// npm run smoke:live
//
// 打真 ERPNext。凭据从环境变量读（见 .env.example），**不落盘、不打印**。
//
// 退出码分三种，调用方（scripts/overlay-verify.mjs）靠它区分：
//   0  连上了，冒烟全过
//   3  没配凭据，一步都没跑 —— 不是通过，也不是失败
//   其它  真跑了，真挂了
// 以前「没配凭据」也退 0，于是 overlay-verify 把它记成 OK ——
// 一台从没连过 ERP 的机器照样能拿到绿灯。3 就是为了堵这个。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env 存在就读进来（只在本进程内，不写回任何地方）。
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (!process.env.ERP_USER || !process.env.ERP_PASSWORD) {
  console.log('跳过：没有配 ERP_USER / ERP_PASSWORD。');
  console.log('要跑真栈冒烟，把 .env.example 复制成 .env 填上助教发给你的受限账号。');
  console.log('（**不是** Administrator —— 用它会触发 af-admin-credentials。）');
  process.exit(3);   // 3 = 跳过，见文件头
}

const r = spawnSync(process.execPath,
  [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'smoke-live.ts')],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ERP_MODE: 'live' } });
process.exit(r.status ?? 1);
