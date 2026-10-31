// node scripts/scan-passthrough.mjs
//
// Task 02 的 02-no-passthrough-tool：工具面里不许有「万能工具」。
//
// 万能工具长这样：erp_call(doctype, method, args)。
// 一次写完、什么都能干，代价是把整个 ERP 的地址空间交了出去 ——
// 之后 policy 那层就没得挡了，因为它看到的每一次调用形状都一样。
//
// 这个脚本查两件事：
//   反面：src/tools.ts 与 src/tool-schema.ts 里有没有自由格式的
//         method / endpoint / path / url / sql / cmd 这类参数；
//         工具表里有没有映到四个 capability 之外的东西。
//   正面：工具表恰好 4 项；DocType 白名单是模块常量，不是谁传进来的。
//
// 只看代码，注释先挖空 —— 上面那段「反面教材是 erp_call(doctype, method, args)」
// 就写在 tool-schema.ts 的文件头里，按裸文本 grep 会把说明本身判成违规。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, matchRules, readStripped, report, toPosix } from './lib/scan-util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['src/tools.ts', 'src/tool-schema.ts'];

/** types.ts 里冻结的四个能力。工具表只能映到这四个。 */
const CAPABILITIES = ['erp.query', 'erp.get', 'erp.create_draft', 'erp.submit'];

/** 自由格式字段名。收下任何一个，工具就变成了可寻址的通道。 */
const FREEFORM = ['method', 'endpoint', 'path', 'url', 'uri', 'sql', 'cmd', 'command', 'script', 'route', 'rawArgs', 'rawBody', 'rawSql'];
const FF = FREEFORM.join('|');

const RULES = [
  // 'method' 这样的字面量键：schema 里收这个字段。
  { id: 'freeform-literal', re: new RegExp("['\"](" + FF + ")['\"]\\s*[:\\]]"), why: '自由格式字段出现在 schema 的键上' },
  // method?: string —— 接口里声明了这个字段。
  { id: 'freeform-decl', re: new RegExp('\\b(' + FF + ')\\s*\\??\\s*:\\s*string\\b'), why: '工具参数里声明了自由格式字段' },
  // args.method / a.endpoint —— 从入参里读这个字段。
  { id: 'freeform-read', re: new RegExp('\\b(a|args|arg|input|params|payload|opts|req)\\s*\\.\\s*(' + FF + ')\\b'), why: '从入参里读自由格式字段' },
  // 万能工具的名字。
  { id: 'passthrough-name', re: /\b(erp_call|erpCall|callErp|genericCall|genericTool|passthrough|proxyCall|rawCall|invokeMethod|call_method)\b/, why: '这是万能工具的名字，四个具名工具之外不该有第五个入口' },
  // 白名单从入参来：allowlist 变成参数就等于没有白名单。
  // 认的是「括号里出现这个名字，括号后面接返回类型 / => / 函数体」，也就是形参位置。
  { id: 'allowlist-as-param', re: /\([^)]{0,200}\b(allowlist|allowList|allowedDocTypes|docTypes|doctypes|docTypeList)\b[^)]{0,200}\)\s*(:|=>|\{)/, why: 'DocType 白名单被做成了入参，调用方就能自己扩表' },
  // 白名单从运行时数据推出来。
  { id: 'allowlist-derived', re: /\b(DOCTYPE_ALLOWLIST|TOOL_DOCTYPES)\b[^\n;]{0,80}(await|JSON\.parse|process\.env|\.map\(|\.concat\(|\.push\(|response|res\.data)/, why: 'DocType 白名单由运行时数据拼出来，注入就能改它' },
];

const problems = [];
const note = (file, line, id, why, text) => problems.push({ file, line, col: 0, id, why, text: text ?? '' });

// ── 反面：逐文件扫 ────────────────────────────────────────────────
/** @type {Map<string, string[]>} */
const stripped = new Map();
for (const rel of TARGETS) {
  const abs = join(ROOT, rel);
  if (!exists(abs)) {
    note(rel, 0, 'missing-file', '文件不存在，工具面还没写');
    continue;
  }
  const lines = readStripped(abs);
  stripped.set(rel, lines);
  for (const h of matchRules(lines, RULES)) problems.push({ ...h, file: rel });
}

// ── 正面：工具表恰好 4 项，且只映到四个 capability ────────────────
const toolsLines = stripped.get('src/tools.ts');
if (toolsLines) {
  const text = toolsLines.join('\n');
  const decl = /export\s+const\s+(TOOL_REGISTRY|TOOLS)\b/.exec(text);
  if (!decl) {
    note('src/tools.ts', 0, 'no-registry', '找不到 export const TOOLS / TOOL_REGISTRY —— 工具表得是模块常量');
  } else {
    const body = balancedFrom(text, decl.index);
    if (body === null) {
      note('src/tools.ts', lineOf(text, decl.index), 'registry-unparsed', '工具表的字面量括号没配上，读不出条目');
    } else {
      const caps = [...body.matchAll(/['"](erp\.[a-z_]+)['"]/g)].map((m) => m[1]);
      const bad = caps.filter((c) => !CAPABILITIES.includes(c));
      for (const c of new Set(bad)) {
        note('src/tools.ts', lineOf(text, decl.index), 'unknown-capability',
          '工具表里映到了 "' + c + '"，types.ts 的 Capability 只有四个');
      }
      if (caps.length !== 4) {
        note('src/tools.ts', lineOf(text, decl.index), 'registry-size',
          '工具表里数出 ' + caps.length + ' 条 capability，应该正好 4 条（' + CAPABILITIES.join(' / ') + '）');
      }
      const missing = CAPABILITIES.filter((c) => !caps.includes(c));
      if (missing.length > 0) {
        note('src/tools.ts', lineOf(text, decl.index), 'registry-missing',
          '工具表缺了：' + missing.join('、'));
      }
      // 表本身要冻起来。运行时能改的表等于没有表。
      if (!/Object\.freeze|as\s+const|Readonly</.test(text.slice(decl.index, decl.index + (body.length + 200)))) {
        note('src/tools.ts', lineOf(text, decl.index), 'registry-mutable',
          '工具表没冻（Object.freeze / as const / Readonly<>），运行时能被改掉');
      }
    }
  }
}

// ── 正面：DocType 白名单是常量 ────────────────────────────────────
{
  const all = TARGETS.map((r) => stripped.get(r) ?? []).map((l) => l.join('\n')).join('\n');
  const literalAllowlist = /export\s+const\s+DOCTYPE_ALLOWLIST\b/.test(all);
  const importsFrozen = /import\s*\{[^}]*\bTOOL_DOCTYPES\b[^}]*\}\s*from\s*['"][^'"]*types(\.js)?['"]/.test(all)
    || /\bTOOL_DOCTYPES\b/.test(all);
  if (!literalAllowlist && !importsFrozen) {
    note('src/tools.ts', 0, 'no-allowlist',
      '找不到 DocType 白名单：要么 export const DOCTYPE_ALLOWLIST（字面量），要么用 types.ts 的 TOOL_DOCTYPES');
  }
  if (literalAllowlist) {
    const toolsText = (stripped.get('src/tools.ts') ?? []).join('\n');
    const d = /export\s+const\s+DOCTYPE_ALLOWLIST\b/.exec(toolsText);
    if (d) {
      const body = balancedFrom(toolsText, d.index);
      if (body !== null && /(await|JSON\.parse|process\.env|\.map\(|\.filter\(|\.concat\()/.test(body)) {
        note('src/tools.ts', lineOf(toolsText, d.index), 'allowlist-computed',
          'DOCTYPE_ALLOWLIST 是算出来的，不是字面量 —— 算的输入被污染，白名单就跟着变');
      }
    }
  }
}

/**
 * 从 `export const X` 开始，取初始化表达式里第一个 { 或 [ 到与它配对的收尾。
 *
 * 得先跳过 `=`，不然 `const TOOLS: readonly ToolDef[] = [...]` 里
 * 抓到的是类型标注上那对空方括号，条目数就数成 0 了。
 */
function balancedFrom(text, from) {
  const eq = /=(?![=>])/.exec(text.slice(from));
  if (!eq) return null;
  const after = from + eq.index + 1;
  const open = /[{[]/.exec(text.slice(after));
  if (!open) return null;
  const s = after + open.index;
  const pairs = { '{': '}', '[': ']' };
  const stack = [];
  for (let i = s; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{' || c === '[') stack.push(pairs[c]);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) return text.slice(s, i + 1);
    }
  }
  return null;
}

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

const code = report('工具面万能工具扫描', problems.map((p) => ({ ...p, file: toPosix(p.file) })),
  '四个具名工具，DocType 是受控参数');
if (code !== 0) {
  console.error('');
  console.error('工具面的形状要固定：工具名 → 能力是模块常量，DocType 过白名单，');
  console.error('参数各有各的窄 schema。留一个能自己填 method 的口子，后面几层就都失效了。');
}
process.exit(code);
