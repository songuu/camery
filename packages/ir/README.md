# @camery/ir · 版本化内容契约

当前新建契约为 `0.6.0-draft`，同时严格读取原 `0.5.0-draft`。Zod 定义在 [src/schema.ts](src/schema.ts)，生成 [StoryboardPackage](contracts/storyboard-package.schema.json) 与 [ChangeSet](contracts/changeset.schema.json) 两份双版本交换契约。测试包含生成物一致性检查；旧 schema 独立保存在 `src/legacy/v05-schema.ts`。

```sh
pnpm --filter @camery/ir test
pnpm --filter @camery/ir test:coverage
pnpm --filter @camery/ir typecheck
pnpm --filter @camery/ir schema:generate
pnpm --filter @camery/ir validate --help
pnpm --filter @camery/ir validate path/to/package.json --asset-root path/to/assets
```

CLI 的输出为 JSON：通过退出 0，校验失败退出 1，参数错误退出 2。仅 `--help` 不读项目数据。`--delivery` 额外要求声明 adopted 修订、ready 目标、非空集/目标内容、消费引用 actual/ready、已采用取用的目标时长覆盖、各版本必需节拍覆盖及声明权利；不执行交付、生成或网络请求。规划允许空骨架和未消费的计划候选；计划素材、估计时间及不完整来源会产生声明限制警告。

## 已实现的语义

- v0.6 增加完整 World、Character 开发字段、CharacterRelationship、DevelopmentPlan、EpisodePlan，保留故事设定、欲望/阻力/弧光、主线、未决问题及分集目标/冲突/转折/收尾。审核来源固定普通租户/项目键、run/digest、brief修订、候选/审核摘要与原作者/时点；这些是来源声明，不能自行授予采用权限。
- 规则/问题使用所属 World/Plan 的局部 key；对象使用 ULID 和明确 RevisionRef。未来版本、悬空对象、同计划重复集号/正式Episode、相同上游版本下的来源混用均拒绝。历史依赖保留原 pin 并产生 `STALE_DEVELOPMENT_DEPENDENCY`；`developmentDependencyIssues` 可定位受影响计划和分集，后续生成消费者必须先拒绝这类过期上下文。此提示不证明导入前历史已在本机完整核实。
- `upgradeV05Package` 只是纯结构转换，增加空集合、保留旧对象及版本，不写数据库。已有正式 head 必须通过版本域独立 `upgrade_schema` ChangeSet 显式采用；有其他待审候选时先处理候选。v0.3 迁移仍明确输出并校验 v0.5，不暗改旧样例或已保存请求。

- 严格对象结构、ULID、相对时长、声音类型四分；旧协议不会被静默接纳。
- 镜头与生成素材段解耦；ShotTake 绑定段/素材版本、素材来源、in/out、头尾余量、取用位置、变速及音频策略。规划允许无实际素材，已有采用取用则必须覆盖镜头。
- 取用时长、源区间、头尾余量和覆盖以 BigInt 有理数计算。数值快照无法表示某些分数切点时，仅接受由各字段实际 IEEE 分辨率推导的舍入预算，且总边界差不超过 1ns，并产生 `TAKE_TIME_ROUNDED`。不使用通用 `1e-6` 容差；首段非零偏移、超出预算的缺口/重叠、源区间越界均拒绝。该边界保持版本域拆镜已有的 `TIME_ROUNDED` 序列化契约，不表示媒体采样已经测量。
- 关键帧的首/尾/中间槽位（快照字段仍为 `panels`）；已采用关键帧必须指向声明 ready 的 actual 图像引用。
- 已建模的剧本、声音、素材、快照核心引用；造型归属、声音续接方向、版本、素材派生环、分版本节拍覆盖及覆盖式替代。
- `Shot.anchor_refs` 与 `camera_placement_id` 目前是阶段 2 的预留字段，仅校验字段结构。AnchorVersion、派生视图与机位实体尚未接入，当前 `valid:true` 不证明这些引用可解析；不得据此声明锚点/机位依赖已验证。完整模块按 T2.1/T2.4/T2.7 验收。
- 复用 `@camery/timeline` 求解每集/每版本的相对时间，检查镜头/节拍/cue 锚点、循环、音轨重叠、集内范围和淡入淡出；非口语全局 cue 也不能声称覆盖其他集的节拍。
- `validatePackage` 为浏览器可用的纯数据校验；不会探测文件。Node 导出 `validatePackageFiles` / `validatePackageFile` 核验实际素材存在、路径边界和 SHA-256。
- Node 入口拒绝重复 JSON 键、非法 UTF-8 和非有限数字；文件校验使用同一打开句柄，打开后核对路径/身份，哈希后核对元数据。校验不写源文件。
- Node 入口 `migrateV03` 显式迁移两个实际 v0.3 样例为规划候选，保留完整审计、必要人工映射及未知权利，不猜取用/认证；见 [迁移说明](MIGRATION.md)。

## 阶段范围与验收限制

T0.3 以实施计划明确指定的契约基础为范围；全产品实体表不是阶段 0 的全部实施清单。当前证据如下：

| 计划要求 | 当前实现与回归 |
|---|---|
| Zod / JSON Schema 同源 | `schema.ts`，`v05.test.ts` 对两份生成物逐值比较 |
| ShotTake 多对多、版本、区间 | `schema.ts`、`validate.ts`，`v05.test.ts` / `production.test.ts` / `take-time.test.ts`；版本域 `shot-edits.test.ts` 验证拆并联动 |
| 四种声音语义 | DialogueLine 四种 kind、AudioCue 从 line 推导；`v05.test.ts` / `continuity.test.ts` / `production.test.ts` |
| PlotUnit / 集末状态快照 | 跨集情节单元、事实、知情、位置/造型/持物、伏笔与版本引用；`continuity.test.ts` 正反例 |
| 质量档及版本派生 | Asset 的 draft/upscaled/refined、derived_from；`production.test.ts` 引用/版本/环反例 |
| 旧规则及两个 fixture | [旧规则核对及有界差分审计](LEGACY-RULES.md)记录 70 个显式报告调用点去向；`migrate-v03.test.ts` 与新增导入守卫验证两个原样例、条件矩阵和生成物一致性 |

该范围不承诺任意旧包/全部 JSON Schema 约束等价，也不将真实媒体探测、升档预算流程、锚点/导演模块或导入 UI 视为已完成。它们分别按媒体/制作、阶段 2 和 T1.1 验收。单元测试中的确定性 ULID 别名映射只供测试使用，不替代 Node 的显式迁移边界。

T0.4 时间求解、轨道重叠/淡入淡出检查与通用编辑代数已落地，详见 [timeline 包](../timeline/README.md)。T0.5 的应用、冲突、锁、采用、拆并引用联动及数据库事务见 [versioning 包](../versioning/README.md)；[认证/RBAC 骨架](../access/README.md)已有独立验收，认证 HTTP 到版本采用业务服务仍待连接。`valid: true` 只说明当前已实现检查通过，不能用来替代阶段 0 全部验收或实际交付批准。

素材时长仍是声明值，未调用 ffprobe 核实。文件哈希通过不代表内容质量、事实准确、版权许可有效或目标后期软件可接受。文件系统检查是便携的一致性检查；生产环境需通过权限/隔离冻结校验中的素材目录，不能将其当作对抗恶意并发目录写入的操作系统沙箱。
