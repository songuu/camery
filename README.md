# Camery

以分镜为核心的 AI 内容创作系统。当前按 [实施计划 v2.1](docs/plan/implementation_plan_v2.md) 开发阶段 0，产品方案见 [solution_v2.md](docs/product/solution_v2.md)。

## 本地开发

需要 Node.js 22 和 pnpm 12.3.4，依赖以 `pnpm-lock.yaml` 为准。

```sh
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm install --frozen-lockfile
pnpm check
```

仓库设置 `verifyDepsBeforeRun: error`：运行测试或检查时，依赖不一致会直接报错，不会隐式安装或重建 `node_modules`。修改依赖后先显式运行 `pnpm install` 更新锁文件；在已有锁文件的干净环境使用 `pnpm install --frozen-lockfile`，成功后再执行检查。

```sh
pnpm lint           # 源文件策略检查：冲突标记、JSON、禁止禁用 TS 检查
pnpm typecheck      # 各包 TypeScript 类型检查
pnpm test           # 工具脚本测试 + 各包测试
pnpm test:coverage  # 测试及包内覆盖率门槛
```

`lint` 是仓库的基础 source-policy 检查，尚不是完整 ESLint 或格式化器；类型检查单独执行。CI 对 pull request 和 push 执行相同的 `pnpm check`，再运行真实 PostgreSQL 持久化集成/故障测试，并校验私有化 Compose 配置。远端 CI 是否运行成功须以实际 workflow 结果为准。

私有化开发基础设施与已知限制见 [deploy/README.md](deploy/README.md)。当前文档和工程骨架不等同于应用已可运行；各阶段任务必须分别通过验收。

当前已落地的 [IR v0.5 契约与 CLI](packages/ir/README.md)、[阶段 0 进展与剩余项](docs/plan/phase0-progress.md) 分别记录使用方法、验证证据和实现边界。

[时间线代数](packages/timeline/README.md) 提供精确时间推算、锚点与音轨检查、不可变编辑；既定技术选择见 [ADR-001–019](docs/adr/README.md)。

[版本域核心](packages/versioning/README.md) 提供候选、基版本冲突、锁与人工采用；[旧样例迁移](packages/ir/MIGRATION.md) 说明 v0.3 到 v0.5 规划候选的显式转换和审计边界。

[持久化执行核心](packages/durable/README.md) 提供 PostgreSQL 步骤日志、租约、重试、定时、人工闸门和取消。`pnpm check` 运行其无数据库单元测试；真实数据库验收另运行 `pnpm test:durable:local --coverage`，或显式设置测试数据库后运行包内 `test:integration --coverage`。

现有研究资料保留在 `storyboard_platform_v3/`，不会在初始化时自动移动或删除。
