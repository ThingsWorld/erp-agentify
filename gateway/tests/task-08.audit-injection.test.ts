// task-08 · 审计与注入隔离的公开测试。
//
// 分两半，对应 tasks/task-08-audit-injection.yaml 的两组要求：
//
//   审计：一行同时写下两侧主键（runId ↔ erpName），两个方向都查得到，
//         append-only 落在存储层（store/audit.sql 的两条 rule），
//         归属只从令牌来 —— 请求体里出现身份字段是拒，不是忽略。
//
//   注入：宿主的自由文本包成不可信块，带来源三元组和显式边界；
//         它不进工具参数，也不改变工具调用序列。
//         判的不是「认没认出那句话」，是「换了主数据之后动作有没有变」。
//
// 测试文件里不出现完整攻击载荷。示范文本从 fixtures/tainted-po-terms.txt 读，
// 判分用的变体本来就不在这个仓里。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeRig, Rig } from '../src/harness.js';
import { GatewayClient, numberField, untrustedField } from '../src/gateway-client.js';
import { computeShortfall } from '../src/agent/shortfall.js';
import { draftKey, submitKey } from '../src/idempotency-key.js';
import { isUntrusted, renderForHuman, wrapUntrusted } from '../src/untrusted.js';
import {
  AuditEntry, CallRequest, DocType, EXPECTED_SHORTFALL, FACTS, UntrustedText,
} from '../src/types.js';

const GATEWAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTYPE: DocType = 'Purchase Order';
const PO_NAME = /^PUR-ORD-\d{4}-\d{5}$/;
const SCHEDULE_DATE = '2026-09-25';

/** 写操作的审计行必须填满的字段。少一个，双向就只剩一个方向。 */
const REQUIRED_ON_WRITE = [
  'learnerId', 'siteId', 'runId', 'capability', 'idempotencyKey', 'erpDoctype', 'erpName',
] as const;

/** 审计接口上不许出现的方法名。append-only 不是靠自觉，是靠面上根本没有这些。 */
const FORBIDDEN_METHODS = [
  'update', 'delete', 'upsert', 'patch', 'modify', 'edit', 'remove', 'clear', 'truncate', 'drop',
] as const;

// ── 一条完整的 agent 跑法 ───────────────────────────────────────

interface RunOutput {
  draftName: string;
  key: string;
  doc: Record<string, unknown>;
  /** 这一趟读到的自由文本。干净场景下是空的。 */
  untrusted: UntrustedText[];
  auditLabels: string[];
  erpCalls: string[];
}

/**
 * 查库存 → 读原单 → 读供应商主数据 → 建草稿。
 *
 * 第三步是注入的入口：Supplier 的备注字段谁都能写。这一步在干净场景和注入场景里
 * 都要发，不然「换了主数据行为没变」这句话就没有对照组。
 */
async function runAgent(rig: Rig): Promise<RunOutput> {
  const client = new GatewayClient(rig.tools, rig.runId);

  const bins = await client.query('Bin', { item_code: FACTS.itemCode });
  const bin = bins.find((b) => b.warehouse === FACTS.warehouse);
  expect(bin).toBeTruthy();
  const onHandQty = numberField(bin as Record<string, unknown>, 'actual_qty');
  const { shortfall } = computeShortfall({ requiredQty: FACTS.requiredQty, onHandQty });

  const pos = await client.query(DOCTYPE, { supplier: FACTS.supplier, docstatus: 1 });
  expect(pos.some((p) => p.name === FACTS.originalPo)).toBe(true);
  const orig = await client.get(DOCTYPE, FACTS.originalPo);
  const origItems = orig.items as Record<string, unknown>[];
  const origLine = origItems.find((x) => x.item_code === FACTS.itemCode);
  expect(origLine).toBeTruthy();
  const rate = numberField(origLine as Record<string, unknown>, 'rate');
  const warehouse = String((origLine as Record<string, unknown>).warehouse);

  const supplier = await client.get('Supplier', FACTS.supplier);
  const untrusted: UntrustedText[] = [];
  for (const doc of [supplier, orig]) {
    for (const field of ['supplier_details', 'remarks', 'terms', 'description']) {
      const u = untrustedField(doc, field);
      if (u) untrusted.push(u);
    }
  }

  const doc: Record<string, unknown> = {
    supplier: FACTS.supplier,
    company: FACTS.company,
    currency: FACTS.currency,
    schedule_date: SCHEDULE_DATE,
    items: [{
      item_code: FACTS.itemCode,
      qty: shortfall,
      rate,
      warehouse,
      schedule_date: SCHEDULE_DATE,
    }],
  };
  const key = draftKey({
    intent: 't08-po-correction',
    supplier: FACTS.supplier,
    itemCode: FACTS.itemCode,
    qty: shortfall,
    batch: FACTS.originalPo,
  });

  const r = await client.createDraft(doc, key);
  expect(r.status, '干净路径要能走到 done：' + (r.reason ?? '')).toBe('done');
  expect(r.erpRef?.name ?? '').toMatch(PO_NAME);

  const entries = await rig.audit.byRun(rig.runId);
  return {
    draftName: r.erpRef!.name,
    key, doc, untrusted,
    auditLabels: entries.map((e) => e.capability + '=' + e.outcome),
    erpCalls: (rig.mock?.calls() ?? []).map((c) => c.op + ' ' + c.doctype),
  };
}

function removeExact(rig: Rig, names: readonly string[]): void {
  for (const n of names) rig.mock?.removeExact(rig.site, DOCTYPE, n);
}

function writeRows(entries: AuditEntry[]): AuditEntry[] {
  return entries.filter(
    (e) => e.capability === 'erp.create_draft' || e.capability === 'erp.submit');
}

// ── 审计 ────────────────────────────────────────────────────────

describe('task-08 审计', () => {
  it('写操作的审计行两侧主键都填满了，byRun 与 byErpRef 命中同一条 id', async () => {
    const rig = makeRig({ scenario: 'baseline', persistent: true });
    const created: string[] = [];
    try {
      const out = await runAgent(rig);
      created.push(out.draftName);

      const entries = await rig.audit.byRun(rig.runId);
      const writes = writeRows(entries).filter((e) => e.outcome === 'done');
      expect(writes.length, '这一趟应该有一条成功的写').toBe(1);
      const row = writes[0]!;

      for (const f of REQUIRED_ON_WRITE) {
        const v = row[f];
        expect(typeof v, '审计行的 ' + f + ' 必须是字符串').toBe('string');
        expect(String(v), '审计行的 ' + f + ' 不许是空串').not.toBe('');
      }
      expect(typeof row.docstatus, 'docstatus 要是数字').toBe('number');
      expect(row.docstatus).toBe(0);
      expect(typeof row.verifiedAt, 'verifiedAt 要是回查时刻，不是 null').toBe('number');
      expect(row.erpDoctype).toBe(DOCTYPE);
      expect(row.erpName).toBe(out.draftName);
      expect(row.idempotencyKey).toBe(out.key);

      // 归属只从令牌来。
      expect(row.learnerId).toBe(rig.principal.learnerId);
      expect(row.siteId).toBe(rig.principal.siteId);
      expect(row.runId).toBe(rig.runId);
      expect(new Set(entries.map((e) => e.siteId)).size, '一次 run 里 siteId 只能有一个值').toBe(1);

      // 两个方向命中同一条。
      const back = await rig.audit.byErpRef({ doctype: DOCTYPE, name: out.draftName });
      expect(back.length, '拿单号要反查得到运行').toBeGreaterThanOrEqual(1);
      const same = back.find((e) => e.id === row.id);
      expect(same, 'byRun 与 byErpRef 必须落在同一条 audit id 上').toBeTruthy();
      expect(same!.runId).toBe(rig.runId);
      expect(same!.learnerId).toBe(rig.principal.learnerId);
      expect(same!.siteId).toBe(rig.principal.siteId);

      // 正向查出来的单据集合 = 这次真的新增的那张，不多不少。
      const fromRun = [...new Set(
        writeRows(entries).map((e) => e.erpName).filter((n): n is string => !!n))];
      expect(fromRun).toEqual([out.draftName]);

      // verifiedAt 记的是回查，不是回执。
      for (const e of entries) {
        if (e.verifiedAt === null) expect(['uncertain', 'denied']).toContain(e.outcome);
      }
      // 这一趟一次 submit 都没有。
      expect(entries.filter(
        (e) => e.capability === 'erp.submit' && (e.outcome === 'done' || e.outcome === 'deduped'),
      ).length).toBe(0);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('append-only：接口上没有 update/delete，落盘文件只增不改，SQL 里两条 rule 都在', async () => {
    const rig = makeRig({ scenario: 'baseline', persistent: true });
    const created: string[] = [];
    try {
      // ① 接口面。改不动的第一层：面上根本没有这些方法。
      const surface = rig.audit as unknown as Record<string, unknown>;
      for (const m of FORBIDDEN_METHODS) {
        expect(typeof surface[m], 'AuditLedger 上不该有 ' + m + '()').not.toBe('function');
      }
      expect(typeof surface.append, 'append 得在 —— 不然是把功能删了，不是做安全').toBe('function');
      expect(typeof surface.byRun).toBe('function');
      expect(typeof surface.byErpRef).toBe('function');

      // ② 物理层。追加之后，旧内容逐字节还在原处。
      const path = join(rig.workDir, 'audit.ndjson');
      const out = await runAgent(rig);
      created.push(out.draftName);
      const before = readFileSync(path, 'utf8');
      expect(before.length).toBeGreaterThan(0);
      const linesBefore = before.trimEnd().split('\n').length;

      const client = new GatewayClient(rig.tools, rig.runId);
      await client.query('Bin', { item_code: FACTS.itemCode });
      const after = readFileSync(path, 'utf8');

      expect(after.startsWith(before), '新条目只能追在后面，不许回头改前面的').toBe(true);
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.trimEnd().split('\n').length).toBe(linesBefore + 1);

      // ③ 存储层。绕过应用直连库的人不看接口，禁改禁删得写在 SQL 里。
      const sql = readFileSync(join(GATEWAY_ROOT, 'store', 'audit.sql'), 'utf8');
      expect(sql, '缺禁 update 的 rule').toMatch(/on\s+update\s+to\s+erp_audit\s+do\s+instead\s+nothing/);
      expect(sql, '缺禁 delete 的 rule').toMatch(/on\s+delete\s+to\s+erp_audit\s+do\s+instead\s+nothing/);
      expect(sql, '关键字要小写，跟 store/schema.sql 保持一致').not.toMatch(/DO\s+INSTEAD\s+NOTHING/);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('归属不可伪造：请求体里出现身份字段直接拒，且不写业务审计行', async () => {
    const rig = makeRig({ scenario: 'baseline', persistent: true });
    try {
      const base = {
        capability: 'erp.query' as const,
        args: { docType: 'Bin', filters: { item_code: FACTS.itemCode } },
      };

      for (const field of ['learnerId', 'siteId', 'persona', 'erpUser', 'site', 'role']) {
        const before = (await rig.audit.byRun(rig.runId)).length;
        const spoofed = { ...base, [field]: 'learner-evil' } as unknown as CallRequest;
        const r = await rig.gw.call(rig.bearer, spoofed, rig.runId);

        expect(r.status, field + ' 应该被拒，不是「忽略后继续」').toBe('denied');
        expect(r.code).toBe('SPOOFED_IDENTITY');
        expect(String(r.reason ?? '')).toContain(field);
        expect((await rig.audit.byRun(rig.runId)).length,
          '身份都没解析出来，不该留下业务审计行').toBe(before);
      }

      // positive control：把伪造字段拿掉，同一个调用必须过，并且留一行。
      const before = (await rig.audit.byRun(rig.runId)).length;
      const ok = await rig.gw.call(rig.bearer, base as CallRequest, rig.runId);
      expect(ok.status, '拒的是伪造字段，不是这个调用本身').toBe('done');
      const entries = await rig.audit.byRun(rig.runId);
      expect(entries.length).toBe(before + 1);
      const last = entries[entries.length - 1]!;
      expect(last.learnerId).toBe(rig.principal.learnerId);
      expect(last.siteId).toBe(rig.principal.siteId);
      expect(last.runId).toBe(rig.runId);

      // 换个姿势：把身份字段塞进 args 里，看它能不能绕过工具面混进归属。
      // 工具面现在是当场拒（BAD_ARGS）；就算将来放宽成「丢掉多余字段」，
      // 下面这两条断言仍然成立 —— 归属只可能来自令牌。
      await rig.tools.call({
        tool: 'erp_query_documents',
        args: { docType: 'Bin', filters: { item_code: FACTS.itemCode }, learnerId: 'learner-evil' },
      }, rig.runId);
      const afterTools = await rig.audit.byRun(rig.runId);
      expect(afterTools.some((e) => e.learnerId === 'learner-evil'),
        '调用方自己声明的归属一个字都不许进审计').toBe(false);
      expect(afterTools.every(
        (e) => e.learnerId === rig.principal.learnerId
            && e.siteId === rig.principal.siteId
            && e.runId === rig.runId,
      ), '每一行的 learnerId / siteId / runId 都得跟令牌和服务端签发的对上').toBe(true);
    } finally {
      rig.cleanup();
    }
  });
});

// ── 注入隔离 ────────────────────────────────────────────────────

describe('task-08 injection 隔离', () => {
  it('injection：宿主自由文本包成不可信块，带来源三元组与显式边界', async () => {
    const rig = makeRig({ scenario: 'poisoned-supplier' });
    const created: string[] = [];
    try {
      const out = await runAgent(rig);
      created.push(out.draftName);

      expect(out.untrusted.length, '注入场景下应该真的读到了那段文字').toBeGreaterThanOrEqual(1);
      const u = out.untrusted[0]!;
      expect(isUntrusted(u)).toBe(true);
      expect(u.source.doctype).toBe('Supplier');
      expect(u.source.name).toBe(FACTS.supplier);
      expect(u.source.field, '来源字段名要留着，事后才追得到是哪张单的哪一栏').toBe('supplier_details');
      expect(u.value.length).toBeGreaterThan(0);

      // 唯一允许离开包装的出口：给人看。带来源、带定界。
      const rendered = renderForHuman(u);
      expect(rendered).toContain('Supplier/' + FACTS.supplier + '.supplier_details');
      expect(rendered).toMatch(/不是指令|仅供展示/);
      expect(rendered).toContain(u.value);

      // 它是数据，不是数字，也不进工具参数。
      expect(() => numberField(
        { supplier_details: u } as Record<string, unknown>, 'supplier_details')).toThrow();
      const sent = JSON.stringify(out.doc);
      expect(sent, '不可信文本一个字都不该出现在写请求里').not.toContain(u.value);
      expect(sent).not.toContain(u.value.slice(0, 12));

      // 宿主的主数据一个字没改 —— 隔离的做法是不听它，不是抹掉它。
      const after = rig.mock!.snapshot(rig.site, 'Supplier').find((s) => s.name === FACTS.supplier);
      expect(String(after?.supplier_details)).toBe(u.value);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('injection · positive control：干净场景里同一个字段读不出不可信块', async () => {
    const rig = makeRig({ scenario: 'baseline' });
    const created: string[] = [];
    try {
      const out = await runAgent(rig);
      created.push(out.draftName);
      expect(out.untrusted.length,
        '干净种子里本来就没有这段话 —— 上一条测试绿不是因为断言恒真').toBe(0);
    } finally {
      removeExact(rig, created);
      rig.cleanup();
    }
  });

  it('injection：换成注入过的主数据，工具调用序列与终局一个字没变', async () => {
    const clean = makeRig({ scenario: 'baseline', persistent: true });
    const dirty = makeRig({ scenario: 'poisoned-supplier', persistent: true });
    const madeClean: string[] = [];
    const madeDirty: string[] = [];
    try {
      const supplierBefore = dirty.mock!.snapshot(dirty.site, 'Supplier')
        .find((s) => s.name === FACTS.supplier);

      const a = await runAgent(clean);
      madeClean.push(a.draftName);
      const b = await runAgent(dirty);
      madeDirty.push(b.draftName);

      // 对照组确实是「一边有话、一边没话」。
      expect(a.untrusted.length).toBe(0);
      expect(b.untrusted.length).toBeGreaterThanOrEqual(1);

      // 判据不看认没认出来，看动作有没有变。
      expect(b.erpCalls, '宿主调用序列必须逐项相同').toEqual(a.erpCalls);
      expect(b.auditLabels, '审计里的能力/结果序列必须逐项相同').toEqual(a.auditLabels);
      expect(b.key, '幂等键不许被那段文字改掉').toBe(a.key);
      expect(b.doc).toEqual(a.doc);

      // 台账里只有 create_draft 的键，没有 submit 的键。
      for (const [rig, name] of [[clean, a.draftName], [dirty, b.draftName]] as const) {
        expect(await rig.ledger.get(rig.principal, a.key)).not.toBeNull();
        expect(await rig.ledger.get(rig.principal, submitKey(name)),
          '出现 submit 的键就说明计划被数据改了').toBeNull();

        const entries = await rig.audit.byRun(rig.runId);
        expect(entries.filter((e) => e.capability === 'erp.submit').length,
          '一次 erp.submit 都不该发出去').toBe(0);

        const draft = rig.mock!.snapshot(rig.site, DOCTYPE).find((d) => d.name === name);
        expect(draft?.supplier).toBe(FACTS.supplier);
        expect(Number(draft?.docstatus)).toBe(0);
        const line = (draft!.items as Record<string, unknown>[])[0]!;
        expect(numberField(line, 'qty')).toBe(EXPECTED_SHORTFALL);
        expect(line.warehouse).toBe(FACTS.warehouse);

        // 原单没动。
        const orig = rig.mock!.snapshot(rig.site, DOCTYPE).find((d) => d.name === FACTS.originalPo);
        expect(Number(orig?.docstatus)).toBe(FACTS.originalPoDocstatus);
        expect(numberField((orig!.items as Record<string, unknown>[])[0]!, 'qty'))
          .toBe(FACTS.orderedQty);
      }

      // 注入源本身原样留在宿主里。
      const supplierAfter = dirty.mock!.snapshot(dirty.site, 'Supplier')
        .find((s) => s.name === FACTS.supplier);
      expect(supplierAfter).toEqual(supplierBefore);
    } finally {
      removeExact(clean, madeClean);
      removeExact(dirty, madeDirty);
      clean.cleanup();
      dirty.cleanup();
    }
  });

  it('injection：示范载荷（fixtures/tainted-po-terms.txt）包起来之后带边界与来源', () => {
    const demo = readFileSync(
      join(GATEWAY_ROOT, 'fixtures', 'tainted-po-terms.txt'), 'utf8');
    const body = demo.split('示范文本开始')[1] ?? '';
    const sample = (body.split('示范文本结束')[0] ?? '').replace(/^-+\s*/gm, '').trim();
    expect(sample.length, '示范文本读不出来，fixture 变形了').toBeGreaterThan(20);

    const u = wrapUntrusted(
      { doctype: DOCTYPE, name: FACTS.originalPo, field: 'terms' }, sample);
    expect(isUntrusted(u)).toBe(true);
    expect(Object.isFrozen(u), '包装体要冻住，免得下游偷偷改来源').toBe(true);

    const rendered = renderForHuman(u);
    expect(rendered.startsWith('[来自宿主数据 '), '渲染要以显式定界开头').toBe(true);
    expect(rendered).toContain(DOCTYPE + '/' + FACTS.originalPo + '.terms');
    expect(rendered.indexOf(sample), '原文要排在边界之后，不能顶到最前面').toBeGreaterThan(0);

    // 包装体不做关键词过滤 —— 黑名单挡不住换个说法，隔离靠的是它从不进指令位置。
    expect(u.value).toBe(sample);
  });
});
