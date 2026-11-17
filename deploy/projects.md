# 共享项目与原创开发正式采用

本入口把已审阅的原创开发成果准备为完整 IR ChangeSet，再由有权限的用户明确采用或拒绝。默认关闭；没有文本模型也能审阅、准备和采用既存的完整成果。项目 runtime 只装配数据库存储，不创建 ModelSession、供应方连接、生成任务、预算或常驻 worker。本说明是安装步骤，不代表当前用户宿主已经启用或通过编辑器验收。

## 显式安装与注册

先备份数据库。以下工作由独立安装身份执行，不能给 API 的认证身份、共享只读身份或采用身份管理员能力。

1. 显式执行 `migrateVersioning`、`migrateDevelopment`，再执行 `migrateProjectIdentities`。保留并校验已有迁移 checksum；开发来源需要 run origins 与局部 IR 身份迁移，共享项目需要身份绑定、intent/receipt 及当前 catalog 索引迁移。安装函数仅在受信安装程序中调用，API 启动不迁移。
2. 受信导入/初始化程序用 `PostgresVersionStore.initialize` 安装实际存在、已核验的版本项目及初始快照，或显式升级既有项目。普通 project key 与版本项目 ULID 分离。不能为 GET 查询、缺失绑定或一次页面刷新自动造空项目、快照或未来 Scene/Shot/Media。
3. 用 `ProjectIdentityRegistrar` 显式注册 tenant、project、principal。注册者提供规范 ULID，project 指向既存版本域二元 key；principal 区分 `user`、`agent_run`、`system`。同语义重试幂等，冲突不能重绑或创建别名。绑定仅解析身份，实际权限仍来自已有会话、项目成员关系和宿主授权。准备来源审核者等需要的真实 principal 绑定也必须先安装。
4. 在同一数据库创建两个不同的专用 LOGIN，例如 `camery_project_reader` 与 `camery_project_adopter`。都使用 `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`，没有其他角色成员关系、对象/schema 所有权、数据库 CREATE、schema CREATE 或转授权能力。只读角色由 `grantProjectIdentityReaderRole(installerPool, readerName)` 安装，采用角色由 `grantProjectAdoptionRole(installerPool, adopterName)` 安装。安装帮助函数只追加所列授权；若角色已存在额外授权，须由安装者审计并显式撤销。
5. 使用两个 LOGIN 的真实独立连接分别执行 `verifyProjectIdentityReaderRole(readerPool)` 与 `verifyProjectAdoptionRole(adoptionPool)`。验证检查有效权限，包括 PUBLIC、成员关系、列授权、所有权、序列与 grant option；不能以 `SET ROLE` 的管理员连接代替实际 LOGIN。数据库如存在向 PUBLIC 暴露的业务表或 CREATE 权限，应由管理员按既有部署政策处理，再重新验证，不能让 runtime 自动改公共授权。

安装函数位置：`packages/server/src/projects/{migrate,identity-map,identity-role,adoption-role}.ts`；来源迁移来自 `@camery/script/node`，版本迁移来自 `@camery/versioning/node`。这些是安装 API，不是公开 HTTP 接口。

## 权限边界

只读 LOGIN 仅获得 `camery_projects.tenants/projects/principals` SELECT 与该 schema USAGE。采用 LOGIN 的精确权限如下，schema 仅 USAGE：

| 对象 | 权限 |
| --- | --- |
| `camery_script.briefs/runs/candidates/reviews/run_origins` | SELECT |
| `camery_script.ir_identities` | SELECT、INSERT |
| `camery_projects.candidate_intents/candidate_receipts/decision_intents/decision_receipts` | SELECT、INSERT |
| `camery_versioning.projects` | SELECT、UPDATE(`head_revision`,`write_version`) |
| `camery_versioning.snapshots/object_revisions/adoptions` | SELECT、INSERT |
| `camery_versioning.changes` | SELECT、INSERT、UPDATE(`status`,`record`) |
| changes 与 object_revisions 的实际 identity sequence | USAGE |

序列由 `pg_get_serial_sequence` 从实际迁移结果解析，不假设名称或授予全 schema 序列权限。采用 LOGIN 不需要共享三张绑定表的访问权，外键 trigger 可在没有 REFERENCES 授权的情况下核对已有绑定。它不能初始化版本项目、改源记录、重写 intent/receipt、迁移或访问认证/预算/tasks。来源锁、版本写入与回执必须共用采用连接的同一事务；不得另开只读池持锁代替原子采用。

## 启用配置

```dotenv
CAMERY_PROJECTS_ENABLED=1
CAMERY_TENANT_ID=your-ordinary-tenant
CAMERY_PROJECTS_READER_DATABASE_URL_FILE=/run/secrets/project-reader-url
CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE=/run/secrets/project-adopter-url
```

两个 secret 为不同的受保护普通 UTF-8 文件，每个实际读取最多 8192 字节，允许结尾一个 LF/CRLF。内容分别是两个专用 LOGIN 的 PostgreSQL URL，用户名与密码按 URL 编码；两个 URL 必须显式指定不同用户名，且指向同一 host、port 和 database。遵循[容器 secret 权限说明](./README.md)，不要把 URL、密码放入 HTTP body、源码、日志或构建参数；直接 `CAMERY_PROJECTS_READER_DATABASE_URL` / `CAMERY_PROJECTS_ADOPTION_DATABASE_URL` 环境变量会被拒绝。容器部署需把两个文件挂载为只读并显式传入以上变量；现有 Compose 不会仅因创建文件而自动启用本入口。

`CAMERY_PROJECTS_ENABLED` 省略或设 `0` 为关闭，仅接受 `0`/`1`。关闭时也需移除两个文件配置，避免误以为入口已装配。只读与采用各自最多 4 个连接，连接等待 5 秒、查询和 statement timeout 15 秒。API 启动先检查两个真实角色，再公开应用能力；权限不符或部分启动失败会关闭已有连接池并返回不含凭据的错误。已有 development 文本配置、模型凭据和任务 worker 都不是启用此入口的前提。

## 核验与回滚

安装后以真实用户会话验证：读取项目及既存绑定不会写入；缺失绑定明确返回缺失；来源变更、对象锁、CAS 冲突、权限撤销能阻止新写入；相同 application/request ID 重试恢复不可变 intent 和原回执，不能分配第二套对象或重复采用。独立 LOGIN 的集成测试包含真实新来源、局部身份、正式 submit、guarded adopt、两类回执及额外 ACL 的拒绝探针，需在专用测试数据库串行运行。协议夹具结果不等同真实文本质量、编辑器验收或法务/设计伙伴签核。

回滚先关闭该入口、移除两个 secret 文件配置并重启 API，保留追加身份、intent、回执和版本历史。需要撤销运行凭据时由安装者处理，不能删记录伪装回退。包含新版 IR 集合或升级项目的数据库不能交给仅识别 v0.5 的旧镜像读取；保留兼容版本及备份。其他工作台投影、补偿、媒体字节及阶段 1 后续门槛仍按完整计划推进。
