# @camery/script · 原创开发核心

实现v2.1 T1.3的两阶段候选契约：创意brief→世界观/人物/主线foundation→用户显式编辑审阅→分集episodes。领域/方法、逐阶段PostgreSQL持久化、预算恢复、认证API、可编辑工作台和配置型常驻宿主已接入；正式开发IR采用与真实模型质量仍按[完整计划](../../docs/plan/original-development-phase1.md)继续。不能据库级测试判定完整T1.3或阶段1已完成。

| API | 行为 |
|---|---|
| `captureBrief(input)` / `validateBrief(snapshot)` | 精确创意、tenant/project/brief/revision、集数和规划时长，完整快照SHA-256；不把应用ID当IR ULID |
| `validateFoundation(output)` | 世界时代/环境/规则、人物欲望/阻力/弧光、人物关系和主线；局部身份唯一且引用完整，至少一位主角驱动主线；保留同名不同身份 |
| `validateEpisodes(brief,foundation,output)` | 精确集数、数组内连续集号、唯一有效角色/规则引用、整季至少一位主角参与；不自动补集、排序或改写文本 |
| `createOriginalFoundationMethodPack()` / `createOriginalEpisodesMethodPack()` | 原创固定`original.develop.foundation@1.0.0` / `original.develop.episodes@1.0.0`，development/balanced，严格输出DSL；不配置供应方/密钥 |
| `prepareDevelopmentStage(brief,stage,reviewed?)` | 为既有MethodRunner/Agent driver编译固定pin与不可信输入、精确请求摘要；episodes只消费已审阅foundation输出与摘要 |
| `generateFoundation(options)` / `generateEpisodes(options)` | 受信runner/context下每阶段一次模型调用，保留原始ModelReceipt，校验method/tenant/connection/mode/call/input/output绑定；无重试 |
| `createFoundationCandidate` / `createEpisodeCandidate` | 从Agent原始finish-output和回执构造同一候选，不再调用模型 |
| `validateFoundationCandidate` / `validateEpisodeCandidate` | 重建候选、绑定当前brief及上游摘要；新brief或新设定拒绝沿用旧结果 |
| `reviewFoundation` / `reviewEpisodes` | 严格`{candidateDigest,output}`决定，保留原始候选及独立编辑审计；真实宿主注入人类身份、范围、时间和同步授权 |
| `rejectDevelopment` | 显式保存拒绝原因；拒绝不是可用于下一步的上游 |
| `validateReviewedFoundation` / `validateReviewedEpisodes` | 审计完整性重放，**不做认证**，不证明被引用candidate存在。应用必须从可信存储读取审核并核对原始候选身份，不能接受客户端自报批准 |

`@camery/script/contracts`仅含Zod和擦除后的类型导入，可供后续浏览器契约复用；包根使用Node摘要能力，不导入浏览器。

`@camery/script/http`提供浏览器安全白名单契约与完整逻辑JSON边界。node公开投影隐藏执行配置、原始模型回执、provider/driver错误；保存创意目录每页20个最新修订，可恢复尚未开始运行的创意。已有run状态先读取原Task，再读取追加审计，避免并发确认混合旧上游和新分集任务。HTTP项目权限、宿主配置和两层Compose见[部署说明](../../deploy/development.md)。

创意最多2000 UTF-16单元；集数1–100、规划时长1–3600秒/集。应用默认10集的选择属于宿主，核心要求明确输入。完整brief逻辑JSON≤8KiB（包含version/digest），foundation≤32KiB、episodes≤64KiB，候选/审阅封套≤256KiB。数量上限不保证所有字段同时达上限仍符合总预算；超限明确拒绝，不截断。数据在Zod复制前经过描述符快照和逐字节计费，拒绝getter、循环、稀疏数组及任意原型。

模型创作不伪装为来源事实，没有虚构引文；结构验证不证明剧情连贯、角色弧光可信或质量达标。用户修改保持单独审核输出，原始模型outputDigest不重写；取消前未请求为not_sent，已识别真实完成后取消/领域错误保持completed，无法辨识宿主返回为unknown，未知usage仍为null。

审核只接受同步字面true；误配置异步回调仍拒绝，并观察其拒绝，避免未处理Promise。时间为规范UTC毫秒格式，审核快照只允许同一brief作用域。摘要是内容一致性标识，不是远程签名、人类授权或正式IR采用。

`@camery/script/node`提供追加式brief/run/候选/审阅存储、有界目录、显式迁移、独立最小角色及每阶段独立durable task与既有Agent/预算账本的工作流，接入约束见[PostgreSQL与恢复说明](./POSTGRES.md)。新执行校验最新brief，已付历史结果保留；恢复先排空原任务尾日志，未知结果需显式对账。真实文本模型需宿主配置；现有ComfyUI图像连接不能代替它。正式IR需要完整开发对象、显式身份映射和ChangeSet权威，不将设定塞进人物role或集title。

```sh
pnpm --filter @camery/script test:coverage
pnpm --filter @camery/script typecheck
pnpm test:script:local -- --coverage
pnpm check
```

协议夹具通过真实OpenAI适配器录制两次响应，再精确回放包含人工编辑的同一流程；没有真实模型推理、真实账单或真人签核。固定方法资产与provider基础DSL结构一致；Unicode/ID格式、跨引用及总字节限制由领域补充，不宣称两种schema在所有语义上等价。

公开AgentRuntime／预算workflow／DurableWorker的进程内组合保留：每阶段独立task，32704字节设定在默认ModelSession限额下通过，已审阅编辑进入下一阶段；重建worker复用缓存journal后模型调用和预算分配增量均为0。Runtime完整请求131072字节通过、131073被阻塞；Worker输入/输出1048576字节通过、多1字节拒绝。

真实PG专项进一步验证并发幂等、首次审阅新鲜度、跨作用域/原始回执绑定、两阶段提交丢确认及新连接恢复、测试子进程提交后SIGKILL、unknown显式对账及已付旧brief结果保存；恢复通过正常dispatcher返回原任务且无新增模型调用。模型响应仍是协议夹具，不证明供应方真实推理或实际费用。运行角色仅四表SELECT/INSERT，并拒绝角色继承、转授权、额外对象能力及REPLICATION。
## 正式开发对象映射

`@camery/script/node` 提供 `PostgresDevelopmentIrIdentities.prepare({source,target})`：在同连接内重建已审核来源，再独立追加稳定对象身份，返回 `{identities,progress}`。构造器接收可信来源 store 与宿主 ULID 分配器；准备动作不是读取，也不会创建正式项目。World/人物/关系按真实 foundation owner 与局部 ID 区分，plan/分集槽位按项目稳定。已有映射残缺会拒绝，不能静默换 ID；旧五表数据角色不获得新表权限。

`prepareDevelopmentDraft({progress,source,identities,reviewers,head})` 完整映射世界设定、人物开发、关系、主线和分集，保留原审核来源、对象 base 与预计写后依赖版本。只能消费可信存储读出的审核；摘要本身不授予批准。目标须显式升级到 v0.6。新设定不按姓名合并，缩集不删除人工场景或媒体；锁与引用冲突交给原版本引擎明确拒绝。

`finalizeDevelopmentChangeSet({draft,changeSetId,author,operationIds})` 使用已固定身份生成候选 ChangeSet，不自行分配身份或采用。空 draft 表示相对该基线无变化，由共享采用应用保存 unchanged 意图，不造空 ChangeSet。宿主还须先解析共享项目/人类身份、持久化完整 intent，再通过同事务来源 guard 和正式采用服务处理。

## T1.4 五件套大纲

`@camery/script/outline/contracts` 和 `@camery/script/outline` 保持浏览器安全，提供五件套、题材、来源/简报契约和纯检查器。`@camery/script/outline/node` 提供下列宿主能力：

| API | 行为 |
| --- | --- |
| `captureOutlineBrief` / `validateOutlineBrief` | 固定目标、备注、主辅题材全文摘要及完整有效规则阈值 |
| `resolveOutlineSource(descriptor, stores)` | 从真实已审阅 Development 或已确认 Bible 读取完整创作材料，核对审计身份与当前性，派生引用目录；不遍历完整原文 |
| `validateOutlineSourceSnapshot` | 重建来源材料/目录与摘要；只做完整性重放，不批准客户端 JSON |
| `createOutlineMethodPack` / `prepareOutline` | 固定原创 `adaptation.outline@1.0.0`、题材及精确模型请求；动态正文只进入不可信数据封套 |
| `generateOutline` / `createOutlineCandidate` | 单次 MethodRunner 调用或原 Agent finish-output 收据构造候选；核对原始请求/输出绑定，保留外部结果，不修复重试 |
| `reviewOutline` / `rejectOutline` | 由受信任人类宿主显式决定，编辑后重算完整规则，逐辅轴记录人工抽离判断，逐实际问题记录豁免理由 |
| `validateOutlineCandidate` / `validateReviewedOutline` | 绑定当前简报、实际来源和原候选的完整性重放；读取审计仍须可信存储及应用权限 |

来源目录 ID 的含义由来源快照摘要及 JSON pointer 共同确定；不能把相同路径的 ID 当作跨来源同一实体。素材仅为规划，不产生 ready 媒体。情绪和秒数是创作估计，规则报告与人工审阅不等于观众效果、质量评分或法务签核。

简报≤16KiB，来源快照（含最多2048条引用目录）≤512KiB，大纲输出≤512KiB，候选/审阅封套≤2MiB；超限拒绝而不截断。模型宿主仍须显式配置适配输入/输出容量。来源读取与当前性检查是分离的读操作，最终写入必须在 OL-3 的事务内重新锁定和检查来源。当前尚未提供大纲持久化、预算宿主、HTTP/页面或正式 IR 采用；完整范围和证据见[大纲实施计划](../../docs/plan/dramaturgy-phase1.md)。
