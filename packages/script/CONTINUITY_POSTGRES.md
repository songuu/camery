# 四账候选与人工审阅存储

`@camery/script/continuity/node`提供不可变候选、人改审阅、拒绝和事务内来源核对。当前没有启用新的主API、页面或生成worker；`reviewed`不等于正式采用，生产typed账本采用/回执和前集解析器继续按[计划](../../docs/plan/continuity-phase1.md)实施。

## 显式安装与身份

1. 先由既有版本域安装者完成`camery_versioning`迁移并准备正式项目。`migrateContinuity(installerPool)`只安装新`camery_continuity`，不会替你安装旧域、创建项目或升级IR。
2. 由运维创建独立、无继承/管理员能力的LOGIN，显式调用`grantContinuityRuntimeRole(installerPool, roleName)`，然后用该LOGIN的真实连接调用`verifyContinuityRuntimeRole(runtimePool)`。不要复用旧adopter或管理员。
3. 运行时构造`new PostgresContinuityStore(runtimePool)`。构造器不迁移、不授权、不创建身份，也不调用模型。

新schema只有`migrations`账本、`candidates`和`reviews`。候选以普通tenant/project/candidateId为主键，固定formal target/source snapshot；外键引用实际`camery_versioning.snapshots`。人审一候选一条最终决定，只追加；不UPDATE原候选或覆盖原始模型/人工事件。source外键有完整三列btree索引，删除父快照受约束；撤服务时保留候选、人审与正式历史。

首发SQL固定LF，v1 SHA-256为`b9ddff6a212c36ec699fddb7f6306f4da337fff4fb88e8b21d0736c1bfe23e35`。重复安装先验证账本；后续版本应新增迁移，不能重写已发行SQL或checksum。

## 运行权限与锁

专用LOGIN拥有新两表SELECT/INSERT和版本域五表SELECT。它另有`camery_versioning.projects.write_version`这一列的UPDATE权限，供`SELECT ... FOR UPDATE`取得原生版本头行锁；实现不会UPDATE该列。没有head_revision、版本正文/历史写权、序列能力、转授权或角色成员关系。PostgreSQL行锁所需权限见[官方说明](https://www.postgresql.org/docs/16/sql-select.html)。

prepare与首次确认始终先锁formal project行，再取candidate advisory锁；原生版本writer也更新同一project行，因此来源不能在本次候选/人审提交前被并发推进。读取使用REPEATABLE READ READ ONLY，不取写锁。内部设置15秒statement timeout、5秒lock timeout，未知提交结果不自动重新分配ID。

## 受信宿主接口

| 接口 | 行为 |
| --- | --- |
| `describeSource(selection, host)` | 读取真实已采用原生包，返回完整context与包/context摘要；不是HTTP响应契约 |
| `prepare(command, host)` | 固定调用者给出的candidateId、source修订/摘要，保存完整原始候选；无变化或问题仍保留原结果，不自动采用 |
| `read(key, host)` | 从实际历史snapshot完整重放候选与审计，另报告当前来源是否仍匹配 |
| `confirm(key, decision, host)` | 在源锁内重新检查来源/前集，完整重算人改事件；error不能豁免，warning必须逐项有理由 |
| `reject(key, decision, host)` | 保存明确拒绝理由；允许来源已过期，拒绝不是可用于下一集的已采用账本 |
| `readForAdoption(client, key, host)` | 在调用者同一事务内锁定并核对已人审来源；不BEGIN、COMMIT、释放client或打开第二事务 |

host是服务器构造的`human`身份、普通项目scope、规范UTC毫秒时间和同步权限函数。每个入口在SQL前重新授权；Promise/thenable不能授权。formal target必须来自服务器可信身份映射，不从HTTP正文透传。命令不能携带自由actor、前集ledger或自报已采用状态。权限函数执行前及数据库await前捕获原命令和审计身份，后续调用者修改不会改变操作。

同candidateId的同一准备或同一人审决定重试，当前仍授权时返回首次完整结果和原actor/time；改变内容或actor发生冲突。确认回执已写入但COMMIT ACK丢失时，沿用原ID重读/重试；不得据未知错误换ID。首次确认拒绝过期来源；历史相同决定仍返回旧审计，不伪装成基于新head的决定。

## 前集与完整性

首集不需要前集。非首集必须由构造器中的可信`previousFor`在同client读取实际已采用typed ledger；没有解析器就失败闭合。实现还核对scope/target、相邻集、实际native snapshot、object revision、adoption和change，以及完整ledger与来源摘要。接口存在不代表生产解析器已交付，不能把任意JSON、摘要、已人审记录或旧source文字当成采用凭证。

历史读取核对整个实际package/context摘要、包ID、修订、列与正文；错误包ID即使重新计算准备记录摘要也被拒绝。摘要证明完整性，不证明真人判断或作品质量。旧IR v05/v06/v07及旧迁移字节保持。

context≤64MiB、单集事件≤512KiB、累计ledger≤2MiB、candidate≤8MiB、每份准备/审阅记录≤16MiB；数据库32MiB的JSONB文本防护包含规范化空格开销，不扩大应用逻辑预算。数量上限不保证所有字段同时达限，超限明确失败，不截断。
