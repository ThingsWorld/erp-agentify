// Task 06 的公开测试：持久幂等台账。
//
// 四个过滤器跟 task-06-idempotency.yaml 的 public_tests 一一对应，测试名里原样带着：
//   concurrency-20 / cross-process-4 / restart-dedup / lease-recovery
//
// 三条纪律：
//   · 并发是真发 20 个请求，跨进程是真起 4 个 node 进程。单进程里的 Promise.all
//     只是并发，事件循环还是一个，「先查后写」在里面照样跑得绿。
//   · 每个负例配一个 positive control。「一张都没建出来」和「只建出一张」在
//     断言上长得很像，不把能建成的那一面也钉住，全拒也是绿的。
//   · 单号只判形状或增量。PUR-ORD-2026-00011 是某一次的观测结果，不是契约。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient } from '../src/gateway-client.js';
import { buildDraftDoc, createCorrectionDraft, gatherFacts } from '../src/agent/create-draft.js';
import { draftKey } from '../src/idempotency-key.js';
import { PersistentLedger } from '../src/ledger-persistent.js';
import { EXPECTED_SHORTFALL, ErpRef, FACTS, Principal } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** node 直接跑不了 .ts，子进程要经 tsx 起。 */
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORKER = join(HERE, 'reserve-worker.mjs');

const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;
const CONCURRENCY = 20;
const PROCESSES = 4;
const ROUNDS = 5;
/** 留给 tsx 冷启动的余量：四个进程都起来了再一起冲同一个键。 */
const START_GAP_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface WorkerLine {
  ok: boolean;
  outcome?: string;
  state?: string | null;
  attempts?: number | null;
  leaseOwner?: string | null;
  erpRef?: ErpRef | null;
  key?: string;
  pid?: number;
  error?: string;
}

function runWorker(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, WORKER, ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

/** worker 把结果打成一行 JSON。取最后一行非空的解析，前面可能有 tsx 的噪音。 */
function parseWorker(r: { code: number; out: string; err: string }): WorkerLine {
  const line = r.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error('子进程没有输出结果：code=' + r.code + ' stderr=' + r.err.slice(0, 400));
  return JSON.parse(line) as WorkerLine;
}

/** 本任务那个业务键：谁、给谁、买什么、哪一批。 */
function correctionKey(qty = EXPECTED_SHORTFALL): string {
  return draftKey({
    intent: 'po-correction', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
    qty, batch: FACTS.originalPo,
  });
}

function mockOf(r: Rig) {
  const m = r.mock;
  if (!m) throw new Error('这套测试只跑 mock 场景');
  return m;
}

function poNames(r: Rig): string[] {
  return mockOf(r).snapshot(r.site, 'Purchase Order').map((p) => String(p.name)).sort();
}

function freshPo(r: Rig, before: readonly string[]): Record<string, unknown> {
  const fresh = mockOf(r).snapshot(r.site, 'Purchase Order')
    .filter((p) => !before.includes(String(p.name)));
  expect(fresh.length, '本次运行应当恰好新增 1 张采购单').toBe(1);
  const only = fresh[0];
  if (!only) throw new Error('新增采购单不见了');
  return only;
}

interface PoLine { item_code?: unknown; qty?: unknown; rate?: unknown; warehouse?: unknown }

function firstLine(po: Record<string, unknown>): PoLine {
  const line = (Array.isArray(po.items) ? (po.items as PoLine[]) : [])[0];
  if (!line) throw new Error('这张单上一行物料都没有');
  return line;
}

describe('task-06 · 持久幂等台账', () => {
  it('concurrency-20 · 20 次同键并发，ERP 里只多出一张采购单', async () => {
    const rig = makeRig({ scenario: 'concurrent', persistent: true, runId: 'run-06-concurrency' });
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const before = poNames(rig);
      expect(before.length).toBe(FACTS.baselinePurchaseOrders);

      // 用户连点 20 次「重新提交」。每一次都走完整链路，键是从业务字段现算的。
      const outs = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => createCorrectionDraft(client)));

      const statuses = outs.map((o) => o.result.status);
      expect(statuses).toHaveLength(CONCURRENCY);
      const done = outs.filter((o) => o.result.status === 'done');
      expect(done, '恰好一次真的写进去了').toHaveLength(1);
      for (const s of statuses.filter((x) => x !== 'done'))
        expect(['deduped', 'in_flight'], '其余 19 次只能是去重或撞上执行中').toContain(s);

      // 宿主侧：不看返回值，自己回查。
      const po = freshPo(rig, before);
      const name = String(po.name);
      expect(name).toMatch(PO_NAME);
      expect(name).toBe(done[0]?.result.erpRef?.name);
      expect(po.supplier).toBe(FACTS.supplier);
      expect(Number(po.docstatus), '先别提交').toBe(0);
      expect((po.items as PoLine[]).length).toBe(1);
      const line = firstLine(po);
      expect(line.item_code).toBe(FACTS.itemCode);
      expect(Number(line.qty), '60 − 40，不是原单的 50').toBe(EXPECTED_SHORTFALL);
      expect(Number(line.rate)).toBe(FACTS.rate);
      expect(line.warehouse).toBe(FACTS.warehouse);

      // 台账侧：这个键只有一行，落到 succeeded，租约已释放，指向那张单。
      const key = correctionKey();
      const row = await rig.ledger.get(rig.principal, key);
      expect(row?.state).toBe('succeeded');
      expect(row?.erpRef?.doctype).toBe('Purchase Order');
      expect(row?.erpRef?.name).toBe(name);
      expect(row?.leaseUntil).toBeNull();
      expect(row?.attempts ?? 0).toBeGreaterThanOrEqual(1);

      // 审计侧：同一个键下恰好一条 done，而且它回查过终态。
      const entries = await rig.audit.byRun(rig.runId);
      const keyed = entries.filter((e) => e.idempotencyKey === key);
      const okWrites = keyed.filter((e) => e.outcome === 'done');
      expect(okWrites, '审计说建成功了几次，就得真有几张单').toHaveLength(1);
      for (const e of keyed) expect(['done', 'deduped', 'in_flight']).toContain(e.outcome);
      expect(okWrites[0]?.erpName).toBe(name);
      expect(okWrites[0]?.verifiedAt).not.toBeNull();
      expect(okWrites[0]?.docstatus).toBe(0);
      expect(entries.some((e) => e.capability === 'erp.submit' && e.outcome === 'done')).toBe(false);

      // 反向：拿单号查得回这次 run 和那个键。
      const back = await rig.audit.byErpRef({ doctype: 'Purchase Order', name });
      expect(back.length).toBeGreaterThanOrEqual(1);
      expect(back.some((e) => e.runId === rig.runId && e.idempotencyKey === key)).toBe(true);

      // 原单和库存一个字段没动。
      const orig = mockOf(rig).snapshot(rig.site, 'Purchase Order')
        .find((p) => p.name === FACTS.originalPo);
      expect(Number(orig?.docstatus)).toBe(1);
      expect(Number(firstLine(orig ?? {}).qty)).toBe(FACTS.orderedQty);
      const bin = mockOf(rig).snapshot(rig.site, 'Bin')
        .find((b) => b.item_code === FACTS.itemCode && b.warehouse === FACTS.warehouse);
      expect(Number(bin?.actual_qty), '草稿不影响库存').toBe(FACTS.onHandQty);

      // 那条成功的答复要报得出缺口和新单号（task-06 的 c-shortage-20 / c-draft-name）。
      const reply = done[0]?.reply ?? '';
      expect(reply).toMatch(/(缺口|还缺|还差|差|补)[^。\n]{0,12}\b20\b/);
      expect(reply).toMatch(/PUR-ORD-(?!2026-00001\b)\d{4}-\d{5}/);
    } finally {
      rig.cleanup();
    }
  });

  it('concurrency-20 · positive control：20 个不同键就该建出 20 张，去重不是宿主给的', async () => {
    const rig = makeRig({ scenario: 'concurrent', persistent: true, runId: 'run-06-concurrency-control' });
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const before = poNames(rig);
      const plan = await gatherFacts(client);
      const doc = buildDraftDoc(plan);

      // 键不同 = 20 件不同的事。FakeErp 自己不去重（mock/CONTRACT.md §2.8），
      // 所以这里必须真的出 20 张 —— 上一条测出的「只有 1 张」才是台账的功劳。
      const outs = await Promise.all(Array.from({ length: CONCURRENCY }, (_unused, i) =>
        client.createDraft(doc, draftKey({
          intent: 'po-correction-control', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
          qty: plan.shortfall, batch: 'CTRL-' + String(i).padStart(2, '0'),
        }))));

      expect(outs.filter((o) => o.status === 'done')).toHaveLength(CONCURRENCY);
      expect(poNames(rig).length).toBe(before.length + CONCURRENCY);

      // 收尾按确切单号逐个删，不按时间窗口、不按 supplier 批删。
      for (const o of outs) {
        const n = o.erpRef?.name;
        if (n) expect(mockOf(rig).removeExact(rig.site, 'Purchase Order', n)).toBe(true);
      }
      expect(poNames(rig)).toEqual(before);
    } finally {
      rig.cleanup();
    }
  });

  it('cross-process-4 · 4 个独立进程抢同一个键，恰好一个 acquired（跑 5 轮）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w12-xproc-'));
    try {
      for (let round = 1; round <= ROUNDS; round += 1) {
        const key = 'task-06-cross-process-probe|r' + round;
        const startAt = Date.now() + START_GAP_MS;
        const raw = await Promise.all(Array.from({ length: PROCESSES }, (_unused, i) => runWorker([
          '--dir', dir, '--key', key, '--owner', 'w' + (i + 1),
          '--lease', '30000', '--start-at', String(startAt),
        ])));
        const lines = raw.map(parseWorker);
        for (const l of lines) expect(l.ok, '第 ' + round + ' 轮有进程炸了：' + l.error).toBe(true);

        const acquired = lines.filter((l) => l.outcome === 'acquired');
        const inFlight = lines.filter((l) => l.outcome === 'in_flight');
        expect(acquired, '第 ' + round + ' 轮：占位不原子就会有第二个进程也拿到').toHaveLength(1);
        expect(inFlight, '第 ' + round + ' 轮：另外三个只能看到执行中').toHaveLength(PROCESSES - 1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('cross-process-4 · positive control：四个进程各拿各的键，四个都该 acquired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w12-xproc-ctrl-'));
    try {
      const startAt = Date.now() + START_GAP_MS;
      const raw = await Promise.all(Array.from({ length: PROCESSES }, (_unused, i) => runWorker([
        '--dir', dir, '--key', 'task-06-cross-process-probe|ctrl-' + i, '--owner', 'w' + (i + 1),
        '--lease', '30000', '--start-at', String(startAt),
      ])));
      const lines = raw.map(parseWorker);
      for (const l of lines) expect(l.ok, l.error ?? '').toBe(true);
      // 四个进程真的跑起来了，也真的写得进台账 —— 上一条的「只有一个」不是因为没起来。
      expect(lines.filter((l) => l.outcome === 'acquired')).toHaveLength(PROCESSES);
      expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(PROCESSES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('restart-dedup · 换个实例打开同一份台账，成功过的键仍判 duplicate 并带回原 ErpRef', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w12-restart-'));
    const key = correctionKey();
    try {
      // ① 重启前：正常建出那一张。
      const before = makeRig({
        scenario: 'concurrent', persistent: true, workDir: dir, runId: 'run-06-restart-a',
      });
      const out1 = await createCorrectionDraft(new GatewayClient(before.tools, before.runId));
      expect(out1.result.status).toBe('done');
      const name = out1.result.erpRef?.name ?? '';
      expect(name).toMatch(PO_NAME);
      const principal: Principal = before.principal;
      before.cleanup();   // 这一份 rig 的内存全丢掉，模拟助手重启

      // ② 单号是以文本形式落在盘上的，不是靠某个还活着的模块级变量。
      const files = readdirSync(join(dir, 'ledger')).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
      const onDisk = files.map((f) => readFileSync(join(dir, 'ledger', f), 'utf8')).join('\n');
      expect(onDisk).toContain(name);
      expect(onDisk).toContain('Purchase Order');
      expect(onDisk).toContain('succeeded');

      // ③ 重启后：全新的 PersistentLedger 实例 + 全新的 Gateway，只共享台账目录。
      const after = makeRig({
        scenario: 'concurrent', persistent: true, workDir: dir, runId: 'run-06-restart-b',
      });
      try {
        const row = await after.ledger.get(after.principal, key);
        expect(row?.state, '重启之后这个键还得认识').toBe('succeeded');
        expect(row?.erpRef?.name).toBe(name);

        const client = new GatewayClient(after.tools, after.runId);
        const out2 = await createCorrectionDraft(client);
        expect(out2.result.status, '重启前点的和重启后点的是同一件事').toBe('deduped');
        expect(out2.result.erpRef?.name, '去重要把原来那个单号还回来').toBe(name);
        expect(poNames(after).length, '重启后不许再冒一张')
          .toBe(FACTS.baselinePurchaseOrders);

        // positive control：库存掉到 39 → 缺口 21 → 另一个业务键，重启后的台账照样放行。
        mockOf(after).seed(after.site, 'Bin', 'BIN-00001',
          { item_code: FACTS.itemCode, warehouse: FACTS.warehouse, actual_qty: FACTS.onHandQty - 1 });
        const out3 = await createCorrectionDraft(client);
        expect(out3.result.status, '不是见谁都判 duplicate').toBe('done');
        expect(Number(out3.plan.shortfall)).toBe(EXPECTED_SHORTFALL + 1);
        expect(poNames(after).length).toBe(FACTS.baselinePurchaseOrders + 1);
        // 重启前后是两份各自 seed 的内存 ERP，发号器都从种子的序号接着往下走，
        // 单号会撞车 —— 所以这里判的是「另一个键、另一行台账」，不是判单号不同。
        const other = correctionKey(EXPECTED_SHORTFALL + 1);
        expect(other).not.toBe(key);
        const row3 = await after.ledger.get(after.principal, other);
        expect(row3?.state).toBe('succeeded');
        expect(row3?.erpRef?.name).toBe(out3.result.erpRef?.name);
      } finally {
        after.cleanup();
      }

      // ④ 再补一刀：写台账的那个进程已经退出了，本进程照样认得出它写下的键。
      const dir2 = mkdtempSync(join(tmpdir(), 'w12-restart-xproc-'));
      try {
        const probe = 'task-06-restart-probe';
        const w = parseWorker(await runWorker([
          '--dir', dir2, '--key', probe, '--owner', 'w-child',
          '--act', 'succeed', '--ref-name', name,
        ]));
        expect(w.ok, w.error ?? '').toBe(true);
        expect(w.outcome).toBe('acquired');
        expect(w.state).toBe('succeeded');

        const reopened = new PersistentLedger(dir2);
        const res = await reopened.reserve(principal, probe, 'erp.create_draft', 'owner-main', 30_000);
        expect(res.outcome, '子进程写的键，本进程也得认').toBe('duplicate');
        expect(res.row.erpRef?.name).toBe(name);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('lease-recovery · 租约过期领得回（recovered、attempts+1），uncertain 永远不领回', async () => {
    const rig = makeRig({ scenario: 'concurrent', persistent: true, leaseMs: 50 });
    const lease = 50;
    try {
      const p = rig.principal;

      // 持有者拿了租约就崩了，什么都没落幕。
      const probe = 'task-06-lease-probe';
      const first = await rig.ledger.reserve(p, probe, 'erp.create_draft', 'owner-1', lease);
      expect(first.outcome).toBe('acquired');
      expect(first.row.attempts).toBe(1);
      await rig.ledger.begin(p, probe, 'owner-1');

      await sleep(lease * 3);
      const taken = await rig.ledger.reserve(p, probe, 'erp.create_draft', 'owner-2', lease);
      expect(taken.outcome, '租约过期不领回，这个键就永远卡死').toBe('recovered');
      expect(taken.row.attempts).toBe(2);
      expect(taken.row.leaseOwner).toBe('owner-2');

      // uncertain 是唯一不许自动重试的终态：写可能已经落进 ERP 了。
      const unsure = 'task-06-uncertain-probe';
      const u1 = await rig.ledger.reserve(p, unsure, 'erp.create_draft', 'owner-3', lease);
      expect(u1.outcome).toBe('acquired');
      await rig.ledger.begin(p, unsure, 'owner-3');
      await rig.ledger.markUncertain(p, unsure, 'owner-3', null);

      await sleep(lease * 3);
      const u2 = await rig.ledger.reserve(p, unsure, 'erp.create_draft', 'owner-4', lease);
      expect(u2.outcome, '租约早过期了也不领 —— 这一条要人工对账').toBe('in_flight');
      expect(u2.row.state).toBe('uncertain');
      expect((await rig.ledger.listUncertain()).map((x) => x.key)).toContain(unsure);

      // positive control：同样等过了租约，全新的键照样占得住位 ——
      // 上面那个 in_flight 是 uncertain 挡的，不是台账整个卡死了。
      const fresh = await rig.ledger.reserve(p, 'task-06-lease-probe|fresh', 'erp.create_draft', 'owner-5', lease);
      expect(fresh.outcome).toBe('acquired');
    } finally {
      rig.cleanup();
    }
  });

  it('lease-recovery · 租约归属：不是持有者就改不动那一行，是持有者才改得动', async () => {
    const rig = makeRig({ scenario: 'concurrent', persistent: true, leaseMs: 50 });
    const lease = 50;
    try {
      const p = rig.principal;
      const probe = 'task-06-lease-owner-probe';
      // 这个 ErpRef 只是台账里的载荷，不是 ERP 回查来的单号，所以刻意不写成单号的形状。
      const ref: ErpRef = { doctype: 'Purchase Order', name: 'PROBE-LEASE-REF' };

      expect((await rig.ledger.reserve(p, probe, 'erp.create_draft', 'owner-1', lease)).outcome)
        .toBe('acquired');
      await rig.ledger.begin(p, probe, 'owner-1');
      await sleep(lease * 3);
      expect((await rig.ledger.reserve(p, probe, 'erp.create_draft', 'owner-2', lease)).outcome)
        .toBe('recovered');

      // 慢半拍的旧持有者回来，想把别人的结果盖掉。
      await expect(rig.ledger.succeed(p, probe, 'owner-1', ref)).rejects.toThrow(/租约/);
      const untouched = await rig.ledger.get(p, probe);
      expect(untouched?.state, '被拒的转移不许留下半截改动').toBe('reserved');
      expect(untouched?.erpRef).toBeNull();
      expect(untouched?.leaseOwner).toBe('owner-2');

      // positive control：真正的持有者改得动，落幕时租约要清掉。
      await rig.ledger.succeed(p, probe, 'owner-2', ref);
      const settled = await rig.ledger.get(p, probe);
      expect(settled?.state).toBe('succeeded');
      expect(settled?.erpRef?.name).toBe(ref.name);
      expect(settled?.leaseUntil).toBeNull();
    } finally {
      rig.cleanup();
    }
  });

  it('幂等键 · 换个进程算出来字节相同；业务字段一变就变，说明文字变了不变', async () => {
    const parts = {
      intent: 'po-correction', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
      qty: EXPECTED_SHORTFALL, batch: FACTS.originalPo,
    };
    const k1 = draftKey(parts);

    // 另一个进程、另一份内存，同一份业务输入。
    const child = parseWorker(await runWorker([
      '--act', 'key', '--intent', parts.intent, '--supplier', parts.supplier,
      '--item', parts.itemCode, '--qty', String(parts.qty), '--batch', parts.batch,
    ]));
    expect(child.ok, child.error ?? '').toBe(true);
    expect(Buffer.from(child.key ?? '', 'utf8').equals(Buffer.from(k1, 'utf8')),
      '跨进程算出来的键要逐字节相同').toBe(true);

    // 业务语义变了就是另一件事。
    expect(draftKey({ ...parts, qty: parts.qty + 1 })).not.toBe(k1);
    expect(draftKey({ ...parts, supplier: 'Initech' })).not.toBe(k1);
    expect(draftKey({ ...parts, itemCode: 'ITEM-PALLET-01' })).not.toBe(k1);
    expect(draftKey({ ...parts, batch: 'WO-2026-0007' })).not.toBe(k1);
    expect(draftKey({ ...parts, intent: 'po-return' })).not.toBe(k1);

    // 模型自己写的说明文字换个措辞，不该算成新的一件事。
    const noisy = { ...parts, remarks: '这次说得客气一点', note: '重试第三次' };
    expect(draftKey(noisy)).toBe(k1);

    // 键里没有熵：不是裸 uuid，也没有 10 位以上的数字串。
    expect(k1).not.toMatch(/^[0-9a-f-]{36}$/);
    expect(k1).not.toMatch(/\d{10,}/);
    expect(new Set(Array.from({ length: 50 }, () => draftKey(parts))).size).toBe(1);

    // negative control：算不出业务语义的请求就不该有键。
    expect(() => draftKey({ ...parts, qty: 0 })).toThrow();
    expect(() => draftKey({ ...parts, supplier: '   ' })).toThrow();
  }, 60_000);
});
