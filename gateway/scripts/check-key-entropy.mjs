// node scripts/check-key-entropy.mjs src/idempotency-key.ts
//
// Task 06 的第一道网：幂等键里不许掺熵。
//
// 掺了会怎样：网关超时、你重试，第二次算出来的键跟第一次不一样，
// 台账查不到，于是又建一张采购单。人到货那天才发现订了两倍。
//
// 只看代码，不看注释 —— idempotency-key.ts 开头那段说明本身就写着
// 「不许有时间戳、随机数」，按裸文本 grep 会把说明判成违规。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, matchRules, readStripped, report, toPosix } from './lib/scan-util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 硬规则：出现即违规。 */
const RULES = [
  { id: 'date-now', re: /\bDate\s*\.\s*now\b/, why: '时间戳：重试时机不同，键就不同' },
  { id: 'new-date', re: /\bnew\s+Date\b/, why: '时间戳：重试时机不同，键就不同' },
  { id: 'date-ctor', re: /\bDate\s*\.\s*(parse|UTC)\b/, why: '时间戳：键不该跟时间有关' },
  { id: 'math-random', re: /\bMath\s*\.\s*random\b/, why: '随机数：重试算不出同一个键' },
  { id: 'random-uuid', re: /\brandomUUID\b/, why: '随机数：每次调用都是新值' },
  { id: 'random-bytes', re: /\brandom(Bytes|Int|Fill(Sync)?)\b/, why: '随机数：每次调用都是新值' },
  { id: 'process-pid', re: /\bprocess\s*\.\s*(pid|ppid)\b/, why: '进程号：换个进程重试就命不中' },
  { id: 'process-hrtime', re: /\bprocess\s*\.\s*hrtime\b/, why: '高精度时钟，跟时间戳一样是熵' },
  { id: 'perf-now', re: /\bperformance\s*\.\s*now\b/, why: '高精度时钟，跟时间戳一样是熵' },
  { id: 'uptime', re: /\bprocess\s*\.\s*uptime\b/, why: '跟进程启动时刻绑定，不稳定' },
  // 自增序号：第 n 次调用一个值，重放时对不上。只盯名字像计数器的那些，
  // 免得把 for (let i = 0; i < xs.length; i++) 误伤了。
  {
    id: 'counter',
    re: /\b\w*(seq|Seq|counter|Counter|serial|Serial|nonce|Nonce|tick|Tick)\w*\s*(\+\+|--|\+=)/,
    why: '自增序号：重试时数已经变了，等于随机数',
  },
  { id: 'counter-post', re: /\b(let|var)\s+\w*(seq|counter|serial|nonce)\w*\s*=\s*0\b/i, why: '看着像模块级计数器，键里不能有它' },
];

const argTarget = process.argv[2] ?? 'src/idempotency-key.ts';
const targets = process.argv.length > 3 ? process.argv.slice(2) : [argTarget];

const hits = [];
let scanned = 0;

for (const t of targets) {
  const abs = resolve(ROOT, t);
  if (!exists(abs)) {
    console.error('[FAIL] 扫不到文件：' + t + '（找的是 ' + toPosix(abs) + '）');
    process.exit(1);
  }
  scanned += 1;
  const rel = toPosix(t);
  for (const h of matchRules(readStripped(abs), RULES)) hits.push({ ...h, file: rel });
}

const code = report('幂等键无熵检查（' + scanned + ' 个文件）', hits, '键只由业务字段拼出来');
if (code !== 0) {
  console.error('');
  console.error('要点：键回答的是「谁、给谁、买什么、发去哪个仓、哪一批」。');
  console.error('这几样在重试时是同一份输入，算出来才是同一个键。');
}
process.exit(code);
