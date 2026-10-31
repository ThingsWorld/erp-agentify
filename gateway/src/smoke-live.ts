// 真 ERPNext 冒烟。跑 Task 00 / 01 / 05 / 06 / 07 / 09 的代表性路径。
//
//   ERP_MODE=live ERP_USER=... ERP_PASSWORD=... npm run smoke:live
//
// 五条纪律，一条都不能松：
//   1. **先评价，再清理。** 清完就查不到了。
//   2. **只按本次审计里的确切 erpName 删。** 禁止按时间窗口、supplier、
//      schedule_date、owner 批量删 —— 那会连种子和别人的单一起删掉（真发生过）。
//   3. **种子单据一张都不动。** PUR-ORD-2026-00001 尤其。
//   4. **失败也要清理。** finally 里跑，不管前面炸没炸。
//   5. **凭据不落盘、不打印。** 只从环境变量读。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLiveRig, Rig } from './harness.js';
import { GatewayClient } from './gateway-client.js';
import { createCorrectionDraft, buildDraftDoc, gatherFacts } from './agent/create-draft.js';
import { draftKey } from './idempotency-key.js';
import { FACTS, DocType } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PO: DocType = 'Purchase Order';
/** 种子单据。任何情况下都不删。 */
const SEED_NAMES = new Set([
  'PUR-ORD-2026-00001', 'PUR-ORD-2026-00002', 'PUR-ORD-2026-00004',
  'PUR-ORD-2026-00008', 'PUR-ORD-2026-00009', 'PUR-ORD-2026-00010',
]);

interface StepResult { id: string; label: string; ok: boolean; detail: string }
const steps: StepResult[] = [];
function record(id: string, label: string, ok: boolean, detail: string) {
  steps.push({ id, label, ok, detail });
  console.log((ok ? '[OK] ' : '[X]  ') + label.padEnd(34) + detail);
}

async function countPO(rig: Rig): Promise<number> {
  const rows = await rig.erp.list(rig.site, rig.principal.persona.name, PO, {});
  return rows.length;
}

const work = mkdtempSync(join(tmpdir(), 'w12-live-'));
let rig: Rig | null = null;
/** 本次运行建出来的单号。清理只看这个集合。 */
const mine = new Set<string>();

try {
  rig = makeLiveRig({ runId: 'live-smoke-' + Date.now(), workDir: work });
  const client = new GatewayClient(rig.tools, rig.runId);
  console.log('site ' + rig.site + ' · runId ' + rig.runId + '\n');

  // ── Task 00：基线 ────────────────────────────────────────────
  const before = await countPO(rig);
  record('task-00', '基线采购单张数', before === FACTS.baselinePurchaseOrders,
    before + ' 张（期望 ' + FACTS.baselinePurchaseOrders + '）');

  // ── Task 01：真实权限读取 ────────────────────────────────────
  const facts = await gatherFacts(client);
  record('task-01-bin', '库存读到真值', facts.onHandQty === FACTS.onHandQty,
    'ITEM-SHELF-01 @ ' + FACTS.warehouse + ' actual_qty=' + facts.onHandQty);
  record('task-01-po', '原单读到真值',
    facts.originalPo === FACTS.originalPo && facts.orderedQty === FACTS.orderedQty,
    facts.originalPo + ' qty=' + facts.orderedQty + ' rate=' + facts.rate);
  // persona 白名单里没有 Purchase Invoice —— 工具收得下，policy 该拒。
  const inv = await rig.tools.call({ tool: 'erp_query_documents', args: { docType: 'Purchase Invoice', filters: {} } }, rig.runId);
  record('task-01-denied', '越权 DocType 被拒且留审计',
    inv.status === 'denied' && inv.code === 'DOCTYPE_NOT_PERMITTED',
    'status=' + inv.status + ' code=' + inv.code);

  // ── Task 05：建正确的草稿 ────────────────────────────────────
  const out = await createCorrectionDraft(client);
  if (out.result.erpRef) mine.add(out.result.erpRef.name);
  record('task-05-shortfall', '缺口算对', out.plan.shortfall === 20,
    FACTS.requiredQty + ' − ' + facts.onHandQty + ' = ' + out.plan.shortfall);
  record('task-05-draft', '草稿建成且 docstatus=0',
    out.result.status === 'done' && out.result.docstatus === 0,
    (out.result.erpRef?.name ?? '-') + ' docstatus=' + out.result.docstatus);
  // 从 ERP 重查，不信回执
  if (out.result.erpRef) {
    const doc = await rig.erp.get(rig.site, rig.principal.persona.name, PO, out.result.erpRef.name);
    const items = doc.items as Record<string, unknown>[];
    const line = items?.[0] ?? {};
    record('task-05-requery', '回查确认 qty/warehouse',
      Number(line.qty) === 20 && line.warehouse === FACTS.warehouse && Number(doc.docstatus) === 0,
      'qty=' + line.qty + ' warehouse=' + line.warehouse + ' docstatus=' + doc.docstatus);
  }

  // ── Task 06：并发幂等 ────────────────────────────────────────
  const doc = buildDraftDoc({ ...out.plan, shortfall: 7 });
  const key = draftKey({ intent: 'live-smoke-concurrency', supplier: FACTS.supplier,
                         itemCode: FACTS.itemCode, qty: 7, batch: rig.runId });
  const c0 = await countPO(rig);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    rig!.tools.call({ tool: 'erp_create_purchase_order_draft',
      args: { docType: PO, doc }, idempotencyKey: key }, rig!.runId)));
  for (const r of results) if (r.erpRef) mine.add(r.erpRef.name);
  const c1 = await countPO(rig);
  const doneCount = results.filter((r) => r.status === 'done').length;
  record('task-06', '20 并发只建一张', c1 - c0 === 1 && doneCount === 1,
    '新增 ' + (c1 - c0) + ' 张 · done=' + doneCount
      + ' · in_flight/deduped=' + (results.length - doneCount));

  // ── Task 07：写后回查 / uncertain ────────────────────────────
  // live 没法注入「响应丢失」，但可以验它的另一半：docstatus 与预期不符 → uncertain。
  // 拿一张已提交的种子单去 create_draft 是不成立的，所以这里验的是
  // 「提交没有审批凭证被拒」+「台账里没有留下悬空的 executing 行」。
  const noAppr = await rig.tools.call({ tool: 'erp_submit_document',
    args: { docType: PO, name: out.result.erpRef?.name ?? FACTS.originalPo },
    idempotencyKey: 'live-smoke-submit-' + rig.runId }, rig.runId);
  record('task-07-floor', '无审批凭证提交被拒',
    noAppr.status === 'denied' && noAppr.code === 'APPROVAL_REQUIRED',
    'status=' + noAppr.status + ' code=' + noAppr.code);
  const uncertain = await rig.ledger.listUncertain();
  record('task-07-ledger', '台账没有悬空的 uncertain', uncertain.length === 0,
    uncertain.length + ' 条待对账');

  // ── Task 09：审计双向 ────────────────────────────────────────
  const entries = await rig.audit.byRun(rig.runId);
  const writes = entries.filter((e) => e.capability === 'erp.create_draft' && e.outcome === 'done');
  const submits = entries.filter((e) => e.capability === 'erp.submit' && e.outcome === 'done');
  record('task-09-audit-fwd', '正向：run → 单据', writes.length >= 1,
    entries.length + ' 条审计，其中成功写 ' + writes.length + ' 次');
  if (writes[0]?.erpName) {
    const back = await rig.audit.byErpRef({ doctype: PO, name: writes[0].erpName });
    record('task-09-audit-rev', '反向：单据 → run',
      back.length > 0 && back[0]!.runId === rig.runId,
      writes[0].erpName + ' → runId ' + back[0]?.runId);
  }
  record('task-09-no-submit', '全程没有成功的 submit', submits.length === 0,
    submits.length + ' 次');

} catch (e) {
  record('fatal', '冒烟中断', false, (e as Error).message.slice(0, 160));
} finally {
  // ── 清理。**只删本次审计里明确记下的单号，且排除种子。** ──────
  const cleaned: string[] = [];
  if (rig) {
    try {
      const entries = await rig.audit.byRun(rig.runId);
      for (const e of entries) if (e.erpName && e.erpDoctype === PO) mine.add(e.erpName);
      for (const name of mine) {
        if (SEED_NAMES.has(name)) { cleaned.push(name + '=SKIP(seed)'); continue; }
        try {
          const d = await rig.erp.get(rig.site, rig.principal.persona.name, PO, name);
          if (Number(d.docstatus) === 1) await rig.erp.cancel(rig.site, rig.principal.persona.name, PO, name);
          await rig.erp.remove(rig.site, rig.principal.persona.name, PO, name);
          cleaned.push(name + '=deleted');
        } catch (err) { cleaned.push(name + '=FAILED:' + (err as Error).message.slice(0, 40)); }
      }
      const after = await countPO(rig);
      record('cleanup', '清理后回到基线', after === FACTS.baselinePurchaseOrders,
        after + ' 张 · 处理 ' + cleaned.length + ' 个：' + (cleaned.join(' ') || '无'));
    } catch (err) {
      record('cleanup', '清理失败', false, (err as Error).message.slice(0, 160));
    }
  }
  rmSync(work, { recursive: true, force: true });

  // 脱敏报告：不含 site 之外的任何连接信息，绝不含凭据。
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(join(ROOT, 'reports', 'live-smoke.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), steps, cleaned }, null, 2) + '\n', 'utf8');

  const failed = steps.filter((s) => !s.ok);
  console.log('\n' + steps.length + ' 项，失败 ' + failed.length + '。报告：reports/live-smoke.json');
  process.exit(failed.length ? 1 : 0);
}
