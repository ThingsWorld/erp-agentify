// npm run mock:reset
//
// mock 的 ERP 状态是**进程内**的：每起一次进程，src/erp-mock.ts 从
// fixtures/erp-seed.json 重新灌一遍，进程一退就没了。所以这里没有「回滚 ERP」这回事，
// 要清的只有跨进程活着的那部分 —— 落盘的幂等台账和审计。
//
// 清理按**确切路径**，一条一条列在下面。
// 不扫目录、不按修改时间筛、不按前缀通配。上次有人拿「最近一小时改过的」当条件清场，
// 把别人正在跑的那次 run 的台账一起端了，查了一下午。
//
// 这里也**绝不**回写 fixtures/erp-seed.json —— 种子是只读的，npm run verify:fixture 会核。

import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 落盘产物的确切路径。
 * 前四条是 makeRig({persistent:true}) 在 workDir 下摆的东西
 * （FileAudit → <workDir>/audit.ndjson，PersistentLedger → <workDir>/ledger/），
 * workDir 取 reports/ 时就是这几个。最后一条是有人把 workDir 放到仓库根的情况。
 */
const TARGETS = [
  'reports/audit.ndjson',
  'reports/ledger',
  'reports/.ledger',
  'reports/.ledger-live',
  '.ledger',
];

const removed = [];
const kept = [];

for (const rel of TARGETS) {
  const abs = join(ROOT, ...rel.split('/'));
  if (!existsSync(abs)) { kept.push(rel); continue; }
  const kind = statSync(abs).isDirectory() ? '目录' : '文件';
  rmSync(abs, { recursive: true, force: true });
  removed.push(`${rel}（${kind}）`);
}

console.log('mock:reset · ' + ROOT + '\n');
if (removed.length === 0) {
  console.log('[--] 没有可清的落盘产物，环境已经是干净的。');
} else {
  for (const r of removed) console.log(`[rm] ${r}`);
}
if (kept.length > 0) console.log(`[--] 本来就不在：${kept.join('  ')}`);

console.log('');
console.log('mock ERP 的单据状态不落盘，下一次起进程会从 fixtures/erp-seed.json 重新灌。');
console.log('种子文件没有被动过（npm run verify:fixture 可以复核）。');
console.log('接着跑 npm run mock:baseline 就能重采一份基线。');
