# 四账存储、原生采用与前集证明

`@camery/script/continuity/node`提供不可变候选、人改审阅、拒绝、同事务原生采用端口和生产前集解析器。当前没有启用新的主API、页面或生成worker；认证应用的独立操作 intent/失败回执与分页页面继续按[计划](../../docs/plan/continuity-phase1.md)接入。`reviewed`只有在真实原生版本采用、完整账本对象和同事务采用证明全部存在后，才能作为下一集的约束。

## 显式安装与身份

1. 先由既有版本域安装者完成`camery_versioning`迁移并准备正式项目。`migrateContinuity(installerPool)`只安装新`camery_continuity`，不会替你安装旧域、创建项目或升级IR。
2. 由运维创建独立、无继承/管理员能力的LOGIN，显式调用`grantContinuityRuntimeRole(installerPool, roleName)`，然后用该LOGIN的真实连接调用`verifyContinuityRuntimeRole(runtimePool)`。不要复用旧adopter或管理员。
3. 运行时构造`new PostgresContinuityStore(runtimePool)`。构造器不迁移、不授权、不创建身份，也不调用模型。
4. 使用原生四账时，显式执行`migrateContinuityNative(installerPool)`，它在独立`native_migrations`账本安装`native_bindings`与`native_adoptions`，要求既有版本历史与人工审阅表已安装。原 v1 安装器/SQL 保持独立。项目通过既有显式 07→08 原生升级进入 v08，不自动改旧项目。
5. 人审数据 LOGIN 使用`grantContinuityRuntimeRole(installerPool, role, {nativeProofs:true})`及同选项的 verifier；独立原生采用 LOGIN 使用`grantContinuityAdoptionRole`与`verifyContinuityAdoptionRole`。默认旧 profile 不增加新表读写权。

v1 schema 包含`migrations`账本、`candidates`和`reviews`。候选以普通tenant/project/candidateId为主键，固定formal target/source snapshot；外键引用实际`camery_versioning.snapshots`。人审一候选一条最终决定，只追加；不UPDATE原候选或覆盖原始模型/人工事件。source外键有完整三列btree索引，删除父快照受约束；撤服务时保留候选、人审与正式历史。新原生绑定一候选一个固定 change ID，另引用真实 review/native change/source；采用证明还引用真实 native adoption/object revision/from/to snapshot，全部只追加。

首发SQL固定LF，v1 SHA-256为`b9ddff6a212c36ec699fddb7f6306f4da337fff4fb88e8b21d0736c1bfe23e35`。重复安装先验证账本；后续版本应新增迁移，不能重写已发行SQL或checksum。
独立 native-proof v1 SQL SHA-256 为`4a60386f036990b5753e7dedaca1581140d0cf0144e5ce4343c369216a1f500a`，同样固定 LF/checksum。

## 运行权限与锁

专用LOGIN拥有新两表SELECT/INSERT和版本域五表SELECT。它另有`camery_versioning.projects.write_version`这一列的UPDATE权限，供`SELECT ... FOR UPDATE`取得原生版本头行锁；实现不会UPDATE该列。没有head_revision、版本正文/历史写权、序列能力、转授权或角色成员关系。PostgreSQL行锁所需权限见[官方说明](https://www.postgresql.org/docs/16/sql-select.html)。

显式 native 人审 profile 另外只有两份原生证明表的 SELECT。原生采用 LOGIN 对人审两表仅 SELECT，允许追加新 binding/proof 与原生历史、更新`projects.head_revision/write_version`和`changes.status/record`，只授两条真实原生 identity sequence 的 USAGE。它不能改人审、更新/删除证明或转授权。verifier 检查实际 PUBLIC/列权限、角色继承、ownership、额外 sequence/安全定义者函数权限；系统目录函数、关系、类型和运算符均限定为`pg_catalog`，并要求有效搜索路径以`pg_catalog`开始。显式`public,pg_catalog`之类的路径启动验证失败；默认连接路径及`pg_catalog,public`保持可用。安装/授权在自有事务中固定`SET LOCAL search_path=pg_catalog`，结束后不改变连接原配置。

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

首集不需要前集。使用生产 typed 来源时构造`new PostgresContinuityStore(runtimePool,{previousFor:resolveContinuityNativePredecessor})`，非首集由同 client 的真实人审/原生历史证明取得完整 v2 前集；未配置解析器仍失败闭合。v1 legacy 前集封套保持原字节与摘要。v2核对scope/target、相邻集、完整 typed snapshot、object revision、adoption、change、绑定/回执与历史人审完整重编译，不能用任意JSON、摘要、已人审记录或旧source文字替代。

`prepareContinuityNativeMapping`只产生完整性映射，固定 change/snapshot/op ID，仅 add/update 本集一个账本，不自动解锁或改别集。通过`PostgresVersionStore.submitWithReceipt`使用`createContinuityNativeSubmissionReceipt`落请求绑定；候选提交后以返回的最新 writeVersion 构造双版本期望，再将`createContinuityNativeAdoptionHooks`的 guard/receipt交给`adoptGuarded`。actor、episode scope、UTC时间、期望版本须来自同一受信宿主，native authorize仍使用真实项目授权；普通scope和正式target必须来自服务器身份映射。

callback核对实际执行上下文及真正 native request/object/adoption，实际写入后在同一 client 反读完整人审与原生证明；任一步失败全回滚。已采用 ACK 重新授权，只恢复已有采用证明，不能为绕过 guard 的原生写入事后补证明。`readContinuityNativeAdoption`按原采用修订验证历史记录，不声称当前新鲜；`resolveContinuityNativePredecessor`另外检查当前 script/物理 pin 与整条前账链的精确 snapshot ID/version/正文摘要。只改前一集账本也会使后账过期，需重新审阅下游。

证明链按严格递减的原生修订顺次验证，上限100项；使用迭代队列，不递归驻留全部历史剧本上下文。v1 legacy 前账转为 typed 后账时，也核对当前 legacy snapshot 的精确版本/全文摘要；legacy 修订或同集 typed 替代会使旧下游过期。当前源和历史 ACK 分别验证，后续无关对象变化不重写原人审或采用事实。认证应用仍需独立操作 intent、失败结果锁定、目录分页和安全 HTTP 投影，依用户安排后补；下一项优先 T1.6 定稿与四账消费。

历史读取核对整个实际package/context摘要、包ID、修订、列与正文；错误包ID即使重新计算准备记录摘要也被拒绝。摘要证明完整性，不证明真人判断或作品质量。旧IR v05/v06/v07及旧迁移字节保持。

context≤64MiB、单集事件≤512KiB、累计ledger≤2MiB、candidate≤8MiB、每份准备/审阅记录≤16MiB；数据库32MiB的JSONB文本防护包含规范化空格开销，不扩大应用逻辑预算。数量上限不保证所有字段同时达限，超限明确失败，不截断。
新原生 mapping/binding/proof逻辑记录≤8MiB，新增 JSONB 文本防护≤16MiB，保持完整四账与证据，不以截短换取预算通过。
