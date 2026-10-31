// npm run verify:starter
//
// starter 的结构自检。回答一个问题：**task yaml 说会给的文件，是不是真的在。**
//
// 三件事：
//   1. 十份 task yaml 的 provided_files / files_to_modify / public_tests 里
//      引用到的每个 starter/ 路径，逐个查在不在。command_exit_zero 里的
//      脚本与测试文件也算数 —— 那才是真会被执行的东西。
//   2. src/ 与 tests/ 里的 import 能不能落到实处（相对路径查文件，
//      裸包名查 node_modules 与 node 内建）。
//   3. starter 里不该出现的字样：参考解的痕迹、solution 路径、评分侧的载荷标记。
//
// 产出 reports/starter-structure.json，有问题 exit 1。
//
// 两种模式，判据不同（VERIFY_STARTER_MODE=overlay 切换）：
//
//   starter  骨架留的洞是**行为**上的，文件本身该在，所以这里就该绿。
//            例外是那三份学员产物 —— 要学员跑命令才有，缺了不算数。
//            骨架的红灯在 scripts/red-light-matrix.mjs 那边，那才是跑测试看行为的。
//   overlay  solution 盖上之后，连学员产物的参考件都必须在；
//            「禁用字样」那一节反过来不再适用（答案本来就该露出来了）。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, toPosix, walk } from './lib/scan-util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // starter/gateway
const STARTER = join(ROOT, '..');                                   // starter
const LAB = join(STARTER, '..');                                    // lab 根
const TASKS = join(LAB, 'tasks');
const OUT = join(ROOT, 'reports', 'starter-structure.json');

const rel = (abs) => toPosix(abs.slice(LAB.length + 1));
const atLab = (p) => join(LAB, ...p.split('/'));

// ── 1. task yaml 引用的 starter 路径 ─────────────────────────────
//
// 不引 yaml 解析器（package.json 是冻结文件，加不了依赖）。
// 要的东西很窄：哪些 starter/ 路径被提到、在哪个小节里提的。
// 按行扫 + 记住当前顶层 key 就够了，缩进结构不用还原。

const SECTIONS_REQUIRED = new Set(['provided_files', 'files_to_modify', 'public_tests']);

/**
 * 跑出来的东西，不该由 starter 带着走（.gitignore 里也是忽略的）。
 * 提到了也不算缺件 —— 它们要等学员真跑一遍才会有。
 */
const GENERATED = [/\/reports\/[^/]*\.rerun\.json$/, /\/reports\/live-[^/]*\.json$/, /\/\.ledger[^/]*\//, /\/reports\/created-names\.txt$/];
const isGenerated = (p) => GENERATED.some((re) => re.test('/' + p));

/**
 * overlay 模式：solution 已经盖到 starter 上了。
 *
 *   VERIFY_STARTER_MODE=overlay npm run verify:starter
 *
 * 影响两处，所以定义要放在这么靠前的地方：
 *   · 下面 LEARNER_ARTIFACTS 那三条，overlay 之后**反过来必须在**；
 *   · 「禁用字样」那一节整节不跑（见文件后半段）。
 */
const OVERLAY_MODE = process.env.VERIFY_STARTER_MODE === 'overlay';

/**
 * 学员自己跑命令跑出来的交付物。skeleton-plan.mjs 把它们标成 kind:'product'，
 * derive-starter.mjs 生成 starter 时主动删掉，.gitignore 也忽略 ——
 * starter 里没有它们是**对的**，不是缺件。solution 里则放着参考件。
 *
 * 为什么写死这三条路径，而不是复用下面 deliverable 那条启发式：
 * files_to_modify 里还躺着 src/read-inventory.ts、src/tools.ts、src/audit.ts
 * 这些骨架源文件，它们的 deliverable 同样为 true。跟着一起降级的话，
 * 「骨架源文件真被删了」就不再报红，fail-fast 这条线也就废了。
 *
 * 名单跟 scripts/skeleton-plan.mjs 里 kind:'product' 那几条是同一份，但抄了两遍：
 * starter/ 是要单独发给学员的，够不到 lab 根的 scripts/。**那边加减一条，这里要跟着改。**
 */
const LEARNER_ARTIFACTS = new Set([
  'starter/gateway/reports/baseline.json',
  'starter/gateway/reports/environment.md',
  'starter/gateway/reports/task-01-facts.md',
]);
const isLearnerArtifact = (p) => LEARNER_ARTIFACTS.has(p);

/**
 * 扫不到 task yaml 就当场停。
 *
 * 以前这里静默 catch 返回空数组，后果是：在没有 tasks/ 的目录里跑，
 * 一个路径都收不上来，报告照样写「在位 0，缺 0」再退 0 —— 一台假绿制造机。
 * overlay-verify 的临时目录就正好踩中过这个坑。
 */
function taskFiles() {
  const bail = (why) => {
    console.error('[FAIL] ' + why);
    console.error('       tasks/ 应该在：' + toPosix(TASKS));
    console.error('       这个脚本是靠 task yaml 反查契约文件的。一份都读不到，就等于什么也没查，');
    console.error('       而「什么也没查」跟「查完全过」在报告里长得一模一样。所以这里直接退 1。');
    console.error('       在临时目录里跑 overlay 校验的话，记得把源目录的 tasks/ 一起带过去。');
    process.exit(1);
  };
  let names;
  try {
    names = readdirSync(TASKS);
  } catch (e) {
    bail('读不到 tasks/ 目录：' + (e && e.message ? e.message : String(e)));
  }
  const files = names.filter((f) => /^task-\d\d.*\.yaml$/.test(f)).sort();
  if (files.length === 0) bail('tasks/ 在，但里面一份 task-NN*.yaml 都没有');
  return files;
}

/** 从一行里抠出所有 starter/... 路径。 */
function starterPaths(line) {
  return [...line.matchAll(/(?:^|[\s'"`(\[,])(starter\/[A-Za-z0-9._\/-]+)/g)]
    .map((m) => m[1].replace(/[.,;:'"`)\]]+$/, ''))
    .filter((p) => /\.[A-Za-z0-9]+$/.test(p));   // 只要文件，目录不算
}

/**
 * command_exit_zero 的命令里藏着真会跑的文件：
 *   cd starter/gateway && node scripts/check-no-bypass.mjs
 *   cd starter/gateway && npx vitest run tests/task-02.tool-contract.test.ts -t doctype
 *   cd starter/gateway && npm run test:task -- 05
 * 前两种能直接解析出路径，第三种要翻 tests/ 里有没有对应任务号的文件。
 */
function commandRefs(cmd) {
  const out = [];
  const cd = /cd\s+(starter\/[A-Za-z0-9._\/-]+)/.exec(cmd);
  const base = cd ? cd[1] : 'starter/gateway';
  for (const m of cmd.matchAll(/(?:^|\s)((?:scripts|tests|src|store|fixtures|mock|reports)\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+)/g)) {
    out.push({ path: base + '/' + m[1], kind: 'command-file' });
  }
  const tt = /test:task\s+--\s+(\d{1,2})/.exec(cmd);
  if (tt) out.push({ path: base + '/tests/task-' + String(tt[1]).padStart(2, '0') + '.*.test.ts', kind: 'command-glob' });
  return out;
}

/** 相对 lab 根，看这个 glob（只支持中间一个 *）有没有命中。 */
function globHits(pattern) {
  const i = pattern.lastIndexOf('/');
  const dir = atLab(pattern.slice(0, i));
  const rest = pattern.slice(i + 1);
  const re = new RegExp('^' + rest.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  try {
    return readdirSync(dir).filter((f) => re.test(f));
  } catch {
    return [];
  }
}

/** path -> { sections:Set, tasks:Set, glob:bool } */
const refs = new Map();
const noteRef = (p, section, task, glob = false) => {
  if (!refs.has(p)) refs.set(p, { sections: new Set(), tasks: new Set(), glob });
  const r = refs.get(p);
  r.sections.add(section);
  r.tasks.add(task);
  if (glob) r.glob = true;
};

const taskReport = [];
for (const f of taskFiles()) {
  const text = readFileSync(join(TASKS, f), 'utf8');
  const id = (/^id:\s*(\S+)/m.exec(text) ?? [, f.replace(/\.yaml$/, '')])[1];
  let section = '(top)';
  let count = 0;
  for (const line of text.split('\n')) {
    const top = /^([a-z_][a-z0-9_]*):/.exec(line);
    if (top) section = top[1];
    for (const p of starterPaths(line)) { noteRef(p, section, id); count += 1; }
    const cmd = /^\s*command:\s*['"]?(.+?)['"]?\s*$/.exec(line);
    if (cmd && section === 'public_tests') {
      for (const r of commandRefs(cmd[1])) { noteRef(r.path, section, id, r.kind === 'command-glob'); count += 1; }
    }
  }
  taskReport.push({ id, file: 'tasks/' + f, references: count });
}

const missing = [];
const present = [];
for (const [p, meta] of [...refs.entries()].sort()) {
  const hit = meta.glob ? globHits(p).length > 0 : exists(atLab(p));
  const sections = [...meta.sections].sort();
  const row = {
    path: p,
    sections,
    tasks: [...meta.tasks].sort(),
    // 只在 files_to_modify 里出现、provided_files 里没有：starter 给的是骨架或者干脆不给，
    // 完整版在 solution 里。仍然列进红灯清单 —— overlay 之后要能盖上，盖不上就是 solution 缺件。
    deliverable: meta.sections.has('files_to_modify') && !meta.sections.has('provided_files'),
    learnerArtifact: isLearnerArtifact(p),
    // overlay 之前学员产物不算缺件，overlay 之后**必须**在 —— 参考件是 solution 的一部分。
    required: sections.some((s) => SECTIONS_REQUIRED.has(s))
      && !isGenerated(p)
      && (!isLearnerArtifact(p) || OVERLAY_MODE),
  };
  (hit ? present : missing).push(row);
}

// ── 2. import 能不能落到实处 ─────────────────────────────────────
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => 'node:' + m)]);
const IMPORT_RE = /(?:\bfrom\s*|(?:^|[^\w.])import\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveSpec(fromAbs, spec) {
  if (spec.startsWith('node:') || BUILTINS.has(spec)) return true;
  if (!spec.startsWith('.')) {
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    return exists(join(ROOT, 'node_modules', ...pkg.split('/')));
  }
  const base = resolve(dirname(fromAbs), spec);
  // NodeNext 里 TS 源写的是 './x.js'，磁盘上是 './x.ts'。
  const tries = [base, base.replace(/\.js$/, '.ts'), base + '.ts',
                 join(base, 'index.ts'), base + '.mjs', base + '.json'];
  return tries.some(exists);
}

const unresolved = [];
let importFiles = 0;
for (const dir of [join(ROOT, 'src'), join(ROOT, 'tests')]) {
  for (const abs of walk(dir, (r) => /\.(ts|mts|mjs)$/.test(r))) {
    importFiles += 1;
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      // 跳过「整行就是一段被引号包起来的示例代码」。
      // tests 里有几处拿正常代码当扫描器的反面样本，形如
      //   const benign = "import { makeRig } from '../harness.js';\n…";
      // 那不是真 import，解析不到是正常的。
      // 三类假 import，跳过：
      //   ① 被引号包起来的示例代码（扫描器的反面样本）
      //   ② 正则字面量里的模块名 —— 扫描器自己的规则就长 re: /from ['"](pg|...)/ 这样
      //   ③ tripwire 样本行
      const isQuotedSample = /=\s*["'`][\s\S]*\b(import|require)\b/.test(ln)
        || /^\s*["'`].*\b(import|require)\b/.test(ln);
      const isRegexRule = /^\s*(re|pattern)\s*:\s*\//.test(ln) || /^\s*tripwire\s*:/.test(ln);
      if (isQuotedSample || isRegexRule) return;

      const re = new RegExp(IMPORT_RE.source, 'g');
      let m;
      while ((m = re.exec(ln)) !== null) {
        if (!resolveSpec(abs, m[1])) {
          unresolved.push({ file: rel(abs), line: i + 1, specifier: m[1] });
        }
      }
    });
  }
}

// ── 3. starter 里不该出现的字样 ──────────────────────────────────
const FORBIDDEN = [
  { id: 'reference-answer', re: /参考解/, why: '参考解的痕迹漏进了 starter' },
  { id: 'solution-token', re: /\bSOLUTION\b/, why: '出现 SOLUTION 标记' },
  { id: 'solution-path', re: /(^|[\s'"`(])solution\/(gateway|grading-model)/, why: '引用了 solution/ 下的路径' },
  // 不扫 staff_only 这个字段名 —— evaluator 里那个字段正是**做脱敏**的机关，
  // 它出现说明脱敏在工作，不是泄露。要抓的是「明说别给学员看」的话。
  { id: 'staff-only-note', re: /(不要给学员看|不给学员|勿下发|禁止下发|学员不可见)/, why: '标着不下发的内容出现在 starter 里' },
  { id: 'hidden-payload', re: /(判分载荷|hidden[-_ ]payload|injection[-_ ]payload|HIDDEN_ASSERT)/i, why: '疑似 hidden 载荷标记' },
  { id: 'hidden-evaluator', re: /\bhidden_evaluators\b/, why: 'hidden 断言的定义不该出现在 starter' },
  { id: 'integrity-baseline', re: /\bINTEGRITY\.json\b/, why: '完整性基线是评分侧的东西' },
];

/**
 * 这个脚本自己不扫 —— 上面那张表里每个标记的原文都写在这儿，
 * 扫自己等于每次都红一片。别的脚本照扫。
 */
const SELF = new Set([
  'starter/gateway/scripts/verify-starter.mjs',
  'starter/gateway/reports/starter-structure.json',   // 自己上一轮的产物，里面当然有这些字样
]);

/** 明说「不是 / 不在这儿 / 只是示范」的句子放过。mock 里那段示范注入就带着这种免责话。 */
const DISCLAIMED = /(不是|并非|非真|不在|示范|样例|示例|举例|反面教材|不含)/;

// overlay 之后答案**就该**在这里，这一节查的是「答案漏进了未补齐的 starter」，
// 所以整节跳过（OVERLAY_MODE 定义在文件上半段）。
// 另外两节 —— 契约文件在不在、import 通不通 —— 照跑，overlay 之后必须绿。
const SCAN_EXT = /\.(ts|mts|mjs|js|json|md|txt|sql|ya?ml)$/;
const forbidden = [];
for (const abs of OVERLAY_MODE ? [] : walk(STARTER, (r) => SCAN_EXT.test(r) && !/package-lock\.json$/.test(r))) {
  const r = rel(abs);
  if (SELF.has(r)) continue;
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    for (const f of FORBIDDEN) {
      if (!f.re.test(ln)) continue;
      if (DISCLAIMED.test(ln)) continue;
      forbidden.push({ file: r, line: i + 1, marker: f.id, why: f.why, text: ln.trim().slice(0, 140) });
    }
  });
}

// ── 报告 ─────────────────────────────────────────────────────────
//
// 红灯只看 provided_files / files_to_modify / public_tests 三节 —— 那是契约。
// evidence_to_submit 之类的地方提到的路径也列出来，但不卡退出码。
const missingRequired = missing.filter((m) => m.required);
// 学员产物单独一组。overlay 模式下它们已经进了 missingRequired，这一组自然是空的。
const missingLearner = missing.filter((m) => !m.required && m.learnerArtifact);
const missingOptional = missing.filter((m) => !m.required && !m.learnerArtifact);
const ok = missingRequired.length === 0 && unresolved.length === 0 && forbidden.length === 0;
const report = {
  generatedBy: 'starter/gateway/scripts/verify-starter.mjs',
  labRoot: toPosix(LAB),
  mode: OVERLAY_MODE ? 'overlay' : 'starter',
  ok,
  summary: {
    tasksScanned: taskReport.length,
    pathsReferenced: refs.size,
    pathsPresent: present.length,
    pathsMissing: missing.length,
    pathsMissingRequired: missingRequired.length,
    pathsMissingLearnerArtifact: missingLearner.length,
    importFilesScanned: importFiles,
    importsUnresolved: unresolved.length,
    forbiddenMarkers: forbidden.length,
  },
  tasks: taskReport,
  missing,
  present: present.map((p) => p.path),
  unresolvedImports: unresolved,
  forbiddenMarkers: forbidden,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('模式：' + (OVERLAY_MODE ? 'overlay（solution 已盖上）' : 'starter（未补齐）'));
console.log('task yaml：' + taskReport.length + ' 份，引用 starter 路径 ' + refs.size + ' 个');
console.log('  在位 ' + present.length + '，缺 ' + missing.length + '（其中卡红灯的 ' + missingRequired.length
  + '，学员产物 ' + missingLearner.length + '）');
console.log('import：扫了 ' + importFiles + ' 个文件，解析不了 ' + unresolved.length + ' 处');
console.log('禁用字样：' + forbidden.length + ' 处');
console.log('报告：reports/starter-structure.json');

function listMissing(title, rows) {
  if (rows.length === 0) return;
  console.log('');
  console.log(title + '：');
  const byDir = new Map();
  for (const m of rows) {
    const d = m.path.slice(0, m.path.lastIndexOf('/'));
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(m);
  }
  for (const [d, list] of [...byDir.entries()].sort()) {
    console.log('  ' + d + '/  (' + list.length + ')');
    for (const r of list) {
      const tag = r.learnerArtifact ? ' (学员产物)' : r.deliverable ? ' (等 overlay 覆盖)' : '';
      console.log('    ' + r.path.slice(d.length + 1) + tag
        + '   ← ' + r.tasks.join(', ') + '  [' + r.sections.join('+') + ']');
    }
  }
}

listMissing('缺的文件（契约里的，卡红灯）', missingRequired);
listMissing('学员产物（starter 不带，overlay 后必须在）', missingLearner);
listMissing('缺的文件（只在叙述里提到，不卡红灯）', missingOptional);

if (unresolved.length > 0) {
  console.log('');
  console.log('解析不了的 import：');
  for (const u of unresolved) console.log('  ' + u.file + ':' + u.line + '  "' + u.specifier + '"');
}

if (forbidden.length > 0) {
  console.log('');
  console.log('starter 里不该有的字样：');
  for (const f of forbidden) console.log('  ' + f.file + ':' + f.line + '  [' + f.marker + '] ' + f.why + '\n      ' + f.text);
}

console.log('');
console.log(ok ? '[OK] starter 结构齐了' : '[FAIL] starter 还没补齐（红灯清单见上）');
process.exit(ok ? 0 : 1);
