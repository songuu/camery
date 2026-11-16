# @camery/methods · 方法包与评测

T0.8 的可执行基础：版本化方法注册与显式路由、受限包加载、结构化模型候选、独立评分、人工评分表单、章节切分、四类评测断言与回退闸门。[章节方法包](../../method-packs/chapter-segmentation/README.md) 附来源、许可、六个黄金用例及固定基线。

```sh
pnpm --filter @camery/methods typecheck
pnpm --filter @camery/methods test:coverage
pnpm test:methods:evals
```

已接入根 `pnpm check`：测试与四项 ≥95% 覆盖率后，还必须比较黄金基线。方法、Agent、模型模式代码变更都会触发该命令；当前黄金指标只覆盖已实现的章节方法，不冒充尚未接入的 Agent/真实模型质量评测。远端 CI 仍以实际 workflow 为准。

## 注册与执行

`MethodRegistry.register(pack)` 校验 manifest、provenance、instructions、rules、examples、cards、evals 并复制数据；全部运行资产进入 digest。同一 id/version 的不同内容拒绝，升级须注册新版本。`resolve(pin)` 返回冻结副本，`route({stage,inputKind,language}, explicitPins)` 只在显式允许的 pin 中选择；无匹配和多匹配都拒绝，不自动选最新版本。

输出使用明确的 JSON Schema 子集：object/array/string/integer/number/boolean/null、required、additionalProperties:false、items、数量/长度/数值范围及 enum。未知关键字、外部引用和不支持的组合契约在注册时拒绝；不静默忽略。结构验证与递归深 JSON enum 相等检查相交，避免 enum 绕过类型/范围，亦支持对象和数组枚举。字符串长度沿用 JSON Schema 的 Unicode 语义。

`MethodRunner(registry, hostExecutors, {timeoutMs})` 只调受信宿主注册的工具，先捕获 pin、输入和 CallContext；包本身不提供可执行脚本。输出须通过 schema 与确定性规则，返回 `status:'candidate'`，不采用、不修改正式 IR。当前 `chapter.segment` 是本地只读工具，原文中的网络或权限指令不执行。

执行默认总时限 300000ms，可调 1–300000ms。取消/超时会通知工具并观察迟到拒绝；无法强制停止忽略信号的宿主代码。付费工具发起后未知故障保留 unknown，返回后输出校验失败为 completed；不隐藏重试。宿主仍须接入 durable 外部步骤、预算、认证和工具权限；这里的 scope 字段不授予权限。

`chapter.segment` 按独立行显式“第…章/回/集”标题生成完整 UTF-16 半开区间，保留前言、BOM、换行与原文。切片连接必须与原文一致，输出摘要绑定输入；sourceDigest 是原文字符串经 canonical JSON 编码后的 SHA-256，不是媒体文件哈希。无标题保留全文并输出 NO_EXPLICIT_HEADINGS，不猜测隐藏章节。标题只在已声明的中文形式内识别，复杂版式/歧义仍需研究 Agent 或用户确认。

## 结构化生成与评分

`ModelSession(client, config)` 绑定宿主提供的租户、连接、模式摘要和模型身份。必须显式设置 `evidence:'live_model'|'synthetic_replay'`、调用次数与总时限；输入/输出默认各 128KiB，可调至 2MiB。失败尝试也占用次数，相同调用身份不能重发，无自动重试/修复。回执只含绑定摘要、供应商请求身份及 usage；未知 token 数保留 null。次数、字节和时间限制已实现，费用/token 总预算及 durable 外部步骤尚待 T0.9 接入。

`createStructuredGenerationExecutor(session)` 作为宿主工具 `method.generate` 注册给运行器，方法须声明该工具及非 deterministic 的 modelTier。方法正文/规则/卡片组成可信指令，来源及 few-shot 输入放入显式不可信数据封套，不把 eval 答案送给生成模型。输出仍经过 schema/规则校验，只产生候选；模型回执绑定租户、连接、模式、调用身份和输出摘要。live 调用标为付费/网络，合成回放标为只读/离线。

`LlmReviewer(registry, reviewerSession, {reviewerId}).review(subject, rubric, ctx)` 独立评审已有候选，评审模型身份与模式摘要均须不同于生产模型。rubric 给出版本、指标及 1/3/5 分锚点；一次结构化调用必须返回完整且不重复的指标、1–5 分和理由。subject 绑定租户、case、method pin、输入、输出及生产模型。模型身份和 evidence 来自受信宿主配置，不是供应商鉴真或防提示注入的质量保证。

`createHumanReviewForm(registry, subject, rubric)` 只生成冻结表单，不生成评分。宿主保存 formDigest 后，由明确的 `submitHumanReview(form, {reviewerId, scores}, expectedFormDigest)` 提交完整分数与备注；返回 `human_record`。expectedFormDigest 必须来自可信存储，客户端传回的摘要不提供授权。本包未实现审片 UI、认证、表单持久化或真实人工验收。

生成后先保存 `evaluateSuite` 的报告，再用 `updateEvaluationReviews(registry, suite, report, ratings)` 给已有产物补评分；此路径不调用生产模型。可运行示例见 [合成生成与评分集成测试](test/generation-review.integration.test.ts)：使用真实 OpenAI 兼容连接器经进程内协议夹具录制两个调用，再离线精确回放，无网络 fallback；不代表真实模型推理、人工评分或计费。

## 目录加载

`@camery/methods/node` 的 `loadMethodPack(directory)` 读取受信宿主选择的目录。pack.yaml 使用严格 JSON 子集，声明固定 instructions.md 与 rules/examples/cards/evals 的分类相对文件；文件清单之外的资产不自动执行或加载。元数据、重复 JSON 键、非法 UTF-8、类型、路径逃逸、symlink/junction、文件身份/读取快照变化及大小超限均明确报错。

每文件最多 1MiB，读取总量最多 2MiB；打开同一 handle 后核对路径/文件身份，读取过程中也计数。这些一致性检查不是操作系统沙箱，文件目录应由受信宿主管理。未来内容包签名、热加载与项目升级流程仍属于发行接入。

dataDirectoryReader/parseDataJson 将同一有界读取/严格 JSON 边界供角色定义加载复用；methodPackReader 的方法包专用路径白名单保持不变，不因共享读取器放宽可加载资产。

## 评测与门禁

`evaluateSuite(registry, runner, suite, pin, ctx, reviews?)` 按真实方法执行结果记录以下断言：

| 类别 | 当前断言 |
|---|---|
| 过程 | 必要工具调用、离线无网络 |
| 内容 | JSON Pointer 精确值、来源摘要、标题 |
| 结构 | 注册输出 schema |
| 质量 | 章节边界 F1；显式 LLM/人工 1–5 分记录 |

缺少 LLM/人工记录为 unscored，整份报告 incomplete，不能通过闸门。评分记录绑定 case、metric、来源、评审者/记录身份、方法摘要及输出摘要；过期/重复/错误归属拒绝。带证据记录另绑定租户、输入、rubric 和生产/评审模型。review_score 可用 requiredEvidence 与 rubricDigest 锁定证据类型/评分标准；旧宿主自报记录仍可用于未锁证据的断言，但不能满足 requiredEvidence。1–5 分归一化为 `(score-1)/4` 后参与回退比较，边界 F1 保持 0–1。

`evaluationGate(registry, suite, baseline, candidate, allowedDrop?)` 核对受信注册 pin、套件与输入摘要、输出、工具轨迹、方法规则及评分记录，重新计算断言；不只相信 passed 标志或均分。默认任何类别均不允许退步；显式阈值范围为 0–1。缺少用例、断言、产物或评分、不可比套件、失败候选及超阈值回退均阻止通过。不同 rubric、证据类型或评审模型的分数不直接比较，返回 INCOMPARABLE_REVIEW。

评测报告现为 version:2，subject 必须声明 tenantId/connectionId，并校验模型回执作用域；旧 v1 报告直接拒绝，不猜测补租户。章节黄金基线已显式重新生成并核对：仅报告版本及本地作用域变化，方法包、六例产物和分数不变。付费执行成功后，后续评分/序列化失败仍保留 completed；任何先前未知调用使累计状态保持 unknown，供宿主对账。

报告可序列化并附产物，但不是远程签名证明；真实工具轨迹和人工/模型评分仍由受信宿主提供，不能从不可信客户端自报获得认证。报告可能含业务标题/产物，存储、分享与保留由宿主控制，不自动外传。

`runGoldenEvaluations(pack, storedBaseline?)` 使用本地章节执行器运行包内评测；基线保存完整方法包，旧版本可重新注册后比较。每份基线报告的完整 method pin 与 suite 必须属于所存旧包，拒绝旧包搭配候选报告。`eval:check` 默认只读取基线，更新必须显式 `--write-baseline` 并审查差异。新增/修改套件使旧基线不可比时，应评审基线升级，不能静默跳过。

基线读写复用包目录边界，读取最多 1MiB 并核对同句柄快照。更新采用核验目录内的独占临时文件、完整写入与 fsync 后 rename 替换；拒绝链接或异常文件，失败保留旧基线并清理临时文件，不原位截断或修改 hardlink 别名。

T0.8 仍需真实模型质量验收、具备认证/持久化/UI 的人工抽检接入，以及更多方法/长文本黄金样本。T0.9 制片→研究 Agent→方法包→候选的持久化回放端到端验收尚未实现；本包的确定性与合成协议通过不替代该验收。
