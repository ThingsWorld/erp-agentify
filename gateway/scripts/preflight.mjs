// npm run preflight —— Task 00 的第一道关。
//
// 默认纯离线：不连 ERPNext，不连网，不 import src/ 下任何还没写完的模块。
// 这里只回答一句话：这台机器现在能不能开始干活。
//
// 只有显式 `ERP_MODE=live npm run preflight` 时，最后才多跑一节站点权限自检
// （见第 7 节）。ERP_MODE 只认进程环境变量，**不认 .env** ——
// Task 00 要求 `npm run preflight` 退出码为 0，这条命令必须无条件是离线的，
// 不能因为某人 .env 里留了一行 live 就去连一台他现在连不上的机器。
//
// 逐项打 [OK] / [X]，任何一项红了就 exit 1，后面的检查照跑完 ——
// 一次把问题全看见，比修一个跑一次快。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 十个 mock 场景。少一个都算环境不完整 —— 后面的 task 会点名要。 */
const SCENARIOS = [
  'baseline', 'tool-probe', 'two-sites', 'floor-probe', 'concurrent',
  'uncertain-a', 'uncertain-b', 'uncertain-c', 'poisoned-supplier', 'capstone',
];

/** package.json 的 engines 要求。写死在这里，跟 engines 字段互为校验。 */
const MIN_NODE = [20, 11, 0];

const results = [];

function check(label, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, label, detail: detail ?? '' });
  } catch (e) {
    results.push({ ok: false, label, detail: e instanceof Error ? e.message : String(e) });
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, label, detail: detail ?? '' });
  } catch (e) {
    results.push({ ok: false, label, detail: e instanceof Error ? e.message : String(e) });
  }
}

/** 跳过不算失败，但要让人看见为什么跳。 */
function skip(label, why) {
  results.push({ ok: true, skipped: true, label, detail: why });
}

function fail(msg) { throw new Error(msg); }

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${path} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 1. Node 版本 ──────────────────────────────────────────────────
check('Node >= 20.11', () => {
  const parts = process.versions.node.split('.').map(Number);
  if (cmpVersion(parts, MIN_NODE) < 0)
    fail(`当前 ${process.versions.node}，最低要 ${MIN_NODE.join('.')}。换个 Node 再来。`);
  return `v${process.versions.node}`;
});

// ── 2. 依赖装没装 ─────────────────────────────────────────────────
check('node_modules 与四个 devDependency 都在', () => {
  const nm = join(ROOT, 'node_modules');
  if (!existsSync(nm)) fail('node_modules 不在。先 npm install。');
  const pkg = readJson(join(ROOT, 'package.json'));
  const want = Object.keys(pkg.devDependencies ?? {});
  const missing = want.filter((d) => !existsSync(join(nm, ...d.split('/'))));
  if (missing.length > 0) fail(`缺依赖：${missing.join(', ')}。跑一次 npm install。`);
  return want.join(' ');
});

// ── 3. 种子摘要 ───────────────────────────────────────────────────
const SEED_PATH = join(ROOT, 'fixtures', 'erp-seed.json');
const SHA_PATH = join(ROOT, 'fixtures', 'erp-seed.sha256');

check('fixtures/erp-seed.json 摘要与 erp-seed.sha256 一致', () => {
  if (!existsSync(SEED_PATH)) fail('fixtures/erp-seed.json 不在。');
  if (!existsSync(SHA_PATH)) fail('fixtures/erp-seed.sha256 不在。');
  const actual = sha256File(SEED_PATH);
  // sha256 文件里可能是 "<hex>" 也可能是 "<hex>  <file>"，只取第一段。
  const expected = readFileSync(SHA_PATH, 'utf8').trim().split(/\s+/)[0];
  if (actual !== expected)
    fail(`摘要对不上。\n         期望 ${expected}\n         实得 ${actual}\n`
       + '         种子是所有 task 的共同底账，改了它后面每一课的基线都跟着漂。'
       + 'git checkout 还原。');
  return actual.slice(0, 16) + '…';
});

// ── 4. 十个场景文件 ───────────────────────────────────────────────
const scenarioDir = join(ROOT, 'mock', 'scenarios');

check(`mock/scenarios 下 ${SCENARIOS.length} 个场景都在且能 JSON.parse`, () => {
  if (!existsSync(scenarioDir)) fail('mock/scenarios 目录不在。');
  const missing = SCENARIOS.filter((id) => !existsSync(join(scenarioDir, id + '.json')));
  if (missing.length > 0) fail(`缺场景：${missing.map((m) => m + '.json').join(', ')}`);

  const bad = [];
  for (const id of SCENARIOS) {
    const path = join(scenarioDir, id + '.json');
    let s;
    try { s = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { bad.push(`${id}.json 解析失败：${e instanceof Error ? e.message : String(e)}`); continue; }
    if (s.id !== id) bad.push(`${id}.json 里的 id 是 "${s.id}"，跟文件名对不上`);
    if (!Array.isArray(s.sites) || s.sites.length === 0) bad.push(`${id}.json 没声明 sites`);
    if (!s.tokens || Object.keys(s.tokens).length === 0) bad.push(`${id}.json 没声明 tokens`);
    if (!s.seed || !existsSync(join(ROOT, s.seed))) bad.push(`${id}.json 的 seed 指向 ${s.seed}，文件不在`);
  }
  if (bad.length > 0) fail(bad.join('\n         '));

  const extra = readdirSync(scenarioDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => !SCENARIOS.includes(id));
  return extra.length > 0 ? `另有未登记的场景 ${extra.join(', ')}` : SCENARIOS.join(' ');
});

// ── 5. baseline 起得来，采购单 6 张 ──────────────────────────────
//
// 这里离线复刻 src/erp-mock.ts:loadScenario 的装配顺序：灌种子 → 打 patch。
// patch 只改已有行的字段，不增删行，所以张数看种子就够。
check('场景 baseline 装配得起来，且 Purchase Order 6 张', () => {
  const scenario = readJson(join(scenarioDir, 'baseline.json'));
  const seed = readJson(join(ROOT, scenario.seed));
  const site = scenario.sites[0];

  const rows = new Map();
  for (const row of seed.doctypes?.['Purchase Order'] ?? []) rows.set(row.name, { ...row });

  for (const p of scenario.patches ?? []) {
    if (p.site !== site || p.doctype !== 'Purchase Order') continue;
    for (const [name, row] of rows) {
      const hit = p.name ? name === p.name
        : Object.entries(p.match ?? {}).every(([k, v]) => row[k] === v);
      if (hit) rows.set(name, { ...row, ...p.set });
    }
  }

  if (rows.size !== 6) fail(`site ${site} 上有 ${rows.size} 张采购单，基线应该是 6 张`);

  const original = rows.get('PUR-ORD-2026-00001');
  if (!original) fail('原单 PUR-ORD-2026-00001 不在种子里');
  if (Number(original.docstatus) !== 1)
    fail(`PUR-ORD-2026-00001 的 docstatus 是 ${original.docstatus}，应该是 1（已提交）`);

  const bins = seed.doctypes?.Bin ?? [];
  const shelf = bins.find((b) => b.item_code === 'ITEM-SHELF-01' && b.warehouse === 'Stores - ADC');
  if (!shelf) fail('种子里没有 ITEM-SHELF-01 @ Stores - ADC 的 Bin');
  if (Number(shelf.actual_qty) !== 40)
    fail(`ITEM-SHELF-01 @ Stores - ADC 的 actual_qty 是 ${shelf.actual_qty}，应该是 40`);

  return `site ${site} · PO 6 张 · PUR-ORD-2026-00001 docstatus=1 · 现有 40`;
});

// ── 6. 网关冒烟（可选）───────────────────────────────────────────
//
// src/preflight.ts 由别的 agent 写。它还没落地的时候这里跳过而不是崩 ——
// 环境检查本身不该依赖一个还没写的模块。
const SMOKE_TS = join(ROOT, 'src', 'preflight.ts');
if (!existsSync(SMOKE_TS)) {
  skip('网关冒烟', 'src/preflight.ts 还没写，本轮跳过（上面 5 项纯离线检查已经能判断环境好坏）');
} else {
  check('网关冒烟（src/preflight.ts）', () => {
    const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!existsSync(tsx)) fail('tsx 不在，跑不了 src/preflight.ts。先 npm install。');
    // 子进程里把 ERP_MODE 摘掉：src/preflight.ts 自己也有一节 live 权限自检，
    // 继承下去就会跟第 7 节撞车，同一件事红两遍，看的人以为是两个问题。
    // 这条命令里 live 那一节归第 7 节管；src/preflight.ts 的那一节留给
    // `npx tsx src/preflight.ts` 直接跑的时候用。
    const { ERP_MODE, ...childEnv } = process.env;
    void ERP_MODE;
    const r = spawnSync(process.execPath, [tsx, SMOKE_TS], { cwd: ROOT, encoding: 'utf8', env: childEnv });
    if (r.status !== 0) {
      const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').slice(-8).join('\n         ');
      fail(`src/preflight.ts 退出码 ${r.status}\n         ${out}`);
    }
    return '通过';
  });
}

// ── 7. live 权限自检 ─────────────────────────────────────────────
//
// mock 模式整节不出现，一个字节都不往外发。
//
// live 模式下要回答的问题是：这个 site 上的服务账号，读不读得到
// Purchase Order / Bin / Supplier。lecture-9 的 seed 只给它 Accounts User，
// 结果是 Purchase Invoice 读得到（而 persona 白名单里恰好没有它），
// Purchase Order 和 Bin 全是 403 —— 跟这门课要的权限正好反着来。
//
// 这一节故意不 import src/ 下任何东西。src/ 可能还是骨架，
// 而「站点角色配没配对」跟学员写了多少代码没有关系，不该被前面的洞连累。

if (process.env.ERP_MODE !== 'live') {
  skip('live 站点权限自检', 'ERP_MODE 不是 live，本轮跳过（Task 00 全程在 mock 上跑，这是预期的）');
} else {
  // 凭据只从环境变量读。.env 存在就补进本进程，不写回任何地方，也不打印。
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^(ERP_(?:BASE|SITE|USER|PASSWORD))\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }

  const BASE = (process.env.ERP_BASE ?? 'http://localhost:8080').replace(/\/+$/, '');
  const SITE = process.env.ERP_SITE ?? 'erp.localhost';
  const USER = process.env.ERP_USER ?? '';
  const PASSWORD = process.env.ERP_PASSWORD ?? '';
  const DOCTYPES = ['Purchase Order', 'Bin', 'Supplier'];

  /** 后端原话里万一带上了密码，打印前抹掉。 */
  const redact = (s) => (PASSWORD.length >= 4 ? String(s).split(PASSWORD).join('***') : String(s));

  await checkAsync('live 站点权限自检（' + DOCTYPES.join(' / ') + '）', async () => {
    if (!USER || !PASSWORD)
      fail('ERP_MODE=live 但没有 ERP_USER / ERP_PASSWORD。\n'
         + '         把 .env.example 复制成 .env 填上助教发的受限账号，或者在环境里传。\n'
         + '         **不是** Administrator —— 用它会触发 af-admin-credentials。');

    // Frappe 按 Host 头路由站点；Windows 上 Node 解析不了 *.localhost，
    // 所以基址走 localhost，站点靠显式 Host 头指定。跟 src/erp-http.ts 一个路子。
    const head = { 'Content-Type': 'application/json', Host: SITE };
    let login;
    try {
      login = await fetch(BASE + '/api/method/login', {
        method: 'POST', headers: head,
        body: JSON.stringify({ usr: USER, pwd: PASSWORD }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      fail('连不上 ' + BASE + '：' + redact(e instanceof Error ? e.message : String(e))
         + '\n         ERPNext 没起来，或者 ERP_BASE 指错了。');
    }
    if (login.status !== 200)
      fail('服务账号登录失败：HTTP ' + login.status + ' — '
         + redact((await login.text()).replace(/\s+/g, ' ').slice(0, 200))
         + '\n         账号或密码不对。这一步过不去，下面的权限根本轮不上。');
    const cookie = (login.headers.getSetCookie?.() ?? []).join('; ');

    const good = [];
    const bad = [];
    for (const dt of DOCTYPES) {
      const r = await fetch(
        BASE + '/api/resource/' + encodeURIComponent(dt) + '?limit_page_length=1&fields=["name"]',
        { headers: { ...head, Cookie: cookie }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 200) good.push(dt + '=200');
      else bad.push(dt + ' → HTTP ' + r.status + ' '
        + redact((await r.text()).replace(/\s+/g, ' ').slice(0, 90)));
    }
    if (bad.length > 0)
      fail('服务账号读不到：\n         ' + bad.join('\n         ')
         + '\n\n         这是站点角色没配好，不是你的代码问题，报给助教。\n'
         + '         服务账号需要 Accounts User + Purchase User + Stock User 三个角色；\n'
         + '         助教在这个 site 上跑一次 node scripts/provision-live.mjs 就能补齐。');

    return SITE + ' · ' + good.join(' ');
  });
}

// ── 汇报 ─────────────────────────────────────────────────────────
console.log('preflight · ' + ROOT + '\n');
for (const r of results) {
  const tag = r.skipped ? '[--]' : r.ok ? '[OK]' : '[X ]';
  console.log(`${tag} ${r.label}`);
  if (r.detail) console.log(`     ${r.detail}`);
}

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.log(`preflight 未通过：${failed.length} / ${results.length} 项红了。`);
  process.exit(1);
}
console.log(`preflight 通过：${results.length} 项全绿。可以开工了。`);
