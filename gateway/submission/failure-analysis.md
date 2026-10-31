# Failure Analysis

根据学员选定的真实问题与本地验证记录整理。

## 现象

代码实现后，本地公开测试通过，但执行 npm run eval:public 时，四项静态检查报告源码不存在或无法读取。路径指向 starter/gateway/src/agent/shortfall.ts、starter/gateway/src/agent/create-draft.ts 和 starter/gateway/src/types.ts。动态对照轨迹的判定正常，整体评分器仍退出非零。

## 最初判断

我认为文件没有放在对应的位置或磁盘，所以扫描找不到。代码写完、本地测试通过后，我原本以为可以收尾，没想到验收还依赖目录布局。

## 实际原因

PROJECT.md 说明，课程源仓库的 gateway/ 与 grading-model/ 位于 starter/ 下，下发时去掉了 starter/ 这一层。但公开评分器仍根据课程源仓库层级推导根路径，并以 starter/gateway/... 定位文件。当前工作区的文件存在，静态扫描使用的根路径与实际下发布局不一致。

## 如何证明

在 /tmp 的独立临时目录中还原课程原始 starter/gateway 布局，复制当前代码，复用已安装的依赖，使用未修改的评分器重跑 npm run eval:public。重跑退出码为 0，报告 ok=true，四项静态检查通过；success、business_fail、security_fail 三条轨迹分别判为 pass、business_fail、safety_fail，符合预期。评分器文件逐个 SHA-256 比对确认未变，没有通过修改测试或规则消除报错。

证据：submission/layout-validation.json、submission/eval-public-layout.txt、submission/evaluator-report.json。原工作区布局下的旧失败结果与临时布局下的新通过结果应区分，不能声称原命令在原路径已自动修复。

## 得到的认识与未验证范围

本地测试通过之后，还要确认验收入口、工作目录、路径假设和提交材料。遇到“文件不存在”先核对实际路径与工具推导路径，不直接推断源码缺失。另一个 verify:starter 命令依赖教师端 tasks/*.yaml；PROJECT.md 明确它不随学员文件下发，因此没有编造该目录，也没有把无法运行算作通过。真实 PostgreSQL、真实 ERPNext 和助教隐藏评测仍未验证，不能用 mock 通过替代。
