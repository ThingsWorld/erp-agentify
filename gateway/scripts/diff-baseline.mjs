// node scripts/diff-baseline.mjs <a.json> <b.json>
//
// 比两份基线快照。**忽略 capturedAt / generatedAt / runId**，其余逐字比。
// 这三个每次都会变，比它们等于永远不相等；剩下的每一个字段都必须一模一样。
//
// 这是 task-00 的 00-reset-is-repeatable：reset 之后重采一次，
// 跟提交的那份对上，才说明环境真的回到了原点，而不是「看着差不多」。
//
// 有差异就把每一处按 JSON 路径列出来再 exit 1。只说「不一致」没用，
// 得让人知道是哪一张单的哪个字段从几变成了几。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 每次运行都会变、不参与比较的键。只有这三个。 */
const IGNORED = new Set(['capturedAt', 'generatedAt', 'runId']);

const [aArg, bArg] = process.argv.slice(2);
if (!aArg || !bArg) {
  console.error('用法：node scripts/diff-baseline.mjs <a.json> <b.json>');
  process.exit(2);
}

function load(arg) {
  const path = resolve(process.cwd(), arg);
  if (!existsSync(path)) {
    console.error(`[X ] ${path} 不在`);
    process.exit(2);
  }
  try {
    return { path, json: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    console.error(`[X ] ${path} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

const a = load(aArg);
const b = load(bArg);

const diffs = [];

function show(v) {
  if (v === undefined) return '(缺)';
  if (typeof v === 'object' && v !== null) {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }
  return JSON.stringify(v);
}

function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function walk(path, x, y) {
  if (kind(x) !== kind(y)) {
    diffs.push({ path, a: x, b: y });
    return;
  }

  if (Array.isArray(x)) {
    const n = Math.max(x.length, y.length);
    if (x.length !== y.length) diffs.push({ path: path + '.length', a: x.length, b: y.length });
    for (let i = 0; i < n; i += 1) walk(`${path}[${i}]`, x[i], y[i]);
    return;
  }

  if (kind(x) === 'object') {
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
    for (const k of keys) {
      // 顶层的时间戳与 runId 跳过；嵌套里出现同名字段照比。
      if (path === '' && IGNORED.has(k)) continue;
      const child = path === '' ? k : `${path}.${k}`;
      if (!(k in x) || !(k in y)) {
        diffs.push({ path: child, a: x[k], b: y[k] });
        continue;
      }
      walk(child, x[k], y[k]);
    }
    return;
  }

  if (!Object.is(x, y)) diffs.push({ path, a: x, b: y });
}

walk('', a.json, b.json);

if (diffs.length === 0) {
  console.log('[OK] 两份基线一致（capturedAt / generatedAt / runId 不比）');
  console.log(`     a  ${a.path}`);
  console.log(`     b  ${b.path}`);
  process.exit(0);
}

console.error(`[X ] 两份基线有 ${diffs.length} 处不一致`);
console.error(`     a  ${a.path}`);
console.error(`     b  ${b.path}`);
console.error('');
for (const d of diffs.slice(0, 40)) {
  console.error(`  ${d.path || '(根)'}`);
  console.error(`    a: ${show(d.a)}`);
  console.error(`    b: ${show(d.b)}`);
}
if (diffs.length > 40) console.error(`  …还有 ${diffs.length - 40} 处`);
console.error('');
console.error('环境没有回到原点，或者采集脚本读到了上一轮的残留。');
console.error('先 npm run mock:reset，再 npm run mock:baseline 重采一次。');
process.exit(1);
