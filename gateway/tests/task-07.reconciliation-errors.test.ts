import { describe, expect, it } from 'vitest';
import { makeRig } from '../src/harness.js';
import { GatewayClient } from '../src/gateway-client.js';
import { businessProbe, reconcile } from '../src/reconcile.js';
import { FACTS } from '../src/types.js';

const doc = {
  supplier: FACTS.supplier, schedule_date: '2026-09-25',
  items: [{ item_code: FACTS.itemCode, qty: 20, rate: FACTS.rate,
    warehouse: FACTS.warehouse, schedule_date: '2026-09-25' }],
};

describe('task-07 回查失败与歧义', () => {
  it('写响应丢失且回查超时，保持 uncertain，同键重放不重复写入', async () => {
    const rig = makeRig({ scenario: 'uncertain-a' });
    try {
      const list = rig.erp.list.bind(rig.erp);
      rig.erp.list = async (...args) => {
        if (rig.mock!.calls().some(c => c.op === 'insert')) throw new Error('回查超时');
        return list(...args);
      };
      const c = new GatewayClient(rig.tools, rig.runId);
      const result = await c.createDraft(doc, 't07-requery-timeout');
      expect(result.status).toBe('uncertain');
      expect(result.erpRef).toBeUndefined();
      expect(result.reason).toContain('回查本身失败');
      const row = await rig.ledger.get(rig.principal, 't07-requery-timeout');
      expect(row?.state).toBe('uncertain');
      expect((await c.createDraft(doc, 't07-requery-timeout')).status).toBe('uncertain');
      expect(rig.mock!.calls().filter(c => c.op === 'insert')).toHaveLength(1);
    } finally { rig.cleanup(); }
  });

  it('排除历史单据后只认新候选，多候选不确认失败，空结果才 confirmedAbsent', async () => {
    const rig = makeRig();
    try {
      const input = { erp: rig.erp, principal: rig.principal,
        docType: 'Purchase Order' as const, doc, knownBefore: [] as string[] };
      const c = new GatewayClient(rig.tools, rig.runId);
      expect((await reconcile(input)).confirmedAbsent).toBe(true);
      const old = await c.createDraft(doc, 'old-candidate');
      const before = [old.erpRef!.name];
      const next = await c.createDraft(doc, 'new-candidate');
      const unique = await reconcile({ ...input, knownBefore: before });
      expect(unique.found?.name).toBe(next.erpRef!.name);
      const ambiguous = await reconcile(input);
      expect(ambiguous.candidates).toBe(2);
      expect(ambiguous.found).toBeNull();
      expect(ambiguous.confirmedAbsent).not.toBe(true);
      expect(businessProbe({ ...doc, name: 'UNAVAILABLE-RESPONSE' })).not.toHaveProperty('name');
    } finally { rig.cleanup(); }
  });
});
