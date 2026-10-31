// Agent 侧的调用门面。Agent 只认这一个对象，不直接碰 Gateway 内部。
//
// 它做两件事：
//   1. 把结果里的 denied / uncertain 变成显式分支，逼调用方处理，而不是当成成功。
//   2. 把宿主读回来的自由文本包成 UntrustedText（Task 08）。

import { CallResult, DocType, ErpFilters, UntrustedText } from './types.js';
import { Tools, ToolCall } from './tools.js';
import { wrapDocument } from './untrusted.js';

export class GatewayClient {
  constructor(private tools: Tools, private runId: string) {}

  private async call(c: ToolCall): Promise<CallResult> {
    return this.tools.call(c, this.runId);
  }

  /** 列单据。返回的自由文本字段已经包成 UntrustedText。 */
  async query(docType: DocType, filters: ErpFilters = {}): Promise<Record<string, unknown>[]> {
    const r = await this.call({ tool: 'erp_query_documents', args: { docType, filters } });
    if (r.status !== 'done') throw new Error('查询被拒（' + r.code + '）：' + r.reason);
    return (r.data as Record<string, unknown>[]).map((d) => wrapDocument(docType, d));
  }

  async get(docType: DocType, name: string): Promise<Record<string, unknown>> {
    const r = await this.call({ tool: 'erp_get_document', args: { docType, name } });
    if (r.status !== 'done') throw new Error('读取被拒（' + r.code + '）：' + r.reason);
    return wrapDocument(docType, r.data as Record<string, unknown>);
  }

  /** 建草稿。**不会**自动重试 —— uncertain 要由调用方决定怎么办。 */
  async createDraft(doc: Record<string, unknown>, idempotencyKey: string): Promise<CallResult> {
    return this.call({
      tool: 'erp_create_purchase_order_draft',
      args: { docType: 'Purchase Order', doc }, idempotencyKey,
    });
  }

  /** 提交。不可逆，必须带审批凭证。 */
  async submit(name: string, idempotencyKey: string, approvalToken: string): Promise<CallResult> {
    return this.call({
      tool: 'erp_submit_document',
      args: { docType: 'Purchase Order', name }, idempotencyKey, approvalToken,
    });
  }
}

/** 从包装过的文档里取一个数值字段。UntrustedText 不参与计算，取到它就是用错了。 */
export function numberField(doc: Record<string, unknown>, field: string): number {
  const v = doc[field];
  if (typeof v === 'object' && v !== null && '__untrusted' in v)
    throw new Error('字段 ' + field + ' 是不可信文本，不能当数字用');
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('字段 ' + field + ' 不是数字：' + String(v));
  return n;
}

export function untrustedField(doc: Record<string, unknown>, field: string): UntrustedText | null {
  const v = doc[field];
  return (typeof v === 'object' && v !== null && '__untrusted' in v) ? (v as UntrustedText) : null;
}
