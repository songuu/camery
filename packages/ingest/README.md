# 小说与剧本导入核心

[T1.1 计划与验收边界](../../docs/plan/phase1-progress.md)。来源只作为数据，解析返回候选；本包不调用模型、执行来源指令或采用 IR。公共 HTTP、用户界面和授权应用服务尚未接入，不能将本库的作用域参数当作认证凭据。

## 格式与来源定位

| 格式 | 当前能力与限制 |
|---|---|
| 小说纯文本 | 复用既有中文章节规则，保留前言、原始换行和 BOM。没有显式标题时整段保留并告警；批次落在标题内部时按累计原文重算，避免永久错误切章 |
| Fountain | 场景、动作、角色、对白、括号、转场、标题页、注释等投影；保留标记及未识别文字，不承诺排版/导出完整 Fountain |
| CSV / TSV | 严格引号及跨行字段、中文/英文列名；字段解码保存在 `fields`，原始表格行范围保持可定位；未知列/类型保留，不执行公式 |
| Word DOCX | 实际 ZIP/OOXML 正文、段落、文本 run、换行、制表符、表格文字及常见剧本样式。提取后按文本结构化；头尾、关系和格式不导入并告警。旧 DOC、XLSX、宏和未确认修订不支持 |

所有 `start/end` 都是半开 UTF-16 范围，指向返回的精确 `text`。`sourceDigest` 是该文本 UTF-8 字节的 SHA-256；`originalDigest` 是原始文件字节摘要，文本格式下两者相等。DOCX 的来源位置指向提取文本，不能当作 ZIP 字节或 Word 页码。既有 methods 运行回执仍使用其 canonical-JSON 摘要，不能直接和文本字节摘要混比。

文本最多 1600 万 UTF-16 单元；小说最多 1 万输出单元，每批最多 100 万单元、每份来源最多 1024 批。拒绝空串、NUL、不完整 Unicode。Fountain 最多 10 万行；CSV/TSV 最多 128 列、10 万数据行、每字段 100 万单元。所有限制失败均返回明确业务错误，不截断来源。

剧本投影的标题、角色名、字段键/值另有累计1600万字符预算，在追加每个单元前检查。按引用共享字符串仍会在JSON序列化时重复展开，因此预算按逻辑投影计数，不把内存共享当作输出上限。DOCX每段只规范化一次样式、标题和角色名，避免长段落乘以行数的重复扫描。

DOCX 压缩体积最多 8 MB、最多 2048 条目、声明解压总量最多 32 MB，正文 XML 最多 16 MB，XML 深度最多 128、提取段落最多 10 万，构造段落列表时即检查。ZIP 惰性读取、实际流字节上限、尺寸和 CRC 检查独立验证；不落磁盘解包、不解析 DTD/外部实体、不跟随外部关系。输入字节在首次等待前快照，摘要与实际解析使用同一份字节。

```ts
import { importNovel, importFountain, importScriptTable } from '@camery/ingest';
import { importDocx } from '@camery/ingest/node';

const novel = importNovel('前言\r\n第一章 初见\r\n原文');
const script = importFountain('.内景 办公室\n\n@小林\n你好。\n');
const table = importScriptTable('场景,角色,对白\n办公室,小林,你好。\n');
// const word = await importDocx(await readFile(authorizedDocxPath));
```

## 分批追加与断点续读

可信宿主先核对当前会话的项目读写权限，再传入 tenant/project/document/reader 身份；本包保留复合作用域，每次 SQL 查询均包含完整作用域。读取者身份应由宿主从已认证用户确定，不能照抄公共请求体。

安装者使用已有 PostgreSQL 管理连接显式执行 `migrateIngest(pool)`；安装路径有事务 advisory lock 和历史 checksum 检查。运行时不自动迁移，也不要求对既有 schema 扩权；将其接入正式 API 前仍需像阶段 0 认证服务一样配置并验收独立最小权限 LOGIN。

```ts
import { PostgresDocumentStore } from '@camery/ingest/node';

const store = new PostgresDocumentStore(pool);
const scope = { tenantId, projectId, documentId };
const appended = await store.append({ ...scope, batchId: 'batch-001', expectedRevision: 0, text: '第一章 开篇\n原文' });
await store.checkpoint({ ...scope, readerId: userId, expectedVersion: 0,
  sourceDigest: appended.document.sourceDigest, offset: 3 });
// 重启后创建新pool/store，仍从数据库读取同一份正文与各用户自己的游标。
const resumed = await store.read({ ...scope, readerId: userId });
```

批次 ID 与内容绑定：相同批次重试返回当前快照且不再追加，不同内容明确冲突；新批次必须匹配最新 revision。文档事务锁保护初次创建和后续追加，正文/批次记录一同提交。游标由独立版本控制，单调前进；拒绝过期来源摘要、倒退、越界和代理对中间位置。追加后旧已读前缀仍有效，更新游标前需读取当前正文摘要。数据库断开、损坏记录或回滚失败使用固定 `STORAGE_FAILED`，不输出驱动细节。

## 验证

```sh
pnpm --filter @camery/ingest test:coverage
pnpm --filter @camery/ingest typecheck
pnpm test:ingest:local --coverage
pnpm check
```

普通测试明确排除数据库专项；真实 PG 配置缺失时专项明确失败。PG 用例涵盖首次并发重试、冲突写入、四维隔离、游标幂等、追加后的前缀、await 前快照、子进程提交游标后 SIGKILL 及新连接续读。测试只删除自己随机租户的记录，不删除现有数据卷或 schema。

实现依据：[Fountain 语法](https://fountain.io/syntax/)、[yauzl 惰性读取及尺寸校验](https://github.com/thejoshwolfe/yauzl)、[saxes 命名空间解析](https://github.com/lddubeau/saxes)。运行依赖固定 `yauzl 3.4.0`、`saxes 6.0.0`，锁文件记录完整闭包；不由测试临时安装。
