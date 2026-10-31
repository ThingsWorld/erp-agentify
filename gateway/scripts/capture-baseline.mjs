// npm run mock:baseline [-- --out <path>] [--scenario <id>] [--run-id <id>]
//
// 拍一份基线快照。默认写 reports/baseline.json。
//
// 数据**经 Gateway 取**，不 readFileSync 种子文件。两条路能凑出一模一样的表，
// 但只有走网关那条在审计里留得下痕：谁、哪次 run、用哪个能力读的。
// 翻文件拼出来的快照，AUDIT 维度直接判 0。
//
// 真正干活的是 src/capture-baseline.ts，链路是：
//   makeRig({ scenario }) → GatewayClient.query → tools.call → gw.call(bearer,
//     { capability: 'erp.query', args: { docType: 'Purchase Order' } }, runId)
//   同一个 runId 再走一遍 erp.query 拿 Bin / Item / Supplier，
//   最后 audit.byRun(runId) 数一下这次读了几条，写进快照。
//
// 这个脚本只做三件事：解析参数、把绝对路径交给 tsx 子进程、把退出码原样传出去。

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const opts = { out: join(ROOT, 'reports', 'baseline.json'), scenario: 'baseline', runId: '' };

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`${a} 后面要跟一个值`);
      process.exit(2);
    }
    i += 1;
    return v;
  };
  if (a === '--out') opts.out = resolve(process.cwd(), next());
  else if (a === '--scenario') opts.scenario = next();
  else if (a === '--run-id') opts.runId = next();
  else if (a === '--help' || a === '-h') {
    console.log('用法：npm run mock:baseline -- [--out <path>] [--scenario <id>] [--run-id <id>]');
    process.exit(0);
  } else {
    console.error(`不认识的参数 ${a}。--help 看用法。`);
    process.exit(2);
  }
}

const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = join(ROOT, 'src', 'capture-baseline.ts');

for (const [what, path] of [['tsx', tsx], ['src/capture-baseline.ts', entry]]) {
  if (!existsSync(path)) {
    console.error(`[X ] ${what} 不在（${path}）`);
    if (what === 'tsx') console.error('     先在 starter/gateway 下跑 npm install。');
    process.exit(1);
  }
}

const args = [tsx, entry, '--out', opts.out, '--scenario', opts.scenario];
if (opts.runId) args.push('--run-id', opts.runId);

const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
