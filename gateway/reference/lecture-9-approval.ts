// ⚠⚠⚠ 反例，别照抄。⚠⚠⚠
//
// 这是上一课（parallight-lecture-9-agentify）那个 connector 的审批与去重逻辑，
// 按原样复刻过来的。它跑得起来，测试也是绿的，code review 那两个人都没看出问题。
// 放在这里只有一个用处：让你把三处错看清楚，然后在自己的实现里避开。
//
// 它**不参与**本仓的任何编译产物，src/ 下没有一个文件 import 它。
//
// 三处错，各自对应本项目的一个 Task：
//
//   错处 ① 风险分级表是唯一那道闸        → task-04-risk-floor
//          表在学员自己的仓里，谁都能改。改一行，一个不可逆动作变成静默 no-op。
//
//   错处 ② 内存 Set 记幂等                → task-06-idempotency
//          Set 活在进程里。助手重启一次，之前成功过的键一个都不认识。
//
//   错处 ③ 检查与记住之间隔着两个 await   → task-06-idempotency
//          20 个同键并发全部通过检查，然后一张一张往 ERP 里写。实测 20 张单。
//
// 本仓里对应的正确写法：
//   src/policy.ts        FLOOR 跑在网关服务端，读 types.ts 冻结的表，学员改不到
//   src/risk-map.ts      学员自己的表，只能在 FLOOR 之上收紧
//   src/ledger-memory.ts reserve() 从进入到写下占位记录之间一个 await 都没有
//   store/schema.sql     insert ... on conflict do nothing，一条语句完成占位

export type ActionName =
  | 'erp.query' | 'erp.get' | 'erp.run_report' | 'erp.create_draft' | 'erp.submit';

export type RiskClass = 'read' | 'write' | 'external';

export interface ErpDoc { name: string; docstatus: number }

export interface ErpPort {
  query(doctype: string, filters: Record<string, unknown>): Promise<ErpDoc[]>;
  insert(payload: Record<string, unknown>): Promise<ErpDoc>;
  submit(name: string): Promise<ErpDoc>;
}

export interface ActionResult { status: 'done' | 'denied'; doc?: ErpDoc; reason?: string }

// 错处 ①：这张表是运行时唯一的那道闸。它跟调用它的代码在同一个仓里，
// 同一个人一次提交就能改。把 'erp.submit' 那一行改成 'read'，
// submit 就掉进下面的 read 分支 —— 而 read 分支只认得 query / get / run_report，
// 于是走到最后 return { status: 'done' }：什么都没做，回执说成功。
// 一行改动，测试全绿，供应商那边什么也收不到，采购那边以为发出去了。
const RISK: Record<ActionName, RiskClass> = {
  'erp.query': 'read',
  'erp.get': 'read',
  'erp.run_report': 'read',
  'erp.create_draft': 'write',
  'erp.submit': 'external',
};

// 错处 ②：内存去重。两个毛病叠在一起 ——
// 它活在进程里（重启即失忆），而且下面用它的方式本身就不是原子的。
const seen = new Set<string>();
const cached = new Map<string, ErpDoc>();

function classify(action: ActionName): RiskClass {
  return RISK[action];
}

/**
 * 人工审批。上一课这里是一次 HTTP 轮询，人在群里点「同意」之前它一直挂着。
 * 挂多久不重要 —— 重要的是它是个 await，下面那个去重正是被它切开的。
 */
async function waitForApproval(action: ActionName): Promise<boolean> {
  await new Promise<void>((r) => setTimeout(r, 0));
  return action !== 'erp.query';
}

export async function runAction(
  erp: ErpPort, action: ActionName, payload: Record<string, unknown>, key: string,
): Promise<ActionResult> {
  const risk = classify(action);

  if (risk === 'read') {
    if (action === 'erp.query') {
      const rows = await erp.query(String(payload.doctype ?? ''), {});
      const first = rows[0];
      return first ? { status: 'done', doc: first } : { status: 'done' };
    }
    // ↓ 掉进这里的东西全都走到这一行。分级表被改过之后，erp.submit 就在这一行结束。
    return { status: 'done' };
  }

  if (seen.has(key)) {                                   // ← 检查（原文 approval.ts:41）
    const hit = cached.get(key);
    return hit ? { status: 'done', doc: hit } : { status: 'done' };
  }

  const approved = await waitForApproval(action);         // ← await ①（原文 :47）
  if (!approved) return { status: 'denied', reason: '没批' };

  const doc = await erp.insert(payload);                  // ← await ②（原文 :51）
  seen.add(key); cached.set(key, doc);                    // ← 记住（原文 :52）

  // 错处 ③ 就在上面四行之间：从「检查」到「记住」隔着两个 await。
  // 20 个同键调用一起进来，全部在检查那一行放行 —— 因为那时候谁都还没写过 seen ——
  // 然后一张接一张地 insert。基线 6 张，跑完 26 张，Globex 收到 20 份一样的订单。
  //
  // 补救的方向不是「把 await 挪走」，是把「检查」和「占位」合成**一个不可分割的动作**：
  //   内存版 → 同步段里 Map.set，中间不许 await（src/ledger-memory.ts）
  //   落盘版 → openSync(path, 'wx')，一次系统调用（src/ledger-persistent.ts）
  //   数据库 → insert ... on conflict do nothing（store/schema.sql 的 erp_reserve）
  //
  // 还有一个不显眼的坑：这里记住的是 doc，但如果只 seen.add 不 cached.set，
  // 下一次命中去重时手里没有单号可以还给调用方，调用方只能再建一张 —— 去重做了等于没做。
  return { status: 'done', doc };
}

/** 测试里用来清场。真实运行里没有人调它 —— 进程一重启，上面那两个容器自己就空了。 */
export function resetForTest(): void {
  seen.clear();
  cached.clear();
}
