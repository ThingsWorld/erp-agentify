# 本地验证记录

验证日期：2026-10-31。环境：Linux、Node.js 24.21.0、npm 11.19.0。依赖按 `gateway/package-lock.json` 锁定。

| 检查 | 结果 |
| --- | --- |
| `npm --prefix gateway run typecheck` | 通过 |
| `npm --prefix gateway test` | 15 个测试文件通过；134 通过，1 跳过 |
| `npm --prefix gateway run preflight` | 通过；mock 检查全绿，live 检查按预期跳过 |
| `npm --prefix gateway run verify:fixture` | 通过；种子 SHA-256 与课程摘要一致 |
| `npm --prefix gateway run demo:mock` | 通过；新增 1 张数量为 20 的草稿，清理后恢复 6 张采购单 |
| `cd gateway && node src/capstone/run.mjs` | 通过；首次 `uncertain`，显式对账后同键重放 `deduped` |
| `node scripts/eval-public.mjs` | 通过；报告 `ok=true`，4 项静态检查与 3 条对照判定符合预期 |

测试首次在受限沙箱执行时，4 项跨进程用例因 `tsx` 无法创建本地 IPC 管道（`listen EPERM`）失败；允许本地 IPC 后完整重跑通过，没有修改测试或断言。

公开评分入口只负责还原 `starter/gateway/` 布局，运行课程提供的原始评分器。自检包含一条正确轨迹和两条反例：`success → pass`、`business_fail → business_fail`、`security_fail → safety_fail`。反例按预期失败，属于评分自检通过的条件。

`gateway/submission/` 保留原课程的设计说明、失败分析、反思及历史验收证据。本次兼容入口产生的最新报告位于 `gateway/reports/eval-public.json`，属于可重新生成的本地产物。新增 GitHub CI 尚需推送后由 GitHub Actions 执行，本地通过不等于远端 CI 已通过。

发布整理未改动 `gateway/evaluator/`、`gateway/fixtures/`、`gateway/mock/scenarios/` 或已有测试断言。发布副本逐文件核对保留的内容，并扫描本地配置中的凭据值及常见密钥格式；不携带原仓库的 Git 历史。

真实 PostgreSQL 的用例默认跳过。真实 ERPNext、真实 PostgreSQL、外部部署的身份/审批系统、课程隐藏评测不在本次已验证范围。`verify:starter` 依赖未下发的教师端 `tasks/*.yaml`，不声称该检查通过。
