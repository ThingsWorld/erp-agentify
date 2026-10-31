// capstone 的幂等键。纯 JS —— 这一关的编排入口是 run.mjs，键的推导也留在 .mjs，
// 免得为了算一串字符串再去起一个 tsx。
//
// 语义跟 src/idempotency-key.ts 的 draftKey 完全一致：同一件业务上的事，
// 算多少遍都得到同一串字节。键里不许有任何熵源 —— 时间、随机、进程号、自增序号
// 都会让重试算出一个新键，网关认不出这是同一件事，于是放行，于是第二张单。
// scripts/check-key-entropy.mjs 会静态扫这个文件。
//
// 键回答四个问题：干什么（intent）、给谁（supplier）、买什么（itemCode + qty）、
// 哪一批（batch）。batch 用能稳定标识这次业务请求的东西 —— 原单号、工单号都行，
// 但不要用 runId：用户点三次「重试」很可能落在三个 run 上，助手重启之后更是必然换掉。
// runId 认的是「同一次执行」，键要认的是「同一件事」。

/** 分隔符。竖线在 ERP 的单号、物料码里都不会出现。 */
const SEP = '|';

/** 折叠空白。手输的字段里多一个空格不该变成另一件事。 */
function normalize(s) {
  return String(s).trim().replace(/\s+/g, ' ');
}

/**
 * @typedef {object} CapstoneKeyParts
 * @property {string} intent    业务意图，如 'po-correction'。补货和退换要用不同的意图。
 * @property {string} supplier  供应商，如 'Globex'。
 * @property {string} itemCode  物料码，如 'ITEM-SHELF-01'。
 * @property {number} qty       这次要下的数量。缺口变了就是另一件事，键跟着变是对的。
 * @property {string} batch     批次标识。capstone 里用原单号 PUR-ORD-2026-00001。
 */

/**
 * 算出一次建草稿的幂等键。
 *
 * 五个字段全部参与，缺一个就报错 —— 与其让一个空串糊过去，不如在这里当场炸掉。
 * 空串键在 policy 那层过得去（它只判 truthy），但两件不同的事会撞成同一个键。
 *
 * @param {CapstoneKeyParts} p
 * @returns {string}
 */
export function capstoneKey(p) {
  if (p === null || typeof p !== 'object') throw new Error('capstoneKey 需要一个参数对象');
  if (!Number.isInteger(p.qty) || p.qty <= 0) throw new Error('qty 必须是正整数');

  const parts = [
    ['intent', p.intent],
    ['supplier', p.supplier],
    ['itemCode', p.itemCode],
    ['batch', p.batch],
  ];
  for (const [name, value] of parts) {
    if (typeof value !== 'string' || normalize(value) === '')
      throw new Error('幂等键的 ' + name + ' 不能为空');
  }

  return [
    normalize(p.intent),
    normalize(p.supplier),
    normalize(p.itemCode),
    String(p.qty),
    normalize(p.batch),
  ].join(SEP);
}
