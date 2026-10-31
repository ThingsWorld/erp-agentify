// evaluator 的类型面。把 evaluator/CONTRACT.md 从文档变成可执行的形状。
//
// 三件事在这里定死，别处不再重复定义：
//   1. 九种 CheckKind —— 前四种沿用 lab-factory 的 RubricCheckKind，
//      后五种是这一课多出来的（回查宿主、查审计、禁副作用、维度门槛、安全 gate）。
//   2. 每一维只认哪一种证据（CONTRACT §2.1 那张表）。这条在 runner 的构建期强制。
//   3. 报告的字段。课上要能指着报告说「你这次是 COMMUNICATE 掉的，不是业务做错了」，
//      所以每一条都留 expected / actual / failure_reason，不是 0/1。
//
// 这里不放任何 hidden 断言的期望值。公开那部分的期望值（缺口 20、库存 40 之类）
// 写在 checks/ 下，且都是 context-pack.md 已经公开过的数字。

import { AuditEntry, Capability, CallStatus, DocType, ErpRef, LedgerRow } from '../src/types.js';

// ── 维度 ────────────────────────────────────────────────────────
export type Dimension = 'BUSINESS_STATE' | 'COMMUNICATE' | 'SAFETY' | 'AUDIT';

export const DIMENSIONS: readonly Dimension[] =
  ['BUSINESS_STATE', 'COMMUNICATE', 'SAFETY', 'AUDIT'] as const;

/**
 * 证据来源。
 *
 * 前四种是 CONTRACT §7.1 的 enum，hidden 与公开两侧都用。
 * `file` / `command` 只出现在**降级出来的**公开 check 上（§1.3 那张降级表）——
 * 它们判的是文件和退出码，跟宿主状态无关，所以不进 §2.1 那张表的管辖。
 */
export type EvidenceSource =
  | 'erp_requery' | 'audit_log' | 'transcript' | 'ledger' | 'file' | 'command';

/** CONTRACT §7.1 的 enum，序列化成合约形状时只允许这四个。 */
export const CONTRACT_EVIDENCE: readonly EvidenceSource[] =
  ['erp_requery', 'audit_log', 'transcript', 'ledger'] as const;

/**
 * 每一维**唯一允许**的证据来源（CONTRACT §2.1）。
 *
 * SAFETY 和 BUSINESS_STATE 不许碰 transcript：transcript 是被判的那一方写的，
 * 审计和宿主状态不是。把安全判据搭在自述上，等于让被管的人提供管他的证据。
 */
export const ALLOWED_EVIDENCE: Readonly<Record<Dimension, readonly EvidenceSource[]>> = Object.freeze({
  BUSINESS_STATE: ['erp_requery'],
  COMMUNICATE: ['transcript'],
  SAFETY: ['audit_log'],
  AUDIT: ['audit_log', 'erp_requery'],
});

// ── 九种 check ──────────────────────────────────────────────────
/**
 * 前四种的语义照抄 lab-factory 的 runCheck，不能按想当然改：
 *   file_exists       读不到文件就算不存在
 *   file_contains     文件不存在直接 false；正则**不带 flags**
 *   command_exit_zero 只看 exitCode === 0，stdout 不参与判定
 *   transcript_regex  对 transcript 跑同一个正则
 *
 * 后五种：
 *   host_state            evaluator 自己连宿主回查到的终态
 *   audit_query           查 Gateway 写的审计
 *   forbidden_side_effect 判「不该发生的事有没有发生」，与 host_state 反着来
 *   dimension_score       某一维的分数够不够。第一轮判据折完才能算
 *   safety_gate           安全门槛过没过。整次判定的开关
 */
export type CheckKind =
  | 'file_exists' | 'file_contains' | 'command_exit_zero' | 'transcript_regex'
  | 'host_state' | 'audit_query' | 'forbidden_side_effect'
  | 'dimension_score' | 'safety_gate';

/** 依赖已折算维度分的两种 check。它们跑在第二轮。 */
export const META_KINDS: readonly CheckKind[] = ['dimension_score', 'safety_gate'] as const;

export function isMetaKind(k: CheckKind): boolean {
  return META_KINDS.includes(k);
}

/** 判据自己给出的观测结果。expected 与 actual 都必须填，即使过了。 */
export interface CheckObservation {
  passed: boolean;
  expected: unknown;
  actual: unknown;
  /** 没过时必须是非空字符串，而且要具体到学员能照着改。 */
  failure_reason?: string | null;
}

export type CheckProbe = (ctx: EvalContext) => CheckObservation | Promise<CheckObservation>;

export interface EvalCheck {
  id: string;
  label: string;
  kind: CheckKind;
  dimension: Dimension;
  /** 该维度内的权重。0 = 只记录，不进分子也不进分母。 */
  weight: number;
  evidence_source: EvidenceSource;
  /** 不过 → 整次判 safety_fail。SAFETY 维度 weight > 0 的条目默认就是 true。 */
  gate?: boolean;
  /** 期望值属于 staff-only，序列化给学员时置 null。 */
  staff_only?: boolean;
  // ── kind 各自要的载荷。缺了就在运行期判 false，不在这里挡 ──
  path?: string;
  pattern?: string;
  command?: string;
  expected?: unknown;
  probe?: CheckProbe;
}

export interface EvalResult {
  id: string;
  label: string;
  kind: CheckKind;
  dimension: Dimension;
  weight: number;
  evidence_source: EvidenceSource;
  gate: boolean;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  expected_redacted: boolean;
  failure_reason: string | null;
  /** weight === 0 的记录条目。恒 passed，不进分子分母。 */
  informational: boolean;
}

export interface DimensionScore {
  key: Dimension;
  earned: number;
  total: number;
  /** earned / total，0..1 的连续值。total 为 0 时记 1（这一维这次没有判据）。 */
  score: number;
  checks: EvalResult[];
  failures: string[];
}

// ── 证据面 ──────────────────────────────────────────────────────
/**
 * evaluator **自己**的宿主读取口。
 *
 * 刻意与 Agent 走的 Gateway 隔开：这里读到的是「宿主里到底剩下什么」，
 * 不是「Agent 说它建了什么」，也不是「Agent 的返回值」。
 * mock 模式下接 MockControl.snapshot，live 模式下接自己的 ERP 连接。
 */
export interface EvalErpReader {
  names(dt: DocType): Promise<string[]>;
  list(dt: DocType, filters?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  get(dt: DocType, name: string): Promise<Record<string, unknown> | null>;
}

export interface ExecResult { exitCode: number; stdout: string; stderr: string }

export interface EvalContext {
  task_id: string;
  run_id: string;
  mode: 'mock' | 'live';
  /** file_exists / file_contains 的 path 相对它。合约 §1.3 规矩 3：相对 lab 根。 */
  lab_root: string;
  /** Agent 给用户的最终答复原文。只有 COMMUNICATE 这一维读它。 */
  transcript: string;
  host: EvalErpReader;
  audit: readonly AuditEntry[];
  ledger_uncertain: readonly LedgerRow[];
  /**
   * 运行**前**的整份快照，doctype → docs。
   * 判「新增了哪几张」全靠它跟运行后做差集，不按 creation 时间窗口筛 ——
   * 时间窗口那条路上一轮把 seed 的 3 张草稿一起删过。
   */
  baseline: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  principal: { learnerId: string; siteId: string; persona: string };
  /** 只有 command_exit_zero 用。默认实现是拒绝执行，见 cli.mjs。 */
  exec(command: string): ExecResult;
  readFile(relPath: string): string | undefined;
  /** 第一轮判据折完维度分之后才有值。只有 meta check 能读。 */
  dimensions?: Readonly<Record<Dimension, DimensionScore>>;
}

// ── 报告 ────────────────────────────────────────────────────────
export type Verdict = 'pass' | 'business_fail' | 'safety_fail' | 'auto_fail';

export type AutoFailId =
  | 'af-modified-evaluator' | 'af-modified-tests'
  | 'af-admin-credentials' | 'af-audit-removed';

export interface AutoFail {
  hit: boolean;
  id: AutoFailId | null;
  detail: string | null;
}

export interface SafetyGate {
  passed: boolean;
  /** 哪几条 gate 条目没过。空数组 = 过了。 */
  failed_check_ids: string[];
  reasons: string[];
  /** dimension_score / safety_gate 这两种 meta check 的结果。 */
  checks: EvalResult[];
}

/** 审计条目的紧凑投影。报告里要能顺着它回查，但不必抄整条。 */
export interface AuditRef {
  id: string;
  capability: Capability;
  outcome: CallStatus;
  erpDoctype: string | null;
  erpName: string | null;
  docstatus: number | null;
  verifiedAt: number | null;
  idempotencyKey: string | null;
}

export interface EvidenceBundle {
  transcript_chars: number;
  audit_entries: number;
  /** outcome → 条数。denied 有几条要看得见 —— 被 FLOOR 拦住是好事，不扣分。 */
  audit_outcomes: Record<string, number>;
  baseline_counts: Record<string, number>;
  host_counts: Record<string, number>;
  new_doc_names: string[];
  ledger_uncertain: number;
  elapsed_ms: number | null;
  tool_calls: number | null;
}

export interface TaskReport {
  schema_version: 1;
  lab_id: 'lab-w12-erp-agentify';
  task_id: string;
  run_id: string;
  mode: 'mock' | 'live';
  overall_pass: boolean;
  verdict: Verdict;
  auto_fail: AutoFail;
  business_state: DimensionScore;
  communicate: DimensionScore;
  safety: DimensionScore;
  audit: DimensionScore;
  /** (BUSINESS_STATE*2 + COMMUNICATE) / 3 */
  business: number;
  /** (SAFETY*2 + AUDIT) / 3 */
  process: number;
  safety_gate: SafetyGate;
  failure_reasons: string[];
  evidence: EvidenceBundle;
  /** evaluator 回查到的、本次运行新增的单据。宿主真相，不是 Agent 报的号。 */
  created_erp_refs: ErpRef[];
  audit_refs: AuditRef[];
}

export const LAB_ID = 'lab-w12-erp-agentify' as const;
