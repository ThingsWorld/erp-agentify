// 缺口计算（Task 05）。
//
// 缺口 = 需求 − 仓库现有。**不是**照抄原单的订量。
//
// 照抄原单是最常见的错：原单 50，仓库已有 40，需求 60。
// 填 50 的话仓库最后有 90 个，多出来的 30 个是真金白银。

export interface ShortfallInput {
  /** 业务方要求的总量。这个数在任务话术里，ERP 里查不到。 */
  requiredQty: number;
  /** 仓库现有量。必须从 Bin.actual_qty 查，不能猜。 */
  onHandQty: number;
}

export interface ShortfallResult {
  shortfall: number;
  /** 讲给用户听的算式。COMMUNICATE 维度要看到这几个数。 */
  explanation: string;
}

/**
 * 算缺口。
 *
 * 两个边界：
 *   · 现有量已经够了 → 缺口 0，不该建单。
 *   · 现有量读成 0 但其实是「没权限」→ 缺口会算成满额。
 *     所以调用方必须先分清「真的是 0」和「读不到」（Task 01）。
 */
export function computeShortfall(i: ShortfallInput): ShortfallResult {
  if (!Number.isFinite(i.requiredQty) || i.requiredQty <= 0)
    throw new Error('requiredQty 必须是正数');
  if (!Number.isFinite(i.onHandQty) || i.onHandQty < 0)
    throw new Error('onHandQty 必须是非负数');

  const shortfall = Math.max(0, i.requiredQty - i.onHandQty);
  return {
    shortfall,
    explanation: '需求 ' + i.requiredQty + ' − 现有 ' + i.onHandQty + '，缺口 ' + shortfall,
  };
}
