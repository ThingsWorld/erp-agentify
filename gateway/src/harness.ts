// 装配台。测试、脚本、evaluator 都从这里拿一套接好线的 Gateway。
//
// **只维护这一份。** 测试里各自 new 一遍，改一个构造参数就要改十个文件。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLedger, DocType, ErpClient, Ledger, Principal } from './types.js';
import { Identity, MemoryTokenStore } from './identity.js';
import { Policy, MemoryApprovals } from './policy.js';
import { MemoryLedger } from './ledger-memory.js';
import { PersistentLedger } from './ledger-persistent.js';
import { MemoryAudit } from './audit-memory.js';
import { FileAudit } from './audit.js';
import { FakeErp } from './erp-fake.js';
import { HttpErp, CredentialResolver } from './erp-http.js';
import { ErpGateway } from './gateway.js';
import { Tools } from './tools.js';
import { loadScenario, LoadedScenario } from './erp-mock.js';

export interface Rig {
  gw: ErpGateway;
  tools: Tools;
  erp: ErpClient;
  /** 只有 mock 模式有。控制面与观测面在这上面。 */
  mock: FakeErp | null;
  ledger: Ledger;
  audit: AuditLedger;
  approvals: MemoryApprovals;
  principal: Principal;
  bearer: string;
  runId: string;
  site: string;
  scenario: LoadedScenario | null;
  /** 落盘台账 / 审计的工作目录。 */
  workDir: string;
  cleanup(): void;
}

export interface RigOptions {
  scenario?: string;
  /** two-sites / capstone 场景里有 tok_learner 和 tok_bob。 */
  token?: string;
  /** true = 用落盘台账与审计（Task 06 之后）。默认内存。 */
  persistent?: boolean;
  /** 覆盖租约时长。uncertain-c 要用很短的租约，别靠等 30 秒。 */
  leaseMs?: number;
  runId?: string;
  /** 复用已有工作目录 —— 跨进程 / 重启测试要指向同一个。 */
  workDir?: string;
}

let rigSeq = 0;

export function makeRig(opts: RigOptions = {}): Rig {
  const scenarioId = opts.scenario ?? 'baseline';
  const scenario = loadScenario(scenarioId);
  const token = opts.token ?? 'tok_learner';
  const rec = scenario.scenario.tokens[token];
  if (!rec) throw new Error('场景 ' + scenarioId + ' 里没有令牌 ' + token);

  const ownDir = opts.workDir === undefined;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'w12-rig-'));

  const ledger: Ledger = opts.persistent
    ? new PersistentLedger(join(workDir, 'ledger'))
    : new MemoryLedger();
  const audit: AuditLedger = opts.persistent
    ? new FileAudit(join(workDir, 'audit.ndjson'))
    : new MemoryAudit();

  const approvals = new MemoryApprovals();
  const gw = new ErpGateway({
    identity: new Identity(scenario.tokens),
    policy: new Policy(approvals),
    ledger, audit, erp: scenario.erp,
    leaseMs: opts.leaseMs ?? scenario.leaseMs,
  });

  rigSeq += 1;
  const bearer = 'Bearer ' + token;
  const principal: Principal = {
    learnerId: rec.learnerId, siteId: rec.siteId,
    persona: { name: rec.persona.name, allowedDocTypes: rec.persona.allowedDocTypes },
  };

  return {
    gw, tools: new Tools(gw, bearer), erp: scenario.erp, mock: scenario.erp,
    ledger, audit, approvals, principal, bearer, site: rec.siteId, scenario, workDir,
    runId: opts.runId ?? 'run-' + scenarioId + '-' + rigSeq,
    cleanup() { if (ownDir) rmSync(workDir, { recursive: true, force: true }); },
  };
}

const LIVE_PERSONA_DOCTYPES: DocType[] = ['Purchase Order', 'Item', 'Bin', 'Supplier'];

/** live 模式的装配。凭据从环境变量读，**绝不落盘、绝不打印**。 */
export function makeLiveRig(opts: { runId: string; leaseMs?: number; workDir: string }): Rig {
  const base = process.env.ERP_BASE ?? 'http://localhost:8080';
  const site = process.env.ERP_SITE ?? 'erp.localhost';
  const user = process.env.ERP_USER ?? '';
  const password = process.env.ERP_PASSWORD ?? '';
  if (!user || !password) throw new Error('live 模式需要 ERP_USER 与 ERP_PASSWORD（见 .env.example）');
  if (user === 'Administrator')
    throw new Error('不许用 Administrator —— 会触发 af-admin-credentials，该 Task 直接记 0 分');

  const creds: CredentialResolver = { async resolve() { return { host: site, user, password }; } };
  const erp = new HttpErp(base, creds);

  const tokens = new MemoryTokenStore();
  tokens.put('tok_live', {
    learnerId: 'live-learner', siteId: site, personaName: 'agent_svc',
    allowedDocTypes: LIVE_PERSONA_DOCTYPES, expiresAt: Date.now() + 3_600_000, revoked: false,
  });

  const ledger = new PersistentLedger(join(opts.workDir, 'ledger'));
  const audit = new FileAudit(join(opts.workDir, 'audit.ndjson'));
  const approvals = new MemoryApprovals();
  const gw = new ErpGateway({
    identity: new Identity(tokens), policy: new Policy(approvals),
    ledger, audit, erp, leaseMs: opts.leaseMs ?? 30_000,
  });

  const bearer = 'Bearer tok_live';
  return {
    gw, tools: new Tools(gw, bearer), erp, mock: null, ledger, audit, approvals,
    principal: {
      learnerId: 'live-learner', siteId: site,
      persona: { name: 'agent_svc', allowedDocTypes: LIVE_PERSONA_DOCTYPES },
    },
    bearer, site, scenario: null, workDir: opts.workDir, runId: opts.runId,
    cleanup() { /* live 的工作目录由调用方管 */ },
  };
}
