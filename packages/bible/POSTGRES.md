# StoryBible 存储与任务恢复

`@camery/bible/node`提供显式`migrateBible`、`PostgresBibleStore`、`verifyBibleRuntimeRole`、`createBibleChunkWorkflow`和`enqueueNextBibleTask`。当前是供受信应用宿主使用的适配器；没有自动启用新的服务端API、配置凭据或常驻调度。

## 存储及人工审阅

安装者先显式安装既有来源迁移，再执行`migrateBible(installerPool)`。新schema为`camery_bible`，runs/chunks/candidates/reviews只追加，不覆写原文或正式IR；迁移有事务、锁和checksum检查。运行进程不迁移或授予自己权限。源码SQL按仓库gitattributes保持LF，Windows与Linux使用同一checksum。

| API | 持久化边界 |
|---|---|
| `start(command)` | 从同一连接读取实际来源，核对客户端所见revision/digest，保存固定完整快照、分块计划、方法pin和宿主执行配置；同run同语义重试返回原createdAt |
| `read(key)` | 完整重建来源/计划/块/候选/审阅记录，核对作用域及所有摘要，不只相信数据库里的passed/status |
| `saveChunk(key,record)` | 验证引文、方法及run模型身份；同chunk同内容幂等，不同内容冲突；单块、累计原始记录和投影分别有界 |
| `materialize(key)` | 所有块完整后重建并追加候选；缺块不产生完整候选 |
| `isCurrent(key)` | 与来源库当前完整identity比较，旧run仍可读但明确过期 |
| `confirm` / `reject` | 真实人类身份及项目授权由认证宿主提供。确认首写在来源锁→run锁内核对当前来源；拒绝可丢弃过期候选 |

确认/拒绝只有一个首写胜出。同actor、同语义决定重试时再次检查当前宿主授权，再返回原at与摘要；这是读取旧审计，不是重新采用。来源追加后可读取既有确认记录，但不能将其当作新来源的确认。其他身份、不同决定或已撤权的重试不能绕过检查。读取审计时的内部重建回调仅验证存档一致性，不向客户端授予权限。

数据库锁固定为来源`['camery_ingest',tenant,project,document]`在前，run`['camery_bible',tenant,project,run]`在后。持锁时使用`readSourceDocument(client,scope)`，不调用会另连pool的来源store，从而避免自阻塞；只读来源身份不需要`FOR UPDATE`或UPDATE权限。

## 独立运行身份

installer创建专用NOINHERIT LOGIN并安全保存连接秘密。该账号仅需：

```sql
GRANT USAGE ON SCHEMA camery_ingest,camery_bible TO camery_bible_worker;
GRANT SELECT ON camery_ingest.documents,camery_ingest.scripts TO camery_bible_worker;
GRANT SELECT,INSERT ON camery_bible.runs,camery_bible.chunks,
  camery_bible.candidates,camery_bible.reviews TO camery_bible_worker;
```

启动宿主显式执行`verifyBibleRuntimeRole(biblePool)`。核验无super/bypass/createrole/createdb/inherit、无额外角色成员或SET ROLE、无DB CREATE/非system schema CREATE/所有权；表列白名单外权限及非system序列权限均拒绝。迁移表不可读写，不能UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER业务行。不能把该账号与需要来源UPDATE或认证sessions撤销权限的pool混用；认证、durable和预算存储沿用各自受限pool。这里不创建或修改已有账号及全局PUBLIC授权。

## 一块一个真实任务

1. 宿主显式创建项目预算，`start`冻结run的模型profile、币种、每块reservation及run limits。使用BigInt校验所有块的份额总数不超过run限额，每块只分配一个Agent decision的预算，不能把整部额度重复给每块。
2. 宿主调用`enqueueNextBibleTask(store,durable,key)`。它只提交第一个缺少记录的块，任务ID由tenant/project/run/chunk确定、input只有run/chunk/digest引用。重复pump或崩溃后再次调用不会产生另一个付费身份。
3. `createBibleChunkWorkflow`加载固定快照，宿主`sessionFor`只构造受信ModelSession，不进行远程调用。固定方法与角色用同一个纯请求编译器算摘要；原始方法回执不被改写成action封套摘要。
4. `createBudgetedAgentWorkflow`先记预算分配，AgentRuntime只执行并计量一次模型decision。新可信driver显式采用`finish-output`绑定，只能finish；旧driver缺省仍校验原action封套，旧journal口径不变。
5. 模型结果有严格回执后，追加不可变ChunkRecord；保存步骤可重放。任务只返回引用、charged与usageUnknown，不把16百万字符来源或可能2MiB的整份candidate塞入上限1MiB的durable日志。
6. 宿主在任务完成、重启恢复或再次处理用户请求时继续pump。只有前块成功写入record才会提交下一块；全部齐备后候选存在PG，pump返回candidateDigest。常驻服务启动时的run枚举/调度仍待应用层接线，当前没有隐式后台循环。

Agent被阻塞时durable任务也可能是succeeded，必须读`output.state`，不能只看task状态。报价超限或不确定用量保留保守占用；没有record就停在同一task，不会自动跳下一块。项目份额沿用账本的held状态，终态后还需受信宿主显式确认实际用量结算；reservation不是供应商真实账单上限证明。

新实际模型执行前检查当前来源；该检查不跨网络持锁。若来源在进行中的调用之后追加，旧结果仍绑定旧快照并可保存，下一块pump停止stale，确认首写拒绝旧版本。已缓存决策不因为来源变化而丢失：恢复直接保存已付结果，不再调用模型。

## 恢复证据与限制

真实PG专项覆盖：并发创建/块/候选/审阅、只读来源与追加Bible LOGIN、字段级额外权限、旧来源与撤权；模型decision已实际提交journal后强杀自身测试子进程，再以新pool/worker恢复并断言provider调用0；record提交但确认丢失重试幂等；unknown外部任务保持reconciling，只有显式operator对账完整原始回执后继续，仍不重发。全部测试仅清理自己随机租户、角色及canary对象。

协议provider与operator记录均为进程内合成夹具，不调用真实付费服务、不证明真实推理质量、真人已审阅或账单已核实。真实连接、价格、模式pin及应用认证仍由后续宿主配置验收。

当前`isCurrent`会重新读取完整来源和已有run进度，长书存在重复传输/校验开销；已知这是静态查询路径观察，尚无大书吞吐实测。应用优化需保留当前版本核对与存档验证语义，不能用未验证的分页拼装替代固定快照。
