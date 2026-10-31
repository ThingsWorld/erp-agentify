// 运行时 FLOOR。
//
// ⚠ 这一层在真实部署里跑在 Gateway 服务端，**学员改不到**。
// 它读的是 types.ts 里冻结的 FLOOR，不是 src/risk-map.ts。
// 学员把 risk-map 改松了，这里照样拦 —— 那正是 Task 04 要撞的那件事。

import {
  Capability, DocType, EffectProfile, Principal, CallRequest,
  DenyCode, DeniedError, FLOOR, TOOL_DOCTYPES,
} from './types.js';

export interface ApprovalService {
  verify(token: string, p: Principal, cap: Capability, args: Record<string, unknown>):
    Promise<{ ok: true; approvalId: string } | { ok: false; reason: string }>;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
  code?: DenyCode;
  approvalId: string | null;
  profile: EffectProfile;
}

/** 从冻结的 FLOOR 取画像。**不读学员的 risk-map。** */
export function profileFor(cap: Capability, args: Record<string, unknown>): EffectProfile {
  const base = FLOOR[cap];
  // changesPayee 说的是「把一张已有单据的收款方改掉」，不是「新建时填了供应商」。
  // 当前能力集没有 erp.update，所以恒 false。等有了改单能力它才有抓手。
  const isUpdate = false;
  const doc = (args.doc ?? {}) as Record<string, unknown>;
  const changesPayee = isUpdate && ('supplier' in doc || 'party' in doc || 'paid_to' in doc);
  return { ...base, changesPayee: base.changesPayee || changesPayee };
}

export class Policy {
  constructor(private approvals: ApprovalService) {}

  async check(p: Principal, req: CallRequest): Promise<PolicyDecision> {
    const known = Object.prototype.hasOwnProperty.call(FLOOR, req.capability);
    const profile = known
      ? profileFor(req.capability, req.args)
      : { channel: 'external' as const, irreversible: true, touchesMoney: true, changesPayee: true };

    const deny = (reason: string, code: DenyCode): PolicyDecision =>
      ({ allow: false, reason, code, approvalId: null, profile });

    // 未知能力按最高风险处理再拒 —— fail closed，不给「没列进表就放行」留口子。
    if (!known) return deny('未知能力 ' + req.capability, 'UNKNOWN_CAPABILITY');

    const dt = req.args.docType as DocType | undefined;
    if (dt !== undefined) {
      if (!TOOL_DOCTYPES.includes(dt)) return deny('未知 DocType ' + dt, 'UNKNOWN_DOCTYPE');
      // persona 的白名单比工具面窄。Purchase Invoice 工具收得下、persona 没权限 →
      // 拒，并且留一条 outcome='denied' 的审计。
      if (!p.persona.allowedDocTypes.includes(dt))
        return deny('DocType ' + dt + ' 不在 persona ' + p.persona.name + ' 的权限内', 'DOCTYPE_NOT_PERMITTED');
    }

    // 写操作必须带幂等键。没有键就没法原子占位，也就没法保证只执行一次。
    if (profile.channel === 'external' && !req.idempotencyKey)
      return deny('写操作必须携带 idempotencyKey', 'MISSING_IDEMPOTENCY_KEY');

    // FLOOR：不可逆 或 换收款人 → 必须有有效审批凭证。
    if (!(profile.irreversible || profile.changesPayee))
      return { allow: true, approvalId: null, profile };

    if (!req.approvalToken)
      return deny('高危写必须携带审批凭证（不可逆或更换收款方）', 'APPROVAL_REQUIRED');

    const v = await this.approvals.verify(req.approvalToken, p, req.capability, req.args);
    if (!v.ok) return deny('审批凭证无效：' + v.reason, 'APPROVAL_INVALID');
    return { allow: true, approvalId: v.approvalId, profile };
  }
}

/**
 * 测试与 mock 用的审批服务。凭证绑 (learnerId, capability, args 摘要)，
 * 内容一变旧凭证就失效 —— 防「拿一张批过的凭证去提交另一张单」。
 */
export class MemoryApprovals implements ApprovalService {
  private m = new Map<string, { learnerId: string; cap: Capability; digest: string; id: string }>();
  private n = 0;

  issue(p: Principal, cap: Capability, args: Record<string, unknown>): string {
    this.n += 1;
    const token = 'appr_' + this.n + '_' + p.learnerId;
    this.m.set(token, { learnerId: p.learnerId, cap, digest: JSON.stringify(args), id: 'A-' + this.n });
    return token;
  }

  async verify(token: string, p: Principal, cap: Capability, args: Record<string, unknown>) {
    const r = this.m.get(token);
    if (!r) return { ok: false as const, reason: '未知凭证' };
    if (r.learnerId !== p.learnerId) return { ok: false as const, reason: '凭证不属于该学员' };
    if (r.cap !== cap) return { ok: false as const, reason: '能力不匹配' };
    if (r.digest !== JSON.stringify(args)) return { ok: false as const, reason: '内容已变，旧审批失效' };
    return { ok: true as const, approvalId: r.id };
  }
}

export { DeniedError };
