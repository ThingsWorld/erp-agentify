// Postgres adapter 的公开测试。**不连任何真库。**
//
// 下面那个 FakePostgres 不是「Postgres 的实现」，它只认这两个 adapter 会发的
// 那几条语句。它存在的意义是把三件事的语义钉死，而这三件事正是 adapter 的
// 正确性依赖的全部：
//
//   ① insert ... on conflict do nothing 的返回行数 —— 插进去是 1，撞了是 0，不抛;
//      同一句话去掉 on conflict，撞了就抛 23505。两者的差别就是「重复单据」的分水岭。
//   ② select ... for update 的行锁 —— 拿到锁之前得等着，读到的一定是最新那一版。
//   ③ store/audit.sql 那两条 rule —— 对 erp_audit 的 update / delete 静默无效：
//      不报错，行数返回 0，数据一个字节不变。
//
// 每个 query() 前面有一次真的异步跳转（setTimeout 0），并发才交错得起来；
// 跳转之后语句本体是同步跑完的 —— 这正是「一条 SQL 语句是原子的」那件事。
//
// 真库那一组在文件末尾，默认跳过：这个仓库没有数据库驱动依赖，
// 本机唯一在跑的 Postgres 属于别的项目，不往里写东西。

import { describe, expect, it } from 'vitest';
import {
  AuditEntry, Capability, ErpRef, PERSONA_DOCTYPES, Principal,
} from '../src/types.js';
import { PgClient, PgQueryResult } from '../src/store/pg-client.js';
import { PostgresLedger } from '../src/store/pg-ledger.js';
import { PostgresAudit, ScopedAuditEntry } from '../src/store/pg-audit.js';

// ── fake ────────────────────────────────────────────────────────

type Role = 'service_role' | 'authenticated';

class PgFakeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PgFakeError';
  }
}

interface LedgerRecord {
  learner_id: string; site_id: string; key: string; capability: string;
  state: string; lease_until: number | null; lease_owner: string | null;
  erp_doctype: string | null; erp_name: string | null;
  attempts: number; created_at: number; updated_at: number;
}

interface AuditRecord {
  id: string; learner_id: string; site_id: string; run_id: string;
  approval_id: string | null; idempotency_key: string | null;
  capability: string; args_digest: string;
  erp_doctype: string | null; erp_name: string | null;
  docstatus: number | null; verified_at: number | null;
  outcome: string; created_at: number;
}

const s = (v: unknown): string => String(v);
const ns = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dt = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
const hop = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });
const rowKey = (learner: string, site: string, key: string) => [learner, site, key].join('\u0000');

function rlsWrite(table: string): PgFakeError {
  return new PgFakeError('42501',
    'new row violates row-level security policy for table "' + table + '"');
}

/**
 * 一个进程内的假库。多个 connect() 出来的连接共享它 —— 这就是「两个网关进程
 * 连同一个库」在测试里的样子。
 */
class FakePostgres {
  readonly ledgerRows = new Map<string, LedgerRecord>();
  readonly auditRows: AuditRecord[] = [];
  /** 语句流水。用来证明 adapter 没有偷偷发第二条写语句。 */
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  /** 库的时钟。now() 在库里，不在应用里。 */
  now: () => number = () => Date.now();

  private tail = new Map<string, Promise<void>>();
  private seq = 0;

  connect(role: Role = 'service_role'): PgClient {
    const db = this;
    return {
      async query<R>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<R>> {
        await hop();                       // 一次网络往返，并发在这儿交错
        const out = await db.exec(role, sql, params);
        return out as unknown as PgQueryResult<R>;
      },
    };
  }

  statements(): string[] { return this.calls.map((c) => c.sql); }

  private async exec(
    role: Role, raw: string, params: readonly unknown[],
  ): Promise<PgQueryResult<Record<string, unknown>>> {
    const sql = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    this.calls.push({ sql, params });

    if (/^select .* from erp_reserve\(/.test(sql)) return this.reserve(role, params);
    if (/^select erp_settle\(/.test(sql)) return this.settleRow(role, params);
    if (/^select .* from erp_idempotency_ledger where learner_id/.test(sql))
      return this.readOne(role, params);
    if (/^select .* from erp_idempotency_ledger where state = 'uncertain'/.test(sql))
      return this.readUncertain(role);
    if (/^insert into erp_idempotency_ledger/.test(sql))
      return this.rawInsertLedger(role, sql, params);

    if (/^insert into erp_audit/.test(sql)) return this.insertAudit(role, params);
    if (/^select .* from erp_audit where run_id/.test(sql))
      return this.readAudit(role, (r) => r.run_id === s(params[0]));
    if (/^select .* from erp_audit where erp_doctype/.test(sql))
      return this.readAudit(role, (r) =>
        r.erp_doctype === s(params[0]) && r.erp_name === s(params[1]));

    // store/audit.sql 的两条 rule。重写之后语句是空的，谁发都一样：
    // 不抛异常，rowCount 0，一行都不动。
    if (/^update erp_audit/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^delete from erp_audit/.test(sql)) return { rows: [], rowCount: 0 };

    throw new PgFakeError('42601', '这个 fake 不认识这条语句：' + sql.slice(0, 80));
  }

  // ── 台账 ──

  private async reserve(
    role: Role, p: readonly unknown[],
  ): Promise<PgQueryResult<Record<string, unknown>>> {
    if (role !== 'service_role') throw rlsWrite('erp_idempotency_ledger');
    const learner = s(p[0]); const site = s(p[1]); const key = s(p[2]);
    const cap = s(p[3]); const owner = s(p[4]); const leaseMs = Number(p[5]);
    const k = rowKey(learner, site, key);

    // 第一段：占位。下面这几行里一个 await 都没有 —— 它就是那条
    // insert ... on conflict do nothing。
    const t = this.now();
    const fresh: LedgerRecord = {
      learner_id: learner, site_id: site, key, capability: cap,
      state: 'reserved', lease_until: t + leaseMs, lease_owner: owner,
      erp_doctype: null, erp_name: null, attempts: 1, created_at: t, updated_at: t,
    };
    if (this.insertLedger(fresh, true) === 1) return reserved('acquired', fresh);

    // 第二段：行已经在了。select ... for update 上锁，锁到手再读状态。
    const unlock = await this.lockRow(k);
    try {
      const row = this.ledgerRows.get(k);
      if (!row) {            // 行在两段之间被删了。真库里 for update 看不到这种情况
        this.insertLedger(fresh, true);
        return reserved('acquired', fresh);
      }
      if (row.state === 'succeeded') return reserved('duplicate', row);
      if (row.state === 'uncertain') return reserved('in_flight', row);

      const alive = row.lease_until !== null && row.lease_until > this.now();
      if (row.state !== 'failed' && alive) return reserved('in_flight', row);

      row.state = 'reserved';
      row.lease_until = this.now() + leaseMs;
      row.lease_owner = owner;
      row.attempts += 1;
      row.updated_at = this.now();
      return reserved('recovered', row);
    } finally {
      unlock();
    }
  }

  /** 唯一约束。ignoreConflict 就是 `on conflict (…) do nothing` 那半句。 */
  private insertLedger(rec: LedgerRecord, ignoreConflict: boolean): number {
    const k = rowKey(rec.learner_id, rec.site_id, rec.key);
    if (this.ledgerRows.has(k)) {
      if (ignoreConflict) return 0;
      throw new PgFakeError('23505',
        'duplicate key value violates unique constraint "erp_idempotency_ledger_pkey"');
    }
    this.ledgerRows.set(k, rec);
    return 1;
  }

  /** 行锁。排队等前一个持有者放手，等到了才轮到自己读写。 */
  private async lockRow(k: string): Promise<() => void> {
    const prev = this.tail.get(k) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => { release = r; });
    this.tail.set(k, prev.then(() => mine));
    await prev;
    return release;
  }

  private settleRow(
    role: Role, p: readonly unknown[],
  ): PgQueryResult<Record<string, unknown>> {
    if (role !== 'service_role') throw rlsWrite('erp_idempotency_ledger');
    const state = s(p[4]);
    if (!['executing', 'succeeded', 'uncertain', 'failed'].includes(state)) {
      throw new PgFakeError('P0001', '不允许的终态 ' + state);
    }
    const row = this.ledgerRows.get(rowKey(s(p[0]), s(p[1]), s(p[2])));
    // where 上带 lease_owner：不是你的行就命中 0 行，返回 false。
    if (!row || row.lease_owner !== s(p[3])) return { rows: [{ ok: false }], rowCount: 1 };

    row.state = state;
    if (p[5] !== null && p[5] !== undefined) row.erp_doctype = s(p[5]);   // coalesce
    if (p[6] !== null && p[6] !== undefined) row.erp_name = s(p[6]);
    if (state === 'succeeded' || state === 'failed') {
      row.lease_until = null;
      row.lease_owner = null;
    }
    row.updated_at = this.now();
    return { rows: [{ ok: true }], rowCount: 1 };
  }

  private readOne(role: Role, p: readonly unknown[]): PgQueryResult<Record<string, unknown>> {
    if (role !== 'service_role') return { rows: [], rowCount: 0 };   // RLS：零行
    const row = this.ledgerRows.get(rowKey(s(p[0]), s(p[1]), s(p[2])));
    return row ? { rows: [ledgerDbRow(row)], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  private readUncertain(role: Role): PgQueryResult<Record<string, unknown>> {
    if (role !== 'service_role') return { rows: [], rowCount: 0 };
    const rows = [...this.ledgerRows.values()]
      .filter((r) => r.state === 'uncertain')
      .sort((a, b) => a.updated_at - b.updated_at)
      .map(ledgerDbRow);
    return { rows, rowCount: rows.length };
  }

  /** 测试自己用的探针：直接往表里插，看唯一约束怎么表现。 */
  private rawInsertLedger(
    role: Role, sql: string, p: readonly unknown[],
  ): PgQueryResult<Record<string, unknown>> {
    if (role !== 'service_role') throw rlsWrite('erp_idempotency_ledger');
    const t = this.now();
    const rec: LedgerRecord = {
      learner_id: s(p[0]), site_id: s(p[1]), key: s(p[2]), capability: s(p[3]),
      state: 'reserved', lease_until: null, lease_owner: null,
      erp_doctype: null, erp_name: null, attempts: 1, created_at: t, updated_at: t,
    };
    const n = this.insertLedger(rec, /on conflict/.test(sql));
    return { rows: [], rowCount: n };
  }

  // ── 审计 ──

  private insertAudit(role: Role, p: readonly unknown[]): PgQueryResult<Record<string, unknown>> {
    if (role !== 'service_role') throw rlsWrite('erp_audit');
    this.seq += 1;
    const rec: AuditRecord = {
      id: 'aud-' + String(this.seq).padStart(4, '0'),
      learner_id: s(p[0]), site_id: s(p[1]), run_id: s(p[2]),
      approval_id: ns(p[3]), idempotency_key: ns(p[4]),
      capability: s(p[5]), args_digest: s(p[6]),
      erp_doctype: ns(p[7]), erp_name: ns(p[8]),
      docstatus: p[9] === null || p[9] === undefined ? null : Number(p[9]),
      verified_at: p[10] === null || p[10] === undefined ? null : Date.parse(s(p[10])),
      outcome: s(p[11]),
      created_at: this.now(),
    };
    this.auditRows.push(rec);
    return { rows: [auditDbRow(rec)], rowCount: 1 };
  }

  private readAudit(
    role: Role, keep: (r: AuditRecord) => boolean,
  ): PgQueryResult<Record<string, unknown>> {
    if (role !== 'service_role') return { rows: [], rowCount: 0 };
    const rows = this.auditRows.filter(keep)
      .sort((a, b) => a.created_at - b.created_at)
      .map(auditDbRow);
    return { rows, rowCount: rows.length };
  }
}

function reserved(outcome: string, r: LedgerRecord): PgQueryResult<Record<string, unknown>> {
  return {
    rows: [{
      out_outcome: outcome, out_state: r.state,
      out_lease_until: dt(r.lease_until), out_lease_owner: r.lease_owner,
      out_erp_doctype: r.erp_doctype, out_erp_name: r.erp_name,
      out_attempts: r.attempts,
    }],
    rowCount: 1,
  };
}

function ledgerDbRow(r: LedgerRecord): Record<string, unknown> {
  return {
    learner_id: r.learner_id, site_id: r.site_id, key: r.key, capability: r.capability,
    state: r.state, lease_until: dt(r.lease_until), lease_owner: r.lease_owner,
    erp_doctype: r.erp_doctype, erp_name: r.erp_name, attempts: r.attempts,
    created_at: new Date(r.created_at), updated_at: new Date(r.updated_at),
  };
}

function auditDbRow(r: AuditRecord): Record<string, unknown> {
  return {
    ...r,
    verified_at: dt(r.verified_at),
    created_at: new Date(r.created_at),
  };
}

// ── 夹具 ────────────────────────────────────────────────────────

const persona = { name: 'agent-buyer', allowedDocTypes: PERSONA_DOCTYPES };
const alice: Principal = { learnerId: 'learner-alice', siteId: 'site-a', persona };
const bob: Principal = { learnerId: 'learner-bob', siteId: 'site-a', persona };
const aliceSiteB: Principal = { learnerId: 'learner-alice', siteId: 'site-b', persona };

const CAP: Capability = 'erp.create_draft';
const LEASE = 5_000;
const T0 = 1_760_000_000_000;

function stack() {
  const db = new FakePostgres();
  let clock = T0;
  db.now = () => clock;
  return {
    db,
    ledger: new PostgresLedger(db.connect()),
    audit: new PostgresAudit(db.connect()),
    advance: (ms: number) => { clock += ms; },
  };
}

const entry = (over: Partial<AuditEntry> = {}): Omit<AuditEntry, 'id' | 'createdAt'> => ({
  learnerId: alice.learnerId, siteId: alice.siteId, runId: 'run-1',
  approvalId: null, idempotencyKey: 'k-1', capability: 'erp.create_draft',
  argsDigest: 'sha256:abcd', erpDoctype: 'Purchase Order', erpName: 'PUR-ORD-9999-09999',
  docstatus: 0, verifiedAt: null, outcome: 'done', ...over,
});

const RAW_INSERT = `insert into erp_idempotency_ledger
  (learner_id, site_id, key, capability) values ($1, $2, $3, $4)`;

// ── fake 自检 ───────────────────────────────────────────────────

describe('fake 库自身的语义（这三条不成立，下面的断言都不算数）', () => {
  it('on conflict do nothing：撞了不抛，行数返回 0，原行不动', async () => {
    const { db } = stack();
    const conn = db.connect();
    const sql = RAW_INSERT + ' on conflict (learner_id, site_id, key) do nothing';

    const first = await conn.query(sql, ['learner-alice', 'site-a', 'k', 'erp.submit']);
    expect(first.rowCount).toBe(1);

    const second = await conn.query(sql, ['learner-alice', 'site-a', 'k', 'erp.create_draft']);
    expect(second.rowCount, '撞了就是没插进去').toBe(0);

    expect(db.ledgerRows.size).toBe(1);
    expect([...db.ledgerRows.values()][0]?.capability, '原行一个字节不变').toBe('erp.submit');
  });

  it('去掉 on conflict，同一句话撞唯一约束就抛 23505', async () => {
    const { db } = stack();
    const conn = db.connect();
    await conn.query(RAW_INSERT, ['learner-alice', 'site-a', 'k', 'erp.submit']);

    const boom = conn.query(RAW_INSERT, ['learner-alice', 'site-a', 'k', 'erp.submit']);
    await expect(boom).rejects.toMatchObject({ code: '23505' });
  });

  it('audit.sql 的 rule：对 erp_audit 的 update / delete 静默无效', async () => {
    const { db, audit } = stack();
    const conn = db.connect();
    const written = await audit.append(entry());

    const upd = await conn.query(
      "update erp_audit set outcome = 'denied' where id = $1", [written.id]);
    const del = await conn.query('delete from erp_audit where id = $1', [written.id]);

    expect(upd.rowCount, 'rule 重写之后没有东西可执行').toBe(0);
    expect(del.rowCount).toBe(0);

    const back = await audit.byRun('run-1');
    expect(back).toHaveLength(1);
    expect(back[0]?.outcome, '改不动').toBe('done');
  });
});

// ── 台账 ────────────────────────────────────────────────────────

describe('PostgresLedger', () => {
  it('占位是一条语句：adapter 从头到尾没有自己发过 insert / update 台账', async () => {
    const { db, ledger } = stack();
    const r = await ledger.reserve(alice, 'k-1', CAP, 'owner-a', LEASE);
    expect(r.outcome).toBe('acquired');

    const sent = db.statements();
    expect(sent[0], '第一条就是原子占位').toMatch(/^select .* from erp_reserve\(/);
    expect(sent.filter((x) => /^insert into erp_idempotency_ledger/.test(x)),
      '应用层自己 insert 就是 check-then-set 的开始').toEqual([]);
    expect(sent.filter((x) => /^update erp_idempotency_ledger/.test(x)),
      '状态推进也只走 erp_settle()').toEqual([]);
    expect(sent.filter((x) => /erp_reserve\(/.test(x)), '占位只发一次').toHaveLength(1);
    expect(sent[1], '第二条是纯读，占位那一刻已经结束了').toMatch(/^select /);
  });

  it('首次 reserve 拿到租约，同一个键在租约内的第二次是 in_flight', async () => {
    const { ledger } = stack();
    const first = await ledger.reserve(alice, 'k-1', CAP, 'owner-a', LEASE);
    expect(first.outcome).toBe('acquired');
    expect(first.row.state).toBe('reserved');
    expect(first.row.leaseOwner).toBe('owner-a');
    expect(first.row.attempts).toBe(1);
    expect(first.row.createdAt).toBe(T0);

    const second = await ledger.reserve(alice, 'k-1', CAP, 'owner-b', LEASE);
    expect(second.outcome).toBe('in_flight');
    expect(second.row.leaseOwner, '租约还在 owner-a 手上').toBe('owner-a');
  });

  it('作用域是 (learner, site, key) 三元组：换人或换 site 各建各的', async () => {
    const { ledger } = stack();
    expect((await ledger.reserve(alice, 'same', CAP, 'o1', LEASE)).outcome).toBe('acquired');
    expect((await ledger.reserve(bob, 'same', CAP, 'o2', LEASE)).outcome).toBe('acquired');
    expect((await ledger.reserve(aliceSiteB, 'same', CAP, 'o3', LEASE)).outcome).toBe('acquired');

    // 三行互不影响，各读各的。
    expect((await ledger.get(alice, 'same'))?.leaseOwner).toBe('o1');
    expect((await ledger.get(bob, 'same'))?.leaseOwner).toBe('o2');
    expect((await ledger.get(aliceSiteB, 'same'))?.leaseOwner).toBe('o3');

    // 同一个人同一个 site 的同一个键，第四次就撞上了。
    expect((await ledger.reserve(alice, 'same', CAP, 'o4', LEASE)).outcome).toBe('in_flight');
  });

  it('成功之后是 duplicate，并且把当初那个单号原样带回来', async () => {
    const { ledger } = stack();
    const ref: ErpRef = { doctype: 'Purchase Order', name: 'PUR-ORD-9999-09999' };
    await ledger.reserve(alice, 'k-1', CAP, 'owner-a', LEASE);
    await ledger.begin(alice, 'k-1', 'owner-a');
    await ledger.succeed(alice, 'k-1', 'owner-a', ref);

    const again = await ledger.reserve(alice, 'k-1', CAP, 'owner-b', LEASE);
    expect(again.outcome).toBe('duplicate');
    expect(again.row.erpRef, '拿不到单号的去重等于没做').toEqual(ref);
    expect(again.row.state).toBe('succeeded');
  });

  it('uncertain 的行不许被重新领回 —— 租约早过期了也还是 in_flight', async () => {
    const { ledger, advance } = stack();
    await ledger.reserve(alice, 'k-1', CAP, 'owner-a', LEASE);
    await ledger.markUncertain(alice, 'k-1', 'owner-a', { doctype: 'Purchase Order', name: 'PUR-ORD-9999-09998' });

    advance(LEASE * 10);
    const again = await ledger.reserve(alice, 'k-1', CAP, 'owner-b', LEASE);
    expect(again.outcome, '自动重试等于把不确定抹平成成功').toBe('in_flight');
    expect(again.row.state).toBe('uncertain');
    expect(again.row.attempts, '没被领回，次数不涨').toBe(1);

    const pending = await ledger.listUncertain();
    expect(pending.map((x) => x.key)).toEqual(['k-1']);
  });

  it('租约过期才领得回来，attempts 加一', async () => {
    const { ledger, advance } = stack();
    await ledger.reserve(alice, 'k-1', CAP, 'owner-a', LEASE);
    advance(LEASE + 1);

    const taken = await ledger.reserve(alice, 'k-1', CAP, 'owner-b', LEASE);
    expect(taken.outcome).toBe('recovered');
    expect(taken.row.leaseOwner).toBe('owner-b');
    expect(taken.row.attempts).toBe(2);
  });

  it('租约归属在库里判：不是你的行你改不动，而且行的状态不受影响', async () => {
    const { ledger } = stack();
    await ledger.reserve(alice, 'k-1', CAP, 'owner-a', LEASE);

    await expect(
      ledger.succeed(alice, 'k-1', 'owner-b', { doctype: 'Purchase Order', name: 'PUR-ORD-9999-09997' }),
    ).rejects.toThrow(/租约不属于你/);

    const row = await ledger.get(alice, 'k-1');
    expect(row?.state, '超时的旧持有者醒过来也覆盖不了').toBe('reserved');
    expect(row?.erpRef).toBeNull();

    // 真正的持有者照样能推进。
    await ledger.succeed(alice, 'k-1', 'owner-a', { doctype: 'Purchase Order', name: 'PUR-ORD-9999-09996' });
    expect((await ledger.get(alice, 'k-1'))?.state).toBe('succeeded');
  });

  it('20 个同键并发，恰好一个 acquired，其余 in_flight', async () => {
    const { db, ledger } = stack();
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ledger.reserve(alice, 'burst', CAP, 'owner-' + i, LEASE)),
    );

    const acquired = all.filter((r) => r.outcome === 'acquired');
    expect(acquired).toHaveLength(1);
    expect(all.filter((r) => r.outcome === 'in_flight')).toHaveLength(19);
    expect(db.ledgerRows.size, '台账里只该有一行').toBe(1);

    // 19 个失败者看到的持有者是同一个，也就是那个赢家。
    const owners = new Set(all.map((r) => r.row.leaseOwner));
    expect(owners.size).toBe(1);
    expect([...owners][0]).toBe(acquired[0]?.row.leaseOwner);
  });

  it('negative-control：同一个 fake 上，check-then-set 的占位照样漏', async () => {
    // 上面那条测试要有意义，前提是这个 fake 真的能让并发交错。
    // 拿 check-then-set 喂给它 —— 先 select 看一眼，再 insert，中间隔一次往返。
    const { db } = stack();
    const conn = db.connect();
    const bad = async (owner: string): Promise<string> => {
      const seen = await conn.query(
        'select key from erp_idempotency_ledger where learner_id = $1 and site_id = $2 and key = $3',
        [alice.learnerId, alice.siteId, 'leaky'],
      );
      if (seen.rows.length > 0) return 'in_flight';
      await conn.query(RAW_INSERT + ' on conflict (learner_id, site_id, key) do nothing',
        [alice.learnerId, alice.siteId, 'leaky', CAP]);
      return 'acquired:' + owner;
    };

    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => bad('o-' + i)));
    const won = all.filter((x) => x.startsWith('acquired'));

    expect(won.length, '扫描器报不出问题就说明它没在扫').toBeGreaterThan(1);
    // 唯一约束确实只留下一行 —— 挡住了「两条记录」，没挡住「20 个都以为自己是新的」。
    // 那 20 个 acquired 在真实世界里就是 20 张发给供应商的采购单。
    expect(db.ledgerRows.size).toBe(1);
  });

  it('两个独立 adapter 实例共享一个库（两个进程），同键并发也只有一个拿到', async () => {
    const db = new FakePostgres();
    let clock = T0;
    db.now = () => clock;

    // 各连各的 —— 两条连接，两个 PostgresLedger，共用一份状态。
    const nodeA = new PostgresLedger(db.connect());
    const nodeB = new PostgresLedger(db.connect());

    const all = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => nodeA.reserve(alice, 'x', CAP, 'a-' + i, LEASE)),
      ...Array.from({ length: 10 }, (_, i) => nodeB.reserve(alice, 'x', CAP, 'b-' + i, LEASE)),
    ]);

    expect(all.filter((r) => r.outcome === 'acquired')).toHaveLength(1);
    expect(db.ledgerRows.size).toBe(1);

    // 租约过期之后再来一轮，同样只有一个领得回去。
    clock += LEASE + 1;
    const round2 = await Promise.all([
      nodeA.reserve(alice, 'x', CAP, 'a-late', LEASE),
      nodeB.reserve(alice, 'x', CAP, 'b-late', LEASE),
    ]);
    expect(round2.filter((r) => r.outcome === 'recovered'),
      '两个同时读到「租约过期」是行锁要挡的那件事').toHaveLength(1);
    expect(round2.filter((r) => r.outcome === 'in_flight')).toHaveLength(1);
  });

  it('键是绑定参数，不是拼进 SQL 的字符串', async () => {
    const { db, ledger } = stack();
    const nasty = "k'); drop table erp_audit; --";
    const r = await ledger.reserve(alice, nasty, CAP, 'owner-a', LEASE);

    expect(r.outcome).toBe('acquired');
    expect(r.row.key).toBe(nasty);
    // 语句文本里不该出现键的内容，它只在 params 里。
    for (const c of db.calls) expect(c.sql).not.toContain('drop table');
    expect(db.calls.some((c) => c.params.includes(nasty))).toBe(true);
    // 别的键不受影响。
    expect((await ledger.reserve(alice, 'k-clean', CAP, 'owner-a', LEASE)).outcome).toBe('acquired');
  });
});

// ── 审计 ────────────────────────────────────────────────────────

describe('PostgresAudit', () => {
  it('双向可查：byRun 拿到这次跑了什么，byErpRef 从单据反查回来', async () => {
    const { audit } = stack();
    const ref: ErpRef = { doctype: 'Purchase Order', name: 'PUR-ORD-9999-09995' };
    await audit.append(entry({ capability: 'erp.query', erpDoctype: null, erpName: null, outcome: 'done' }));
    const written = await audit.append(entry({
      erpDoctype: ref.doctype, erpName: ref.name, docstatus: 1,
      approvalId: 'apr-7', verifiedAt: T0 + 500, outcome: 'done',
    }));

    const forward = await audit.byRun('run-1');
    expect(forward).toHaveLength(2);

    const backward = await audit.byErpRef(ref);
    expect(backward.map((x) => x.id)).toEqual([written.id]);
    expect(backward[0]?.runId).toBe('run-1');
    expect(backward[0]?.approvalId).toBe('apr-7');
    expect(backward[0]?.idempotencyKey).toBe('k-1');
    expect(backward[0]?.verifiedAt, 'timestamptz 要还原成毫秒').toBe(T0 + 500);
    expect(backward[0]?.docstatus).toBe(1);
  });

  it('接口面上没有改和删 —— 连方法都不存在', () => {
    const { audit } = stack();
    const face = audit as unknown as Record<string, unknown>;
    for (const m of ['update', 'delete', 'patch', 'remove', 'truncate', 'rewrite', 'set']) {
      expect(typeof face[m], 'AuditLedger 上不该有 ' + m + '()').not.toBe('function');
    }
    expect(typeof face.append).toBe('function');
    expect(typeof face.byRun).toBe('function');
    expect(typeof face.byErpRef).toBe('function');
  });

  it('归属由服务端填：绑定过的面上根本没有 learner / site / run 的入口', async () => {
    const { audit } = stack();
    const scoped = audit.forPrincipal(alice, 'run-real');

    // 硬把身份塞进去。类型上塞不进去（ScopedAuditEntry 里没有这几个键），
    // 所以这里得先绕过类型 —— 绕过之后落库的仍然是 Principal 那一份。
    const spoofed = {
      approvalId: null, idempotencyKey: 'k-9', capability: 'erp.submit',
      argsDigest: 'sha256:ffff', erpDoctype: null, erpName: null,
      docstatus: null, verifiedAt: null, outcome: 'denied',
      learnerId: 'learner-evil', siteId: 'site-evil', runId: 'run-evil',
    } as unknown as ScopedAuditEntry;

    const written = await scoped.append(spoofed);
    expect(written.learnerId).toBe('learner-alice');
    expect(written.siteId).toBe('site-a');
    expect(written.runId).toBe('run-real');

    expect(await audit.byRun('run-evil')).toEqual([]);
    expect(await audit.byRun('run-real')).toHaveLength(1);
  });

  it('对象上多带的字段进不了绑定参数，也就进不了库', async () => {
    const { db, audit } = stack();
    await audit.append({
      ...entry(),
      erpUser: 'someone-else', persona: 'privileged', extra: 'ignored',
    } as unknown as Omit<AuditEntry, 'id' | 'createdAt'>);

    const insert = db.calls.find((c) => c.sql.startsWith('insert into erp_audit'));
    expect(insert).toBeTruthy();
    expect(insert?.params).toHaveLength(12);
    for (const junk of ['someone-else', 'privileged', 'ignored']) {
      expect(insert?.params.includes(junk), junk + ' 不该有入口').toBe(false);
    }
    expect(db.auditRows[0]?.learner_id).toBe('learner-alice');
  });

  it('归属为空直接炸，不写一条查不出来源的审计', async () => {
    const { db, audit } = stack();
    await expect(audit.append(entry({ runId: '' }))).rejects.toThrow(/审计缺归属/);
    await expect(audit.append(entry({ learnerId: '   ' }))).rejects.toThrow(/审计缺归属/);
    expect(db.auditRows).toHaveLength(0);
  });
});

// ── 连接隔离 ────────────────────────────────────────────────────

describe('学员那一侧的角色拿不到能写审计 / 台账的连接', () => {
  it('anon / authenticated 角色：写抛 42501，读零行', async () => {
    const db = new FakePostgres();
    db.now = () => T0;

    // 服务角色先写一条，证明表里确实有东西。
    const server = new PostgresAudit(db.connect('service_role'));
    await server.append(entry());
    expect(await server.byRun('run-1')).toHaveLength(1);

    // 同一个库，换成学员令牌落到的那个角色。
    const asLearner = new PostgresAudit(db.connect('authenticated'));
    await expect(asLearner.append(entry())).rejects.toMatchObject({ code: '42501' });
    expect(await asLearner.byRun('run-1'), 'RLS 开着且没有 policy = 零行可见').toEqual([]);
    expect(await asLearner.byErpRef({ doctype: 'Purchase Order', name: 'PUR-ORD-9999-09999' })).toEqual([]);

    // 台账同理。
    const ledgerAsLearner = new PostgresLedger(db.connect('authenticated'));
    await expect(ledgerAsLearner.reserve(alice, 'k', CAP, 'o', LEASE))
      .rejects.toMatchObject({ code: '42501' });
    expect(await ledgerAsLearner.listUncertain()).toEqual([]);

    // 服务角色那一条还在，没被影响。
    expect(db.auditRows).toHaveLength(1);
  });
});

// ── 真库（默认跳过）───────────────────────────────────────────────
//
// 这个仓库不带数据库驱动依赖，package.json 是冻结的，所以真库那一组不能
// 在这里 import 驱动。要跑的话，在平台仓库里把一个满足 PgClient 的连接挂上来：
//
//   globalThis.__w12PgClient = pool;   // 已经 apply 过 store/schema.sql + audit.sql
//
// 挂上了就跑，没挂就跳过 —— 本机唯一在跑的 Postgres 属于别的项目，不往里写东西。

const livePg = (globalThis as Record<string, unknown>).__w12PgClient as PgClient | undefined;

describe('真库（挂了连接才跑）', () => {
  it.skipIf(!livePg)('reserve → succeed → duplicate 在真 Postgres 上也是这个结果', async () => {
    const conn = livePg as PgClient;
    const ledger = new PostgresLedger(conn);
    const key = 'live-' + Date.now();
    const ref: ErpRef = { doctype: 'Purchase Order', name: 'PUR-ORD-9999-09994' };

    expect((await ledger.reserve(alice, key, CAP, 'owner-a', LEASE)).outcome).toBe('acquired');
    expect((await ledger.reserve(alice, key, CAP, 'owner-b', LEASE)).outcome).toBe('in_flight');
    await ledger.succeed(alice, key, 'owner-a', ref);

    const again = await ledger.reserve(alice, key, CAP, 'owner-b', LEASE);
    expect(again.outcome).toBe('duplicate');
    expect(again.row.erpRef).toEqual(ref);
  });
});
