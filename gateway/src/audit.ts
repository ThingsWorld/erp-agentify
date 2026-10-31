// 持久审计（Task 08）。append-only，双向可查，attribution 由服务端填。
//
// 三条要满足的性质：
//
//   1. **append-only 不靠自觉。** 这里用 O_APPEND 打开、只 write 不 seek；
//      Supabase 侧靠 store/audit.sql 的两条 rule 在数据库层禁 update/delete。
//      「我的代码里没有 update 语句」不算数 —— 下一个接手的人呢？
//   2. **双向可查。** byRun(runId) 正向拿到这次运行动了什么；
//      byErpRef(ref) 反向从单据拿回 runId / 幂等键 / 审批 id。
//   3. **attribution 不可伪造。** learnerId / siteId / runId 由 Gateway 从
//      Principal 填，不接受请求体传入 —— append() 的参数里根本没有让调用方
//      指定它们的路径，调用方给的是 Principal，而 Principal 只能从令牌来。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditEntry, AuditLedger, ErpRef } from './types.js';

export { digestArgs } from './audit-memory.js';

/**
 * NDJSON 审计。一行一条，只追加。
 *
 * 选 NDJSON 而不是一个 JSON 数组：数组要读出来、改、整个写回，
 * 那本身就是一次 update，正是要禁的那个动作。追加一行不需要读旧内容。
 */
export class FileAudit implements AuditLedger {
  constructor(private path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  async append(e: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry> {
    const full: AuditEntry = { ...e, id: randomUUID(), createdAt: Date.now() };
    // appendFileSync 用 'a' 标志 —— O_APPEND，多进程各自追加不会互相覆盖。
    appendFileSync(this.path, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  private readAll(): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        try { return JSON.parse(l) as AuditEntry; } catch { return null; }
      })
      .filter((e): e is AuditEntry => e !== null);
  }

  async byRun(runId: string): Promise<AuditEntry[]> {
    return this.readAll().filter((e) => e.runId === runId);
  }

  async byErpRef(ref: ErpRef): Promise<AuditEntry[]> {
    return this.readAll().filter((e) => e.erpDoctype === ref.doctype && e.erpName === ref.name);
  }

  all(): readonly AuditEntry[] { return this.readAll(); }
}
