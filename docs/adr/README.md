# 技术决策索引

依据：[实施计划 v2.1 第 2 章](../plan/implementation_plan_v2.md)。日期：2026-11-10。

ADR-001–019 的统一状态为：**设计决策已确认，实施按任务验收**。文档记录所选方向、代价和证明条件，不证明相关库、服务、连接器或产品功能已经实现。具体开发证据见 [阶段 0 进展](../plan/phase0-progress.md)。

| ADR | 决策 | 记录 |
|---|---|---|
| 001 | 语言与仓库 | [TypeScript monorepo 与 Python 媒体服务](001-language-and-monorepo.md) |
| 002 | 后端 | [NestJS / Fastify 模块化单体](002-backend-modular-monolith.md) |
| 003 | 数据库 | [PostgreSQL 16、pgvector 与 Drizzle](003-postgres-and-drizzle.md) |
| 004 | 存储 | [本地 / NAS / S3 存储抽象](004-storage-abstraction.md) |
| 005 | 持久化执行 | [基于 PostgreSQL 的自研执行引擎](005-postgres-durable-execution.md) |
| 006 | IR 与版本 | [Zod、JSON Schema 与 ChangeSet](006-ir-and-versioning.md) |
| 007 | AI 运行方式 | [Agent → Skill → Tool](007-agent-skill-tool.md) |
| 008 | 模型接入 | [模型模式注册表](008-model-mode-registry.md) |
| 009 | 前端 | [工作台 SPA 与编辑视图](009-frontend-workbench.md) |
| 010 | 媒体处理 | [FFmpeg 与工坊模板渲染](010-media-processing.md) |
| 011 | 实时 | [SSE 与事件游标](011-sse-and-cursors.md) |
| 012 | 可观测 | [OpenTelemetry 与脱敏诊断](012-observability.md) |
| 013 | Agent 运行时 | [持久化步骤与恢复](013-durable-agent-runtime.md) |
| 014 | Agent 协作 | [层级调度、IR 黑板与审查回路](014-agent-collaboration.md) |
| 015 | 工具协议 | [内部工具 schema 兼容 MCP](015-internal-tool-schema.md) |
| 016 | 私有化发行 | [容器、离线包与签名授权](016-private-distribution.md) |
| 017 | 交付格式 | [后期交接与兼容性验证](017-delivery-formats.md) |
| 018 | 热点接入 | [统一 HTTP / MCP / 文件入口](018-trend-intake.md) |
| 019 | 镜头取用 | [ShotTake 多对多与版本绑定](019-shot-takes.md) |

[ADR-000](000-phase0-foundation.md) 记录工程启动基线，不能代替上述逐项决策或验收。

边界：ADR-015 确定内部工具定义格式，ADR-018 单独要求 Studio 1.0 对外提供受限热点 MCP 工具；两者不等于开放全部内部工具。ADR-017 的剪映支持取决于 T0.13 实测。法规、备案分类、AIGC 字段与调研经验值须按 T0.11 或模型评测核实，不能因 ADR 已确认就视为已验证。
