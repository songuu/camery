# @camery/ir · 阶段 0 首批契约

当前规范为 `0.5.0-draft`。Zod 定义在 [src/schema.ts](src/schema.ts)，生成 [StoryboardPackage](contracts/storyboard-package.schema.json) 与 [ChangeSet](contracts/changeset.schema.json) 两份交换契约。测试包含生成物一致性检查。

```sh
pnpm --filter @camery/ir test
pnpm --filter @camery/ir test:coverage
pnpm --filter @camery/ir typecheck
pnpm --filter @camery/ir schema:generate
pnpm --filter @camery/ir validate --help
pnpm --filter @camery/ir validate path/to/package.json --asset-root path/to/assets
```

CLI 的输出为 JSON：通过退出 0，校验失败退出 1，参数错误退出 2。仅 `--help` 不读项目数据。`--delivery` 额外检查已采用取用的目标时长覆盖、各版本必需节拍覆盖及声明权利；不执行交付、生成或网络请求。

## 已实现的语义

- 严格对象结构、ULID、相对时长、声音类型四分；旧协议不会被静默接纳。
- 镜头与生成素材段解耦；ShotTake 绑定段/素材版本、素材来源、in/out、头尾余量、取用位置、变速及音频策略。规划允许无实际素材，已有采用取用则必须覆盖镜头。
- 关键帧的首/尾/中间槽位（快照字段仍为 `panels`）；已采用关键帧必须指向声明 ready 的 actual 图像引用。
- 已建模的剧本、声音、素材、快照核心引用；造型归属、声音续接方向、版本、素材派生环、分版本节拍覆盖及覆盖式替代。
- 复用 `@camery/timeline` 求解每集/每版本的相对时间，检查镜头/节拍/cue 锚点、循环、音轨重叠、集内范围和淡入淡出；非口语全局 cue 也不能声称覆盖其他集的节拍。
- `validatePackage` 为浏览器可用的纯数据校验；不会探测文件。Node 导出 `validatePackageFiles` / `validatePackageFile` 核验实际素材存在、路径边界和 SHA-256。
- Node 入口拒绝重复 JSON 键、非法 UTF-8 和非有限数字；文件校验使用同一打开句柄，打开后核对路径/身份，哈希后核对元数据。校验不写源文件。
- Node 入口 `migrateV03` 显式迁移两个实际 v0.3 样例为规划候选，保留完整审计、必要人工映射及未知权利，不猜取用/认证；见 [迁移说明](MIGRATION.md)。

## 尚未完成的阶段 0 工作

T0.3 尚未整体完成：两个原始样例的规划迁移及生成物一致性已落地；全部旧规则的逐条对照、其余计划实体和产品化导入流程仍需补齐。单元测试中的确定性 ULID 别名映射只供测试使用，不替代 Node 的显式迁移边界。

T0.4 时间求解、轨道重叠/淡入淡出检查与通用编辑代数已落地，详见 [timeline 包](../timeline/README.md)。T0.5 的应用、冲突、锁、采用及拆并引用联动见 [versioning 包](../versioning/README.md)；数据库事务和真实会话授权尚未接入。`valid: true` 只说明当前已实现检查通过，不能用来替代阶段 0 全部验收或实际交付批准。

素材时长仍是声明值，未调用 ffprobe 核实。文件哈希通过不代表内容质量、事实准确、版权许可有效或目标后期软件可接受。文件系统检查是便携的一致性检查；生产环境需通过权限/隔离冻结校验中的素材目录，不能将其当作对抗恶意并发目录写入的操作系统沙箱。
