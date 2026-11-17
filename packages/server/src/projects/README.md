# 共享项目身份边界

该目录是 VCA-002 / LIN-006 和原创开发正式采用共用的身份绑定位置。认证普通 ID 与版本域 ULID 各有自己的作用域；显示名称、slug、runId 不能临时转换成 IR 身份。

## 安装与注册

先由安装者执行版本域迁移和显式项目初始化，再执行 `migrateProjectIdentities`。项目绑定以真实 `camery_versioning.projects(tenant_id,project_id)` 为外键；注册不会创建空 IR，读取也不会补建项目。

`ProjectIdentityRegistrar` 只供受信安装/注册流程使用：先 `registerTenant`，再 `registerProject` 与 `registerPrincipal`。调用者提供已确定的规范 ULID。同一普通身份与相同绑定重复注册幂等，重绑或把第二个普通身份指向同一版本身份会冲突。用户、Agent run 和系统主体按 `kind` 区分；Agent 不能因为普通 key 同名就解析成人类。

这层绑定不授予项目权限。`resolveProjectAuthority` 接收宿主已认证的会话，先检查所需权限再解析映射，并固定真实人类、普通作用域与版本 key。其采用回调始终单独要求 `candidate:review`，编辑者的候选写权限不会变成采用权。每次请求须重新鉴权；采用时仍需版本域范围、对象锁及基版本检查。注册者的数据库连接不能用于 API 运行。

## 只读运行

`PostgresProjectIdentityStore` 提供 `resolveProject`、`resolvePrincipal` 和组合 `resolve`，只查询已存映射。缺少项目/主体分别抛出 `PROJECT_BINDING_MISSING` / `PRINCIPAL_BINDING_MISSING`；不得在缺失时生成新 ID 或回退到另一个租户。

`grantProjectIdentityReaderRole` 是显式安装者操作。独立 reader LOGIN 仅有三张绑定表 SELECT；`verifyProjectIdentityReaderRole` 在运行前验证权限闭包，拒绝写表、列级越权、其他业务表、所有权、角色继承、复制和转授权等能力。此 reader 不代替后续来源/版本采用的独立权限配置。

## 当前交付边界

本批提供持久映射及最小只读身份，尚未启用新 HTTP、配置开关或自动注册流程。后续共享 CandidateApplication、原创开发 application intent 与来源局部对象映射继续消费此目录；不能另建一套普通项目/主体映射。迁移与运行分离，回滚应用时保留追加绑定和版本历史。
