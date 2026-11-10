# v0.3 → v0.5 规划候选迁移

`src/node/migrate-v03.ts` 提供 Node 边界函数 `migrateV03(input, options)`。输入必须是 `0.3.0-draft`，输出只可能是新的规划候选，不能直接采用、交付或发布；不会读取素材、调用模型或写入正式状态。

本模块对旧封装使用严格 Zod 对象及 v0.3 条件约束，拒绝未知字段、版本、重复引用、无证据的测量声明、错误的 spoken/nonspoken 字段、缺失引用、顺序/范围冲突等。它不是完整旧 Python 校验器的替代物；全量旧规则对照迁移仍属于 T0.3 的剩余工作。

## 迁移输出

- `ok`：是否成功形成并通过当前规划检查的候选。`false` 时 `package` 为 `null`，不能靠忽略错误取得半成品。
- `package`：v0.5 规划包，`revision.status=candidate`。新的对象版本从 1 开始，不能把它们解释为旧对象版本链。
- `issues`：带 code、位置、严重度的错误与警告。
- `decisions`：明确记录类别映射、相对时间、就绪重置、旧分组及覆盖表处理。
- `id_map`：旧 ID 到新 ULID 的一对多映射；同一 cue/轨道若被视频和音频版本共用，会分别获得独立身份。
- `blocked_actions`：始终包含 delivery、publish，表示迁移不提供采用或发布授权。知识样例的 `public_reference` 额外保留为未知权利。
- `legacy`：通过旧结构检查后的完整原始快照副本，保留旧修订、导出声明、覆盖表、相机原文及分组关联。非法输入的该字段为 null，不将未知对象夹带进可序列化审计报告。

ID 使用旧 package ID、active revision ID 和对象/版本作用域作为确定性命名空间，生成语法合法的 ULID。其时间部分不表示真实生成时刻；稳定 ID 不是审计时间戳。相同输入与 options 可重现同一候选；这不允许绕过后续版本冲突检查重复导入。

## 必须明确提供的选择

旧 `dialogue` 无法区分当面说、心声与画外音，需在 `line_kinds` 中逐条声明。旧 narration 继续为 narration。画幅、自由文本相机词表、计划资产的创建/导入意图也需由调用方明确提供，不能从剧情猜测。

对于旧 schema 有、当前 schema 无的值，调用方通过 `source_mappings`、`beat_kinds`、`source_relationships` 指定语义映射，审计报告同时保留前后值。映射不能把 reference_only 声称为已提供全文，也不能把局部/仅参考来源声称为完整正文。`public_reference` / `undetermined` 不是授权证据，迁移后 usage_basis 和 project.rights_status 保留 unknown。不会创建 verified 的事实主张；原 source_refs 的来源、位置与旧语义均可从候选及审计快照追溯。

就绪素材不能只凭旧 JSON 被认证。遇到旧 ready 素材，默认阻止迁移；调用方可显式提供 `reset_readiness:true` 将它们退回 planned，并清除候选中的文件认证与关键帧采用。原文件描述仍在审计快照中，之后应经实际文件/哈希/授权检查重新接入。document 资产、generic 引用等未提供对应模型的情形明确报错，不偷偷换成另一种内容。

空的旧 `must_not_control` 需通过 `reference_exclusions` 提供用户编写的新规则。位置、造型、持物只存在于旧文字时，迁移保留 summary，不虚构结构化人物站位、造型或道具身份。

## 时间与版本边界

旧全局秒点先按声明的集区间切分，变成本集起点相对偏移；计划时长保持为原声明值。画面轨必须与旧时间连续对应，不能自动删去空白、压缩间隔或填造新镜头。

端点与交集从一开始使用精确有理数计算，避免把 `0.2 + 0.1` 的浮点误差当作时间缺损。生成当前规划包后，会再次求解并逐版本、逐集、逐镜头、逐 cue 对照原区间：音频尾静音无法由现有 cue 表达时明确阻止，不能自动删去；场次排序会移动镜头时同样阻止。若当前秒数字段无法精确保留派生偏移，返回时间不匹配问题，由人工决定新的时间基准，不悄悄舍入内容。

视频与纯音频的 cue 使用旧 render segment 成员关系确定，不能因为文本相似而猜测归属。跨集全局底乐可在声明边界切为连续 cue；跨集口语或淡入淡出无法无损自动决定分界，必须人工处理。cue 必须精确声明其相交集，不能在迁移时裁掉落在集外的内容。

旧 render segment 没有具体源媒体 in/out，不足以建立 ShotTake。迁移仅保留分组意图及旧关联的审计信息，`shot_takes=[]`，不会虚构素材版本、头尾余量、完成状态或生产任务。旧 coverage 不再作为正式冗余状态，新覆盖由实际内容计算；矛盾的旧声明会报错。

## 实际样例与复现

两个 fixture 均来自原有研究样例，原文件保持不变：

| 原始样例 | 显式迁移选项 | 新规划候选 | 完整审计报告 |
|---|---|---|---|
| `storyboard_platform_v3/examples/fiction_package.json` | [fiction options](examples/fiction.v03-migration.options.json) | [fiction v0.5](examples/fiction.v05.planned.json) | [fiction report](examples/fiction.v03-migration.report.json) |
| `storyboard_platform_v3/examples/knowledge_package.json` | [knowledge options](examples/knowledge.v03-migration.options.json) | [knowledge v0.5](examples/knowledge.v05.planned.json) | [knowledge report](examples/knowledge.v03-migration.report.json) |

选项文件是本次 fixture 的显式演示决策，例如把旧双人中景归到 medium、选择 16:9、将两个可见对白声明为 on_screen；它们不是通用的自动判定规则。新候选保留全部集、场、节拍、台词、来源和既有改编决定；知识来源仍只是一条 NASA 参考，迁移没有重新浏览或独立核查该页面。

调用示例（在 `packages/ir` 目录，已有 tsx 开发依赖）：

```js
import { readFile, writeFile } from 'node:fs/promises';
import { migrateV03 } from './src/node/migrate-v03.ts';
import { parseStrictJson } from './src/node/strict-json.ts';

const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const input = parseStrictJson(decode(await readFile('../../storyboard_platform_v3/examples/fiction_package.json')));
const options = parseStrictJson(decode(await readFile('examples/fiction.v03-migration.options.json')));
const result = migrateV03(input, options);
if (!result.ok) throw new Error(JSON.stringify(result.issues));
await writeFile('examples/fiction.v05.planned.json', JSON.stringify(result.package, null, 2) + '\n');
await writeFile('examples/fiction.v03-migration.report.json', JSON.stringify(result, null, 2) + '\n');
```

测试会重新读取两个原始样例、调用真实迁移函数，验证规划检查、全文保留、确定性、语义阻塞、绝对时间及生成物一致性。仅有新 JSON 文件本身不构成迁移完成的证据。

本次两个原始样例还分别通过了原 `storyboard_platform_v3/tools/validate_package.py` 校验：均为 `valid:true`，保留 planned-media、estimated-timing 警告；知识样例另有 reference-only 警告。新迁移没有把这些警告当作素材、事实或授权的验证结论。
