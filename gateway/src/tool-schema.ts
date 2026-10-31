// 工具面的参数 schema（Task 02）。
//
// 这里没有「通用工具」。四个能力各有各的参数形状，DocType 是**受控参数**，
// 必须落在 TOOL_DOCTYPES 里 —— 不是可以自由填写的地址。
//
// 反面教材是 erp_call(doctype, method, args)：一次写完、什么都能干，
// 但它把整个 ERP 的地址空间交出去了。scripts/scan-passthrough.mjs 静态查这个。
//
// TODO（task-02）：三个洞。
//   ① checkDocType 只判「是不是字符串」，没对着白名单校验。
//      DocType 于是又变回了「可以自由填写的地址」。
//   ② checkUnexpected 什么都没做。多传的字段被悄悄忽略 ——
//      调用方以为生效了，其实没有。忽略和拒绝，对调用方是两回事。
//   ③ checkLine 不要求 warehouse。mock 不拦这个，**live 会整单打回**：
//      Row #1: Warehouse is mandatory for stock Item。
//      本地拦不住，错误就跨出了这一层，审计里还多一条没意义的失败。

import { Capability, DocType, DenyCode, TOOL_DOCTYPES } from './types.js';

// ── 老的对外形状。tools.ts 之外还有别的调用方按它分支，保留。────────
export interface ValidationOk { ok: true; args: Record<string, unknown> }
export interface ValidationErr { ok: false; code: DenyCode; message: string; field?: string }
export type ValidationResult = ValidationOk | ValidationErr;

// ── 封闭错误码 ─────────────────────────────────────────────────────
//
// 六个码，一个不多。调用方按 code 分支、按 field 定位到出错的那个参数。
// 文案随时会改，code 与 field 不改 —— 那是给机器看的那一半。

export const TOOL_ERROR_CODES = [
  'UNKNOWN_TOOL',
  'DOCTYPE_NOT_ALLOWED',
  'MISSING_FIELD',
  'UNEXPECTED_FIELD',
  'BAD_TYPE',
  'VALUE_NOT_ALLOWED',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolCheckOk { ok: true; capability: Capability; args: Record<string, unknown> }
export interface ToolCheckErr { ok: false; code: ToolErrorCode; field: string; message: string }
export type ToolCheckResult = ToolCheckOk | ToolCheckErr;

/** 工具面的码 → 网关的 DenyCode。CallResult.code 的类型在 types.ts 冻着，不动它。 */
export const DENY_BY_TOOL_CODE: Readonly<Record<ToolErrorCode, DenyCode>> = Object.freeze({
  UNKNOWN_TOOL: 'UNKNOWN_CAPABILITY',
  DOCTYPE_NOT_ALLOWED: 'UNKNOWN_DOCTYPE',
  MISSING_FIELD: 'BAD_ARGS',
  UNEXPECTED_FIELD: 'BAD_ARGS',
  BAD_TYPE: 'BAD_ARGS',
  VALUE_NOT_ALLOWED: 'BAD_ARGS',
});

const bad = (code: ToolErrorCode, field: string, message: string): ToolCheckErr =>
  ({ ok: false, code, field, message });

/** 每个能力认识的顶层参数。表外的键一律拒。 */
const ARG_KEYS: Readonly<Record<Capability, readonly string[]>> = Object.freeze({
  'erp.query': Object.freeze(['docType', 'filters']),
  'erp.get': Object.freeze(['docType', 'name']),
  'erp.create_draft': Object.freeze(['docType', 'doc']),
  'erp.submit': Object.freeze(['docType', 'name']),
});

/** 采购单行上必须逐个到位的字段。warehouse 在这里，是因为货架是库存物料。 */
// TODO（task-02）洞③：少了一个字段。哪个？为什么 mock 不报错而 live 报？
const LINE_TEXT_FIELDS = ['item_code', 'warehouse'] as const;
const LINE_NUM_FIELDS = ['qty', 'rate'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── 逐字段的窄校验 ─────────────────────────────────────────────────

function checkDocType(a: Record<string, unknown>): ToolCheckErr | null {
  const v = a.docType;
  if (v === undefined || v === null) return bad('MISSING_FIELD', 'docType', 'docType 必填');
  if (typeof v !== 'string') return bad('BAD_TYPE', 'docType', 'docType 必须是字符串');
  if (!TOOL_DOCTYPES.includes(v as DocType))
    return bad('DOCTYPE_NOT_ALLOWED', 'docType', '不允许访问该 DocType');
  return null;
}

function checkUnexpected(cap: Capability, a: Record<string, unknown>): ToolCheckErr | null {
  for (const key of Object.keys(a)) {
    if (!ARG_KEYS[cap].includes(key))
      return bad('UNEXPECTED_FIELD', key, `不允许参数 ${key}`);
  }
  return null;
}

function checkName(a: Record<string, unknown>): ToolCheckErr | null {
  const v = a.name;
  if (v === undefined || v === null) return bad('MISSING_FIELD', 'name', 'name 必填');
  if (typeof v !== 'string') return bad('BAD_TYPE', 'name', 'name 必须是字符串');
  // 单号只允许安全字符。挡的是拿 name 去拼路径、拼查询的花招。
  if (!/^[A-Za-z0-9._\- ]{1,140}$/.test(v))
    return bad('VALUE_NOT_ALLOWED', 'name', 'name "' + v + '" 含不允许的字符');
  return null;
}

function checkFilters(a: Record<string, unknown>): ToolCheckErr | null {
  const v = a.filters;
  if (v === undefined) return null;
  if (!isPlainObject(v)) return bad('BAD_TYPE', 'filters', 'filters 必须是对象');
  for (const [k, val] of Object.entries(v)) {
    if (!/^[a-z_][a-z0-9_]{0,60}$/.test(k))
      return bad('VALUE_NOT_ALLOWED', 'filters.' + k, 'filters 的字段名 "' + k + '" 不合法');
    const t = typeof val;
    if (t !== 'string' && t !== 'number' && t !== 'boolean')
      return bad('BAD_TYPE', 'filters.' + k, 'filters.' + k + ' 只能是字符串 / 数字 / 布尔');
  }
  return null;
}

function checkLine(row: unknown, i: number): ToolCheckErr | null {
  const at = (f: string) => 'items[' + i + '].' + f;
  if (!isPlainObject(row)) return bad('BAD_TYPE', 'items[' + i + ']', 'items[' + i + '] 必须是对象');

  for (const f of LINE_TEXT_FIELDS) {
    const v = row[f];
    // warehouse 走的就是这一条：库存物料的行不带仓库，ERPNext 会整单打回
    // （Row #1: Warehouse is mandatory for stock Item）。本地先拦住。
    if (v === undefined || v === null) return bad('MISSING_FIELD', at(f), at(f) + ' 必填');
    if (typeof v !== 'string') return bad('BAD_TYPE', at(f), at(f) + ' 必须是字符串');
    if (v.trim() === '') return bad('VALUE_NOT_ALLOWED', at(f), at(f) + ' 不能是空串');
  }

  for (const f of LINE_NUM_FIELDS) {
    const v = row[f];
    if (v === undefined || v === null) return bad('MISSING_FIELD', at(f), at(f) + ' 必填');
    if (typeof v !== 'number' || !Number.isFinite(v))
      return bad('BAD_TYPE', at(f), at(f) + ' 必须是数字');
  }
  const qty = row.qty as number;
  const rate = row.rate as number;
  if (qty <= 0) return bad('VALUE_NOT_ALLOWED', at('qty'), at('qty') + ' 必须是正数');
  if (rate < 0) return bad('VALUE_NOT_ALLOWED', at('rate'), at('rate') + ' 不能是负数');
  return null;
}

function checkDoc(a: Record<string, unknown>): ToolCheckErr | null {
  const v = a.doc;
  if (v === undefined || v === null) return bad('MISSING_FIELD', 'doc', 'doc 必填');
  if (!isPlainObject(v)) return bad('BAD_TYPE', 'doc', 'doc 必须是对象');

  const supplier = v.supplier;
  if (supplier === undefined || supplier === null) return bad('MISSING_FIELD', 'supplier', 'supplier 必填');
  if (typeof supplier !== 'string') return bad('BAD_TYPE', 'supplier', 'supplier 必须是字符串');
  if (supplier.trim() === '') return bad('VALUE_NOT_ALLOWED', 'supplier', 'supplier 不能是空串');

  const items = v.items;
  if (items === undefined || items === null) return bad('MISSING_FIELD', 'items', 'items 必填');
  if (!Array.isArray(items)) return bad('BAD_TYPE', 'items', 'items 必须是数组');
  if (items.length === 0) return bad('VALUE_NOT_ALLOWED', 'items', 'items 至少要有一行');

  for (let i = 0; i < items.length; i += 1) {
    const e = checkLine(items[i], i);
    if (e) return e;
  }
  return null;
}

// ── 入口 ───────────────────────────────────────────────────────────

/**
 * 按能力校验一次调用的参数。**在 gateway.call() 之前跑完。**
 *
 * 顺序是固定的：先看形状，再看 DocType，再看多余字段，最后逐字段。
 * DocType 排在多余字段前面，是因为「你根本不该碰这个 DocType」比
 * 「你多传了个参数」更值得先说。
 */
export function validateToolArgs(cap: Capability, raw: unknown): ToolCheckResult {
  if (!Object.prototype.hasOwnProperty.call(ARG_KEYS, cap))
    return bad('UNKNOWN_TOOL', 'capability', '未知能力 ' + String(cap));
  if (!isPlainObject(raw)) return bad('BAD_TYPE', 'args', 'args 必须是对象');

  const a = raw;
  const dt = checkDocType(a);
  if (dt) return dt;
  const extra = checkUnexpected(cap, a);
  if (extra) return extra;

  const docType = a.docType as DocType;

  switch (cap) {
    case 'erp.query': {
      const e = checkFilters(a);
      if (e) return e;
      return { ok: true, capability: cap, args: { docType, filters: a.filters ?? {} } };
    }
    case 'erp.get':
    case 'erp.submit': {
      const e = checkName(a);
      if (e) return e;
      return { ok: true, capability: cap, args: { docType, name: a.name as string } };
    }
    default: {
      const e = checkDoc(a);
      if (e) return e;
      return { ok: true, capability: cap, args: { docType, doc: a.doc as Record<string, unknown> } };
    }
  }
}

/**
 * 老形状的门面。返回的 code 是 types.ts 的 DenyCode，
 * 想拿到工具面那六个封闭码，用 validateToolArgs / validateToolCall。
 */
export function validateArgs(cap: Capability, raw: unknown): ValidationResult {
  const r = validateToolArgs(cap, raw);
  if (r.ok) return { ok: true, args: r.args };
  return { ok: false, code: DENY_BY_TOOL_CODE[r.code], message: r.message, field: r.field };
}
