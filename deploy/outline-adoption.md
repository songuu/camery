# 正式大纲采用与完整读取

本宿主把已审阅的大纲接入正式版本域，并提供六类规划对象的完整只读接口。默认关闭。启用不依赖文本模型或生成 worker；现有 Outline 页面仍等待页面组合验收，`formalAdoption` 保持关闭。

## 安装与配置

由独立安装身份先完成 [Projects 安装与身份注册](./projects.md) 和 [Outline 来源安装](./outline.md)，再调用 `migrateOutlineIdentities`、`migrateOutlineProjectIntents`。安装函数来自 `@camery/script/outline/node` 与 `packages/server/src/projects/outline-intent-migrate.ts`；保留迁移账本及原 checksum。正式项目必须已经存在，且采用新版六类规划对象前显式升级到 `0.7.0-draft`；GET 不会创建或升级项目。

另建独立 LOGIN，使用 `grantOutlineProjectAdoptionRole` 显式安装，再用该 LOGIN 的真实连接执行 `verifyOutlineProjectAdoptionRole`。这两个函数位于 `packages/server/src/projects/outline-adoption-role.ts`。角色只读来源及注册表，只追加身份/proof、意图/回执和原生版本记录，并精确更新版本头及候选状态；不能修改来源、人审、Access 或创建项目。不要复用已有 Projects adopter、Outline 来源角色或管理员。

在已有 Projects 与 Outline 配置之外追加：

```dotenv
CAMERY_OUTLINE_ADOPTION_ENABLED=1
CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE=/run/secrets/outline-project-adopter-url
```

tenant 沿用 `CAMERY_TENANT_ID`，reader 沿用 Projects reader。新 secret 是受保护的普通 UTF-8 文件，实际最多读取 8192 字节，允许一个结尾 LF/CRLF。URL 必须指向同一数据库，用户名与 reader、原 Projects adopter、Outline 来源 LOGIN 均不同。URL query 不允许覆盖 host/user/database 等连接身份；仅接受明确的 TLS、application_name、connect_timeout 选项。直接 `CAMERY_OUTLINE_ADOPTION_DATABASE_URL` 会被拒绝。

省略开关或设 `0` 时也必须移除 secret 配置。启用只验证已有角色，不迁移、GRANT 或调用模型。两个自有连接池各最多 4 个连接，连接等待 5 秒、查询与 statement timeout 15 秒；启动失败及退出关闭全部自有池。现有 Compose 需显式挂载只读 secret 并传入变量后才会启用。

## 只读接口

所有路径以 `/api/v1/projects/:projectId/formal-outline` 开始，并要求当前用户的 `project:read`：

| GET 路径 | 返回 |
| --- | --- |
| 根路径 | 六类对象的引用、所属 plan 与计数 |
| `/rows` | 最多 50 条完整 typed records；单行过大时返回 sectioned overview |
| `/:collection/:objectId` | 全部非分节字段与每节计数，包括空数组 |
| `/:collection/:objectId/sections?section=…` | 预定义的 22 种 typed 数组节，完整项分页 |

列表与 rows 支持 `collection`、`planId`、`revision`、`cursor`、`limit`；对象支持 `revision`；分节另支持 `section`、`cursor`、`limit`。section 名称由 `@camery/ir/outline-formal` 定义，不接受任意 JSON 路径。每份完整 HTTP 响应不超过 983040 字节；超大行必须读取 overview 中列出的所有 sections 才算完整。

首次省略 revision 选择当前快照，后续游标固定所选不可变 revision。新 head 不会替换尚未读完的快照；响应分别标明 snapshotRevision 和当前 headRevision/writeVersion。每页重新授权，游标不能跨用户、项目、筛选或节复用。读取快照的内部捕获预算为 64 MiB，每个大纲图仍受独立的 16 MiB 校验限制。旧 schema 显式要求升级，损坏数据安全失败，不截断内容伪装完整。

关闭入口并移除 secret 配置后重启即可停用，保留所有身份、意图、回执与版本历史。角色撤权由安装者执行。协议及数据库测试不代替编辑器验收、法务或设计伙伴确认。
