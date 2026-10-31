// ERP Gateway 的领域类型 —— 这个文件是**接口冻结点**。
//
// 所有模块都编译到这里的类型。你可以往里加字段，但不要删、不要改语义
// （改了会触发 af-modified-tests，见 PROJECT.md §8.5）。
//
// 四条设计前提，贯穿整个项目：
//   1. Gateway 是运行时 FLOOR。评分只做验证，不在调用路径上。
//   2. 学员沙箱只持有短期平台令牌，永远拿不到 ERP 服务账号密码。
//   3. 身份 / site / persona 全部由服务端从令牌解析，请求体里的同名字段一律**拒绝**。
//   4. 「回执说成功」和「宿主终态确认」是两件事。

// ── 能力面（Task 02）──────────────────────────────────────────────
/** 学员的沙箱能调的能力。刻意窄 —— DocType 是参数，不是端点。 */
export type Capability = 'erp.query' | 'erp.get' | 'erp.create_draft' | 'erp.submit';

export const CAPABILITIES: readonly Capability[] =
  ['erp.query', 'erp.get', 'erp.create_draft', 'erp.submit'] as const;

/**
 * 工具面认识的 DocType。**五项**。
 * `Purchase Invoice` 是故意留的越权靶子：工具收得下这个参数，
 * policy 那层按 persona 拒（persona 只有四项），审计里要留一条 outcome='denied'。
 */
export type DocType =
  | 'Purchase Order' | 'Purchase Invoice' | 'Item' | 'Bin' | 'Supplier';

export const TOOL_DOCTYPES: readonly DocType[] =
  ['Purchase Order', 'Purchase Invoice', 'Item', 'Bin', 'Supplier'] as const;

/** persona 实际有权限的四项。 */
export const PERSONA_DOCTYPES: readonly DocType[] =
  ['Purchase Order', 'Item', 'Bin', 'Supplier'] as const;

// ── 副作用画像（Task 04）─────────────────────────────────────────
/** 四个**正交**属性。不是四档等级 —— 一个操作可以 external 且 irreversible 却不动钱。 */
export interface EffectProfile {
  channel: 'read' | 'write_local' | 'exec' | 'external';
  irreversible: boolean;   // 过了这一步能不能自己撤回
  touchesMoney: boolean;   // 涉不涉及金额
  changesPayee: boolean;   // 换不换供应商 / 收款人
}

/** 运行时 FLOOR：学员的映射表只能在此之上**收紧**，不能放松。 */
export const FLOOR: Readonly<Record<Capability, EffectProfile>> = Object.freeze({
  'erp.query':        Object.freeze({ channel: 'read',     irreversible: false, touchesMoney: false, changesPayee: false }),
  'erp.get':          Object.freeze({ channel: 'read',     irreversible: false, touchesMoney: false, changesPayee: false }),
  'erp.create_draft': Object.freeze({ channel: 'external', irreversible: false, touchesMoney: true,  changesPayee: false }),
  'erp.submit':       Object.freeze({ channel: 'external', irreversible: true,  touchesMoney: true,  changesPayee: false }),
});

// ── 身份（Task 03）───────────────────────────────────────────────
/**
 * 服务端解析出来的调用主体。
 * ⚠ 只能由 Identity.resolve() 从平台令牌生成。任何从请求体读 learnerId /
 * email / role / site / erpUser 的代码都是漏洞。
 */
export interface Principal {
  learnerId: string;
  siteId: string;
  persona: ErpPersona;
}

/** 受限 ERP persona。凭据字段刻意不在这里 —— 只在 Gateway 的凭据解析器内部出现。 */
export interface ErpPersona {
  name: string;
  allowedDocTypes: readonly DocType[];
}

/** 请求体里出现下列任一字段 → 直接拒（不是忽略）。 */
export const SPOOFABLE_FIELDS: readonly string[] = [
  'learnerId', 'learner_id', 'email', 'role', 'roles',
  'siteId', 'site', 'site_id', 'erpUser', 'erp_user', 'user', 'persona',
] as const;

// ── 调用（Task 02 / 04）──────────────────────────────────────────
export interface CallRequest {
  capability: Capability;
  args: Record<string, unknown>;
  /** 学员自己算的业务语义幂等键。写操作必填。 */
  idempotencyKey?: string;
  /** 高危写必须携带。由审批服务签发，学员伪造不了。 */
  approvalToken?: string;
}

export type CallStatus =
  | 'done'       // 执行完成**且回查确认**
  | 'deduped'    // 幂等命中，返回上次结果
  | 'uncertain'  // 写可能发生了但终态对不上 —— 必须人工对账
  | 'denied'     // FLOOR 拒绝
  | 'in_flight'; // 同一个键正在被另一次调用执行

export interface CallResult {
  status: CallStatus;
  erpRef?: ErpRef;
  docstatus?: number;
  data?: unknown;
  reason?: string;
  /** 机器可判的拒绝原因。学员的错误处理按它分支，不要按 reason 的文案。 */
  code?: DenyCode;
  auditId?: string;
}

export type DenyCode =
  | 'UNKNOWN_CAPABILITY' | 'UNKNOWN_DOCTYPE' | 'DOCTYPE_NOT_PERMITTED'
  | 'SPOOFED_IDENTITY' | 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED_TOKEN'
  | 'MISSING_IDEMPOTENCY_KEY' | 'APPROVAL_REQUIRED' | 'APPROVAL_INVALID'
  | 'BAD_ARGS' | 'CROSS_SITE';

/** 宿主侧主键。审计与幂等台账都靠它跟 ERP 关联。 */
export interface ErpRef { doctype: string; name: string }

// ── 幂等台账（Task 06 / 07）──────────────────────────────────────
//
//   (none) --reserve--> reserved --begin--> executing --+--> succeeded
//                          ^                            +--> uncertain
//                          |                            +--> failed
//                          +---- lease 过期由回收器领回 ----+
//
// 唯一索引不够：它挡得住「两条记录」，挡不住「一条记录被两个进程同时当成新的」。
// reserve 必须是「原子占位 + 拿租约」，不是 check-then-set。

export type LedgerState = 'reserved' | 'executing' | 'succeeded' | 'uncertain' | 'failed';

export interface LedgerRow {
  learnerId: string;
  siteId: string;
  key: string;
  capability: Capability;
  state: LedgerState;
  leaseUntil: number | null;
  leaseOwner: string | null;
  erpRef: ErpRef | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export type ReserveOutcome =
  | { outcome: 'acquired';  row: LedgerRow }
  | { outcome: 'duplicate'; row: LedgerRow }
  | { outcome: 'in_flight'; row: LedgerRow }
  | { outcome: 'recovered'; row: LedgerRow };

export interface Ledger {
  /** 原子占位。同一 (learnerId, siteId, key) 只可能有一个持有者。 */
  reserve(p: Principal, key: string, cap: Capability, owner: string, leaseMs: number): Promise<ReserveOutcome>;
  begin(p: Principal, key: string, owner: string): Promise<void>;
  succeed(p: Principal, key: string, owner: string, ref: ErpRef): Promise<void>;
  markUncertain(p: Principal, key: string, owner: string, ref: ErpRef | null): Promise<void>;
  fail(p: Principal, key: string, owner: string): Promise<void>;
  get(p: Principal, key: string): Promise<LedgerRow | null>;
  /** 对账用：列出所有需要人工处理的行。 */
  listUncertain(): Promise<LedgerRow[]>;
}

// ── 审计（Task 08）──────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  learnerId: string;
  siteId: string;
  runId: string;
  approvalId: string | null;
  idempotencyKey: string | null;
  capability: Capability;
  argsDigest: string;
  erpDoctype: string | null;
  erpName: string | null;
  docstatus: number | null;
  /** 回查确认的时刻；null = 没确认上。 */
  verifiedAt: number | null;
  outcome: CallStatus;
  createdAt: number;
}

export interface AuditLedger {
  /** append-only。没有 update，也没有 delete。 */
  append(e: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry>;
  /** 正向：一次 run 在 ERP 里留下了什么。 */
  byRun(runId: string): Promise<AuditEntry[]>;
  /** 反向：一张单据是哪次 run、哪个工具、谁批的。 */
  byErpRef(ref: ErpRef): Promise<AuditEntry[]>;
}

// ── ERP 客户端（凭据只在 Gateway 内部）──────────────────────────
export interface ErpFilters { [field: string]: unknown }

export interface ErpClient {
  list(site: string, persona: string, dt: DocType, filters?: ErpFilters): Promise<Record<string, unknown>[]>;
  get(site: string, persona: string, dt: DocType, name: string): Promise<Record<string, unknown>>;
  insert(site: string, persona: string, dt: DocType, doc: Record<string, unknown>): Promise<ErpRef>;
  submit(site: string, persona: string, dt: DocType, name: string): Promise<ErpRef>;
  /** 清理用：作废一张已提交的单。reset 走这条，学员的能力面里没有它。 */
  cancel(site: string, persona: string, dt: DocType, name: string): Promise<void>;
  /** 清理用：按**确切单号**删。禁止按时间窗口或业务字段批删。 */
  remove(site: string, persona: string, dt: DocType, name: string): Promise<void>;
}

// ── 不可信数据（Task 08）────────────────────────────────────────
/**
 * 宿主自由文本的包装。ERP 里的字符串永远是数据，不是指令。
 * 拿到 UntrustedText 的代码不能把 .value 直接拼进 prompt。
 */
export interface UntrustedText {
  readonly __untrusted: true;
  /** 来源三元组，出问题时能追到是哪张单的哪个字段。 */
  readonly source: { doctype: string; name: string; field: string };
  /** 原文。只允许展示与存档，不允许当指令执行。 */
  readonly value: string;
}

// ── mock 的观测与控制面（Task 00 / 06 / 07，evaluator 也用）──────
export interface FaultSwitches {
  /** 落库成功但回执抛错。触发一次后自动复位。 */
  insertThenThrowOnce?: boolean;
  /** 回查时把 docstatus 换成这个值。触发一次后自动复位。 */
  corruptDocstatusOnce?: number;
  /** 延迟一次。when='after_effect' 表示副作用已发生才延迟。 */
  delayOnce?: { op: 'insert' | 'submit' | 'get'; ms: number; when: 'before_effect' | 'after_effect' };
}

export interface RecordedCall {
  site: string;
  persona: string;
  op: 'list' | 'get' | 'insert' | 'submit' | 'cancel' | 'remove';
  doctype: string;
  name?: string;
  at: number;
}

/** mock 专有的控制面。真实 adapter 不实现它 —— 这是两者唯一的差别。 */
export interface MockControl {
  /** 回到场景初始状态（所有 site）。 */
  reset(): void;
  /** 只重置一个 site。 */
  resetSite(site: string): void;
  /** 按**确切单号**删。找不到不报错。 */
  removeExact(site: string, dt: DocType, name: string): boolean;
  /** 本次进程内的调用流水。判据用它看「有没有越出四个 capability」。 */
  calls(): readonly RecordedCall[];
  setFaults(f: FaultSwitches): void;
  /** 只读快照，evaluator 回查用。 */
  snapshot(site: string, dt: DocType): Record<string, unknown>[];
}

// ── 错误 ───────────────────────────────────────────────────────
export class DeniedError extends Error {
  constructor(message: string, readonly code: DenyCode = 'BAD_ARGS') {
    super(message);
    this.name = 'DeniedError';
  }
}
export class UpstreamError extends Error {
  constructor(message: string, readonly effectMayHaveHappened = false) {
    super(message);
    this.name = 'UpstreamError';
  }
}

// ── 任务事实（全项目唯一来源，与 context-pack.md 对齐）──────────
export const FACTS = Object.freeze({
  originalPo: 'PUR-ORD-2026-00001',
  originalPoDocstatus: 1,
  supplier: 'Globex',
  itemCode: 'ITEM-SHELF-01',
  itemName: '钢制货架 Steel Shelving Unit',
  orderedQty: 50,
  rate: 70,
  onHandQty: 40,
  warehouse: 'Stores - ADC',
  requiredQty: 60,
  company: 'Agentify Demo Co',
  currency: 'USD',
  /** 基线采购单张数。与 tasks/_SPINE.yaml 的 baseline_purchase_order_count 一致。 */
  baselinePurchaseOrders: 6,
} as const);

/** 缺口 = 需求 − 现有。必须真的去查库存才算得出来。 */
export const EXPECTED_SHORTFALL = FACTS.requiredQty - FACTS.onHandQty; // 20
