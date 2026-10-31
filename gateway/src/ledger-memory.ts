// 内存幂等台账。**单进程**，测试与 Task 05 之前用。
//
// ⚠ 这不是最终实现。Task 06 要把它换成 ledger-persistent.ts —— 内存 Map 活在进程里，
// 助手重启一次，之前成功过的键一个都不认识。
//
// 但它的**占位段**已经是对的，值得先看懂：
//
//   从进入 reserve() 到写下占位记录之间，一个 await 都没有。
//
// 上一课的实现正好相反：检查与记住之间隔着两个 await，实测 20 并发建出 20 张单。
// 见 reference/lecture-9-approval.ts。

import {
  Capability, ErpRef, Ledger, LedgerRow, LedgerState, Principal, ReserveOutcome,
} from './types.js';

const rowKey = (p: Principal, key: string) => p.learnerId + '\u0000' + p.siteId + '\u0000' + key;

export class MemoryLedger implements Ledger {
  private rows = new Map<string, LedgerRow>();
  constructor(private now: () => number = Date.now) {}

  async reserve(p: Principal, key: string, cap: Capability, owner: string, leaseMs: number): Promise<ReserveOutcome> {
    // ↓↓↓ 同步段开始。这里面不许出现 await。 ↓↓↓
    const k = rowKey(p, key);
    const t = this.now();
    const existing = this.rows.get(k);

    if (!existing) {
      const row: LedgerRow = {
        learnerId: p.learnerId, siteId: p.siteId, key, capability: cap,
        state: 'reserved', leaseUntil: t + leaseMs, leaseOwner: owner,
        erpRef: null, attempts: 1, createdAt: t, updatedAt: t,
      };
      this.rows.set(k, row);
      return { outcome: 'acquired', row };
    }

    if (existing.state === 'succeeded') return { outcome: 'duplicate', row: existing };
    if (existing.state === 'uncertain') return { outcome: 'in_flight', row: existing };

    const leaseAlive = existing.leaseUntil !== null && existing.leaseUntil > t;
    if (leaseAlive && existing.state !== 'failed') return { outcome: 'in_flight', row: existing };

    existing.state = 'reserved';
    existing.leaseUntil = t + leaseMs;
    existing.leaseOwner = owner;
    existing.attempts += 1;
    existing.updatedAt = t;
    return { outcome: 'recovered', row: existing };
    // ↑↑↑ 同步段结束 ↑↑↑
  }

  private transition(p: Principal, key: string, owner: string, state: LedgerState, ref?: ErpRef | null): void {
    const row = this.rows.get(rowKey(p, key));
    if (!row) throw new Error('台账里没有这个键：' + key);
    // 校验持有者，防止别人误改。uncertain 保留归属，便于对账时追到人。
    if (row.leaseOwner !== owner) throw new Error('租约不属于你，不能改这一行');
    row.state = state;
    row.updatedAt = this.now();
    if (ref !== undefined) row.erpRef = ref;
    if (state === 'succeeded' || state === 'failed') row.leaseUntil = null;
  }

  async begin(p: Principal, key: string, owner: string): Promise<void> {
    this.transition(p, key, owner, 'executing');
  }
  async succeed(p: Principal, key: string, owner: string, ref: ErpRef): Promise<void> {
    this.transition(p, key, owner, 'succeeded', ref);
  }
  async markUncertain(p: Principal, key: string, owner: string, ref: ErpRef | null): Promise<void> {
    this.transition(p, key, owner, 'uncertain', ref);
  }
  async fail(p: Principal, key: string, owner: string): Promise<void> {
    this.transition(p, key, owner, 'failed');
  }
  async get(p: Principal, key: string): Promise<LedgerRow | null> {
    return this.rows.get(rowKey(p, key)) ?? null;
  }
  async listUncertain(): Promise<LedgerRow[]> {
    return [...this.rows.values()].filter((r) => r.state === 'uncertain');
  }
}
