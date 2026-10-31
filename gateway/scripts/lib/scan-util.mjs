// 三个静态扫描脚本共用的小工具。
//
// 放在自己的文件里，不去动 types.ts / harness.ts 那几个冻结文件。
//
// 最要紧的一条：**注释里提到违规写法不算违规**。
// idempotency-key.ts 的开头就写着「不许有时间戳、随机数」，
// 按裸文本 grep 会把这句说明本身判成违规，然后没人知道为什么红。
// 所以先把注释挖空再匹配。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 永远不进的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.vitest']);

/**
 * 递归收集文件。
 * @param {string} dir 起点目录（绝对路径）
 * @param {(relPosix: string) => boolean} accept 收不收这个文件，参数是相对 dir 的 posix 路径
 * @returns {string[]} 绝对路径，字典序
 */
export function walk(dir, accept) {
  /** @type {string[]} */
  const out = [];
  const rec = (cur) => {
    let ents;
    try {
      ents = readdirSync(cur, { withFileTypes: true });
    } catch {
      return; // 目录不存在就当空的，调用方自己决定这算不算问题
    }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) rec(p);
      } else if (e.isFile()) {
        if (accept(toPosix(relative(dir, p)))) out.push(p);
      }
    }
  };
  rec(dir);
  return out;
}

/** Windows 的反斜杠一律换成斜杠。报告里的路径要跨平台一致。 */
export function toPosix(p) {
  return p.split(sep).join('/');
}

export function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把注释挖空，行数、列号原样保留。
 *
 * 认得 `//`、`/* *\/`、三种引号。引号里的 `//` 不当注释
 * （不然 'http://x' 会被从中间截断，后半截就再也扫不到了）。
 * 模板串整段当字符串，`${}` 里的代码不再往下拆 —— 拿它藏违规写法属于刻意规避，
 * 不是这个脚本要防的误伤。
 *
 * @param {string} src
 * @returns {string[]} 逐行，注释位置换成空格
 */
export function stripComments(src) {
  const n = src.length;
  const out = new Array(n);
  let i = 0;
  /** @type {'code'|'line'|'block'|'sq'|'dq'|'tpl'} */
  let st = 'code';

  // 换行必须原样留着，别的字符换成空格 —— 行号列号都不能挪。
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    switch (st) {
      case 'code':
        if (c === '/' && d === '/') { st = 'line'; out[i] = ' '; i += 1; }
        else if (c === '/' && d === '*') { st = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; }
        else {
          if (c === "'") st = 'sq';
          else if (c === '"') st = 'dq';
          else if (c === '`') st = 'tpl';
          out[i] = c; i += 1;
        }
        break;

      case 'line':
        if (c === '\n') { st = 'code'; out[i] = '\n'; } else out[i] = blank(c);
        i += 1;
        break;

      case 'block':
        if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; st = 'code'; }
        else { out[i] = blank(c); i += 1; }
        break;

      case 'sq':
      case 'dq':
      case 'tpl': {
        const q = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
        if (c === '\\' && i + 1 < n) { out[i] = c; out[i + 1] = src[i + 1]; i += 2; }
        else if (c === q) { st = 'code'; out[i] = c; i += 1; }
        else if (c === '\n' && st !== 'tpl') { st = 'code'; out[i] = '\n'; i += 1; } // 串没闭合，按换行收尾
        else { out[i] = c; i += 1; }
        break;
      }
    }
  }
  return out.join('').split('\n');
}

/** 读文件 + 挖空注释，一步到位。 */
export function readStripped(abs) {
  return stripComments(readFileSync(abs, 'utf8'));
}

/** 原样读行，给 md / json 这类没有代码注释的文件用。 */
export function readRawLines(abs) {
  return readFileSync(abs, 'utf8').split('\n');
}

/**
 * 在若干行里找一组规则。
 * @param {string[]} lines
 * @param {{id: string, re: RegExp, why: string}[]} rules
 * @returns {{line: number, col: number, id: string, why: string, text: string}[]}
 */
export function matchRules(lines, rules) {
  const hits = [];
  lines.forEach((ln, idx) => {
    for (const r of rules) {
      const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
      let m;
      while ((m = re.exec(ln)) !== null) {
        hits.push({
          line: idx + 1,
          col: m.index + 1,
          id: r.id,
          why: r.why,
          text: ln.trim().slice(0, 160),
        });
        if (m[0] === '') re.lastIndex += 1;
      }
    }
  });
  return hits;
}

/** 统一的结果打印。命中按 文件:行:列 排一列，人肉可跳。 */
export function report(title, hits, okLine) {
  if (hits.length === 0) {
    console.log('[OK] ' + title + (okLine ? ' —— ' + okLine : ''));
    return 0;
  }
  console.error('[FAIL] ' + title + '，命中 ' + hits.length + ' 处：');
  for (const h of hits) {
    console.error('  ' + h.file + ':' + h.line + (h.col ? ':' + h.col : '') + '  [' + h.id + '] ' + h.why);
    if (h.text) console.error('      ' + h.text);
  }
  return 1;
}
