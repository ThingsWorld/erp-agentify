// 写后对账（Task 07）。
//
// 场景：写请求发出去了，ERP 那边成功了，但响应在路上丢了。
// 这时候你**没有单号** —— 单号是响应带回来的。所以只能按**业务引用**回查。
//
// 不能做的两件事：
//   · 直接重试 —— 会建出第二张单。
//   · 报 done —— 你并不知道它成没成。
//
// 正确的动作是标 uncertain，然后回查；查得到就把单号补上，查不到才是 failed。

import { DocType, ErpClient, ErpFilters, ErpRef, Principal } from './types.js';

/**
 * 能唯一定位这次写入的业务字段。
 *
 * 选这几个是因为它们**在请求里就已经确定**，不依赖响应：
 * supplier 是你填的，schedule_date 是你填的，bill_no 是你填的。
 * 单号不在这里 —— 丢响应的时候它还不存在。
 */
export const BUSINESS_REF_FIELDS: readonly string[] = ['supplier', 'bill_no', 'schedule_date'] as const;

export function businessProbe(doc: Record<string, unknown>): ErpFilters {
  const filters: ErpFilters = {};
  for (const field of BUSINESS_REF_FIELDS) {
    const value = doc[field];
    if ((typeof value === 'string' && value.trim() !== '') ||
        (typeof value === 'number' && Number.isFinite(value))) filters[field] = value;
  }
  return filters;
}

export interface ReconcileInput {
  erp: ErpClient;
  principal: Principal;
  docType: DocType;
  /** 原本要写进去的那份 doc。回查条件从它来。 */
  doc: Record<string, unknown>;
  /** 这次运行之前就已经存在的单号。用来把「我写的」和「本来就有的」分开。 */
  knownBefore: readonly string[];
}

export interface ReconcileResult {
  /** 查到了这次写入留下的单据。 */
  found: ErpRef | null;
  /** 命中的候选数。>1 说明业务引用不够唯一，要报人工。 */
  candidates: number;
  reason: string;
  /** 只有成功查询且排除运行前记录后为空，才能确认未落库。 */
  confirmedAbsent?: boolean;
}

/**
 * 按业务引用回查宿主，判断「到底写没写进去」。
 *
 * 关键在 knownBefore：同一个供应商同一个计划日期，种子里本来就可能有单。
 * 不排掉运行前已存在的，你会把别人的单认成自己的。
 */
export async function reconcile(i: ReconcileInput): Promise<ReconcileResult> {
  const probe = businessProbe(i.doc);
  if (Object.keys(probe).length === 0)
    return { found: null, candidates: 0, reason: 'doc 里没有可回查的业务字段，这次写入无法对账' };

  let rows: Record<string, unknown>[];
  try {
    rows = await i.erp.list(i.principal.siteId, i.principal.persona.name, i.docType, probe);
  } catch (e) {
    return { found: null, candidates: 0, reason: '回查本身失败：' + (e as Error).message };
  }

  const fresh = rows.filter((r) => typeof r.name === 'string' && !i.knownBefore.includes(r.name));

  if (fresh.length === 0)
    return { found: null, candidates: 0, confirmedAbsent: true, reason: '宿主里没有本次写入留下的记录，判定为未落库' };
  if (fresh.length > 1)
    return {
      found: null, candidates: fresh.length,
      reason: '业务引用命中 ' + fresh.length + ' 张，不唯一，需要人工对账',
    };

  const only = fresh[0] as Record<string, unknown> & { name: string };
  const expectedItems = Array.isArray(i.doc.items) ? i.doc.items as Record<string, unknown>[] : [];
  const actualItems = Array.isArray(only.items) ? only.items as Record<string, unknown>[] : [];
  const fields = ['item_code', 'qty', 'rate', 'warehouse'];
  const matches = expectedItems.length === actualItems.length && expectedItems.every((expected, n) =>
    fields.every(field => expected[field] === actualItems[n]?.[field]));
  if (!matches || Number(only.docstatus) !== 0)
    return { found: null, candidates: 1, reason: '候选单据的物料、数量、价格、仓库或草稿状态不符，需人工对账' };
  return { found: { doctype: i.docType, name: only.name }, candidates: 1, reason: '回查到一张，补上单号' };
}
