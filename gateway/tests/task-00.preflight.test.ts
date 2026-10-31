// Task 00 · 环境与基线。
//
// 这一套只回答两个问题：
//   1. 这台机器现在能不能开工（node 版本、种子摘要、十个场景装配得起来）。
//   2. 基线是不是**从 Gateway 读出来**的，而且推倒重来之后还是同一份。
//
// 全程只读。任何一次 erp.create_draft / erp.submit 出现在审计里都算这一课红了，
// 所以下面几处需要「宿主里多一张单」的地方，都是直接摆到 FakeErp 上（rig.erp / mock），
// 不经能力面 —— 那是布置现场，不是 Agent 的动作。
//
// 单号一律按正则或相对基线的增量断言。写死 PUR-ORD-2026-00011 那种是观测结果，
// 换台机器、换个年份就对不上了。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeRig } from '../src/harness.js';
import { loadScenario } from '../src/erp-mock.js';
import { GatewayClient } from '../src/gateway-client.js';
import { DocType, FACTS } from '../src/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SEED_PATH = join(ROOT, 'fixtures', 'erp-seed.json');
const SHA_PATH = join(ROOT, 'fixtures', 'erp-seed.sha256');
const BASELINE_PATH = join(ROOT, 'reports', 'baseline.json');
const CAPTURE_SCRIPT = join(ROOT, 'scripts', 'capture-baseline.mjs');

/** preflight 点名的十个场景。少一个都算环境不完整。 */
const SCENARIOS = [
  'baseline', 'tool-probe', 'two-sites', 'floor-probe', 'concurrent',
  'uncertain-a', 'uncertain-b', 'uncertain-c', 'poisoned-supplier', 'capstone',
];

/** 单据名只认形状，不认具体号。 */
const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;

interface BaselineItem { item_code: string; qty: number; rate: number }
interface BaselinePo { name: string; supplier: string; docstatus: number; items: BaselineItem[] }
interface BaselineBin { item_code: string; warehouse: string; actual_qty: number }

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toPo(doc: Record<string, unknown>): BaselinePo {
  const raw = Array.isArray(doc.items) ? (doc.items as Record<string, unknown>[]) : [];
  const items = raw
    .map((it) => ({ item_code: String(it.item_code ?? ''), qty: num(it.qty), rate: num(it.rate) }))
    .sort((a, b) => a.item_code.localeCompare(b.item_code));
  return {
    name: String(doc.name ?? ''),
    supplier: String(doc.supplier ?? ''),
    docstatus: num(doc.docstatus),
    items,
  };
}

function toBin(doc: Record<string, unknown>): BaselineBin {
  return {
    item_code: String(doc.item_code ?? ''),
    warehouse: String(doc.warehouse ?? ''),
    actual_qty: num(doc.actual_qty),
  };
}

function sortPos(rows: BaselinePo[]): BaselinePo[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function sortBins(rows: BaselineBin[]): BaselineBin[] {
  return [...rows].sort((a, b) =>
    a.item_code.localeCompare(b.item_code) || a.warehouse.localeCompare(b.warehouse));
}

/** 走 Gateway 读一份和 baseline.json 同形状的快照。 */
async function captureThroughGateway(): Promise<{
  pos: BaselinePo[];
  bins: BaselineBin[];
  runId: string;
  audit: Awaited<ReturnType<ReturnType<typeof makeRig>['audit']['byRun']>>;
  calls: readonly { op: string; doctype: string }[];
  uncertainRows: number;
}> {
  const rig = makeRig({ scenario: 'baseline' });
  try {
    const client = new GatewayClient(rig.tools, rig.runId);
    const poRows = await client.query('Purchase Order');
    const binRows = await client.query('Bin');
    return {
      pos: sortPos(poRows.map(toPo)),
      bins: sortBins(binRows.map(toBin)),
      runId: rig.runId,
      audit: await rig.audit.byRun(rig.runId),
      calls: (rig.mock?.calls() ?? []).map((c) => ({ op: c.op, doctype: c.doctype })),
      uncertainRows: (await rig.ledger.listUncertain()).length,
    };
  } finally {
    rig.cleanup();
  }
}

describe('task-00 · 环境与基线', () => {
  // ── preflight 那五项，逐项在进程里复核一遍 ──────────────────────
  it('preflight: node 版本满足 package.json 的 engines（>= 20.11）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBe('>=20.11');

    const [maj, min] = process.versions.node.split('.').map(Number);
    expect(Number.isFinite(maj)).toBe(true);
    expect((maj as number) > 20 || ((maj as number) === 20 && (min as number) >= 11)).toBe(true);
  });

  it('preflight: fixtures/erp-seed.json 的 sha256 与 erp-seed.sha256 逐字相等', () => {
    expect(existsSync(SEED_PATH)).toBe(true);
    expect(existsSync(SHA_PATH)).toBe(true);
    const expected = readFileSync(SHA_PATH, 'utf8').trim().split(/\s+/)[0];
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(SEED_PATH)).toBe(expected);
  });

  it('preflight: 十个 mock 场景都在，且都能从同一份种子装配起来', () => {
    for (const id of SCENARIOS) {
      const path = join(ROOT, 'mock', 'scenarios', id + '.json');
      expect(existsSync(path), '缺场景 ' + id + '.json').toBe(true);

      const loaded = loadScenario(id);
      expect(loaded.scenario.id).toBe(id);
      expect(loaded.scenario.seed).toBe('fixtures/erp-seed.json');
      expect(loaded.scenario.sites.length).toBeGreaterThan(0);
      expect(Object.keys(loaded.scenario.tokens).length).toBeGreaterThan(0);
    }
  });

  it('preflight: baseline 场景装配后采购单 6 张，原单已提交，货架现有 40', () => {
    const rig = makeRig({ scenario: 'baseline' });
    try {
      const mock = rig.mock;
      expect(mock).not.toBeNull();
      if (!mock) return;

      const pos = mock.snapshot(rig.site, 'Purchase Order');
      expect(pos.length).toBe(FACTS.baselinePurchaseOrders);

      const orig = pos.find((p) => p.name === FACTS.originalPo);
      expect(orig, '原单 ' + FACTS.originalPo + ' 不在种子里').toBeDefined();
      expect(num(orig?.docstatus)).toBe(FACTS.originalPoDocstatus);

      const shelf = mock.snapshot(rig.site, 'Bin')
        .find((b) => b.item_code === FACTS.itemCode && b.warehouse === FACTS.warehouse);
      expect(shelf, '种子里没有 ' + FACTS.itemCode + ' @ ' + FACTS.warehouse + ' 的 Bin').toBeDefined();
      expect(num(shelf?.actual_qty)).toBe(FACTS.onHandQty);
    } finally {
      rig.cleanup();
    }
  });

  // ── 基线是从 Gateway 读出来的，不是从种子文件抄的 ────────────────
  it('baseline: 快照来自 Gateway —— 审计按 runId 能反查到 Purchase Order 与 Bin 两种读', async () => {
    const snap = await captureThroughGateway();

    // 正例：这一轮确实读了东西，不是「什么都没做所以什么都没违规」。
    expect(snap.audit.length).toBeGreaterThanOrEqual(2);

    const doctypes = new Set(snap.audit.map((e) => e.erpDoctype));
    expect(doctypes.has('Purchase Order')).toBe(true);
    expect(doctypes.has('Bin')).toBe(true);

    for (const e of snap.audit) {
      expect(e.runId).toBe(snap.runId);
      expect(e.outcome).toBe('done');
      expect(e.verifiedAt).not.toBeNull();
      expect(e.capability).toBe('erp.query');
    }
  });

  it('baseline: 这一轮只读 —— 审计里没有写能力，台账 0 行，宿主流水里没有 insert / submit', async () => {
    const snap = await captureThroughGateway();

    const writes = snap.audit.filter(
      (e) => e.capability === 'erp.create_draft' || e.capability === 'erp.submit');
    expect(writes).toHaveLength(0);

    // 读不进台账（gateway.ts 的读分支直接返回），有行就说明调过写能力。
    expect(snap.uncertainRows).toBe(0);
    expect(snap.audit.every((e) => e.idempotencyKey === null)).toBe(true);

    const effectful = snap.calls.filter(
      (c) => c.op === 'insert' || c.op === 'submit' || c.op === 'cancel' || c.op === 'remove');
    expect(effectful).toHaveLength(0);
  });

  it('baseline: reports/baseline.json 与现在从 Gateway 读出来的宿主状态逐字段相等', async () => {
    expect(existsSync(BASELINE_PATH), 'reports/baseline.json 不在，先跑 npm run mock:baseline').toBe(true);
    const filed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
      purchaseOrders: BaselinePo[]; bins: BaselineBin[];
    };
    const live = await captureThroughGateway();

    expect(sortPos(filed.purchaseOrders)).toEqual(live.pos);
    expect(sortBins(filed.bins)).toEqual(live.bins);

    // 单号只按形状断言，具体号是观测结果不是契约。
    for (const p of filed.purchaseOrders) expect(p.name).toMatch(PO_NAME);
  });

  it('baseline: 快照的必备键齐全、顺序对，原单与现有量对得上公开测试的正则', () => {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;

    const required = [
      'capturedAt', 'runId', 'source', 'scenario', 'purchaseOrders', 'bins', 'fixtureDigest',
    ];
    const keys = Object.keys(json);
    for (const k of required) expect(keys, '快照缺键 ' + k).toContain(k);

    // 顺序也是契约的一部分：公开测试按这个顺序开正则窗口。
    const idx = required.map((k) => keys.indexOf(k));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    expect(json.source).toBe('mock');
    // 场景写的是哪个 id 不写死，但必须是 mock/scenarios 下真实存在的那一个 ——
    // 拍基线用的场景得能被别人原样跑一遍。
    expect(SCENARIOS).toContain(String(json.scenario));
    expect(json.fixtureDigest).toBe('sha256:' + sha256(SEED_PATH));

    // 00-baseline-has-original-po
    expect(raw).toMatch(/"PUR-ORD-2026-00001"[\s\S]{0,200}"docstatus"[\s\S]{0,8}1/);
    // 00-baseline-has-on-hand-40
    expect(raw).toMatch(/"warehouse"[\s\S]{0,24}"Stores - ADC"[\s\S]{0,120}"actual_qty"[\s\S]{0,8}40/);
  });

  it('baseline: 采集脚本走的是 Gateway，不是 readFileSync 种子文件拼出来的', () => {
    expect(existsSync(CAPTURE_SCRIPT)).toBe(true);
    const text = readFileSync(CAPTURE_SCRIPT, 'utf8');
    // 00-capture-goes-through-gateway
    expect(text).toMatch(/\.call\s*\([\s\S]{0,200}erp\.(?:query|get)/);
  });

  // ── reset：推倒重来之后跟第一次一模一样，而且不误伤别人的单 ──────
  it('reset: 连做三次，每次重采的快照都和第一次逐字段相等', async () => {
    const rig = makeRig({ scenario: 'baseline' });
    try {
      const mock = rig.mock;
      expect(mock).not.toBeNull();
      if (!mock) return;

      const shot = () => ({
        pos: sortPos(mock.snapshot(rig.site, 'Purchase Order').map(toPo)),
        bins: sortBins(mock.snapshot(rig.site, 'Bin').map(toBin)),
      });

      const first = shot();
      expect(first.pos.length).toBe(FACTS.baselinePurchaseOrders);

      for (let round = 1; round <= 3; round += 1) {
        // 先把环境弄脏：直接摆到 FakeErp 上，不经能力面。
        const ref = await rig.erp.insert(rig.site, rig.principal.persona.name, 'Purchase Order', {
          supplier: FACTS.supplier,
          items: [{ item_code: FACTS.itemCode, qty: 1, rate: FACTS.rate }],
        });
        expect(ref.name).toMatch(PO_NAME);
        expect(mock.count(rig.site, 'Purchase Order')).toBe(FACTS.baselinePurchaseOrders + 1);

        mock.reset();
        expect(shot(), '第 ' + round + ' 次 reset 之后对不上').toEqual(first);
      }
    } finally {
      rig.cleanup();
    }
  });

  it('reset: 按确切单号删，同一分钟里别人建的那张不受影响', async () => {
    const rig = makeRig({ scenario: 'baseline' });
    try {
      const mock = rig.mock;
      expect(mock).not.toBeNull();
      if (!mock) return;

      // 别人的草稿。创建时间跟本次 run 挨着 —— 按时间窗口清场就是这么误删的。
      const foreign = 'PUR-ORD-2026-09999';
      mock.seed(rig.site, 'Purchase Order', foreign, { supplier: 'Initech' }, 0);

      // 本次 run 自己建的那张，单号从宿主回执上拿，不是猜的。
      const mine = await rig.erp.insert(rig.site, rig.principal.persona.name, 'Purchase Order', {
        supplier: FACTS.supplier,
        items: [{ item_code: FACTS.itemCode, qty: 1, rate: FACTS.rate }],
      });
      expect(mine.name).toMatch(PO_NAME);
      expect(mine.name).not.toBe(foreign);

      const before = mock.count(rig.site, 'Purchase Order');
      expect(before).toBe(FACTS.baselinePurchaseOrders + 2);

      // 清理：只按确切单号，一条一条删。
      expect(mock.removeExact(rig.site, 'Purchase Order', mine.name)).toBe(true);

      const names = mock.names(rig.site, 'Purchase Order');
      expect(names).not.toContain(mine.name);              // 正例：该删的删掉了
      expect(names).toContain(foreign);                    // 别人的还在
      expect(names).toContain(FACTS.originalPo);           // seed 的原单还在
      expect(names.length).toBe(before - 1);

      const orig = mock.snapshot(rig.site, 'Purchase Order').find((p) => p.name === FACTS.originalPo);
      expect(num(orig?.docstatus)).toBe(FACTS.originalPoDocstatus);
      const other = mock.snapshot(rig.site, 'Purchase Order').find((p) => p.name === foreign);
      expect(num(other?.docstatus)).toBe(0);
    } finally {
      rig.cleanup();
    }
  });

  it('reset: 不回写种子 —— 一整轮跑完 fixtures/erp-seed.json 的摘要没变', async () => {
    const before = sha256(SEED_PATH);

    const rig = makeRig({ scenario: 'baseline' });
    try {
      const mock = rig.mock;
      if (!mock) return;
      const client = new GatewayClient(rig.tools, rig.runId);
      for (const dt of ['Purchase Order', 'Bin', 'Item', 'Supplier'] as DocType[]) {
        expect((await client.query(dt)).length).toBeGreaterThan(0);
      }
      await rig.erp.insert(rig.site, rig.principal.persona.name, 'Purchase Order', {
        supplier: FACTS.supplier, items: [],
      });
      mock.reset();
    } finally {
      rig.cleanup();
    }

    expect(sha256(SEED_PATH)).toBe(before);
  });
});
