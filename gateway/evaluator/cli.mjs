// npm run eval:public 的落点。scripts/eval-public.mjs 用 tsx 拉起这个文件。
//
// 它做四件事，顺序不能换：
//   ① 跑三条自检轨迹（每条内部：跑 → 评价 → 清理）
//   ② 逐条打印四维分、两个合成分、判定
//   ③ 写 reports/eval-public.json
//   ④ 三条判定跟预期对不上就以非 0 退出
//
// 这里跑的是**公开那部分判据**。hidden 侧多的四样（维度权重分布、部分分的实际配比、
// staff-only 的期望值、negative fixture）不在这个进程里，也不在这个仓里。
// 公开这一侧全绿不等于 hidden 侧满分。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAllTrajectories, runPublicFileChecks, EXPECTED_VERDICT } from './scenarios.ts';
import { toContractReport } from './scoring.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY_ROOT = join(HERE, '..');
const OUT = join(GATEWAY_ROOT, 'reports', 'eval-public.json');

const pct = (n) => (n * 100).toFixed(0) + '%';
const pad = (s, n) => String(s).padEnd(n);

function printStatic(results) {
  console.log('公开静态判据（降级出来的布尔 check）');
  for (const r of results)
    console.log('  ' + (r.passed ? '[o]' : '[x]') + ' ' + pad(r.id, 28) + r.label
      + (r.passed ? '' : ' —— ' + r.failure_reason));
  console.log('');
}

function printTable(runs) {
  console.log('轨迹            BUSINESS COMM  SAFETY AUDIT  商业   安全   判定');
  for (const t of runs) {
    const r = t.report;
    console.log([
      pad(t.name, 15),
      pad(pct(r.business_state.score), 8),
      pad(pct(r.communicate.score), 5),
      pad(pct(r.safety.score), 6),
      pad(pct(r.audit.score), 6),
      pad(pct(r.business), 6),
      pad(pct(r.process), 6),
      r.verdict,
      t.matches_expectation ? '' : '  <- 应该是 ' + t.expected_verdict,
    ].join(' '));
  }
  console.log('');
}

function printDetail(t) {
  const r = t.report;
  console.log('── ' + t.name + ' · run ' + r.run_id + ' ────────────────────────────');
  for (const d of [r.business_state, r.communicate, r.safety, r.audit]) {
    console.log('  ' + pad(d.key, 16) + d.earned + '/' + d.total + ' = ' + pct(d.score));
    for (const c of d.checks) {
      if (c.passed) continue;
      console.log('      [x] ' + c.id + ' · ' + c.label);
      console.log('          期望 ' + JSON.stringify(c.expected));
      console.log('          实际 ' + JSON.stringify(c.actual));
      console.log('          ' + c.failure_reason);
    }
  }
  console.log('  safety gate     ' + (r.safety_gate.passed ? '放行' : '拦截'
    + '（' + r.safety_gate.failed_check_ids.join('、') + '）'));
  for (const m of t.meta)
    console.log('  ' + (m.passed ? '[o]' : '[x]') + ' 自检 ' + m.id + ' · ' + m.label
      + (m.passed ? '' : ' —— ' + m.failure_reason));
  console.log('  新增单据       ' + (r.created_erp_refs.map((x) => x.name).join('、') || '（无）'));
  console.log('  审计           ' + r.audit_refs.length + ' 条：'
    + r.audit_refs.map((a) => a.capability + '=' + a.outcome).join('  '));
  console.log('  清理           删掉 ' + (t.cleanup.removed.join('、') || '（无）')
    + '，残留 ' + (t.cleanup.residue.join('、') || '无'));
  console.log('');
}

async function main() {
  const staticResults = await runPublicFileChecks();
  const runs = await runAllTrajectories();

  printStatic(staticResults);
  printTable(runs);
  for (const t of runs) printDetail(t);

  const staticOk = staticResults.every((r) => r.passed);
  const verdictsOk = runs.every((t) => t.matches_expectation);
  const ok = staticOk && verdictsOk;

  const payload = {
    schema_version: 1,
    lab_id: 'lab-w12-erp-agentify',
    generated_at: new Date().toISOString(),
    mode: 'mock',
    ok,
    static_rubric: { ok: staticOk, checks: staticResults },
    trajectories: runs.map((t) => ({
      name: t.name,
      expected_verdict: t.expected_verdict,
      matches_expectation: t.matches_expectation,
      transcript: t.transcript,
      cleanup: t.cleanup,
      meta: t.meta,
      report: t.report,
      // 给学员看的那一份：staff-only 的期望值置 null，failure_reason 保留。
      // 跟上面那份来自同一次计算，不重跑。
      contract_report_redacted: toContractReport(t.report, { redact: true }),
    })),
    summary: {
      expected: EXPECTED_VERDICT,
      actual: Object.fromEntries(runs.map((t) => [t.name, t.report.verdict])),
      failures: [
        ...staticResults.filter((r) => !r.passed).map((r) => r.id + '：' + r.failure_reason),
        ...runs.filter((t) => !t.matches_expectation)
          .map((t) => t.name + ' 判成了 ' + t.report.verdict + '，应该是 ' + t.expected_verdict),
      ],
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const sec = runs.find((t) => t.name === 'security_fail');
  const biz = runs.find((t) => t.name === 'business_fail');
  if (sec && biz)
    console.log('对照：security_fail 商业 ' + pct(sec.report.business)
      + '，business_fail 商业 ' + pct(biz.report.business)
      + ' —— 前者更高，但因为安全没满分被拦下。这一行换成加权平均，它就被放行了。');

  console.log('报告：' + OUT);
  console.log(ok ? '\n[OK] 三条自检轨迹的判定与预期一致' : '\n[X] ' + payload.summary.failures.length + ' 项没过');
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('[X] 评分进程自己挂了：' + (e && e.stack ? e.stack : String(e)));
  process.exitCode = 1;
});
