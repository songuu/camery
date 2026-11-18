# Camery

以分镜为核心的 AI 内容创作系统。当前按 [实施计划 v2.1](docs/plan/implementation_plan_v2.md) 推进阶段 1，产品方案见 [solution_v2.md](docs/product/solution_v2.md)。

## 本地开发

需要 Node.js ≥22.15.0 和 pnpm 12.3.4，依赖以 `pnpm-lock.yaml` 为准。

```sh
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm install --frozen-lockfile
pnpm check
```

仓库设置 `verifyDepsBeforeRun: error`：运行测试或检查时，依赖不一致会直接报错，不会隐式安装或重建 `node_modules`。修改依赖后先显式运行 `pnpm install` 更新锁文件；在已有锁文件的干净环境使用 `pnpm install --frozen-lockfile`，成功后再执行检查。

```sh
pnpm lint           # 源文件策略 + Oxlint 正确性及 TypeScript 类型感知规则
pnpm lint:code      # 仅检查 packages/ 与 scripts/ 的 TS/JS 代码
pnpm typecheck      # 各包 TypeScript 类型检查
pnpm typecheck --fresh # 强制重新执行类型检查，仍只使用本地缓存
pnpm build          # 类型检查后实际构建 API/worker 与固定内容
pnpm test           # 工具脚本测试 + 各包测试
pnpm test:coverage  # 测试及包内覆盖率门槛
```

`lint` 先运行 source-policy（冲突标记、JSON、禁止禁用 TS 检查），再按 [.oxlintrc.json](.oxlintrc.json) 对全部工作区 TS/JS 源码、配置和测试运行 Oxlint。锁定的 Oxlint 1.93.0 与 oxlint-tsgolint 7.0.2006 使用原生 TypeScript 类型分析，检查 correctness、未处理 Promise、误用异步回调；警告及无效禁用指令都令检查失败。没有自动修复或格式化步骤，`typecheck` 仍独立执行。选型依据：[Oxlint 原生类型分析](https://oxc.rs/docs/guide/usage/linter/type-aware.html)、[typescript-eslint 当前支持范围](https://typescript-eslint.io/users/dependency-versions/)；后者尚不覆盖本仓库的 TypeScript 7，未因此降级各包编译器。

代码扫描范围为 `packages/` 与 `scripts/`，忽略依赖、覆盖率和构建输出；原有研究资料不自动改写。测试只对 mock 方法引用、稀疏数组和恶意 thenable 样例关闭对应三条规则，其余检查继续运行。安全边界故意匹配控制字符、清理时故意拒绝不安全路径的语句使用带原因的单行例外；不全局关闭这些保护规则。实际 CLI 正反回归位于 [scripts/lint.test.mjs](scripts/lint.test.mjs)。

CI 对 pull request 和 push 执行相同的 `pnpm check`，再运行真实 PostgreSQL 持久化集成/故障测试，并校验私有化 Compose 配置。远端 CI 是否运行成功须以实际 workflow 结果为准。

覆盖率检查按包串行运行：Windows 上并行包运行曾在全部用例通过后触发 V8 覆盖率临时目录 `EBUSY`；串行运行保持原覆盖范围和门槛。

任务编排使用锁定的 Turborepo 2.11.10，配置见 [turbo.json](turbo.json)，统一入口见 [workspace.mjs](scripts/workspace.mjs)。仅成功的 `typecheck` 结果可命中本地缓存；`^typecheck` 将上游包源码变化传到下游。缓存输入包含包内默认文件、根 TypeScript/工作区配置、方法包、Agent 定义、旧契约/样例，以及 Node/OS/架构/真实检出目录的运行指纹；已声明的环境变量变化也会失效。缓存不上传，遥测关闭，`.turbo/` 属于忽略的本机生成目录。

`test`、`test:coverage`、`eval:check`、`build` 每次执行；普通测试最多四包并发，覆盖率保持一包。API 构建要创建绑定当前依赖安装目录的开发链接，因此不复用构建输出缓存。数据库/容器验收继续使用专用命令，不进入 Turbo 任务或缓存。入口直接解析并运行已安装的平台原生二进制；缺失时明确失败，不运行可能自动安装依赖的 Turbo JS shim。`--fresh` 跳过本地缓存读取；过滤器必须对应实际存在且有该任务的包，拼错名称不能空跑通过。

缓存行为由 [真实 Turbo 隔离探针](scripts/workspace-cache.test.mjs)验证，含冷/暖执行计数、上游及根配置/内容/环境变化、失败不缓存和强制执行任务。探针只在自己的临时目录使用 Node 内置模块，不更改仓库源码或黄金基线。配置依据：[任务依赖与缓存输入](https://turborepo.com/docs/reference/configuration)、[环境变量与严格模式](https://turborepo.com/docs/crafting-your-repository/using-environment-variables)。

私有化开发基础设施与已知限制见 [deploy/README.md](deploy/README.md)。当前文档和工程骨架不等同于应用已可运行；各阶段任务必须分别通过验收。

当前已落地的 [IR v0.5/v0.6/v0.7 契约与 CLI](packages/ir/README.md)、[阶段 0 进展与剩余项](docs/plan/phase0-progress.md) 分别记录使用方法、验证证据和实现边界。

[阶段1进展](docs/plan/phase1-progress.md)已接入[小说与剧本导入核心](packages/ingest/README.md)、认证来源HTTP和[React来源工作台](packages/web/README.md)：精确来源定位、分批幂等、PostgreSQL读取游标，以及Fountain/CSV/TSV/DOCX候选。StoryBible及后续生成链路仍按计划逐项实施。

[StoryBible候选领域](packages/bible/README.md)提供有界分块、结构化抽取、跨块合并建议、精确引文与受信人工确认/拒绝；[PostgreSQL与逐块预算任务](packages/bible/POSTGRES.md)支持日志提交后SIGKILL、新连接恢复及未知结果对账。认证审阅应用、常驻服务接线、真实文本模型质量和人审仍按[T1.2计划](docs/plan/storybible-phase1.md)继续，不把候选或库级确认直接写入正式IR。

[T1.4 剧作大纲](docs/plan/dramaturgy-phase1.md)已具备五件套契约、固定原创方法、已审阅 Development/Bible 来源、不可变 PostgreSQL 候选与显式人工审阅。单阶段预算工作流仅把运行引用写入任务日志，完整输入和输出保持原有容量；恢复沿用原任务、原模型回执和预算，未知结果须明确对账。认证 API、来源/简报/运行目录、脱敏状态投影和[配置型常驻宿主](deploy/outline.md)已接入，默认关闭；已付费日志在无文本配置的新进程中仍可恢复。[五件套编辑审阅页面](packages/web/README.md)已接真实同源 API，支持普通字段、语义引用、抽离判断和逐问题豁免，保留原候选与人改审计；正式 v0.7 规划图与顺序升级已接入，完整采用映射和分节读取继续推进。合成协议测试不代表真实文本质量或真人签核。

[时间线代数](packages/timeline/README.md) 提供精确时间推算、锚点与音轨检查、不可变编辑；既定技术选择见 [ADR-001–019](docs/adr/README.md)。

[版本域核心](packages/versioning/README.md) 提供候选、基版本冲突、锁与人工采用；[旧样例迁移](packages/ir/MIGRATION.md) 说明 v0.3 到 v0.5 规划候选的显式转换和审计边界。

[持久化执行核心](packages/durable/README.md) 提供 PostgreSQL 步骤日志、租约、重试、定时、人工闸门和取消。`pnpm check` 运行其无数据库单元测试；真实数据库验收另运行 `pnpm test:durable:local --coverage`，或显式设置测试数据库后运行包内 `test:integration --coverage`。

[版本域 PostgreSQL 接入](packages/versioning/POSTGRES.md) 将候选、正式快照、对象历史和采用记录一同事务提交，并验证并发与失败回滚。使用相同测试数据库运行 `pnpm test:versioning:local --coverage`；普通 `pnpm check` 不包含此数据库验收。

[模型模式与连接器](packages/model-modes/README.md) 提供模式版本锁定、能力证据、分层提示编译、受限 HTTP/WebSocket、OpenAI 兼容 LLM、ComfyUI 进度监听与有限重连、fal 队列及录制/回放。本地协议检查已接入 `pnpm check`；[ComfyUI 真实出图和离线回放](docs/validation/comfy-zimage-live-2026-11-16.md)已通过，其他供应商真实配置待后补。

[方法包与评测](packages/methods/README.md) 提供版本 pin、受限目录加载、结构化模型候选、独立评分、人工评分表单、章节切分和四类断言；评分可追加到已有产物，无需再次生成。[章节黄金包](method-packs/chapter-segmentation/README.md) 的固定基线已接入根检查；也可单独运行 `pnpm test:methods:evals`。确定性指标与合成录制/回放不替代真实模型或人工质量验收。

[Agent 执行与制片骨架](packages/agents/README.md) 提供角色加载、结构化模型决策、权限/审批和追踪。[项目预算账本](packages/agents/POSTGRES.md) 在 PostgreSQL 事务中分配份额，未知结果保留占用，终态后显式确认实际量再结算。[持久化协作](packages/agents/COLLABORATION.md) 保存跨工作流任务树、Issue/Question 和两轮审查，通过事务 outbox 投递任务及人工回答。[轮询宿主](packages/agents/HOST.md) 已接通依赖调度、精确领取与停止恢复。制片、模型/预算回放及进程恢复已通过数据库验收；单独运行 `pnpm test:agents:local --coverage`。模型协议为合成录制/回放，独立宿主服务编排、通用角色调度和正式认证仍待接入。

[Agent 行为评测基线](packages/agents/EVALUATIONS.md) 用十个固定合成案例报告完成率、回路、人工升级与已知/未知成本。精确基线检查已纳入 `pnpm check`，也可单独运行 `pnpm test:agents:evals`；这些指标描述行为契约，不作为真实模型质量或账单证明。

[本地 OpenTelemetry](packages/agents/OBSERVABILITY.md) 以真实 SDK span 关联工作流与工具步骤，区分执行/回放并输出按范围脱敏的有界快照；默认不安装网络 exporter，不改写业务日志或候选。

[认证与项目 RBAC](packages/access/README.md) 提供可撤销哈希令牌和逐请求角色验证；[NestJS/Fastify API](packages/server/README.md) 提供默认拒绝的服务入口。[同镜像 API/章节 worker 与可选 Compose](deploy/README.md) 已验证文件凭据、独立低权限身份、预算/人工闸门、停止及重启恢复。完整登录、多树/角色服务、业务 HTTP 接入与发行部署仍待完成。

现有研究资料保留在 `storyboard_platform_v3/`，不会在初始化时自动移动或删除。

[T0.11 合规原文核对包](docs/compliance/phase0-source-review.md)区分官方原文事实、待签核业务适用性和未验证的封装格式；[授权台账模板](docs/compliance/rights-ledger-template.md)当前没有真实授权记录，不产生运行时许可。[T0.12设计伙伴访谈包](docs/validation/design-partner-kit.md)覆盖方案五项假设，尚无真实参与确认。[T0.13导入验收准备](docs/delivery/phase0-readiness.md)与[合成夹具记录](docs/delivery/phase0-import-report.md)包含可重建FCPXML/EDL、媒体探测和预期切点；Resolve已实际启动，但桌面工具交互遇坐标问题，用户选择稍后处理，实际导入仍未执行。
