// 基线采集。scripts/capture-baseline.mjs 用 tsx 起它。
//
// 一条规矩：**所有数字都从 Gateway 读出来。** 这里不 readFileSync 种子文件
// 去拼快照 —— 种子只用来算 fixtureDigest，那是文件指纹，不是业务数据。
//
// 走网关的代价是多写几行装配，换来的是审计里能反查：
// 快照上的 runId 拿去 audit.byRun()，能看到这一轮读了 Purchase Order 和 Bin，
// outcome=done、verifiedAt 非空。翻文件拼出来的快照没有这一条。
//
// 输出做过稳定排序（单据按 name、行按 item_code、Bin 按 item_code+warehouse、
// counts 按键名），除了时间戳和 runId 之外逐字可比 —— diff-baseline.mjs 靠这个。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRig } from './harness.js';
import { GatewayClient } from './gateway-client.js';
import { DocType, FACTS } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 快照里要点名的四类。都在 persona 的白名单内，一个都不越权。 */
const DOCTYPES: readonly DocType[] = ['Purchase Order', 'Bin', 'Item', 'Supplier'];

interface BaselineItem { item_code: string; qty: number; rate: number }
interface BaselinePo { name: string; supplier: string; docstatus: number; items: BaselineItem[] }
interface BaselineBin { item_code: string; warehouse: string; actual_qty: number }

function parseArgs(argv: string[]): { out: string; scenario: string; runId: string } {
  const o = {
    out: join(ROOT, 'reports', 'baseline.json'),
    scenario: 'baseline',
    runId: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--out' && v) { o.out = resolve(process.cwd(), v); i += 1; }
    else if (a === '--scenario' && v) { o.scenario = v; i += 1; }
    else if (a === '--run-id' && v) { o.runId = v; i += 1; }
  }
  if (!o.runId) o.runId = 'baseline-' + o.scenario + '-' + randomUUID().slice(0, 8);
  return o;
}

/** 种子文件的指纹。只读文件字节算哈希，不从里面取任何业务数字。 */
function fixtureDigest(): string {
  const seed = join(ROOT, 'fixtures', 'erp-seed.json');
  return 'sha256:' + createHash('sha256').update(readFileSync(seed)).digest('hex');
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toPo(doc: Record<string, unknown>): BaselinePo {
  const rawItems = Array.isArray(doc.items) ? (doc.items as Record<string, unknown>[]) : [];
  const items: BaselineItem[] = rawItems
    .map((it) => ({
      item_code: String(it.item_code ?? ''),
      qty: num(it.qty),
      rate: num(it.rate),
    }))
    .sort((a, b) => a.item_code.localeCompare(b.item_code));
  return {
    name: String(doc.name ?? ''),
    supplier: String(doc.supplier ?? ''),
    docstatus: num(doc.docstatus),
    items,
  };
}

function toBin(doc: Record<string, unknown>): BaselineBin {
  return {
    item_code: String(doc.item_code ?? ''),
    warehouse: String(doc.warehouse ?? ''),
    actual_qty: num(doc.actual_qty),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // persistent:true 把审计落到 reports/audit.ndjson —— 进程退了还查得到，
  // 不然快照上的 runId 事后没人对得上。台账在 reports/ledger/，这一轮读操作
  // 不写台账，它会是空的。两处都归 npm run mock:reset 清。
  const rig = makeRig({
    scenario: opts.scenario,
    runId: opts.runId,
    persistent: true,
    workDir: join(ROOT, 'reports'),
  });

  try {
    const client = new GatewayClient(rig.tools, rig.runId);

    const counts: Record<string, number> = {};
    let purchaseOrders: BaselinePo[] = [];
    let bins: BaselineBin[] = [];

    for (const dt of DOCTYPES) {
      const rows = await client.query(dt);
      counts[dt] = rows.length;
      if (dt === 'Purchase Order') purchaseOrders = rows.map(toPo);
      if (dt === 'Bin') bins = rows.map(toBin);
    }

    purchaseOrders.sort((a, b) => a.name.localeCompare(b.name));
    bins.sort((a, b) =>
      a.item_code.localeCompare(b.item_code) || a.warehouse.localeCompare(b.warehouse));

    const sortedCounts: Record<string, number> = {};
    for (const k of Object.keys(counts).sort()) sortedCounts[k] = counts[k] as number;

    const auditEntries = (await rig.audit.byRun(rig.runId)).length;
    const stamp = new Date().toISOString();

    // 键的顺序是契约的一部分：公开测试按 name → docstatus、
    // warehouse → actual_qty 开正则窗口，别重排。
    const baseline = {
      capturedAt: stamp,
      generatedAt: stamp,
      runId: rig.runId,
      source: 'mock',
      scenario: opts.scenario,
      site: rig.site,
      counts: sortedCounts,
      purchaseOrders,
      bins,
      auditEntries,
      fixtureDigest: fixtureDigest(),
    };

    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

    const po = purchaseOrders.find((p) => p.name === FACTS.originalPo);
    const shelf = bins.find(
      (b) => b.item_code === FACTS.itemCode && b.warehouse === FACTS.warehouse);

    console.log('基线已采 · 场景 ' + opts.scenario + ' · site ' + rig.site);
    console.log('runId      ' + rig.runId);
    console.log('采购单     ' + (sortedCounts['Purchase Order'] ?? 0) + ' 张'
      + (po ? '（原单 ' + po.name + ' docstatus=' + po.docstatus + '）' : ''));
    console.log('Bin        ' + (sortedCounts.Bin ?? 0) + ' 条'
      + (shelf ? '（' + shelf.item_code + ' @ ' + shelf.warehouse
                + ' actual_qty=' + shelf.actual_qty + '）' : ''));
    console.log('审计       ' + auditEntries + ' 条（全部是读）');
    console.log('写入       ' + opts.out);
  } finally {
    rig.cleanup();
  }
}

main().catch((e: unknown) => {
  console.error('采基线失败：' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
