// Task 09 可执行入口：tsx 的模块导入 API，无额外命令行进程。
import { tsImport } from 'tsx/esm/api';
try {
  const { runCapstone } = await tsImport('./run-impl.ts', import.meta.url);
  await runCapstone();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
