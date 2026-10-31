// 两个 Postgres adapter 共用的驱动最小面。
//
// 刻意只声明一个 query()，不引任何数据库驱动包：
//
//   · 驱动版本、连接池参数、重试策略是平台部署的事，不该由这一层决定；
//   · 学员那份仓库 npm ci 完就要能跑，多一个原生依赖多一份 Windows 上装不上的风险；
//   · 测试拿一个内存实现顶上去就行，不用为了跑测试起一个库。
//
// node-postgres 的 Pool 与 Client 原样满足这个形状，装配的时候直接传进来。

/** 一次查询的结果。字段名与主流驱动对齐，省得在 adapter 里做一层翻译。 */
export interface PgQueryResult<R> {
  rows: R[];
  /** 受影响 / 返回的行数。on conflict do nothing 没插进去的时候这里是 0。 */
  rowCount: number;
}

/**
 * 一条已经建好的连接。
 *
 * 参数一律走 $1 $2 绑定，adapter 里不许出现字符串拼接 —— 幂等键是学员算出来的，
 * 里面什么字符都可能有。
 */
export interface PgClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
}

/** timestamptz → epoch 毫秒。驱动可能给 Date，也可能给字符串，两种都收。 */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

/** epoch 毫秒 → 可以直接当 timestamptz 绑定的字符串。 */
export function toTimestamp(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
