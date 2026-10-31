// 业务语义幂等键（Task 06）。
//
// 键里**不许有**时间戳、随机数、进程号 —— 重试的时候你需要算出同一个键，
// 任何熵源都会让重试命不中，于是建出第二张单。
// scripts/check-key-entropy.mjs 会静态检查这个文件。
//
// 键要能回答四个问题：谁、给谁、买什么、哪一批。

/** 键的分隔符。选竖线是因为 ERP 的单号、物料码里都不会出现它。 */
const SEP = '|';

export interface DraftKeyParts {
  /** 业务意图，如 'po-correction'。同一个供应商同一物料，补货和退换要用不同的意图。 */
  intent: string;
  supplier: string;
  itemCode: string;
  qty: number;
  /** 哪一批 —— 用能稳定标识这次业务请求的东西，比如原单号或工单号。 */
  batch: string;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** 建草稿的键。 */
export function draftKey(p: DraftKeyParts): string {
  if (!Number.isInteger(p.qty) || p.qty <= 0) throw new Error('qty 必须是正整数');
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && normalize(v) === '') throw new Error(`幂等键的 ${k} 不能为空`);
  }
  return [normalize(p.intent), normalize(p.supplier), normalize(p.itemCode),
          String(p.qty), normalize(p.batch)].join(SEP);
}

/** 提交的键。绑单号 —— 提交的对象就是那一张单，没有别的批次概念。 */
export function submitKey(erpName: string): string {
  if (!erpName) throw new Error('提交的幂等键必须带单号');
  return ['submit', normalize(erpName)].join(SEP);
}
