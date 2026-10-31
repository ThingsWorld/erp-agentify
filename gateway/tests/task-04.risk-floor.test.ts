// Task 04 公开测试：副作用画像与 FLOOR。
//
// 要撞的就是工单里那件事：分级表是自己仓里的文件，谁都能改一行。
// 所以这里真的把 LOCAL_RISK_MAP 的 erp.submit 改成「只读」，再拿同一个 client
// 去提交刚建的那张草稿 —— 看拦不拦得住、是哪一层拦的。
//
// 拦它的是 policy.ts 的 check()，它读 types.ts 里冻结的 FLOOR，不读 src/risk-map.ts。
// 真实部署里那段代码跑在网关服务端，学员的仓里根本没有那个文件。
//
//   npx vitest run tests/task-04.risk-floor.test.ts
//
// 每条负例都配阳性对照：草稿要真的建得出来，篡改要真的生效。
// 「全拒也绿」和「改了也没生效」这两种假绿都得堵上。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient, numberField } from '../src/gateway-client.js';
import { FakeErp } from '../src/erp-fake.js';
import { LOCAL_RISK_MAP, effectiveProfile, needsApproval } from '../src/risk-map.js';
import { localMapOnlyVerdict, preflightCall } from '../src/preflight.js';
import {
  CallResult, CAPABILITIES, Capability, EffectProfile, FACTS, FLOOR,
} from '../src/types.js';

const DOCTYPE = 'Purchase Order' as const;
const SCHEDULE_DATE = '2026-09-30';
const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;

/** 幂等键带业务语义，没有随机数 —— reset 要靠这两个键把痕迹找回来。 */
const DRAFT_KEY = `t04-probe|draft|${FACTS.itemCode}x${FACTS.requiredQty - FACTS.onHandQty}`;
const submitKeyFor = (name: string) => `t04-probe|submit|${name}`;

/** 篡改用的「只读」画像 —— 上一课那个一行改动。 */
const READ_LIKE: EffectProfile =
  { channel: 'read', irreversible: false, touchesMoney: false, changesPayee: false };

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
    schedule_date: SCHEDULE_DATE,
    items: [{
      item_code: FACTS.itemCode,
      qty: FACTS.requiredQty - FACTS.onHandQty,
      rate: FACTS.rate,
      // 库存物料的行必须带仓库，漏了 live 会整单打回
      // （Row #1: Warehouse is mandatory for stock Item）。
      warehouse: FACTS.warehouse,
      schedule_date: SCHEDULE_DATE,
    }],
  };
}

describe('task-04 · 副作用画像与 FLOOR', () => {
  let rig: Rig;
  let mock: FakeErp;
  let client: GatewayClient;
  let originalSubmit: EffectProfile;
  /** 本轮自己建的那张，收尾按确切单号删。 */
  let draftName: string | null;

  beforeEach(() => {
    rig = makeRig({ scenario: 'floor-probe' });
    mock = mockOf(rig);
    client = new GatewayClient(rig.tools, rig.runId);
    originalSubmit = { ...LOCAL_RISK_MAP['erp.submit'] };
    draftName = null;
  });

  afterEach(() => {
    // 表还回去，别让被改过的表漏给下一条用例。
    LOCAL_RISK_MAP['erp.submit'] = originalSubmit;
    if (draftName) mock.removeExact(rig.site, DOCTYPE, draftName);
    rig.cleanup();
  });

  /** 建草稿 → 篡改分级表 → 提交同一张单。返回三步的结果。 */
  async function runTamperProbe(): Promise<{ draft: CallResult; submitted: CallResult; key: string }> {
    const draft = await client.createDraft(draftDoc(), DRAFT_KEY);
    if (draft.status !== 'done' || !draft.erpRef) {
      throw new Error(`建草稿没成功：status=${draft.status} reason=${draft.reason ?? '-'}`);
    }
    draftName = draft.erpRef.name;

    LOCAL_RISK_MAP['erp.submit'] = { ...READ_LIKE };

    const key = submitKeyFor(draftName);
    const submitted = await client.submit(draftName, key, '');
    return { draft, submitted, key };
  }

  // ── 一、四属性的画像 ─────────────────────────────────────────

  it('四个 capability 各有一条四属性齐全的 EffectProfile，没有靠展开默认值补齐', () => {
    for (const cap of CAPABILITIES) {
      const p = LOCAL_RISK_MAP[cap];
      expect(p, cap + ' 在分级表里没有').toBeTruthy();
      expect(['read', 'write_local', 'exec', 'external']).toContain(p.channel);
      expect(typeof p.irreversible, cap + '.irreversible 不是布尔').toBe('boolean');
      expect(typeof p.touchesMoney, cap + '.touchesMoney 不是布尔').toBe('boolean');
      expect(typeof p.changesPayee, cap + '.changesPayee 不是布尔').toBe('boolean');
      expect(Object.keys(p).sort()).toEqual(['changesPayee', 'channel', 'irreversible', 'touchesMoney']);
    }
    expect(Object.keys(LOCAL_RISK_MAP).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('read 与写分得开：query / get 是 read，create_draft / submit 不是', () => {
    expect(LOCAL_RISK_MAP['erp.query'].channel).toBe('read');
    expect(LOCAL_RISK_MAP['erp.get'].channel).toBe('read');
    expect(LOCAL_RISK_MAP['erp.create_draft'].channel).not.toBe('read');
    expect(LOCAL_RISK_MAP['erp.submit'].channel).not.toBe('read');
  });

  it('create_draft 与 submit 至少在 irreversible 这一位上不同，不是「写」一个档次', () => {
    const draft = LOCAL_RISK_MAP['erp.create_draft'];
    const submit = LOCAL_RISK_MAP['erp.submit'];
    expect(draft.irreversible).toBe(false);
    expect(submit.irreversible).toBe(true);
    expect(draft.irreversible).not.toBe(submit.irreversible);
    // 决定要不要人批的就是这一位。
    expect(needsApproval(draft)).toBe(false);
    expect(needsApproval(submit)).toBe(true);
  });

  // ── 二、本地闸点名属性 ───────────────────────────────────────

  it('preflight 点名是哪一位属性触发的，不是只说「风险太高」', () => {
    const denied = preflightCall('erp.submit', { idempotencyKey: 't04-probe|submit|X' });
    expect(denied.allow).toBe(false);
    expect(denied.attribute).toBe('irreversible');
    expect(denied.reason).toContain('irreversible');

    // 写操作漏了幂等键，报的是幂等键这一位，不是笼统一句「不让写」。
    const noKey = preflightCall('erp.create_draft', {});
    expect(noKey.allow).toBe(false);
    expect(noKey.attribute).toBe('idempotencyKey');

    // positive-control：草稿可逆，本地闸必须放行 —— 全拦死的话 task-05 根本跑不动。
    const ok = preflightCall('erp.create_draft', { idempotencyKey: DRAFT_KEY });
    expect(ok.allow).toBe(true);
    expect(ok.attribute).toBeNull();
    expect(preflightCall('erp.query').allow).toBe(true);
    expect(preflightCall('erp.get').allow).toBe(true);
  });

  // ── 三、核心：改自己的表绕不过 FLOOR ─────────────────────────

  it('分级表被降级成 read 之后，submit 仍然被 Gateway 拒', async () => {
    const submittedBefore = mock.snapshot(rig.site, DOCTYPE).filter((d) => Number(d.docstatus) === 1).length;

    // 篡改前的对照：只看本地表的话，submit 是要人批的。
    expect(localMapOnlyVerdict('erp.submit').needsApproval).toBe(true);

    const { draft, submitted, key } = await runTamperProbe();

    // 阳性对照：草稿这条正常路径真的走通了，不是「什么都建不出来所以什么都拒」。
    expect(draft.status).toBe('done');
    expect(draft.erpRef?.name ?? '').toMatch(PO_NAME);
    expect(draft.docstatus).toBe(0);

    // 篡改真的生效了：只看本地表现在是「不用批」。上一课就是在这儿变成静默 no-op 的。
    expect(localMapOnlyVerdict('erp.submit').needsApproval).toBe(false);
    expect(LOCAL_RISK_MAP['erp.submit'].channel).toBe('read');
    // 但取更严的那个之后，irreversible 还是 true —— 本地表只能收紧，不能放松。
    expect(effectiveProfile('erp.submit').irreversible).toBe(true);
    expect(effectiveProfile('erp.submit').channel).toBe('external');

    // 服务端那一层照样拒。
    expect(submitted.status).toBe('denied');
    expect(submitted.code).toBe('APPROVAL_REQUIRED');
    expect(submitted.auditId).toBeTruthy();
    expect(String(submitted.reason)).not.toBe('');

    // FLOOR 在 reserve 之前就拒了，被拒的调用不进台账。
    expect(await rig.ledger.get(rig.principal, key)).toBeNull();

    // 草稿还是草稿，一张单都没被推过 0 → 1 那条线。
    const after = await client.get(DOCTYPE, draftName as string);
    expect(numberField(after, 'docstatus')).toBe(0);
    const submittedAfter = mock.snapshot(rig.site, DOCTYPE).filter((d) => Number(d.docstatus) === 1).length;
    expect(submittedAfter).toBe(submittedBefore);
  });

  it('FLOOR 是冻的：改不动，也不受本地分级表影响', () => {
    LOCAL_RISK_MAP['erp.submit'] = { ...READ_LIKE };
    expect(FLOOR['erp.submit'].irreversible).toBe(true);
    expect(Object.isFrozen(FLOOR)).toBe(true);
    expect(Object.isFrozen(FLOOR['erp.submit'])).toBe(true);

    // 严格模式下给冻结对象赋值会抛。抛出来才算真冻住。
    expect(() => {
      (FLOOR as unknown as Record<string, EffectProfile>)['erp.submit'] = { ...READ_LIKE };
    }).toThrow();
    expect(() => {
      (FLOOR['erp.submit'] as unknown as { irreversible: boolean }).irreversible = false;
    }).toThrow();
    expect(FLOOR['erp.submit'].irreversible).toBe(true);
  });

  it('建草稿带上了仓库，单号形状对，原采购单一字未动', async () => {
    const { draft } = await runTamperProbe();
    expect(draft.status).toBe('done');

    const back = await client.get(DOCTYPE, draftName as string);
    const items = back.items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]?.warehouse).toBe(FACTS.warehouse);
    expect(numberField(items[0] as Record<string, unknown>, 'qty')).toBe(FACTS.requiredQty - FACTS.onHandQty);

    // 原单：docstatus=1、ITEM-SHELF-01 50 个、单价 70、供应商 Globex。
    const orig = await client.get(DOCTYPE, FACTS.originalPo);
    expect(numberField(orig, 'docstatus')).toBe(FACTS.originalPoDocstatus);
    expect(orig.supplier).toBe(FACTS.supplier);
    const origItems = orig.items as Record<string, unknown>[];
    expect(origItems).toHaveLength(1);
    const line = origItems[0] as Record<string, unknown>;
    expect(line.item_code).toBe(FACTS.itemCode);
    expect(numberField(line, 'qty')).toBe(FACTS.orderedQty);
    expect(numberField(line, 'rate')).toBe(FACTS.rate);
  });

  // ── 四、被拒的调用要留痕 ─────────────────────────────────────

  it('被拒的 submit 在审计里留了完整的一条，字段齐全', async () => {
    const { submitted, key } = await runTamperProbe();
    expect(submitted.status).toBe('denied');

    const entries = await rig.audit.byRun(rig.runId);
    const denied = entries.filter((e) => e.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(1);

    for (const e of denied) {
      expect(e.capability).toBe('erp.submit');
      // 没执行就没有回查时刻，也没有终态。
      expect(e.docstatus).toBeNull();
      expect(e.verifiedAt).toBeNull();
      // 事后能看出试的是哪张单。
      expect(typeof e.argsDigest).toBe('string');
      expect(e.argsDigest.length).toBeGreaterThan(0);
      expect(e.idempotencyKey).toBe(key);
      // 身份取自令牌解析出来的 Principal。
      expect(e.learnerId).toBe(rig.principal.learnerId);
      expect(e.siteId).toBe(rig.principal.siteId);
    }

    // 报告里给的 auditId 要真能查到这条。
    expect(denied.some((e) => e.id === submitted.auditId)).toBe(true);

    // 这个 task 拿不到有效凭证，不该有任何成功的提交。
    const goodSubmits = entries.filter(
      (e) => e.capability === 'erp.submit' && (e.outcome === 'done' || e.outcome === 'deduped'),
    );
    expect(goodSubmits).toHaveLength(0);
  });

  it('审计正反两个方向都查得到：凭 runId 查得到拒绝，凭单号查得到是谁建的', async () => {
    const { draft, submitted } = await runTamperProbe();

    // 正向：这次 run 在 ERP 里留下了什么。
    const byRun = await rig.audit.byRun(rig.runId);
    expect(byRun.map((e) => e.id)).toContain(submitted.auditId);
    expect(byRun.map((e) => e.id)).toContain(draft.auditId);
    expect(byRun.every((e) => e.runId === rig.runId)).toBe(true);

    // 反向：这张单是哪次 run、哪个能力建的。
    const byRef = await rig.audit.byErpRef({ doctype: DOCTYPE, name: draftName as string });
    const created = byRef.filter((e) => e.capability === 'erp.create_draft' && e.outcome === 'done');
    expect(created.length).toBeGreaterThanOrEqual(1);
    const c = created[0] as NonNullable<(typeof created)[number]>;
    expect(c.runId).toBe(rig.runId);
    expect(c.docstatus).toBe(0);
    expect(c.verifiedAt).not.toBeNull();
    expect(c.idempotencyKey).toBe(DRAFT_KEY);
  });

  // ── 五、四个能力走出不同的结局 ───────────────────────────────

  it('不带审批凭证时：query / get / create_draft 放行，submit 被拒 —— 四者不是一个档次', async () => {
    const q = await client.query('Bin', { item_code: FACTS.itemCode, warehouse: FACTS.warehouse });
    expect(q.length).toBeGreaterThan(0);

    const g = await client.get(DOCTYPE, FACTS.originalPo);
    expect(numberField(g, 'docstatus')).toBe(FACTS.originalPoDocstatus);

    const { draft, submitted } = await runTamperProbe();

    const outcomeOf = async (cap: Capability): Promise<string[]> => {
      const entries = await rig.audit.byRun(rig.runId);
      return entries.filter((e) => e.capability === cap).map((e) => e.outcome);
    };

    expect(await outcomeOf('erp.query')).toContain('done');
    expect(await outcomeOf('erp.get')).toContain('done');
    expect(draft.status).toBe('done');
    expect(submitted.status).toBe('denied');
    // 关键：草稿和提交的结局必须不同。都拒也算没做对。
    expect(draft.status).not.toBe(submitted.status);
    expect(await outcomeOf('erp.create_draft')).toContain('done');
    expect(await outcomeOf('erp.submit')).toEqual(['denied']);
  });

  // ── 六、终局回到基线 ─────────────────────────────────────────

  it('按确切单号清理之后回到基线的 6 张，已提交张数没变', async () => {
    const before = mock.count(rig.site, DOCTYPE);
    expect(before).toBe(FACTS.baselinePurchaseOrders);
    const submittedBefore = mock.snapshot(rig.site, DOCTYPE).filter((d) => Number(d.docstatus) === 1).length;

    await runTamperProbe();
    expect(mock.count(rig.site, DOCTYPE)).toBe(before + 1);

    // 按 name 删。不按 creation / supplier / schedule_date 批删 ——
    // 那种清场会把别人正在跑的单子一起端掉。
    const name = draftName as string;
    expect(mock.removeExact(rig.site, DOCTYPE, name)).toBe(true);
    draftName = null;

    expect(mock.count(rig.site, DOCTYPE)).toBe(before);
    const submittedAfter = mock.snapshot(rig.site, DOCTYPE).filter((d) => Number(d.docstatus) === 1).length;
    expect(submittedAfter).toBe(submittedBefore);
    expect(mock.snapshot(rig.site, DOCTYPE).some((d) => d.name === FACTS.originalPo)).toBe(true);
  });
});
