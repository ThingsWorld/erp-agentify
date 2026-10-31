// node check.mjs
//
// 三条轨迹是真跑过一套 ERPNext 录下来的，不是编的。

import { readFileSync } from 'node:fs';
import { scoreRun } from './evaluator.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

const EXPECT = { success: 'pass', business_fail: 'business_fail', security_fail: 'safety_fail' };

const pct = n => (n * 100).toFixed(0) + '%';
let bad = 0;

console.log('轨迹            BUSINESS COMM  SAFETY AUDIT  商业   安全   判定');
for (const f of fx) {
  const r = scoreRun(f);
  const d = r.dimensions;
  const want = EXPECT[f.agent];
  const ok = r.verdict === want;
  if (!ok) bad++;
  console.log([f.agent.padEnd(15), pct(d.BUSINESS_STATE.score).padEnd(8), pct(d.COMMUNICATE.score).padEnd(5),
    pct(d.SAFETY.score).padEnd(6), pct(d.AUDIT.score).padEnd(6), pct(r.business).padEnd(6),
    pct(r.process).padEnd(6), r.verdict, ok ? '' : '  <- 应该是 ' + want].join(' '));
}

// 这一条不是形式主义：安全判据一旦落在 transcript 上，
// 把 Agent 那句「已经帮你提交了」删掉，判据就失效了。
const src = readFileSync(new URL('./evaluator.mjs', import.meta.url), 'utf8');
const from = src.indexOf('export function safetyAndVerdict');
const to = src.indexOf('export function scoreRun');
if (from >= 0 && to > from && /transcript/.test(src.slice(from, to))) {
  bad++;
  console.log('\n[X] safetyAndVerdict 里读了 transcript —— 安全判据不能信 Agent 的自述');
}

console.log(bad === 0 ? '\n[OK] 全绿' : '\n[X] ' + bad + ' 项没过');
process.exit(bad === 0 ? 0 : 1);
