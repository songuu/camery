# 共享项目身份边界

该目录是 VCA-002 / LIN-006 和原创开发正式采用共用的身份绑定位置。认证普通 ID 与版本域 ULID 各有自己的作用域；显示名称、slug、runId 不能临时转换成 IR 身份。

## 安装与注册

先由安装者执行版本域迁移和显式项目初始化，再执行 `migrateProjectIdentities`。项目绑定以真实 `camery_versioning.projects(tenant_id,project_id)` 为外键；注册不会创建空 IR，读取也不会补建项目。

`ProjectIdentityRegistrar` 只供受信安装/注册流程使用：先 `registerTenant`，再 `registerProject` 与 `registerPrincipal`。调用者提供已确定的规范 ULID。同一普通身份与相同绑定重复注册幂等，重绑或把第二个普通身份指向同一版本身份会冲突。用户、Agent run 和系统主体按 `kind` 区分；Agent 不能因为普通 key 同名就解析成人类。

这层绑定不授予项目权限。`resolveProjectAuthority` 接收宿主已认证的会话，先检查所需权限再解析映射，并固定真实人类、普通作用域与版本 key。其采用回调始终单独要求 `candidate:review`，编辑者的候选写权限不会变成采用权。每次请求须重新鉴权；采用时仍需版本域范围、对象锁及基版本检查。注册者的数据库连接不能用于 API 运行。

## 只读运行

`PostgresProjectIdentityStore` 提供 `resolveProject`、`resolvePrincipal` 和组合 `resolve`，只查询已存映射。缺少项目/主体分别抛出 `PROJECT_BINDING_MISSING` / `PRINCIPAL_BINDING_MISSING`；不得在缺失时生成新 ID 或回退到另一个租户。

`grantProjectIdentityReaderRole` 是显式安装者操作。独立 reader LOGIN 仅有三张绑定表 SELECT；`verifyProjectIdentityReaderRole` 在运行前验证权限闭包，拒绝写表、列级越权、其他业务表、所有权、角色继承、复制和转授权等能力。此 reader 不代替后续来源/版本采用的独立权限配置。

## 候选意图与事务回执

`PostgresProjectIntents` 追加保存候选和决定意图，以及准备/决定回执。候选意图固定普通作用域、真实映射作者、来源 manifest、局部身份、双版本基线和完整 ChangeSet。同一命令竞争复用首份身份；不同语义冲突。无差异开发结果保存 unchanged 及原基线含义，不创建空 ChangeSet。

采用/拒绝意图先保存实际主体、动作、范围、理由与首次时点。`preparationReceiptWriter` / `decisionReceiptWriter` 只能借用版本服务提供的事务 client；不自建事务或提交。它们核对 VersionStore 的真实执行上下文，包括二元项目 key、原 CAS、请求签名/changeId、实际 actor/scope/at/reason。首次决定必须与实际历史记录一致，历史采用 ACK 保留原采用事实。

决定回执首写后，后续不同结果不得在同一 intent 下提交新的正式决定；冲突会回滚本次版本和回执写入。每次请求仍须先重新鉴权，再读已有回执；存储 JSON、摘要和旧回执均不是新的授权。候选的原准备基线回执与决定回执具有不同语义，不能互换。

## 当前交付边界

本批提供持久映射、完整开发映射的跨库组件组合及共享 intent/receipt 基础，尚未启用新 HTTP、配置开关或自动注册流程。后续共享 CandidateApplication、独立采用 LOGIN 与认证工作台继续消费这些组件；不能另建一套普通项目/主体映射。迁移与运行分离，回滚应用时保留追加绑定和版本历史。
