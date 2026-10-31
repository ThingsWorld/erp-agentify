// 工具面（Task 02）。Agent 只能碰这四个工具，没有第五个。
//
// 这一层做三件事，做完才把请求交给 Gateway：
//   1. 工具名 → 能力的固定映射。**没有** erp_call(doctype, method, args) 这种万能工具。
//   2. 参数 schema 校验（tool-schema.ts）。DocType 是受控参数，不是任意地址。
//   3. 明确的错误码。调用方按 code 分支，不要去 match 文案。
//
// TODO（task-02）：两个洞。
//   ① TOOL_REGISTRY 里多了一个 erp_call —— 收 doctype 和 method 两个自由参数。
//      「一次写完、什么都能干」听着方便，但它把整个 ERP 的地址空间交出去了。
//      scripts/scan-passthrough.mjs 会静态查这个形状。
//   ② Tools.call() 遇到不认识的工具名，现在照样往下转发。
//      判据看的是「审计里一条都没有」，不是「审计里有一条 denied」——
//      网关拒了也算你漏了，因为请求已经从这一层出去了。

import { Capability, CallResult, DenyCode, DocType, TOOL_DOCTYPES } from './types.js';
import {
  DENY_BY_TOOL_CODE, ToolCheckResult, validateToolArgs,
} from './tool-schema.js';

/** 工具名 → 能力。**这张表是常量，运行时不接受修改。** */
export const TOOL_REGISTRY: Readonly<Record<string, Capability>> = Object.freeze({
  erp_query_documents: 'erp.query',
  erp_get_document: 'erp.get',
  erp_create_purchase_order_draft: 'erp.create_draft',
  erp_submit_document: 'erp.submit',
});

export type ToolName = keyof typeof TOOL_REGISTRY;

/**
 * 工具面认识的 DocType。**字面量常量**，不由任何运行时数据推导。
 *
 * 多出来的 Purchase Invoice 是故意留的越权靶子：工具收得下这个参数，
 * policy 那层按 persona 拒，审计里留一条 outcome='denied'。
 * 宿主字段里的文字改不动这张表 —— 白名单一旦能被宿主数据影响，注入就等于提权。
 */
export const DOCTYPE_ALLOWLIST: readonly DocType[] = Object.freeze([
  'Purchase Order',
  'Purchase Invoice',
  'Item',
  'Bin',
  'Supplier',
] as DocType[]);

// 白名单与 types.ts 的 DocType 联合类型必须逐项对齐。
// 有人只改了一边就在加载时炸掉，别拖到运行时才发现两张表不一样。
if (DOCTYPE_ALLOWLIST.length !== TOOL_DOCTYPES.length
  || TOOL_DOCTYPES.some((d) => !DOCTYPE_ALLOWLIST.includes(d))) {
  throw new Error('DOCTYPE_ALLOWLIST 与 types.ts 的 TOOL_DOCTYPES 对不上，两边要一起改');
}

/** 给 Agent 与风控看的工具清单。正好四条，一条一个能力。 */
export interface ToolDef {
  readonly name: ToolName;
  readonly capability: Capability;
  readonly summary: string;
}

export const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'erp_query_documents' as ToolName,
    capability: 'erp.query' as Capability,
    summary: '按等值条件列出某一类单据',
  }),
  Object.freeze({
    name: 'erp_get_document' as ToolName,
    capability: 'erp.get' as Capability,
    summary: '按单号读一张单据',
  }),
  Object.freeze({
    name: 'erp_create_purchase_order_draft' as ToolName,
    capability: 'erp.create_draft' as Capability,
    summary: '建一张采购单草稿（docstatus=0）',
  }),
  Object.freeze({
    name: 'erp_submit_document' as ToolName,
    capability: 'erp.submit' as Capability,
    summary: '提交一张单据。不可逆，需要审批凭证',
  }),
]);

export function isToolName(n: string): n is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, n);
}

/**
 * 一次工具调用的完整校验：工具名 + 参数。
 *
 * **在 gateway.call() 之前跑完。** 返回 ok:false 的那一次不该有任何出站请求，
 * 审计里也不该多出一条 —— 判据看的是「审计里一条都没有」，不是「有一条 denied」。
 */
export function validateToolCall(tool: string, args: unknown): ToolCheckResult {
  if (typeof tool !== 'string' || !isToolName(tool))
    return { ok: false, code: 'UNKNOWN_TOOL', field: 'tool', message: '没有名为 "' + String(tool) + '" 的工具' };
  const cap = TOOL_REGISTRY[tool];
  if (cap === undefined)
    return { ok: false, code: 'UNKNOWN_TOOL', field: 'tool', message: '没有名为 "' + String(tool) + '" 的工具' };
  return validateToolArgs(cap, args);
}

export interface ToolCall {
  tool: string;
  args: unknown;
  idempotencyKey?: string;
  approvalToken?: string;
}

/** Gateway 的调用面。tools 只依赖这个最小接口，方便测试注入。 */
export interface GatewayPort {
  call(
    bearer: string | undefined,
    req: { capability: Capability; args: Record<string, unknown>; idempotencyKey?: string; approvalToken?: string },
    runId: string,
  ): Promise<CallResult>;
}

function denied(code: DenyCode, reason: string): CallResult {
  return { status: 'denied', code, reason };
}

export class Tools {
  constructor(private gw: GatewayPort, private bearer: string) {}

  /**
   * 调一个工具。
   *
   * 未知工具名、白名单外的 DocType、缺字段、多字段 —— 都在这里当场拒，**不转发**。
   * 这一条是 task-02 的核心断言：判的是审计里一条都没有，不是审计里有一条 denied。
   */
  async call(c: ToolCall, runId: string): Promise<CallResult> {
    const v = validateToolCall(c.tool, c.args);
    if (!v.ok) {
      return denied(DENY_BY_TOOL_CODE[v.code], `${v.field}: ${v.message}`);
    }

    const req: Parameters<GatewayPort['call']>[1] = { capability: v.capability, args: v.args };
    if (c.idempotencyKey !== undefined) req.idempotencyKey = c.idempotencyKey;
    if (c.approvalToken !== undefined) req.approvalToken = c.approvalToken;
    return this.gw.call(this.bearer, req, runId);
  }

  /** 给 Agent 看的工具清单。只有名字和一句话，不暴露内部映射。 */
  static describe(): { name: string; summary: string }[] {
    return TOOLS.map((t) => ({ name: t.name, summary: t.summary }));
  }
}
