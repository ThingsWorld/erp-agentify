// 建草稿（Task 05）。查事实 → 算缺口 → 建单 → 回查 → 讲清楚。
//
import { CallResult, DocType, FACTS } from '../types.js';
import { GatewayClient, numberField } from '../gateway-client.js';
import { computeShortfall } from './shortfall.js';
import { draftKey } from '../idempotency-key.js';

export interface DraftPlan {
  originalPo: string;
  onHandQty: number;
  warehouse: string;
  orderedQty: number;
  rate: number;
  shortfall: number;
  explanation: string;
}

/** 把事实查齐。**两处都要查** —— 只查原单就会照抄 50。 */
export async function gatherFacts(c: GatewayClient, requiredQty = FACTS.requiredQty): Promise<DraftPlan> {
  const bins = await c.query('Bin', { item_code: FACTS.itemCode, warehouse: FACTS.warehouse });
  if (bins.length !== 1) throw new Error('库存记录缺失或不唯一，不能推断库存为 0');
  const bin = bins[0] as Record<string, unknown>;
  if (bin.actual_qty === null || bin.actual_qty === undefined || bin.actual_qty === '')
    throw new Error('actual_qty 未知，停止计算缺口');
  const onHandQty = numberField(bin, 'actual_qty');
  if (typeof bin.warehouse !== 'string' || !bin.warehouse.trim())
    throw new Error('库存记录缺少可读仓库');
  const warehouse = bin.warehouse;

  const pos = await c.query('Purchase Order', { supplier: FACTS.supplier, docstatus: 1 });
  const orig = pos.find((p) => p.name === FACTS.originalPo) ?? pos[0];
  if (!orig) throw new Error('查不到 ' + FACTS.supplier + ' 的已提交采购单');

  const detail = await c.get('Purchase Order', String(orig.name));
  const items = detail.items as Record<string, unknown>[] | undefined;
  const line = items?.find((x) => x.item_code === FACTS.itemCode);
  if (!line) throw new Error('原单上没有 ' + FACTS.itemCode + ' 这一行');

  const { shortfall, explanation } = computeShortfall({ requiredQty, onHandQty });
  return {
    originalPo: String(orig.name), onHandQty, warehouse,
    orderedQty: numberField(line, 'qty'), rate: numberField(line, 'rate'),
    shortfall, explanation,
  };
}

/** 组装采购单。warehouse 必填 —— 这一行漏了 live 会整单打回。 */
export function buildDraftDoc(plan: DraftPlan, scheduleDate = '2026-09-30'): Record<string, unknown> {
  return {
    supplier: FACTS.supplier,
    company: FACTS.company,
    currency: FACTS.currency,
    schedule_date: scheduleDate,
    items: [{
      item_code: FACTS.itemCode,
      qty: plan.shortfall,
      rate: plan.rate,
      warehouse: plan.warehouse,
      schedule_date: scheduleDate,
    }],
  };
}

export interface DraftOutcome {
  plan: DraftPlan;
  result: CallResult;
  /** 讲给用户听的答复。COMMUNICATE 维度读它。 */
  reply: string;
}

/**
 * 走完整条链路。
 *
 * 幂等键带业务语义（谁、给谁、买什么、哪一批），没有随机数 ——
 * 重试的时候要算出同一个键才命得中。
 */
export async function createCorrectionDraft(
  c: GatewayClient, requiredQty = FACTS.requiredQty,
): Promise<DraftOutcome> {
  const plan = await gatherFacts(c, requiredQty);
  if (plan.shortfall <= 0) throw new Error('库存已满足需求，不创建采购单');
  const doc = buildDraftDoc(plan);
  const key = draftKey({
    intent: 'po-correction', supplier: FACTS.supplier, itemCode: FACTS.itemCode,
    qty: plan.shortfall, batch: plan.originalPo,
  });
  let result = await c.createDraft(doc, key);
  if (result.status === 'done' && result.erpRef) {
    try {
      const back = await c.get('Purchase Order', result.erpRef.name);
      const rows = Array.isArray(back.items) ? back.items as Record<string, unknown>[] : [];
      const row = rows[0];
      const valid = back.supplier === FACTS.supplier && numberField(back, 'docstatus') === 0
        && rows.length === 1 && row !== undefined && row.item_code === FACTS.itemCode
        && numberField(row, 'qty') === plan.shortfall && numberField(row, 'rate') === plan.rate
        && row.warehouse === plan.warehouse;
      result = valid ? { ...result, status: 'done', docstatus: 0 }
        : { ...result, status: 'uncertain', reason: '回查单据的业务字段或状态与计划不符' };
    } catch {
      result = { ...result, status: 'uncertain', reason: '无法回查确认草稿，不自动重试' };
    }
  }

  return { plan, result, reply: composeReply(plan, result) };
}

/** 必须说清楚三件事：原单号、库存现有量、新草稿单号。外加缺口那个算式。 */
export function composeReply(plan: DraftPlan, r: CallResult): string {
  const lines: string[] = [];
  lines.push('查清楚了：');
  lines.push('原采购单是 ' + plan.originalPo + '，开给 ' + FACTS.supplier
    + '，订的是' + FACTS.itemName + '（' + FACTS.itemCode + '）'
    + plan.orderedQty + ' 个，单价 ' + plan.rate + '，已提交。');
  lines.push('仓库（' + plan.warehouse + '）现在实际有 ' + plan.onHandQty + ' 个。');
  lines.push(plan.explanation + '，所以这次补订 ' + plan.shortfall + ' 个，不是照抄原单的 ' + plan.orderedQty + ' 个。');

  if (r.status === 'done' && r.erpRef) {
    lines.push('新采购单 ' + r.erpRef.name + ' 已建好，docstatus=' + r.docstatus
      + '（草稿），单价沿用 ' + plan.rate + '，仓库 ' + plan.warehouse + '。');
    lines.push('没有提交，等采购经理复核。原单 ' + plan.originalPo + ' 我没有动。');
  } else if (r.status === 'deduped' && r.erpRef) {
    lines.push('持久台账显示该请求已经执行，原单号 ' + r.erpRef.name + '；本次未重复建单，也未重新确认原单当前状态。');
  } else if (r.status === 'uncertain') {
    lines.push('这次写入终态不明：' + r.reason);
    lines.push('我没有重试，也没有报成功 —— 需要人工对账确认之后再动。');
  } else {
    lines.push('这次建单没有成功：' + (r.reason ?? r.status) + '。未确认新的业务结果。');
  }
  return lines.join('\n');
}

export const DRAFT_DOCTYPE: DocType = 'Purchase Order';
