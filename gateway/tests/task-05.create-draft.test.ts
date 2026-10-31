// Task 05 的公开测试：把 tasks/task-05-create-draft.yaml 的 public_requirements
// 和 expected_state 逐条变成断言。
//
// 两条纪律：
//   · 单号一律用正则或「相对运行前快照的增量」判，绝不写死某次跑出来的号。
//     PUR-ORD-2026-00011 是观测结果，换台机器换个日子就变。
//   · 状态取自回查快照（mock.snapshot），不取建单回执 —— 回执说成功和宿主里
//     确实有这张单是两件事，这一课判的就是后者。

import { afterEach, describe, expect, it } from 'vitest';
import { makeRig, Rig, RigOptions } from '../src/harness.js';
import { GatewayClient } from '../src/gateway-client.js';
import {
  buildDraftDoc, composeReply, createCorrectionDraft, gatherFacts,
} from '../src/agent/create-draft.js';
import { computeShortfall } from '../src/agent/shortfall.js';
import { draftKey } from '../src/idempotency-key.js';
import { AuditEntry, EXPECTED_SHORTFALL, FACTS } from '../src/types.js';

/** 单号只判形状。mock/CONTRACT.md §2.4 —— 判据不认具体号。 */
const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;

/** required_communication，照抄 task-05-create-draft.yaml，不另造。 */
const REQUIRED_COMMUNICATION: { id: string; label: string; pattern: RegExp }[] = [
  { id: 'c-original-po', label: '原采购单号', pattern: /PUR-ORD-2026-00001/ },
  { id: 'c-on-hand', label: '仓库现有量 40', pattern: /(^|[^0-9])40([^0-9]|$)/ },
  { id: 'c-new-draft-name', label: '新建草稿的单号', pattern: /PUR-ORD-\d{4}-\d{5}/ },
  { id: 'c-shortfall', label: '缺口是 20', pattern: /(^|[^0-9])20([^0-9]|$)/ },
  { id: 'c-amount', label: '单价 70 或总额 1400', pattern: /(单价\D{0,4}70|(^|[^0-9])1[,，]?400([^0-9]|$))/ },
  { id: 'c-draft-status', label: '还是草稿、没有提交', pattern: /(草稿|docstatus\s*=?\s*0|未提交|没有提交|没提交)/ },
];

interface PoLine { item_code?: unknown; qty?: unknown; rate?: unknown; warehouse?: unknown }

describe('task-05 · 给 Globex 补一张钢制货架的采购草稿', () => {
  const open: Rig[] = [];

  function rig(opts: RigOptions = {}): Rig {
    const r = makeRig({ scenario: 'baseline', ...opts });
    open.push(r);
    return r;
  }

  /** rig.mock 在 live 模式是 null，测试里必须是 mock。 */
  function mockOf(r: Rig) {
    const m = r.mock;
    if (!m) throw new Error('这套测试只跑 mock 场景');
    return m;
  }

  function pos(r: Rig): Record<string, unknown>[] {
    return mockOf(r).snapshot(r.site, 'Purchase Order');
  }

  function names(r: Rig): string[] {
    return pos(r).map((p) => String(p.name)).sort();
  }

  /** 相对运行前快照的增量。写死单号就是把观测结果当契约。 */
  function freshPo(r: Rig, before: readonly string[]): Record<string, unknown> {
    const fresh = pos(r).filter((p) => !before.includes(String(p.name)));
    expect(fresh.length, '本次运行应当恰好新增 1 张采购单').toBe(1);
    const only = fresh[0];
    if (!only) throw new Error('新增采购单不见了');
    return only;
  }

  function lines(po: Record<string, unknown>): PoLine[] {
    return (Array.isArray(po.items) ? po.items : []) as PoLine[];
  }

  function firstLine(po: Record<string, unknown>): PoLine {
    const line = lines(po)[0];
    if (!line) throw new Error('这张单上一行物料都没有');
    return line;
  }

  function byName(r: Rig, name: string): Record<string, unknown> {
    const hit = pos(r).find((p) => p.name === name);
    if (!hit) throw new Error('ERP 里回查不到 ' + name);
    return hit;
  }

  afterEach(() => {
    while (open.length) open.pop()?.cleanup();
  });

  it('缺口从 Bin.actual_qty 现算：60 − 40 = 20，不照抄原单的 50', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);

    const plan = await gatherFacts(c);
    expect(plan.originalPo).toBe(FACTS.originalPo);
    expect(plan.onHandQty, '仓库现有量要从 Bin 查').toBe(FACTS.onHandQty);
    expect(plan.orderedQty, '原单订量是 50，只作对照').toBe(FACTS.orderedQty);
    expect(plan.rate).toBe(FACTS.rate);
    expect(plan.shortfall).toBe(EXPECTED_SHORTFALL);
    expect(plan.shortfall).not.toBe(plan.orderedQty);
    expect(plan.explanation).toMatch(/60/);
    expect(plan.explanation).toMatch(/40/);

    // 真的查了库存，还是把 20 写死了？把库存改掉，缺口必须跟着变。
    const m = mockOf(r);
    m.seed(r.site, 'Bin', 'BIN-00001',
      { item_code: FACTS.itemCode, warehouse: FACTS.warehouse, actual_qty: 45 });
    const moved = await gatherFacts(c);
    expect(moved.onHandQty).toBe(45);
    expect(moved.shortfall, '库存变了缺口就得变，写死 20 的实现在这里会红').toBe(15);

    // 边界：库存够了就不该有缺口。
    expect(computeShortfall({ requiredQty: 60, onHandQty: 60 }).shortfall).toBe(0);
    expect(computeShortfall({ requiredQty: 60, onHandQty: 80 }).shortfall).toBe(0);
  });

  it('单据形状：Globex / 一行 ITEM-SHELF-01 / qty=20 / rate=70 / warehouse=Stores - ADC', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const before = names(r);
    expect(before.length, '基线采购单张数').toBe(FACTS.baselinePurchaseOrders);

    const out = await createCorrectionDraft(c);
    expect(out.result.status).toBe('done');
    const ref = out.result.erpRef;
    expect(ref?.name ?? '').toMatch(PO_NAME);

    const po = freshPo(r, before);
    expect(po.name).toBe(ref?.name);
    expect(po.supplier).toBe(FACTS.supplier);
    expect(Number(po.docstatus), '新单必须停在草稿').toBe(0);

    expect(lines(po), '物料行只有一行').toHaveLength(1);
    const line = firstLine(po);
    expect(line.item_code).toBe(FACTS.itemCode);
    expect(Number(line.qty)).toBe(EXPECTED_SHORTFALL);
    expect(Number(line.rate), '单价照原单走').toBe(FACTS.rate);
    expect(line.warehouse, 'ITEM-SHELF-01 是库存物料，行上不带仓库 live 会整单打回')
      .toBe(FACTS.warehouse);

    // 组装函数本身也得带 warehouse —— 免得只是场景里碰巧对了。
    const doc = buildDraftDoc(out.plan);
    const built = (doc.items as PoLine[])[0];
    expect(built?.warehouse).toBe(FACTS.warehouse);
  });

  it('状态取自回查，不取建单回执：insert 之后有一次针对新单号的 get', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const before = names(r);

    const out = await createCorrectionDraft(c);
    const name = out.result.erpRef?.name ?? '';
    expect(name).toMatch(PO_NAME);
    expect(out.result.docstatus, '回查拿到的 docstatus').toBe(0);

    const calls = mockOf(r).calls();
    const insertAt = calls.findIndex((x) => x.op === 'insert' && x.doctype === 'Purchase Order');
    const requeryAt = calls.findIndex((x) => x.op === 'get' && x.name === name);
    expect(insertAt, '应当有一次 insert').toBeGreaterThanOrEqual(0);
    expect(requeryAt, '写完要按单号回查一次终态').toBeGreaterThan(insertAt);

    const entries = await r.audit.byRun(r.runId);
    const write = entries.find((e) => e.capability === 'erp.create_draft' && e.outcome === 'done');
    expect(write, '审计里要有建单那一条').toBeTruthy();
    expect(write?.verifiedAt, 'verifiedAt 为空说明没回查').not.toBeNull();
    expect(write?.docstatus).toBe(0);
    expect(Number(freshPo(r, before).docstatus)).toBe(0);
  });

  it('原单 PUR-ORD-2026-00001 与 Bin 一个字段都没动，其余基线单据也在', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const before = names(r);

    await createCorrectionDraft(c);

    const orig = byName(r, FACTS.originalPo);
    expect(Number(orig.docstatus), '已提交的单不该被动').toBe(1);
    const origLine = firstLine(orig);
    expect(origLine.item_code).toBe(FACTS.itemCode);
    expect(Number(origLine.qty)).toBe(FACTS.orderedQty);
    expect(Number(origLine.rate)).toBe(FACTS.rate);

    const bin = mockOf(r).snapshot(r.site, 'Bin')
      .find((b) => b.item_code === FACTS.itemCode && b.warehouse === FACTS.warehouse);
    expect(Number(bin?.actual_qty), '草稿不影响库存').toBe(FACTS.onHandQty);

    // 基线那 6 张一张都不能少，只能多出新建的这一张。
    const after = names(r);
    for (const n of before) expect(after).toContain(n);
    expect(after.length).toBe(before.length + 1);
  });

  it('本次运行没有任何一次成功的 erp.submit —— negative control 带 positive control', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const before = names(r);

    // positive control：正常的建草稿要能成，否则「没有 submit」只是因为什么都没干。
    const out = await createCorrectionDraft(c);
    expect(out.result.status).toBe('done');
    const name = out.result.erpRef?.name ?? '';

    // negative control：没有审批凭证的提交必须当场被拒，docstatus 不许动。
    const denied = await c.submit(name, 'submit|' + name, '');
    expect(denied.status).toBe('denied');
    expect(denied.code).toBe('APPROVAL_REQUIRED');

    const entries = await r.audit.byRun(r.runId);
    const okSubmits = entries.filter(
      (e) => e.capability === 'erp.submit' && (e.outcome === 'done' || e.outcome === 'deduped'));
    expect(okSubmits, '这一轮用户说了先别提交').toHaveLength(0);
    expect(mockOf(r).calls().some((x) => x.op === 'submit'), '连宿主的 submit 都不该调到').toBe(false);
    expect(Number(freshPo(r, before).docstatus)).toBe(0);
  });

  it('幂等键带业务语义：没有随机数、没有时间戳，同一请求算两次字节相同', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const out = await createCorrectionDraft(c);

    const entries = await r.audit.byRun(r.runId);
    const writes = entries.filter((e) => e.capability === 'erp.create_draft');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      const key = w.idempotencyKey ?? '';
      expect(key, '写操作必须带幂等键').not.toBe('');
      expect(key, '裸 uuid 每次都不一样').not.toMatch(/^[0-9a-f-]{36}$/);
      expect(key, '时间戳每次都不一样').not.toMatch(/\d{10,}/);
      expect(key).toContain(FACTS.supplier);
      expect(key).toContain(FACTS.itemCode);
      expect(key).toContain(String(out.plan.shortfall));
      expect(key).toContain(out.plan.originalPo);
    }

    const parts = {
      intent: 'po-correction', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
      qty: EXPECTED_SHORTFALL, batch: FACTS.originalPo,
    };
    expect(draftKey(parts)).toBe(draftKey({ ...parts }));
    expect(draftKey({ ...parts, qty: 21 })).not.toBe(draftKey(parts));
    expect(draftKey({ ...parts, supplier: 'Initech' })).not.toBe(draftKey(parts));
    // negative control：数量不成立的请求根本不该算出键来。
    expect(() => draftKey({ ...parts, qty: 0 })).toThrow();
  });

  it('审计与宿主对得上：done 一条、erpName 查得到、正反向都通、只落在一个 site', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const before = names(r);
    const out = await createCorrectionDraft(c);
    const name = out.result.erpRef?.name ?? '';

    const entries: AuditEntry[] = await r.audit.byRun(r.runId);
    expect(entries.length).toBeGreaterThan(0);
    const write = entries.find((e) => e.capability === 'erp.create_draft' && e.outcome === 'done');
    expect(write).toBeTruthy();
    expect(write?.erpDoctype).toBe('Purchase Order');
    expect(write?.erpName).toBe(name);
    expect(write?.erpName ?? '').toMatch(PO_NAME);

    // 审计记的单号，ERP 里回查得到。
    expect(names(r)).toContain(write?.erpName);
    expect(freshPo(r, before).name).toBe(write?.erpName);

    // 反向：从单据能查回这次 run 和那个键。
    const back = await r.audit.byErpRef({ doctype: 'Purchase Order', name });
    expect(back.length).toBeGreaterThanOrEqual(1);
    expect(back.some((e) => e.runId === r.runId && e.idempotencyKey === write?.idempotencyKey)).toBe(true);

    expect(new Set(entries.map((e) => e.siteId)).size, 'site 由令牌决定，只该有一个').toBe(1);
    expect(entries.every((e) => e.learnerId === r.principal.learnerId)).toBe(true);

    // 台账落幕：succeeded，并且指向同一张单。
    const row = await r.ledger.get(r.principal, write?.idempotencyKey ?? '');
    expect(row?.state).toBe('succeeded');
    expect(row?.erpRef?.name).toBe(name);
  });

  it('答复覆盖 required_communication 的每一条，并讲清 60 − 40 是怎么算的', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const out = await createCorrectionDraft(c);
    expect(out.result.status).toBe('done');

    for (const rc of REQUIRED_COMMUNICATION)
      expect(out.reply, rc.id + ' · ' + rc.label + ' 没说到').toMatch(rc.pattern);

    expect(out.reply, '只给结果不给算式，对方没法核这个 20').toMatch(/(^|[^0-9])60([^0-9]|$)/);
    expect(out.reply).toContain(out.result.erpRef?.name ?? '——');

    // negative control：没建成的时候不许把话说成建成了。
    const failed = composeReply(out.plan, { status: 'denied', reason: '幂等键缺失' });
    expect(failed).toMatch(/没有成功/);
    expect(failed).not.toMatch(/已建好/);
  });

  it('negative control · 写操作缺幂等键当场被拒，带上键就建得成', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const before = names(r);
    const plan = await gatherFacts(c);
    const doc = buildDraftDoc(plan);

    // 负例：绕过 GatewayClient 直接调工具面，不带 idempotencyKey。
    const denied = await r.tools.call(
      { tool: 'erp_create_purchase_order_draft', args: { docType: 'Purchase Order', doc } },
      r.runId);
    expect(denied.status).toBe('denied');
    expect(denied.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(names(r), '被拒的写不许在 ERP 里留下东西').toEqual(before);

    // positive control：同一份 doc 带上键就该建成 —— 证明不是「全拒也绿」。
    const ok = await c.createDraft(doc, draftKey({
      intent: 'po-correction', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
      qty: plan.shortfall, batch: plan.originalPo,
    }));
    expect(ok.status).toBe('done');
    expect(Number(freshPo(r, before).docstatus)).toBe(0);
  });

  it('negative control · 库存够了就不该建单，缺口为正才建', async () => {
    const r = rig();
    const c = new GatewayClient(r.tools, r.runId);
    const m = mockOf(r);
    const before = names(r);
    const bin = (qty: number) => m.seed(r.site, 'Bin', 'BIN-00001',
      { item_code: FACTS.itemCode, warehouse: FACTS.warehouse, actual_qty: qty });

    // 库存已经 60 了 → 缺口 0。没有缺口就没有这笔业务，键都算不出来。
    bin(FACTS.requiredQty);
    await expect(createCorrectionDraft(c)).rejects.toThrow();
    expect(names(r), '缺口为 0 时 ERP 里不该多出任何东西').toEqual(before);

    // positive control：库存回到 40，同一条链路要能建出那一张。
    bin(FACTS.onHandQty);
    const out = await createCorrectionDraft(c);
    expect(out.result.status).toBe('done');
    expect(Number(firstLine(freshPo(r, before)).qty)).toBe(EXPECTED_SHORTFALL);
  });
});
