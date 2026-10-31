# Task 00：环境与基线记录

## 环境与检查结果

- 使用 Conda `lab` 环境；本项目运行时为 Node.js，Conda 不是项目必需条件。
- 已验证 Node.js v24.21.0、npm 11.19.0。
- 已安装依赖：@types/node 22.10.2、tsx 4.23.13、TypeScript 5.7.2、Vitest 4.1.11。
- 初次受限沙箱中，`npm run preflight` 的 tsx 子进程因本地通信管道 `listen EPERM` 失败；改用 `node --import tsx src/preflight.ts` 执行同一检查入口，六项检查全部通过。该替代执行不等于记录原命令退出码为 0。
- `npm run verify:fixture` 通过，种子文件未被修改。
- 2026-10-26 执行 `npm test`：Task 00 的 12 项测试全部通过；全项目 67 项通过、52 项失败、12 项跳过，退出码 1。尚不能认定全项目验收通过；Task 01 的 11 项测试跳过。
- 默认全程使用 mock，未连接真实 ERPNext，也未执行 live 验证。

补充复查：2026-10-26 重新执行原命令 `npm run preflight`，退出码 0；六项离线检查通过，live 检查按预期跳过。此前 tsx 管道限制本次未出现。

## 基线与证据来源

基线文件：`reports/baseline.json`。

| 内容 | 观测结果 |
| --- | --- |
| 场景 / 站点 | baseline / erp.localhost |
| 采购单 | 6 张 |
| Bin 库存记录 | 8 条 |
| Item / Supplier | 10 条 / 7 条 |
| 原单 | PUR-ORD-2026-00001，docstatus=1 |
| 货架库存 | ITEM-SHELF-01 @ Stores - ADC，actual_qty=40 |
| 最后一轮运行编号 | baseline-baseline-e7ba926b |

业务数据通过 Gateway 读取，不直接读取 fixture 拼装快照。每轮对应 4 条 `erp.query` 审计，覆盖 Purchase Order、Bin、Item、Supplier；均为 `outcome=done`，带 `verifiedAt`，没有写操作。审计备份见 `reports/repeatability/audit-round-1.ndjson` 至 `audit-round-3.ndjson`。

单据用 `name` 识别，比较执行前后的名称集合以识别新增和删除；同名单据继续比较 supplier、docstatus 和 items 的 item_code、qty、rate，以识别修改。仅比较总数不能排除“删除一张又新建两张”的情况。

## mock 与真实 ERPNext 的边界

学员的理解：mock 没有实现库存物料行“必须带仓库”的规则；真实 ERPNext 会验证这条已有的业务规则。

具体例子：库存物料采购单行缺少 warehouse 时，真实 ERPNext 的已记录报错为：

```text
Row #1: Warehouse is mandatory for stock Item
```

这是课程资料中的真实系统报错示例，不是本次连接真实站点得到的输出。mock 可能接受并保存同一份请求，所以 mock 通过不能证明请求满足真实 ERPNext 的全部业务约束。mock 绿而 live 红在这种情况下是模拟边界所致。

## 重置与三轮重复验证

已连续执行三轮：

```bash
npm run mock:reset
npm run mock:baseline
node scripts/diff-baseline.mjs reports/repeatability/baseline-reference.json reports/repeatability/baseline-round-N.json
```

其中 N 分别为 1、2、3；每轮采集后将快照和审计备份到 `reports/repeatability/` 再比较。以上比较命令需使用对应轮次的实际文件名。

三轮结果均与原基线一致：采购单 6 张、Bin 8 条、货架库存 40，每轮 4 条只读审计。比较按脚本契约只忽略顶层 capturedAt、generatedAt、runId，其余字段逐项一致。最后再次核验种子 sha256 通过。

mock ERP 单据状态保存在进程内，每次启动从种子重新装配。reset 清理的是明确列出的持久化审计、台账路径，不会修改种子，也不按时间窗口或通配符清场。真实系统若清理实验单据，应按确切单号处理，不能用“最近一小时”筛选代替，以免时区差异或其他单据混入造成误删。

## 当前状态

环境依赖、基线采集、三轮重复验证及 Task 00 公开测试已有证据；本报告供学员核对，尚未宣称课程检查点或全项目评测通过。
