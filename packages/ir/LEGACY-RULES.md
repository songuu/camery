# v0.3 校验规则迁移核对

核对对象为原 [Python 校验器](../../storyboard_platform_v3/tools/validate_package.py)、[旧 JSON Schema](../../storyboard_platform_v3/contracts/storyboard_package.schema.json)、当前 [迁移边界](src/node/migrate-v03.ts)及 [v0.5 校验器](src/validate.ts)。旧文件和两个原始样例不改写。

旧 Python 有 **70 个显式报告调用点（67 error、3 warning）**，不是 70 个错误码。引用 helper 另有 37 个调用点（23 个 `need`、14 个 `many`），`sequence` 用于四个作用域。下表按语义合并调用点；JSON Schema 内的字段约束不包含在这 70 点中。此表说明去向，不是全部结构约束等价的形式证明。

## 规则去向与证据

旧行号指上述 Python 文件。测试文件均在 [test](test/)；`migrate-v03.test.ts` 检查原样例、条件矩阵及生成物一致性，新增的 `legacy-import-guards.test.ts` 检查规范化前不能丢弃的旧矛盾。

| 旧行号 / 条件 | 当前边界及测试 | 语义说明 |
|---|---|---|
| 61 结构 | `LEGACY_SCHEMA`、v0.5 `SCHEMA`；`schema.test.ts`、`migrate-v03.test.ts` | 两个版本各用严格结构；不宣称所有 JSON Schema keyword 等价 |
| 69、75 全局 ID 唯一 | register、`LEGACY_DUPLICATE_ID`；`v05.test.ts`、迁移测试 | 保留 |
| 85 引用 helper | need、`LEGACY_REFERENCE`；`references.test.ts`、迁移测试 | 测量证据另作保守阻止，不继承已验证结论 |
| 101 四组 sequence | `ORDER_KEY`、`LEGACY_SEQUENCE`；引用/迁移测试 | 新顺序键唯一，不要求连续整数 |
| 106、108 adopted 指针 | `LEGACY_ADOPTION`；新增导入守卫 | 先查旧声明，再生成 candidate |
| 112、116 父修订与环 | `LEGACY_REVISION`；迁移测试 | 父版本严格更小排除环；旧版本图留审计 |
| 124、126、129 scope 数量 | `SCOPE`、`LEGACY_SCOPE`；v05/迁移测试 | 保留 |
| 133、146 数组顺序 | 顺序键及迁移排序后绝对时间复核；迁移测试 | 新数组位置不是排序权威，不将旧数组规则强加新 IR |
| 136 集全局时间不重叠 | `LEGACY_TIMING`；迁移测试 | 新时间按集相对计算 |
| 139 每集有场次 | `LEGACY_EPISODE_EMPTY`、delivery `EPISODE_CONTENT`；新增守卫、`delivery-gates.test.ts` | 新规划可空；交付不可空 |
| 158 来源作用域 | `SOURCE_SCOPE`、`LEGACY_REFERENCE`；引用/迁移测试 | 保留 |
| 164、166 台词、节拍、说话人同场 | `SPEAKER_SCOPE`、`LEGACY_OWNERSHIP`；引用/迁移测试 | 新台词场次从节拍推导，消除冗余字段 |
| 176、179、185 路径、文件、哈希 | `ASSET_PATH`、Node 文件边界；`node.test.ts` | 纯数据校验不读取文件；Node 才核对实际文件与 SHA-256 |
| 190、192 actual / ready | `ASSET_READINESS`、`LEGACY_ASSET_READINESS`；引用测试、新增守卫 | 导入只查声明一致性；ready 默认拒迁，显式 reset 仅降级 |
| 196、198 声音参考目的与音频类型 | `VOICE_REFERENCE`；引用/连续性测试 | 保留 |
| 205、210 时间范围与测量证据 | timeline、`LEGACY_TIMING`、`MEASUREMENT_REVIEW`；时间线/迁移测试 | 不继承旧 measured 认证；新 measured 仍只是声明，未探测媒体 |
| 215、218、221、226、230 镜头顺序、重叠、归属 | timeline、`SCENE_OWNERSHIP`、迁移 gap/roundtrip；时间线/迁移测试 | 相对时间与顺序键取代冗余绝对秒点 |
| 239、241、243 panel 时间、ready、图像 | ratio schema、`PANEL_READINESS/PANEL_ASSET`、`LEGACY_PANEL_TIME/LEGACY_PANEL_READINESS`；schema/引用/守卫测试 | 保留槽位与采用语义，原时点转比例 |
| 252、254、260、263 cue 精确相交集与范围 | 单集 cue、continuation、`ANCHOR_SCOPE/CUE_RANGE`、迁移交集核对；时间线/迁移测试 | 不静默裁掉集外内容或尾部静音 |
| 265 track role | `TRACK_SCOPE`；连续性测试 | 还校验 rendition 一致性 |
| 270、273、275 cue beat/shot 的场次和时间 | `SCENE_OWNERSHIP`、`LEGACY_OWNERSHIP/LEGACY_AUDIO_SHOT`；新增守卫 | 删除旧 shot_refs 或过滤 beat 前先拒绝矛盾 |
| 280、282 spoken script 与 canonical beat | `LEGACY_AUDIO_SCRIPT`、新 line 关联；schema/迁移测试 | 新 cue 不重复存 text/speaker/beat |
| 284、291 fade、轨道重叠 | timeline `AUDIO_FADE/TRACK_OVERLAP`；时间线测试 | 保留 |
| 297 segment 目标 | `TARGET`、`LEGACY_TARGET`；迁移测试 | 新 rendition 取代旧 target |
| 305、308、313 旧分组顺序、范围、cue 相交 | `LEGACY_SEGMENT_ORDER/LEGACY_SEGMENT_TIMING`；新增守卫 | 仅导入前检查，不把旧连续分组规则加入新 Segment/ShotTake |
| 316、319 旧 ready/produced 输出 | `LEGACY_SEGMENT_READINESS/LEGACY_SEGMENT_OUTPUT`；新增守卫 | 只核对声明及媒体类型，不认证文件或虚构 take |
| 321、324、326 旧目标非空、每镜头一组 | `LEGACY_TARGET_EMPTY/LEGACY_SHOT_DELIVERY`；新增守卫 | 新取用保持多对多；delivery 另查每目标/集实际有内容 |
| 331、334、336、339、369 coverage 双向 ledger | `LEGACY_COVERAGE`；新增守卫 | 先核对重复与正反引用，再转为计算视图，不保留冗余正式 ledger |
| 343 affected/replacement 不相交 | `DECISION_OVERLAP`、`LEGACY_DECISION_CYCLE`；delivery/新增守卫 | 直接自替代无论是否已有覆盖均拒绝 |
| 364 required beat 每目标覆盖 | delivery `BEAT_COVERAGE` 固定点、`LEGACY_COVERAGE`；production/守卫测试 | approved omit / 有实际覆盖的 replacement 才能补覆盖 |
| 373、379、381 ready export | `LEGACY_EXPORT_READINESS/LEGACY_EXPORT_LOSS`；新增守卫；delivery adopted/实际消费 ref 检查 | 旧 export 留审计；candidate 不获得采用/发布授权 |
| 384、386、388 警告 | `PLANNED_MEDIA/ESTIMATED_TIMING/REFERENCE_ONLY`；delivery 测试 | 任一估计时长即警告，比旧“全部估计”更保守；警告不是事实/版权/素材认证 |

新 delivery 还要求至少一集、至少一个 rendition、每个声明 rendition ready、每个 rendition 在每集有对应镜头或 cue。当前没有 rendition 的部分集作用域字段。未消费的计划候选素材可留存并产生警告。`makeProductionPackage` 只是声明级测试夹具，不提供真实媒体证明。

## 有界差分复现

```sh
pnpm --filter @camery/ir audit:legacy
```

这是手动、只读审计，需要现有 Python 与 `jsonschema`；不自动安装依赖，不进入生产导入路径。固定原 fiction/knowledge 样例及已有显式 options，对各节点做单点类型替换、字段删除、未知字段添加、数组首项复制。两个未变异样例先通过迁移正向控制，再和迁移接受的变体一起交给**原 Python validate 函数与原 schema**核对，防止迁移全拒绝造成真空通过；不写包、素材、数据库或 Python 字节码。报告含 baselineCount 和输入文件摘要，子进程有超时和输出上限，差异令命令失败。固定阶段标签为失败保留上下文，不回显底层输入或错误正文。

本轮实际结果：**10,595 个变体，迁移接受 134 个，旧校验器拒绝其中 0 个**。schema SHA-256：`1f6b54056a76c2c4650e208f9b8dceac26bc9c590d7338f10b462bfa1f34c483`；validator SHA-256：`3392646fa031a60e561b9c1554ee557c771aed3fb0eb7c9356d93fa362f7e0e7`。命令同时输出两个 fixture 的摘要。

这只检验两个样例邻域中“迁移接受、旧校验拒绝”的差异，不证明所有合法旧包都能迁移，也不覆盖任意多点组合或全部 JSON Schema 字段等价。旧 ready 文件认证不能在无素材条件下复现。T0.3 的指定契约与测试证据另见 [阶段范围](README.md)；不能单凭本表和变体计数判定完成。未建模的完整锚点/导演引用按阶段 2、产品导入 UI 按 T1.1 实施，不以完整产品实体表扩大阶段 0 范围。
