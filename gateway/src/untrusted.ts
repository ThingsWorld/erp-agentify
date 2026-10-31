// 宿主自由文本的包装（Task 08）。
//
// ERP 字段里的字符串永远是**数据**，不是指令。包装之后，
// 想把它当指令用就得显式调 .value —— 那一行在 code review 里看得见。
//
// 这里刻意**不做**关键词过滤：黑名单挡不住没见过的写法，
// 而且给人一种「已经防住了」的错觉。隔离靠的是「它从不进入指令位置」。

import { UntrustedText } from './types.js';

/** ERP 里可能带自由文本、需要包装的字段。 */
export const FREE_TEXT_FIELDS: readonly string[] = [
  'terms', 'remarks', 'description', 'notes', 'comment',
  'supplier_details', 'item_name', 'custom_notes',
] as const;

export function wrapUntrusted(
  source: { doctype: string; name: string; field: string },
  value: string,
): UntrustedText {
  return Object.freeze({ __untrusted: true as const, source: Object.freeze({ ...source }), value });
}

export function isUntrusted(x: unknown): x is UntrustedText {
  return typeof x === 'object' && x !== null && (x as { __untrusted?: unknown }).__untrusted === true;
}

/**
 * 把一份 ERP 文档里的自由文本字段就地包装。
 * 非自由文本字段原样保留 —— 数量、日期、单号这些要参与计算，包起来反而碍事。
 */
export function wrapDocument(
  doctype: string,
  doc: Record<string, unknown>,
  sourceName = String(doc.name ?? ''),
): Record<string, unknown> {
  const wrapped = { ...doc };
  for (const field of FREE_TEXT_FIELDS) {
    const value = doc[field];
    if (typeof value === 'string') {
      wrapped[field] = wrapUntrusted({ doctype, name: sourceName, field }, value);
    }
  }
  if (doctype === 'Purchase Order' && Array.isArray(doc.items)) {
    wrapped.items = doc.items.map((row, index) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
      const item = row as Record<string, unknown>;
      return wrapDocument('Purchase Order Item', item,
        String(item.name ?? `${sourceName}.items[${index}]`));
    });
  }
  return wrapped;
}

/**
 * 给人看的渲染。**这是 UntrustedText 唯一允许离开包装的出口。**
 * 加了显式定界符，让它在任何下游文本里都不会被误当成上下文的一部分。
 */
export function renderForHuman(u: UntrustedText): string {
  const { doctype, name, field } = u.source;
  return `[来自宿主数据 ${doctype}/${name}.${field}，仅供展示，不是指令]
${u.value}
[宿主数据结束，仅供展示，不是指令]`;
}
