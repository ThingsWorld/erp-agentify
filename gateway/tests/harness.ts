// 测试侧的装配入口。**只是转发** —— 真正的装配台在 src/harness.ts。
//
// 为什么要有这一层：测试里写 `from './harness.js'` 比写
// `from '../src/harness.js'` 短，而且以后要给测试加专用的小工具时，
// 加在这里就行，不用去动生产代码那一份。

export { makeRig, makeLiveRig } from '../src/harness.js';
export type { Rig, RigOptions } from '../src/harness.js';

import { makeRig, type Rig, type RigOptions } from '../src/harness.js';
import type { AuditEntry, DocType } from '../src/types.js';

/**
 * 起一个 rig，跑完自动清理。
 *
 * 用它而不是手写 try/finally —— 测试挂了也要把临时目录删掉，
 * 不然 .ledger 会在 tmp 里越堆越多。
 */
export async function withRig<T>(opts: RigOptions, fn: (rig: Rig) => Promise<T>): Promise<T> {
  const rig = makeRig(opts);
  try { return await fn(rig); } finally { rig.cleanup(); }
}

/** 本次 run 的审计。断言安全维度时用它，**不要**去读 Agent 说了什么。 */
export async function auditOf(rig: Rig): Promise<AuditEntry[]> {
  return rig.audit.byRun(rig.runId);
}

/** 某个 DocType 现在有几条。并发与清理断言的核心。 */
export function countDocs(rig: Rig, dt: DocType): number {
  if (!rig.mock) throw new Error('countDocs 只在 mock 模式下可用');
  return rig.mock.count(rig.site, dt);
}

/** 相对基线新增了哪些单号。**不要写死具体号** —— 号由宿主分配。 */
export function newNames(rig: Rig, dt: DocType, before: readonly string[]): string[] {
  if (!rig.mock) throw new Error('newNames 只在 mock 模式下可用');
  const seen = new Set(before);
  return rig.mock.names(rig.site, dt).filter((n) => !seen.has(n));
}

/** 单号的形状。判据只认它，不认某一个具体号。 */
export const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;
