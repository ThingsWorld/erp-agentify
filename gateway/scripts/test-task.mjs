// npm run test:task -- 05
//
// 按任务号跑那一个 task 的测试文件，不跑整套。
// task-09 有两个测试文件（capstone 与 no-bypass），这里会一起跑。
//
// 多余的参数原样透给 vitest：
//   npm run test:task -- 06 -t concurrency-20
//
// 直接 spawn node + node_modules/vitest/vitest.mjs，不拼 shell 字符串 ——
// Windows 上 npx / .cmd 走 shell，参数里的 - 和空格会被吃掉。

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const argv = process.argv.slice(2);
const raw = argv[0];
const passthrough = argv.slice(1);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (raw === undefined || raw === '' || raw === '--help' || raw === '-h') {
  die([
    '用法：npm run test:task -- <两位任务号> [透给 vitest 的参数]',
    '',
    '  npm run test:task -- 05',
    '  npm run test:task -- 06 -t concurrency-20',
    '',
    '任务号是 00 到 09。写 5 也行，会补成 05。',
  ].join('\n'));
}

// 允许 5 / 05 / task-05 / task-05-create-draft 几种写法，最后都归一成两位数字。
const m = /^(?:task[-_]?)?(\d{1,2})\b/.exec(String(raw));
if (!m) die('看不懂的任务号 "' + raw + '"。要的是 00 到 09 的两位数字，比如：npm run test:task -- 05');
const nn = String(m[1]).padStart(2, '0');

let entries;
try {
  entries = readdirSync(TESTS);
} catch {
  die('找不到 tests/ 目录：' + TESTS + '\n测试文件还没写，先看 task yaml 的 provided_files 列了哪些。');
}

// 命名约定是 tests/task-05.create-draft.test.ts。
// 顺手也认 task-05-xxx.test.ts，免得为了一个分隔符白红一次。
const prefix = 'task-' + nn;
const files = entries
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => f === prefix + '.test.ts' || f.startsWith(prefix + '.') || f.startsWith(prefix + '-'))
  .sort();

if (files.length === 0) {
  const known = entries.filter((f) => f.endsWith('.test.ts')).sort();
  console.error('tests/ 下没有 task-' + nn + ' 的测试文件（找的是 tests/' + prefix + '.*.test.ts）。');
  console.error(known.length
    ? '现在有的是：\n  ' + known.map((f) => 'tests/' + f).join('\n  ')
    : 'tests/ 里一个 .test.ts 都没有。');
  process.exit(1);
}

const args = [VITEST, 'run', ...files.map((f) => 'tests/' + f), ...passthrough];
console.log('$ node ' + ['node_modules/vitest/vitest.mjs', 'run', ...files.map((f) => 'tests/' + f), ...passthrough].join(' '));

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
child.on('error', (e) => {
  console.error('起不来 vitest：' + e.message + '\n先跑 npm install。');
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) { console.error('vitest 被信号 ' + signal + ' 结束'); process.exit(1); }
  process.exit(code ?? 1);
});
