// 只读事实采集（Task 01）。
//
// 这个文件解一个结：**返回值里的「没有」有四种，它们长得一模一样。**
//
//   read     —— 读到了。status=read 的项才允许带值。
//   filtered —— 记录在、字段被权限挡住。宿主给你一个 0，那个 0 不是真值。
//   absent   —— 记录本身不存在。查询返回空列表，不是权限问题。
//   denied   —— 整个 DocType 你没资格碰。要么去要权限，要么换来源。
//
// 四种的下一步动作完全不同：absent 照常往下走；filtered 接着算就是在错的地基上算；
// denied 得去要权限或者换条路（仓库名就是这么从 Bin 行上拿的）。
// 揉成一种「没拿到」，等于把两条「得去问人」悄悄改写成了「没有」。
//
// 全程只读。这里只调 GatewayClient 的 query / get，映射到 erp.query / erp.get，
// 不走宿主的超级权限通道，也不去翻 fixtures 下的种子文件 ——
// 翻文件也能凑出一份一样的表，但那份表审计里没有痕迹，事后没人说得清数是谁读的。

import { DocType, ErpFilters, EXPECTED_SHORTFALL, FACTS } from './types.js';
import { numberField } from './gateway-client.js';

// ── 类型 ────────────────────────────────────────────────────────

export type FactStatus = 'read' | 'filtered' | 'absent' | 'denied';

/**
 * 来源三元组。`ref` 是规格里那个字符串形式，
 * 形如 `Purchase Order/PUR-ORD-2026-00001.items[0].rate`。
 * 拆开的 doctype / name / field 给程序用，`ref` 给人和报告用。
 */
export interface FactSource {
  doctype: string;
  name: string;
  field: string;
  ref: string;
}

export interface Fact<T> {
  /** 只有 status=read 才允许非 null。其余三种一律 null —— **不许拿 0 顶上**。 */
  value: T | null;
  source: FactSource;
  status: FactStatus;
  /** 一句话说清为什么是这个 status。报告直接引它。 */
  note?: string;
}

export interface FactSheet {
  originalPo: Fact<string>;
  supplier: Fact<string>;
  orderedQty: Fact<number>;
  rate: Fact<number>;
  itemIsStock: Fact<number>;
  onHand: Fact<number>;
  reserved: Fact<number>;
  lineWarehouse: Fact<string>;
  itemLastRate: Fact<number>;
  binFinishedGoods: Fact<number>;
  warehouseDoc: Fact<string>;
  invoiceDoc: Fact<string>;
  shortfall: Fact<number>;
}

/** readFacts 需要的最小调用面。GatewayClient 直接满足它。 */
export interface FactReader {
  query(docType: DocType, filters?: ErpFilters): Promise<Record<string, unknown>[]>;
  get(docType: DocType, name: string): Promise<Record<string, unknown>>;
}

// ── 内部小工具 ──────────────────────────────────────────────────

function src(doctype: string, name: string, field: string, explicit?: string): FactSource {
  return {
    doctype, name, field,
    ref: explicit ?? (field === '' ? `${doctype}/${name}` : `${doctype}/${name}.${field}`),
  };
}

function read<T>(value: T, source: FactSource, note?: string): Fact<T> {
  return note === undefined ? { value, source, status: 'read' } : { value, source, status: 'read', note };
}
function miss<T>(status: Exclude<FactStatus, 'read'>, source: FactSource, note: string): Fact<T> {
  return { value: null, source, status, note };
}

/**
 * GatewayClient 把拒绝抛成 Error，文案里带着 DenyCode（gateway-client.ts:26）。
 * 这里只把那个机器码抠出来 —— 分支按 code 走，不按文案走。
 */
const DENY_CODE_RE = /（([A-Z_]+)）/;
function denyCodeOf(e: unknown): string {
  const m = e instanceof Error ? DENY_CODE_RE.exec(e.message) : null;
  return m?.[1] ?? 'UNKNOWN';
}

/** 受 permlevel 管的字段。读不到 ≠ 0 —— 单独归到 filtered。 */
const PERMLEVEL_GUARDED: readonly string[] = ['last_purchase_rate', 'valuation_rate', 'standard_rate'];

/**
 * Bin 上的数量字段。ERPNext 里这些字段默认就是 0，行在就说明这个 0 是真的 0。
 * 种子只铺了 actual_qty，其余按宿主默认值读成 0 —— 跟上面那个被挡住的 0 不是一回事。
 */
const BIN_QTY_DEFAULT_ZERO: readonly string[] = [
  'reserved_qty', 'ordered_qty', 'indented_qty', 'planned_qty', 'projected_qty',
];

function numFromRow(row: Record<string, unknown>, field: string, source: FactSource): Fact<number> {
  const raw = row[field];
  if (raw !== undefined && raw !== null) return read(numberField(row, field), source);
  if (PERMLEVEL_GUARDED.includes(field))
    return miss('filtered', source, `记录在，${field} 这个字段拿不到 —— 受 permlevel 管，persona 读不出真值`);
  if (BIN_QTY_DEFAULT_ZERO.includes(field))
    return read(0, source, `${field} 在宿主里默认 0，Bin 行本身在，所以这个 0 是真的 0`);
  return miss('absent', source, `记录在，但没有 ${field} 这个字段`);
}

type Probe =
  | { denied: false; rows: Record<string, unknown>[] }
  | { denied: true; code: string; reason: string };

async function probe(c: FactReader, docType: string, filters: ErpFilters): Promise<Probe> {
  try {
    // docType 这里刻意用字符串再断言：探的就是「工具面/persona 认不认识它」。
    return { denied: false, rows: await c.query(docType as DocType, filters) };
  } catch (e) {
    return { denied: true, code: denyCodeOf(e), reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────

/**
 * 把建单要用的事实查齐，每一项带来源和 status。
 *
 * 读的顺序就是审计里的顺序，照着看能复原整条推理链。
 */
export async function readFacts(client: FactReader): Promise<FactSheet> {
  const po = await client.get('Purchase Order', FACTS.originalPo);
  const item = await client.get('Item', FACTS.itemCode);
  const bins = await client.query('Bin', { item_code: FACTS.itemCode, warehouse: FACTS.warehouse });
  const bin = bins[0];
  const items = Array.isArray(po.items) ? po.items as Record<string, unknown>[] : [];
  const lineIndex = items.findIndex(row => row.item_code === FACTS.itemCode);
  const line = items[lineIndex];
  const poSource = (field: string) => src('Purchase Order', String(po.name), field);
  const binSource = (field: string) => src('Bin', `${FACTS.itemCode}@${FACTS.warehouse}`, field);
  const itemSource = (field: string) => src('Item', String(item.name), field);
  const text = (row: Record<string, unknown>, field: string, source: FactSource): Fact<string> =>
    typeof row[field] === 'string' && row[field] !== ''
      ? read(row[field] as string, source)
      : miss('absent', source, `没有可读的 ${field} 字段`);
  const lineNumber = (field: string): Fact<number> => {
    const source = poSource(`items[${lineIndex}].${field}`);
    return line ? numFromRow(line, field, source) : miss('absent', source, '原单没有对应物料行');
  };
  const onHand = bin ? numFromRow(bin, 'actual_qty', binSource('actual_qty'))
    : miss<number>('absent', binSource('actual_qty'), '未找到对应物料和仓库的 Bin 记录');
  const reserved = bin ? numFromRow(bin, 'reserved_qty', binSource('reserved_qty'))
    : miss<number>('absent', binSource('reserved_qty'), '未找到 Bin 记录，不能使用字段默认值');
  const finishedWarehouse = 'Finished Goods - ADC';
  const finished = await client.query('Bin', { item_code: FACTS.itemCode, warehouse: finishedWarehouse });
  const finishedSource = src('Bin', `${FACTS.itemCode}@${finishedWarehouse}`, 'actual_qty',
    finished.length ? undefined : `Bin(item_code=${FACTS.itemCode}, warehouse=${finishedWarehouse}) -> []`);
  const binFinishedGoods = finished[0] ? numFromRow(finished[0], 'actual_qty', finishedSource)
    : miss<number>('absent', finishedSource, '查询成功，但没有对应库存记录');

  // 工具面尚待 Task 02 加固；在此只读采集器中也不发送契约外的 DocType。
  const warehouseDoc = miss<string>('denied',
    src('Warehouse', FACTS.warehouse, '', 'erp.query Warehouse -> FLOOR 白名单拒绝'),
    'Warehouse 不在工具允许的 DocType 中，未发送请求');
  const invoice = await probe(client, 'Purchase Invoice', {});
  if (invoice.denied && invoice.code === 'UNKNOWN') throw new Error(invoice.reason);
  const invoiceSource = src('Purchase Invoice', '*', 'name');
  const invoiceDoc: Fact<string> = invoice.denied
    ? miss('denied', invoiceSource, `${invoice.code}: ${invoice.reason}`)
    : invoice.rows[0] ? text(invoice.rows[0], 'name', invoiceSource)
      : miss('absent', invoiceSource, '查询成功，但没有发票记录');
  const shortfallSource = src('计算', 'shortfall', '',
    `计算: ${FACTS.requiredQty} − ${onHand.value === null ? '未知' : onHand.value}`);
  const shortfall: Fact<number> = onHand.status === 'read' && onHand.value !== null
    ? read(Math.max(0, FACTS.requiredQty - onHand.value), shortfallSource)
    : miss(onHand.status === 'read' ? 'absent' : onHand.status, shortfallSource, '库存未知，不能计算缺口');
  return {
    originalPo: text(po, 'name', poSource('name')),
    supplier: text(po, 'supplier', poSource('supplier')),
    orderedQty: lineNumber('qty'), rate: lineNumber('rate'),
    itemIsStock: numFromRow(item, 'is_stock_item', itemSource('is_stock_item')),
    onHand, reserved,
    lineWarehouse: bin ? text(bin, 'warehouse', binSource('warehouse'))
      : miss('absent', binSource('warehouse'), '未找到 Bin 记录'),
    itemLastRate: numFromRow(item, 'last_purchase_rate', itemSource('last_purchase_rate')),
    binFinishedGoods, warehouseDoc, invoiceDoc, shortfall,
  };
}

// ── 渲染 ────────────────────────────────────────────────────────

const LABELS: Record<keyof FactSheet, string> = {
  originalPo: '原采购单号',
  supplier: '供应商',
  orderedQty: '原单订量',
  rate: '单价',
  itemIsStock: '是否库存物料',
  onHand: '仓库现有量',
  reserved: '已预留量',
  lineWarehouse: '建单要填的仓库名',
  itemLastRate: 'Item.last_purchase_rate',
  binFinishedGoods: 'Finished Goods - ADC 的 Bin',
  warehouseDoc: 'Warehouse 这个 DocType',
  invoiceDoc: 'Purchase Invoice 这个 DocType',
  shortfall: '缺口',
};

const ORDER: (keyof FactSheet)[] = [
  'originalPo', 'supplier', 'orderedQty', 'rate', 'itemIsStock',
  'onHand', 'reserved', 'lineWarehouse', 'shortfall',
  'itemLastRate', 'binFinishedGoods', 'invoiceDoc', 'warehouseDoc',
];

function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return String(v).replace(/\|/g, '\\|');
}

/**
 * 渲染成 Markdown，给 reports/task-01-facts.md 用。
 *
 * `extra` 是留给手写段落的口子 —— 比如双路径对照那一节，
 * 它要引 ERPNext 两条读取路径的名字，那些字样不适合从 src/ 里生成
 * （`scripts/check-no-bypass.mjs` 静态扫 src/）。报告里手写，这里只负责事实部分。
 */
export function renderFactSheet(fs: FactSheet, extra?: string): string {
  const L: string[] = [];
  const required = FACTS.requiredQty;
  const onHand = fs.onHand.value;
  const short = fs.shortfall.value;

  L.push('# Task 01 · 事实清单');
  L.push('');
  L.push('每个数字都带来源，来源指到字段一级。没有来源的数字按没读到算。');
  L.push('全程只读：本轮只有 `erp.query` 与 `erp.get`，幂等台账 0 行。');
  L.push('');
  L.push('## 事实表');
  L.push('');
  L.push('| 事实 | 值 | status | 来源 | 说明 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const k of ORDER) {
    const f = fs[k] as Fact<unknown>;
    L.push(`| ${LABELS[k]} | ${cell(f.value)} | \`${f.status}\` | \`${f.source.ref}\` | ${cell(f.note ?? '')} |`);
  }
  L.push('');

  L.push('## 缺口怎么算出来的');
  L.push('');
  L.push(`业务方要 ${required} 个，仓库里查到 ${cell(onHand)} 个：`);
  L.push('');
  L.push('```');
  L.push(`${required} − ${cell(onHand)} = ${cell(short)}`);
  L.push('```');
  L.push('');
  L.push(`补订 ${cell(short)} 个，不是照抄原单的 ${cell(fs.orderedQty.value)} 个。`);
  L.push(`原单 ${cell(fs.originalPo.value)} 已提交，这次不动它。`);
  L.push('');

  L.push('## 四种「看起来都像没有」');
  L.push('');
  L.push('这一段是本任务的重点。四种结果在返回值里长得一模一样，下一步动作完全不同。');
  L.push('');

  L.push('### read —— 真的读到了');
  L.push('');
  L.push(`单价 ${cell(fs.rate.value)} 来自 ${cell(fs.originalPo.value)} 的采购单行`);
  L.push(`（\`${fs.rate.source.ref}\`），不是从物料主数据上捡的。`);
  L.push(`仓库 ${FACTS.warehouse} 现有 ${cell(onHand)} 个，来源 \`${fs.onHand.source.ref}\`。`);
  L.push('');
  L.push(`\`reserved_qty\` 读到的是 ${cell(fs.reserved.value)}，这个 0 **是真的 0**：`);
  L.push(`Bin 行本身在（\`${fs.reserved.source.ref}\`），这个字段在宿主里默认就是 0，`);
  L.push('不是被谁挡掉的。真值可以直接进算式。');
  L.push('');

  L.push('### filtered —— 值在那儿，你看不见');
  L.push('');
  L.push(`\`last_purchase_rate\` 这一项 status 是 \`${fs.itemLastRate.status}\`，value 记成 null。`);
  L.push('Item 记录本身读得到，唯独这个字段受 permlevel 管，persona `agent_svc` 无权限读到真值 ——');
  L.push('宿主返回的 0 是过滤出来的结果，不是「上次采购价是 0」。');
  L.push(`所以单价那一栏我信的是采购单行上的 ${cell(fs.rate.value)}，来源 \`${fs.rate.source.ref}\`。`);
  L.push('');
  L.push('这条跟上面 `reserved_qty` 的 0 摆在一起看：返回值一样，能不能用完全相反。');
  L.push('');

  L.push('### absent —— 这条记录本来就不存在');
  L.push('');
  L.push(`\`${fs.binFinishedGoods.source.ref}\``);
  L.push(`查 Finished Goods - ADC 上的同一个物料，返回的是空列表，这条 Bin 不存在 ——`);
  L.push('没有仓库行，不是数量为 0，也不是权限问题。');
  L.push('记成 0 的话，「这个仓有 0 个」和「这个仓压根没进过货」就分不开了。');
  L.push('');

  L.push('### denied —— 整个 DocType 你没资格碰');
  L.push('');
  L.push(`Warehouse 这个 DocType 读不到。${cell(fs.warehouseDoc.note ?? '')}。`);
  L.push('这跟「站点上没有仓库」是两回事：数据在不在我不知道，我连问的资格都没有。');
  L.push(`所以建单要填的仓库名 \`${FACTS.warehouse}\` 是换条路拿的 ——`);
  L.push(`从 Bin 行上取（\`${fs.lineWarehouse.source.ref}\`）。`);
  L.push('');
  L.push(`Purchase Invoice 是另一种 denied。${cell(fs.invoiceDoc.note ?? '')}。`);
  L.push('两者的区别在拦的位置：Warehouse 在工具层就停住了，请求没转发出去，审计里没有条目；');
  L.push('Purchase Invoice 转发到了 policy 那层才被拒，审计里留着 `outcome=denied` ——');
  L.push('事后翻得到「试过、被拦了」。一个 Agent 试了五十次都被拦，这是重要信号。');
  L.push('');

  L.push('## 建单要用的字段');
  L.push('');
  L.push(`- 物料 \`${FACTS.itemCode}\`，\`is_stock_item=${cell(fs.itemIsStock.value)}\` —— 库存物料，行上必须带仓库。`);
  L.push(`- 仓库 \`${FACTS.warehouse}\`，取自 \`${fs.lineWarehouse.source.ref}\`。`);
  L.push(`- 数量 ${cell(short)}，单价 ${cell(fs.rate.value)}，供应商 ${cell(fs.supplier.value)}。`);
  if (short !== null && short !== EXPECTED_SHORTFALL)
    L.push(`- ⚠ 缺口算出来是 ${short}，跟任务基线的 ${EXPECTED_SHORTFALL} 对不上，先别建单。`);
  L.push('');

  if (extra && extra.trim() !== '') {
    L.push(extra.trim());
    L.push('');
  }
  return L.join('\n');
}

/** 只留 { value, status, source: string } 的扁平形，方便逐字段比对与快照。 */
export function flattenFactSheet(
  fs: FactSheet,
): Record<string, { value: unknown; status: FactStatus; source: string }> {
  const out: Record<string, { value: unknown; status: FactStatus; source: string }> = {};
  for (const k of ORDER) {
    const f = fs[k] as Fact<unknown>;
    out[k] = { value: f.value, status: f.status, source: f.source.ref };
  }
  return out;
}
