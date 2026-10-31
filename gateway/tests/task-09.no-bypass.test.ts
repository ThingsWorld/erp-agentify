// task-09 · 没有旁路。
//
// 前面那个文件判「做出来的东西对不对」，这个文件判「是不是从正门进去的」。
// 两件事分开写，是因为终局可以蒙对 —— 直连 HTTP 也能建出一张长得一样的草稿。
//
// 分静态和运行时两半：
//   静态：src/capstone/ 下的代码里不出现 Administrator、直连 HTTP、数据库驱动、
//         真实凭据、绕过 Gateway 直接调 ErpClient 写口、请求体身份字段、
//         自己拼的 approvalToken。扫描规则自带 tripwire，保证不是空扫。
//   运行时：所有宿主调用都带令牌解析出来的 site + persona，碰不到别人的 site；
//         请求体里塞身份字段是拒；未知工具名和白名单外的 DocType 连转发都不会发生。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient, numberField } from '../src/gateway-client.js';
import { computeShortfall } from '../src/agent/shortfall.js';
import { capstoneKey } from '../src/capstone/idempotency-key.mjs';
import {
  CallRequest, DocType, EXPECTED_SHORTFALL, FACTS, SPOOFABLE_FIELDS,
} from '../src/types.js';

const GATEWAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPSTONE_DIR = join(GATEWAY_ROOT, 'src', 'capstone');
const DOCTYPE: DocType = 'Purchase Order';
const SCHEDULE_DATE = '2026-09-25';
const OTHER_SITE = 'erp-b.localhost';

// ── 静态扫描 ────────────────────────────────────────────────────

interface Rule {
  id: string;
  why: string;
  re: RegExp;
  /** 一定会被这条规则抓住的样本。没有它，「扫不出问题」可能只是规则写错了。 */
  tripwire: string;
}

const RULES: Rule[] = [
  {
    id: 'no-administrator',
    why: 'Administrator 是绕过 persona 的万能钥匙，命中直接总分 0',
    re: /\bAdministrator\b/,
    tripwire: "const erpUserName = 'Administrator';",
  },
  {
    id: 'no-direct-http',
    why: '只能通过 Gateway 调宿主，不许自己拿 HTTP 打 Frappe API',
    re: /https?:\/\/|\bfetch\s*\(|node:https?\b|['"](axios|undici|got|node-fetch)['"]/,
    tripwire: "await fetch('http://erp.localhost/api/resource/Purchase%20Order');",
  },
  {
    id: 'no-db-driver',
    why: '不许直连数据库绕过网关和审计',
    re: /from\s+['"](pg|pg-promise|mysql2?|sqlite3?|better-sqlite3|mongodb|@supabase\/[a-z-]+)['"]|require\(\s*['"](pg|mysql2?|sqlite3?|mongodb)['"]\s*\)|\b(service_role|DATABASE_URL)\b/,
    tripwire: "import { Client } from 'pg';",
  },
  {
    id: 'no-credentials',
    why: 'live 的值只从环境读，而且读的地方在 harness 里，capstone 不碰凭据',
    re: /process\.env|ERP_PASSWORD|ERP_USER\b/,
    tripwire: "const password = process.env.ERP_PASSWORD;",
  },
  {
    id: 'no-raw-erp-write',
    why: '写宿主只能走 Gateway；直接调 ErpClient 就没有 FLOOR、没有台账、没有审计',
    re: /\.erp\.(insert|submit|cancel|remove)\s*\(/,
    tripwire: "await rig.erp.insert(site, persona, 'Purchase Order', doc);",
  },
  {
    id: 'no-erp-client-construction',
    why: '自己 new 一个 ErpClient 等于把网关整段跳过去',
    re: /new\s+(HttpErp|FakeErp)\s*\(/,
    tripwire: 'const erp = new HttpErp(base, creds);',
  },
  {
    id: 'no-live-rig',
    why: 'capstone 跑 mock。makeLiveRig 要凭据，出现在这里就是想连真环境',
    re: /makeLiveRig\s*\(/,
    tripwire: 'const rig = makeLiveRig({ runId, workDir });',
  },
  {
    id: 'no-identity-in-body',
    why: '身份只从平台令牌来。请求体里写 learnerId / siteId / persona 是自己给自己签字',
    re: /\b(learnerId|learner_id|siteId|site_id|erpUser|erp_user|persona)\s*:/,
    tripwire: "await gw.call(bearer, { capability, args, learnerId: 'learner-a' }, runId);",
  },
  {
    id: 'no-forged-approval',
    why: '审批凭证由审批服务签发。自己拼一个字符串是伪造，不是审批',
    re: /approvalToken\s*[:=]\s*['"`]/,
    tripwire: "const approvalToken = 'appr_我签字';",
  },
];

/** 幂等键里不许出现的熵源。有一个，重放就算不出同一串键。 */
const ENTROPY = /Date\.now|new\s+Date|Math\.random|randomUUID|randomBytes|process\.pid|performance\.now/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 只扫代码。reply.md 是给人看的散文，里面出现「白名单」「权限」这类词是正常的。 */
function capstoneCodeFiles(): string[] {
  return walk(CAPSTONE_DIR).filter((f) => /\.(ts|mts|mjs|cjs|js)$/.test(f));
}

/** 去掉字符串字面量里不该被扫的内容？—— 不去。规则宁可严一点，也不给「藏在字符串里」留口子。 */
function readCode(f: string): string {
  return readFileSync(f, 'utf8');
}

// ── 静态 ────────────────────────────────────────────────────────

describe('task-09 no-bypass · 静态扫描', () => {
  it('capstone 目录下确实有代码可扫，而且走的是 Gateway 那条路', () => {
    const files = capstoneCodeFiles();
    expect(files.length, 'src/capstone 下一个代码文件都没有，扫描等于空转')
      .toBeGreaterThanOrEqual(2);

    const all = files.map(readCode).join('\n');
    expect(all, '正门是 GatewayClient').toMatch(/GatewayClient/);
    expect(all, '装配走 harness 的 makeRig').toMatch(/makeRig/);
  });

  it('扫描规则本身有效：每条规则都能抓住自己的 tripwire', () => {
    for (const r of RULES) {
      expect(r.re.test(r.tripwire), r.id + ' 的规则抓不住自己的样本，规则写错了').toBe(true);
    }
    // 反过来：规则不能宽到把一段正常代码也抓进来。
    const benign = "import { makeRig } from '../harness.js';\nconst r = await client.createDraft(doc, key);\n";
    for (const r of RULES) {
      expect(r.re.test(benign), r.id + ' 把正常代码也当成了旁路').toBe(false);
    }
  });

  it('capstone 的代码里没有任何一条旁路', () => {
    const files = capstoneCodeFiles();
    const hits: string[] = [];
    for (const f of files) {
      const src = readCode(f);
      const rel = relative(GATEWAY_ROOT, f).replace(/\\/g, '/');
      for (const r of RULES) {
        const m = r.re.exec(src);
        if (!m) continue;
        const line = src.slice(0, m.index).split('\n').length;
        hits.push(rel + ':' + line + ' 命中 ' + r.id + '（' + r.why + '）：' + m[0]);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('幂等键模块里没有熵源：时间、随机数、进程号一个都不许有', () => {
    const src = readCode(join(CAPSTONE_DIR, 'idempotency-key.mjs'));
    const m = ENTROPY.exec(src);
    expect(m === null, '幂等键里出现了 ' + (m?.[0] ?? '') + '，重放就命不中同一个键').toBe(true);
    // positive control：这条规则确实抓得住熵源。
    expect(ENTROPY.test('const k = Date.now() + Math.random();')).toBe(true);
  });
});

// ── 运行时 ──────────────────────────────────────────────────────

/** 走一遍最小编排，只为拿到「这次到底往哪个 site、用哪个 persona 发了什么」。 */
async function minimalRun(rig: Rig): Promise<{ draftName: string | null; qty: number }> {
  const client = new GatewayClient(rig.tools, rig.runId);

  const bins = await client.query('Bin', { item_code: FACTS.itemCode });
  const bin = bins.find((b) => b.warehouse === FACTS.warehouse);
  const onHandQty = numberField(bin as Record<string, unknown>, 'actual_qty');
  const { shortfall } = computeShortfall({ requiredQty: FACTS.requiredQty, onHandQty });

  const orig = await client.get(DOCTYPE, FACTS.originalPo);
  const line = (orig.items as Record<string, unknown>[])[0]!;

  const doc: Record<string, unknown> = {
    supplier: FACTS.supplier,
    company: FACTS.company,
    currency: FACTS.currency,
    schedule_date: SCHEDULE_DATE,
    items: [{
      item_code: FACTS.itemCode,
      qty: shortfall,
      rate: numberField(line, 'rate'),
      warehouse: String(line.warehouse),
      schedule_date: SCHEDULE_DATE,
    }],
  };
  const key = capstoneKey({
    intent: 'po-correction', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
    qty: shortfall, batch: FACTS.originalPo,
  });

  // capstone 场景开局注入了丢响应，所以这里可能是 uncertain —— 不重发，按业务引用回查。
  const r = await client.createDraft(doc, key);
  if (r.erpRef) return { draftName: r.erpRef.name, qty: shortfall };

  const rows = await client.query(DOCTYPE, { supplier: FACTS.supplier, schedule_date: SCHEDULE_DATE });
  return { draftName: rows.length === 1 ? String(rows[0]!.name) : null, qty: shortfall };
}

describe('task-09 no-bypass · 运行时', () => {
  it('每一次宿主调用都带令牌解析出来的 site 与 persona，碰不到别人的 site', async () => {
    const rig = makeRig({ scenario: 'capstone', token: 'tok_learner', persistent: true });
    const created: string[] = [];
    try {
      const mock = rig.mock!;
      const otherBefore = mock.names(OTHER_SITE, DOCTYPE);
      const out = await minimalRun(rig);
      if (out.draftName) created.push(out.draftName);

      const calls = mock.calls();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.site === rig.principal.siteId),
        '出现了指向别的 site 的调用：'
          + [...new Set(calls.map((c) => c.site))].join('、')).toBe(true);
      expect(calls.every((c) => c.persona === rig.principal.persona.name),
        'persona 只能是令牌给的那个').toBe(true);
      expect(rig.principal.persona.name).not.toBe('Administrator');

      // 别人的 site 一张单都没多，一次调用都没落上去。
      expect(mock.names(OTHER_SITE, DOCTYPE)).toEqual(otherBefore);

      // 更硬的证据：两个 site 的 Bin 数字不一样，算出来的缺口用的是自己这边那个。
      const mine = mock.snapshot(rig.site, 'Bin')
        .find((b) => b.item_code === FACTS.itemCode && b.warehouse === FACTS.warehouse);
      const theirs = mock.snapshot(OTHER_SITE, 'Bin')
        .find((b) => b.item_code === FACTS.itemCode);
      expect(numberField(mine as Record<string, unknown>, 'actual_qty')).toBe(FACTS.onHandQty);
      expect(numberField(theirs as Record<string, unknown>, 'actual_qty'),
        '场景把 B 站的库存改成了别的数，正好用来验证读的是哪一边').not.toBe(FACTS.onHandQty);
      expect(out.qty, '缺口来自本人 site 的 Bin').toBe(EXPECTED_SHORTFALL);

      // 审计里的归属全程只有一个值，且等于令牌解析出来的那个。
      const entries = await rig.audit.byRun(rig.runId);
      expect(new Set(entries.map((e) => e.siteId))).toEqual(new Set([rig.principal.siteId]));
      expect(new Set(entries.map((e) => e.learnerId))).toEqual(new Set([rig.principal.learnerId]));
      expect(new Set(entries.map((e) => e.runId))).toEqual(new Set([rig.runId]));
    } finally {
      for (const n of created) rig.mock?.removeExact(rig.site, DOCTYPE, n);
      rig.cleanup();
    }
  });

  it('请求体里出现身份类字段一律拒，不是忽略后继续', async () => {
    const rig = makeRig({ scenario: 'capstone', token: 'tok_learner', persistent: true });
    try {
      const base = {
        capability: 'erp.query' as const,
        args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } },
      };

      for (const field of SPOOFABLE_FIELDS) {
        const before = (await rig.audit.byRun(rig.runId)).length;
        const spoofed = { ...base, [field]: 'x' } as unknown as CallRequest;
        const r = await rig.gw.call(rig.bearer, spoofed, rig.runId);
        expect(r.status, field + ' 应该被拒').toBe('denied');
        expect(r.code, field + ' 的拒绝码').toBe('SPOOFED_IDENTITY');
        expect((await rig.audit.byRun(rig.runId)).length,
          field + '：身份没解析出来就不该留业务审计行').toBe(before);
      }

      // positive control：把伪造字段去掉，同一个调用要能过。
      const ok = await rig.gw.call(rig.bearer, base as CallRequest, rig.runId);
      expect(ok.status, '拒的是伪造字段，不是这个调用').toBe('done');

      // 令牌本身也不能少。
      const noToken = await rig.gw.call(undefined, base as CallRequest, rig.runId);
      expect(noToken.status).toBe('denied');
      expect(noToken.code).toBe('MISSING_TOKEN');
    } finally {
      rig.cleanup();
    }
  });

  it('工具面就是全部通道：未知工具名和白名单外的 DocType 连转发都不会发生', async () => {
    const rig = makeRig({ scenario: 'capstone', token: 'tok_learner', persistent: true });
    try {
      const mock = rig.mock!;
      const auditBefore = (await rig.audit.byRun(rig.runId)).length;
      const callsBefore = mock.calls().length;

      // 万能工具不存在。
      const generic = await rig.tools.call(
        { tool: 'erp_call', args: { doctype: 'User', method: 'get_list', args: {} } }, rig.runId);
      expect(generic.status).toBe('denied');
      expect(generic.code).toBe('UNKNOWN_CAPABILITY');

      // 工具面白名单外的 DocType，在转发之前就被挡住。
      const badDoctype = await rig.tools.call(
        { tool: 'erp_query_documents', args: { docType: 'User', filters: {} } }, rig.runId);
      expect(badDoctype.status).toBe('denied');
      expect(badDoctype.code).toBe('UNKNOWN_DOCTYPE');

      expect((await rig.audit.byRun(rig.runId)).length,
        '没转发出去的请求不该留业务审计行').toBe(auditBefore);
      expect(mock.calls().length, '一次宿主调用都不该发生').toBe(callsBefore);

      // persona 白名单外的 DocType 会被转发到网关，然后拒 —— 这一条要留痕。
      const invoice = await rig.tools.call(
        { tool: 'erp_query_documents', args: { docType: 'Purchase Invoice', filters: {} } },
        rig.runId);
      expect(invoice.status).toBe('denied');
      expect(invoice.code).toBe('DOCTYPE_NOT_PERMITTED');
      const entries = await rig.audit.byRun(rig.runId);
      expect(entries.length, 'FLOOR 拒掉的调用要留审计').toBe(auditBefore + 1);
      expect(entries[entries.length - 1]!.outcome).toBe('denied');
      expect(mock.calls().length, '拒了就不该真的去读宿主').toBe(callsBefore);

      // positive control：白名单内的 DocType 读得出来。
      const ok = await rig.tools.call(
        { tool: 'erp_query_documents', args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } } },
        rig.runId);
      expect(ok.status).toBe('done');
      expect(Array.isArray(ok.data)).toBe(true);
    } finally {
      rig.cleanup();
    }
  });
});
