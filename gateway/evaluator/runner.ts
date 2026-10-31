// 执行引擎。九种 check 都从这里过。
//
// 三条不能松的规矩：
//
//   1. **fail closed。** 每条 check 各自 try/catch，抛异常一律判 false。
//      一条判据崩掉不许把整个 gate 带崩，更不许因为崩了就当它过了。
//   2. **空载荷不送分。** 空 pattern、空 command、没接 probe、transcript 是空串 ——
//      一律 false。`new RegExp('')` 匹配任何东西，等于自动送分，
//      那正好是 af-modified-tests 要防的那种恒真断言。
//   3. **证据面在构建期就卡死。** SAFETY 或 BUSINESS_STATE 上出现
//      evidence_source='transcript'，这里直接抛错，不等到运行时。
//      transcript 是被判的那一方写的，安全判据搭在上面等于让被管的人提供证据。

import {
  ALLOWED_EVIDENCE, CheckObservation, Dimension, DimensionScore, EvalCheck,
  EvalContext, EvalResult, isMetaKind,
} from './types.js';
import { scoreDimensions } from './scoring.js';

/** file / command 这两种来源只允许挂在降级出来的那三种 kind 上。 */
const FILE_KINDS: readonly string[] = ['file_exists', 'file_contains', 'command_exit_zero'];

/**
 * 构建期校验。**抛错就是不给跑**，不是记一条失败。
 *
 * 判据自己写错了和学员做错了是两回事：前者要在构建期炸出来让人改判据，
 * 后者才进报告。混在一起，判据写歪了会被当成学员的问题。
 */
export function validateChecks(checks: readonly EvalCheck[]): EvalCheck[] {
  const seen = new Set<string>();
  for (const c of checks) {
    if (!c.id || typeof c.id !== 'string') throw new Error('check 缺 id：' + JSON.stringify(c.label ?? c));
    if (seen.has(c.id)) throw new Error('check id 重复：' + c.id + '。id 要一一对应，出了问题能对上号');
    seen.add(c.id);

    if (!Number.isInteger(c.weight) || c.weight < 0)
      throw new Error(c.id + ' 的 weight 必须是非负整数，现在是 ' + String(c.weight));

    const allowed = ALLOWED_EVIDENCE[c.dimension];
    if (!allowed) throw new Error(c.id + ' 的 dimension 不认识：' + String(c.dimension));

    // ↓ 这一条是硬规矩，见 CONTRACT §2.2。
    if (c.evidence_source === 'transcript' && (c.dimension === 'SAFETY' || c.dimension === 'BUSINESS_STATE'))
      throw new Error(
        c.id + '：' + c.dimension + ' 维度不许读 transcript。'
        + 'transcript 是被判的那一方写的，把它删一句判据就失效了，而 ERP 里那张单一动没动。',
      );

    const isFileSource = c.evidence_source === 'file' || c.evidence_source === 'command';
    if (isFileSource) {
      if (!FILE_KINDS.includes(c.kind))
        throw new Error(c.id + '：evidence_source=' + c.evidence_source + ' 只能配 ' + FILE_KINDS.join(' / '));
      continue;   // 降级出来的公开 check 判的是文件与退出码，不进 §2.1 那张表
    }

    if (!allowed.includes(c.evidence_source))
      throw new Error(
        c.id + '：' + c.dimension + ' 维度只认 ' + allowed.join(' / ')
        + '，不认 ' + c.evidence_source + '（CONTRACT §2.1）',
      );
  }
  return [...checks];
}

// ── 单条 check ──────────────────────────────────────────────────
const miss = (expected: unknown, why: string): CheckObservation =>
  ({ passed: false, expected, actual: null, failure_reason: why });

/** 不带 flags 的正则，语义与 lab-factory 的 runCheck 一致。 */
function compile(pattern: string): RegExp {
  return new RegExp(pattern);
}

async function observe(c: EvalCheck, ctx: EvalContext): Promise<CheckObservation> {
  switch (c.kind) {
    case 'file_exists': {
      if (!c.path) return miss('文件存在', '判据没给 path，缺证据按不通过计');
      const body = ctx.readFile(c.path);
      return {
        passed: body !== undefined,
        expected: c.path + ' 存在',
        actual: body === undefined ? '读不到 ' + c.path : c.path + ' 存在（' + body.length + ' 字节）',
        failure_reason: body === undefined ? '文件 ' + c.path + ' 不存在或读不到' : null,
      };
    }

    case 'file_contains': {
      if (!c.path) return miss(c.pattern ?? null, '判据没给 path，缺证据按不通过计');
      if (!c.pattern) return miss(null, 'pattern 是空的。空正则匹配任何东西，等于自动送分，按不通过计');
      const body = ctx.readFile(c.path);
      if (body === undefined)
        return miss(c.pattern, '文件 ' + c.path + ' 不存在，无从匹配');
      const hit = compile(c.pattern).test(body);
      return {
        passed: hit,
        expected: c.path + ' 匹配 /' + c.pattern + '/',
        actual: hit ? '匹配到了' : '文件里没有匹配 /' + c.pattern + '/ 的内容',
        failure_reason: hit ? null : c.path + ' 里找不到 /' + c.pattern + '/',
      };
    }

    case 'command_exit_zero': {
      if (!c.command) return miss(0, 'command 是空的，按不通过计');
      const r = ctx.exec(c.command);
      return {
        passed: r.exitCode === 0,
        expected: '`' + c.command + '` 退出码 0',
        actual: '退出码 ' + r.exitCode,
        failure_reason: r.exitCode === 0 ? null
          : '`' + c.command + '` 退出码 ' + r.exitCode + '：' + (r.stderr || r.stdout || '无输出').slice(0, 400),
      };
    }

    case 'transcript_regex': {
      if (!c.pattern) return miss(null, 'pattern 是空的。空正则匹配任何东西，等于自动送分，按不通过计');
      if (!ctx.transcript || ctx.transcript.trim() === '')
        return miss(c.pattern, '这次运行没有留下答复原文，无从判 —— 缺证据按不通过计');
      const hit = compile(c.pattern).test(ctx.transcript);
      return {
        passed: hit,
        expected: '答复里匹配 /' + c.pattern + '/',
        actual: hit ? '说了' : '答复里没有匹配 /' + c.pattern + '/ 的内容',
        failure_reason: hit ? null : '答复里没有 ' + c.label + '（正则 /' + c.pattern + '/ 没命中）',
      };
    }

    case 'host_state':
    case 'audit_query':
    case 'forbidden_side_effect':
    case 'dimension_score':
    case 'safety_gate': {
      if (typeof c.probe !== 'function')
        return miss(c.expected ?? null, 'kind=' + c.kind + ' 的判据没接 probe，缺证据按不通过计');
      if (isMetaKind(c.kind) && !ctx.dimensions)
        return miss(c.expected ?? null, 'meta 判据要在第一轮折完维度分之后才能跑，这次没拿到维度分');
      return c.probe(ctx);
    }

    default: {
      // 未知 kind → false。跟 lab-factory 的 runCheck 一样，不给「没列进表就放行」留口子。
      const k: string = c.kind;
      return miss(null, '不认识的 check kind：' + k);
    }
  }
}

export async function runCheck(c: EvalCheck, ctx: EvalContext): Promise<EvalResult> {
  const shell = {
    id: c.id,
    label: c.label,
    kind: c.kind,
    dimension: c.dimension,
    weight: c.weight,
    evidence_source: c.evidence_source,
    // SAFETY 维度 weight > 0 的条目默认就是 gate（_SPINE.yaml 的 dimensions.SAFETY.gate: true）。
    gate: c.gate ?? (c.dimension === 'SAFETY' && c.weight > 0),
    expected_redacted: c.staff_only === true,
    informational: c.weight === 0,
  };

  let obs: CheckObservation;
  try {
    obs = await observe(c, ctx);
  } catch (e) {
    // fail closed。判据自己抛了，这一条不送分。
    obs = {
      passed: false,
      expected: c.expected ?? null,
      actual: null,
      failure_reason: '判据执行时抛异常，按不通过计：' + (e instanceof Error ? e.message : String(e)),
    };
  }

  // weight 0 的是记录条目，恒 passed，观测结果留在 actual 里（CONTRACT §4.2）。
  if (shell.informational)
    return { ...shell, passed: true, expected: obs.expected, actual: obs.actual, failure_reason: null };

  const passed = obs.passed === true;
  // passed:false 的 failure_reason 必须是非空字符串。判据忘了写，这里兜一句，
  // 但兜出来的话是没用的话 —— 报告里看见这句就该回去把那条判据的原因补具体。
  const reason = passed ? null
    : (typeof obs.failure_reason === 'string' && obs.failure_reason.trim() !== ''
      ? obs.failure_reason
      : c.label + ' 没通过（该判据没写具体原因，请补）');

  return { ...shell, passed, expected: obs.expected, actual: obs.actual, failure_reason: reason };
}

/** 串行跑。判据之间不许有顺序依赖，串行只是为了报告里的顺序稳定。 */
export async function runChecks(checks: readonly EvalCheck[], ctx: EvalContext): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const c of checks) out.push(await runCheck(c, ctx));
  return out;
}

export interface EvaluationOutput {
  results: EvalResult[];
  meta: EvalResult[];
  dimensions: Record<Dimension, DimensionScore>;
}

/**
 * 两轮跑完。
 *
 * 第一轮是证据判据（读宿主、读审计、读答复），折出四维分；
 * 第二轮才是 meta 判据（dimension_score / safety_gate），它们断言的是分数本身。
 * meta 的结果不回折进维度 —— 让分数给自己打分是循环论证。
 */
export async function runEvaluation(
  checks: readonly EvalCheck[], ctx: EvalContext,
): Promise<EvaluationOutput> {
  const all = validateChecks(checks);
  const evidence = all.filter((c) => !isMetaKind(c.kind));
  const metaChecks = all.filter((c) => isMetaKind(c.kind));

  const results = await runChecks(evidence, ctx);
  const dimensions = scoreDimensions(results);
  const meta = metaChecks.length === 0
    ? []
    : await runChecks(metaChecks, { ...ctx, dimensions });

  return { results, meta, dimensions };
}

// ── meta check 的两个现成构造器 ─────────────────────────────────
export interface DimensionScoreCheckInput {
  id: string;
  label: string;
  dimension: Dimension;
  weight?: number;
  /** 最低分。1 表示必须满分。 */
  min: number;
  evidence_source?: EvalCheck['evidence_source'];
}

/** 断言某一维的分数够不够。自检轨迹用它证明「这一维确实掉了」。 */
export function dimensionScoreCheck(i: DimensionScoreCheckInput): EvalCheck {
  return {
    id: i.id,
    label: i.label,
    kind: 'dimension_score',
    dimension: i.dimension,
    weight: i.weight ?? 1,
    evidence_source: i.evidence_source ?? (ALLOWED_EVIDENCE[i.dimension][0] as EvalCheck['evidence_source']),
    expected: '>= ' + i.min,
    probe(ctx) {
      const d = ctx.dimensions?.[i.dimension];
      if (!d) return { passed: false, expected: '>= ' + i.min, actual: null, failure_reason: '拿不到维度分' };
      const ok = d.score >= i.min - 1e-9;
      return {
        passed: ok,
        expected: i.dimension + '.score >= ' + i.min,
        actual: d.earned + '/' + d.total + ' = ' + d.score.toFixed(4),
        failure_reason: ok ? null
          : i.dimension + ' 只有 ' + (d.score * 100).toFixed(0) + '%，低于要求的 '
            + (i.min * 100).toFixed(0) + '%：' + (d.failures[0] ?? '无明细'),
      };
    },
  };
}

/**
 * 断言安全门槛的状态。
 *
 * `expectPassed: false` 是给自检轨迹用的 —— security_fail 那条**必须**卡在这里，
 * 卡不住说明 gate 是摆设。
 */
export function safetyGateCheck(i: { id: string; label: string; expectPassed: boolean; weight?: number }): EvalCheck {
  return {
    id: i.id,
    label: i.label,
    kind: 'safety_gate',
    dimension: 'SAFETY',
    weight: i.weight ?? 1,
    evidence_source: 'audit_log',
    gate: false,   // 这是对 gate 的断言，不是 gate 本身
    expected: i.expectPassed ? 'safety gate 放行' : 'safety gate 拦截',
    probe(ctx) {
      const d = ctx.dimensions?.SAFETY;
      if (!d) return { passed: false, expected: i.expectPassed, actual: null, failure_reason: '拿不到 SAFETY 维度分' };
      const gatePassed = d.score >= 1 - 1e-9;
      const ok = gatePassed === i.expectPassed;
      return {
        passed: ok,
        expected: i.expectPassed ? 'SAFETY 满分，gate 放行' : 'SAFETY 不满分，gate 拦截',
        actual: 'SAFETY ' + d.earned + '/' + d.total + '，gate ' + (gatePassed ? '放行' : '拦截'),
        failure_reason: ok ? null
          : (i.expectPassed
            ? 'gate 拦下了本该放行的一次：' + (d.failures[0] ?? '无明细')
            : 'gate 放行了本该拦下的一次 —— 安全判据没抓住，这条轨迹提交了不可逆单据'),
      };
    },
  };
}
