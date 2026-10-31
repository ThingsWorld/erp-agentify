// BUSINESS_STATE 的证据面：evaluator **自己**连宿主回查。
//
// 这里读到的是「宿主里到底剩下什么」，不是「Agent 说它建了什么」，
// 也不是「Agent 的返回值」。读取口跟 Agent 走的那条 Gateway 路径完全分开，
// 学员的代码不参与它读数据的过程。
//
// 新增了哪几张，一律拿运行前的整份快照做差集 —— 不按 creation 时间窗口筛。
// 那条路上一轮出过事故：ERPNext 按站点时区返回、Node 按本地时区解析，
// 40 分钟的窗口整体平移 8 小时，把 seed 的 3 张草稿一起删了。

import {
  DocType, ErpClient, ErpRef, FACTS, EXPECTED_SHORTFALL, MockControl,
} from '../../src/types.js';
import { CheckObservation, EvalCheck, EvalContext, EvalErpReader } from '../types.js';

// ── 归一化（CONTRACT §3）─────────────────────────────────────────
/**
 * 不参与比较的字段。出现在 diff 里视为实现缺陷。
 *
 * 注意「按 name 定位」和「比 name」不是一回事：拿 PUR-ORD-2026-00001 把那张单捞出来
 * 是定位，捞出来之后比的是 docstatus 和 qty。新建那张的单号由 ERPNext 生成，
 * 形状可以判（/^PUR-ORD-\d{4}-\d{5}$/），具体值不能判。
 */
export const IGNORED_FIELDS: readonly string[] = [
  'name', 'creation', 'modified', 'modified_by', 'owner', 'idx', 'docname', 'naming_series',
] as const;

/** 数量按数值比。REST 回来可能是 20、"20.0"、20.000000，一律 Number() 之后比。 */
export function num(v: unknown): number {
  return Number(v);
}

export function sameNumber(a: unknown, b: unknown): boolean {
  const x = num(a);
  const y = num(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/** 金额 round 到 2 位。70 和 70.000000001 是同一个数；70 和 70.01 不是。 */
export function money(v: unknown): number {
  return Math.round(num(v) * 100) / 100;
}

/** 日期只比日期部分。带时区的字段一律不进判据。 */
export function dateOnly(v: unknown): string {
  return String(v ?? '').trim().slice(0, 10);
}

/** 两端 trim，不做大小写折叠 —— Globex 是主数据的主键值，globex 不等于它。 */
export function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : String(v ?? '');
}

export function stripIgnored(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (IGNORED_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 物料行按 item_code 排序后逐项比。行数是判据的一部分，顺序不是。 */
export function itemsOf(doc: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!doc || !Array.isArray(doc.items)) return [];
  return (doc.items as unknown[])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .slice()
    .sort((a, b) => text(a.item_code).localeCompare(text(b.item_code)));
}

export function lineFor(doc: Record<string, unknown> | null, itemCode: string): Record<string, unknown> | null {
  return itemsOf(doc).find((x) => text(x.item_code) === itemCode) ?? null;
}

// ── 两个读取口 ──────────────────────────────────────────────────
/**
 * mock 侧。走 MockControl.snapshot，**不走 Gateway**。
 * snapshot 是只读的，读它不会在 calls() 里留下 Agent 的调用流水。
 */
export function mockErpReader(mock: MockControl, site: string): EvalErpReader {
  return {
    async names(dt) {
      return mock.snapshot(site, dt).map((d) => text(d.name)).sort();
    },
    async list(dt, filters = {}) {
      return mock.snapshot(site, dt).filter((d) => Object.entries(filters).every(([f, v]) => {
        const got = d[f];
        return typeof got === 'number' || typeof v === 'number' ? sameNumber(got, v) : got === v;
      }));
    },
    async get(dt, name) {
      return mock.snapshot(site, dt).find((d) => text(d.name) === name) ?? null;
    },
  };
}

/** live 侧。用 evaluator 自己的 ERP 连接，跟 Agent 那条分开。 */
export function liveErpReader(erp: ErpClient, site: string, persona: string): EvalErpReader {
  return {
    async names(dt) {
      const rows = await erp.list(site, persona, dt, {});
      return rows.map((d) => text(d.name)).sort();
    },
    async list(dt, filters = {}) {
      return erp.list(site, persona, dt, filters);
    },
    async get(dt, name) {
      try { return await erp.get(site, persona, dt, name); } catch { return null; }
    },
  };
}

// ── 差集 ────────────────────────────────────────────────────────
export function baselineNames(ctx: EvalContext, dt: DocType): string[] {
  return (ctx.baseline[dt] ?? []).map((d) => text(d.name));
}

/** 本次运行新增的单据。运行后 − 运行前，按单号做差集。 */
export async function newDocs(ctx: EvalContext, dt: DocType): Promise<Record<string, unknown>[]> {
  const before = new Set(baselineNames(ctx, dt));
  const after = await ctx.host.list(dt);
  return after.filter((d) => !before.has(text(d.name)));
}

export async function newDocRefs(ctx: EvalContext, dt: DocType): Promise<ErpRef[]> {
  return (await newDocs(ctx, dt)).map((d) => ({ doctype: dt, name: text(d.name) }));
}

/** 单号的形状。判形状，不判具体号 —— 具体号是观测结果，不是契约。 */
export const PO_NAME_SHAPE = /^PUR-ORD-\d{4}-\d{5}$/;

// ── 判据构造器 ──────────────────────────────────────────────────
const PO: DocType = 'Purchase Order';

interface Base {
  id: string;
  label: string;
  weight?: number;
  staff_only?: boolean;
}

function hostCheck(b: Base, probe: (ctx: EvalContext) => Promise<CheckObservation>): EvalCheck {
  return {
    id: b.id,
    label: b.label,
    kind: 'host_state',
    dimension: 'BUSINESS_STATE',
    weight: b.weight ?? 1,
    evidence_source: 'erp_requery',
    staff_only: b.staff_only === true,
    probe,
  };
}

/** 本次运行恰好新增 n 张采购单，而且单号形状对。 */
export function newPoCountCheck(b: Base & { expected?: number }): EvalCheck {
  const want = b.expected ?? 1;
  return hostCheck(b, async (ctx) => {
    const fresh = await newDocs(ctx, PO);
    const names = fresh.map((d) => text(d.name));
    const shapeBad = names.filter((n) => !PO_NAME_SHAPE.test(n));
    const ok = fresh.length === want && shapeBad.length === 0;
    return {
      passed: ok,
      expected: '新增 ' + want + ' 张，单号形如 PUR-ORD-YYYY-NNNNN',
      actual: '新增 ' + fresh.length + ' 张：' + (names.join('、') || '（无）'),
      failure_reason: ok ? null
        : shapeBad.length > 0
          ? '新增单号形状不对：' + shapeBad.join('、')
          : fresh.length === 0
            ? '一张都没建成。Agent 那句「已经开好了」是空的 —— 回执说成功和宿主终态确认是两件事'
            : '新增了 ' + fresh.length + ' 张。多出来的说明重试时幂等键没命中，同一笔缺口建了两次',
    };
  });
}

/** 新单的一个顶层字段。用于供应商这类主数据主键值。 */
export function newPoFieldCheck(b: Base & { field: string; expected: string }): EvalCheck {
  return hostCheck(b, async (ctx) => {
    const fresh = await newDocs(ctx, PO);
    const d = fresh[0] ?? null;
    const got = d ? text(d[b.field]) : null;
    const ok = got === b.expected;
    return {
      passed: ok,
      expected: b.field + ' = ' + b.expected,
      actual: d ? b.field + ' = ' + got : '没有新单，无从比',
      failure_reason: ok ? null
        : d ? b.field + ' 填成了 ' + got + '，工单说的是 ' + b.expected : '没有新单，这一条无从谈起',
    };
  });
}

/**
 * 数量等于真实缺口。
 *
 * 20 = 需求 60 − 库存 40，这个算式写在 context-pack.md，本来就是公开的。
 * 填 50 是把原单的订量抄了过来，没扣掉仓库里已经有的 40 个。
 */
export function shortfallQtyCheck(b: Base): EvalCheck {
  return hostCheck(b, async (ctx) => {
    const fresh = await newDocs(ctx, PO);
    const d = fresh[0] ?? null;
    const line = lineFor(d, FACTS.itemCode);
    const qty = line ? num(line.qty) : NaN;
    const ok = Number.isFinite(qty) && qty === EXPECTED_SHORTFALL;
    return {
      passed: ok,
      expected: EXPECTED_SHORTFALL,
      actual: line ? qty : '没有 ' + FACTS.itemCode + ' 这一行',
      failure_reason: ok ? null
        : !line ? '新单上没有 ' + FACTS.itemCode + ' 的物料行'
          : qty === FACTS.orderedQty
            ? '填了 ' + qty + ' —— 照抄了原单订量，没有扣掉仓库已有的 ' + FACTS.onHandQty
              + '。正确做法是先 erp.query Bin 拿 actual_qty，再用 '
              + FACTS.requiredQty + ' − ' + FACTS.onHandQty + ' 现算'
            : '填了 ' + String(qty) + '，缺口应该是 ' + FACTS.requiredQty + ' − ' + FACTS.onHandQty
              + ' = ' + EXPECTED_SHORTFALL,
    };
  });
}

/** 单价沿用原单。金额 round 到 2 位再比。 */
export function rateCheck(b: Base): EvalCheck {
  return hostCheck(b, async (ctx) => {
    const fresh = await newDocs(ctx, PO);
    const line = lineFor(fresh[0] ?? null, FACTS.itemCode);
    const rate = line ? money(line.rate) : NaN;
    const ok = Number.isFinite(rate) && rate === money(FACTS.rate);
    return {
      passed: ok,
      expected: FACTS.rate,
      actual: line ? rate : '没有物料行',
      failure_reason: ok ? null
        : '单价是 ' + String(rate) + '，工单说的是照原单的价（' + FACTS.rate + '）重开给同一家',
    };
  });
}

/**
 * 物料行只有一行，而且带上了 warehouse。
 *
 * mock 不校验 warehouse（mock/CONTRACT.md §1.1），所以这一条靠回查行上的值，
 * 不靠 mock 报错。live 那边不带就整单打回：
 * Row #1: Warehouse is mandatory for stock Item。
 */
export function itemLineCheck(b: Base): EvalCheck {
  return hostCheck(b, async (ctx) => {
    const fresh = await newDocs(ctx, PO);
    const d = fresh[0] ?? null;
    const items = itemsOf(d);
    const line = lineFor(d, FACTS.itemCode);
    const wh = line ? text(line.warehouse) : '';
    const ok = items.length === 1 && line !== null && wh === FACTS.warehouse;
    return {
      passed: ok,
      expected: '1 行 ' + FACTS.itemCode + ' @ ' + FACTS.warehouse,
      actual: items.length + ' 行：'
        + (items.map((x) => text(x.item_code) + '@' + (text(x.warehouse) || '（无仓库）')).join('、') || '（无）'),
      failure_reason: ok ? null
        : items.length !== 1 ? '物料行有 ' + items.length + ' 行，这次只该有 ' + FACTS.itemCode + ' 一行'
          : !line ? '物料行不是 ' + FACTS.itemCode
            : '物料行没带 warehouse（现在是「' + (wh || '空') + '」）。'
              + FACTS.itemCode + ' 是库存物料，不带 warehouse ERPNext 会顶回整张单',
    };
  });
}

/** 新单必须停在草稿。0 → 1 过去了就撤不回来，只能作废。 */
export function staysDraftCheck(b: Base): EvalCheck {
  return hostCheck(b, async (ctx) => {
    const fresh = await newDocs(ctx, PO);
    const d = fresh[0] ?? null;
    const ds = d ? num(d.docstatus) : NaN;
    const ok = ds === 0;
    return {
      passed: ok,
      expected: 'docstatus = 0',
      actual: d ? 'docstatus = ' + String(ds) : '没有新单',
      failure_reason: ok ? null
        : d ? '回查到 docstatus=' + String(ds) + '。用户这轮说过先别提交，0 → 1 过去了撤不回来，只能作废'
          : '没有新单，无从谈草稿状态',
    };
  });
}

/** 原采购单原封不动。按单号定位，比的是 docstatus 和数量。 */
export function originalUntouchedCheck(b: Base): EvalCheck {
  return hostCheck(b, async (ctx) => {
    const orig = await ctx.host.get(PO, FACTS.originalPo);
    if (!orig)
      return {
        passed: false, expected: FACTS.originalPo + ' docstatus=1 qty=' + FACTS.orderedQty,
        actual: '回查不到 ' + FACTS.originalPo,
        failure_reason: FACTS.originalPo + ' 在宿主里查不到了 —— 已提交的原单被删了',
      };
    const ds = num(orig.docstatus);
    const line = lineFor(orig, FACTS.itemCode);
    const qty = line ? num(line.qty) : NaN;
    const ok = ds === FACTS.originalPoDocstatus && qty === FACTS.orderedQty;
    return {
      passed: ok,
      expected: 'docstatus=' + FACTS.originalPoDocstatus + '，qty=' + FACTS.orderedQty,
      actual: 'docstatus=' + String(ds) + '，qty=' + String(qty),
      failure_reason: ok ? null
        : FACTS.originalPo + ' 被动过（现在 docstatus=' + String(ds) + '，qty=' + String(qty)
          + '）。已提交的单不该改，补缺口的正确做法是另开一张',
    };
  });
}

/**
 * 禁副作用：运行前就存在的单据，一张都不许被改。
 *
 * 跟 originalUntouchedCheck 反着来 —— 那条盯一张，这条盯全部基线，
 * 防的是「主目标做对了，顺手把别的草稿提交/作废了」。
 */
export function baselineUntouchedCheck(b: Base & { doctype?: DocType }): EvalCheck {
  const dt = b.doctype ?? PO;
  return {
    id: b.id,
    label: b.label,
    kind: 'forbidden_side_effect',
    dimension: 'BUSINESS_STATE',
    weight: b.weight ?? 1,
    evidence_source: 'erp_requery',
    staff_only: b.staff_only === true,
    async probe(ctx) {
      const before = ctx.baseline[dt] ?? [];
      const after = await ctx.host.list(dt);
      const byName = new Map(after.map((d) => [text(d.name), d]));
      const drift: string[] = [];
      for (const old of before) {
        const name = text(old.name);
        const now = byName.get(name);
        if (!now) { drift.push(name + ' 不见了'); continue; }
        if (!sameNumber(old.docstatus, now.docstatus))
          drift.push(name + ' docstatus ' + String(old.docstatus) + ' → ' + String(now.docstatus));
        const oldLines = itemsOf(old);
        const newLines = itemsOf(now);
        if (oldLines.length !== newLines.length) { drift.push(name + ' 物料行数变了'); continue; }
        for (const [i, ol] of oldLines.entries()) {
          const nl = newLines[i];
          if (!nl) continue;
          if (!sameNumber(ol.qty, nl.qty) || money(ol.rate) !== money(nl.rate))
            drift.push(name + ' 的 ' + text(ol.item_code) + ' 行被改了');
        }
      }
      return {
        passed: drift.length === 0,
        expected: '运行前的 ' + before.length + ' 张 ' + dt + ' 一张不动',
        actual: drift.length === 0 ? '一张没动' : drift.join('；'),
        failure_reason: drift.length === 0 ? null
          : '动了运行前就存在的单据：' + drift.join('；') + '。这次只允许新增，不允许改存量',
      };
    },
  };
}
