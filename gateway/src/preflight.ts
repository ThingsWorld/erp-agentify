// 起飞前检查。两件事挤在一个文件里，因为它们是同一个动作的两半：
//
//   runPreflight()  —— 环境体检。种子没被动过、场景装得起来、基线是 6 张、
//                      网关真能读一次、FLOOR 是冻的。跑功能之前先跑它。
//   preflightCall() —— 单次调用的本地闸（Task 04）。在发请求之前就拦下
//                      「不可逆而且没带审批凭证」的调用，并且**点名是哪一位属性**触发的。
//
// 本地闸不是安全边界，是省一趟往返和一条审计噪音。真正的闸在 Gateway 服务端的
// policy.ts，它读 types.ts 里冻结的 FLOOR，不读 src/risk-map.ts。
// 把这里改松了，服务端照样拒 —— src/tamper-probe.ts 就是去撞这件事的。
//
// 直接跑：npx tsx src/preflight.ts

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Capability, DocType, EffectProfile, FACTS, FLOOR } from './types.js';
import { effectiveProfile, LOCAL_RISK_MAP } from './risk-map.js';
import { loadScenario } from './erp-mock.js';
import { makeLiveRig, makeRig } from './harness.js';
import { GatewayClient, numberField } from './gateway-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 一、单次调用的本地闸（Task 04）────────────────────────────────

/** 触发拒绝的那一位属性。放行时是 null。 */
export type TripWire = 'irreversible' | 'changesPayee' | 'idempotencyKey' | null;

export interface PreflightVerdict {
  allow: boolean;
  /** 哪一位属性把它拦下来的。报告和日志里要写这个，不能只说「风险太高」。 */
  attribute: TripWire;
  reason: string;
  /** 实际生效的画像：本地表与 FLOOR 取更严的那个。 */
  profile: EffectProfile;
}

export interface PreflightInput {
  idempotencyKey?: string;
  approvalToken?: string;
  /** 只用来算画像，不参与身份判断。 */
  args?: Record<string, unknown>;
}

/**
 * 发请求之前先自己判一遍。
 *
 * 三条，按顺序：
 *   1. 写操作没带幂等键 → 拦。没有键就没法原子占位，重试会出第二张单。
 *   2. irreversible=true 且没带审批凭证 → 拦，理由点名 irreversible。
 *   3. changesPayee=true 且没带审批凭证 → 拦，理由点名 changesPayee。
 */
export function preflightCall(cap: Capability, input: PreflightInput = {}): PreflightVerdict {
  const profile = effectiveProfile(cap);
  const deny = (attribute: Exclude<TripWire, null>): PreflightVerdict =>
    ({ allow: false, attribute, reason: `${attribute} 要求尚未满足`, profile });
  if (profile.channel !== 'read' && !input.idempotencyKey) return deny('idempotencyKey');
  if (profile.irreversible && !input.approvalToken) return deny('irreversible');
  if (profile.changesPayee && !input.approvalToken) return deny('changesPayee');
  return { allow: true, attribute: null, reason: '本地检查通过，仍须服务端验证', profile };
}

export function describeProfile(cap: Capability, p: EffectProfile): string {
  return `${cap} channel=${p.channel} irreversible=${p.irreversible} `
    + `touchesMoney=${p.touchesMoney} changesPayee=${p.changesPayee}`;
}

/**
 * 只看本地表怎么说 —— **反面教材**。
 * tamper-probe 用它演示「如果分级表是唯一那道闸，改一行就能把提交降级成只读」。
 * 正经路径一律走 preflightCall()。
 */
export function localMapOnlyVerdict(cap: Capability): { needsApproval: boolean; profile: EffectProfile } {
  const p = LOCAL_RISK_MAP[cap];
  return { needsApproval: p.irreversible || p.changesPayee, profile: p };
}

// ── 二、环境体检 ────────────────────────────────────────────────

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

/** 这十个场景是全套的。少一个说明 mock/scenarios 被动过。 */
export const EXPECTED_SCENARIOS: readonly string[] = [
  'baseline', 'tool-probe', 'two-sites', 'floor-probe', 'concurrent',
  'uncertain-a', 'uncertain-b', 'uncertain-c', 'poisoned-supplier', 'capstone',
];

/**
 * live 模式下 persona 必须读得到的三个 DocType。
 *
 * lecture-9 的 seed 建服务账号时只给了 Accounts User，于是这三个里
 * Purchase Order 和 Bin 都是 403 —— Purchase Invoice 反而读得到，
 * 而它恰恰不在 persona 白名单里。所以「能连上」不等于「配好了」，得逐个读一次。
 */
export const LIVE_REQUIRED_DOCTYPES: readonly DocType[] = ['Purchase Order', 'Bin', 'Supplier'];

/** 读不到时给的那句话。别让人回去翻自己的代码 —— 那儿没问题。 */
const LIVE_ROLE_HINT =
  '这是站点角色没配好，不是你的代码问题，报给助教。\n'
  + '      服务账号需要 Accounts User + Purchase User + Stock User 三个角色，\n'
  + '      助教在这个 site 上跑一次 node scripts/provision-live.mjs 就能补齐。';

const MIN_NODE = [20, 11] as const;

function check(id: string, label: string, fn: () => string): PreflightCheck {
  try {
    return { id, label, ok: true, detail: fn() };
  } catch (e) {
    return { id, label, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkAsync(id: string, label: string, fn: () => Promise<string>): Promise<PreflightCheck> {
  try {
    return { id, label, ok: true, detail: await fn() };
  } catch (e) {
    return { id, label, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export async function runPreflight(): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  checks.push(check('node-version', 'Node 版本 >= 20.11', () => {
    const v = process.versions.node;
    const parts = v.split('.').map(Number);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    assert(major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]),
      `当前 ${v}，需要 >= ${MIN_NODE[0]}.${MIN_NODE[1]}`);
    return `node ${v}`;
  }));

  checks.push(check('seed-digest', '种子 fixtures/erp-seed.json 的 sha256 没变', () => {
    const seedPath = join(ROOT, 'fixtures', 'erp-seed.json');
    const want = (readFileSync(join(ROOT, 'fixtures', 'erp-seed.sha256'), 'utf8').trim().split(/\s+/)[0] ?? '')
      .toLowerCase();
    const got = createHash('sha256').update(readFileSync(seedPath)).digest('hex');
    assert(want !== '', 'fixtures/erp-seed.sha256 是空的');
    assert(got === want, `摘要对不上：期望 ${want}，实际 ${got}。种子被改过，后面所有基线都不作数`);
    return got.slice(0, 16) + '…';
  }));

  checks.push(check('scenarios-load', `mock/scenarios 下 ${EXPECTED_SCENARIOS.length} 个场景都装得起来`, () => {
    const files = readdirSync(join(ROOT, 'mock', 'scenarios'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    const missing = EXPECTED_SCENARIOS.filter((s) => !files.includes(s));
    assert(missing.length === 0, `缺场景：${missing.join(', ')}`);
    for (const id of EXPECTED_SCENARIOS) {
      const s = loadScenario(id);
      assert(s.scenario.id === id, `${id}.json 里的 id 写成了 ${s.scenario.id}`);
      assert(s.scenario.sites.length > 0, `${id} 没声明任何 site`);
    }
    const extra = files.filter((f) => !EXPECTED_SCENARIOS.includes(f));
    return `${files.length} 个：${files.join(' ')}` + (extra.length ? `（多出 ${extra.join(' ')}）` : '');
  }));

  checks.push(check('baseline-po-count', `baseline 场景的采购单是 ${FACTS.baselinePurchaseOrders} 张`, () => {
    const rig = makeRig({ scenario: 'baseline' });
    try {
      assert(rig.mock, 'baseline 装出来没有 mock 控制面');
      const n = rig.mock.count(rig.site, 'Purchase Order');
      assert(n === FACTS.baselinePurchaseOrders,
        `基线应为 ${FACTS.baselinePurchaseOrders} 张，实际 ${n} 张 —— 上一次跑完没清干净`);
      return `${n} 张 @ ${rig.site}`;
    } finally { rig.cleanup(); }
  }));

  checks.push(await checkAsync('gateway-read', '走一次 erp.query 真能读回库存', async () => {
    const rig = makeRig({ scenario: 'baseline' });
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const rows = await client.query('Bin', { item_code: FACTS.itemCode, warehouse: FACTS.warehouse });
      const bin = rows[0];
      assert(bin, `查不到 ${FACTS.itemCode} 在 ${FACTS.warehouse} 的 Bin 行`);
      const qty = numberField(bin, 'actual_qty');
      assert(qty === FACTS.onHandQty, `现有量应为 ${FACTS.onHandQty}，读到 ${qty}`);
      const entries = await rig.audit.byRun(rig.runId);
      assert(entries.length >= 1, '读完审计里一条都没有 —— 这次读没走网关');
      return `actual_qty=${qty}，审计留了 ${entries.length} 条`;
    } finally { rig.cleanup(); }
  }));

  checks.push(check('floor-frozen', 'FLOOR 是冻结对象，运行时改不动', () => {
    assert(Object.isFrozen(FLOOR), 'FLOOR 本身没冻');
    const caps = Object.keys(FLOOR) as Capability[];
    for (const c of caps) assert(Object.isFrozen(FLOOR[c]), `FLOOR['${c}'] 没冻`);
    // 真去改一下。模块是严格模式，改冻结对象会抛 —— 抛出来才算冻住了。
    let threw = false;
    try {
      (FLOOR as unknown as Record<string, EffectProfile>)['erp.submit'] = {
        channel: 'read', irreversible: false, touchesMoney: false, changesPayee: false,
      };
    } catch { threw = true; }
    assert(threw, '给 FLOOR 赋值没有抛错 —— 它没被真正冻住');
    assert(FLOOR['erp.submit'].irreversible === true, 'FLOOR 的 erp.submit 已经不是不可逆了');
    return `${caps.length} 个 capability 全部冻结；改它会抛 TypeError`;
  }));

  // ── live 专属：站点角色配没配对 ─────────────────────────────────
  //
  // 只在 ERP_MODE=live 时跑。mock 模式一个字节都不发出去 —— 上面那几项是纯离线的，
  // Task 00 就靠它们，不能因为没配真站点而变红。
  //
  // 走的是 makeLiveRig → HttpErp，跟后面每个 task 用的是同一条客户端路径。
  // 换句话说这里绿了，Task 01 的读就一定不会卡在权限上。
  if (process.env.ERP_MODE === 'live') {
    checks.push(await checkAsync('live-doctype-read',
      `live：服务账号读得到 ${LIVE_REQUIRED_DOCTYPES.join(' / ')}`, async () => {
        const work = mkdtempSync(join(tmpdir(), 'w12-preflight-'));
        try {
          const rig = makeLiveRig({ runId: 'preflight-' + Date.now(), workDir: work });
          const good: string[] = [];
          const bad: string[] = [];
          for (const dt of LIVE_REQUIRED_DOCTYPES) {
            try {
              const rows = await rig.erp.list(rig.site, rig.principal.persona.name, dt, {});
              good.push(`${dt}=${rows.length} 行`);
            } catch (e) {
              // HttpErp 把 HTTP 状态放在 message 开头，截一段就够定位是 403 还是别的。
              const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 100);
              bad.push(`${dt} → ${why}`);
            }
          }
          assert(bad.length === 0,
            `读不到：\n      ${bad.join('\n      ')}\n      ${LIVE_ROLE_HINT}`);
          return `${rig.site} · ${good.join(' · ')}`;
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ── 三、命令行入口 ──────────────────────────────────────────────

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

export function formatReport(r: PreflightReport): string {
  const lines = r.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} ${c.label}\n      ${c.detail}`);
  lines.push('');
  lines.push(r.ok ? '起飞前检查全过。' : '起飞前检查没过，先把上面 FAIL 的修好再往下走。');
  return lines.join('\n');
}

if (isDirectRun()) {
  const report = await runPreflight();
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
}
