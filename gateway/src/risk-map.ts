// 学员自己的风险分级表（Task 04）。
//
// ⚠ 这张表**只能在 FLOOR 之上收紧，不能放松**。
// 把 'erp.submit' 改成 read 不会让提交变成只读 —— Gateway 服务端的
// policy.check() 会用 types.ts 里冻结的 FLOOR 兜底，那段代码不在这个仓里。
//
// 上一课的实现正好相反：分级表是唯一那道闸，改一行就能把不可逆动作变成静默 no-op。
// 见 reference/lecture-9-approval.ts。

import { Capability, EffectProfile, FLOOR } from './types.js';

/** 学员可以改这里。改松了不生效，改紧了生效。 */
export const LOCAL_RISK_MAP: Record<Capability, EffectProfile> = {
  'erp.query':        { channel: 'read',     irreversible: false, touchesMoney: false, changesPayee: false },
  'erp.get':          { channel: 'read',     irreversible: false, touchesMoney: false, changesPayee: false },
  'erp.create_draft': { channel: 'external', irreversible: false, touchesMoney: true,  changesPayee: false },
  'erp.submit':       { channel: 'external', irreversible: true,  touchesMoney: true,  changesPayee: false },
};

const CHANNEL_RANK: Record<EffectProfile['channel'], number> = {
  read: 0, write_local: 1, exec: 2, external: 3,
};

/**
 * 取两者中**更严**的那个。这是「只能收紧」的实现。
 *
 * 注意它不是简单的「以 FLOOR 为准」—— 学员把 create_draft 标成 irreversible
 * （更严）是允许的，会真的要求审批。
 */
export function effectiveProfile(cap: Capability, local: Partial<EffectProfile> = {}): EffectProfile {
  const floor = FLOOR[cap];
  const candidate = { ...LOCAL_RISK_MAP[cap], ...local };
  return {
    channel: CHANNEL_RANK[candidate.channel] > CHANNEL_RANK[floor.channel]
      ? candidate.channel : floor.channel,
    irreversible: floor.irreversible || candidate.irreversible,
    touchesMoney: floor.touchesMoney || candidate.touchesMoney,
    changesPayee: floor.changesPayee || candidate.changesPayee,
  };
}

/** 这个操作要不要人批。 */
export function needsApproval(p: EffectProfile): boolean {
  return p.irreversible || p.changesPayee;
}
