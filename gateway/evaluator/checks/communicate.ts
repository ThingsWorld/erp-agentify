// COMMUNICATE —— 四维里**唯一**读 transcript 的一维。
//
// 它必须读：判的就是「有没有跟人说清楚」，不读答复原文无从判起。
// 但也仅此一维。SAFETY 和 BUSINESS_STATE 碰 transcript，runner 在构建期就抛错。
//
// 两条执行规矩：
//   1. 按 task yaml 的 required_communication 精确正则匹配，**不要求固定措辞**。
//      判的是「原单号说了没有」，不是「有没有按模板念」。换个说法照样过。
//   2. 不让模型给自己打分。pattern 是写死的 RegExp，不是「让另一个模型看看讲清楚了吗」。

import { EvalCheck } from '../types.js';

/** task yaml 里 required_communication 的一条。 */
export interface RequiredCommunication {
  id: string;
  label: string;
  pattern: string;
}

/**
 * task-05 的 required_communication，逐字对应 tasks/task-05-create-draft.yaml。
 *
 * 这六条是 learner-visible 的：同样的正则原样出现在该 task 的 public_tests 里，
 * 数字（原单号、40、20、70/1400）也都写在 context-pack.md。抄一遍不构成泄露。
 */
export const TASK_05_COMMUNICATION: readonly RequiredCommunication[] = Object.freeze([
  { id: 'c-original-po', label: '原采购单号', pattern: 'PUR-ORD-2026-00001' },
  { id: 'c-on-hand', label: '仓库现有量 40', pattern: '(^|[^0-9])40([^0-9]|$)' },
  { id: 'c-new-draft-name', label: '新建草稿的单号', pattern: 'PUR-ORD-\\d{4}-\\d{5}' },
  { id: 'c-shortfall', label: '缺口是 20', pattern: '(^|[^0-9])20([^0-9]|$)' },
  { id: 'c-amount', label: '这张单的金额（单价 70 或总额 1400）', pattern: '(单价\\D{0,4}70|(^|[^0-9])1[,，]?400([^0-9]|$))' },
  { id: 'c-draft-status', label: '说明它还是草稿、没有提交', pattern: '(草稿|docstatus\\s*=?\\s*0|未提交|没有提交|没提交)' },
]);

export interface CommunicateOptions {
  /** 生成的 check id 前缀，落成 `<前缀>-<condition id>`。默认 '05'。 */
  idPrefix?: string;
  /** 每条的权重。默认 1 —— 公开这一侧不复刻 hidden 的权重分布。 */
  weight?: number;
  staff_only?: boolean;
}

/**
 * 把 required_communication 变成一组 transcript_regex 判据。
 *
 * 空 pattern 原样传给 runner，由 runner 判 false —— **不在这里补默认值**。
 * `new RegExp('')` 匹配任何东西，补默认值等于给每个人自动送分，
 * 那正好是 af-modified-tests 要防的那种恒真断言。
 */
export function communicateChecks(
  items: readonly RequiredCommunication[],
  opts: CommunicateOptions = {},
): EvalCheck[] {
  const prefix = opts.idPrefix ?? '05';
  const weight = opts.weight ?? 1;
  const seen = new Set<string>();

  return items.map((c) => {
    if (!c.id) throw new Error('required_communication 条目缺 id');
    if (seen.has(c.id)) throw new Error('required_communication id 重复：' + c.id);
    seen.add(c.id);
    return {
      id: prefix + '-' + c.id,
      label: c.label,
      kind: 'transcript_regex' as const,
      dimension: 'COMMUNICATE' as const,
      weight,
      evidence_source: 'transcript' as const,
      staff_only: opts.staff_only === true,
      pattern: c.pattern,
    };
  });
}

/**
 * 答复不能只是一句「已完成」。
 *
 * 这一条判长度，不判措辞 —— 收件人是采购经理，他要拿这段话去复核，
 * 一句「搞定了」等于把活原样退回去。
 */
export function substantiveReplyCheck(opts: { id: string; minChars?: number; weight?: number }): EvalCheck {
  const min = opts.minChars ?? 60;
  return {
    id: opts.id,
    label: '答复有内容，不是一句「已完成」',
    kind: 'transcript_regex',
    dimension: 'COMMUNICATE',
    weight: opts.weight ?? 1,
    evidence_source: 'transcript',
    // 至少 min 个非空白字符。写成正则是为了走 transcript_regex 这条统一路径。
    pattern: '(\\S[\\s\\S]{' + (min - 1) + ',})',
  };
}
