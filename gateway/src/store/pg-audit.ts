// Postgres / Supabase 侧的调用审计。平台跑的是这一份。
//
// 对应的应用侧实现是 src/audit.ts（NDJSON，O_APPEND 追加）。两边语义一样，
// 都编译到 src/types.ts 的 AuditLedger，都只有 append / byRun / byErpRef。
//
// ── append-only 不靠这个文件 ──
//
// 这里没有 update，也没有 delete。但「我的代码里没有 update 语句」证明不了什么 ——
// 下一个接手的人加一条谁也拦不住，更不用说绕过应用直连库的人根本不看接口。
//
// 真正兜底的是 store/audit.sql 那一侧：erp_audit 上的 update 和 delete 被拦在
// 数据库里，不需要应用配合。
//
// 拦法是查询重写，发生在权限检查之后、执行之前。谁来发这条语句都一样 ——
// 服务角色、表 owner、超级用户，重写之后的语句是空的，没有东西可执行。
// 而且它是**静默无效**：语句照跑，行数返回 0，数据一个字节不变。
// 报错还能被人 catch 掉当没发生，静默无效连绕的路都没有。
//
// ── 归属由服务端填 ──
//
// learner / site / run 三个字段没有让调用方指定的路径：拿 forPrincipal() 绑定一次，
// 之后 append() 的入参里根本没有这三个键（见 ScopedAuditEntry）。Principal 只能由
// identity.resolve() 从平台令牌生成，请求体里出现同名字段是直接拒，不是覆盖。
//
// persona 不进审计表 —— 它是网关拿去换 ERP 会话的东西，落库只会多一份可以被
// 拿来对照猜测的信息。要追「这次用的哪个 persona」，从 learner_id 去权限表查。
//
// 另外，insert 的列是写死的一张表。调用方对象上多带的字段进不了绑定参数，
// 也就进不了库 —— 想往审计里塞一个 erp_user 冒充别人，没有那个入口。
//
// ── 连接怎么隔离 ──
//
// 平台给网关进程两条连接：台账一条、审计一条，各自是各自的角色。
// 审计那条的授权只有 insert 和 select（update / delete 给了也没用，被 rule 吃掉）。
// 两个 adapter 各拿各的，谁也调不到对方的表。
//
// 学员那一侧一条连接都没有。沙箱手里只有短期平台令牌，走 HTTP 打到网关；
// 令牌本身在库里是 anon / authenticated 角色，而 erp_audit 开了 RLS 且没有
// 任何 policy —— 拿它直连的结果是零行可见、零行可写。
// 以后要给内审开只读，在 audit.sql 里单加一条 select policy，**只加 select**。

import { AuditEntry, AuditLedger, ErpRef, Principal } from '../types.js';
import { PgClient, toMs, toTimestamp } from './pg-client.js';

/** 审计行在库里的形状。列名与 store/audit.sql 一一对应。 */
interface AuditDbRow {
  id: string;
  learner_id: string;
  site_id: string;
  run_id: string;
  approval_id: string | null;
  idempotency_key: string | null;
  capability: string;
  args_digest: string;
  erp_doctype: string | null;
  erp_name: string | null;
  docstatus: number | string | null;
  verified_at: unknown;
  outcome: string;
  created_at: unknown;
}

/** 绑定归属之后剩下的入参。少的那三个键就是「调用方指定不了」的意思。 */
export type ScopedAuditEntry =
  Omit<AuditEntry, 'id' | 'createdAt' | 'learnerId' | 'siteId' | 'runId'>;

/** 网关业务代码只该看见这个面。 */
export interface ScopedAudit {
  append(e: ScopedAuditEntry): Promise<AuditEntry>;
}

const RETURNING = `id, learner_id, site_id, run_id, approval_id, idempotency_key,
       capability, args_digest, erp_doctype, erp_name, docstatus,
       verified_at, outcome, created_at`;

const INSERT_SQL = `insert into erp_audit
  (learner_id, site_id, run_id, approval_id, idempotency_key, capability,
   args_digest, erp_doctype, erp_name, docstatus, verified_at, outcome)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
returning ${RETURNING}`;

const BY_RUN_SQL = `select ${RETURNING}
  from erp_audit where run_id = $1 order by created_at`;

const BY_REF_SQL = `select ${RETURNING}
  from erp_audit where erp_doctype = $1 and erp_name = $2 order by created_at`;

export class PostgresAudit implements AuditLedger {
  /**
   * @param db 只授了 insert / select 的那条连接。这一层不做提权也不做降权。
   */
  constructor(private db: PgClient) {}

  /**
   * 绑定归属，返回一个连 learnerId / siteId / runId 都传不进去的窄面。
   * 网关每次调用开头绑一次，后面所有 append 都走它。
   */
  forPrincipal(p: Principal, runId: string): ScopedAudit {
    const scope = { learnerId: p.learnerId, siteId: p.siteId, runId };
    return {
      append: (e: ScopedAuditEntry) => this.append({ ...e, ...scope }),
    };
  }

  async append(e: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry> {
    // 归属为空说明装配错了 —— 与其写一条查不出来源的审计，不如现在就炸。
    for (const [field, value] of [
      ['learnerId', e.learnerId], ['siteId', e.siteId], ['runId', e.runId],
    ] as const) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('审计缺归属：' + field + ' 必须由服务端从 Principal 填');
      }
    }

    const hit = await this.db.query<AuditDbRow>(INSERT_SQL, [
      e.learnerId, e.siteId, e.runId,
      e.approvalId, e.idempotencyKey, e.capability, e.argsDigest,
      e.erpDoctype, e.erpName, e.docstatus,
      toTimestamp(e.verifiedAt), e.outcome,
    ]);
    const first = hit.rows[0];
    if (!first) throw new Error('审计没写进去 —— erp_audit 的 insert 返回了空');
    return mapEntry(first);
  }

  async byRun(runId: string): Promise<AuditEntry[]> {
    const hit = await this.db.query<AuditDbRow>(BY_RUN_SQL, [runId]);
    return hit.rows.map(mapEntry);
  }

  /** 反向：一张单据是哪次 run、哪个工具、谁批的。出事的时候查的是这个方向。 */
  async byErpRef(ref: ErpRef): Promise<AuditEntry[]> {
    const hit = await this.db.query<AuditDbRow>(BY_REF_SQL, [ref.doctype, ref.name]);
    return hit.rows.map(mapEntry);
  }
}

function mapEntry(r: AuditDbRow): AuditEntry {
  return {
    id: r.id,
    learnerId: r.learner_id,
    siteId: r.site_id,
    runId: r.run_id,
    approvalId: r.approval_id,
    idempotencyKey: r.idempotency_key,
    capability: r.capability as AuditEntry['capability'],
    argsDigest: r.args_digest,
    erpDoctype: r.erp_doctype,
    erpName: r.erp_name,
    docstatus: r.docstatus === null ? null : Number(r.docstatus),
    verifiedAt: toMs(r.verified_at),
    outcome: r.outcome as AuditEntry['outcome'],
    createdAt: toMs(r.created_at) ?? 0,
  };
}
