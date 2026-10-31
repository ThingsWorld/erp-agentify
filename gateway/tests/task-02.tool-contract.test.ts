// Task 02 · 窄工具面。
//
// 四条线，跟公开测试的 -t 过滤器一一对应：doctype / warehouse / errorcode / injection。
//
// 判据是「审计里一条都没有」，不是「审计里有一条 denied」。网关拒了也算这一层漏了 ——
// 那说明请求已经从工具层转发出去。所以每个负例都要同时看三处：
//   返回的 code/field、audit.byRun(runId)、mock.calls() 的调用流水。
//
// 场景用 tool-probe：persona 的白名单里**故意**放了 User，网关不会替你拦；
// PUR-ORD-2026-00001 的 terms 上挂着示范注入文本（原文见 fixtures/tainted-po-terms.txt，
// 这里只拿它的存在与来源三元组做断言，不把载荷抄进测试）。
//
// 这一轮不写宿主。所以「正例」一律停在校验通过那一步，不真去建单。

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient, untrustedField } from '../src/gateway-client.js';
import {
  DOCTYPE_ALLOWLIST, TOOLS, TOOL_REGISTRY, validateToolCall,
} from '../src/tools.js';
import { TOOL_ERROR_CODES, ToolErrorCode } from '../src/tool-schema.js';
import { CAPABILITIES, FACTS, TOOL_DOCTYPES } from '../src/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAINTED_FIXTURE = join(ROOT, 'fixtures', 'tainted-po-terms.txt');

/** 越权探针要够到的 DocType。工具面里没有它，网关那层却放行 —— 只能靠这一层拦。 */
const OFF_LIMITS = 'User';

function rigForProbe(): Rig {
  return makeRig({ scenario: 'tool-probe' });
}

/** 一条合法的采购单行。负例都是从它上面拿掉一个字段做出来的。 */
function goodLine(): Record<string, unknown> {
  return {
    item_code: FACTS.itemCode,
    qty: 20,
    rate: FACTS.rate,
    warehouse: FACTS.warehouse,
    schedule_date: '2026-09-30',
  };
}

function goodDoc(line: Record<string, unknown> = goodLine()): Record<string, unknown> {
  return {
    supplier: FACTS.supplier,
    company: FACTS.company,
    currency: FACTS.currency,
    schedule_date: '2026-09-30',
    items: [line],
  };
}

describe('task-02 · 工具面契约', () => {
  // ── doctype ────────────────────────────────────────────────────
  it('doctype: 工具面恰好四个能力，DocType 是受控参数而不是端点', () => {
    expect(TOOLS).toHaveLength(4);
    expect(Object.isFrozen(TOOLS)).toBe(true);

    const caps = TOOLS.map((t) => t.capability).sort();
    expect(caps).toEqual([...CAPABILITIES].sort());
    for (const t of TOOLS) {
      expect(CAPABILITIES).toContain(t.capability);
      expect(TOOL_REGISTRY[t.name]).toBe(t.capability);
    }
    expect(Object.keys(TOOL_REGISTRY)).toHaveLength(4);

    // DocType 是参数，不是端点：四个工具都要求显式传 docType，少了就当场报缺字段。
    for (const t of TOOLS) {
      const v = validateToolCall(t.name, {});
      expect(v.ok, t.name + ' 没有把 docType 当必填参数').toBe(false);
      if (v.ok) continue;
      expect(v.code).toBe('MISSING_FIELD');
      expect(v.field).toBe('docType');
    }
  });

  it('doctype: DOCTYPE_ALLOWLIST 是冻结的字面量，内容等于 types.ts 的五项', () => {
    expect(Object.isFrozen(DOCTYPE_ALLOWLIST)).toBe(true);
    expect([...DOCTYPE_ALLOWLIST].sort()).toEqual([...TOOL_DOCTYPES].sort());
    expect(DOCTYPE_ALLOWLIST).toHaveLength(5);
    expect(DOCTYPE_ALLOWLIST).not.toContain(OFF_LIMITS);

    // 冻住的表推不进新东西。运行时能改的白名单等于没有白名单。
    const before = [...DOCTYPE_ALLOWLIST];
    expect(() => (DOCTYPE_ALLOWLIST as string[]).push(OFF_LIMITS)).toThrow();
    expect([...DOCTYPE_ALLOWLIST]).toEqual(before);
  });

  it('doctype: 白名单外的 DocType 被本地拒掉，一次网关调用都没发出去', async () => {
    const v = validateToolCall('erp_query_documents', { docType: OFF_LIMITS, filters: {} });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('DOCTYPE_NOT_ALLOWED');
    expect(v.field).toBe('docType');
    // 报错里不该顺手把整份白名单念一遍 —— 那等于一次目录枚举。
    expect(v.message).not.toContain('Purchase Invoice');

    const rig = rigForProbe();
    try {
      // persona 这边故意允许了 User，网关不会替这一层兜底。
      expect(rig.principal.persona.allowedDocTypes).toContain(OFF_LIMITS);

      const r = await rig.tools.call(
        { tool: 'erp_query_documents', args: { docType: OFF_LIMITS, filters: {} } }, rig.runId);
      expect(r.status).toBe('denied');

      expect(await rig.audit.byRun(rig.runId)).toHaveLength(0);
      expect(rig.mock?.calls() ?? []).toHaveLength(0);
    } finally {
      rig.cleanup();
    }
  });

  it('doctype: 正例 —— 白名单内的 Bin 会转发，审计里留下 erp.query / Bin / done', async () => {
    const rig = rigForProbe();
    try {
      const r = await rig.tools.call({
        tool: 'erp_query_documents',
        args: { docType: 'Bin', filters: { item_code: FACTS.itemCode, warehouse: FACTS.warehouse } },
      }, rig.runId);

      expect(r.status).toBe('done');
      expect((r.data as unknown[]).length).toBe(1);

      const es = await rig.audit.byRun(rig.runId);
      expect(es).toHaveLength(1);
      const e = es[0];
      expect(e?.capability).toBe('erp.query');
      expect(e?.erpDoctype).toBe('Bin');
      expect(e?.outcome).toBe('done');
      expect(e?.verifiedAt).not.toBeNull();

      // 收窄不等于把参数写死：filters 是这个工具的合法参数。
      expect(rig.mock?.calls().map((c) => c.op + ':' + c.doctype)).toEqual(['list:Bin']);
    } finally {
      rig.cleanup();
    }
  });

  // ── warehouse ──────────────────────────────────────────────────
  it('warehouse: 采购单行缺 warehouse 时本地就拒，错误指到 items[0].warehouse', async () => {
    const { warehouse: _dropped, ...noWarehouse } = goodLine();
    const v = validateToolCall('erp_create_purchase_order_draft', {
      docType: 'Purchase Order', doc: goodDoc(noWarehouse),
    });

    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('MISSING_FIELD');
    expect(v.field).toBe('items[0].warehouse');

    const rig = rigForProbe();
    try {
      const r = await rig.tools.call({
        tool: 'erp_create_purchase_order_draft',
        args: { docType: 'Purchase Order', doc: goodDoc(noWarehouse) },
        idempotencyKey: 'k-task02-no-warehouse',
      }, rig.runId);
      expect(r.status).toBe('denied');

      // 这一次根本没跨出工具层：审计里没有 erp.create_draft，宿主也没被碰过。
      const es = await rig.audit.byRun(rig.runId);
      expect(es.filter((e) => e.capability === 'erp.create_draft')).toHaveLength(0);
      expect(es).toHaveLength(0);
      expect((rig.mock?.calls() ?? []).map((c) => c.op)).not.toContain('insert');
      expect(rig.mock?.count(rig.site, 'Purchase Order')).toBe(FACTS.baselinePurchaseOrders);
    } finally {
      rig.cleanup();
    }
  });

  it('warehouse: 正例 —— 行上带了仓库就通过校验（这一轮不真建单，宿主一张不多）', async () => {
    const v = validateToolCall('erp_create_purchase_order_draft', {
      docType: 'Purchase Order', doc: goodDoc(),
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.capability).toBe('erp.create_draft');

    const doc = v.args.doc as Record<string, unknown>;
    const line = (doc.items as Record<string, unknown>[])[0];
    expect(line?.warehouse).toBe(FACTS.warehouse);

    // 空串跟没填一样要拦住，不然会带着一个空仓库跑到宿主那边去。
    const blank = validateToolCall('erp_create_purchase_order_draft', {
      docType: 'Purchase Order', doc: goodDoc({ ...goodLine(), warehouse: '  ' }),
    });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.field).toBe('items[0].warehouse');

    const rig = rigForProbe();
    try {
      expect(rig.mock?.count(rig.site, 'Purchase Order')).toBe(FACTS.baselinePurchaseOrders);
      expect(await rig.audit.byRun(rig.runId)).toHaveLength(0);
    } finally {
      rig.cleanup();
    }
  });

  // ── errorcode ──────────────────────────────────────────────────
  it('errorcode: 六个码全部落在封闭集合里，每条都带 field，且都没转发出去', async () => {
    const cases: { why: ToolErrorCode; field: string; tool: string; args: unknown }[] = [
      {
        why: 'UNKNOWN_TOOL', field: 'tool',
        tool: 'erp_run_report', args: { docType: 'Bin' },
      },
      {
        why: 'DOCTYPE_NOT_ALLOWED', field: 'docType',
        tool: 'erp_query_documents', args: { docType: OFF_LIMITS, filters: {} },
      },
      {
        why: 'MISSING_FIELD', field: 'name',
        tool: 'erp_get_document', args: { docType: 'Purchase Order' },
      },
      {
        why: 'UNEXPECTED_FIELD', field: 'fields',
        tool: 'erp_query_documents', args: { docType: 'Bin', filters: {}, fields: ['name'] },
      },
      {
        why: 'BAD_TYPE', field: 'name',
        tool: 'erp_get_document', args: { docType: 'Purchase Order', name: 42 },
      },
      {
        why: 'VALUE_NOT_ALLOWED', field: 'name',
        tool: 'erp_get_document', args: { docType: 'Purchase Order', name: '../../etc/passwd' },
      },
    ];

    // 六个码一个不落，正好把封闭集合走一遍。
    expect(new Set(cases.map((c) => c.why))).toEqual(new Set(TOOL_ERROR_CODES));

    const rig = rigForProbe();
    try {
      for (const c of cases) {
        const v = validateToolCall(c.tool, c.args);
        expect(v.ok, c.why + ' 那一条居然通过了').toBe(false);
        if (v.ok) continue;
        expect(TOOL_ERROR_CODES).toContain(v.code);
        expect(v.code, JSON.stringify(c.args)).toBe(c.why);
        expect(v.field).toBe(c.field);
        expect(v.message.length).toBeGreaterThan(0);

        const r = await rig.tools.call({ tool: c.tool, args: c.args }, rig.runId);
        expect(r.status).toBe('denied');
        expect(r.code).toBeDefined();
      }

      // 六次全被本地拦下，审计与宿主流水都是空的。
      expect(await rig.audit.byRun(rig.runId)).toHaveLength(0);
      expect(rig.mock?.calls() ?? []).toHaveLength(0);
    } finally {
      rig.cleanup();
    }
  });

  it('errorcode: 正例 —— 合法参数返回 ok:true，不产生任何错误码', () => {
    const ok = [
      { tool: 'erp_query_documents', docType: 'Bin', args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } } },
      { tool: 'erp_query_documents', docType: 'Purchase Order', args: { docType: 'Purchase Order' } },
      { tool: 'erp_get_document', docType: 'Purchase Order', args: { docType: 'Purchase Order', name: FACTS.originalPo } },
      { tool: 'erp_submit_document', docType: 'Purchase Order', args: { docType: 'Purchase Order', name: FACTS.originalPo } },
      { tool: 'erp_create_purchase_order_draft', docType: 'Purchase Order', args: { docType: 'Purchase Order', doc: goodDoc() } },
      // 越权靶子：工具面收得下 Purchase Invoice，拒它是 policy 那层的活。
      { tool: 'erp_query_documents', docType: 'Purchase Invoice', args: { docType: 'Purchase Invoice', filters: {} } },
    ];
    for (const c of ok) {
      const v = validateToolCall(c.tool, c.args);
      expect(v.ok, c.tool + '（' + c.docType + '）被误判成了错误').toBe(true);
      if (v.ok) expect(v.args.docType).toBe(c.docType);
    }

    // filters 缺省时补成空对象，不是被当成未知字段丢掉。
    const noFilters = validateToolCall('erp_query_documents', { docType: 'Bin' });
    expect(noFilters.ok).toBe(true);
    if (noFilters.ok) expect(noFilters.args.filters).toEqual({});
  });

  // ── injection ──────────────────────────────────────────────────
  it('injection: 读过 PUR-ORD-2026-00001 的 terms 之后，工具面与白名单一个字没变', async () => {
    const toolsBefore = JSON.stringify(TOOLS);
    const allowBefore = JSON.stringify(DOCTYPE_ALLOWLIST);
    const registryBefore = JSON.stringify(TOOL_REGISTRY);

    const rig = rigForProbe();
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const doc = await client.get('Purchase Order', FACTS.originalPo);
      // 确认这一轮真的读到了那段文字，不然下面的断言等于没测。
      expect(untrustedField(doc, 'terms')).not.toBeNull();

      expect(JSON.stringify(TOOLS)).toBe(toolsBefore);
      expect(JSON.stringify(DOCTYPE_ALLOWLIST)).toBe(allowBefore);
      expect(JSON.stringify(TOOL_REGISTRY)).toBe(registryBefore);
      expect(TOOLS).toHaveLength(4);
      expect(DOCTYPE_ALLOWLIST).not.toContain(OFF_LIMITS);

      // 读完之后再探一次：还是拒。宿主里的文字改不动这一层。
      const after = validateToolCall('erp_query_documents', { docType: OFF_LIMITS, filters: {} });
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.code).toBe('DOCTYPE_NOT_ALLOWED');

      const probe = await rig.tools.call(
        { tool: 'erp_query_documents', args: { docType: OFF_LIMITS, filters: {} } }, rig.runId);
      expect(probe.status).toBe('denied');

      // 这一轮转发出去的 (capability, DocType) 组合里不许多出新东西。
      const pairs = new Set(
        (await rig.audit.byRun(rig.runId)).map((e) => e.capability + '|' + String(e.erpDoctype)));
      expect(pairs).toEqual(new Set(['erp.get|Purchase Order']));
      expect(pairs.has('erp.query|' + OFF_LIMITS)).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  it('injection: 正例 —— 那段文字确实读到了，并且被包成带来源的不可信文本', async () => {
    // 示范原文在 fixtures 里，测试只引用它的位置，不把载荷抄进来。
    expect(existsSync(TAINTED_FIXTURE)).toBe(true);

    const rig = rigForProbe();
    try {
      const client = new GatewayClient(rig.tools, rig.runId);
      const doc = await client.get('Purchase Order', FACTS.originalPo);

      const terms = untrustedField(doc, 'terms');
      expect(terms).not.toBeNull();
      if (!terms) return;

      expect(terms.__untrusted).toBe(true);
      expect(terms.source).toEqual({
        doctype: 'Purchase Order', name: FACTS.originalPo, field: 'terms',
      });
      expect(terms.value.length).toBeGreaterThan(0);

      // 参与计算的字段没有被包起来 —— 包错了后面算数会直接抛。
      expect(untrustedField(doc, 'docstatus')).toBeNull();
      expect(Number(doc.docstatus)).toBe(FACTS.originalPoDocstatus);
    } finally {
      rig.cleanup();
    }
  });
});
