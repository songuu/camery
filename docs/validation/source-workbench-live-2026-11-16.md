# 来源工作台实际验收 · 2026-11-16

范围：阶段1 T1.1小说/Fountain/CSV/TSV/DOCX认证导入与分页续读，以及T1.10的来源页。编辑器导出验收、法务签核与设计伙伴确认按用户指示后补，未标记完成。旧DOC/XLSX、StoryBible和十集剧本生成不在本次通过结论内。

## 实际结果

| 检查 | 结果 |
|---|---|
| `pnpm check` | 退出0；20工具测试 + 1873普通测试 = 1893；策略371文件零问题；11包类型检查及覆盖率通过；6章节黄金案例与10 Agent行为基线匹配 |
| `pnpm test:ingest:local --coverage` | 259项 = 247普通 + 12真实PG；语句/分支/函数/行99.49/98.77/99.13/100% |
| `pnpm test:server:local --coverage` | 85项 = 74普通 + 11真实PG；98.33/97.14/100/100% |
| `pnpm test:private-api:local` | 最终镜像2项通过；来源开/关、静态页、独立LOGIN、重启后游标及旧会话撤销 |
| `pnpm test:private-worker:local` | 最终镜像1项通过；预算/人工门禁/崩溃恢复 |
| web普通覆盖 | 72项；纯TS语句/分支/函数/行99.39/100/100/100%；不包含整页TSX交互覆盖率 |
| 浏览器 | 本机已有Playwright Chromium，无安装；全流程14步通过；最终镜像3个fresh context通过 |

所有PG与Compose用例只修改自身随机租户及角色。普通测试被专项包含，不重复累计。最终导入PG覆盖率在整仓检查结束后独立串行复验。

原创小说281370个UTF-16单元、798306个UTF-8字节，含BOM/CRLF/emoji，分2批、10章加前言。遍历分页核对10章；重复上传返回两个重复批次回执且revision仍为2。既有24000游标可向前读12000–24000再向后读24000–36000；只读用户有独立12000游标。DOCX、Fountain、CSV、TSV均经真实上传及预览。来源中的HTML保持文字。

跨项目切换不展示旧来源；只读者无法上传；断开返回204，撤销令牌再用返回401。刷新恢复未连接，localStorage/sessionStorage为空。1440/768/320宽度无横向溢出，截图经人工检查；没有应用JS错误。全流程记录有预期401和切换/断开导致的2次请求取消，不能据此宣称控制台绝无任何事件。

## 镜像与修复

完整14步浏览器流程在`sha256:930615574daa333758b2f7a29b354e356cfdda9eb21e6069d7c6d13918d9493b`上完成。最终镜像`sha256:138eea39d74ff7c7795eddfeed5d0b06cef16312c856ee22501fa3fcf03c359d`只增加后端非法来源列表游标分隔符校验；同一UI资源`index-uOZZ0aWK.js`经3个新上下文复验，Compose亦使用该最终镜像。

浏览器发现原先把原生fetch作为对象方法调用导致接收者错误，已先加回归再改为独立函数调用。复审还关闭：普通请求误用大上传上限、Fastify默认参数长度挡住合法128字符ID、单项数据库权限检查、非DOCX原文摘要不一致、上一段分页间隙、来源元数据投影放大。Windows构建测试只对自身临时目录清理增加有界重试；WS测试改成有界观察远端释放容量且保留其他错误，不放松生产并发限制。核心、TypeScript、SQL/迁移、凭据及不可信输入边界均经过独立复审。

浏览器fixture旧启动宿主出现unsettled top-level await退出，未执行finally；后续清理单独核对容器ID、镜像、固定随机租户与独立角色，再停止并删除自身资源。最终容器退出0；角色、租户、临时凭据均已删除。用户数据库卷和ComfyUI保持运行。

## 本机原始证据

原始文件留在忽略目录`.turbo/source-ui-20261116-2eadaec5-a3fc-4af4-ac4e-d5fe46a81d47/`，不会提交临时凭据或合成正文。

| 文件 | SHA-256 |
|---|---|
| `report.json`（全流程） | `d4f5c182b54fec37fdb7631e76e297fd0e68c9bf1af710ef8721304a28559082` |
| `final-smoke.json`（最终镜像） | `a7f286d0e93ff94f706c65affe7f71e4214681c6dbe4b5836bf5ddf225322fe4` |
| `cleanup.json` | `ab384aff1f3ba082646bf4f82b993c140936a7f0303bc957c365ac48dd6506e2` |

截图为`desktop-connected.png`、`mobile.png`、`final-1440.png`、`final-768.png`、`final-320.png`。最终本机日志在`%TEMP%`：

| 日志 | SHA-256 |
|---|---|
| `camery-phase1-source-ui-check-final3-20261116.log` | `78ca1499d1be0b0f73e7860bd1d11ba877dbc0c478815e42ff868766fe27cd45` |
| `camery-phase1-source-ui-ingest-pg-final2-20261116.log` | `130833a13809c22ceb298ae9765d2f19e44822081e0e5afaf65613db61829ddc` |
| `camery-phase1-source-ui-server-pg-final-20261116.log` | `79b260820c86cd27bdb46ff3685de0f2227afbc4b3f331ea415d1af12298ff69` |
| `camery-phase1-source-ui-private-api-final-20261116.log` | `f8f37942304f05b26d4d014c13977b27273ae70832bc1ec211209520ce50d2e1` |
| `camery-phase1-source-ui-private-worker-final-20261116.log` | `3c2408c99a30286e34a261c1bff43966646b0a46e09ece1d4e4494e637d39c35` |

远端结果以对应提交的GitHub Actions为准，本地通过不提前代替远端通过。
