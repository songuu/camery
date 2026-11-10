# ADR-001：TypeScript monorepo 与 Python 媒体服务

日期：2026-11-10。状态：**设计决策已确认，实施按任务验收**。

## 背景与决策

工作台、API、worker 需要共享 IR 类型和验证契约；文档解析、OCR 和媒体处理需要 Python 生态。按照 [实施计划 v2.1 第 2 章](../plan/implementation_plan_v2.md)，采用 TypeScript monorepo（pnpm + turborepo），媒体能力放在 Python 服务中。

包边界服务于业务模块，共享 IR、时间线、版本和检查器，不以复制前后端类型维持一致。Python 与 TypeScript 之间通过明确的输入输出契约交互，不各自维护一份独立业务真相。

## 代价与边界

需要维护两种语言的依赖、构建和契约测试；monorepo 的任务依赖及缓存键也需要随包边界维护。选择 turborepo 不证明它已安装或缓存已正确失效，必须以实际构建结果验收。

## 实施与验证条件

- T0.1：工作区依赖锁定，lint、类型检查、测试和覆盖率命令可以在干净环境执行；CI 与本地入口一致。
- T0.3：IR 类型及 JSON Schema 由同一源定义生成，前后端消费共享包；跨语言边界校验结构化输入输出。
- 后续媒体服务集成：TS 调用端与 Python 服务通过正常、非法输入及错误上下文的契约测试；构建缓存不能掩盖依赖变更。

关联：[ADR-006](006-ir-and-versioning.md)、[ADR-010](010-media-processing.md)。
