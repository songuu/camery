# 本地接入实施契约 v1（待前置完成后实施）

日期：2026-11-11。状态：**设计规格；接口、表、命令与测试名均为待实现约定，不表示已上线**。

本文件细化[架构方案](local-comfyui-beeftv-integration.md)，供[执行任务清单](local-integration-backlog.md)引用。现有实现与本文冲突时先以代码事实确认差距，不能把本规格反写成既有能力。任务启动条件采用 `P-CORE / P-ASSET / P-APP / P-UI / P-APPROVAL`；设备协议、操作账本和同步属于接入任务自身，不列成永远等待的前置。

## 1. 包边界与实现落点

| 路径（拟新增） | 导出与职责 | 禁止依赖 |
|---|---|---|
| `packages/integrations/src/contracts/` | `ids`、`envelopes`、`operations`、`bridge`、`transfer`、`sync`、`errors` 的校验 schema 和纯类型；导出 `@camery/integrations/contracts` | PG、Drizzle、Nest、OS 文件操作、凭据解析 |
| `packages/integrations/src/adapters/` | `ports`、`comfy`、`beeftv`；导出 `@camery/integrations/adapters`；协议映射、能力判断 | 版本采用、数据库和预算 store |
| `packages/integrations/src/node/` | `store`、`migrate`、`outbox`、`application`、`orchestrator`、`receipts`、`approval-port`；仅服务端导出 `@camery/integrations/node` | Bridge 运行包不可引用此子路径 |
| `packages/integrations/src/node/migrations/` | 接入 schema 递增迁移，沿用仓库 migration 记录和校验方式 | 运行进程自动执行 DDL |
| `packages/local-bridge/src/` | `main/config/pairing/client/executor/journal/staging`，固定 adapter 宿主 | PG、正式采用、全局调度、任意 shell |
| `packages/server/src/integrations/` | controller、独立设备 guard、宿主授权/文件传输入口、服务装配；独立 integration-worker 入口 | 改造固定章节 worker 为任意角色执行器 |

不提供把 contracts 和 node 混合导出的根 barrel。Bridge 构建验收检查依赖闭包无 `pg/drizzle-orm/@nestjs`；共享 adapter 可使用 `model-modes` 的受限传输，不重复实现 Comfy 连接器。P-ASSET默认落点为拟建的`packages/storage/src/{store,local,transfer}.ts`、`services/media-py/app/{probe,images}.py`；P-APP默认落点为`packages/server/src/projects/{application,controller}.ts`。前置已实现同等能力时在readiness记录实际路径并复用，不创建重复包；接入层只依赖下列端口。

### 1.1 内部端口

以下是操作语义，不是可执行代码或已存在 SDK：

| 端口 | 输入 | 输出/副作用 |
|---|---|---|
| `GenerationAdapter.inspectEnvironment` | 已登记连接、所需模式依赖 | 版本、节点/模型证据、capabilityDigest、缺项；只读 |
| `GenerationAdapter.stageInputs` | 固定素材版本、授权读取句柄、输入映射 | 供应商输入引用及每步操作回执；上传属 external |
| `GenerationAdapter.submit` | 冻结 request、operationId、有效执行授权 | accepted(remoteId) / knownNotSent / rejected / unknown；不内部重试提交 |
| `GenerationAdapter.observe` | 原 operation、remoteId、原 clientId | 一次有限观察，返回状态、输出描述、下一次查询建议；不重新生成 |
| `GenerationAdapter.requestCancel` | 原 remoteId、已验证取消能力 | requested / confirmed / unsupported / unknown；不把 200 当终止证据 |
| `WorkspaceAdapter.read` | 已选工作区/画布、范围 | revision、允许同步字段、外部身份 |
| `WorkspaceAdapter.applyStep` | 固定子步骤、operationId、expectedRevision | 写回执、新 revision 和 ID；只接受固定操作枚举 |
| `WorkspaceAdapter.findReceipt` | operationId、已知远端身份 | found / absent / unknown；absent 不授权自动重发非幂等创建 |
| `ArtifactStore` | begin、写分片、verify、publish、read、abortTemporary | 授权对象句柄及不可变内容身份；不接任意本机路径 |
| `MediaInspector` | 已校验临时对象、预期类型/上限 | 实际参数与格式验证结果；不决定内容质量或正式采用 |
| `CandidateApplication` | 可信身份、固定候选 ID、base revisions、变更、来源证据 | 幂等提交候选；采用另用既有版本域授权入口 |
| `ApprovalAuthority` | 用户身份、参数/报价摘要、项目/范围/期限 | 签发、校验、绑定一次执行授权；`P-APPROVAL` 未通过时收费提交拒绝 |

BeefTV 的 MCP/CLI/HTTP 选择、真实工具名映射和 upload body 由 L0 兼容性档案填入 adapter。此端口约定不替代供应商契约；无法取得完整外部契约时，对应 adapter capability 禁用，通用模块仍可用模拟器开发。

## 2. 公共标识、摘要与幂等

### 2.1 标识分工

| 标识 | 产生方及格式 | 生命周期 |
|---|---|---|
| 认证 tenant/user/project ID | 沿用 accessId 与实际SessionIdentity校验规则，允许现有slug | 客户端不得替换认证作用域；不强制迁移现有认证ID |
| IR object/change ID及版本域project key | 沿用各自现有StableId/schema约束 | P-APP负责从可信项目范围解析到满足版本域约束的key；不兼容配置拒绝接入，不擅自将slug转为新ULID |
| connection/generation/operation/sync ID | Camery 生成 ULID；API 保留为字符串 | 数据库保证同K范围唯一；跨表引用必须携带tenant/project |
| device ID | Camery生成ULID | 同租户唯一；项目授权通过独立grants |
| HTTP `Idempotency-Key` | 调用方 8–128 位 `[A-Za-z0-9:_-]` | 同主体+项目+路由语义作用域唯一；相同键同请求返回原响应，不同请求 409 |
| durable task ID / step key | 应用创建固定 task ID；step key 随已发布 workflow 版本固定 | 通过现有 `stepIdempotencyKey()` 生成步骤身份，不自行换算法 |
| external operationId | 应用生成并持久化；一项外部副作用一个 | 与 durable step key 显式绑定，进程重启不重建；供应商使用其派生稳定值 |
| provider operation ID | `camery_<operationId>`，或能力档案指定的固定编码 | 首次调用前保存；如服务要求 UUID，生成一次并保存，不按重试重新生成 |
| remoteId / Comfy clientId | 真正远端回执 / 原提交时确定值 | 只是关联身份，不作为通用 exactly-once 证明 |
| traceId / requestId / eventCursor | 追踪/HTTP/事件系统 | 不参与业务去重；cursor 为不透明字符串 |

同步 saga 的创建画布、创建分镜、上传、完成上传、创建素材、绑定节点各自拥有 operationId。一个 root SyncRun ID 不能当所有供应商写操作的幂等键。

### 2.2 requestDigest v1

输入先通过严格 schema，拒绝额外字段、重复 JSON key、非有限数、unsafe integer、原型污染键和非法 Unicode。使用仓库已有 canonical JSON 规则的纯实现/测试向量；实施时固定 `digestAlgorithm=camery-canonical-json-v1+sha256`，不要静默改为另一算法。

摘要覆盖 `contractVersion/kind/tenantId/projectId/connectionId/workspaceIdentity/targetVersions/modePin/workflowDigest/environmentDigest/inputAssetVersions/parameters/seed/expectedRevision` 中适用于该操作的字段。文本不做未经声明的 trim、Unicode 归一化或数组排序；数字 seed/大计数使用十进制字符串或经 schema 限定的安全整数。原 workflow 文件另按原始字节计算 SHA-256。

不纳入凭据、短期下载 URL、traceId、租约、重试时间、当前显示名。无意义差异不能改变冻结业务内容；任何真正参数变化必须建立新操作。operation 行保存摘要和不可变请求引用，body 过大时只存受控 blob 引用，不塞进 durable 1 MiB JSON 日志。

API idempotency 记录保留到相关操作/审计保留期结束；不能在仍可能收到重试时先删除键。仅凭“超过 24 小时”不可将同键解释为新生成。

冻结连接的配置版本与workspaceIdentity；修改端点、凭据作用域或切换BeefTV工作区后，新操作使用新配置。旧操作仅能向原身份对账，禁止在新端点续发；旧绑定不能自动继承到另一个工作区。远端身份无法证明一致时需管理员重新绑定。

## 3. 持久化与迁移规格

使用 `camery_integrations` schema。下表的 `K` 表示 `(tenant_id, project_id)`，仅租户设备主表除外；所有项目业务外键包含 K，禁止仅凭裸 ID 关联。普通 IDs 为 text 并使用契约约束；新增持久化CAS version、fence、sequence为bigint，API编码为十进制字符串。现有IR对象revision/版本字段继续沿原schema的安全整数，不能把已有数字契约改成字符串；adapter明确区分两者。

| 表 | 主键/关联及关键内容 | 唯一约束/索引 |
|---|---|---|
| `connections` | K+connection_id；provider、device_id可空、endpoint_ref、credential_ref、workspace_identity、配置版本/能力摘要、enabled | K+connection_id；按 K+enabled；设备绑定通过 device_project_grants 校验 |
| `devices` / `device_project_grants` | tenant+device_id；凭据哈希、协议版本、撤销；授权表 K+device_id | grants 含 allowed_actions；撤销/在线索引；不存明文令牌 |
| `pairings` | tenant+pairing_id、project_id、邀请码哈希、申请nonce/设备摘要、批准者、过期/消费时间 | 邀请码哈希唯一；只允许一次批准与兑换 |
| `preparations` | K+preparation_id；不可变请求ref/digest、模式/来源/参数/估算、有效期与创建者 | K+preparation_id唯一；到期索引；不按requestDigest唯一，以允许用户明确再次生成同参数 |
| `generation_jobs` | K+generation_id；preparation_id FK、immutable request ref/digest、source revisions、mode pin、planned_task_id（不可变）、bound_durable_task_id（可空）、预算回执引用、candidate id、业务投影 | UNIQUE(K,preparation_id)，防不同HTTP key重复提交同准备单；K+status+updated_at；只对enqueue确认后写入的bound_durable_task_id建立durable实际tenant/task复合FK，planned_task_id不建悬空FK |
| `external_operations` | K+operation_id；job或sync所属、connection_id、kind、request_digest/ref、remote_id、provider_operation_id、state、cancel_state、fence、version | K+connection_id+provider_operation_id 唯一；connection+remote_id 只在具体 provider 保证唯一时建部分唯一索引；state+next_check_at |
| `dispatches` | K+dispatch_id、operation_id、device_id、fence、claim_request_id、state、permit哈希/期限、issued/consumed time | 同 operation 同时最多一个 active dispatch；重复 claim_request_id 返回原派发；device+state+lease_until |
| `receipts` | K+receipt_id、operation_id、device_id、dispatch/fence、payload_digest、sequence、可信分类 | `(K,device_id,receipt_id)`唯一；同 ID 内容不符拒绝；operation+received_at；append-only |
| `sync_runs` / `workspace_bindings` | K+sync_id；方向、基线、固定变更计划与检查点；binding保存 IR对象/版本、canvas/row/node/resource/asset 与字段摘要 | binding 的 K+connection+workspace+外部类型+外部ID 唯一；允许一个IR对象映射多个角色但 role必须纳入唯一键 |
| `artifact_receipts` / `upload_sessions` | K+artifact_id；purpose、operation/output_slot可空、input_upload_id可空、存储对象、hash/probe、归档状态；上传会话保存大小、分片、授权主体、期限 | generated_media要求operation/output_slot且有部分唯一约束`(K,operation_id,output_slot)`；input_content/input_media要求input_upload_id且禁止伪造operation，唯一`(K,input_upload_id)`；相同槽位异字节冲突；session+chunk_index唯一 |
| `outbox` | K+event_id、类型、aggregate/version、payload/ref、可用时间、投递租约/次数 | event_id及业务dedupe key唯一；未投递 available_at 部分索引；与接入状态更新同事务 |
| `events` / `request_receipts` | events为项目事件游标、安全投影；request_receipts记录HTTP幂等摘要及响应 | `(K,event_sequence)`；主体+路由作用域+Idempotency-Key唯一 |

FK 到现有 project/task 表的精确表名和列由 migration 编写时从 schema 核实，不假设 access、versioning 已有统一项目表。已有实体若无合适数据库 FK，则使用显式受信应用校验并记录理由；不能创建悬空 FK 或在接入包复制项目主表。generation/sync 二选一归属用检查约束；不得允许一个 operation 隐式归属多个计费主体。

每次业务更新用 `version` CAS；状态迁移和 outbox 追加在同一接入事务。远端调用不持有数据库行锁。数据库只保证自身原子性；budget、durable、versioning、文件存储依既有 store 接口做可恢复 saga，不让应用同时持有多个包内部事务。

### 3.1 最小数据库权限

| 角色 | 权限 |
|---|---|
| installer | 新 schema DDL/迁移；单独凭据，不进应用镜像运行配置 |
| API | 读取授权范围配置/投影；创建请求、配对、授权、回执；禁止直接写 adopted IR、删除审计与发任意 SQL |
| integration worker | 领取自己的任务、操作/回执/归档/outbox写入、候选提交所需最小权限；不能签发人类批准 |
| relay/observer | 可与 worker 同进程，仍只按注册类型领取；禁止任意外部提交 |
| Bridge | 无数据库身份；只访问设备 HTTP 协议和对象授权 |

PostgreSQL grants 与应用 project RBAC 均需负向测试；若采用列级权限，应与现有 server 启动自检一致，不能用 schema owner 运行。迁移需验证从空库和升级库均可重入，历史内容被改写时报冲突。

### 3.2 发布次序

1. P-CORE 数据库基线可用后部署纯增加型 migration，建立表、约束、索引与受限角色；功能开关默认关闭。建表不等待 P-APP 业务入口全部完成，启用项目业务读写前才要求其授权/身份映射验收，避免连接服务与接入表互相等待。
2. 部署能读新 schema、但不派发的 API/worker；验证幂等、权限、恢复和旧功能回归。
3. 发布 Bridge，完成版本握手/配对和只读探测；再为测试项目启用 `localIntegrations`，分别启用 `comfyGeneration`、`beeftvWorkspace`。
4. 实机验收后扩大项目范围；收费渠道另受 `beeftvPaidGeneration` 和 P-APPROVAL 限制。
5. 回退先关闭新派发，再排空/对账已有 operation；保留旧 workflow/adapter pin。不能删除新表或回退成无法解读在途回执的版本；必要时保留兼容 worker，恢复旧应用仅处理旧能力。

## 4. 状态模型与事件

### 4.1 单次外部操作状态

| 当前状态 | 允许下一状态 | 条件 |
|---|---|---|
| `prepared` | `waiting_authorization`、`dispatchable`、`rejected` | 请求冻结；预算/批准不足等待；授权齐全才 dispatchable |
| `waiting_authorization` | `dispatchable`、`rejected` | 核实有效预算/批准及用户最新权限 |
| `dispatchable` | `claimed`、`rejected` | 固定设备/连接领取；取消在提交前成立则拒绝执行 |
| `claimed` | `submitting`、`dispatchable`、`rejected` | consumed permit之前可确认未发送并释放；已消费不能直接释放重领 |
| `submitting` | `remote_queued`、`running`、`remote_succeeded`、`rejected`、`not_sent`、`submit_unknown` | 保存accepted回执；无响应转unknown；明确拒绝或未发送需证据 |
| `not_sent` | `retry_wait`、`rejected` | 仅可信adapter证明本次没有调用远端；检查重试次数/预算/取消；consume过的批准不能自行复用 |
| `retry_wait` | `dispatchable`、`rejected` | 持久化重试时间到达，权限/预算和必要重新批准有效；创建新派发许可，保持同一请求摘要；unknown无此出口 |
| `submit_unknown` | `reconciling` | 查询原操作，保持预算 |
| `reconciling` | `remote_queued`、`running`、`remote_succeeded`、`remote_failed`、`remote_cancelled`、`needs_review` | 证据驱动；不存在“查不到→直接dispatchable”转换 |
| `remote_queued` | `running`、`remote_succeeded`、`remote_failed`、`remote_cancelled`、`reconciling` | 历史可直接证明缓存完成；离线不等于失败 |
| `running` | `remote_succeeded`、`remote_failed`、`remote_cancelled`、`reconciling` | 远端终态证据或失联 |
| `needs_review` | `reconciling`、`remote_succeeded`、`remote_failed`、`remote_cancelled`、`rejected` | 管理员提供可审计证据；新尝试必须新operation |
| `remote_succeeded`、`remote_failed`、`remote_cancelled`、`rejected` | 无自动回退 | 最终证据与后续归档/费用分别记录；勘误追加事件，不覆盖历史 |

`unknown` 是结果不确定，不是普通可重试失败。状态跳转由应用服务验证；设备只提交证据，不能直接请求把某个 job 改为 succeeded。

独立维度：`cancelState=none|requested|confirmed|unsupported|unknown`；`artifactState=not_expected|pending|transferring|verifying|published|quarantined|failed`；`costState=held|actual_pending|confirmed|settled`。取消确认不意味着费用为0，成功也不意味着已归档；晚到素材可 published，但不能因此自动采用。

远端终态谓词只接受remote_succeeded/remote_failed/remote_cancelled以及有未受理证据的rejected。remote_cancelled必须取得针对原remoteId的终止证据，或能力已验证的pending原子移除结果并确认没有在途执行；普通200/取消按钮ACK不够。写remote_cancelled同时设置cancelState=confirmed；若取消竞态后实际已成功，保留remote_succeeded和取消请求历史，不伪造cancelled。终态证据可解除父remote.final等待，费用是否可结算另由实际量决定。

GenerationJob 用户投影为 waiting/queued/generating/reconciling/ingesting/candidate_ready/failed/cancelled，并另显示取消/费用/同步状态。`candidate_ready` 表示已有可审阅候选，预算工作流可能还在等待实际费用。

### 4.2 事件与乱序

事件名固定：`integration.connection.changed`、`device.status.changed`、`operation.state.changed`、`operation.evidence.received`、`artifact.state.changed`、`candidate.created`、`sync.conflict.detected`、`cost.state.changed`。事件有 contractVersion、eventId、project cursor、aggregateId/version、occurredAt、脱敏 data。

同一 aggregate 只应用更高版本；receipt 的设备 sequence 用于检测缺口，不作为远端完成时间。晚到 queued/running 不覆盖已证实终态。不同终态冲突保留两份证据并标记人工核对，不按“最后收到”裁决。SSE 丢失游标返回 `CURSOR_EXPIRED` 与重新取快照提示，不返回其他项目历史。

## 5. 生成与预算编排

### 5.1 可恢复时序

1. prepare：验证 P-APP、模式和素材版本，产生不可变准备记录、requestDigest、预算估算及所需批准；不提交供应商。
2. submit API：验证同一准备版本/摘要和当前权限，接入事务建立 GenerationJob、ExternalOperation 意图和 enqueue outbox；返回202。
3. relay：按planned_task_id调用现有durable.enqueue；首次outbox保存完整enqueue参数，包括workflow/version/input/maxAttempts和availableAt。重放逐项复用，不能用新的当前时间代替availableAt；现有store会比较这些字段。原task已存在且参数相同才写bound_durable_task_id并确认投递，任一不同为冲突；enqueue成功但绑定回执丢失按同任务重放恢复。task存在前不调用预算allocate，父workflow取得绑定前先幂等核对/补绑定。
4. generation 父 workflow 首个幂等步骤 allocate 预算，保存原父 task 的 held 回执。已确认PROJECT_BUDGET_LIMIT在replayable回调内转为结构化unavailable，不让普通不足触发tracked step抛错并耗尽失败次数；持久化budgetRound，进入budget.retry.N gate。补预算后宿主通过signal outbox唤醒，下一轮用budget.N+1新step key及原稳定allocationId尝试，不能反复读取已缓存unavailable。未知存储错误仍按真实失败处理；任一成功held回执之前不能执行external。授权过期时可保留等待并按真实“未发出”证据处理资源预留，不伪造结算。
5. staging、submit 分别是 external 操作；调用前保存稳定 operation 与原 step key。当前 runtime 对 external 抛错进入 unknown，已知not_sent/rejected应作为结构化结果返回，由固定策略分支处理；未知提交保留 reconciling。not_sent若允许重试，在持久化决策中增加submissionAttempt并固定下一次dueAt；步骤使用submit.1/submit.2等不同稳定key，按顺序回放此前已完成步骤，再进入新attempt，不能重新运行已缓存的submit.1却期待它再次调用远端。请求摘要与供应商operationId不变，executionNonce/permit是新尝试的；默认最多3次明确未发送尝试，策略随任务冻结，unknown不推进attempt。现有Comfy.submit把CallContext.idempotencyKey写入client_id，因此adapter必须使用已保存的operation级providerClientId构造CallContext，不能把变化后的durable step key透传；恢复watch始终用原clientId。
6. 接收远端ID后父 workflow 在 `remote.final` gate等待；它不把数分钟/数小时生成包装成一次长期外部HTTP步骤。独立 observer 工作流执行一次有界查询，保存证据，再由接入 outbox 安排下一观察。
7. 归档、候选提交使用独立稳定ID恢复；通过 CandidateApplication 幂等提交，成功后设置candidate_ready。终态/费用证据与signal outbox在同一接入事务提交，授权宿主按固定signalId/value向父remote.final/cost.confirmed gate发送；Bridge不能直接signal durable。gate尚未打开返回GATE_NOT_WAITING时保留outbox并重投，不能把信号丢弃或当任务完成。父任务取消/最终失败后只保留证据、停止唤醒并走对账；已消费相同signal的重放核验原回执，不能创建新signal覆盖旧值。
8. 费用/资源用量确定后，父 workflow 完成最终日志并进入durable终态；结算宿主核实原父task终态、所有external未知已解决、实际量证据齐全后按既有预算协议settle。实际账单未知保留held，即使素材候选已可用。

父 workflow 可以先结束生成等待，再等待独立 `cost.confirmed` gate；关键是预算回执始终属于原父task。观察/传输子任务不能凭自身 succeeded 结算父预算。用户取消父任务后，对账任务继续查原operation；durable已cancelled也必须先解决unknown、取得实际量，才能结算原预留。

### 5.2 有界观察

每个观察任务采用 `(operationId, observationRound)` 固定身份；一次执行最多一个有限 HTTP 查询窗口和可选短 WS 监听，默认不超过20秒，网络超时单独限制。观察产生下一round outbox与状态更新同一接入事务；重复投递同round幂等。下一轮availableAt和任何sleepUntil的dueAt首次决定后持久化，重放复用原时间；不能每次执行new Date再生成不同步骤fingerprint或TASK_CONFLICT。

首次查询可立即执行，后续默认2秒逐步退避到15秒；上限及抖动由连接档案配置。达到观察业务期限转needs_review，不重新生成。pending结果不能在同一固定 replayable step 内无限重复读取缓存；新round产生新任务/step身份。父workflow的gate等待释放执行租约；多个镜头并发拆成多个父任务，遵守durable单workflow步骤顺序执行约束。

## 6. HTTP API v1

### 6.1 公共约定

下文 `P=/api/v1/projects/:projectId`。人类连接/配对管理全部使用项目路径，适配当前项目权限guard；无租户全局admin推断。连接可被多个项目授权复用时，需要后续明确共享授权，不通过自报projectId扩大权限。

连接provider固定为`comfyui|beeftv`，executionLocation固定为`local|lan|cloud`；实际执行宿主另以`hostKind=server|device`区分。服务端直连worker也调用同一授权应用服务，在external之前验证预算/批准/取消/connection revision及durable fence；只省去设备握手与网络permit传送，不绕过授权规则。

JSON采用严格schema。时间是UTC RFC3339；大小、新增CAS版本、fence、sequence通过十进制字符串编码，IR版本继续用原schema整数；密码/原件字节不进入响应日志。写请求要求 `Idempotency-Key`，读取/心跳/已有receipt重传有其独立幂等身份。成功信封为 `{"data":{...},"requestId":"..."}`；错误保持当前安全策略 `{"code":"...","requestId":"..."}`，不回显供应商body、凭据或内部堆栈。可在授权操作详情里读取脱敏诊断和 evidenceRef。

普通JSON请求保持16 KiB上限，单个内联文本最多4 KiB；超出时用已经授权上传并封存的`contentRef={objectId,sha256,bytes,contentType}`代替该槽位内联内容。生成parameters与parametersContentRef二选一；大同步resolutionSet可使用resolutionSetRef。workflow、长提示词、同步大快照和素材通过§8的受控二进制/内容上传流程承载，JSON与contentRef二选一。contentRef只能指同项目、当前主体可读且已封存的内容；不能传任意URL。durable每步只存ID/摘要/状态/有限证据，目标上限64 KiB并受已有1 MiB硬上限保护；不因接入放大通用JSON边界。

201创建、202接受长任务、200读取/幂等原响应、204无任务/注销成功；同键重放保留原业务结果，可增加 `Idempotent-Replay: true`。401无有效身份，403权限拒绝，404不可见对象，409版本/摘要冲突，413超限，422语义不支持，429限流，503暂不可用。202不表示远端已收到。

### 6.2 连接与人类设备管理

| 路由 | 请求字段 | 成功结果 | 授权 |
|---|---|---|---|
| `POST P/integration-connections` | provider、executionLocation、deviceId可空、endpointRef、credentialRef可空、label | connectionId、configRevision、enabled=false | 项目admin；端点由受信登记流程创建 |
| `PATCH P/integration-connections/:id` | expectedRevision、允许配置patch | 新revision；有在途操作时旧config保留 | 项目admin |
| `POST P/integration-connections/:id/probe` | expectedRevision、modePins数组（可空） | reachable、ready、capabilityDigest、缺项code数组、observedAt | 项目admin；有界只读，不出图 |
| `POST P/local-device-pairings` | label、allowedActions | pairingId、单次邀请码、expiresAt | 项目admin；邀请码只显示一次 |
| `GET P/local-device-pairings/:id` | 无 | 设备申请摘要、状态、校验短码 | 项目admin |
| `POST P/local-device-pairings/:id/approve` | expectedRevision、deviceFingerprint | approved、兑换期限 | 项目admin；核对本机显示的同一校验短码 |
| `POST P/local-devices/:id/revoke` | expectedGrantRevision、reasonCode | 本项目grant撤销状态、deviceTokenRevoked标志 | 项目admin只撤本项目grant；不能影响其他项目 |

allowedActions为固定能力枚举，例如 `comfy.submit/comfy.observe/beeftv.workspace.write/artifact.transfer`，不能填工具名或shell。可用的项目权限复用 `task:run/candidate:write/candidate:review/project:read`；连接管理新增显式 `integration:manage`，只授予项目admin。系统安装/凭据登记仍是受信运维入口。

若事务确认设备已无任何有效项目grant，可同时吊销其token；仍有其他项目grant时只禁止被撤项目的领取/授权/回执。整个租户设备token的紧急吊销属于受信运维入口，不把某个项目admin扩成租户管理员。

### 6.3 生成 API

| 路由 | 请求 | 返回 |
|---|---|---|
| `POST P/generations/prepare` | connectionId、sourceRevisionRefs、modePin、parameters、seed、inputAssets、outputIntent | preparationId、requestDigest、expiresAt、costEstimate、requiredApprovals、capabilityDigest |
| `POST P/generations/submit` | preparationId、expectedRequestDigest、approvalId可空 | generationId、operationId、state=waiting、statusUrl；202 |
| `GET P/generations/:id` | 无 | 业务状态、取消/费用维度、进度证据、候选/产物、动作能力 |
| `POST P/generations/:id/cancel-request` | expectedVersion、reasonCode | cancelRequestId、cancelState=requested；202 |
| `POST P/generations/:id/resume` | expectedVersion、wakeReason=budget_available或authorization_updated | 宿主重新核实真实预算/授权状态后写固定gate signal outbox；202；不能由客户端直接注入gate值 |
| `POST P/generations/:id/reconcile` | expectedVersion、resolutionKind、evidenceRefs；人工动作需reasonCode | reconciliationId；202；不能用approved:true断言远端没执行 |
| `POST P/generations/:id/retry` | 原明确终态或人工风险确认、newPreparationId、expectedOriginalVersion | 新generation/operation ID及原尝试引用；202 |

生成准备请求示例（ID为示意占位符；实际分别通过§2.1对应校验）：

```json
{
  "connectionId": "<connectionId>",
  "sourceRevisionRefs": [{"objectId": "<segmentId>", "version": 3}],
  "modePin": {"id": "local-image", "version": "1.0.0", "digest": "<sha256>"},
  "parameters": {"width": 1024, "height": 1024, "prompt": "<项目内容>"},
  "seed": "174001",
  "inputAssets": [{"slot": "reference.0", "assetId": "<assetId>", "version": 2, "sha256": "<sha256>"}],
  "outputIntent": {"kind": "image", "count": 1, "targetSegmentId": "<segmentId>"}
}
```

modePin由现有注册表解析，以上封装不改变其实际版本/摘要规则；参数由具体模式严格校验，不是任意JSON透传供应商。prepared快照保存编译后的参数，submit不能额外覆盖prompt、seed或连接。

### 6.4 同步与候选 API

| 路由 | 请求 | 返回 |
|---|---|---|
| `POST P/workspace-sync/preview` | connectionId、canvasId可空、direction=push/pull、scopeObjectIds、expectedCameryRevision、bindingBaselineId可空 | previewId、planDigest、source/base/externalRevision、changes、conflicts、unsupported、expiresAt |
| `POST P/workspace-sync/previews/:id/resolve` | expectedPlanDigest、resolutionSet（只允许已展示冲突项的显式选择，或resolutionSetRef） | 新previewId/planDigest与冻结计划；原preview不可变，未执行外部写入 |
| `POST P/workspace-sync/apply` | previewId、expectedPlanDigest | syncRunId、statusUrl；202；只执行已冻结且无未解决冲突的计划 |
| `POST P/workspace-sync/pull` | previewId、expectedPlanDigest | syncRunId；只生成候选，不执行adopt |
| `GET P/workspace-sync/:id` | 无 | 步骤结果、当前revision、冲突、candidateId、重试能力 |
| `POST P/workspace-sync/:id/resume` | expectedVersion | 继续未完成步骤；新revision冲突需要新preview |
| `GET P/events?after=:cursor` | 不透明cursor | 授权SSE投影；过期cursor明确要求快照刷新 |

同步数量上限默认每preview 200个对象、每外部批次按provider能力限制；超过时分页/分批保留同一根快照，不能截断后宣称全量完成。preview对Bridge上的读取可以返回202并由同一GET取得结果；只有本地有界读取可直接200，UI兼容两种明确状态。

## 7. Bridge 协议与提交授权

### 7.1 配对与协议握手

Bridge配置只有Camery固定HTTPS地址、允许的本机端点/可执行文件/目录；首次配对不自动扫描网络或导入浏览器会话。

1. 管理员创建项目邀请码，有效期10分钟；服务器只存其哈希。Bridge向 `POST /api/v1/local-devices/pairing-requests` 提交邀请码、clientNonce、设备显示信息、protocolRange、adapter摘要。
2. 服务器返回requestId和待核对短码；管理员从项目页批准与本机显示一致的请求。邀请码不直接授予执行权限。
3. Bridge以原clientNonce证明同一申请后，向 `POST /api/v1/local-devices/pairing-requests/:id/redeem` 兑换随机256-bit opaque device token。token只显示一次，服务器保存哈希，Bridge放OS保护存储/受限secret文件；响应丢失则撤销该未确认凭据并重新配对，不向无验证的请求重显token。
4. 后续Authorization Bearer为设备token，由独立guard解析tenant/device/grants。协议握手 `POST /api/v1/local-devices/:id/hello` 包含bridgeVersion、protocolMajor=1、minor、capabilities和bootId；不兼容返回`PROTOCOL_UNSUPPORTED`，不会降级为任意工具执行。

设备token默认30天有效、可撤销；轮换通过已认证且未过期设备请求，先验证新token已落盘再撤销旧token，短暂双token窗口仅用于恢复且有期限。过期需要重新配对；共享账号密码不进入Bridge协议。

### 7.2 Claim、授权与回执

| 路由 | 请求/输出 | 约束 |
|---|---|---|
| `POST /api/v1/local-devices/:id/claim` | claimRequestId、bootId、capacity、supportedKinds；返回204或一个DispatchEnvelope | 同claimRequestId重放返回原派发，不领取第二个任务；MVP capacity=1 |
| `POST .../:id/heartbeat` | bootId、dispatchId、fence、lastReceiptSequence | 返回serverTime、leaseUntil、stopNewEffects、cancelRequests；设备时间不决定租约 |
| `POST .../:id/dispatches/:dispatchId/authorize` | operationId、requestDigest、fence、bootId、executionNonce | 返回短期单次permitId、permitToken、expiresAt、批准摘要；仅资格齐全才发 |
| `POST .../:id/dispatches/:dispatchId/consume` | permitToken、executionNonce、requestDigest | 返回executionAuthorizationId、authorizedAt、expiresAt；事务消费并绑定唯一执行实例 |
| `GET .../:id/dispatches/:dispatchId/authorization` | executionNonce（同设备认证） | 只恢复原消费结果/期限；不延长，不创建第二份许可 |
| `POST .../:id/receipts` | ReceiptEnvelope | ACK分类；原receiptId同内容重发返回原ACK，内容不同409 |

服务端authorize再次核验设备/项目授权、operation归属、当前connection revision、模式环境、预算held、批准范围与期限、未取消、固定执行所有者。permit有效期默认30秒，consume只允许原device/bootId/executionNonce/fence/摘要，最长不能超过批准剩余期。新的副作用必须在消费后的有效窗口内开始；过期未发的许可需提交可证明not_sent证据，由服务端决定重新授权同一operation，不能由设备自行延长。

消费permit只代表授权已给出，不证明远端执行。consume响应丢失时仅查询原许可，不调用供应商；查询确认原许可仍有效且本机journal无sent/unknown后才能继续。consume后设备失联视为可能发出，不重派到其他设备。撤销与真正远端调用之间无法跨系统原子化，方案保证下一次在线检查拒绝新动作，已授权短窗口或已发请求按对账处理，不承诺瞬时撤销所有远端副作用。

DispatchEnvelope示例：

```json
{
  "contractVersion": "1.0",
  "dispatchId": "<dispatchId>",
  "operationId": "<operationId>",
  "projectId": "<projectId>",
  "kind": "comfy.submit",
  "connectionId": "<connectionId>",
  "configRevision": "4",
  "requestDigest": "<sha256>",
  "payloadRef": {"objectId": "<objectId>", "sha256": "<sha256>", "bytes": "12290"},
  "fence": "7",
  "leaseUntil": "2026-11-12T02:00:45Z",
  "requiredCapabilityDigest": "<sha256>",
  "allowedOutputSlots": ["image.0"],
  "authorizationRequired": true
}
```

ReceiptEnvelope示例：

```json
{
  "contractVersion": "1.0",
  "receiptId": "<receiptId>",
  "dispatchId": "<dispatchId>",
  "operationId": "<operationId>",
  "executionAuthorizationId": "<authorizationId>",
  "requestDigest": "<sha256>",
  "fence": "7",
  "bootId": "<bootId>",
  "sequence": "12",
  "kind": "submission.accepted",
  "observedAt": "2026-11-12T02:00:20Z",
  "evidence": {"remoteId": "<promptId>", "clientId": "<originalClientId>"}
}
```

ACK为 `{receiptId, disposition: accepted|duplicate|late_evidence|quarantined, operationVersion}`。过期fence但仍有效设备身份的原回执可进入late_evidence，只增加证据；服务端reconciler核验后才能改变业务状态，不能更新原lease或复活取消任务。跨项目、不同摘要、不同连接一律拒绝。已撤销token不能走普通回执接口，管理员重新配对/显式导入日志后按待验证证据处理。

收费审批ID绑定项目、操作类型、节点/素材范围、requestDigest、模型配置revision、货币/金额上限与期限。首次consume执行授权时，先在批准权威自己的事务中将批准绑定该operation和authorization身份；同一身份重放幂等，其他operation不可再用。接入模块核实该回执后，在最终CAS事务中再次检查permit未过期、operation未取消、device及本项目grant有效、config/fence/摘要匹配，才标记permit consumed并回复；两个store不声称共享事务，任一步响应丢失均查原identity并恢复，两个绑定都完成前不回复可执行授权。批准已绑定但最终检查拒绝时保存bound/not_executable回执，禁止执行；不自动释放批准或换身份重发。未发出且需新许可时，必须由批准权威显式重新授权或签发新批准，不能重新消费旧批准到第二个操作。供应商proposal仅是报价证据，不是Camery人类批准。

### 7.3 本机日志与恢复

Bridge每设备只允许一个executor实例持有OS互斥锁。先落盘 `claimed`，下载并核对payload，再落盘 `permit_consumed`、`about_to_send`，fsync成功后调用远端，随后追加回执与结果定位。保存receiptId和准确请求摘要，重传同一记录；追加记录带长度/校验和，恢复时仅丢弃损坏的最后未完成记录，正文损坏则隔离并人工处理。

重启后检查点规则：claimed但无permit→请求恢复领取资格；permit_consumed/about_to_send但无结果→unknown并上报，禁止直接重发；有remoteId→恢复observe；有完整文件未ACK→继续传输/回执；已ACK→按保留策略清理本任务暂存。不能用“进程刚启动，没有内存任务”作为可重复提交的证据。

日志只保存引用、摘要、必要远端身份与回执；凭据独立存储。文件配额不足则拒绝新领取，保留原日志。原始workflow/媒体由有界staging保存并绑定任务目录，不能读写任意绝对路径。

## 8. 二进制传输与归档

### 8.1 Camery 侧文件接口

设备/服务端上传协议共用P-ASSET；不要为Comfy和BeefTV分别建文件系统：

| 操作 | 契约 |
|---|---|
| `POST P/uploads` | purpose=`input_content`、`input_media`或`generated_media`、expectedBytes、expectedSha256可空、contentType；generated_media还必须有operationId/outputSlot且核对执行授权；前两类按真实项目身份上传，prepare前无operation；返回uploadId、chunkBytes、maxBytes、expiresAt |
| `PUT P/uploads/:id/chunks/:index` | `application/octet-stream`，Content-Length、分片SHA-256；返回index/hash/acceptedBytes；同index同字节幂等，不同字节409 |
| `GET P/uploads/:id` | 已收分片索引、上限、状态；只允许原主体或项目管理员 |
| `POST P/uploads/:id/complete` | totalBytes、sha256、chunkCount；返回202/verificationId；只封存，不立即ready |
| `GET P/contents/:id` | 已封存input_content返回contentRef与验证状态；工作流上传只用于管理员模式发布校验，不能直接绕过modePin执行 |
| `GET P/artifacts/:id` | artifactState、实测参数、验证错误、candidate关联；不泄露本机路径 |
| `GET P/artifact-reads/:grantId/content` | 单对象、单方法、短期授权；流式返回，Range仅在实现确认支持时开放 |

默认分片8 MiB、每会话并发2、最多10000分片；连接配置可调总文件上限。默认图像上限64 MiB、视频2 GiB作为首轮验收配置，不是平台硬性能力承诺。先验证总额再接收分片，流式超限立即中止；HTTP JSON默认16 KiB继续保持，二进制路径单独配置，不整体提高所有API上限。

输入与输出共用底层上传session实现，但授权分支不可互换：input_content要求项目task:run，input_media要求candidate:write并附素材来源/权利声明；设备token不能伪装人类走无operation输入分支。input_media验证发布后返回artifactId与导入candidateId，经P-APP正式采用后得到可用于prepare的assetId/version；或直接使用项目已有ready素材版本。不能为方便参考图把上传自动变成正式采用。generated_media只允许原操作的已声明槽位和执行主体。

prepare前的内容路径为input_content上传/封存→GET取得contentRef→prepare解析；不存在先创建生成operation才能上传参数的循环。输入session默认24小时过期；封存但尚未被准备单/候选引用的输入默认7天后可回收，均可按安装配置延长。已被有效准备单、在途任务、候选或已采用内容引用的对象不得按暂存TTL删除；回收按项目引用与保留策略验证，无跨项目按哈希直接删除。

SDK不接受供应商返回的任意URL作为download目标。文件定位由固定连接+provider输出描述转换，并复用网络策略；云S3预签名仅为已验证对象颁发，具体URL不纳入业务摘要。原件不能以base64放进MCP JSON、durable日志或数据库事件。

### 8.2 状态与一致性

`created → uploading → sealed → verifying → published`，失败进入quarantined/failed，过期未提交会话进入expired。complete之后禁止再改分片；服务端重新计算整体hash；input_content按声明UTF-8/JSON及消费用途schema验证，input_media/generated_media解码/探测，不信设备自报的hash或MIME。输入JSON默认总上限2 MiB、深度/项数有界；大分镜快照由服务端从授权对象生成，不接受上传“正式快照”直接作为权威。文件发布与数据库不可原子时先保证不可变对象落盘，再提交content/artifact_receipt；DB失败留下带请求/operation标签的orphan供恢复，不创建ready候选。

同一operation/outputSlot重复complete读取已有结果；发现不同内容不覆盖，隔离并报警。published只是素材字节可用；生成候选和正式采用仍各自有权限/版本步骤。NAS路径、Windows重解析点、符号链接与读取期间变化按存储契约检查，存储位置不透传为IR外部绝对路径。

输入传输是相反方向：Camery生成受限read grant→Bridge/worker核对hash→provider staging。BeefTV上传的创建会话/分片/complete、素材注册字段必须来自L0记录；供应商失败从自己已经完成的子步骤恢复，不重复整个生成。

## 9. 同步基线与候选契约

`SyncPreview` 固定方向、scope、sourceSnapshot、bindingBaseline、externalRevision、映射schemaVersion、每字段B/C/E摘要及unsupported列表。Camery读取内容必须是已授权快照；不能把最新head更新为“已同步”来掩盖在途变更。

| 比较结果 | 默认行为 |
|---|---|
| C=B且E=B | no-op；保持现有映射 |
| C≠B且E=B | push patch可执行；执行前检查外部revision |
| C=B且E≠B | pull候选；不得自动adopt |
| C≠B且E≠B且C=E | 视为内容已对齐；校验身份后仅更新同步基线 |
| C≠B且E≠B且C≠E | 同字段冲突；禁止后台覆盖 |
| 身份缺失/删除/锁定字段变化/媒体绑定改变 | 显式冲突或解绑候选；不级联删除 |

字段无关更改可形成合并建议，但执行计划必须重新冻结摘要。push每步保存返回revision，下一步用该revision；中断恢复先确认最后receipt，不以整图commit覆盖。未知创建结果且无可验证receipt时停needs_review，不能按标题猜唯一对象。

BeefTV写后回执丢失的自动重放，必须由E-BEEF证明“同一operationId/同一内容先读取原幂等回执，再处理已过期expectedRevision”。如果供应商先拒绝revision或无法证明幂等保持期，则只查询原任务/回执或进入人工处理，不能拿原expectedRevision重发并宣称安全；更不能改新revision/新ID重建同一未知副作用。

pull得到的新资产先发布到存储；候选使用预先生成的changeId，以“冻结变更内容+changeId”幂等调用versioning.submit。提交候选成功但映射检查点保存失败，恢复时读取同changeId并核对请求后补检查点，不再生成第二候选。人工adopt再次验证最新base revisions/锁/角色；未采用不推进正式内容基线。

同步基线分为 `lastExported` 与 `lastAcceptedImport`；仅下载或生成候选不更新lastAcceptedImport。用户拒绝候选保留外部差异供后续处理，不把拒绝当已对齐。基线正文可受控blob保存，hash alone不足以做三方字段差异。

L3时间转换使用`mappingVersion=camery-beeftv-timeline-v1`，量化规则固定为精确有理秒乘1000后取最近整数，正中取偶。设非负边界t=n/d、d>0；以BigInt计算N=1000n、q=N div d、r=N mod d：2r<d取q，2r>d取q+1，2r=d取偶数q或q+1。不能先转浮点毫秒；30000/1001帧率保留有理数，不写成29.97近似。

每个绝对边界误差≤0.5ms，导出duration=Q(end)-Q(start)，区间长度误差≤1ms；不累计逐段时长舍入。量化后零/负duration拒绝；目标软件要求整帧时另外验证帧边界，毫秒误差合格不等于整帧合法。不支持的变速/重叠/音频策略拒绝或输出明确预览降级报告。映射保存原精确边界、导出边界及误差；回流只恢复未修改片段的原基线，其余产生新候选。

## 10. 错误、重试与诊断矩阵

| code | HTTP/业务表现 | 是否自动重试 | 恢复动作 |
|---|---|---|---|
| `UNAUTHENTICATED` / `DEVICE_REVOKED` | 401；停止新效果 | 否 | 重新认证/管理员配对；旧证据人工导入 |
| `FORBIDDEN` / `SCOPE_MISMATCH` | 403或不可见对象404 | 否 | 修正授权，不更换身份绕过 |
| `IDEMPOTENCY_CONFLICT` | 409 | 否 | 同键不同内容；创建明确新业务请求 |
| `REVISION_CONFLICT` / `BASE_CONFLICT` | 409 | 否 | 重读、重新preview、新operation；原未知先对账 |
| `PROTOCOL_UNSUPPORTED` / `CAPABILITY_MISMATCH` | 422 | 否 | 兼容性档案升级并重验，不静默换模式 |
| `BUDGET_UNAVAILABLE` / `APPROVAL_REQUIRED` / `APPROVAL_EXPIRED` | 准备/任务等待或403/409 | 否 | 补足预算/有效批准，重新检查冻结摘要 |
| `NOT_SENT` | 明确未发出的结构化步骤结果 | 有界 | 校验授权仍有效后重试同一operation；必须有未发送证据 |
| `PROVIDER_REJECTED` / `DEPENDENCY_MISSING` | 明确拒绝；安全错误码 | 否 | 修正模式/环境，必要时新准备版本 |
| `SUBMISSION_UNKNOWN` | reconciling，不是普通HTTP重试 | 否 | 查询原remoteId/providerOperationId；不重提 |
| `OBSERVATION_UNAVAILABLE` | 暂时不能查询 | 是 | 新观察round退避；超期needs_review |
| `DEVICE_OFFLINE` / `LEASE_EXPIRED` | 设备离线/接管对账 | 仅查询 | 同operation不迁移设备重发 |
| `CANCEL_UNSUPPORTED` / `CANCEL_UNKNOWN` | 保留cancel requested与真实运行状态 | 仅查询 | 能力门控；禁止全局中断共享节点 |
| `UPLOAD_CONFLICT` / `HASH_MISMATCH` / `MEDIA_INVALID` | 409/422或quarantined | 不重生成 | 重传经确认的坏分片/下载；原件证据保留 |
| `STORAGE_FULL` | 507或任务等待；停止新领取 | 空间恢复后 | 清理本任务已确认无引用临时对象，不删用户原件 |
| `RATE_LIMITED` / `SERVICE_UNAVAILABLE` | 429/503 | 读可重试；写先判outcome | 遵循Retry-After；已发写不得直接重放 |
| `CURSOR_EXPIRED` | 409 | 重建订阅 | 取新快照再使用新cursor |

诊断对象只返回code、operationId、可公开阶段、outcome、retryClass、evidenceRef和requestId；底层错误脱敏后落受限日志。不要向用户隐藏“未知”并翻译成失败，也不要因provider HTTP 5xx就断言没有生成。

## 11. 契约验收与兼容证据

`contractVersion=1.0` 表示Camery协议；providerVersion/toolSchemaDigest/environmentDigest另记录。major变化拒绝混用；minor只允许兼容新增可选字段，严格schema按协商版本解码，不能一边严格拒绝未知字段一边宣称任意minor都兼容。在途操作固定当时协议与adapter pin。

实施测试至少具备以下固定用例身份，执行清单可直接引用：

| 用例ID | 必须证明 |
|---|---|
| `IC-IDEMPOTENCY` | 同键同body重放、同键异body409、不同HTTP key不能重复同prepared提交 |
| `IC-DIGEST` | canonical向量、UTF-8/数组/数字/空值、无隐式归一化，跨进程摘要一致 |
| `IC-SCOPE` | 跨项目/设备/连接/素材拒绝，Bridge bundle无PG |
| `IC-DISPATCH` | claim重放、permit过期/重复消费/不同nonce/fence拒绝、消费丢回执只恢复原许可 |
| `IC-UNKNOWN` | 提交前、供应商已接受、保存remoteId前各崩溃；不重复发单 |
| `IC-OBSERVER` | 父gate释放租约，observer每轮新查询，服务重启续查原remoteId，不耗尽固定step上限 |
| `IC-BUDGET` | task先于allocate、held不被观察子任务结算、原任务终态且无unknown再确认实际量 |
| `IC-CANCEL-LATE` | 本地取消不假远端终止，旧fence晚回执仅证据，已撤销凭据无普通写权限 |
| `IC-TRANSFER` | 64 MiB以上样本流传输、分片重复/冲突、断点、磁盘满、hash/probe失败不ready |
| `IC-SYNC` | 三方全部分支、同字段冲突、操作未知、失败后续步、不覆盖手改、不重复候选 |
| `IC-TIME` | 绝对边界量化、非相邻复用、变速/重叠不支持报告、未改片段还原精确基线 |
| `IC-UPGRADE` | 不兼容major拒绝、旧pin恢复、功能关闭后只查在途、迁移重入/校验冲突 |

L0真实兼容性档案（E-COMFY/E-BEEF）必须给出：Comfy具体版本/commit、API workflow与模型清单、BeefTV具体版本/独立启动或连接方式、认证作用域、完整工具schema与upload字段、真实请求/响应脱敏样例、幂等保持期及幂等读取先于revision拒绝的行为、文件链路及能力限制。缺少证据的功能保持disabled；合成测试成功只能证明Camery契约行为，不替代实机结果。部署证据另归E-DEPLOY。
