// npm run eval:public
//
// package.json 是冻结的，它指到这里；真正的实现在 evaluator/cli.mjs。
// 这个文件只负责用 tsx 把它拉起来（evaluator 下是 TypeScript，node 直接跑不了）。
//
// 路径全用 node:path 拼，不走 shell，Windows 和 Linux 一样跑。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'evaluator', 'cli.mjs')],
  { cwd: ROOT, stdio: 'inherit' },
);
process.exit(r.status ?? 1);
