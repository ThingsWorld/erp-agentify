// Task 01 · 先读宿主，再动它。
//
// 这一套判的是「四种看起来都像没有的结果，分不分得开」：
//
//   read     真读到了
//   filtered 记录在、字段被 permlevel 挡住，宿主给你一个 0
//   absent   记录本身不存在，查询返回空列表
//   denied   整个 DocType 你没资格碰
//
// 每个负例都配一个正例：filtered 配同一张 Item 上读得到的 is_stock_item，
// absent 配 Stores - ADC 上真实存在的那条 Bin，denied 配一条正常转发的读。
// 不然「全都判成读不到」也能绿，那等于什么都没测。
//
// 还有一条硬的：全程只读。审计里出现写能力，或者台账里出现行，这一课就红了。

import { describe, expect, it, beforeAll } from 'vitest';

import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient } from '../src/gateway-client.js';
import { FactSheet, readFacts } from '../src/read-inventory.js';
import { AuditEntry, DocType, ErpFilters, EXPECTED_SHORTFALL, FACTS } from '../src/types.js';

let rig: Rig;
let facts: FactSheet;
let entries: AuditEntry[];

beforeAll(async () => {
  rig = makeRig({ scenario: 'baseline' });
  facts = await readFacts(new GatewayClient(rig.tools, rig.runId));
  entries = await rig.audit.byRun(rig.runId);
  return () => rig.cleanup();
});

/** 从来源三元组里抠出 doctype。'计算' 那种不是宿主 doctype，返回 null。 */
function doctypeOf(ref: string): string | null {
  const dt = ref.split('/')[0] ?? '';
  return ['Purchase Order', 'Item', 'Bin', 'Supplier'].includes(dt) ? dt : null;
}

describe('task-01 · 读宿主', () => {
  it('read: 四类主数据都读到了，值与来源三元组逐项对得上', () => {
    expect(facts.originalPo).toMatchObject({
      value: FACTS.originalPo, status: 'read',
    });
    expect(facts.originalPo.source.ref).toBe('Purchase Order/PUR-ORD-2026-00001.name');

    expect(facts.supplier).toMatchObject({ value: FACTS.supplier, status: 'read' });
    expect(facts.supplier.source.ref).toBe('Purchase Order/PUR-ORD-2026-00001.supplier');

    expect(facts.orderedQty).toMatchObject({ value: FACTS.orderedQty, status: 'read' });
    expect(facts.orderedQty.source.ref).toBe('Purchase Order/PUR-ORD-2026-00001.items[0].qty');

    expect(facts.itemIsStock).toMatchObject({ value: 1, status: 'read' });
    expect(facts.itemIsStock.source.ref).toBe('Item/ITEM-SHELF-01.is_stock_item');

    expect(facts.onHand).toMatchObject({ value: FACTS.onHandQty, status: 'read' });
    expect(facts.onHand.source.ref).toBe('Bin/ITEM-SHELF-01@Stores - ADC.actual_qty');

    // 建单那一行要填的仓库名只能从 Bin 行上取 —— Warehouse 这个 doctype 读不到。
    expect(facts.lineWarehouse).toMatchObject({ value: FACTS.warehouse, status: 'read' });
    expect(facts.lineWarehouse.source.ref).toBe('Bin/ITEM-SHELF-01@Stores - ADC.warehouse');
  });

  it('read: 缺口是 60 − 40 = 20，不是照抄原单的 50，也不是把库存当成 0 的 60', () => {
    expect(facts.shortfall.status).toBe('read');
    expect(facts.shortfall.value).toBe(EXPECTED_SHORTFALL);
    expect(facts.shortfall.value).toBe(20);
    expect(facts.shortfall.value).not.toBe(FACTS.orderedQty);
    expect(facts.shortfall.value).not.toBe(FACTS.requiredQty);
    expect(facts.shortfall.source.ref).toContain(String(FACTS.requiredQty));
    expect(facts.shortfall.source.ref).toContain(String(FACTS.onHandQty));
  });

  it('read: 单价 70 认的是采购单行，不是 Item.last_purchase_rate', () => {
    expect(facts.rate.status).toBe('read');
    expect(facts.rate.value).toBe(FACTS.rate);
    expect(facts.rate.source.ref).toMatch(/^Purchase Order\/PUR-ORD-2026-00001\.items\[0\]\.rate$/);
    expect(facts.rate.source.ref).not.toMatch(/last_purchase_rate/);
    // 反向：那个字段本身必须被标成读不到，不许它顶替单价。
    expect(facts.itemLastRate.status).toBe('filtered');
    expect(facts.itemLastRate.value).toBeNull();
  });

  it('filtered: last_purchase_rate 记成 filtered、value 是 null，不拿 0 顶上', () => {
    expect(facts.itemLastRate.status).toBe('filtered');
    expect(facts.itemLastRate.value).toBeNull();
    expect(facts.itemLastRate.value).not.toBe(0);
    expect(facts.itemLastRate.source.ref).toBe('Item/ITEM-SHELF-01.last_purchase_rate');
    expect(facts.itemLastRate.note ?? '').not.toBe('');

    // 正例：同一张 Item 上的 is_stock_item 读得到 —— 挡住的是字段，不是整条记录。
    expect(facts.itemIsStock.status).toBe('read');
    expect(facts.itemIsStock.value).toBe(1);
    expect(facts.itemIsStock.source.doctype).toBe(facts.itemLastRate.source.doctype);
    expect(facts.itemIsStock.source.name).toBe(facts.itemLastRate.source.name);
  });

  it('absent: Finished Goods - ADC 上没有 Bin 行，记成 absent 不是 0', () => {
    expect(facts.binFinishedGoods.status).toBe('absent');
    expect(facts.binFinishedGoods.value).toBeNull();
    expect(facts.binFinishedGoods.source.ref).toBe(
      'Bin(item_code=ITEM-SHELF-01, warehouse=Finished Goods - ADC) -> []');

    // 正例：同一个物料在 Stores - ADC 上就有行，值是 40。查询本身没问题。
    expect(facts.onHand.status).toBe('read');
    expect(facts.onHand.value).toBe(FACTS.onHandQty);
  });

  it('genuine-zero: reserved_qty 的 0 是真的 0，跟被过滤掉的那个 0 不是一回事', () => {
    expect(facts.reserved.status).toBe('read');
    expect(facts.reserved.value).toBe(0);
    expect(facts.reserved.source.ref).toBe('Bin/ITEM-SHELF-01@Stores - ADC.reserved_qty');

    // 两个 0 在返回值里长得一样，status 必须把它们分开。
    expect(facts.reserved.status).not.toBe(facts.itemLastRate.status);
    expect(facts.itemLastRate.value).toBeNull();
  });

  it('denied: Warehouse 记成 denied，且请求在工具层就停住 —— 审计里没有 Warehouse 条目', () => {
    expect(facts.warehouseDoc.status).toBe('denied');
    expect(facts.warehouseDoc.value).toBeNull();
    expect(facts.warehouseDoc.source.ref).toBe('erp.query Warehouse -> FLOOR 白名单拒绝');

    // 白名单外的 DocType 连转发都不该发生。
    expect(entries.filter((e) => e.erpDoctype === 'Warehouse')).toHaveLength(0);

    // denied 不等于「站点上没有仓库」：仓库名换条路照样拿到了。
    expect(facts.lineWarehouse.status).toBe('read');
    expect(facts.lineWarehouse.value).toBe(FACTS.warehouse);
  });

  it('denied: Purchase Invoice 被 persona 白名单拒，审计里留下一条 outcome=denied', () => {
    expect(facts.invoiceDoc.status).toBe('denied');
    expect(facts.invoiceDoc.value).toBeNull();

    const denials = entries.filter((e) => e.outcome === 'denied');
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(denials.map((e) => e.erpDoctype)).toContain('Purchase Invoice');
    for (const d of denials) expect(d.verifiedAt).toBeNull();

    // 正例：拦得住不等于什么都做不了 —— 同一轮里正常的读留下了 done。
    expect(entries.filter((e) => e.outcome === 'done').length).toBeGreaterThan(0);
  });

  it('audit: 本轮只有 erp.query / erp.get，outcome 只有 done 与 denied，台账 0 行', async () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(['erp.query', 'erp.get']).toContain(e.capability);
      expect(['done', 'denied']).toContain(e.outcome);
      expect(e.runId).toBe(rig.runId);
      expect(e.idempotencyKey).toBeNull();
    }
    expect(entries.filter(
      (e) => e.capability === 'erp.create_draft' || e.capability === 'erp.submit')).toHaveLength(0);

    // 读不进台账。有行就说明调过写能力。
    expect(await rig.ledger.listUncertain()).toHaveLength(0);

    const ops = (rig.mock?.calls() ?? []).map((c) => c.op);
    expect(ops).not.toContain('insert');
    expect(ops).not.toContain('submit');
    expect(ops).not.toContain('cancel');
    expect(ops).not.toContain('remove');
    expect(ops.length).toBeGreaterThan(0);
  });

  it('audit: 每一条 status=read 的事实，审计里都有一次读撑着；没有孤儿条目', () => {
    const done = entries.filter((e) => e.outcome === 'done');
    const seen = new Set(done.map((e) => String(e.erpDoctype)));

    const readFactsList = Object.values(facts).filter((f) => f.status === 'read');
    expect(readFactsList.length).toBeGreaterThanOrEqual(8);

    for (const f of readFactsList) {
      const dt = doctypeOf(f.source.ref);
      if (dt === null) continue;          // shortfall 是算出来的，没有对应的读
      expect(seen, f.source.ref + ' 在审计里找不到对应的读').toContain(dt);
    }

    // 反向：审计里每一条 done 的 doctype，都在事实表里有落点。
    const usedDoctypes = new Set(
      readFactsList.map((f) => doctypeOf(f.source.ref)).filter((d): d is string => d !== null));
    for (const e of done) expect(usedDoctypes).toContain(String(e.erpDoctype));
  });

  it('no-bypass: 数字来自 Gateway —— 断掉调用面之后 readFacts 一个值都拿不到', async () => {
    const broken = {
      async query(_dt: DocType, _f?: ErpFilters): Promise<Record<string, unknown>[]> {
        throw new Error('Gateway 不可用');
      },
      async get(_dt: DocType, _n: string): Promise<Record<string, unknown>> {
        throw new Error('Gateway 不可用');
      },
    };
    // 它要是还能报出 40 / 70，那就是从 fixtures 里抄的，审计上没有来源。
    await expect(readFacts(broken)).rejects.toThrow(/Gateway 不可用/);
  });
});
