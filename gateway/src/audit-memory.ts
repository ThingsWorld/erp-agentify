// 内存审计。测试与 mock 模式用。append-only 的语义在这里靠「没有 update / delete 方法」体现。
//
// ⚠ 真实部署要用 audit.ts —— 靠应用自觉不写 update 是不够的，
// 得在存储层禁掉（见 store/audit.sql 的两条 rule）。

import { createHash, randomUUID } from 'node:crypto';
import { AuditEntry, AuditLedger, ErpRef } from './types.js';

/** args 的稳定摘要。键排序后再哈希，字段顺序变了摘要不变。 */
export function digestArgs(args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return 'sha256:' + createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

export class MemoryAudit implements AuditLedger {
  private entries: AuditEntry[] = [];

  async append(e: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry> {
    const full: AuditEntry = { ...e, id: randomUUID(), createdAt: Date.now() };
    this.entries.push(full);
    return full;
  }

  async byRun(runId: string): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.runId === runId);
  }

  async byErpRef(ref: ErpRef): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.erpDoctype === ref.doctype && e.erpName === ref.name);
  }

  /** 只读全量。evaluator 用，学员的代码不该调它。 */
  all(): readonly AuditEntry[] { return this.entries; }
}
