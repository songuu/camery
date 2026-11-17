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
