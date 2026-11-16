# 来源工作台

按[ADR-009](../../docs/adr/009-frontend-workbench.md)使用React、Vite、TanStack Query与内存Zustand。当前提供T1.1来源导入与续读页，不宣称已实现项目向导、StoryBible、剧本编辑/采用或完整账号管理。

本地开发先启动已配置的API（3000端口），再运行`pnpm dev:web`（仅监听127.0.0.1:5173，`/api`固定代理到本机3000）；生产构建运行`pnpm --filter @camery/web build`，静态目录交给同源API提供。无外部字体、脚本CDN或遥测。

连接时使用受信安装者签发的访问凭证，表单为password且提交后清空。凭证仅保存在JS私有字段，不写入localStorage/sessionStorage、URL或日志；断开会清理身份与所有Query缓存，并请求服务端撤销会话。HTTP请求同源、拒绝重定向、禁用缓存、30秒超时。401清连接，403清当前项目与来源缓存；迟到请求受会话代次、项目和操作身份约束。

上传保留原始字节，UTF-8解码失败明确拒绝，保留BOM/CRLF与emoji。小说客户端固定25万UTF-16单元一批且不拆代理对，文件摘要与批次序号组成幂等身份；重新选择同一文件可恢复已完成批次，遇其它上传插入导致的批次顺序变化时停止。小说文件最多64MB、解码后1600万单元，其它格式最多8MB；服务端仍独立核验所有输入。显示标题最长200字符，原始正文不因显示截断而改写。

来源列表每次加载50条；预览默认12000、最多20000个UTF-16单元与200个相交结构单元。上一段按服务端`before`边界返回紧邻前文，UTF-16代理对不被拆开；写入游标仍严格校验。所有正文均为React文本节点，不执行HTML/Markdown或来源中的指令。小说阅读游标只写当前认证用户；只读角色可保存自己的阅读位置，不能导入。Word暂支持DOCX正文，旧DOC/XLSX不支持。

`pnpm --filter @camery/web test:coverage`检查HTTP客户端、会话与上传编排等纯TS逻辑；TSX视图由SSR边界测试和真实浏览器验收覆盖，不把纯TS覆盖率当作整页交互覆盖率。`pnpm --filter @camery/web typecheck`和`build`验证完整前端。
