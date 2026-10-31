-- store/audit.sql —— Supabase / Postgres 侧的审计表（Task 08）。
--
-- 为什么 append-only 一定要做在数据库层，不能只写在 TypeScript 里：
--
--   src/types.ts 的 AuditLedger 接口上只有 append / byRun / byErpRef，
--   全仓 grep 不出一条 update erp_audit —— 看起来已经做完了。
--   然后有人拿 service_role 直接连库，一条 update 把某行的 outcome
--   从 done 改成 denied，重读，改成了。
--
--   绕过应用直连库的人不看你的接口。所以禁改禁删得落在这里：
--   下面那两条 rule 让 update 和 delete 变成「什么都不做」——
--   不是报错，是静默无效。报错还能被人 catch 掉当没发生，
--   静默无效连绕的路都没有：语句照跑，行数照返回 0，数据一个字节不变。
--
-- 一句话：审计要能证明「谁在什么时候动了哪张单」，
--         而能被改的证据不叫证据。
--
-- 应用侧的对应物是 src/audit.ts（NDJSON，O_APPEND 追加，只 write 不 seek）。
-- 两边语义一样，这份是生产版。

-- ── 表 ────────────────────────────────────────────────────────────
--
-- 两侧主键写在**同一行**上：runId 一侧（这次运行动了什么）和
-- (erp_doctype, erp_name) 一侧（这张单是谁动的）。
-- 拆成两张表、或者一行只记一侧，双向就只剩一个方向 ——
-- 内审手里永远只有单号，不会有你的 runId。

create table if not exists erp_audit (
  id               uuid        primary key default gen_random_uuid(),

  -- 归属。全部由网关从平台令牌解析出的 Principal 填，
  -- 请求体里带同名字段是直接拒（src/identity.ts），不是覆盖。
  learner_id       text        not null,
  site_id          text        not null,
  run_id           text        not null,

  -- 这次调用本身
  approval_id      text,                       -- 没走审批就是 null
  idempotency_key  text,                       -- 读操作没有键，写操作必须有
  capability       text        not null
    check (capability in ('erp.query', 'erp.get', 'erp.create_draft', 'erp.submit')),
  args_digest      text        not null,       -- sha256 前缀，键排序后再哈希

  -- 宿主侧主键。denied 的调用这两列可能是 null —— 请求根本没走到宿主。
  erp_doctype      text,
  erp_name         text,
  docstatus        smallint    check (docstatus in (0, 1, 2)),

  -- 「回执说成功」和「宿主终态确认」是两件事，所以分两列：
  -- outcome 是前者，verified_at 是后者。null 就是没回查上。
  verified_at      timestamptz,
  outcome          text        not null
    check (outcome in ('done', 'deduped', 'uncertain', 'denied', 'in_flight')),

  created_at       timestamptz not null default now()
);

comment on table erp_audit is
  'ERP Gateway 的调用审计。append-only：禁 update / 禁 delete 由下面两条 rule 兜底。';
comment on column erp_audit.verified_at is
  '回查确认宿主终态的时刻。null 表示没确认上 —— 这一行证明不了写入落地。';

-- ── append-only：两条 rule ────────────────────────────────────────
--
-- rule 是 Postgres 的查询重写，发生在权限检查之后、执行之前。
-- 对正常 update/delete 语句重写为空操作。
-- 这不防范能删除规则、改表或 truncate 的数据库管理员。
--
-- 关键字全小写，和 erp-gateway/store/schema.sql 里那两条保持一致，
-- 公开测试按小写匹配（task-08 的 08-sql-no-update / 08-sql-no-delete）。



create or replace rule erp_audit_no_update as
  on update to erp_audit do instead nothing;
create or replace rule erp_audit_no_delete as
  on delete to erp_audit do instead nothing;

-- ── 索引：两个方向各一条 ─────────────────────────────────────────
--
-- 正向：byRun(runId) —— 这次运行在 ERP 里留下了什么。
create index if not exists erp_audit_run_idx
  on erp_audit (run_id, created_at desc);

-- 反向：byErpRef({doctype, name}) —— 这张单是哪次运行、哪个工具、谁批的。
-- 这一条是内审真正会用的那个方向，也是第一版最容易漏掉的那个。
create index if not exists erp_audit_erp_ref_idx
  on erp_audit (erp_doctype, erp_name)
  where erp_name is not null;

-- 追责常用的第三个入口：某个学员在某个 site 上的全部动作。
create index if not exists erp_audit_principal_idx
  on erp_audit (learner_id, site_id, created_at desc);

-- ── RLS：开，但一条 policy 都不给 ────────────────────────────────
--
-- Postgres 的 RLS 默认拒绝：启用之后，没有匹配的 policy 就是零行可见、零行可写。
-- 所以这一句的效果是「除了绕过 RLS 的角色（表 owner、service_role），
-- 谁都读不到、写不进」。
--
-- 审计的写入方只有网关服务端一个，它用的是服务角色；
-- 学员的沙箱令牌走的是 anon / authenticated，落到这里是零行。
-- 想开放只读给内审的时候，在这下面单独加一条 select policy —— **只加 select**。
-- 千万别顺手写一条 for all 的 policy，那等于把上面两条 rule 的意义抵消掉一半。

alter table erp_audit enable row level security;
