// 场景加载器：读 mock/scenarios/<id>.json，装配出 FakeErp + 令牌表。
//
// 场景是**声明式**的：种子来自 fixtures/erp-seed.json，场景只声明
// 「哪些 site」「patch 掉哪几个字段」「开哪些故障开关」。
// 十个场景共用一份种子，不会各自漂移。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocType, ErpPersona, FaultSwitches } from './types.js';
import { FakeErp } from './erp-fake.js';
import { MemoryTokenStore, TokenRecord } from './identity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Patch {
  site: string;
  doctype: DocType;
  name?: string;
  match?: Record<string, unknown>;
  set: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  seed: string;
  sites: string[];
  personas: Record<string, ErpPersona>;
  tokens: Record<string, { learnerId: string; siteId: string; persona: ErpPersona }>;
  faults: FaultSwitches;
  patches: Patch[];
  /** 只有 uncertain-c 用：把租约调小，让超时可测而不用等 30 秒。 */
  leaseMs?: number;
}

interface Seed {
  warehouse: string;
  doctypes: Record<string, Record<string, unknown>[]>;
}

export interface LoadedScenario {
  scenario: Scenario;
  erp: FakeErp;
  tokens: MemoryTokenStore;
  /** 场景的主 site（第一个）。 */
  site: string;
  leaseMs: number;
}

export function readScenario(id: string): Scenario {
  return JSON.parse(readFileSync(join(ROOT, 'mock', 'scenarios', id + '.json'), 'utf8')) as Scenario;
}

export function readSeed(rel = 'fixtures/erp-seed.json'): Seed {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Seed;
}

export function loadScenario(id: string): LoadedScenario {
  const scenario = readScenario(id);
  const seed = readSeed(scenario.seed);
  const erp = new FakeErp();

  for (const site of scenario.sites) {
    for (const [dt, rows] of Object.entries(seed.doctypes)) {
      for (const row of rows) {
        const { name, docstatus, ...fields } = row as { name: string; docstatus?: number };
        erp.seed(site, dt as DocType, name, fields, Number(docstatus ?? 0));
      }
    }
  }

  // patch 在种子之后、freeze 之前 —— reset() 回到的是「打过 patch 的场景初始态」。
  for (const p of scenario.patches ?? []) {
    for (const row of erp.snapshot(p.site, p.doctype)) {
      const hit = p.name ? row.name === p.name
        : Object.entries(p.match ?? {}).every(([k, v]) => row[k] === v);
      if (!hit) continue;
      const merged = { ...row, ...p.set } as Record<string, unknown> & { name: string; docstatus?: number };
      const { name, docstatus, ...rest } = merged;
      erp.seed(p.site, p.doctype, name, rest, Number(docstatus ?? 0));
    }
  }

  erp.freezeSeed();
  erp.setFaults(scenario.faults ?? {});

  const tokens = new MemoryTokenStore();
  for (const [tok, t] of Object.entries(scenario.tokens)) {
    const rec: TokenRecord = {
      learnerId: t.learnerId, siteId: t.siteId,
      personaName: t.persona.name, allowedDocTypes: t.persona.allowedDocTypes,
      expiresAt: Date.now() + 3_600_000, revoked: false,
    };
    tokens.put(tok, rec);
  }

  const site = scenario.sites[0];
  if (!site) throw new Error(`场景 ${id} 没有声明任何 site`);
  return { scenario, erp, tokens, site, leaseMs: scenario.leaseMs ?? 30_000 };
}
