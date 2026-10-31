// ⚠⚠⚠ 反例，别照抄。⚠⚠⚠
//
// 上一课那个 connector 的限流与审批边界（limits.ts），原样复刻。
// 跟 lecture-9-approval.ts 一样，它不参与本仓的任何编译产物，没人 import 它。
//
// 它想解决的问题是对的：Agent 会失控地重复调用，得有个上限；
// 大额动作得有人批。错的是把这两件事做成了「唯一的那道闸」，
// 而且闸的开关全在调用方能碰到的地方。
//
// 五处错，各自对应本项目的一个 Task：
//
//   错处 ① 计数器活在进程里              → task-06-idempotency
//          三个副本 = 三倍配额，重启 = 配额清零。它拦不住重复，只拦得住手速。
//
//   错处 ② 用 Date.now 做滑窗            → task-06-idempotency / task-07
//          节流不是幂等。窗口一过，同一件事照样能再做一遍，而且这次「合规」。
//
//   错处 ③ 「内部调用」从请求体读          → task-03-identity-isolation
//          req.role === 'internal' 就免检。谁都能在 body 里写这三个字。
//
//   错处 ④ 用金额阈值决定要不要审批        → task-04-risk-floor
//          金额只是四个属性里的一个。0 元的提交照样不可逆，照样该有人批。
//
//   错处 ⑤ 限流器自己挂了就放行（fail open）→ task-02 / task-04
//          闸门坏了应该关死，不是敞开。
//
// 本仓里对应的正确写法：
//   src/identity.ts   身份只从平台令牌解析，请求体出现身份字段直接拒
//   src/policy.ts     FLOOR 按 irreversible / changesPayee 判审批，不按金额
//   src/types.ts      EffectProfile 是四个正交属性，不是一个「高危」标签
//   src/tool-schema.ts 未知能力按最高风险处理再拒 —— fail closed

export type ActionName =
  | 'erp.query' | 'erp.get' | 'erp.run_report' | 'erp.create_draft' | 'erp.submit';

/** 上一课的请求体。注意 role 和 tenant 都在这里 —— 这就是错处 ③ 的入口。 */
export interface IncomingRequest {
  action: ActionName;
  /** 调用方自己声明的角色。'internal' 免限流、免审批。 */
  role?: string;
  /** 调用方自己声明的租户。计数器按它分桶。 */
  tenant?: string;
  amount?: number;
  payload?: Record<string, unknown>;
}

export interface LimitDecision {
  allow: boolean;
  needsApproval: boolean;
  reason: string;
}

// 错处 ①：每分钟多少次，记在模块级的 Map 里。
// 部署三个副本就是每分钟 3×N 次，谁都不知道真实上限是多少；
// 滚动发布一次，所有计数器归零，Agent 可以立刻再打满一轮。
const WINDOW_MS = 60_000;
const PER_MINUTE: Record<ActionName, number> = {
  'erp.query': 120,
  'erp.get': 120,
  'erp.run_report': 20,
  'erp.create_draft': 10,
  'erp.submit': 5,          // ← 「一分钟最多提交五次」。五次不可逆动作，也叫限流。
};

/** bucket key -> 这一分钟里的调用时刻。 */
const hits = new Map<string, number[]>();

/** 金额超过这个数才要人批。错处 ④ 就是这一行。 */
const APPROVAL_THRESHOLD = 10_000;

function bucketKey(req: IncomingRequest): string {
  // 租户也是调用方自己报的。换一个 tenant 字符串就是一个全新的配额桶。
  return (req.tenant ?? 'default') + '::' + req.action;
}

/**
 * 判这一次调用放不放行、要不要人批。
 *
 * 整个函数是上一课运行时唯一的那道闸 —— 它返回 allow: true 之后，
 * 后面就直接 erp.insert / erp.submit 了，没有第二层。
 */
export function checkLimits(req: IncomingRequest, now: number = Date.now()): LimitDecision {
  // 错处 ③：身份从请求体读。写 'internal' 三个字就绕过底下全部逻辑。
  // 本仓里这条路是走不通的 —— identity.ts 见到 role 字段直接抛 DeniedError，
  // 而且是拒绝，不是忽略：忽略会让调用方以为生效了。
  if (req.role === 'internal') {
    return { allow: true, needsApproval: false, reason: '内部调用，免检' };
  }

  try {
    // 错处 ②：Date.now 的滑动窗口。
    // 它管的是「一分钟内几次」，跟「这是不是同一件事」没有关系。
    // 用户点三次重试落在三分钟里，三次全部合规，ERP 里三张单。
    const k = bucketKey(req);
    const recent = (hits.get(k) ?? []).filter((t) => now - t < WINDOW_MS);
    const cap = PER_MINUTE[req.action];
    if (recent.length >= cap) {
      return { allow: false, needsApproval: false, reason: '超出每分钟 ' + cap + ' 次' };
    }
    recent.push(now);
    hits.set(k, recent);
  } catch (e) {
    // 错处 ⑤：限流器自己出问题就放行。
    // 写这一行的人想的是「别让监控组件拖垮主流程」，方向反了 ——
    // 闸门坏了要关死。fail closed 才是这类代码的默认值。
    return { allow: true, needsApproval: false, reason: '限流器异常，放行：' + (e as Error).message };
  }

  // 错处 ④：金额阈值当审批边界。
  // 一张 9,999 元的采购单提交出去，不可逆、供应商收到确认函、钱要付 —— 不用批。
  // 一张 10,001 元的草稿，能删能改，要批。
  // 金额只是 EffectProfile 四个属性里的 touchesMoney 那一位，
  // 真正决定要不要人批的是 irreversible 和 changesPayee（src/policy.ts）。
  const amount = req.amount ?? 0;
  if (amount > APPROVAL_THRESHOLD) {
    return { allow: true, needsApproval: true, reason: '金额 ' + amount + ' 超过阈值' };
  }

  return { allow: true, needsApproval: false, reason: '在配额内' };
}

/** 测试里清场。生产上没人调 —— 进程重启就是天然的清场，这本身就是错处 ①。 */
export function resetForTest(): void {
  hits.clear();
}
