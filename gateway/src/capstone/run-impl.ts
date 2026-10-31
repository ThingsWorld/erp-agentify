// Task 09：所有业务读写均通过 GatewayClient。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { makeRig } from '../harness.js';
import { GatewayClient, numberField, untrustedField } from '../gateway-client.js';
import { computeShortfall } from '../agent/shortfall.js';
import { businessProbe } from '../reconcile.js';
import { FACTS } from '../types.js';
import { capstoneKey } from './idempotency-key.mjs';

export async function runCapstone(): Promise<void> {
  const rig = makeRig({ scenario: 'capstone', persistent: true });
  const client = new GatewayClient(rig.tools, rig.runId);
  const made: string[] = [];
  const scheduleDate = '2026-09-25'; // 课程场景的业务月份，不使用机器当前月份。
  try {
    const baseline = await client.query('Purchase Order');
    const originalCandidates = (await client.query('Purchase Order', { supplier: FACTS.supplier, docstatus: 1 }))
      .filter(p => Array.isArray(p.items) && p.items.some((x: Record<string, unknown>) => x.item_code === FACTS.itemCode));
    if (originalCandidates.length !== 1) throw new Error('原单不唯一，需要人工确认');
    const original = await client.get('Purchase Order', String(originalCandidates[0]!.name));
    const originalName = String(original.name);
    const originalLine = (original.items as Record<string, unknown>[]).find(x => x.item_code === FACTS.itemCode)!;
    const warehouse = String(originalLine.warehouse);
    const rate = numberField(originalLine, 'rate');
    const bins = await client.query('Bin', { item_code: FACTS.itemCode, warehouse });
    if (bins.length !== 1 || bins[0]!.actual_qty === null || bins[0]!.actual_qty === undefined)
      throw new Error('库存未知或记录不唯一，停止建单');
    const onHand = numberField(bins[0]!, 'actual_qty');
    const { shortfall } = computeShortfall({ requiredQty: FACTS.requiredQty, onHandQty: onHand });
    if (shortfall <= 0) throw new Error('没有缺口，不建单');
    const supplier = await client.get('Supplier', FACTS.supplier);
    const sources: string[] = [];
    for (const doc of [supplier, original]) {
      for (const field of ['supplier_details', 'remarks', 'terms', 'description']) {
        const u = untrustedField(doc, field);
        if (u) sources.push(`${u.source.doctype}/${u.source.name}.${u.source.field}`);
      }
    }
    const doc = { supplier: FACTS.supplier, company: FACTS.company, currency: FACTS.currency,
      schedule_date: scheduleDate, items: [{ item_code: FACTS.itemCode, qty: shortfall, rate,
        warehouse, schedule_date: scheduleDate }] };
    const key = capstoneKey({ intent: 'po-correction', supplier: FACTS.supplier,
      itemCode: FACTS.itemCode, qty: shortfall, batch: originalName });
    const filters = businessProbe(doc);
    const before = (await client.query('Purchase Order', filters)).map(p => String(p.name));
    const first = await client.createDraft(doc, key);
    if (!['uncertain', 'done', 'deduped'].includes(first.status)) throw new Error('创建未完成：' + first.status);
    const fresh = (await client.query('Purchase Order', filters)).filter(p => !before.includes(String(p.name)));
    if (fresh.length !== 1) throw new Error('对账不唯一，保持未知并交人工');
    const name = String(fresh[0]!.name);
    const back = await client.get('Purchase Order', name);
    const lines = back.items as Record<string, unknown>[];
    const line = lines[0];
    if (back.supplier !== FACTS.supplier || numberField(back, 'docstatus') !== 0 || lines.length !== 1
      || !line || line.item_code !== FACTS.itemCode || numberField(line, 'qty') !== shortfall
      || numberField(line, 'rate') !== rate || line.warehouse !== warehouse)
      throw new Error('回查字段与计划不符，保留未知');
    if (!first.erpRef || first.erpRef.name !== name) throw new Error('候选单据无法与本次写入关联，不自动清理');
    made.push(name);
    const row = await rig.ledger.get(rig.principal, key);
    if (row?.state === 'uncertain' && row.leaseOwner) {
      // 显式对账结论；不重发写入，也不改写历史审计。
      await rig.ledger.succeed(rig.principal, key, row.leaseOwner, { doctype: 'Purchase Order', name });
    }
    const replay = await client.createDraft(doc, key);
    if (replay.status !== 'deduped') throw new Error('对账后的重放没有去重');
    let invoiceError = '';
    try { await client.query('Purchase Invoice', { supplier: FACTS.supplier }); }
    catch (e) { invoiceError = (e as Error).message; }
    if (!invoiceError.includes('DOCTYPE_NOT_PERMITTED')) throw new Error('发票权限结果不符合预期');
    const after = await client.query('Purchase Order');
    if (after.length !== baseline.length + 1) throw new Error('采购单增量不为一');
    const originalAfter = await client.get('Purchase Order', originalName);
    if (JSON.stringify(originalAfter) !== JSON.stringify(original)) throw new Error('原单变化');
    const binsAfter = await client.query('Bin', { item_code: FACTS.itemCode, warehouse });
    const supplierAfter = await client.get('Supplier', FACTS.supplier);
    if (JSON.stringify(binsAfter) !== JSON.stringify(bins) || JSON.stringify(supplierAfter) !== JSON.stringify(supplier))
      throw new Error('库存或供应商主数据发生变化');
    const audit = await rig.audit.byRun(rig.runId);
    if (audit.some(e => e.capability === 'erp.submit')) throw new Error('不应尝试提交');
    const reply = readFileSync(new URL('./reply.md', import.meta.url), 'utf8')
      .replaceAll('<RUN-ID>', rig.runId).replaceAll('<PUR-ORD-YYYY-NNNNN>', name)
      .replaceAll('<UNTRUSTED-SOURCES>', sources.join('、') || '未读取到自由文本');
    // 模板中的课程数字必须与本次观测一致，否则不发布该模板。
    if (originalName !== FACTS.originalPo || onHand !== 40 || shortfall !== 20 || rate !== 70
      || warehouse !== FACTS.warehouse) throw new Error('本次事实与课程答复模板不符');
    mkdirSync('reports/capstone', { recursive: true });
    writeFileSync('reports/capstone/reply.md', reply);
    writeFileSync('reports/capstone/evidence.json', JSON.stringify({ runId: rig.runId, first, replay,
      key, draft: back, invoiceError, untrustedSources: sources, audit,
      baselineCount: baseline.length, afterCount: after.length }, null, 2) + '\n');
    console.log(reply);
    console.log(`采购单 ${baseline.length} → ${after.length}；首次 ${first.status}；对账后重放 ${replay.status}`);
  } finally {
    // mock 清理只按本轮回查确认的确切单号；真实 ERP 不在此入口运行。
    for (const name of made) rig.mock?.removeExact(rig.site, 'Purchase Order', name);
    const remaining = await client.query('Purchase Order');
    console.log(`清理后采购单 ${remaining.length} 张`);
    rig.cleanup();
  }
}
