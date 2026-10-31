// task-07 · 超时、uncertain 与对账的公开测试。
//
// 判的是四件事，跟 tasks/task-07-reconciliation.yaml 的 checks 一一对上：
//   insert-then-throw   落库成功但回执断了 → uncertain，不是 done 也不是 failed
//   corrupt-docstatus   回执可信但回查的 docstatus 对不上 → uncertain
//   no-auto-retry       台账停在 uncertain 时 reserve 不放行，attempts 不涨，不建第二张
//   single-order        两种故障各跑一遍并对账之后，符合业务引用的草稿只有一张
//
// 每一条负例后面都跟一条 positive control。不然「所有调用一律判 uncertain」也能全绿，
// 那不是安全，那是把功能做没了。
//
// 单号一律用正则或「相对运行前快照的增量」来判。哪次跑出 00011 是观测结果，不是契约。

import { describe, expect, it } from 'vitest';

import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient, numberField } from '../src/gateway-client.js';
import { computeShortfall } from '../src/agent/shortfall.js';
import { businessProbe } from '../src/reconcile.js';
import { draftKey } from '../src/idempotency-key.js';
import {
  AuditEntry, DocType, ErpFilters, ErpRef, EXPECTED_SHORTFALL, FACTS, LedgerRow,
} from '../src/types.js';

const DOCTYPE: DocType = 'Purchase Order';

/** 单号只判形状。具体号是宿主发的，写死一次就锁死一个环境。 */
const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;

/** 交货日期是业务引用的一半，回查全靠它 + supplier 把这次写入认出来。 */
const SCHEDULE_DATE = '2026-09-25';

// ── 装配 ────────────────────────────────────────────────────────

interface Prepared {
  doc: Record<string, unknown>;
  key: string;
  shortfall: number;
  rate: number;
  warehouse: string;
  /** 写之前符合业务引用的单号。回查靠它把「我写的」和「本来就有的」分开。 */
  knownBefore: string[];
}

/**
 * 查事实、算缺口、组装草稿和幂等键。
 *
 * 只用 erp.query（list），一次 erp.get 都不发 —— corrupt-docstatus 的开关是一次性的，
 * 提前发一次 get 会把它消耗掉，故障就注不进要测的那条路了。
 */
async function prepare(
  client: GatewayClient,
  opts: { scheduleDate?: string; intent?: string } = {},
): Promise<Prepared> {
  const scheduleDate = opts.scheduleDate ?? SCHEDULE_DATE;
  const intent = opts.intent ?? 't07-po-correction';

  const bins = await client.query('Bin', { item_code: FACTS.itemCode });
  const bin = bins.find((b) => b.warehouse === FACTS.warehouse);
  expect(bin, '种子里应该有 ' + FACTS.itemCode + ' @ ' + FACTS.warehouse + ' 的库存行').toBeTruthy();
  const onHandQty = numberField(bin as Record<string, unknown>, 'actual_qty');

  const { shortfall } = computeShortfall({ requiredQty: FACTS.requiredQty, onHandQty });
  expect(shortfall, '缺口要从 Bin 查出来算，不是照抄原单的 ' + FACTS.orderedQty)
    .toBe(EXPECTED_SHORTFALL);

  // 单价和仓库全称从原单读。list 已经把行项目带回来了，不用再发 get。
  const pos = await client.query(DOCTYPE, { supplier: FACTS.supplier, docstatus: 1 });
  const orig = pos.find((p) => p.name === FACTS.originalPo);
  expect(orig, '种子里应该有 ' + FACTS.originalPo).toBeTruthy();
  const items = (orig as Record<string, unknown>).items as Record<string, unknown>[] | undefined;
  const line = items?.find((x) => x.item_code === FACTS.itemCode);
  expect(line, FACTS.originalPo + ' 上应该有 ' + FACTS.itemCode + ' 这一行').toBeTruthy();
  const rate = numberField(line as Record<string, unknown>, 'rate');
  const warehouse = String((line as Record<string, unknown>).warehouse);

  const doc: Record<string, unknown> = {
    supplier: FACTS.supplier,
    company: FACTS.company,
    currency: FACTS.currency,
    schedule_date: scheduleDate,
    items: [{
      item_code: FACTS.itemCode,
      qty: shortfall,
      rate,
      warehouse,               // 库存物料必填，漏了 live 整单打回
      schedule_date: scheduleDate,
    }],
  };

  const key = draftKey({
    intent,
    supplier: FACTS.supplier,
    itemCode: FACTS.itemCode,
    qty: shortfall,
    batch: FACTS.originalPo,   // 批次用原单号，重放、重启都算得出同一串
  });

  const knownBefore = await namesMatching(client, doc);
  return { doc, key, shortfall, rate, warehouse, knownBefore };
}

/** 按业务引用列出当前命中的单号。 */
async function namesMatching(client: GatewayClient, doc: Record<string, unknown>): Promise<string[]> {
  const rows = await client.query(DOCTYPE, businessProbe(doc));
  return rows.map((r) => String(r.name)).sort();
}

// ── 显式对账入口 ────────────────────────────────────────────────

interface ReconcileOutcome {
  state: 'succeeded' | 'failed';
  found: ErpRef | null;
  /** 回查真正用出去的 filters。判据要看它含 supplier + schedule_date、不含单号。 */
  filters: ErpFilters;
  fresh: string[];
}

/**
 * 对账：按业务引用回查宿主，把 uncertain 收敛成 succeeded 或 failed。
 *
 * 三个刻意的选择：
 *   1. 回查走 Gateway 的 erp.query，不直接摸 mock —— 这一下要在审计里留痕。
 *   2. filters 由 businessProbe 从原始 doc 组装（supplier + schedule_date），
 *      不用单号：丢响应的时候单号根本还没回来。
 *   3. 查到才 succeed，查不到才 fail。没有第三条路，也没有「重发一次看看」。
 */
async function reconcileByBusinessRef(
  rig: Rig, client: GatewayClient, p: Prepared,
): Promise<ReconcileOutcome> {
  const filters = businessProbe(p.doc);
  const rows = await client.query(DOCTYPE, filters);
  const fresh = rows.map((r) => String(r.name)).filter((n) => !p.knownBefore.includes(n)).sort();

  const row = await rig.ledger.get(rig.principal, p.key);
  expect(row, '对账之前台账里应该有这一行').toBeTruthy();
  const owner = (row as LedgerRow).leaseOwner;
  expect(owner, 'markUncertain 之后归属要留着，对账才追得到人').toBeTruthy();

  if (fresh.length > 1) throw new Error('业务引用命中 ' + fresh.length + ' 张，不唯一，停下报人工');

  const only = fresh[0];
  if (only !== undefined) {
    const found: ErpRef = { doctype: DOCTYPE, name: only };
    await rig.ledger.succeed(rig.principal, p.key, owner as string, found);
    return { state: 'succeeded', found, filters, fresh };
  }
  await rig.ledger.fail(rig.principal, p.key, owner as string);
  return { state: 'failed', found: null, filters, fresh };
}

// ── 小工具 ──────────────────────────────────────────────────────

function label(entries: AuditEntry[]): string[] {
  return entries.map((e) => e.capability + '=' + e.outcome);
}

/** 深拷一份审计快照。比较 append-only 的时候不能拿同一批对象引用去比。 */
function frozenCopy(entries: AuditEntry[]): AuditEntry[] {
  return JSON.parse(JSON.stringify(entries)) as AuditEntry[];
}

/** 清理只按确切单号。不按时间窗口、不按 supplier、不按 schedule_date 批删。 */
function removeExact(rig: Rig, names: readonly string[]): void {
  for (const n of names) rig.mock?.removeExact(rig.site, DOCTYPE, n);
}

// ── insert-then-throw ───────────────────────────────────────────

describe('task-07 丢响应与对账', () => {
  it('insert-then-throw：宿主落库了、回执断了 → uncertain，不是 done 也不是 failed', async () => {
    const rig = makeRig({ scenario: 'uncertain-a' });
    const created: string[] = [];
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const p = await prepare(client);
      const countBefore = rig.mock!.count(rig.site, DOCTYPE);

      const r = await client.createDraft(p.doc, p.key);
      if (r.erpRef) created.push(r.erpRef.name);

      expect(r.status, '落库成功但回执丢了，只能判 uncertain').toBe('uncertain');
      expect(r.status).not.toBe('done');
      expect(r.status).not.toBe('denied');
      expect(r.erpRef?.name ?? '').toMatch(PO_NAME);
      expect(String(r.reason ?? '')).not.toBe('');

      // 单据是真写进去了 —— 这正是不许重试的理由。
      expect(rig.mock!.count(rig.site, DOCTYPE)).toBe(countBefore + 1);

      const row = await rig.ledger.get(rig.principal, p.key);
      expect(row?.state, '台账要停在 uncertain').toBe('uncertain');
      expect(row?.erpRef?.name, '回查补上的单号要写回台账').toBe(r.erpRef?.name);

      const entries = await rig.audit.byRun(rig.runId);
      const writes = entries.filter((e) => e.capability === 'erp.create_draft');
      expect(writes.length, '这条路只发了一次写调用：' + label(entries).join(' ')).toBe(1);
      expect(writes[0]!.outcome).toBe('uncertain');
      expect(writes[0]!.verifiedAt, '没回查确认就不许填 verifiedAt').toBeNull();
      expect(
        entries.filter((e) => e.capability === 'erp.create_draft' && e.outcome === 'done').length,
        '没经过成功回查的写不许记成 done',
      ).toBe(0);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('insert-then-throw · positive control：一次性开关复位之后，同一条路走到 done', async () => {
    const rig = makeRig({ scenario: 'uncertain-a' });
    const created: string[] = [];
    try {
      const client = new GatewayClient(rig.tools, rig.runId);

      // 第一次把故障开关烧掉。
      const first = await prepare(client);
      const bad = await client.createDraft(first.doc, first.key);
      if (bad.erpRef) created.push(bad.erpRef.name);
      expect(bad.status).toBe('uncertain');

      // 第二次是干净路径：换一个业务引用（另一个交货日期），别跟上一张搅在一起。
      const good = await prepare(client, { scheduleDate: '2026-09-20', intent: 't07-control' });
      const r = await client.createDraft(good.doc, good.key);
      if (r.erpRef) created.push(r.erpRef.name);

      expect(r.status, '不开故障时这条路必须仍然能走到 done').toBe('done');
      expect(r.docstatus, '建出来的是草稿').toBe(0);
      expect(r.erpRef?.name ?? '').toMatch(PO_NAME);

      const row = await rig.ledger.get(rig.principal, good.key);
      expect(row?.state).toBe('succeeded');

      const done = (await rig.audit.byRun(rig.runId))
        .filter((e) => e.capability === 'erp.create_draft' && e.outcome === 'done');
      expect(done.length).toBe(1);
      expect(done[0]!.verifiedAt, 'done 的行必须有回查时刻').not.toBeNull();
      expect(done[0]!.docstatus).toBe(0);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  // ── corrupt-docstatus ─────────────────────────────────────────

  it('corrupt-docstatus：回执可信但回查的终态对不上 → uncertain', async () => {
    const rig = makeRig({ scenario: 'uncertain-b' });
    const created: string[] = [];
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const p = await prepare(client);

      const r = await client.createDraft(p.doc, p.key);
      if (r.erpRef) created.push(r.erpRef.name);

      expect(r.status, '回执说成功 ≠ 宿主终态确认').toBe('uncertain');
      expect(r.erpRef?.name ?? '').toMatch(PO_NAME);
      expect(r.docstatus, '回查读到的 docstatus 要如实带回来').not.toBe(0);

      // 宿主里那张单其实是好的 —— 脏的是这一次回查。所以更不能重试。
      const snap = rig.mock!.snapshot(rig.site, DOCTYPE).find((d) => d.name === r.erpRef?.name);
      expect(Number(snap?.docstatus), '宿主里那张单本身是草稿').toBe(0);

      const row = await rig.ledger.get(rig.principal, p.key);
      expect(row?.state).toBe('uncertain');
      expect(row?.erpRef?.name).toBe(r.erpRef?.name);

      const writes = (await rig.audit.byRun(rig.runId))
        .filter((e) => e.capability === 'erp.create_draft');
      expect(writes.length).toBe(1);
      expect(writes[0]!.outcome).toBe('uncertain');
      expect(writes[0]!.verifiedAt).toBeNull();
      expect(writes[0]!.docstatus, '读到什么就记什么，不许改成预期值').toBe(r.docstatus);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('corrupt-docstatus · positive control：回查读到 0 时落 done 并填 verifiedAt', async () => {
    const rig = makeRig({ scenario: 'uncertain-b' });
    const created: string[] = [];
    try {
      const client = new GatewayClient(rig.tools, rig.runId);

      const first = await prepare(client);
      const bad = await client.createDraft(first.doc, first.key);
      if (bad.erpRef) created.push(bad.erpRef.name);
      expect(bad.status).toBe('uncertain');

      const good = await prepare(client, { scheduleDate: '2026-09-20', intent: 't07-control' });
      const r = await client.createDraft(good.doc, good.key);
      if (r.erpRef) created.push(r.erpRef.name);

      expect(r.status).toBe('done');
      expect(r.docstatus).toBe(0);

      const done = (await rig.audit.byRun(rig.runId))
        .filter((e) => e.capability === 'erp.create_draft' && e.outcome === 'done');
      expect(done.length).toBe(1);
      expect(done[0]!.verifiedAt).not.toBeNull();
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  // ── no-auto-retry ─────────────────────────────────────────────

  it('no-auto-retry：台账停在 uncertain 时 reserve 不放行，attempts 不涨，不建第二张', async () => {
    const rig = makeRig({ scenario: 'uncertain-a' });
    const created: string[] = [];
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const p = await prepare(client);

      const first = await client.createDraft(p.doc, p.key);
      if (first.erpRef) created.push(first.erpRef.name);
      expect(first.status).toBe('uncertain');

      const before = await rig.ledger.get(rig.principal, p.key);
      const attempts0 = before!.attempts;
      const count0 = rig.mock!.count(rig.site, DOCTYPE);
      const audit0 = (await rig.audit.byRun(rig.runId)).length;

      // ① 台账这一层：uncertain 的键不许被重新领走。
      const probe = await rig.ledger.reserve(
        rig.principal, p.key, 'erp.create_draft', 'owner-probe', 1_000);
      expect(probe.outcome, 'uncertain 是唯一不许自动重试的终态').toBe('in_flight');
      expect(probe.outcome).not.toBe('acquired');
      expect(probe.outcome).not.toBe('recovered');
      expect(probe.row.attempts, '被挡下来不该算一次尝试').toBe(attempts0);

      // ② 网关这一层：同键再发一次，结果仍是 uncertain，并且说明原因。
      const replay = await client.createDraft(p.doc, p.key);
      expect(replay.status).toBe('uncertain');
      expect(String(replay.reason ?? ''), '要说清是在等人工对账').toMatch(/对账|不自动重试/);
      expect(rig.mock!.count(rig.site, DOCTYPE), '重放不许建出第二张').toBe(count0);

      const after = await rig.ledger.get(rig.principal, p.key);
      expect(after!.state).toBe('uncertain');
      expect(after!.attempts, 'attempts 不许增长 —— 增长就意味着又执行了一次').toBe(attempts0);

      // 被挡下来的重放不该产生新的写审计。
      const entries = await rig.audit.byRun(rig.runId);
      expect(entries.length).toBe(audit0);
      expect(entries.filter((e) => e.capability === 'erp.create_draft').length).toBe(1);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('no-auto-retry · positive control：全新键放行、succeeded 键去重，不是一律 in_flight', async () => {
    const rig = makeRig({ scenario: 'uncertain-a' });
    const created: string[] = [];
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const p = await prepare(client);
      const stuck = await client.createDraft(p.doc, p.key);
      if (stuck.erpRef) created.push(stuck.erpRef.name);
      expect(stuck.status).toBe('uncertain');

      // 全新的键 —— 台账必须放行，网关必须真的建出一张。
      const other = await prepare(client, { scheduleDate: '2026-09-20', intent: 't07-control' });
      const countBefore = rig.mock!.count(rig.site, DOCTYPE);
      const ok = await client.createDraft(other.doc, other.key);
      if (ok.erpRef) created.push(ok.erpRef.name);
      expect(ok.status, '拦的是那一个 uncertain 的键，不是所有写').toBe('done');
      expect(rig.mock!.count(rig.site, DOCTYPE)).toBe(countBefore + 1);

      // 已经 succeeded 的键：第二次是 duplicate（去重），不是 in_flight（等人）。
      const dup = await rig.ledger.reserve(
        rig.principal, other.key, 'erp.create_draft', 'owner-probe', 1_000);
      expect(dup.outcome).toBe('duplicate');
      expect(dup.row.erpRef?.name).toBe(ok.erpRef?.name);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  // ── single-order ──────────────────────────────────────────────

  for (const scenario of ['uncertain-a', 'uncertain-b'] as const) {
    it('single-order：' + scenario + ' 故障跑完并对账之后，符合业务引用的草稿只有一张', async () => {
      const rig = makeRig({ scenario });
      const created: string[] = [];
      try {
        const client = new GatewayClient(rig.tools, rig.runId);
        const p = await prepare(client);
        expect(p.knownBefore, '这个业务引用在运行前不该命中任何单').toEqual([]);

        const r = await client.createDraft(p.doc, p.key);
        if (r.erpRef) created.push(r.erpRef.name);
        expect(r.status, scenario + ' 下这次写的终态就是不明').toBe('uncertain');

        const beforeReconcile = frozenCopy(await rig.audit.byRun(rig.runId));
        const uncertainAt = beforeReconcile
          .findIndex((e) => e.capability === 'erp.create_draft' && e.outcome === 'uncertain');
        expect(uncertainAt, '审计里要有那条 uncertain').toBeGreaterThanOrEqual(0);
        const attemptsAtUncertain = (await rig.ledger.get(rig.principal, p.key))!.attempts;

        // ── 显式对账 ──
        const rec = await reconcileByBusinessRef(rig, client, p);

        // 回查用的是业务引用，不是单号。
        expect(Object.keys(rec.filters).sort()).toEqual(['schedule_date', 'supplier']);
        expect(Object.keys(rec.filters)).not.toContain('name');
        expect(rec.filters.supplier).toBe(FACTS.supplier);
        expect(rec.filters.schedule_date).toBe(SCHEDULE_DATE);

        expect(rec.state, '两种故障下宿主里都确实有那张单').toBe('succeeded');
        expect(rec.fresh.length).toBe(1);
        expect(rec.found?.name ?? '').toMatch(PO_NAME);
        if (r.erpRef) expect(rec.found?.name).toBe(r.erpRef.name);

        // 台账收敛到终态，不停在 uncertain / executing。
        const row = await rig.ledger.get(rig.principal, p.key);
        expect(row!.state).toBe('succeeded');
        expect(row!.state).not.toBe('uncertain');
        expect(row!.state).not.toBe('executing');
        expect(row!.erpRef?.name).toBe(rec.found?.name);
        expect(row!.attempts, '对账不是一次新的执行').toBe(attemptsAtUncertain);

        // 审计：旧条目一字未改，结论是追加的，回查那一条按业务引用发出去。
        const afterReconcile = await rig.audit.byRun(rig.runId);
        expect(afterReconcile.length).toBeGreaterThan(beforeReconcile.length);
        expect(frozenCopy(afterReconcile).slice(0, beforeReconcile.length))
          .toEqual(beforeReconcile);

        const requery = afterReconcile.slice(beforeReconcile.length)
          .find((e) => e.capability === 'erp.query' && e.erpDoctype === DOCTYPE);
        expect(requery, '对账的回查要留一条 erp.query 审计').toBeTruthy();
        expect(requery!.outcome).toBe('done');
        expect(requery!.erpName, '按业务引用查，不是按单号查').toBeNull();

        // 终局：符合业务引用的草稿恰好一张。
        const matching = await client.query(DOCTYPE, rec.filters);
        const drafts = matching.filter((d) => Number(d.docstatus) === 0);
        expect(drafts.length, '重试过就会在这里数出两张').toBe(1);
        expect(String(drafts[0]!.name)).toMatch(PO_NAME);
        const draftLine = (drafts[0]!.items as Record<string, unknown>[])[0]!;
        expect(numberField(draftLine, 'qty')).toBe(EXPECTED_SHORTFALL);
        expect(draftLine.warehouse).toBe(FACTS.warehouse);

        // 原单一字未动。
        const orig = rig.mock!.snapshot(rig.site, DOCTYPE).find((d) => d.name === FACTS.originalPo);
        expect(Number(orig?.docstatus)).toBe(FACTS.originalPoDocstatus);
        const origLine = (orig!.items as Record<string, unknown>[])[0]!;
        expect(numberField(origLine, 'qty')).toBe(FACTS.orderedQty);
        expect(numberField(origLine, 'rate')).toBe(FACTS.rate);
      } finally {
        removeExact(rig, created);
        rig.cleanup();
      }
    });
  }

  it('single-order · 反向：回查确认宿主里什么都没有 → 收敛成 failed，不是硬写 succeeded', async () => {
    const rig = makeRig({ scenario: 'uncertain-a' });
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const p = await prepare(client);

      const r = await client.createDraft(p.doc, p.key);
      expect(r.status).toBe('uncertain');
      expect(r.erpRef).toBeTruthy();

      // 制造「宿主里其实没有」这个局面：按确切单号把那张删掉，再对账。
      // 删的是这次自己写进去的那一张，不碰基线。
      expect(rig.mock!.removeExact(rig.site, DOCTYPE, r.erpRef!.name)).toBe(true);

      const rec = await reconcileByBusinessRef(rig, client, p);
      expect(rec.fresh.length).toBe(0);
      expect(rec.state, '确认没有才是 failed —— 这条路证明对账不是无脑写 succeeded').toBe('failed');
      expect(rec.found).toBeNull();

      const row = await rig.ledger.get(rig.principal, p.key);
      expect(row!.state).toBe('failed');
      expect(row!.state).not.toBe('uncertain');
    } finally {
      rig.cleanup();
    }
  });
});
