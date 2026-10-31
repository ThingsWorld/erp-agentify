// Postgres / Supabase 侧的幂等台账。平台跑的是这一份。
//
// 它和 src/ledger-persistent.ts 是**并存**的两套实现，不是替换关系：
// 文件系统那份零依赖、离线可跑，学员在自己机器上用；这一份要的是
// 多个网关进程共用一份状态。两边都编译到 src/types.ts 的 Ledger 接口，
// 上层拿到哪一个都一样调。
//
// ── 判定全部落在库里 ──
//
// 占位：store/schema.sql 的 erp_reserve()。第一段是 insert ... on conflict
// do nothing，一条语句定胜负；已存在的行走 select ... for update 上行锁再判。
// 这一层**不重写那段逻辑**，也不许自己发 insert into erp_idempotency_ledger ——
// 应用层一旦变成「先 select 看一眼，再 insert」，两条语句之间就是重复单据的来源。
//
// 租约：谁持有、过没过期，也在库里判。erp_settle() 的 where 上带 lease_owner，
// erp_reserve() 用 lease_until > now() 比时间。都不是读回 JS 里比 ——
// 网关有好几个进程，各自的时钟差几百毫秒是常态，谁的 Date.now() 都不算数。
//
// uncertain 的行永不自动领回，erp_reserve() 直接返回 in_flight。
// 写可能已经落到宿主了，自动重试等于把那一刻的不确定抹平成「重试成功」。
//
// ── 连接怎么隔离 ──
//
// 这个 adapter 从构造函数拿一个建好的连接，自己不读环境变量、不拼连接串、
// 不认识任何口令。装配只发生在网关进程启动那一次，用的是服务角色。
//
// 学员沙箱手里只有一个短期平台令牌，走 HTTP 打到网关，中间隔着整个网关进程,
// 没有任何一条路能拿到连接对象。就算那个令牌被拿去直连数据库，它落到库里是
// anon / authenticated 角色，而 erp_idempotency_ledger 开了 RLS 且一条 policy
// 都没有 —— 结果是零行可见、零行可写。审计表同理，见 pg-audit.ts。

import {
  Capability, ErpRef, Ledger, LedgerRow, LedgerState, Principal, ReserveOutcome,
} from '../types.js';
import { PgClient, toMs } from './pg-client.js';

/** 台账行在库里的形状。列名与 store/schema.sql 一一对应。 */
interface LedgerDbRow {
  learner_id: string;
  site_id: string;
  key: string;
  capability: string;
  state: string;
  lease_until: unknown;
  lease_owner: string | null;
  erp_doctype: string | null;
  erp_name: string | null;
  attempts: number | string;
  created_at: unknown;
  updated_at: unknown;
}

/** erp_reserve() 的返回。判定用的就是这七个字段，别的都不作数。 */
interface ReserveDbRow {
  out_outcome: string;
  out_state: string;
  out_lease_until: unknown;
  out_lease_owner: string | null;
  out_erp_doctype: string | null;
  out_erp_name: string | null;
  out_attempts: number | string;
}

const RESERVE_SQL = `select out_outcome, out_state, out_lease_until, out_lease_owner,
       out_erp_doctype, out_erp_name, out_attempts
  from erp_reserve($1, $2, $3, $4, $5, $6)`;

const SETTLE_SQL = 'select erp_settle($1, $2, $3, $4, $5, $6, $7) as ok';

const COLUMNS = `learner_id, site_id, key, capability, state,
       lease_until, lease_owner, erp_doctype, erp_name,
       attempts, created_at, updated_at`;

const ROW_SQL = `select ${COLUMNS}
  from erp_idempotency_ledger
 where learner_id = $1 and site_id = $2 and key = $3`;

const UNCERTAIN_SQL = `select ${COLUMNS}
  from erp_idempotency_ledger
 where state = 'uncertain'
 order by updated_at`;

function refOf(doctype: string | null, name: string | null): ErpRef | null {
  return doctype && name ? { doctype, name } : null;
}

export class PostgresLedger implements Ledger {
  /**
   * @param db 服务角色的连接。谁传进来谁负责它的权限，这一层不做提权也不做降权。
   */
  constructor(private db: PgClient) {}

  async reserve(
    p: Principal, key: string, cap: Capability, owner: string, leaseMs: number,
  ): Promise<ReserveOutcome> {
    // 作用域三元组来自 Principal，不来自调用方给的任何对象 ——
    // Principal 只能由 identity.resolve() 从平台令牌生成。
    const hit = await this.db.query<ReserveDbRow>(
      RESERVE_SQL, [p.learnerId, p.siteId, key, cap, owner, leaseMs],
    );
    const head = hit.rows[0];
    if (!head) throw new Error('erp_reserve 没返回行 —— store/schema.sql 没装上？');

    // 判定字段全部取自上面那一次调用。下面这次读只补 created_at / updated_at
    // 这两个展示用的时间戳 —— 它们不在 erp_reserve 的返回里，而改函数签名
    // 会动到已经上线的那份 schema。两次查询之间行还会变，所以**判定不看第二次读**。
    const meta = await this.readRow(p, key);
    const now = Date.now();
    const row: LedgerRow = {
      learnerId: p.learnerId,
      siteId: p.siteId,
      key,
      capability: (meta?.capability ?? cap) as Capability,
      state: head.out_state as LedgerState,
      leaseUntil: toMs(head.out_lease_until),
      leaseOwner: head.out_lease_owner,
      erpRef: refOf(head.out_erp_doctype, head.out_erp_name),
      attempts: Number(head.out_attempts),
      createdAt: meta?.createdAt ?? now,
      updatedAt: meta?.updatedAt ?? now,
    };

    switch (head.out_outcome) {
      case 'acquired':  return { outcome: 'acquired', row };
      case 'duplicate': return { outcome: 'duplicate', row };
      case 'in_flight': return { outcome: 'in_flight', row };
      case 'recovered': return { outcome: 'recovered', row };
      default:
        throw new Error('erp_reserve 返回了没见过的 outcome：' + String(head.out_outcome));
    }
  }

  async begin(p: Principal, key: string, owner: string): Promise<void> {
    await this.settle(p, key, owner, 'executing', undefined);
  }

  async succeed(p: Principal, key: string, owner: string, ref: ErpRef): Promise<void> {
    await this.settle(p, key, owner, 'succeeded', ref);
  }

  async markUncertain(p: Principal, key: string, owner: string, ref: ErpRef | null): Promise<void> {
    await this.settle(p, key, owner, 'uncertain', ref);
  }

  async fail(p: Principal, key: string, owner: string): Promise<void> {
    await this.settle(p, key, owner, 'failed', undefined);
  }

  async get(p: Principal, key: string): Promise<LedgerRow | null> {
    return this.readRow(p, key);
  }

  async listUncertain(): Promise<LedgerRow[]> {
    const hit = await this.db.query<LedgerDbRow>(UNCERTAIN_SQL);
    return hit.rows.map(mapRow);
  }

  /**
   * 状态推进。租约归属由 erp_settle() 的 where 判，命中 0 行就是「这行不归你」。
   *
   * 没有这一条，一个超时的旧持有者醒过来会把接手者的成功结果覆盖掉。
   */
  private async settle(
    p: Principal, key: string, owner: string, state: LedgerState, ref: ErpRef | null | undefined,
  ): Promise<void> {
    const hit = await this.db.query<{ ok: boolean }>(SETTLE_SQL, [
      p.learnerId, p.siteId, key, owner, state,
      ref?.doctype ?? null, ref?.name ?? null,
    ]);
    if (hit.rows[0]?.ok !== true) {
      throw new Error('租约不属于你，或者台账里没有这个键：' + key);
    }
  }

  private async readRow(p: Principal, key: string): Promise<LedgerRow | null> {
    const hit = await this.db.query<LedgerDbRow>(ROW_SQL, [p.learnerId, p.siteId, key]);
    const first = hit.rows[0];
    return first ? mapRow(first) : null;
  }
}

function mapRow(r: LedgerDbRow): LedgerRow {
  const created = toMs(r.created_at) ?? 0;
  return {
    learnerId: r.learner_id,
    siteId: r.site_id,
    key: r.key,
    capability: r.capability as Capability,
    state: r.state as LedgerState,
    leaseUntil: toMs(r.lease_until),
    leaseOwner: r.lease_owner,
    erpRef: refOf(r.erp_doctype, r.erp_name),
    attempts: Number(r.attempts),
    createdAt: created,
    updatedAt: toMs(r.updated_at) ?? created,
  };
}
