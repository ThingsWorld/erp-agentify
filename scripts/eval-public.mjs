// Restore the course layout for the unmodified evaluator, then keep its report.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateway = join(root, 'gateway');
const dependencies = join(gateway, 'node_modules');

if (!existsSync(join(dependencies, 'tsx', 'dist', 'cli.mjs'))) {
  console.error('Dependencies missing. Run: npm --prefix gateway ci');
  process.exitCode = 1;
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'erp-public-eval-'));
  try {
    const isolated = join(temporary, 'starter', 'gateway');
    mkdirSync(isolated, { recursive: true });
    for (const entry of ['src', 'scripts', 'evaluator', 'fixtures', 'mock', 'store', 'package.json', 'tsconfig.json']) {
      cpSync(join(gateway, entry), join(isolated, entry), { recursive: true });
    }
    // Dependencies are reused; local credentials and runtime state are not copied.
    symlinkSync(dependencies, join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [join(isolated, 'scripts', 'eval-public.mjs')], {
      cwd: isolated,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    const reportPath = join(isolated, 'reports', 'eval-public.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    mkdirSync(join(gateway, 'reports'), { recursive: true });
    cpSync(reportPath, join(gateway, 'reports', 'eval-public.json'));
    console.log('Report copied to gateway/reports/eval-public.json');
    process.exitCode = result.status === 0 && report.ok === true ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
