# 阶段1 T1.5 四本账与集末状态快照

Revision 2 · 2026-11-18。接续`b0ccfcd2ca792e5132fc6491241a64acd84cffb6`，精确CI https://github.com/songuu/camery/actions/runs/44312613153 已completed/success，27步骤全部成功。用户已授权提交/推送，编辑器、法务和设计伙伴确认后补；完整阶段1范围保持。

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与价值：每集采用后的事实、角色知情、人物状态和伏笔必须可追溯，下集不能从候选、错误集或过期版本继续，避免角色无来源知情、伏笔提前回收和状态丢失。
- 范围：严格四账事件、原生剧本证据、确定性演算、问题定位、人工审阅/正式采用、不可变持久快照与下一集约束，并在后续T1.6定稿流程消费。当前先完成核心领域与原生采用读取组合，再接持久化/应用/页面，不将纯库候选冒称正式采用。
- 备选方案：修改旧IR快照字段会破坏v05/v06/v07严格读者；从自由文本猜测事实/知情会虚构语义。选择独立typed四账事件和完整证据，再由现有正式版本权威与同事务应用绑定；沿用旧四账快照作为兼容只读输入，不把自由source字符串当可验证事件引用。
- 组件：`@camery/script/continuity/contracts`浏览器安全契约；context从完整已采用IR投影所有集的实际beat/line及顺序/参与角色；纯reducer按事件演算；Node候选摘要/原生handoff组合；后续PG与应用继续复用已有版本、Access和预算边界。
- 状态与失败：候选有完整问题且不自批。结构/证据引用/不相邻上游/旧版本等拒绝；未满足知情来源不赋予知识，未来伏笔不得提前回收；到期未回收是可定位问题，不能自动删除。摘要仅证明完整性，不是人类许可或采用凭据。
- Acceptance Criteria：
  - AC-CT-1: WHEN 接收四账事件 THE SYSTEM SHALL 核对实际剧本对象及精确版本、原文片段、集序和角色/物件所属，并按原顺序完整保留内容，拒绝越界、重复或伪造引用。
  - AC-CT-2: WHEN 演算一集 THE SYSTEM SHALL 从精确前集账本延续事实、知情、人物状态、伏笔；角色只能通过有证据的目击、已知者告知或已有事实推断获得知识，无来源使用和错误伏笔配对输出可定位问题。
  - AC-CT-3: WHEN 下集请求约束 THE SYSTEM SHALL 只读取同项目相邻前集真实已采用的快照及精确来源版本，拒绝候选、含混快照、缺完整来源和过期引用；当前head与所选历史修订分别标识。
  - AC-CT-4: WHEN 定稿/采用或恢复 THE SYSTEM SHALL 同事务绑定受信任人类决定、完整四账记录及正式版本，原操作重试不重复写入；授权、租户、来源新鲜度及回滚保持既有边界。
  - AC-CT-5: WHEN 用户核对账本 THE SYSTEM SHALL 完整显示四账、来源及可定位问题，并将已采用约束交给下一集；编辑/拒绝/刷新和并发不会伪造采用或质量结论。
<!-- design-authority:end -->

## 有序任务

| 任务 / owner | 文件边界 / 风险 / 前置 | 完成证据 |
| --- | --- | --- |
| 根：契约和安全边界 | script/continuity/contracts.ts、boundary.ts；L2 | 严格event/四账类型、总字节限制、无自由actor/adopted声明；冻结后下列两任务才并行 |
| [P] 实际剧本context投影 | 只context.ts及独立test；L2，依赖冻结契约 | 完整IR图校验、实际集/场/beat/line顺序及角色/物件；拒过期/跨集/伪quote/不相邻来源 |
| [P] 四账演算与来源检查 | 只reduce.ts及独立test；L2，依赖冻结契约 | 四账完整延续、知识来源与时间、人物状态和伏笔配对；可定位问题，所有输出不自动adopted |
| 根：Node候选和原生handoff组合 | 独立node模块/入口与测试；L3，依赖前两者 | Node摘要与完整性重放；从真实VersionStore读取人类已采用快照，完整基线覆盖/历史/撤权由后续应用gate承接 |
| 后续：持久化/角色/应用/页面与定稿消费 | L4，依赖核心冻结和T1.6生产者 | 同事务原生采用/回执、实际PG/认证浏览器/镜像/精确CI；完整T1.5不能由本批核心冒称 |

## 契约与验证

| 边界 | Before | After / 一致性 |
| --- | --- | --- |
| IR v05/v06/v07 | 既有四账字段，知情来源为文本 | 旧schema/语义/生成JSON Schema全部保持；新独立typed事件不塞入自由JSON或更改旧字段 |
| 事实/知情/人物/伏笔 | 无独立领域演算 | 当前真实脚本event精确ref+quote，四账可重复演算，正文不截断；未配置模型仍可人工核对 |
| 下一集输入 | 任意调用者可能自报snapshot adopted | Node读取真实版本state及object/adoption历史，所需完整script pins与相邻集验证；不凭status字符串授权 |
| 当前批消费者 | 尚无定稿生产者 | 明确导出独立契约/纯域/Node入口，T1.6后续消费；不默默让旧Workbench写接口获得新权威 |

测试先建立失败反例，再实现；先窄测/types/lint/完整包95%覆盖率，再真实版本/PG与整仓，复审后授权commit/push及精确CI。数据库、Docker和覆盖率串行。上下文捕获≤64MiB，单集事件≤512KiB，累计账本≤2MiB；数量上限不保证所有字段同时达限。旧IR不升级/不迁移，回滚撤新入口并保留任何后续已提交数据。用户五份脏文档及无关文件保持；真实作品质量与后补签核不由合成脚本替代。

## Revision 1.1 · 核心契约反例闭合

AC语义保持。LedgerEvidence追加单集声明`order`（1–2048）：同一真实beat可先声明事实、学习后退役，不能因为丢失声明先后而使合法下一集重读失败；告知/推断仍要求知识来源在严格更早的真实剧本event，不能在同一句台词内自证或相互转述。Context事件追加原始`lineKind`，beat为null，台词保留on_screen/inner_monologue/off_screen/narration；内心独白只可给speaker本人提供心理证据，旁白不自动给角色赋知识，offscreen有声告知保持。明确人物物理状态仍可由旁白描述，不由此产生知情。

复审实际反例指出共享Method canonical固定2MiB与新域64MiB上下文不符。新域在自己预算内先安全捕获，再按确定key顺序序列化与SHA256；旧Method接口/限额不改。候选封套另有8MiB整体预算，重放比对所有字段与原context/前集ledger，不单信客户端digest。原生handoff必需pins限制为前集完整剧本、参与/四账引用人物和物件/造型/地点的实际闭包；后来新增无关人物/道具不阻止交接，相关精确版本依赖保持。

兼容边界：Node读取既有四账快照时必须找到真实object revision和native adoption，而非只看status。旧知情`source`文本仅作为已经人工采用的声明原样携带，不被升级为新的typed事件证明；后续新四账采用必须绑定完整typed ledger持久记录。当前Native VersionStore读取结果整体捕获≤64MiB、返回handoff≤2MiB，超限失败不截断；尚未开放HTTP或自动定稿写入，不宣称本批完成AC-CT-4/5或完整T1.5。

## 核心验证证据（2026-11-18）

- 新增168项普通测试：context65、reducer64、native交接27、candidate9、digest3；最初缺模块RED，以及真实重复scene参与者、私密声道与容量/依赖闭包反例先失败后闭合。实际IR v05/v06/v07投影完整source、明确顺序和精确版本；四账延续、告知严格前知/推断独立前提、事实退役、完整物理引用、伏笔配对/到期警告与同beat声明顺序通过。缺乏来源不赋知识，错误回收不写paidOff。窄测终态0，日志`artifacts/delivery/continuity-narrow-final.log` SHA-256=`fef407d3406b020921d6765d93f4b044d76c3ea58a20eca11c7119b2fdbebd7f`。
- Code/TypeScript/security复审无未闭合P0–P2。原三项P2已各自闭合：合法2,100,000字节context完整生成候选并重放；原生正式新增无关人物/道具后旧handoff仍ready，相关角色变更被STALE_REFERENCE阻止；实际inner_monologue/narration不能给其他角色获得或使用知识，有声offscreen告知与本人内心声明保持。采用metadata严格schema拒绝额外字段，避免依赖附加内容跨越边界。
- 从实际公开纯域入口进行browser ES打包，终态0，872.7kB未压缩、无Node external占位，不修改应用主包或安装依赖。日志`artifacts/delivery/continuity-browser-build.log` SHA-256=`cfad66fd7954b11d5a061a9e47af390ad761d3b83ff0c8568536ab742ea7b47b`。独立全包类型13/13及lint通过；最终整仓类型命中有效缓存，覆盖率全部重新执行。
- `pnpm test:script:local --coverage`终态0：1484项=1383普通+101真实PG，72文件，244.90秒；覆盖98.32/96.65/99.42/99.85%，门槛保持95%。新两项PG使用真实VersionStore准备/人类episode-scope采用、独立新pool只读LOGIN，完整四账与原native采用记录一致；重复读state不变，UPDATE确被42501拒绝，异tenant找不到；prepared及receipt故障回滚后前集仍不可交接，原candidate随后正式采用才能读取。日志`artifacts/delivery/continuity-script-pg.log` SHA-256=`9a18ff1fd0f80087c819d854b089dfbbe16e16f05df1d641286371b1dcbe5be1`。此回滚oracle针对原生版本事务，不冒称新typed ledger持久应用已完成。
- 最终`pnpm check`终态0：5175项=20工具+5155普通；script1383项覆盖98.05/96.40/99.14/99.45%，IR579、server1004保持。13包类型成功（13有效缓存），13包覆盖率全部实际执行（零coverage缓存）、876文件策略零问题、方法6项/Agent10项基线匹配。日志`artifacts/delivery/continuity-workspace-check.log` SHA-256=`6e50de17d7a726f3368673fd45f56c43960cf5208ea5d32b618073aced9a227d`。PG普通项不与整仓重复相加，全部远端镜像/私有组合仍以本批精确提交CI终态为准。
- 本批没有改IR、SQL迁移、生产角色或既有项目，不部署新HTTP/页面/模型。AC-CT-1/2核心及AC-CT-3原生兼容只读组合已有证据；后续继续typed ledger受信持久化、同事务采用/回执、认证应用、页面及T1.6定稿消费，完整T1.5/阶段1尚未完成，用户后补安排和五份脏文档保持。

## Revision 2 · 不可变候选与人工审阅存储

前批`b0ccfcd2ca792e5132fc6491241a64acd84cffb6`精确CI https://github.com/songuu/camery/actions/runs/44312613153 completed/success（13:47:57Z），27步骤全部通过；远端实际新两项PG及1484项script门禁通过。本批继续AC-CT-4/5的持久候选/人审前置，不将reviewed等同于正式adopted。

| owner / 任务 | 风险 / 文件 / 前置 | 完成证据 |
| --- | --- | --- |
| 根：冻结persistence-contracts | L2；独立新node文件 | 完整prepared/reviewed/rejected审计、小命令无自由前集/actor/来源正文，当前source与历史source分开 |
| [P] 显式迁移及专用角色 | L2；仅新migrations、migrate/runtime-role及对应独立测试 | append-only candidates/reviews两表、完整FK/校验/固定checksum；运行时不安装；真实role权限由根串行验证 |
| [P] 纯人工决定与完整性重放 | L2；仅新node/review.ts及对应测试，依赖冻结契约 | 受信任同步human权限、编辑后完整重演算、错误不可豁免、warning逐项理由、原始candidate不改；拒绝独立审计 |
| 根：Postgres source/store与实际组合 | L4；独立source/store及新普通/PG测试，依赖以上 | 同连接原生版本头锁→candidate锁，来源/前集重新校验、8并发/丢ACK/回滚/新pool/撤权、只追加不改IR；完整包与整仓95%门槛、review及精确CI |

候选以ordinary tenant/project/candidateId定位，formal target仅由受信宿主提供。source固定实际原生package/snapshot完整摘要及context摘要；历史读取必须从实际不可变snapshot重建，不能只信digest。候选和审阅各保存完整strict记录（各≤16MiB）及独立columns/checksum，原始候选与人改输出分别保留，时间由受信宿主注入，原ID重试重新授权后保留首次审计时间。

前集不接受命令自报：仅构造器内可信resolver可在同一client解析实际已采用typed ledger，并须与实际native snapshot/object revision/adoption记录核对。没有resolver时非首集失败闭合；库内reviewed记录和旧自由source文字不会被当成前集已采用typed ledger。该resolver的正式生产实现及新typed账本正式采用/回执仍属下一步，不以测试宿主的受信fixture冒充交付。

来源确认使用真实project行锁，顺序始终formal project→candidate advisory。PostgreSQL 16的SELECT行锁需要至少一列UPDATE权限（[官方说明](https://www.postgresql.org/docs/16/sql-select.html)）；专用data LOGIN仅追加两表、SELECT版本元数据，另有原生projects.write_version列UPDATE以取得锁，不授head_revision或版本内容写权，运行实现不UPDATE该列。读走REPEATABLE READ/READ ONLY，不取写锁；prepare/首次review锁住版本头直到同一commit，source变化拒绝首次确认，历史相同决定ACK先授权后返回原结果。

Gate：RED→窄测/types/lint→code/TS/security/DB审查→根串行真实PG与覆盖率→整仓→授权commit/push及精确CI。仅测试安装随机scope/LOGIN，不修改生产角色；旧IR/旧迁移/Method预算保持。回滚撤新入口但保留追加候选和人审；完整T1.5/阶段1及用户后补项保持未完成状态。

## 持久候选与人审验证证据（2026-11-18）

- 新增182项普通测试：安装/角色35、纯人审27、store协议/前集证明112、source5及基本store3。新接口先缺模块RED；实际on/remove监听异常反例发现凭据错误透出与释放路径缺失，修复后统一safe STORAGE_FAILED并始终释放/销毁连接。Code复审发现历史source.packageId独立字段缺绑定，先4pass/1fail，补实际package/context/project一致检查；错包ID即使重算完整prepared摘要也被拒绝。全部182窄测终态0，日志`artifacts/delivery/continuity-persistence-narrow-final.log` SHA-256=`9a65be441c48e58b058b48537d9a1e34f66e1a041d0345d5fef459f5efa0aade`。
- code/TypeScript/security/DB复审无未闭合P0–P2。DB复审指出source FK无子表匹配索引，在新v1首次提交/安装前补`continuity_candidates_source_idx(formal_tenant_id,formal_project_id,source_revision)`，字段顺序测试先RED后GREEN；固定LF与`.gitattributes`覆盖，最终v1 SHA-256=`b9ddff6a212c36ec699fddb7f6306f4da337fff4fb88e8b21d0736c1bfe23e35`，旧迁移字节保持。
- 首轮完整PG1670项通过、1项失败：根权限canary误期望FORBIDDEN，但配置verifier实际已按安全STORAGE_FAILED拒绝额外head_revision权限。更正为既有code+exact operation并增加实际授予→拒绝→撤销后恢复检查，没有放宽权限profile。首轮日志保留`artifacts/delivery/continuity-persistence-pg.log` SHA-256=`2b095332ea3a25f69c4f08f461ea60de839cfd1c7d1bc1e02a5681ae56f41aff`，不将该失败轮判通过。
- 最终串行`pnpm test:script:local --coverage`终态0：1675项=1565普通+110真实PG，80文件，243.61秒；覆盖98.14/96.44/99.47/99.86%，95%门槛保持。新增9项PG完成独立LOGIN完整人改审阅、新pool恢复、原始/人改输出分别保留、源变化后首次review拒绝/理由reject允许/旧ACK保留首次时间、撤权后历史ACK拒绝、8并发仅1候选/1人审、真正COMMIT后丢ACK及真正INSERT后故障回滚、project行锁在commit前确实阻挡独立writer；来源/人审过程没有native业务写入。
- 实际PG前集组合使用同client的显式可信测试resolver读取实际已存reviewed输出及真实native adoption：未采用或无resolver不能给下一集材料，采用后完整事实/知情/人物状态/伏笔继承且下一集真实回收。该fixture不是生产typed账本采用实现。原生head写/新两表UPDATE/DELETE被42501拒绝；额外列、native INSERT、列GRANT OPTION、sequence USAGE与role membership使verifier拒绝，逐项撤销后恢复。column-only write_version权限可取行锁，table-wide UPDATE/head权限为false。source FK实际拒绝孤儿snapshot（23503），索引valid/ready与三列顺序通过，关闭顺序扫描的自有事务EXPLAIN验证source lookup可用匹配索引，不承诺生产成本规划必选。重复migrate账本不变；随机租户/角色/临时对象已清理。
- 最终PG日志`artifacts/delivery/continuity-persistence-pg-final.log` SHA-256=`6ffaf3f567ba494a4350d49e0557269fbe798f3e9c219c532029fefc67578e9c`。最终`pnpm check`终态0：5357项=20工具+5337普通，script1565普通覆盖97.90/96.08/99.21/99.50%，IR579/server1004保持；13包类型成功（10缓存/3执行），13包覆盖率全部实际执行、零coverage缓存，893文件策略零问题，方法6项/Agent10项基线匹配。整仓日志`artifacts/delivery/continuity-persistence-workspace-check.log` SHA-256=`df6e2771aaa6908273351447c105c94db9b6071bf21c26e64bd1f402322fcb40`。PG普通项不重复相加；精确提交的镜像/私有组合仍以随后远端CI实际终态为准。
- 安装与接口边界见`packages/script/CONTINUITY_POSTGRES.md`。本批只交付候选与人审存储及同事务source接口，未启用生产HTTP/页面/新角色，未把reviewed当正式adopted；typed正式采用/回执、生产前集解析器及T1.6定稿消费继续，完整T1.5/阶段1尚未完成。五份用户脏文档与后补安排保持。
