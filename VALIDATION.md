# 验证与边界

环境：Windows，Node 24.13.0；ffmpeg 8.0.1-full_build，ffprobe 8.0.1。DSH 依赖测试过 `0.2.1-rc.4`（工作区）和 `0.2.1-rc.3`（临时副本）；全局 CLI 为 `0.2.1-rc.2`，用户当前版本为 `0.2.1-rc.3`。本报告区分程序测试、宿主集成、渠道测试和用户业务验收。

## 已运行

### 程序测试（rc.4 工作区）

命令与结果：

- `npm install`：完成，`prepare` 触发的 `npm run build` 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：6 个测试文件、61 项全部通过（vision 5、plugin 6、agent_tools 15、domain 21、m2 9、m2-sampling 5），耗时约 3.5 秒；无失败，只有 `node:sqlite` 的 ExperimentalWarning。

M1.5 原有的 47 项测试全部保留并通过。M2 新增 14 项测试：

1. v1.3 契约：v1.2 TaskSpec（含三个旧固定间隔字段）可校验；v1.3 TaskSpec 删除旧字段仍可校验；`change_threshold=1.5` 和 `max_frame_interval_s < min_frame_interval_s` 均被拒绝。
2. v1.2 TaskSpec 缺三个旧固定间隔字段被拒绝。
3. 旧 1.2 OperationResult（`schema_version: "1.2"`）可读取，1.0 被拒绝。
4. 1.2→1.3 数据库迁移：旧 SQLite 文件含 `schema_migrations='1.2'` 和旧 `jobs` 表，迁移后 `pragma table_info(jobs)` 含 `claim_generation`、版本变 1.3、旧 job 行仍可读。
5. 认领租约：第二次 claim 后 `claim_generation=2`；旧 claim 的 `complete` 抛 stale、`heartbeat` 抛 lease；新 claim 可心跳并完成，`workflow_events` 的 `job.completed` 只出现 1 条。
6. 重复完成：同一 claim 二次 `complete` 返回 `already_completed:true`，完成事件仍只有 1 条。
7. 媒体全链路：ffmpeg 生成 `testsrc2 1.5s + 黑场 1.5s` 的 3 秒 320×240 10fps 测试视频，放入 `dataDir/inbox`；`media.acquire` 成功且产物文件存在、字节数和 sha256 与 `media`/`artifacts` 一致；`media.probe` 报告 CFR 且时长 >2.5 秒；`media.overview` 使用 v1.3 变化取帧，帧数 ≤3，`quality_json` 含 `trigger`/`change_score`/`scene_cut_score` 等，包含 `FIRST_FRAME` 与 `SCENE_CUT`（testsrc2→黑场的 scdet 分数 39.572，归一化 0.3957，高于默认 0.30）；`SAMPLED` 覆盖数等于帧数；`media.sample` 按固定时间戳抽 3 帧，`listFrames` 通过 `segments` 关联可见。
8. 崩溃恢复：`tests/fixtures/crash-worker.ts` 领取 `media.acquire` 后直接退出（`jobs.status=RUNNING`、`claim_generation=1`）；把租约强制过期后再次 `runJobs(1)` 重认领并成功（attempt=2、`claim_generation=2`），`media` 与 media artifact 各 1 行、文件字节和 sha256 一致；再次运行返回空数组，证明不会重复产出。
9. `m2-sampling.test.ts` 的 5 个纯函数测试：最小间隔（变化在 0.2/0.4 秒不保留、到 0.6 秒才保留）、静止场景按最大间隔保留、场景切换绕过最小间隔、候选数截断、v1.2 固定间隔回退。

### 程序测试（rc.3 临时副本）

在 `%TEMP%\shijie-rc3-check` 复制工作区（不含 `node_modules`、`lib`、`.tmp-media`），只把 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools` 的 devDependencies 改为 `0.2.1-rc.3`，删除临时副本的 lockfile 后重新 `npm install`：

- `npm install`：成功，`prepare` 触发的 build 通过。
- `npm run typecheck`：通过。
- `npm test`：6 个测试文件、61 项全部通过（vision 5、plugin 6、agent_tools 15、domain 21、m2 9、m2-sampling 5）。
- 临时副本不修改工作区 `package.json`/`package-lock.json`。

### 宿主集成（隔离 profile，未动用户正在用的 profile）

- 测试 profile：`C:\Users\64576\.dsh\profiles\m15-test`，插件以 `link:E:/xiangmu/03 Video footage acquisition/plugin` 安装，dataDir 指向 `C:/Users/64576/AppData/Local/Temp/shijie-m15-test`。
- `dsh --profile m15-test --json "只调用 shijie_capabilities 一次..."` 实际加载当前构建并返回：`schema_version: "1.3"`、`job_executor.state: AVAILABLE`（reason 为 “M2 local executor: SQLite queue with claim leases, claim_generation, heartbeat and transactional completion; media jobs run in-process”）、`ffmpeg`/`ffprobe` AVAILABLE、`reviewer_surface` UNSUPPORTED、`host_vision` AVAILABLE。
- 插件加载测试在真实 Cordis Context（真实 ToolRuntime、SkillRegistry、SystemPrompt）里加载插件：36 个 `shijie_*` 业务工具经真实工具管线执行，参数校验、输出 schema 校验、信封失败、技能注册均通过；工具集中没有 reviewer 操作或用户决定入口。`visionProbe: true` 时另注册 E1 诊断工具。

### 分发包（仅本地验证）

- `npm run pack` 成功生成 `dist/dsh-shijie-workbench-0.1.0.tgz`（约 78 KB，32 个文件，包含 `lib/`、`contracts/`、`skills/`、`cordis.patch.yml`，不包含 `node_modules`）。
- 在干净临时目录执行 `npm install <tarball>` 成功；`import('dsh-shijie-workbench')` 返回 `Config, apply, inject, name` 四个导出。
- 在临时 `DSH_HOME` 的 `packhead` profile 里 `dsh plugin --profile packhead add <tarball>` 成功；因该临时 profile 没有模型凭据，未完成真实模型工具调用，这一项不算宿主运行验证。

### E1 宿主看图（历史验证，仍有效）

- `shijie_e1_image_probe` 生成确定性 PNG，经 `ctx.attachments.saveImage` 转为 `ImageBlock` 返回给模型；512×384 与 2048×1536 两种尺寸的模型坐标与真值误差分别不超过 1 和 2 像素，宿主未缩图。
- 结论只对 `magpie-responses` / `codex/gpt-6.1-sol` 这个声明了 `input: [text, image]` 的模型成立；E1 用合成图，不是航拍素材。

## NOT_RUN（没有验证，不能当作通过）

- 真实航拍素材验收：工作区没有真实航拍视频，也没有 jpg/png；程序测试用的合成视频由测试运行时在临时目录生成，验证后已清理，不留测试素材。因此“1–2 段真实航拍小片、帧数明显少于固定间隔且不漏镜头切换”未运行；`change_threshold`、`scene_cut_threshold`、`similarity_merge_threshold` 都没有用真实素材校准。合成片不能冒充互联网素材。
- 真实渠道（YouTube、Bilibili、Commons、Flickr 等）的搜索、来源核实、下载、许可证判断和真实下载失败处理；本轮不联网、不登录、不下载素材。
- 用户业务验收：真实供给、审核流程、反馈返工、导出和数据集就绪判定。
- 超过 2048×2048 总像素的图片在宿主里的缩图行为和坐标表现。
- 对全部 job kind 的崩溃恢复：只测试了 `media.acquire` 的 worker 进程退出；`media.probe`/`media.overview`/`media.sample` 只通过直接执行测试，没有逐个做 kill 后恢复。
- Linux / macOS；Node 22 与 Node 24 之外的版本；DSH 0.3 或 alpha 版本。
- 大任务、多轮对话下的参数填写质量与上下文/缓存表现。

## 未实现（相对 v1.3 规格）

- 真实渠道适配器和下载；`media.acquire` 只接受 `dataDir/inbox` 下的本地文件/测试素材，且不写 `media_origins`（该表要求真实 `policy_decision_id`）。M2 用 `segments.task_id` 关联任务与媒体。
- `search.execute`、`source.inspect`、`source.route`、`source.capture`、`frame.assess`、`frame.dedupe`、`frame.select`、`frame.tile`、`media.overlap`、`batch.prepare`、`batch.export`、`image.normalize`、`feedback.apply` 等作业。
- 看图前相似帧合并、按目标选代表、`similarity_group_id` 导出生成；本版只在 `AcceptedFrameManifest`/`ReviewFrameManifest` 契约中加入了可选字段，尚未生成导出。
- 审核页面与全部 reviewer 操作；策略/审批的写入或决定；反馈处理。`shijie_policy_propose` 只创建 PENDING 请求，`shijie_bootstrap_get` 只报告缺项。
- agent-request 轮询协议（getNextAgentRequest、claimAgentRequest 等）。

## 已知限制

- 变化取帧当前用 5 fps、64×64 灰度差值和 ffmpeg `scdet` 低分辨率分析；它是 §12 第 1 层的第一版，可能漏掉持续时间很短的镜头切换或极小目标变化，阈值需用真实航拍素材校准。`scdet` 对纯色切换不敏感（红→蓝测试片 score=0.0），已改用 testsrc2→黑场测试验证。
- 相似合并的 `similarity_group_id` 生成规则已按 `simp_` + `sha256(media_id + 排序后的组内 frame_identity_sha256 列表)` 前 16 位写入契约说明；本轮没有导出流水线可实际生成该字段。
- 复杂请求仍用 `json` 类型承载整份对象（TaskSpec、JobRequest 等），由 Ajv 按 v1.3 契约校验；模型需先 `shijie_contract` 了解字段。
- `media.acquire` 的本地路径限制在 `dataDir/inbox`，拒绝绝对路径逃逸、`..` 和符号链接；这是测试/本地素材通道，不是互联网下载通道。
- 依赖外部 ffmpeg/ffprobe；路径由配置项 `ffmpegPath`/`ffprobePath` 指定。`node:sqlite` 在当前 Node 版本仍是实验特性。
- 依赖预览版 DSH。`engines.dsh` 和 peer 依赖是 `>=0.2.1-rc.2 <0.3.0`；开发依赖固定在 `0.2.1-rc.4`。0.2.2-alpha 系列和 0.3 以后没有测试。
