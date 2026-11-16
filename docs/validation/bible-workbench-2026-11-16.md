# StoryBible 应用验收 · 2026-11-16

范围为[SB-1..SB-6](../plan/storybible-phase1.md)的应用接线：认证API、运行目录/轻量状态、冻结原文、显式审阅、可配置的独立文本宿主。真实文本模型质量与真人评分仍未验收；编辑器、法务和设计伙伴确认依用户指示后补。

## 已验证

| 检查 | 实际结果 |
|---|---|
| `pnpm check` | 退出0；20工具+2279普通=2299测试；442文件策略零问题、lint与12包类型检查（11缓存/1实际）、12包覆盖率全部实际执行；6方法golden/10 Agent基线通过 |
| Bible PG+覆盖率 | 16文件275测试=265普通+10PG；98.43/97.94/97.88/99.81%（语句/分支/函数/行） |
| Server PG+覆盖率 | 23文件131测试=116普通+15PG；98.31/96.71/100/100%；包含三个独立LOGIN、十章合成抽取、审阅重启、新鲜度及会话撤销 |
| 新宿主真实HTTP协议夹具 | OpenAI实际HTTP adapter、usage/id保留、预算持久化、重建宿主不重发；14类额外权限canary明确拒绝 |
| 浏览器 | Chromium1208，3个独立context重复完整流程；另4项竞态/只读/过期测试；320px无横溢、无pageerror、截图实际查看 |
| 镜像/Compose | 新三入口镜像构建退出0；原API2项、原章节worker1项真实容器测试通过；Bible叠加配置quiet校验通过；新Bible入口在镜像内无配置时按预期退出1并固定脱敏信息 |
| 依赖审计 | 授权网络下`pnpm audit --prod --audit-level high`退出0，No known vulnerabilities found；先前10013网络失败不算通过 |

API测试校验viewer/reviewer不能开始，editor不能审阅，tenant/user/actor/model/URL/approved注入被拒绝。确认只扩大自身body上限至2MiB；普通请求保持16KiB。状态轮询不读完整source，目录微秒游标绑定scope/filter，0002索引匹配C排序，0001 checksum未改变。

真实PG十章验收通过受限auth/Bible/task三池：开始→逐块预算执行→候选→显式分组确认→重启回显；来源追加后新候选首次确认409、冻结引文不变、允许显式拒绝；撤销角色与会话随下一请求生效。模型响应来自明确的协议夹具，不能作为真实文本推理质量或实际账单证据。

浏览器从凭证连接/来源阅读进入知识页，核对原文、保持默认独立身份、显式合并/拆分、拒绝实体后仍保留关联并禁确认，用户明确取消关联后才确认。确认body仅含ReviewDecision，服务端审核者真实来自fixture认证身份，刷新后只读。覆盖同源两次新提取使用不同runId、整体拒绝、Bible403返回来源显示权限错误、401清连接、迟到旧run详情及断开期间审阅回执不串新会话、延迟首次status和刷新不重置草稿、viewer只读、过期禁确认但保留拒绝。

审查关闭4项实际问题：历史分组ID碰撞；成功后复用旧runId；403清项目后空白；首次status改变detail查询键导致草稿卸载。保留状态序列单测和实际浏览器回归。Windows构建失败路径的目录清理增加与成功路径一致的有限重试，不改变断言。一次并行coverage争用同一报告目录，已串行重跑全部相关检查通过，失败结果不计通过。

代码、TS、安全及数据库审查均完成；数据库审查未运行EXPLAIN，不能声称实际执行计划已测。SQL由真实PG测试执行，运行角色未获安装/扩权能力。测试只清理随机自有租户/角色/canary，浏览器自建服务和进程均已关闭。

## 本机证据

| 日志/产物 | SHA-256 |
|---|---|
| `%TEMP%/camery-bible-application-check.log` | `e3faf73c3b3c7e2ca93a41b04e3f3940f9a31430fb6f9ef49d38d4052f468ea7` |
| `%TEMP%/camery-bible-http-pg-coverage.log` | `e17e250527cf6fc8016cd683b68ab4e6e49b38485ba36d5f2161fb4238ff5c7d` |
| `%TEMP%/camery-bible-catalog-pg-final.log` | `e2fae2e62addf51abd2ed46258a0d08f04db981ede4a26578f910569c58fa005` |
| `%TEMP%/camery-bible-application-image.log` | `abee7e54db410f9899346c18d55965bb937e15052201e6a291fe308493fd6e1c` |
| `%TEMP%/camery-bible-application-compose-api.log` | `2f8c2309632ce4eb943716728804055336759e14293f1efa21451b4c530a9591` |
| `%TEMP%/camery-bible-application-compose-worker.log` | `7d268ddedd358b4e350f48ac3299819bc27646e87e14de7a9ba08ed56aed0a80` |
| `artifacts/delivery/bible-browser/result.json` | `62aec8944d22eefa39f077795be7f81e49452fa033688f3eab3157a667aa1caa` |

浏览器本机产物另有report.html、JUnit、trace-1..3.zip、desktop/candidate-desktop/mobile320截图与verify.mjs。该忽略目录不提交，服务夹具保存在`packages/server/test/fixtures/bible-browser.ts`，可检查其合成证据来源。

## 未完成与部署边界

本机未提供实际文本供应方、模型、价格和令牌配置。生产不会synthetic fallback；无文本配置的API仍可读取/审阅已有候选，禁止开始，worker拒绝启动。真实十章语义质量、真人评分及阶段1其他模块不能据此判定完成。ComfyUI图像能力与文本抽取分开验收，本轮未改其服务。

新服务与新角色未自动启用到用户常驻环境；[部署说明](../../packages/server/BIBLE-POSTGRES.md)给出显式安装/预算/密钥/叠加配置。远端CI必须核对本次最终提交的实际Actions结果，本机日志不能替代。
