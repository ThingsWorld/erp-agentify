// 跨进程探针（Task 06）。测试用 child_process.spawn 起它，每个进程一份独立的
// PersistentLedger，指向同一个台账目录。
//
// 为什么要真起进程：单进程里的 Promise.all 只是并发，事件循环还是一个，
// 「先 existsSync 再 writeFile」在里面照样能跑绿。四个进程是真并行，
// 占位不原子当场就穿帮。
//
// 它自己不做断言，只把结果打成一行 JSON 交给父进程判。
//
// 起法（node 直接跑不了 .ts，要经 tsx）：
//   node node_modules/tsx/dist/cli.mjs tests/reserve-worker.mjs \
//     --dir <台账目录> --key <幂等键> --owner w1 --start-at <epoch 毫秒>
//
// 参数：
//   --dir       台账目录，必填。几个进程传同一个才算抢同一份账。
//   --key       幂等键，必填。
//   --owner     租约持有者标识，默认 worker-<pid>。
//   --lease     租约毫秒数，默认 30000。
//   --learner   learnerId，默认 learner-a。键的作用域是三元组，所以它参与哈希。
//   --site      siteId，默认 erp.localhost。
//   --start-at  统一起跑时刻（epoch 毫秒）。几个进程传同一个值才撞得上。
//   --act       reserve（默认）/ succeed / key
//   --ref-name  act=succeed 时写进台账的单号。
//   --intent --supplier --item --qty --batch   act=key 时算幂等键用。

import { PersistentLedger } from '../src/ledger-persistent.ts';
import { draftKey } from '../src/idempotency-key.ts';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[a.slice(2)] = 'true'; continue; }
    out[a.slice(2)] = next;
    i += 1;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到统一起跑时刻。最后几毫秒自旋，setTimeout 的精度不够对齐四个进程。 */
async function waitForStart(startAt) {
  if (!Number.isFinite(startAt) || startAt <= 0) return;
  const gap = startAt - Date.now() - 5;
  if (gap > 0) await sleep(gap);
  while (Date.now() < startAt) { /* 自旋 */ }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const act = a.act ?? 'reserve';

  if (act === 'key') {
    // 幂等键的跨进程一致性：同一份业务输入，换个进程算出来的字节要一模一样。
    const key = draftKey({
      intent: a.intent ?? 'po-correction',
      supplier: a.supplier ?? 'Globex',
      itemCode: a.item ?? 'ITEM-SHELF-01',
      qty: Number(a.qty ?? 20),
      batch: a.batch ?? 'PUR-ORD-2026-00001',
    });
    process.stdout.write(JSON.stringify({ ok: true, act, pid: process.pid, key }) + '\n');
    return;
  }

  if (!a.dir) throw new Error('缺 --dir');
  if (!a.key) throw new Error('缺 --key');

  const owner = a.owner ?? 'worker-' + process.pid;
  const leaseMs = Number(a.lease ?? 30_000);
  const principal = {
    learnerId: a.learner ?? 'learner-a',
    siteId: a.site ?? 'erp.localhost',
    persona: { name: 'agent_svc', allowedDocTypes: ['Purchase Order', 'Item', 'Bin', 'Supplier'] },
  };

  const ledger = new PersistentLedger(a.dir);
  await waitForStart(Number(a['start-at'] ?? 0));

  const res = await ledger.reserve(principal, a.key, 'erp.create_draft', owner, leaseMs);

  if (act === 'succeed') {
    if (res.outcome !== 'acquired' && res.outcome !== 'recovered')
      throw new Error('act=succeed 需要先拿到租约，实际拿到 ' + res.outcome);
    // 默认值是合成哨兵，不是某次跑出来的号 —— 真实号由宿主分配，写死会误导。
    const ref = { doctype: 'Purchase Order', name: a['ref-name'] ?? 'PUR-ORD-TEST-00000' };
    await ledger.begin(principal, a.key, owner);
    await ledger.succeed(principal, a.key, owner, ref);
  }

  const row = await ledger.get(principal, a.key);
  process.stdout.write(JSON.stringify({
    ok: true, act, pid: process.pid, owner,
    outcome: res.outcome,
    state: row?.state ?? null,
    attempts: row?.attempts ?? null,
    leaseOwner: row?.leaseOwner ?? null,
    erpRef: row?.erpRef ?? null,
  }) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, pid: process.pid, error: String(e && e.message ? e.message : e) }) + '\n');
  process.exitCode = 1;
});
