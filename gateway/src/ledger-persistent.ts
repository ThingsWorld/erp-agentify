// 持久幂等台账（Task 06）。落盘，**跨进程**，进程重启后仍去重。
//
// 为什么不用 SQLite：学员环境要 `npm ci` 之后立刻能跑，原生模块在 Windows 上
// 需要构建工具链。文件系统的排他创建（open 带 'wx'）在 Windows 和 POSIX 上
// 都是原子的，零依赖，而且这一课要教的正是「原子占位」本身。
//
// reserve 的检查、占位与恢复均在同一个排他文件锁中完成。
// 记录通过临时文件 + 原子 rename 发布，其他进程不会读到半份 JSON。

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  Capability, ErpRef, Ledger, LedgerRow, LedgerState, Principal, ReserveOutcome,
} from './types.js';

/** 锁文件超过这个岁数就认为持有者死了，可以抢。 */
const STALE_LOCK_MS = 5_000;

function slug(p: Principal, key: string): string {
  // 键里可能有 / 和中文，不能直接当文件名。作用域是三元组，所以三样都进哈希。
  return createHash('sha256').update([p.learnerId, p.siteId, key].join('\u0000')).digest('hex').slice(0, 32);
}

export class PersistentLedger implements Ledger {
  constructor(private dir: string, private now: () => number = Date.now) {
    mkdirSync(this.dir, { recursive: true });
  }

  private file(p: Principal, key: string): string { return join(this.dir, slug(p, key) + '.json'); }

  private read(path: string): LedgerRow | null {
    try { return JSON.parse(readFileSync(path, 'utf8')) as LedgerRow; }
    catch { return null; }
  }

  /** 写临时文件再 rename —— rename 在同一分区上是原子的。 */
  private write(path: string, row: LedgerRow): void {
    const tmp = path + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(row), 'utf8');
    renameSync(tmp, path);
  }

  /** 拿临界区。拿不到返回 false —— 调用方据此判 in_flight，不阻塞等待。 */
  private lock(path: string): boolean {
    const lp = path + '.lock';
    try {
      closeSync(openSync(lp, 'wx'));
      return true;
    } catch {
      // 持有者可能已经死了。锁太旧就抢一次。
      try {
        if (this.now() - statSync(lp).mtimeMs > STALE_LOCK_MS) {
          rmSync(lp, { force: true });
          closeSync(openSync(lp, 'wx'));
          return true;
        }
      } catch { /* 抢锁失败，按拿不到处理 */ }
      return false;
    }
  }

  private unlock(path: string): void { rmSync(path + '.lock', { force: true }); }

  async reserve(p: Principal, key: string, cap: Capability, owner: string, leaseMs: number): Promise<ReserveOutcome> {
    const path = this.file(p, key);
    const t = this.now();
    const fresh: LedgerRow = {
      learnerId: p.learnerId, siteId: p.siteId, key, capability: cap,
      state: 'reserved', leaseUntil: t + leaseMs, leaseOwner: owner,
      erpRef: null, attempts: 1, createdAt: t, updatedAt: t,
    };

    // 原子排他创建锁文件；只有锁持有者能检查并发布占位记录。
    if (!this.lock(path)) {
      const row = this.read(path) ?? fresh;
      return { outcome: 'in_flight', row };
    }
    try {
      if (!existsSync(path)) {
        this.write(path, fresh);
        return { outcome: 'acquired', row: fresh };
      }
      const row = this.read(path);
      if (!row) throw new Error('台账记录损坏，停止执行并等待人工核查：' + key);
      if (row.state === 'succeeded') return { outcome: 'duplicate', row };
      // uncertain 是唯一不允许自动重试的终态。
      if (row.state === 'uncertain') return { outcome: 'in_flight', row };

      const leaseAlive = row.leaseUntil !== null && row.leaseUntil > t;
      if (leaseAlive && row.state !== 'failed') return { outcome: 'in_flight', row };

      const taken: LedgerRow = {
        ...row, state: 'reserved', leaseUntil: t + leaseMs, leaseOwner: owner,
        attempts: row.attempts + 1, updatedAt: t,
      };
      this.write(path, taken);
      return { outcome: 'recovered', row: taken };
    } finally {
      this.unlock(path);
    }
  }

  private async transition(
    p: Principal, key: string, owner: string, state: LedgerState, ref?: ErpRef | null,
  ): Promise<void> {
    const path = this.file(p, key);
    if (!this.lock(path)) throw new Error('台账正被别的进程改，稍后重试：' + key);
    try {
      const row = this.read(path);
      if (!row) throw new Error('台账里没有这个键：' + key);
      if (row.leaseOwner !== owner) throw new Error('租约不属于你，不能改这一行');
      const next: LedgerRow = {
        ...row, state, updatedAt: this.now(),
        erpRef: ref !== undefined ? ref : row.erpRef,
        leaseUntil: state === 'succeeded' || state === 'failed' ? null : row.leaseUntil,
      };
      this.write(path, next);
    } finally {
      this.unlock(path);
    }
  }

  async begin(p: Principal, key: string, owner: string) { await this.transition(p, key, owner, 'executing'); }
  async succeed(p: Principal, key: string, owner: string, ref: ErpRef) { await this.transition(p, key, owner, 'succeeded', ref); }
  async markUncertain(p: Principal, key: string, owner: string, ref: ErpRef | null) { await this.transition(p, key, owner, 'uncertain', ref); }
  async fail(p: Principal, key: string, owner: string) { await this.transition(p, key, owner, 'failed'); }

  async get(p: Principal, key: string): Promise<LedgerRow | null> {
    return this.read(this.file(p, key));
  }

  async listUncertain(): Promise<LedgerRow[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(join(this.dir, f)))
      .filter((r): r is LedgerRow => r !== null && r.state === 'uncertain');
  }
}
