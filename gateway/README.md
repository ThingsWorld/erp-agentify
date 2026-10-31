# ERP Gateway · 工程说明

项目要求在上一层的 [`PROJECT.md`](../PROJECT.md)。这份只讲**怎么把它跑起来**。

项目概览与本次验证结果见 [仓库首页](../README.md)。在课程下发布局中运行公开评分，请使用 `node ../scripts/eval-public.mjs`，详见首页的目录兼容说明。

---

## 三十秒

```bash
npm ci
npm run preflight
npm run demo:mock
```

三条都绿，环境就没问题了。`demo:mock` 会把一条完整链路跑给你看：
查库存 → 查原单 → 算缺口 → 建草稿 → 回查 → 讲清楚 → 清理回基线。

**不需要 ERPNext，不需要网络。**

## 命令

| 命令 | 干什么 |
|---|---|
| `npm run preflight` | 环境自检。Task 00 的第一关 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | 全部公开测试 |
| `npm run test:task -- 05` | 只跑 Task 05 的 |
| `npm run mock:baseline` | 采一份基线到 `reports/baseline.json` |
| `npm run mock:reset` | 清掉落盘的台账与审计 |
| `npm run verify:fixture` | 核 `fixtures/erp-seed.json` 的 sha256 |
| `npm run verify:starter` | 结构自检：引用的文件在不在、import 通不通 |
| `npm run eval:public` | 跑公开那部分评分，出 `reports/eval-public.json` |
| `npm run demo:mock` | 演示一条完整链路 |
| `npm run smoke:live` | 打真 ERPNext（要先配 `.env`） |

## 目录

```
src/
  types.ts            领域类型、FLOOR、FACTS —— **接口冻结点，不要改**
  identity.ts         身份解析。整个 Gateway 唯一产出 Principal 的地方
  policy.ts           运行时 FLOOR。真实部署里它不在你的仓里
  tools.ts            工具面。四个工具，没有第五个
  tool-schema.ts      参数校验
  gateway.ts          主编排：身份 → FLOOR → 占位 → 写 → 回查 → 审计
  risk-map.ts         你自己的风险表（Task 04）
  ledger-memory.ts    内存台账
  ledger-persistent.ts 落盘台账（Task 06）
  audit.ts            持久审计（Task 08）
  reconcile.ts        写后对账（Task 07）
  untrusted.ts        宿主文本的包装（Task 08）
  erp-fake.ts         mock ERP
  erp-http.ts         真 ERPNext 客户端。**凭据只在这里出现**
  erp-mock.ts         场景加载器
  harness.ts          装配台。测试和脚本都从这儿拿接好线的 Gateway
  agent/              Agent 侧：算缺口、建草稿
  capstone/           Task 09
mock/scenarios/       10 个场景。**不要改**
fixtures/             种子数据 + sha256。**不要改**
evaluator/            评分合约的公开部分。**不要改**
tests/                公开测试
reports/              你跑出来的产物
```

## 两种模式

默认 **mock**。它离线、秒级、可重置、可注入故障。

要打真 ERPNext：把 `.env.example` 复制成 `.env`，填助教发给你的受限账号，然后

```bash
npm run smoke:live
```

**`.env` 不要提交进仓库。** 账号不是 Administrator —— 用它会触发
`af-admin-credentials`，该 Task 直接记 0 分。

### mock 绿而 live 红是**预期内的**

mock 不做 ERPNext 的业务校验。最常撞的一条：

```
Row #1: Warehouse is mandatory for stock Item ITEM-SHELF-01
```

`ITEM-SHELF-01` 是库存物料，采购单行必须带 `warehouse`。
mock 照收，live 整单打回。完整差异清单在 `reports/environment.md`（Task 00 要你写的那份）。

## 几条会省你时间的

**`npm run preflight` 红了先看它说什么。** 它逐项打，不会只说「失败」。

**并发测试要跑十几秒。** Task 06 的跨进程测试真起 4 个子进程、跑 5 轮，
慢是正常的。不要以为它挂住了。

**`reports/` 是产物目录。** 里面的东西由命令生成，不用手写。
`.ledger*` 和 `.env` 已经在 `.gitignore` 里。

**遇到 `uncertain` 不要重试。** 那是 Task 07 的整个题面。
先想清楚它和 `failed` 差在哪。
