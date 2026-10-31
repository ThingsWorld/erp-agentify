// Gateway 主编排。学员的沙箱只跟这一个入口说话。
//
// 固定执行顺序（学员改不了，因为这段代码在真实部署里不在学员的仓里）：
//
//   ① 令牌解析身份  → ② FLOOR 检查 → ③ 原子占位 → ④ 标记执行中
//     → ⑤ 带 site + persona 调宿主 → ⑥ 回查终态 → ⑦ 写审计 → ⑧ 落幕状态
//
// 尚待 Task 07 完成写后回查与异常对账。
//
//   task-07 洞③：写调用抛异常时直接判 failed。
//                 但调用失败 ≠ 什么都没发生 —— 单据可能已经落库了。

import { randomUUID } from 'node:crypto';
import {
  CallRequest, CallResult, Principal, ErpClient, Ledger, AuditLedger,
  DocType, ErpRef, Capability, DeniedError, UpstreamError,
} from './types.js';
import { Identity } from './identity.js';
import { Policy } from './policy.js';
import { digestArgs } from './audit-memory.js';
import { reconcile, businessProbe } from './reconcile.js';

export interface GatewayDeps {
  identity: Identity;
  policy: Policy;
  ledger: Ledger;
  audit: AuditLedger;
  erp: ErpClient;
  leaseMs?: number;
  now?: () => number;
}


export class ErpGateway {
  private leaseMs: number;
  private now: () => number;

  constructor(private d: GatewayDeps) {
    this.leaseMs = d.leaseMs ?? 30_000;
    this.now = d.now ?? Date.now;
  }

  /**
   * @param bearer  Authorization 头原文
   * @param req     学员的请求体
   * @param runId   一次 agent run 的标识。只用于审计串联，**不参与授权**
   */
  async call(bearer: string | undefined, req: CallRequest, runId: string): Promise<CallResult> {
    // ① 身份。唯一来源是令牌；req 一并传进去做防伪检查。
    let p: Principal;
    try {
      p = await this.d.identity.resolve(bearer, req as unknown as Record<string, unknown>);
    } catch (e) {
      if (e instanceof DeniedError) {
        // 身份就没解析出来，审计里没有可信的 learner/site 可写 —— 这条不进审计，
        // 直接把拒绝原因交回去。伪造身份的痕迹由上层（tools / 平台）记录。
        return { status: 'denied', code: e.code, reason: e.message };
      }
      throw e;
    }

    // ② FLOOR
    const decision = await this.d.policy.check(p, req);
    if (!decision.allow) {
      // 被拒也要留审计。不然「试过但被拦」事后查不到 ——
      // 一个 Agent 试了 50 次提交都被拦，是重要信号。
      const a = await this.audit(p, runId, null, req.idempotencyKey ?? null, req, null, null, 'denied');
      const out: CallResult = { status: 'denied', auditId: a };
      if (decision.reason !== undefined) out.reason = decision.reason;
      if (decision.code !== undefined) out.code = decision.code;
      return out;
    }

    // 读操作不进台账，直接走。
    if (decision.profile.channel === 'read') {
      const data = await this.read(p, req);
      const a = await this.audit(p, runId, null, null, req, null, null, 'done', this.now());
      return { status: 'done', data, auditId: a };
    }

    // ③ 原子占位
    const key = req.idempotencyKey as string;
    const owner = randomUUID();
    const res = await this.d.ledger.reserve(p, key, req.capability, owner, this.leaseMs);

    if (res.outcome === 'duplicate') {
      const out: CallResult = { status: 'deduped' };
      if (res.row.erpRef) out.erpRef = res.row.erpRef;
      return out;
    }
    if (res.outcome === 'in_flight') {
      const isUncertain = res.row.state === 'uncertain';
      const out: CallResult = {
        status: isUncertain ? 'uncertain' : 'in_flight',
        reason: isUncertain
          ? '同一业务键上一次执行终态不明，等待人工对账，不自动重试'
          : '同一业务键正在被另一次调用执行',
      };
      if (res.row.erpRef) out.erpRef = res.row.erpRef;
      return out;
    }

    // ④ 执行前先记下「本来有哪些」，丢响应时才分得清哪张是自己写的。
    const dt = req.args.docType as DocType;
    let knownBefore: string[];
    try {
      knownBefore = await this.snapshotNames(p, dt, req);
    } catch (e) {
      await this.d.ledger.fail(p, key, owner);
      throw e; // 还没有发送写请求；不能把基线查询失败当作空结果。
    }

    await this.d.ledger.begin(p, key, owner);
    let ref: ErpRef | null = null;
    try {
      ref = await this.write(p, req);
    } catch (e) {
      const mayHaveHappened = !(e instanceof UpstreamError) || e.effectMayHaveHappened;
      if (!mayHaveHappened) {
        await this.d.ledger.fail(p, key, owner);
        await this.audit(p, runId, decision.approvalId, key, req, null, null, 'denied');
        throw new UpstreamError('宿主确认写入失败：' + (e as Error).message, false);
      }
      // 先阻止同键重放，再回查；回查失败或歧义绝不能降为 failed。
      await this.d.ledger.markUncertain(p, key, owner, null);
      const rec = req.capability === 'erp.create_draft'
        ? await reconcile({ erp: this.d.erp, principal: p, docType: dt,
            doc: (req.args.doc ?? {}) as Record<string, unknown>, knownBefore })
        : { found: null, confirmedAbsent: false, reason: '提交响应丢失，需按原单核查终态' };
      if (rec.confirmedAbsent) {
        await this.d.ledger.fail(p, key, owner);
        await this.audit(p, runId, decision.approvalId, key, req, null, null, 'denied');
        throw new UpstreamError('回查确认未落库：' + rec.reason, false);
      }
      ref = rec.found;
      await this.d.ledger.markUncertain(p, key, owner, ref);
      const auditId = await this.audit(p, runId, decision.approvalId, key, req, ref, null, 'uncertain');
      const out: CallResult = { status: 'uncertain', auditId,
        reason: '写响应丢失；' + rec.reason + '；等待人工对账，不自动重试' };
      if (ref) out.erpRef = ref;
      return out;
    }

    // 成功审计必须使用回查的终态，不能把写接口的回执当成证据。
    let docstatus: number;
    try {
      const back = await this.d.erp.get(p.siteId, p.persona.name, dt, ref.name);
      docstatus = Number(back.docstatus);
      if (!Number.isFinite(docstatus)) throw new Error('回查未返回有效 docstatus');
    } catch {
      await this.d.ledger.markUncertain(p, key, owner, ref);
      const auditId = await this.audit(p, runId, decision.approvalId, key, req, ref, null, 'uncertain');
      return { status: 'uncertain', erpRef: ref, auditId, reason: '写入后无法确认宿主终态' };
    }
    if (docstatus !== this.expectedDocstatus(req.capability)) {
      await this.d.ledger.markUncertain(p, key, owner, ref);
      const auditId = await this.audit(p, runId, decision.approvalId, key, req, ref, docstatus, 'uncertain');
      return { status: 'uncertain', erpRef: ref, docstatus, auditId, reason: '回查状态与预期不符' };
    }

    await this.d.ledger.succeed(p, key, owner, ref);
    const a = await this.audit(p, runId, decision.approvalId, key, req, ref, docstatus, 'done', this.now());
    const done: CallResult = { status: 'done', erpRef: ref, auditId: a };
    if (docstatus !== null) done.docstatus = docstatus;
    return done;
  }

  private expectedDocstatus(cap: Capability): number {
    return cap === 'erp.submit' ? 1 : 0;
  }

  private async snapshotNames(p: Principal, dt: DocType, req: CallRequest): Promise<string[]> {
    if (req.capability !== 'erp.create_draft') return [];
    const probe = businessProbe((req.args.doc ?? {}) as Record<string, unknown>);
    if (Object.keys(probe).length === 0) return [];
    try {
      const rows = await this.d.erp.list(p.siteId, p.persona.name, dt, probe);
      return rows.map((r) => String(r.name));
    } catch (e) { throw new Error('写入前无法获取对账基线，停止写入：' + (e as Error).message); }
  }

  private async read(p: Principal, req: CallRequest): Promise<unknown> {
    const dt = req.args.docType as DocType;
    if (req.capability === 'erp.query')
      return this.d.erp.list(p.siteId, p.persona.name, dt, req.args.filters as Record<string, unknown>);
    return this.d.erp.get(p.siteId, p.persona.name, dt, req.args.name as string);
  }

  private async write(p: Principal, req: CallRequest): Promise<ErpRef> {
    const dt = req.args.docType as DocType;
    if (req.capability === 'erp.create_draft')
      return this.d.erp.insert(p.siteId, p.persona.name, dt, req.args.doc as Record<string, unknown>);
    return this.d.erp.submit(p.siteId, p.persona.name, dt, req.args.name as string);
  }

  private async audit(
    p: Principal, runId: string, approvalId: string | null, key: string | null,
    req: CallRequest, ref: ErpRef | null, docstatus: number | null,
    outcome: CallResult['status'], verifiedAt: number | null = null,
  ): Promise<string> {
    // learnerId / siteId 从 Principal 来，**不接受请求体传入** —— attribution 不可伪造。
    const a = await this.d.audit.append({
      learnerId: p.learnerId, siteId: p.siteId, runId, approvalId,
      idempotencyKey: key, capability: req.capability, argsDigest: digestArgs(req.args),
      erpDoctype: ref?.doctype ?? (req.args.docType as string) ?? null,
      erpName: ref?.name ?? (req.args.name as string) ?? null,
      docstatus, verifiedAt, outcome,
    });
    return a.id;
  }
}

export { DeniedError, UpstreamError };
