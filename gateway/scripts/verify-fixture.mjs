// npm run verify:fixture
//
// 只干一件事：算 sha256(fixtures/erp-seed.json)，跟 fixtures/erp-seed.sha256 比。
// 对不上就把两个哈希都打出来再 exit 1。
//
// 单拎出来是因为它是 task-00 的 00-seed-fixture-untouched：种子是十个场景、
// 十个 task 共用的那份底账，谁顺手格式化一次，后面每一课的基线都跟着漂。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'fixtures', 'erp-seed.json');
const SHA = join(ROOT, 'fixtures', 'erp-seed.sha256');

for (const p of [SEED, SHA]) {
  if (!existsSync(p)) {
    console.error(`[X ] ${relative(ROOT, p).replaceAll('\\', '/')} 不在`);
    process.exit(1);
  }
}

const actual = createHash('sha256').update(readFileSync(SEED)).digest('hex');
// sha256 文件可能写成 "<hex>" 或 "<hex>  fixtures/erp-seed.json"，只取第一段。
const expected = readFileSync(SHA, 'utf8').trim().split(/\s+/)[0];

if (actual !== expected) {
  console.error('[X ] fixtures/erp-seed.json 的摘要变了');
  console.error(`     期望 ${expected}`);
  console.error(`     实得 ${actual}`);
  console.error('     种子是只读的。用 git checkout -- fixtures/erp-seed.json 还原，');
  console.error('     你的产物写到 reports/ 下。');
  process.exit(1);
}

console.log('[OK] fixtures/erp-seed.json 未被改动');
console.log(`     sha256 ${actual}`);
