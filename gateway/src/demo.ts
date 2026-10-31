// 演示：一条完整链路。`npm run demo:mock` 调它。
//
// 这不是作业的一部分，是给你看「跑起来是什么样」。

import { makeRig } from './harness.js';
import { GatewayClient } from './gateway-client.js';
import { createCorrectionDraft } from './agent/create-draft.js';
import { FACTS } from './types.js';

const rig = makeRig({ scenario: 'baseline' });
const mock = rig.mock;
if (!mock) throw new Error('demo 只跑 mock');

try {
  const before = mock.count(rig.site, 'Purchase Order');
  console.log('场景 baseline · site ' + rig.site);
  console.log('运行前采购单 ' + before + ' 张（基线应为 ' + FACTS.baselinePurchaseOrders + '）\n');

  const client = new GatewayClient(rig.tools, rig.runId);
  const out = await createCorrectionDraft(client);

  const after = mock.count(rig.site, 'Purchase Order');
  console.log('调用结果  status=' + out.result.status
    + '  ref=' + (out.result.erpRef?.name ?? '-')
    + '  docstatus=' + out.result.docstatus);
  console.log('采购单     ' + before + ' → ' + after);

  const entries = await rig.audit.byRun(rig.runId);
  console.log('审计       ' + entries.length + ' 条：'
    + entries.map((e) => e.capability + '=' + e.outcome).join('  '));

  const row = await rig.ledger.get(rig.principal, '');
  void row;
  console.log('\n---------------- Agent 给用户的答复 ----------------');
  console.log(out.reply);
  console.log('---------------------------------------------------\n');

  // 演示完把自己建的那张删掉，回到基线。**按确切单号删，不按时间窗口。**
  if (out.result.erpRef) mock.removeExact(rig.site, 'Purchase Order', out.result.erpRef.name);
  console.log('清理后采购单 ' + mock.count(rig.site, 'Purchase Order') + ' 张');
} finally {
  rig.cleanup();
}
