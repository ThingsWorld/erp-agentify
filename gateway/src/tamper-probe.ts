// TODO（task-04）：这个探针要证明一件事 ——
// **改自己仓里的风险表，绕不过 FLOOR。**
//
// 三段要你写：
//   ① 正常建一张草稿（docstatus=0）
//   ② 把 LOCAL_RISK_MAP 里 erp.submit 改成 read 语义，再提交那张草稿
//      —— 必须**被拒**，打印 code 与 reason
//   ③ 说清楚拦它的是哪一层，以及那一层为什么改不动
//
// 最后按确切单号清理，打印清理前后张数。脚本要能重复跑，不留残留。
// `npx tsx src/tamper-probe.ts` 退出码必须是 0。
// 篡改探针（Task 04）：把自己的风险分级表改松，看还能不能把不可逆动作放过去。
//
// 上一课的实现里，分级表就是唯一那道闸 —— 改一行，提交变成静默 no-op（reference/lecture-9-approval.ts）。
// 这一课不是。policy.ts 读的是 types.ts 里冻结的 FLOOR，不读 src/risk-map.ts，
// 而且那段代码在真实部署里跑在网关服务端，根本不在学员的仓里。
//
// 探针跑三步，每步都把结论打出来：
//   ① 正常建一张草稿（docstatus=0）
//   ② 把 LOCAL_RISK_MAP 的 erp.submit 改成 read 语义，再提交刚才那张 → 必须被拒
//   ③ 说清拦它的是哪一层
// 最后按**确切单号**把自己建的那张删掉，回到基线。可以反复跑，不留残留。
//
//   npx tsx src/tamper-probe.ts

import { EffectProfile, FACTS, FLOOR } from './types.js';
import { makeRig } from './harness.js';
import { GatewayClient, numberField } from './gateway-client.js';
import { PO_NAME_RE } from './erp-fake.js';
import { effectiveProfile, LOCAL_RISK_MAP } from './risk-map.js';
import { describeProfile, localMapOnlyVerdict, preflightCall } from './preflight.js';

const DOCTYPE = 'Purchase Order' as const;
const SCHEDULE_DATE = '2026-09-30';

/** 幂等键带业务语义，没有随机数 —— 重跑要能算出同一个键，reset 也靠它把痕迹找回来。 */
const DRAFT_KEY = `t04-probe|draft|${FACTS.itemCode}x${FACTS.requiredQty - FACTS.onHandQty}`;
const submitKeyFor = (name: string) => `t04-probe|submit|${name}`;

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('探针判定失败：' + msg);
}

function h(title: string): void {
  console.log('');
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length)));
}

const READ_LIKE: EffectProfile =
  { channel: 'read', irreversible: false, touchesMoney: false, changesPayee: false };

async function main(): Promise<void> {
  throw new Error("[task-04] tamper-probe 还没实现：见文件头的三段说明。");
}

try {
  await main();
  process.exitCode = 0;
} catch (e) {
  console.error('');
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
