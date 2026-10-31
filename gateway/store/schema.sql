-- store/schema.sql —— 幂等台账的生产版（Task 06 / 07 的参照物）。
--
-- 这个文件不参与本机跑分。放在这里是给你对照一件事：
--
--   src/ledger-memory.ts 的 reserve() 从进入函数到写下占位记录之间一个 await 都没有；
--   src/ledger-persistent.ts 用 openSync(path, 'wx') 一次系统调用完成占位；
--   下面的 erp_reserve() 用 insert ... on conflict do nothing 一条语句完成占位。
--
-- 三份实现长得完全不一样，但守的是同一条：
-- **「检查」和「占位」必须是一个动作，中间不给任何人留窗口。**
--
-- 上一课的实现正好相反 —— 内存 Set，第 41 行检查、第 52 行记住，
-- 中间隔着两个 await。20 个同键并发全部通过检查，然后一张一张写进 ERP，
-- 供应商那边收到 20 份一模一样的订单。见 reference/lecture-9-approval.ts。
--
-- 唯一索引不够。唯一索引挡得住「两条记录」，挡不住「一条记录被两个进程
-- 同时当成新的」—— 后者的表现是一个进程 insert 成功、另一个撞唯一键报错，
-- 然后在 catch 里「重试一次」，于是照样两张单。要的是撞了不报错、
-- 直接告诉你「你没抢到」，这就是 on conflict do nothing 的用处。

-- ── 台账表 ────────────────────────────────────────────────────────
--
-- 主键是三元组 (learner_id, site_id, key)，不是 key 单独一个。
-- alice 和 bob 传同一个字符串，各建各的单，互不影响；
-- 同一个人的两个 site 也分开算。作用域写进主键，就不用在应用层记得拼前缀。

create table if not exists erp_idempotency_ledger (
  learner_id    text        not null,
  site_id       text        not null,
  key           text        not null,

  capability    text        not null
    check (capability in ('erp.create_draft', 'erp.submit')),

  state         text        not null default 'reserved'
    check (state in ('reserved', 'executing', 'succeeded', 'uncertain', 'failed')),

  -- 租约。持有者崩了之后靠它把行领回来，不然一条 executing 会永远卡死这个键。
  lease_until   timestamptz,
  lease_owner   text,

  -- 成功之后必须把宿主主键记进来。只改 state 不记 ErpRef 是最常见的半成品：
  -- 去重「生效」了，但下一次命中 duplicate 时你手里没有单号可以还给调用方，
  -- 调用方唯一能做的就是再建一张 —— 去重做了等于没做。
  erp_doctype   text,
  erp_name      text,

  attempts      int         not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (learner_id, site_id, key)
);

comment on table erp_idempotency_ledger is
  '业务语义幂等键的台账。占位由 erp_reserve() 一条语句完成，应用层不做 check-then-set。';

create index if not exists erp_ledger_state_idx
  on erp_idempotency_ledger (state, updated_at desc);

-- 按宿主单号反查是哪个键写的。对账的人手里往往只有单号。
create index if not exists erp_ledger_erp_ref_idx
  on erp_idempotency_ledger (erp_doctype, erp_name)
  where erp_name is not null;

alter table erp_idempotency_ledger enable row level security;
-- 同 audit.sql：启用 RLS 且不给 policy = 除服务角色外零行可见可写。
-- 台账是网关的内部状态，学员令牌不该直接读到别人的行。

-- ── 原子占位 ──────────────────────────────────────────────────────
--
-- 返回值与 src/types.ts 的 ReserveOutcome 一一对应：
--   acquired  —— 这个键是新的，你拿到了租约，去干活
--   duplicate —— 之前成功过，把 erp_name 原样还给调用方，别再写一次
--   in_flight —— 别人正拿着租约，或者这一行是 uncertain（等人工对账，永不自动领回）
--   recovered —— 上一个持有者的租约过期了，你领回来接着做，attempts 加一
--
-- 两段临界区：
--   第一段是那句 insert ... on conflict do nothing。它要么插进去、要么什么都不做，
--   没有中间态，也不抛异常。插进去了就是 acquired，收工。
--   第二段是 select ... for update。行已经存在，接下来要读状态再决定改不改 ——
--   这一读一写之间必须把行锁住，否则两个并发调用会同时读到「租约过期」，
--   然后一起把自己写成 lease_owner，两个都以为拿到了。

create or replace function erp_reserve(
  p_learner_id  text,
  p_site_id     text,
  p_key         text,
  p_capability  text,
  p_owner       text,
  p_lease_ms    int
) returns table (
  out_outcome     text,
  out_state       text,
  out_lease_until timestamptz,
  out_lease_owner text,
  out_erp_doctype text,
  out_erp_name    text,
  out_attempts    int
)
language plpgsql
as $$
declare
  v_lease   interval := make_interval(secs => p_lease_ms / 1000.0);
  v_row     erp_idempotency_ledger%rowtype;
begin
  -- 第一段：占位。一条语句，要么占上要么没占上。
  insert into erp_idempotency_ledger
    (learner_id, site_id, key, capability, state, lease_until, lease_owner, attempts)
  values
    (p_learner_id, p_site_id, p_key, p_capability, 'reserved', now() + v_lease, p_owner, 1)
  on conflict (learner_id, site_id, key) do nothing
  returning * into v_row;

  if found then
    return query select 'acquired'::text, v_row.state, v_row.lease_until, v_row.lease_owner,
                        v_row.erp_doctype, v_row.erp_name, v_row.attempts;
    return;
  end if;

  -- 第二段：行已经在了。先上行锁，再读状态。
  -- for update 会等到别的事务放手为止，所以下面读到的一定是最新的那一版。
  select * into v_row
    from erp_idempotency_ledger
   where learner_id = p_learner_id
     and site_id    = p_site_id
     and key        = p_key
     for update;

  -- 之前成功过：把当初那个单号原样还回去，调用方直接用，不再写宿主。
  if v_row.state = 'succeeded' then
    return query select 'duplicate'::text, v_row.state, v_row.lease_until, v_row.lease_owner,
                        v_row.erp_doctype, v_row.erp_name, v_row.attempts;
    return;
  end if;

  -- uncertain 是唯一一个永远不自动领回的状态。
  -- 写可能已经落到宿主了，自动重试等于把那一刻的不确定抹平成「重试成功」。
  -- 清掉它的动作是人工对账：核对单号，然后手工改成 succeeded 或 failed。
  if v_row.state = 'uncertain' then
    return query select 'in_flight'::text, v_row.state, v_row.lease_until, v_row.lease_owner,
                        v_row.erp_doctype, v_row.erp_name, v_row.attempts;
    return;
  end if;

  -- 租约还活着，而且不是 failed：别人正在干这件事，你等着。
  if v_row.state <> 'failed'
     and v_row.lease_until is not null
     and v_row.lease_until > now() then
    return query select 'in_flight'::text, v_row.state, v_row.lease_until, v_row.lease_owner,
                        v_row.erp_doctype, v_row.erp_name, v_row.attempts;
    return;
  end if;

  -- 剩下的情况：租约过期，或者上一次明确失败。领回来接着做，attempts 加一。
  update erp_idempotency_ledger
     set state       = 'reserved',
         lease_until = now() + v_lease,
         lease_owner = p_owner,
         attempts    = attempts + 1,
         updated_at  = now()
   where learner_id = p_learner_id
     and site_id    = p_site_id
     and key        = p_key
  returning * into v_row;

  return query select 'recovered'::text, v_row.state, v_row.lease_until, v_row.lease_owner,
                      v_row.erp_doctype, v_row.erp_name, v_row.attempts;
end;
$$;

comment on function erp_reserve is
  '原子占位：insert ... on conflict do nothing 抢新键，for update 行锁处理已存在的键。'
  ' 应用层不许用「先 select 再 insert」代替它 —— 两条语句之间就是重复单据的来源。';

-- ── 状态推进 ──────────────────────────────────────────────────────
--
-- 转移前校验 lease_owner：别人的租约你改不动。
-- 没有 where 上的 lease_owner 这一条，一个超时的旧持有者醒过来
-- 会把接手者的成功结果覆盖掉。

create or replace function erp_settle(
  p_learner_id  text,
  p_site_id     text,
  p_key         text,
  p_owner       text,
  p_state       text,
  p_erp_doctype text default null,
  p_erp_name    text default null
) returns boolean
language plpgsql
as $$
declare
  v_hit int;
begin
  if p_state not in ('executing', 'succeeded', 'uncertain', 'failed') then
    raise exception '不允许的终态 %', p_state;
  end if;

  update erp_idempotency_ledger
     set state       = p_state,
         erp_doctype = coalesce(p_erp_doctype, erp_doctype),
         erp_name    = coalesce(p_erp_name, erp_name),
         -- succeeded / failed 是终态，把租约清掉；
         -- uncertain 保留持有者，对账的时候要追到是谁跑的那一次。
         lease_until = case when p_state in ('succeeded', 'failed') then null else lease_until end,
         lease_owner = case when p_state in ('succeeded', 'failed') then null else lease_owner end,
         updated_at  = now()
   where learner_id  = p_learner_id
     and site_id     = p_site_id
     and key         = p_key
     and lease_owner = p_owner;

  get diagnostics v_hit = row_count;
  return v_hit = 1;
end;
$$;

-- ── 待对账视图 ────────────────────────────────────────────────────
--
-- uncertain 的含义是「写可能发生了，但终态没确认上」。
-- 这些行不会自己消失，也不许被自动重试收拾掉 —— 它们是要人去看的。
--
-- 对账的人拿着 erp_name 去宿主回查：
--   查到了、内容对 → erp_settle(..., 'succeeded')
--   宿主里没有       → erp_settle(..., 'failed')，然后重新跑一次
--   查到两张以上     → 停下，这已经是重复单据了，先处理单据再动台账
--
-- 视图只读，故意不给 update 入口：改状态得显式调 erp_settle，
-- 那一行在 code review 里看得见。

create or replace view erp_ledger_pending_reconcile as
  select
    l.learner_id,
    l.site_id,
    l.key,
    l.capability,
    l.erp_doctype,
    l.erp_name,
    l.attempts,
    l.lease_owner                                   as last_owner,
    l.updated_at                                    as stuck_since,
    now() - l.updated_at                            as stuck_for,
    (l.erp_name is null)                            as needs_business_probe
  from erp_idempotency_ledger l
  where l.state = 'uncertain'
  order by l.updated_at;

comment on view erp_ledger_pending_reconcile is
  '等人工对账的台账行。needs_business_probe 为真表示连单号都没回查到，'
  ' 得按业务引用（supplier / schedule_date / bill_no）去宿主里找。';
