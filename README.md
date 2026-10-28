# dsh-shijie-workbench v0.1.1（M2 切片 + 设置页）

视界工作台的 DeepSeek Harness（DSH）原生插件。规格来源是 `shijie_workbench_v1_2`；`contracts/` 已按 v1.3 取帧契约升级（`schemas.json`、`task.template.yaml`、`operation_catalog.yaml`、`workflow.yaml`、`schema.sql` 及 `1.2-to-1.3` 迁移）。

M2 切片在 M1.5 的任务、来源、拍摄证据建议、作业排队之上，加入了进程内作业执行器、本地媒体获取、ffprobe、按画面变化取帧（TECH_PLAN §12 第 1 层）和崩溃恢复。仍然不接真实渠道下载、不做看图前合并/按目标选代表/导出生成/审核页面；完整边界见 `VALIDATION.md`。


## 安装

要求：Node >= 22.13，DSH `>=0.2.1-rc.2 <0.3.0`（预览版，接口可能变）。已在 rc.3 和 rc.4 下跑通 typecheck、build 和全部测试，详见 `VALIDATION.md`。

```
npm install
npm run build
dsh plugin --profile <profile> add <本目录绝对路径>
```

### 从 GitHub 安装

公开仓库：<https://github.com/shady2713/dsh-shijie-workbench>

```
git clone https://github.com/shady2713/dsh-shijie-workbench.git
cd dsh-shijie-workbench
npm install
dsh plugin --profile <profile> add <克隆目录的绝对路径>
```

`npm install` 会通过 `prepare` 自动执行 `npm run build`。安装后启动该 profile，调用 `shijie_capabilities` 应返回 `schema_version: "1.3"` 和 `job_executor.state: "AVAILABLE"`。

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后会自动并入 profile。数据库默认在 `~/.dsh/shijie-workbench/workbench.sqlite`，可用配置项 `dataDir` 修改。

### 分发到其他电脑

在开发机打包：

```
cd plugin
npm run build
npm run pack
```

把 `plugin/dist/dsh-shijie-workbench-0.1.1.tgz` 复制到目标电脑，在目标电脑执行：

```
dsh plugin --profile <profile> add <路径>/dsh-shijie-workbench-0.1.1.tgz
```

目标电脑需要 DSH `>=0.2.1-rc.2 <0.3.0`，并有一个包含 DSH 基础包的 profile；ffmpeg/ffprobe 需在 PATH 中，或通过 `ffmpegPath`/`ffprobePath` 配置。tarball 已包含 `lib/`、`contracts/`、`skills/` 和 `cordis.patch.yml`，不会包含 `node_modules`；`ajv`、`yaml` 等运行依赖由 pnpm 安装。当前 `package.json` 是 `private: true`，因此默认用 tarball/私有 registry 分发，不发布到公共 npm。安装后启动该 profile，调用 `shijie_capabilities` 应返回 `schema_version: "1.3"` 和 `job_executor.state: "AVAILABLE"`。

配置项：`dataDir`、`mode`（assisted / unattended）、`ffmpegPath`、`ffprobePath`、`journal`（AUTO / DELETE / WAL）、`evidenceMaxBytes`（导入证据大小上限，默认 20 MiB）、`visionProbe`（默认 false）。AUTO 只在 SQLite 带 WAL-reset 修复时启用 WAL。`visionProbe: true` 时另注册 E1 诊断工具 `shijie_e1_image_probe`，它只在宿主提供 attachments 服务时可用；生产配置建议保持 false。

注意：存储用 Node 内置 `node:sqlite`，它在当前 Node 版本里仍是实验特性，启动时会有 ExperimentalWarning。

## 设置页

插件在 Web GUI 的“设置”侧栏注册“视界工作台”页面（`settings.section`，order 95）。页面是只读工作台概览：任务/作业/媒体/帧/取样与审核导出计数、最近任务/作业/媒体/审计事件，以及数据库文件和大小。页面通过宿主 `webServer` 的 `GET /api/shijie-workbench/status` 读取当前 profile 的 SQLite；不会新增审核入口或写数据库。浏览器端每 5 秒刷新一次。

该页面需要宿主提供 `webServer` 服务（DSH Web GUI 默认提供）；如果宿主没有该服务，插件的业务工具仍可使用，只是不注册这个页面路由。

## 工具（36 个业务工具 + 1 个 E1 诊断工具）

| 工具 | 对应 v1.3 操作 |
|---|---|---|
| `shijie_capabilities` | getCapabilities |
| `shijie_contract` | 读取契约 JSON Schema（插件新增，替代 HTTP 的 openapi） |
| `shijie_task_template` | 默认 TaskSpec 草稿（插件新增） |
| `shijie_task_list` `_create` `_get` `_resume` `_close` `_next` | listTasks / createTask / getTask / resumeTask / closeTask / getNextAction |
| `shijie_source_register` `_list` `_get` | registerSource / listSources / getSource |
| `shijie_source_variants` `_verify` | listSourceVariants / verifySource |
| `shijie_capture_propose` | proposeCaptureAssessment |
| `shijie_job_submit` `_run` `_list` `_get` `_cancel` | submitJob / runJobs / listJobs / getJob / cancelJob |
| `shijie_search_plan` | getSearchPlan |
| `shijie_quality_record` | recordQualityAssessment |
| `shijie_frame_get` `_list` | getFrame / listFrames |
| `shijie_coverage_list` `shijie_segment_list` `shijie_overlap_list` | listCoverage / listSegments / listOverlaps |
| `shijie_policy_request_list` `shijie_policy_rule_list` `shijie_policy_propose` | listPolicyRequests / listPolicyRules / proposePolicy |
| `shijie_bootstrap_get` | getBootstrap |
| `shijie_review_batch_list` `_get` | listReviewBatches / getReviewBatch |
| `shijie_export_get` | getExport |
| `shijie_feedback_list` | listFeedback |
| `shijie_evidence_import` | importEvidence |
| `shijie_e1_image_probe` | E1 宿主看图诊断（插件新增，`visionProbe: true` 时启用） |

所有业务工具返回 v1.3 的 Response 信封（`status`、`code`、`message`、`data`、`retryable`），历史 v1.2 载荷在读取时按兼容枚举接受。业务失败是返回值，不是异常。

## 审核边界

operation_catalog 里仅限 reviewer 的操作都不是工具：审核决定、拍摄证据裁定、策略决定、任务修订、引导批准、反馈创建、用户参考导入、观察解决。agent 没有任何入口记录用户决定。`shijie_policy_propose` 只创建 PENDING 请求，`shijie_bootstrap_get` 只报告缺项；测试检查了工具名和操作列表。

## 与 v1.2 规格的差别

- Python + FastAPI + HTTP + CLI 换成 TypeScript + DSH 工具。业务写入入口由 HTTP API 变为这组工具，规则仍集中在 `src/domain/`。
- 数据库直接使用 v1.3 的 `schema.sql`，输入输出用 `schemas.json` 经 Ajv 校验，没有另写一份；已有 v1.2 库通过 `contracts/migrations/1.2-to-1.3.sql` 原地迁移，空库 DDL 不会跑在旧库上。
- 宿主就是 DSH，因此 agent-request 轮询协议（getNextAgentRequest 等）在这个形态里没有实现。工作单如何交给 DSH 的 agent 看图，由 E1 验证的 ImageBlock 路径承接。
- M2 作业执行器只处理 `media.acquire` / `media.probe` / `media.overview` / `media.sample`，且媒体获取只接受 `dataDir/inbox` 下的本地文件和测试素材；真实渠道下载、看图前合并、按目标选代表、导出生成留到 M2b/M3/M4。其他作业只入队，`shijie_task_next` 如实报告 `CAPABILITY_MISSING`。
- 因 `media_origins.policy_decision_id` 必须有真实策略决定，M2 本地测试素材不伪造 `media_origins`，改用 `segments.task_id` 关联任务与媒体；渠道来源关系留 M4。

## 目录

```
src/            插件源码（config、store、contracts、domain、tools、vision、index）
client.js       Web GUI 设置页客户端模块
contracts/      v1.3 契约（含 migrations/1.2-to-1.3.sql）
skills/         随插件注册的 SKILL
tests/          vitest（含 fixtures/crash-worker.ts）
lib/            npm run build 的输出
```
