# StoryBible 候选领域

[T1.2计划与完整验收边界](../../docs/plan/storybible-phase1.md)。当前交付完整来源分块、单块结构化模型适配、跨块合并建议、精确引文及受信宿主驱动的人工确认/拒绝函数。数据库、付费任务编排、认证HTTP和审阅界面尚待接入；纯域函数返回不等于数据库提交、真实模型质量或真人已经审阅。

| 接口 | 行为 |
|---|---|
| `captureSource(source)` | 严格校验ingest完整快照及tenant/project/document/kind/revision，保留UTF-8文字摘要和DOCX原文件摘要；不能用UI分页拼装来源 |
| `createChunkPlan(source,limits?)` | 默认12000 UTF-16单元/48000 UTF-8字节，优先结构边界，长章节继续切分，不拆代理对/CRLF；上限4096块 |
| `validateChunkPlan` / `readChunk` | 重建验证外部计划；只对本库生成的深冻结source/plan身份缓存验证，伪造冻结标记不能绕过 |
| `createStoryBibleMethodPack()` | 原创固定版本`story-bible-extract@1.0.0`，由既有MethodRegistry注册，不动态加载代码或凭据 |
| `extractChunk(options)` | 注入受信MethodRunner、固定方法pin和CallContext，一次模型调用；来源放不可信封套，无自动重试 |
| `validateChunkOutput` / `validateChunkRecord` | 严格结构、块内唯一ID和引用、逐字引文、回执作用域与输出摘要；不证明模型的解释正确 |
| `assembleBibleCandidate` / `validateBibleCandidate` | 必须有且仅有每块结果，按计划排序并转换全局UTF-16位置；保留原始块和模型回执，重建所有投影与摘要 |
| `confirmBible` / `rejectBibleCandidate` | 由认证宿主提供人类身份、项目范围、规范UTC时点及同步授权；返回不可变知识快照或拒绝记录，不修改正式IR |

每块最多32实体、64关系、64事实/世界规则/时间线/伏笔/揭示。每项1–6条引文、每条≤500 UTF-16单元，位置相对本块且quote必须等于精确切片。模型输出≤128KiB，所有原始块记录累计≤2MiB，候选全投影另受2MiB约束；最多4096实体、8192关系、8192事实。超限明确拒绝，不截断候选或静默丢块；大型来源可分任务逐步研究，不能把部分覆盖当全书完成。

JSON边界先逐步计数逻辑字节并建立普通数据快照，再序列化。共享对象重复出现仍重复计费，访问器/原型/循环/稀疏数组/符号字段拒绝，不执行getter或回显任意异常。完整来源另有128MiB JSON预算及ingest本身的原文字数/结构限制。内部自有source/plan可跳过重复全书校验；外部传入值仍重建。

跨块同kind名称和别名按NFC、首尾/连续空白规范化精确匹配，只产生`mergeSuggestions`；同名异人可以由用户分开。确认要求每个实体恰好在一组或被拒绝，不能跨kind合并；选择关系/事实时，被引用实体必须保留。所有矛盾描述和原文位置保留，关系/事实引用显式重映射，不用模型猜测覆盖冲突。

宿主必须从认证结果提供身份、从可信存储读取候选及当前来源；不能把客户端自报`human`、digest或ModelReceipt当授权。同步`authorize`仅返回字面`true`才通过。确认得到独立`ConfirmedBible`，还没有正式IR集合/ULID映射；未来写IR仍走既有ChangeSet/采用服务。

每块ModelSession记录实际使用量，未知token保留null，live调用失败保留unknown以待对账，已完成模型返回但领域引文非法保留completed。畸形宿主返回无法辨识evidence时保守unknown。模型回执是宿主一致性记录，不是远程签名。该适配器本身不限制跨块总费用，不是生产付费工作流；生产必须接现有AgentRuntime、预算账本和durable逐块步骤，不能普通for循环后声称有恢复/计费保证。

```sh
pnpm --filter @camery/bible test:coverage
pnpm --filter @camery/bible typecheck
pnpm check
```

十章原创用例经真实OpenAI连接器的进程内协议夹具录制，再严格离线回放，覆盖分块→候选→明确分组→确认/拒绝。它不调用真实模型、不产生真实账单，也不证明真人确认或数据库崩溃恢复。现有ComfyUI实机出图能力与文本抽取模型是不同的验收项。
