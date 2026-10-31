// npm run demo:mock
//
// 一条完整链路跑给你看：查库存 → 查原单 → 算缺口 → 建草稿 → 回查 → 讲清楚。
// 全程走 mock，不需要 ERPNext，不需要网络。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath,
  [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'demo.ts')],
  { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
