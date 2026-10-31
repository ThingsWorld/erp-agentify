// Export an allowlisted source snapshot, without the course workspace's Git history.
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(root, '.publish');
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(join(outputRoot, 'erp-gateway-'));

const entries = [
  'README.md', 'PROJECT.md', '.gitignore', '.gitattributes', '.github', 'docs', 'scripts', 'grading-model',
  'gateway/README.md', 'gateway/.env.example', 'gateway/.gitignore', 'gateway/.gitattributes',
  'gateway/package.json', 'gateway/package-lock.json', 'gateway/tsconfig.json', 'gateway/vitest.config.ts',
  'gateway/src', 'gateway/tests', 'gateway/scripts', 'gateway/evaluator',
  'gateway/fixtures', 'gateway/mock', 'gateway/reference', 'gateway/store',
  'gateway/reports/environment.md',
  'gateway/submission/architecture-note.md', 'gateway/submission/failure-analysis.md',
  'gateway/submission/learner-reflection.md', 'gateway/submission/evaluator-report.json',
  'gateway/submission/layout-validation.json', 'gateway/submission/eval-public-layout.txt',
  'gateway/submission/test-mock.txt',
];

for (const entry of entries) {
  const source = join(root, entry);
  if (!existsSync(source)) throw new Error('Required release file missing: ' + entry);
  const target = join(output, entry);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => {
      const name = path.replaceAll('\\', '/').split('/').at(-1);
      return !['.git', 'node_modules', '.env', '.aws', '.codex', '.agents', '.publish'].includes(name)
        && (!name.startsWith('.env.') || name === '.env.example')
        && !name.startsWith('.ledger');
    },
  });
}

console.log('Clean release snapshot: ' + output);
console.log('Original workspace, credentials and Git history are preserved.');
