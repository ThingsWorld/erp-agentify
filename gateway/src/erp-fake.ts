// 内存 ERP。实现 mock/CONTRACT.md 第二、三、四、六节。
//
// 三条不能违反的性质：
//   1. **不做幂等去重**（§2.8）。同一份 doc 连插两次必须出两张单。
//      mock 一去重，task-06 的并发测试就假绿 —— 学员的键写错也照样只出一张。
//   2. **insert 从进入到落库是同步的**。中间插一个 await，20 并发会数出错的张数。
//   3. **不做业务校验**（§1.1）。warehouse 必填、日期先后这些是 live 的事。
//      所以 mock 绿而 live 红是预期内的，不是 bug。

import {
  DocType, ErpClient, ErpFilters, ErpRef, MockControl,
  FaultSwitches, RecordedCall, UpstreamError,
} from './types.js';

interface Doc extends Record<string, unknown> {
  name: string;
  docstatus: number;
}

/** 单据名的正则。§2.4 —— 判据只认这个形状，不认具体号。 */
export const PO_NAME_RE = /^PUR-ORD-(\d{4})-(\d{5})$/;

const key = (site: string, dt: string) => `${site}::${dt}`;

/** docstatus 迁移表（§2.2）。除表里列的，一律禁止。 */
function assertTransition(from: number, to: number, name: string): void {
  const allowed =
    (from === 0 && to === 1) ||   // submit
    (from === 0 && to === 2) ||   // cancel 草稿
    (from === 1 && to === 2);     // cancel 已提交
  if (allowed) return;
  const why =
    from === 2 ? '已作废是终态，不能再改'
    : from === 1 && to === 0 ? '已提交不能改回草稿'
    : from === 1 && to === 1 ? '已提交的不能再提交'
    : `不允许的迁移 ${from} → ${to}`;
  throw new UpstreamError(`${name}: ${why}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeErp implements ErpClient, MockControl {
  /** site::doctype -> name -> doc */
  private tables = new Map<string, Map<string, Doc>>();
  /** 初始快照，reset 用。 */
  private seedSnapshot = new Map<string, Map<string, Doc>>();
  private log: RecordedCall[] = [];
  private counter = new Map<string, number>();   // site -> 下一个序号

  // ── 故障开关（§3）。公开可写字段，一次性，命中即复位。──────────
  public insertThenThrowOnce = false;
  public corruptDocstatusOnce: number | null = null;
  public delayOnce: NonNullable<FaultSwitches['delayOnce']> | null = null;

  private table(site: string, dt: string): Map<string, Doc> {
    const k = key(site, dt);
    let t = this.tables.get(k);
    if (!t) { t = new Map(); this.tables.set(k, t); }
    return t;
  }

  private record(c: Omit<RecordedCall, 'at'>): void {
    this.log.push({ ...c, at: Date.now() });
  }

  /**
   * 同步地读开关、判匹配、复位。返回要睡多久（0 = 不睡）。
   * 复位必须在 await 之前完成，否则并发调用会一起命中同一个开关（§3）。
   */
  private takeDelay(op: NonNullable<FaultSwitches['delayOnce']>['op']): { before: number; after: number } {
    const d = this.delayOnce;
    if (!d || d.op !== op) return { before: 0, after: 0 };
    this.delayOnce = null;
    return d.when === 'before_effect' ? { before: d.ms, after: 0 } : { before: 0, after: d.ms };
  }

  // ── 铺种子 ─────────────────────────────────────────────────────
  seed(site: string, dt: DocType, name: string, fields: Record<string, unknown>, docstatus = 0): void {
    this.table(site, dt).set(name, { ...fields, name, docstatus });
    const m = PO_NAME_RE.exec(name);
    if (m) {
      const n = Number(m[2]);
      this.counter.set(site, Math.max(this.counter.get(site) ?? 0, n));
    }
  }

  /** 种子铺完调一次。之后 reset() 回到这个点。 */
  freezeSeed(): void {
    this.seedSnapshot = new Map(
      [...this.tables].map(([k, t]) => [k, new Map([...t].map(([n, d]) => [n, { ...d }]))]),
    );
    this.seedCounter = new Map(this.counter);
  }
  private seedCounter = new Map<string, number>();

  private nextName(site: string): string {
    const n = (this.counter.get(site) ?? 0) + 1;
    this.counter.set(site, n);
    const year = new Date().getUTCFullYear();
    return `PUR-ORD-${year}-${String(n).padStart(5, '0')}`;
  }

  // ── ErpClient ─────────────────────────────────────────────────
  async list(site: string, persona: string, dt: DocType, filters: ErpFilters = {}): Promise<Record<string, unknown>[]> {
    this.record({ site, persona, op: 'list', doctype: dt });
    const { before, after } = this.takeDelay('list' as never);
    if (before) await sleep(before);
    // 等值 AND。name 与 docstatus 也参与过滤（§2.6）。
    const rows = [...this.table(site, dt).values()]
      .filter((d) => Object.entries(filters).every(([f, v]) => {
        const got = d[f];
        return typeof got === 'number' || typeof v === 'number' ? Number(got) === Number(v) : got === v;
      }))
      .map((d) => ({ ...d }));
    if (after) await sleep(after);
    return rows;
  }

  async get(site: string, persona: string, dt: DocType, name: string): Promise<Record<string, unknown>> {
    this.record({ site, persona, op: 'get', doctype: dt, name });
    const { before, after } = this.takeDelay('get');
    // corruptDocstatusOnce：同步读 + 复位，只污染一次回查（§3.2）。
    const corrupt = this.corruptDocstatusOnce;
    if (corrupt !== null) this.corruptDocstatusOnce = null;
    if (before) await sleep(before);
    const d = this.table(site, dt).get(name);
    if (!d) throw new UpstreamError(`${dt} ${name} not found in site ${site}`);
    const out = { ...d, docstatus: corrupt !== null ? corrupt : Number(d.docstatus) };
    if (after) await sleep(after);
    return out;
  }

  async insert(site: string, persona: string, dt: DocType, doc: Record<string, unknown>): Promise<ErpRef> {
    this.record({ site, persona, op: 'insert', doctype: dt });
    const { before, after } = this.takeDelay('insert');
    // 同步读 + 复位，保证并发时只有先到的那次被注入（§3.1）。
    const willThrow = this.insertThenThrowOnce;
    if (willThrow) this.insertThenThrowOnce = false;

    if (before) await sleep(before);

    // ↓↓↓ 这一段必须同步：分配号 → 落库。中间不许有 await（§2.8）。
    const name = this.nextName(site);
    this.table(site, dt).set(name, { ...doc, name, docstatus: 0 });
    // ↑↑↑

    if (willThrow) {
      // 先落库再抛。反过来就变成普通失败，逼不出 Gateway 的对账分支（§3.1）。
      throw new UpstreamError('ETIMEDOUT', true);
    }
    if (after) await sleep(after);
    return { doctype: dt, name };
  }

  async submit(site: string, persona: string, dt: DocType, name: string): Promise<ErpRef> {
    this.record({ site, persona, op: 'submit', doctype: dt, name });
    const { before, after } = this.takeDelay('submit');
    if (before) await sleep(before);
    const d = this.table(site, dt).get(name);
    if (!d) throw new UpstreamError(`${dt} ${name} not found in site ${site}`);
    assertTransition(Number(d.docstatus), 1, name);
    d.docstatus = 1;
    if (after) await sleep(after);
    return { doctype: dt, name };
  }

  async cancel(site: string, persona: string, dt: DocType, name: string): Promise<void> {
    this.record({ site, persona, op: 'cancel', doctype: dt, name });
    const d = this.table(site, dt).get(name);
    if (!d) throw new UpstreamError(`${dt} ${name} not found in site ${site}`);
    assertTransition(Number(d.docstatus), 2, name);
    d.docstatus = 2;
  }

  async remove(site: string, persona: string, dt: DocType, name: string): Promise<void> {
    this.record({ site, persona, op: 'remove', doctype: dt, name });
    this.table(site, dt).delete(name);
  }

  // ── MockControl（§4、§6）───────────────────────────────────────
  reset(): void {
    this.tables = new Map(
      [...this.seedSnapshot].map(([k, t]) => [k, new Map([...t].map(([n, d]) => [n, { ...d }]))]),
    );
    this.counter = new Map(this.seedCounter);
    this.log = [];
    this.insertThenThrowOnce = false;
    this.corruptDocstatusOnce = null;
    this.delayOnce = null;
  }

  resetSite(site: string): void {
    for (const k of [...this.tables.keys()]) {
      if (!k.startsWith(`${site}::`)) continue;
      const seed = this.seedSnapshot.get(k);
      this.tables.set(k, seed ? new Map([...seed].map(([n, d]) => [n, { ...d }])) : new Map());
    }
    this.counter.set(site, this.seedCounter.get(site) ?? 0);
  }

  /** 按确切单号删。找不到返回 false，不报错。**禁止按时间窗口或业务字段批删。** */
  removeExact(site: string, dt: DocType, name: string): boolean {
    return this.table(site, dt).delete(name);
  }

  calls(): readonly RecordedCall[] { return this.log; }

  setFaults(f: FaultSwitches): void {
    if (f.insertThenThrowOnce !== undefined) this.insertThenThrowOnce = f.insertThenThrowOnce;
    if (f.corruptDocstatusOnce !== undefined) this.corruptDocstatusOnce = f.corruptDocstatusOnce;
    if (f.delayOnce !== undefined) this.delayOnce = f.delayOnce ?? null;
  }

  snapshot(site: string, dt: DocType): Record<string, unknown>[] {
    return [...this.table(site, dt).values()].map((d) => ({ ...d }));
  }

  count(site: string, dt: DocType): number { return this.table(site, dt).size; }
  names(site: string, dt: DocType): string[] { return [...this.table(site, dt).keys()].sort(); }
}
