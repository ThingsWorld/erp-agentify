// Task 03 公开测试：身份与 site 隔离。
//
// 判四件事：
//   1. 身份只从平台令牌来。请求体里塞同名字段是**被拒**，不是被忽略后照常执行。
//   2. 两个 site 各读各的 —— 同名 Bin 一个 40 一个 99，那是分区，不是缓存没刷。
//   3. 知道确切单号也越不过 site 边界。
//   4. 阳性对照：本人读自己 site 的单据必须成功。这一条不过，上面三条的绿不作数。
//
//   npx vitest run tests/task-03.identity-isolation.test.ts
//   npx vitest run tests/task-03.identity-isolation.test.ts -t positive-control
//
// 场景是 two-sites：tok_learner → erp.localhost，tok_bob → erp-b.localhost，
// 两边同一份种子，只把 B 站的 Bin 数量 patch 成 99。
// 收尾一律按**确切单号**删，不按 supplier / 时间窗口批删。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRig, Rig } from '../src/harness.js';
import { Tools } from '../src/tools.js';
import { GatewayClient, numberField } from '../src/gateway-client.js';
import { Identity, MemoryTokenStore, TokenRecord } from '../src/identity.js';
import { FakeErp } from '../src/erp-fake.js';
import {
  CallRequest, DeniedError, FACTS, PERSONA_DOCTYPES, SPOOFABLE_FIELDS,
} from '../src/types.js';

const ALICE = 'tok_learner';
const BOB = 'tok_bob';
const ALICE_SITE = 'erp.localhost';
const BOB_SITE = 'erp-b.localhost';
const DOCTYPE = 'Purchase Order' as const;

/** 只存在于 B 站的一张单。alice 知道这个确切单号，也不该读得到。 */
const BOB_ONLY_PO = 'PO-BOB-1';

/** B 站被 patch 成 99；A 站还是种子里的 40。 */
const BOB_BIN_QTY = 99;

const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;

function mockOf(rig: Rig): FakeErp {
  const m = rig.mock;
  if (!m) throw new Error('这组用例只跑 mock 场景');
  return m;
}

function draftDoc(): Record<string, unknown> {
  return {
    supplier: FACTS.supplier,
    company: FACTS.company,
    currency: FACTS.currency,
    schedule_date: '2026-09-30',
    items: [{
      item_code: FACTS.itemCode,
      qty: 1,
      rate: FACTS.rate,
      warehouse: FACTS.warehouse,
      schedule_date: '2026-09-30',
    }],
  };
}

describe('task-03 · 身份与 site 隔离', () => {
  let rig: Rig;
  let mock: FakeErp;
  let alice: Tools;
  let bob: Tools;

  beforeEach(() => {
    rig = makeRig({ scenario: 'two-sites', token: ALICE });
    mock = mockOf(rig);
    // 两个令牌共用同一个 Gateway 和同一个 FakeErp —— 跨 site 才有得测。
    alice = new Tools(rig.gw, 'Bearer ' + ALICE);
    bob = new Tools(rig.gw, 'Bearer ' + BOB);
    // 只往 B 站铺这一张，A 站没有。收尾按确切单号删。
    mock.seed(BOB_SITE, DOCTYPE, BOB_ONLY_PO, {
      supplier: FACTS.supplier,
      transaction_date: '2026-05-01',
      grand_total: 100,
      items: [{ item_code: FACTS.itemCode, qty: 1, rate: 100, warehouse: FACTS.warehouse }],
    }, 0);
  });

  afterEach(() => {
    mock.removeExact(BOB_SITE, DOCTYPE, BOB_ONLY_PO);
    rig.cleanup();
  });

  // ── 阳性对照。放在最前面：它不过，后面所有「被拒」都不构成证据。 ──
  it('positive-control：bob 用自己的令牌读得到 PO-BOB-1，alice 读得到自己那份 40 的库存', async () => {
    const got = await bob.call({ tool: 'erp_get_document', args: { docType: DOCTYPE, name: BOB_ONLY_PO } }, rig.runId);
    expect(got.status).toBe('done');
    const doc = got.data as Record<string, unknown>;
    expect(doc.supplier).toBe(FACTS.supplier);
    expect(Number(doc.docstatus)).toBe(0);

    // alice 读自己 site 的 Bin，必须是 40 —— 拒绝条件不能宽到把本人也拦了。
    const client = new GatewayClient(new Tools(rig.gw, 'Bearer ' + ALICE), rig.runId);
    const bins = await client.query('Bin', { item_code: FACTS.itemCode, warehouse: FACTS.warehouse });
    const bin = bins[0];
    expect(bin).toBeTruthy();
    expect(numberField(bin as Record<string, unknown>, 'actual_qty')).toBe(FACTS.onHandQty);

    // alice 也读得到自己 site 的原采购单。四个 DocType 一个都没被误伤。
    const own = await alice.call({ tool: 'erp_get_document', args: { docType: DOCTYPE, name: FACTS.originalPo } }, rig.runId);
    expect(own.status).toBe('done');
    expect((own.data as Record<string, unknown>).supplier).toBe(FACTS.supplier);
  });

  it('同名 Bin 在两个 site 读出不同的数：40 vs 99，是分区不是缓存', async () => {
    const aq = await alice.call({
      tool: 'erp_query_documents', args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } },
    }, rig.runId);
    const bq = await bob.call({
      tool: 'erp_query_documents', args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } },
    }, rig.runId);
    expect(aq.status).toBe('done');
    expect(bq.status).toBe('done');

    const pick = (r: unknown): number => {
      const rows = r as Record<string, unknown>[];
      const row = rows.find((x) => x.warehouse === FACTS.warehouse);
      expect(row).toBeTruthy();
      return Number((row as Record<string, unknown>).actual_qty);
    };

    expect(pick(aq.data)).toBe(FACTS.onHandQty);
    expect(pick(bq.data)).toBe(BOB_BIN_QTY);
    expect(pick(aq.data)).not.toBe(pick(bq.data));

    // 两次查询下发的 site 各是各的，没有谁读到对面那张表。
    const sites = mock.calls().filter((c) => c.op === 'list' && c.doctype === 'Bin').map((c) => c.site);
    expect(sites).toEqual([ALICE_SITE, BOB_SITE]);
  });

  it('alice 知道确切单号 PO-BOB-1 也读不到 —— 查询被钉在她自己的 site 上', async () => {
    const from = mock.calls().length;
    let leaked: unknown = null;
    let err: unknown = null;
    try {
      leaked = await alice.call({ tool: 'erp_get_document', args: { docType: DOCTYPE, name: BOB_ONLY_PO } }, rig.runId);
    } catch (e) {
      err = e;
    }

    // 要么抛，要么返回非 done。总之不能把 B 站那张单交出去。
    if (leaked !== null) {
      expect((leaked as { status: string }).status).not.toBe('done');
      expect((leaked as { data?: unknown }).data).toBeUndefined();
    } else {
      expect(String((err as Error).message)).toContain(ALICE_SITE);
    }

    // 这次调用只碰了 alice 的 site，一次都没落到 B 站上。
    const touched = mock.calls().slice(from);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((c) => c.site === ALICE_SITE)).toBe(true);

    // B 站那张单原样还在，docstatus 没被动过。
    const bobRow = mock.snapshot(BOB_SITE, DOCTYPE).find((d) => d.name === BOB_ONLY_PO);
    expect(bobRow).toBeTruthy();
    expect(Number((bobRow as Record<string, unknown>).docstatus)).toBe(0);
    // A 站里也没凭空多出一张同名的。
    expect(mock.snapshot(ALICE_SITE, DOCTYPE).some((d) => d.name === BOB_ONLY_PO)).toBe(false);
  });

  it('请求体里每一个身份类字段都单独触发 SPOOFED_IDENTITY，且连台账都不占位', async () => {
    const aliceBefore = mock.count(ALICE_SITE, DOCTYPE);
    const bobBefore = mock.count(BOB_SITE, DOCTYPE);

    // 逐个字段跑，不做组合 —— 组合能过而单个不过，说明判断写成了「全部命中才拒」。
    for (const field of SPOOFABLE_FIELDS) {
      const key = 'iso-spoof|' + field;
      const req: Record<string, unknown> = {
        capability: 'erp.create_draft',
        args: { docType: DOCTYPE, doc: draftDoc() },
        idempotencyKey: key,
      };
      req[field] = BOB_SITE;

      const r = await rig.gw.call(rig.bearer, req as unknown as CallRequest, rig.runId);
      expect(r.status, field + ' 没被拒').toBe('denied');
      expect(r.code, field + ' 的拒绝码不对').toBe('SPOOFED_IDENTITY');
      // 错误信息里要点名命中的字段，调用方才知道该删哪一行。
      expect(String(r.reason), field + ' 没出现在拒绝理由里').toContain(field);

      // 连占位都不该发生 —— 有行就说明实现是「剥掉伪造字段再往下跑」。
      expect(await rig.ledger.get(rig.principal, key), field + ' 在台账里留了行').toBeNull();
    }

    // 伪造探针一条审计都不该留成功的痕迹。
    const entries = await rig.audit.byRun(rig.runId);
    const spoofed = entries.filter((e) => (e.idempotencyKey ?? '').startsWith('iso-spoof|'));
    expect(spoofed.filter((e) => e.outcome === 'done' || e.outcome === 'deduped')).toHaveLength(0);

    // 两个 site 都没多出单据。
    expect(mock.count(ALICE_SITE, DOCTYPE)).toBe(aliceBefore);
    expect(mock.count(BOB_SITE, DOCTYPE)).toBe(bobBefore);

    // positive-control：同一个写请求，把身份字段换成一个普通字段，必须放行。
    // 拒绝条件只认那 12 个固定的名字，不是「出现任何非预期字段就当伪造」。
    const ctrlKey = 'iso-spoof|control';
    const ctrl = await rig.gw.call(rig.bearer, {
      capability: 'erp.create_draft',
      args: { docType: DOCTYPE, doc: draftDoc() },
      idempotencyKey: ctrlKey,
      note: 'not-an-identity-field',
    } as unknown as CallRequest, rig.runId);
    expect(ctrl.status).toBe('done');
    expect(ctrl.erpRef?.name ?? '').toMatch(PO_NAME);

    // 按确切单号收拾掉，终局等于起始。
    if (ctrl.erpRef) mock.removeExact(ALICE_SITE, DOCTYPE, ctrl.erpRef.name);
    expect(mock.count(ALICE_SITE, DOCTYPE)).toBe(aliceBefore);
    expect(mock.count(BOB_SITE, DOCTYPE)).toBe(bobBefore);
  });

  it('四种令牌故障的错误信息互不相同，调用方分得清没带还是过期', async () => {
    const base = {
      learnerId: 'learner-a', siteId: ALICE_SITE, personaName: 'agent_svc',
      allowedDocTypes: PERSONA_DOCTYPES, revoked: false,
    };
    const store = new MemoryTokenStore();
    store.put('tok_ok', { ...base, expiresAt: Date.now() + 3_600_000 } as TokenRecord);
    store.put('tok_revoked', { ...base, expiresAt: Date.now() + 3_600_000, revoked: true } as TokenRecord);
    store.put('tok_expired', { ...base, expiresAt: Date.now() - 1_000 } as TokenRecord);
    const id = new Identity(store);

    const cases: { label: string; bearer: string | undefined; code: string }[] = [
      { label: '没带', bearer: undefined, code: 'MISSING_TOKEN' },
      { label: '不认识', bearer: 'Bearer tok_not_issued', code: 'INVALID_TOKEN' },
      { label: '已吊销', bearer: 'Bearer tok_revoked', code: 'INVALID_TOKEN' },
      { label: '已过期', bearer: 'Bearer tok_expired', code: 'EXPIRED_TOKEN' },
    ];

    const messages: string[] = [];
    for (const c of cases) {
      let caught: unknown = null;
      try {
        await id.resolve(c.bearer);
      } catch (e) {
        caught = e;
      }
      expect(caught, c.label + ' 没抛').toBeInstanceOf(DeniedError);
      const e = caught as DeniedError;
      expect(e.code, c.label + ' 的拒绝码不对').toBe(c.code);
      expect(e.message.trim().length).toBeGreaterThan(0);
      messages.push(e.message);
    }
    // 四条信息必须互不相同 —— 都写「令牌有问题」就等于什么都没说。
    expect(new Set(messages).size).toBe(4);

    // positive-control：好令牌解析得出来，三个字段全部来自令牌记录。
    const p = await id.resolve('Bearer tok_ok');
    expect(p.learnerId).toBe('learner-a');
    expect(p.siteId).toBe(ALICE_SITE);
    expect(p.persona.name).toBe('agent_svc');
    expect(p.persona.allowedDocTypes).toEqual(PERSONA_DOCTYPES);
  });

  it('全程下发给 ErpClient 的 persona 恒为 agent_svc，site 跟着令牌走', async () => {
    const from = mock.calls().length;

    await alice.call({ tool: 'erp_query_documents', args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } } }, rig.runId);
    await alice.call({ tool: 'erp_get_document', args: { docType: DOCTYPE, name: FACTS.originalPo } }, rig.runId);
    const aliceCalls = mock.calls().slice(from);

    const mid = mock.calls().length;
    await bob.call({ tool: 'erp_query_documents', args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } } }, rig.runId);
    await bob.call({ tool: 'erp_get_document', args: { docType: DOCTYPE, name: BOB_ONLY_PO } }, rig.runId);
    const bobCalls = mock.calls().slice(mid);

    expect(aliceCalls.length).toBeGreaterThanOrEqual(2);
    expect(bobCalls.length).toBeGreaterThanOrEqual(2);
    expect(aliceCalls.every((c) => c.site === ALICE_SITE)).toBe(true);
    expect(bobCalls.every((c) => c.site === BOB_SITE)).toBe(true);

    const bad = ['Administrator', 'System Manager', 'root', ''];
    for (const c of mock.calls()) {
      expect(c.persona).toBe('agent_svc');
      expect(bad).not.toContain(c.persona);
    }

    // 审计里的身份也只能来自令牌：不存在 learner-a 挂着 B 站的条目。
    const entries = await rig.audit.byRun(rig.runId);
    expect(entries.length).toBeGreaterThan(0);
    const pairs = new Set(entries.map((e) => e.learnerId + '@' + e.siteId));
    expect([...pairs].sort()).toEqual(['learner-a@' + ALICE_SITE, 'learner-b@' + BOB_SITE]);
    expect(entries.some((e) => e.learnerId === 'learner-a' && e.siteId === BOB_SITE)).toBe(false);
    expect(entries.some((e) => e.learnerId === 'learner-b' && e.siteId === ALICE_SITE)).toBe(false);
  });

  it('跨 site 的写也进不去：alice 建的草稿只落在自己 site', async () => {
    const aliceBefore = mock.count(ALICE_SITE, DOCTYPE);
    const bobBefore = mock.count(BOB_SITE, DOCTYPE);

    const key = 'iso-probe-03';
    const r = await rig.gw.call(rig.bearer, {
      capability: 'erp.create_draft',
      args: { docType: DOCTYPE, doc: draftDoc() },
      idempotencyKey: key,
    }, rig.runId);

    expect(r.status).toBe('done');
    const name = r.erpRef?.name ?? '';
    expect(name).toMatch(PO_NAME);

    expect(mock.count(ALICE_SITE, DOCTYPE)).toBe(aliceBefore + 1);
    expect(mock.count(BOB_SITE, DOCTYPE)).toBe(bobBefore);
    expect(mock.snapshot(BOB_SITE, DOCTYPE).some((d) => d.name === name)).toBe(false);
    const inserts = mock.calls().filter((c) => c.op === 'insert');
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.every((c) => c.site === ALICE_SITE)).toBe(true);

    // 按确切单号删，终局等于起始。
    expect(mock.removeExact(ALICE_SITE, DOCTYPE, name)).toBe(true);
    expect(mock.count(ALICE_SITE, DOCTYPE)).toBe(aliceBefore);
    expect(mock.count(BOB_SITE, DOCTYPE)).toBe(bobBefore);
  });
});
