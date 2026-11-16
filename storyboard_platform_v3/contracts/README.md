# 分镜交付协议草案 0.3.0-draft

这是本次为“双场景、分镜核心”产品设计的**通用交换协议草案**，采用 JSON Schema draft 2020-12。它不是 Toonflow、Reelbench、火宝、TTS 服务或音频制作软件的原生导入格式。外部平台仍需单独做字段转换、能力预检、实际导入与回读验收。

本目录没有实现完整应用、外部平台连接器、生成服务或发布任务。

## 文件

| 文件 | 用途 |
| --- | --- |
| `storyboard_package.schema.json` | 类型、必填项、枚举、媒体计划与真实文件的结构约束 |
| `../tools/validate_package.py` | 只读校验 Schema、引用、顺序、覆盖、时间与文件就绪条件 |
| `../examples/fiction_package.json` | 原创故事：公司场景、一集两场六镜、视觉与纯音频两个交付目标 |
| `../examples/knowledge_package.json` | 月相科普：个人场景、一集纯音频、四个讲解节拍；没有机位或镜头对象 |

两个样例均是自拟设计数据，`export.status=planned`，只有估算时长及待制作的媒体计划。没有真实图片、声音或视频，不可据样例名称宣称已经完成媒体制作或平台导入。

## 1. 关键对象与边界

| 对象 | 说明 |
| --- | --- |
| Project | `mode` 为 personal 或 studio；`targets` 是 video、audio 或二者；保存选定来源、范围与目标时长 |
| SourceSnapshot | 选定资料的读取记录；`reference_only` 明确表示只有来源定位，不冒充抓取到完整正文 |
| Revision | 当前包正文对应 `active_revision_id`；`adopted_revision_id` 单独指向采用版本。这里包含版本元数据，不是完整多版本数据库 |
| Episode | 稳定 ID、标题、集序与全项目时间范围；`scope.expected_episode_count` 声明本包应完成的集数 |
| Location | 可复用的地点资产身份 |
| ScriptSceneOccurrence | 一次具体场次，带 `episode_id`、全项目顺序、地点引用、参与者、场次正文与起止状态；回到同一地点是新场次，不复用旧场次 ID |
| Beat | 场次内有稳定 ID 的动作、对白、解释或转场单元，标明是否必须承载及对应来源 |
| DialogueLine | 台词或旁白原句、说话人、语气、所属场次与节拍；AudioCue 原句必须与之相同 |
| Shot | 视觉目的、节拍引用、起点/动作/终点、摄影、资产引用与预计时间；纯音频可以没有 Shot |
| Panel | 某镜头首、尾或中间关键瞬间的构图计划，时间相对该镜头；计划文字与真实关键帧资产分别保存 |
| AudioCue | dialogue、narration、sfx、ambience、music 五类声音事件；包含分轨、时间、原句或声音意图；`episode_ids` 必须明确列出声音实际涉及的每集 |
| RenderSegment | 一次计划交接/执行单元，可包含多个连续 Shot；声音另以 cue IDs 绑定，不固定某个供应商的段长 |
| Asset / AssetReference | 媒体本体与引用用途分开；`planned` 是计划，`actual` 必须指向有实际文件和哈希的 ready 资产 |
| AdaptationDecision | 明确删去或替换节拍的决定；只有 approved 决策才可解释必须节拍为什么没有直接承载 |
| Coverage | 对账每个必须节拍由哪些镜头或声音承担，以及被采用的删改决定 |
| Export | 交付格式、适配目标和状态；`exported` 也不等于外部平台已经接收或公开发布 |

`character_ids` 表示场次的叙事参与者，可包含画外说话人，不代表所有角色都出现在每个画面里。人物资产的默认声音参考与某条实际配音分开；真正生成时由对应声音任务选择、记录并使用。

### 视觉、声音与生成单元不是同一个粒度

`Shot` 是视觉语言单元；`Panel` 是该镜头中的一个关键瞬间；`RenderSegment` 是交给某个执行方的一组工作。三者有独立 ID。

声音以自己的时间线保存。配乐或环境声可以跨越多个镜头；`AudioCue.shot_refs` 只在需要对齐画面时填写。纯音频示例不创建空机位、假分镜图或零时长镜头。

摄影景别、角度和运镜以开放文字保存，协议没有强制每切 2–5 秒、每段 15 秒之类的套件默认值。供应商档案的时长、画幅和参考数量限制，应由具体导出适配器验证。

## 2. 时间与完整范围

- 所有 `start_seconds` 是选定作品范围内的时间，单位秒；`duration_seconds` 必须大于零。
- **多集仍共用全项目时间线，不是每集从零计时。**例如第1集为 0–120 秒，第2集为 120–240 秒。Episode 区间按集序排列且不重叠；场次引用一集，镜头必须落在其所属集的时间范围内。
- 声音默认受所声明的集范围约束。跨集音乐或声音桥必须在 `AudioCue.episode_ids` 明确列出所有相交集；只列第一集却延伸到第二集会被拒绝。声明中的额外集、未声明的集、越出集范围或跨越未建模时间缺口都会报错。`scene_id=null` 允许全局声音，但不会免除分集声明。
- `Panel.offset_seconds` 是相对所属 Shot 的时间。首帧应为 0，尾帧应为镜头时长，中间关键帧应位于区间内部。
- `basis=estimated` 只是设计预算；真实配音、表演、剪辑后应更新为测量结果。声明 measured 时需要实际证据资产。
- 声音跨镜时可以被多个视频执行段引用。段内实际使用的部分是该声音事件与段时间的交集；不能在每段都从音频文件的零秒重新播放。具体源片偏移和裁切由适配器计算并记录。
- 同一画面轨上的镜头按全局 sequence 排列，不能重叠。并行画面、分屏和多个剪辑版本尚未建模，应在后续版本增加轨道/版本维度。
- 音轨是否允许重叠由 `AudioTrack.allow_overlap` 明确声明，不跨轨一概禁止重叠。
- 范围计数须与实际集数、场次数和必须节拍数量相等；每集至少有一个场次，场次全局序号服从集序；每个视频镜头在本版本中归属一个视频执行段。

校验器对每个目标分别检查必须节拍的承载。video 可以通过画面或该视频使用的声音承担；audio 必须由实际纳入音频交付段的声音承担。因此“video+audio”不意味着删掉视频画面就自动得到完整音频版。

原创样例中，四条专用于音频版的旁白补足视觉动作，视频执行段没有引用这些旁白。两个版本共用对白与来源事实，同时有各自的表达计划。

## 3. 计划资产与真实文件

`Asset.status=planned` 或 missing 时不能填写 `file` 冒充存在；`AssetReference.mode=actual` 要求目标资产 ready，并且能在指定 asset root 内找到文件、通过 SHA-256 对比。

文件路径只允许相对 POSIX 路径，禁止绝对路径、URI、反斜线与 `..` 穿越；解析后的真实路径也必须位于 asset root 内。校验器只读文件，不创建、上传或执行任何内容。

这些检查证明文件存在并与声明字节一致，**不证明该文件确实是可用的图片、音频或视频，也不证明内容正确**。解码、尺寸、音频时长、响度、声音身份、图像连续性等需要下游媒体检查。

## 4. 修订、采用与就绪

`draft`、`reviewed`、`adopted` 是不同版本状态。父版本必须存在且编号较小；当前包中所有内容归于 active revision，不能用旧版采用状态替新版背书。

`export.status`：

| 状态 | 含义 |
| --- | --- |
| planned | 创作和资产计划仍在准备；允许尚无真实媒体 |
| validated | 当前数据完成结构检查；不代表内容或事实已正确 |
| render_ready | 当前采用版本可交接执行，所引用的前置媒体必须是真实文件，且没有未处理的能力损失 |
| exported | 交付包已形成；外部接收、审核或生成结果另行记录 |

校验器不会自动升级状态、批准版本或把计划素材替换成真实素材。样例保持 planned，避免把通过结构校验写成已经就绪。

此版本没有完整的外部提交与回执协议。应用需另外保存 adapter/version、远端项目和对象 ID、导入映射、未支持字段、提交尝试与回读结果，才能声称“已经导入某平台”。

## 5. 使用校验器

需要 Python 3.9+ 和包含 `Draft202012Validator` 的 `jsonschema` 包。校验器不会自动安装依赖，也不会联网读取 Schema。

在 `storyboard_platform_v3` 目录执行：

```bash
python3 tools/validate_package.py examples/fiction_package.json
python3 tools/validate_package.py examples/knowledge_package.json
```

如果真实媒体放在其他选定目录：

```bash
python3 tools/validate_package.py examples/fiction_package.json --asset-root /absolute/path/to/assets
```

退出码 0 表示本工具检查通过，1 表示存在问题。输出 JSON 包含 `valid`、`errors`、`warnings` 和结果含义。预计时间、仅链接来源与计划资产会保留警告，不能因此改写成实际产物。

## 6. 本次验证结果

| 检查 | 结果 |
| --- | --- |
| 原创故事，一集两场六镜，视觉与音频各自覆盖必要节拍 | 通过；保留计划资产与估算时间警告 |
| 月相科普，一集纯音频，无 Shot 或 Panel | 通过；另保留 reference_only 来源警告 |
| 临时两集变体，0–21 秒与 21–42 秒，并显式声明跨集音乐 | 通过，说明协议不局限于单集样例 |
| 临时场次引用不存在的 Episode | 拒绝，报告 MISSING_REFERENCE 等 |
| 跨集音乐只声明第一集 | 拒绝，报告 AUDIO_EPISODE_SCOPE、AUDIO_EPISODE_TIME |
| 第二集错误地从零重新计时 | 拒绝，报告 EPISODE_TIME、SHOT_EPISODE_TIME 等 |
| 临时变体同时破坏节拍引用与镜头时序 | 拒绝，报告 MISSING_REFERENCE、COVERAGE_EDGE、SHOT_OVERLAP |
| 临时把计划样例声明为 render_ready | 拒绝，报告 EXPORT_READINESS |
| 临时用不存在的 WAV 路径假装实际资产 | 拒绝，报告 ASSET_FILE、ACTUAL_REFERENCE |

破坏用例只在内存中构造，没有混入交付样例。这是设计级检查，不是完整测试框架，也没有运行第三方 Skill、生成服务或真实平台导入。

## 7. 仍需明确的质量边界

覆盖率只对已经抽取并声明的 Beat 负责，无法证明从原著或图书抽取时没有漏掉关键内容；仍需对照完整选定来源审阅。结构化来源引用不证明科学事实成立。时间窗口不证明演员或 TTS 能自然说完。镜头起止状态都是非空文字也不证明语义连续。

下一步实现应补上领域审阅、真实媒体测量、目标平台能力检查和导入回读。协议版本目前明确为草案，不能当成已被各平台支持的行业标准。
