// Task 03 公开测试：源码扫描。
//
// 安全那边问的是「Agent 用的是哪个 ERP 账号」。行为测试答不了这个问题 ——
// 一次跑通不代表某条分支上没埋着 Administrator。这里静态扫一遍 src/。
//
// 扫四类东西：
//   1. 管理员账号：Administrator / System Manager。只允许出现在「拒绝它」的那行守卫里。
//   2. 数据库直连：DSN、jdbc、mysql2 / mariadb / pg 这类驱动。
//   3. 硬编码凭据：password / api_key / api_secret 被赋了一个字符串字面量。
//   4. 从请求体读身份：req.siteId / body.persona / args.user 这类取值。
//
// 每条规则都配一个阳性对照 —— 拿造出来的坏样本喂给同一个扫描器，
// 报不出来就说明规则写空了，「全绿」不算证据。
//
//   npx vitest run tests/task-03.source-scan.test.ts

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

interface Finding { rule: string; file: string; line: number; text: string }

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

function readAll(): { file: string; text: string }[] {
  return listTs(SRC).map((p) => ({
    file: relative(ROOT, p).split(sep).join('/'),
    text: readFileSync(p, 'utf8'),
  }));
}

// ── 规则 ────────────────────────────────────────────────────────

/**
 * 出现 Administrator 只有一种合法姿势：那一行在**拒绝**它。
 * `if (user === 'Administrator') throw ...` 是对的，`user: 'Administrator'` 不是。
 */
const ADMIN_GUARD = /(===|!==)\s*['"]Administrator['"]|不许用\s*Administrator|af-admin-credentials/;

/** 数据库直连。绕过 Gateway 就没有 site 分区，也没有审计。 */
const DSN = [
  /\b(mysql|mariadb|postgres|postgresql|mongodb):\/\//i,
  /\bjdbc:/i,
  /\bfrom\s+['"](mysql2?|mariadb|pg|knex|sequelize|typeorm)['"]/,
  /\brequire\(\s*['"](mysql2?|mariadb|pg)['"]\s*\)/,
];

/** 凭据被赋了字面量。live 的值只能从 process.env 读。 */
const HARDCODED_CRED =
  /\b(password|passwd|pwd|api_secret|api_key|apiSecret|apiKey|db_password|secret)\s*[:=]\s*['"][^'"]{3,}['"]/;

/** 从请求体取身份。这是 task-03 判的那件事 —— 身份只能来自令牌记录。 */
const IDENTITY_FROM_REQUEST =
  /\b(req|body|args|input|payload)\s*(\.|\[\s*['"])\s*(learnerId|learner_id|siteId|site_id|site|erpUser|erp_user|persona|role|roles|email|user)\b/;

/** 把伪造字段删掉再往下跑。忽略是安全的，但调用方会以为自己指定的 site 生效了。 */
const STRIP_SPOOF = /\bdelete\s+(req|body|args|input|payload)\s*[.[]/;

/** 一个文件一遍过完四类规则。测试和阳性对照喂的是同一个函数。 */
export function scanSource(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const push = (rule: string, i: number, raw: string) =>
    out.push({ rule, file, line: i + 1, text: raw.trim().slice(0, 160) });

  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.includes('Administrator') && !ADMIN_GUARD.test(raw)) push('admin-account', i, raw);
    if (raw.includes('System Manager')) push('admin-role', i, raw);
    if (DSN.some((re) => re.test(raw))) push('db-direct', i, raw);
    if (HARDCODED_CRED.test(raw)) push('hardcoded-credential', i, raw);
    if (IDENTITY_FROM_REQUEST.test(raw)) push('identity-from-request', i, raw);
    if (STRIP_SPOOF.test(raw)) push('strip-spoofed-field', i, raw);
  });
  return out;
}

function fmt(f: Finding[]): string {
  return f.map((x) => `[${x.rule}] ${x.file}:${x.line}  ${x.text}`).join('\n');
}

// ── 用例 ────────────────────────────────────────────────────────

describe('task-03 · 源码扫描', () => {
  const files = readAll();

  it('src/ 下扫得到文件，扫描本身没跑空', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.file === 'src/identity.ts')).toBe(true);
    expect(files.some((f) => f.file === 'src/gateway.ts')).toBe(true);
  });

  it('没有 Administrator / System Manager 这类管理员账号', () => {
    const hits = files.flatMap((f) => scanSource(f.file, f.text))
      .filter((h) => h.rule === 'admin-account' || h.rule === 'admin-role');
    expect(fmt(hits)).toBe('');
  });

  it('没有数据库 DSN，也没有直连驱动 —— 绕过 Gateway 就没有 site 分区', () => {
    const hits = files.flatMap((f) => scanSource(f.file, f.text)).filter((h) => h.rule === 'db-direct');
    expect(fmt(hits)).toBe('');
  });

  it('没有硬编码的口令 / api_key / api_secret，live 的值只从 process.env 读', () => {
    const hits = files.flatMap((f) => scanSource(f.file, f.text)).filter((h) => h.rule === 'hardcoded-credential');
    expect(fmt(hits)).toBe('');

    // 反过来确认：live 那几个值确实是从环境变量取的。
    const harness = files.find((f) => f.file === 'src/harness.ts');
    expect(harness).toBeTruthy();
    expect((harness as { text: string }).text).toContain('process.env.ERP_PASSWORD');
    expect((harness as { text: string }).text).toContain('process.env.ERP_USER');
  });

  it('没有从 req / body / args 里读身份字段，也没有把伪造字段 delete 掉再往下跑', () => {
    const hits = files.flatMap((f) => scanSource(f.file, f.text))
      .filter((h) => h.rule === 'identity-from-request' || h.rule === 'strip-spoofed-field');
    expect(fmt(hits)).toBe('');
  });

  it('Principal 只有一个出口：gateway 调 identity.resolve，identity 里对伪造字段 throw', () => {
    const gw = files.find((f) => f.file === 'src/gateway.ts');
    const id = files.find((f) => f.file === 'src/identity.ts');
    expect(gw).toBeTruthy();
    expect(id).toBeTruthy();
    expect((gw as { text: string }).text).toMatch(/identity\.resolve\(/);
    // 是 throw，不是删字段继续走。
    expect((id as { text: string }).text).toMatch(/throw new DeniedError/);
    expect((id as { text: string }).text).toContain('SPOOFABLE_FIELDS');
    expect((id as { text: string }).text).toContain('SPOOFED_IDENTITY');
  });

  it('gateway 下发给 ErpClient 的头两个参数恒为 p.siteId 与 p.persona.name，没有默认 site 兜底', () => {
    const gw = files.find((f) => f.file === 'src/gateway.ts');
    const text = (gw as { text: string }).text;

    const calls = [...text.matchAll(/this\.d\.erp\.(list|get|insert|submit|cancel|remove)\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const bad = calls
      .map((m) => ({ method: m[1] ?? '', argv: (m[2] ?? '').replace(/\s+/g, ' ').trim() }))
      .filter((c) => !c.argv.startsWith('p.siteId, p.persona.name'));
    expect(bad.map((c) => c.method + '(' + c.argv + ')').join('\n')).toBe('');

    // 四个 ErpClient 方法一个都没落下。
    const methods = new Set(calls.map((m) => m[1]));
    for (const m of ['list', 'get', 'insert', 'submit']) expect(methods.has(m)).toBe(true);

    // 没有 `siteId ?? 'xxx'` / `persona || 'xxx'` 这种 fallback。
    expect(text).not.toMatch(/siteId\s*(\?\?|\|\|)/);
    expect(text).not.toMatch(/persona(\.name)?\s*(\?\?|\|\|)/);

    // 审计里的身份也从 Principal 来，不从请求体补。
    for (const line of text.split(/\r?\n/)) {
      if (/\blearnerId:/.test(line)) expect(line).toMatch(/learnerId:\s*p\./);
      if (/\bsiteId:/.test(line)) expect(line).toMatch(/siteId:\s*p\./);
    }
  });

  it('positive-control：同一个扫描器对造出来的坏样本必须逐条报错', () => {
    const bad = [
      "const creds = { user: 'Administrator', host: site };",
      "roles: ['System Manager'],",
      "const dsn = 'mysql://erp:hunter2@127.0.0.1:3306/erpnext';",
      "import mysql from 'mysql2';",
      "const api_secret = 'abcd1234efgh';",
      "const site = req.siteId ?? 'erp.localhost';",
      'delete body.learnerId;',
    ].join('\n');

    const hits = scanSource('fake/bad-sample.ts', bad);
    const rules = new Set(hits.map((h) => h.rule));
    expect([...rules].sort()).toEqual([
      'admin-account', 'admin-role', 'db-direct',
      'hardcoded-credential', 'identity-from-request', 'strip-spoofed-field',
    ]);
    expect(hits.length).toBeGreaterThanOrEqual(7);

    // 反面：真实那行守卫（拒绝 Administrator）不该被报出来，否则规则就是「见字就叫」。
    const guard = scanSource('fake/guard.ts', "  if (user === 'Administrator')\n    throw new Error('不许用 Administrator');");
    expect(guard).toHaveLength(0);
  });
});
