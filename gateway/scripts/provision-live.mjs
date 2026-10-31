// 开完一个干净 Site 之后跑这一步。**助教用，不是学员用。**
//
//   node scripts/provision-live.mjs            真跑
//   node scripts/provision-live.mjs --dry-run  只查不写，打印差异
//
// 干的事只有一件：把服务账号的角色补齐到 Accounts User + Purchase User + Stock User，
// 然后**用它自己的会话**去证明 Purchase Order / Bin / Supplier 三个 DocType 真读得到。
//
// 为什么需要这一步：lecture-9 的 seed 建服务账号时只给了 Accounts User。
// 结果是这个账号读得到 Purchase Invoice（W12 的 persona 白名单里恰好没有它），
// 却读不到 Purchase Order 和 Bin（403）—— 跟 W12 要的权限正好反着来。
// 上游补丁合并之前，靠这个脚本兜住。
//
// 三条规矩：
//   1. 只加角色，不动任何单据。种子里那 6 张采购单跑完还是 6 张。
//   2. 写完从 ERP 重查一遍，用重查结果判成功。写入的回执不算数 ——
//      Frappe 的 PUT 返回 200 只说明请求收下了。
//   3. 凭据全部来自环境变量，脚本里一个字面量都没有，也不往 stdout 上打。
//      后端回来的原话在打印前过一遍脱敏，防止哪天 Frappe 把入参回显出来。
//
// 环境变量（前两个有默认值，后四个必填）：
//   ERP_BASE            默认 http://localhost:8080
//   ERP_SITE            默认 erp.localhost，同时作为 Host 头
//   ERP_ADMIN_USER      改角色需要管理员，这一项只在本脚本里用
//   ERP_ADMIN_PASSWORD
//   ERP_USER            服务账号。就是 .env 里学员会填的那个
//   ERP_PASSWORD

const DRY_RUN = process.argv.includes('--dry-run');

/** persona 要读的三个 DocType 对应的角色。少一个就有 403。 */
const TARGET_ROLES = ['Accounts User', 'Purchase User', 'Stock User'];

/** 补完角色之后真正要验的东西。只加角色不验权限等于没做。 */
const PROBE_DOCTYPES = ['Purchase Order', 'Bin', 'Supplier'];

const BASE = (process.env.ERP_BASE ?? 'http://localhost:8080').replace(/\/+$/, '');
const SITE = process.env.ERP_SITE ?? 'erp.localhost';
const ADMIN_USER = process.env.ERP_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.ERP_ADMIN_PASSWORD ?? '';
const SVC_USER = process.env.ERP_USER ?? '';
const SVC_PASSWORD = process.env.ERP_PASSWORD ?? '';

const TIMEOUT_MS = 20_000;

// ── 打印用的小工具 ────────────────────────────────────────────────

/**
 * 后端原话在打印前过这一遍。
 *
 * Frappe 平时不回显密码，但出错路径上什么都可能被塞进 traceback，
 * 到时候这段文字就进了助教的终端记录。宁可多这一层。
 */
const SECRETS = [ADMIN_PASSWORD, SVC_PASSWORD].filter((s) => s.length >= 4);
function redact(s) {
  let out = String(s ?? '');
  for (const secret of SECRETS) out = out.split(secret).join('***');
  return out;
}

/** 账号只露出 @ 前面那一段，够认人就行，不把完整地址落进终端记录。 */
function maskUser(u) {
  if (!u) return '(空)';
  const at = u.indexOf('@');
  return at > 0 ? u.slice(0, at) + '@…' : u;
}

/** 中文一个字占两列。按列数补空格，不然对不齐。 */
function pad(s, cols) {
  let w = 0;
  for (const ch of s) w += /[⺀-￯]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, cols - w));
}

let stepNo = 0;
function ok(label, detail) {
  stepNo += 1;
  console.log('[OK] ' + String(stepNo).padStart(2, '0') + ' ' + pad(label, 22) + ' ' + (detail ?? ''));
}

/** fail-fast：说清是哪一步、HTTP 多少、后端原话是什么，然后退出非零。 */
function die(label, detail, hint) {
  stepNo += 1;
  console.error('[X ] ' + String(stepNo).padStart(2, '0') + ' ' + label);
  console.error('     ' + redact(detail).split('\n').join('\n     '));
  if (hint) {
    console.error('');
    console.error('     ' + hint.split('\n').join('\n     '));
  }
  console.error('');
  console.error('provision 中断在第 ' + stepNo + ' 步。上面这段原样发给助教就够定位。');
  process.exit(1);
}

// ── HTTP ─────────────────────────────────────────────────────────
//
// 纯 node，不调 shell、不调 bench —— 助教的机器可能是 Windows，
// 也可能只有一个能连到容器的端口，没有 docker exec 的权限。

async function http(method, path, { cookie, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Host: SITE };
  if (cookie) headers.Cookie = cookie;
  let r;
  try {
    r = await fetch(BASE + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 连不上跟权限不对是两回事，别混在一起报。
    return { status: 0, text: '', networkError: e instanceof Error ? e.message : String(e) };
  }
  return {
    status: r.status,
    text: await r.text(),
    setCookie: (r.headers.getSetCookie?.() ?? []).join('; '),
  };
}

/** 从 Frappe 的错误响应里抠出人能读的那句，抠不出来就把原文截一段。 */
function backendSays(res) {
  if (res.networkError) return '连不上 ' + BASE + '：' + res.networkError;
  const raw = (res.text ?? '').trim();
  let msg = '';
  try {
    const j = JSON.parse(raw);
    const serverMessages = j._server_messages
      ? JSON.parse(j._server_messages).map((m) => { try { return JSON.parse(m).message; } catch { return m; } }).join(' / ')
      : '';
    msg = j.exception || serverMessages || j.message || '';
  } catch { /* 不是 JSON，下面直接用原文 */ }
  const tail = raw.replace(/\s+/g, ' ').slice(0, 400);
  return 'HTTP ' + res.status + (msg ? ' — ' + msg : '') + (tail ? '\n原文：' + tail : '');
}

async function login(user, password, who) {
  const res = await http('POST', '/api/method/login', { body: { usr: user, pwd: password } });
  if (res.status !== 200 || !res.setCookie) {
    die('登录 ' + who, backendSays(res),
      res.status === 0
        ? 'ERPNext 没起来，或者 ERP_BASE 指错了。先确认那 9 个容器在跑，\n'
          + '再用浏览器打开 ' + BASE + ' 看看有没有登录页。'
        : '账号或密码不对。检查 ' + (who === 'admin' ? 'ERP_ADMIN_USER / ERP_ADMIN_PASSWORD' : 'ERP_USER / ERP_PASSWORD')
          + ' 这两个环境变量，别改脚本。');
  }
  return res.setCookie;
}

// ── 1. 环境变量自检 ──────────────────────────────────────────────

{
  const missing = [];
  if (!ADMIN_USER) missing.push('ERP_ADMIN_USER');
  if (!ADMIN_PASSWORD) missing.push('ERP_ADMIN_PASSWORD');
  if (!SVC_USER) missing.push('ERP_USER');
  if (!SVC_PASSWORD) missing.push('ERP_PASSWORD');
  if (missing.length) {
    die('环境变量自检', '缺 ' + missing.join(' / '),
      '这四项只能从环境里传，脚本不读 .env 也不接受命令行参数。\n'
      + '别把值写进任何文件 —— 写进去就跟着仓库跑了。\n'
      + 'PowerShell：$env:ERP_ADMIN_USER = "…"\n'
      + 'bash：      export ERP_ADMIN_USER=…');
  }
  // 这一条挡在最前面，省得助教把一套凭据发出去之后才发现学员不能用它：
  // 服务账号必须是受限账号，拿超级用户跑 Task 会直接触发 af-admin-credentials。
  if (SVC_USER === 'Administrator' || SVC_USER === ADMIN_USER) {
    die('环境变量自检', 'ERP_USER 跟管理员是同一个账号',
      '服务账号必须是受限账号，跟改角色用的那个管理员分开。\n'
      + 'ERP_USER 填 seed 建出来的那个服务账号，不要图省事填超级用户。');
  }
  ok('环境变量齐了', 'base=' + BASE + ' site=' + SITE
    + ' admin=' + maskUser(ADMIN_USER) + ' svc=' + maskUser(SVC_USER));
}

// ── 2. 管理员登录 ────────────────────────────────────────────────

const adminCookie = await login(ADMIN_USER, ADMIN_PASSWORD, 'admin');
ok('管理员会话拿到', maskUser(ADMIN_USER));

// ── 3. 三个角色在这个 site 上存不存在 ───────────────────────────
//
// 角色不存在通常意味着 site 上没装 erpnext（只装了 frappe），
// 这时候后面每一步都会失败，早点说清楚。

{
  const absent = [];
  for (const role of TARGET_ROLES) {
    const res = await http('GET', '/api/resource/Role/' + encodeURIComponent(role), { cookie: adminCookie });
    if (res.status === 404) { absent.push(role); continue; }
    if (res.status !== 200) die('检查角色是否存在', '查 Role「' + role + '」时 ' + backendSays(res));
  }
  if (absent.length) {
    die('检查角色是否存在', '这个 site 上没有：' + absent.join('、'),
      '这几个是 ERPNext 的标准角色。它们不在，说明 site 上没装 erpnext 应用，\n'
      + '或者装了但没 migrate。先把 site 建对，再回来跑 provision。');
  }
  ok('三个角色都在', TARGET_ROLES.join('、'));
}

// ── 4. 读服务账号当前状态 ────────────────────────────────────────

const userPath = '/api/resource/User/' + encodeURIComponent(SVC_USER);

async function readUser(label) {
  const res = await http('GET', userPath, { cookie: adminCookie });
  if (res.status === 404) {
    die(label, backendSays(res),
      '这个 site 上没有 ' + maskUser(SVC_USER) + ' 这个账号。\n'
      + 'seed 没跑，或者 ERP_USER 填的邮箱跟 seed 里建的对不上。');
  }
  if (res.status !== 200) die(label, backendSays(res));
  let doc;
  try { doc = JSON.parse(res.text).data; }
  catch { die(label, '返回的不是 JSON：' + res.text.slice(0, 200)); }
  return {
    enabled: Number(doc.enabled) === 1,
    userType: String(doc.user_type ?? ''),
    roles: [...new Set((doc.roles ?? []).map((r) => String(r.role)))].sort(),
  };
}

const before = await readUser('读服务账号');
if (!before.enabled) {
  die('读服务账号', maskUser(SVC_USER) + ' 是禁用状态（enabled=0）',
    '禁用的账号补再多角色也登不进去。先在 ERPNext 后台把它启用，\n'
    + '再跑一次 provision。这个脚本只动角色，不替你改账号开关。');
}
if (before.userType && before.userType !== 'System User') {
  die('读服务账号', maskUser(SVC_USER) + ' 的 user_type 是「' + before.userType + '」',
    'Website User 拿不住 Accounts / Purchase / Stock 这几个角色，加了也不生效。\n'
    + '把它改成 System User 再跑一次。');
}
ok('服务账号可用', maskUser(SVC_USER) + ' · ' + before.userType
  + ' · 现有角色 ' + (before.roles.length ? before.roles.join('、') : '（一个都没有）'));

// ── 5. 算差异 ────────────────────────────────────────────────────

const toAdd = TARGET_ROLES.filter((r) => !before.roles.includes(r));

if (toAdd.length === 0) {
  ok('角色差异', '已经是目标状态，不写。缺的角色：无');
} else {
  ok('角色差异', '缺 ' + toAdd.length + ' 个：' + toAdd.join('、'));
}

if (DRY_RUN) {
  console.log('');
  console.log('--dry-run：只查不写，上面就是全部差异。');
  console.log(toAdd.length === 0
    ? '这个 site 已经是目标状态，去掉 --dry-run 跑一次也只会做权限验证。'
    : '去掉 --dry-run 再跑一次，会把 ' + toAdd.join('、') + ' 补上，然后重查确认。');
  process.exit(0);
}

// ── 6. 写入 ──────────────────────────────────────────────────────
//
// Frappe 的 PUT 是**整表替换**子表，不是追加。所以这里发的是并集：
// 现有角色一个不动，缺的补上。直接发 TARGET_ROLES 会把助教手工加的其他角色抹掉。
//
// 幂等就落在这儿：toAdd 为空时根本不发这个请求，重复跑不会产生第二行 Has Role。

if (toAdd.length > 0) {
  const union = [...new Set([...before.roles, ...TARGET_ROLES])].sort();
  const res = await http('PUT', userPath, {
    cookie: adminCookie,
    body: { roles: union.map((role) => ({ role })) },
  });
  if (res.status !== 200) {
    die('写角色', backendSays(res),
      '管理员账号改不动 User 的角色表。检查 ERP_ADMIN_USER 是不是真的有 System Manager。');
  }
  ok('写角色', '提交了 ' + union.length + ' 个：' + union.join('、') + '（回执暂不采信）');
} else {
  ok('写角色', '跳过 —— 没有要补的');
}

// ── 7. 从 ERP 重查，用重查结果判定 ──────────────────────────────

const after = await readUser('重查服务账号');
const stillMissing = TARGET_ROLES.filter((r) => !after.roles.includes(r));
if (stillMissing.length) {
  die('重查角色', '写完再读，还是缺：' + stillMissing.join('、')
    + '\n重查到的角色：' + (after.roles.join('、') || '（一个都没有）'),
    '写请求返回了 200，但 ERP 里没这几行 —— 说明子表没落库。\n'
    + '常见原因是这个 site 上有 hook / 权限规则拦了 User 的写入。找助教。');
}
ok('重查角色', '目标三个都在：' + TARGET_ROLES.join('、')
  + (after.roles.length > TARGET_ROLES.length
    ? '（另有 ' + after.roles.filter((r) => !TARGET_ROLES.includes(r)).join('、') + '，没动）' : ''));

// ── 8. 用服务账号自己的会话验权限 ───────────────────────────────
//
// 这一步才是这个脚本存在的理由。角色写进去只说明 User 文档变了，
// 说明不了 persona 真读得到东西 —— 权限规则、user_type、site 上的自定义
// permission 都可能横插一杠。所以换成服务账号自己登录，一个个去 list。

const svcCookie = await login(SVC_USER, SVC_PASSWORD, 'svc');
ok('服务账号会话拿到', maskUser(SVC_USER));

{
  const bad = [];
  const good = [];
  for (const dt of PROBE_DOCTYPES) {
    const res = await http('GET',
      '/api/resource/' + encodeURIComponent(dt) + '?limit_page_length=1&fields=["name"]',
      { cookie: svcCookie });
    if (res.status === 200) {
      let n = '?';
      try { n = String((JSON.parse(res.text).data ?? []).length); } catch { /* 读到就行，条数不重要 */ }
      good.push(dt + '=200(' + n + ' 行)');
    } else {
      bad.push('  ' + dt + ' → ' + backendSays(res).split('\n')[0]);
    }
  }
  if (bad.length) {
    die('权限验证', '服务账号读不到：\n' + bad.join('\n')
      + (good.length ? '\n读得到的：' + good.join(' ') : ''),
      '角色已经写进去了，读还是被拒 —— 这是 site 上的权限规则问题，不是角色问题。\n'
      + '拿管理员登进后台看 Role Permissions Manager 里这几个 DocType 的 read 权限。');
  }
  ok('权限验证', good.join(' '));
}

// ── 收尾 ─────────────────────────────────────────────────────────

console.log('');
if (toAdd.length === 0) {
  console.log('已经是目标状态：角色没动过，权限也验过了。这个 site 可以直接发给学员。');
} else {
  console.log('补齐完成：加了 ' + toAdd.join('、') + '，重查确认在位，三个 DocType 都读得到。');
}
console.log('下一步：把 ERP_BASE / ERP_SITE / ERP_USER / ERP_PASSWORD 发给学员填进他自己的 .env，');
console.log('然后 ERP_MODE=live npm run preflight 应该全绿。');
process.exit(0);
