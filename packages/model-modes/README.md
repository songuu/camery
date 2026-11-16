# @camery/model-modes · 模式注册表与连接器

T0.7 的本地可验证部分：不可变模式版本、能力证据、分层提示编译、受限 HTTP/WebSocket 连接、OpenAI 兼容 LLM、ComfyUI 进度会话与重连、fal 队列，以及显式录制/离线回放。

2026-11-16已在本机ComfyUI 0.44.2通过[HTTP/WS连接实测](../../docs/validation/comfy-local-connection-2026-11-16.md)，并用用户下载的Z-Image-Turbo及Qwen3、补齐的官方VAE完成[一次1024×1024真实出图、下载/解码与独立离线回放](../../docs/validation/comfy-zimage-live-2026-11-16.md)。实际仅提交一次，29条HTTP交换回放一致；分体模型使用UNET/CLIP/VAE加载，checkpoint列表为空不影响此模式。服务地址`http://127.0.0.1:8188/`。其他LLM/中转供应商真实冒烟仍待配置，一次出图不代表通用质量或生产归档完成。此前的服务端403已恢复，WebSocket增量已完成独立复审；Unicode转义凭据回显已有回归，生产依赖审计未发现已知漏洞。

## 验证与来源

```sh
pnpm --filter @camery/model-modes typecheck
pnpm --filter @camery/model-modes test
pnpm --filter @camery/model-modes test:coverage
```

包已接入根 `pnpm check` 与四项 ≥95% 覆盖率门槛。协议来源是 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[ComfyUI 服务路由](https://docs.comfy.org/development/comfyui-server/comms_routes)、[fal 提交](https://fal.ai/docs/api-reference/inference-api/queue/submit-path)、[状态](https://fal.ai/docs/api-reference/inference-api/queue/status)和[结果](https://fal.ai/docs/api-reference/inference-api/queue/result)，不能从协议兼容推断任意具体模型的能力或可用性。

[providers.synthetic.json](test/fixtures/providers.synthetic.json) 由本地 HTTP 协议模拟器录制，含明确的 synthetic_contract 来源；测试随后关闭服务，仅凭 cassette 完成回放。`SyntheticNode` 及三字节输出只是协议占位，不能提交到真实节点或解释成生成图片。黄金文件更新需显式检查协议/模式变更后运行 Vitest 的快照更新操作。

## 模式版本与能力证据

`ModelModeRegistry.register(definition)` 用严格 schema 验证并复制模式。相同 id/version 相同内容幂等，不同内容拒绝；升级必须注册新版本。`pin(id, version)` 返回冻结的 `{ id, version, digest }`；`resolve(pin)` 只从受信注册表读取对应内容，不接受客户端提供的完整定义替代。已入队任务持有旧 pin，之后安装新模式不改变旧任务。

每项能力记录 value、source、modeVersion、verification 和 evaluationIds：

- 时长范围、参考图数、首/尾帧、原生音频和口型。
- 画幅、分辨率、图像/音频/视频/文本槽位及并发信息。
- 提示词软/硬长度及字符、字节或 token 单位。
- 成本模型、币种/计量单位；未知费用保留 null。

证据适用版本必须匹配模式；locally_verified 必须有评测引用。质量统计需有有效分子/分母和评测记录，不从缺失数据生成通过率。这些是受信维护者的版本化声明，库不会自动核验源网站或评测正文，不能把注册成功当作模型能力实测成功。

`compile(pin, input)` 根据 anchor/keyframe/video/text 对应 recipe 组装声明的字段，按 rank 排参考图，检查已声明且非 unverified 的能力。keyframe/video recipe 禁止引入 anchorLighting 字段；艺术质量仍需实际审片。未知/未验证的参考、帧、时长等请求不会当作已支持。软长度超限返回警告，硬限制拒绝；token 限制缺少对应 tokenizer 时明确返回 TOKENIZER_REQUIRED，不用字符数假冒 token 数。当前编译参数承载图像参考，其他模态槽位仅为能力档案，具体输入适配仍需各模式补齐。

## HTTP 与凭据边界

`NodeHttpTransport` 由受信宿主创建，固定 tenantId、connectionId 和 baseUrl。请求只提供相对路径和结构化正文，不能覆盖授权头或把模型返回 URL 当作连接目标。

- 默认只允许 HTTPS 和公网地址。ComfyUI 内网/回环 HTTP 必须分别以布尔 true 明确开启 allowPrivateNetworks、allowInsecureHttp；字符串 `"false"` 等配置会被拒绝。
- DNS 查询返回的地址全部检查，并将实际套接字固定到已检查地址，Host/TLS SNI 使用原主机名。不会跟随重定向，也不会自行重试；可信内网配置的范围仍由宿主控制。
- maxInFlight 是本进程连接容量，不能冒充远端并发能力或跨进程限流。超时涵盖 DNS、凭据解析和响应读取；请求默认 ≤1MiB、响应默认 ≤4MiB，均有显式配置上限。
- 凭据只在发送层按 credentialRef 解析，连接器、模式定义和调用正文不持有密钥。JSON 字符串值中的实际凭据会脱敏；响应头、JSON 属性名或二进制中回显实际凭据时拒绝返回，避免日志/cassette 泄漏和结构损坏。
- 错误只带本库代码、阶段、HTTP 状态和 outcome，不带供应商错误正文、请求参数或原始异常堆栈。

`CallContext` 带 tenantId、connectionId、modeDigest、idempotencyKey 和 AbortSignal。连接作用域必须匹配；身份和 pin 由宿主生成/核对，不从模型或请求自报字段授予权限。这里没有会话认证、RBAC、密钥加密存储或面向公网的端点，仍需 T0.9/T0.10 服务接入。

outcome 区分 not_sent、unknown、rejected、completed、not_applicable。提交已发出后的网络故障、超时或异常回包保持 unknown；录制失败也不能把已返回请求伪装为 not_sent。调用方应将每次付费提交放入 durable 的 external 步骤；任何 idempotencyKey 都不能自动变成供应商的去重保证。

## 三种连接器

| 接口 | 当前行为与边界 |
|---|---|
| `OpenAiCompatibleLlm.complete(request, ctx)` | 一次 Chat Completions 请求；配置声明 json_schema 或 json_object，严格解析 JSON，并执行宿主同步输出校验；拒绝/截断/非法输出显式报错，已发生的调用不冒充未计费 |
| `OpenAiCompatibleLlm.repair(request, previous, newCtx)` | 调用者显式发起的一次修复，要求不同 idempotencyKey；需要单独预算/日志，不自动重试未知请求 |
| `ComfyUiConnector.compile/submit/poll/download/health` | API 格式模板仅替换明确映射的现有字段；/prompt 返回 ID，/history 与 /queue 查询状态，/view 返回字节；健康查询只证明响应，不证明 GPU/工作流可用 |
| `decodeComfyProgress(message, promptId)` | 过滤其他任务事件，解码进度/错误；执行成功消息仅要求后续查 history，不直接标记产物成功 |
| `ComfyProgressSession.watch(promptId, clientId, ctx, onProgress?)` | 监听已有任务；初始、定期、终态提示及断线时查询 HTTP 状态；有限重连后继续 HTTP 轮询，不重新提交或全局中断 |
| `FalQueueConnector.submit/poll/result` | 固定配置 owner/app[/path]；忽略远端返回的跳转 URL，以配置路径和验证后的 ID 查询；COMPLETED 单独不标成功，因为其中也可能包含失败/取消，需另外读取结果 |

OpenAI 兼容不等于所有第三方模型支持严格 schema；具体 model ID、输出方式和限制由模式维护者提供。令牌统计仅保存远端报告的有效数值，没有报告时为 null，不伪造成本。

ComfyUI 的模板必须从实际节点导出并核对可用节点/模型，不能执行任意脚本模板或猜测 checkpoint 名称。路径映射、文件名和相对子目录有边界检查，下载不写磁盘；全局 /interrupt 不作为某个任务的安全取消接口。

remote_succeeded 只表示连接器取得了相应远端成功证据；没有在这里设置 MediaAsset.ready。下载、媒体探测、实测时长、哈希与素材入库仍由 T3.7 等后续工作实现。

## ComfyUI 进度会话

`NodeWebSocketTransport(connection)` 复用 HTTP 的基础 URL、网络策略、作用域、DNS 固定与凭据解析，将 http/https 转为 ws/wss。只允许受限相对路径，不跟随 upgrade 重定向；TLS 验证开启，压缩关闭。文本回显实际凭据时拒绝，二进制预览只计数，不交给进度处理器或当作生成结果。

`connection.webSocket` 可配置 sessionMs、maxConnections、maxFrameBytes、maxBufferedBytes、maxBufferedMessages、maxMessages；默认分别为 connection.timeoutMs、1、4MiB、1MiB、128、10000。所有值必须是有上限的正整数。握手超时包含 DNS 与凭据解析；会话另有总时限。HTTP maxInFlight 与 WS maxConnections 分开计数，长连接不会占用 HTTP 查询槽位。远端关闭、取消、错误、超时及消费者退出都会释放资源；消费者停读时仍执行会话时限与缓冲上限。

用 `new ComfyProgressSession(connector, socketTransport, options)` 组合 HTTP 查询与进度流。`clientId` 必须传原提交时的 `CallContext.idempotencyKey`；宿主应把它和返回的 prompt ID 一同保存，恢复监听时继续使用。监听上下文可以使用新的查询身份，不能靠换 clientId 创建第二份任务。该库不从远端证明 clientId 与任务的归属关系，身份授权仍由宿主保证。

监听默认最多重连 2 次，重连间隔 1000ms，查询间隔 1000ms，总时限 300000ms；可用 maxReconnects、reconnectDelayMs、pollIntervalMs、maxMonitorMs 调整。普通断线或进度会话超时可重连；认证、非法消息、秘密回显和缓冲限额错误直接报错。重连预算用尽后保留 HTTP 轮询，只有查询得到 remote_succeeded/failed 才返回终态。成功/失败事件只是提示，不覆盖查询结果。

每条流最多一个待完成的 next()，周期查询不会产生遗留读取。进度回调按顺序 await，也受监听总时限约束；回调异常只返回安全错误代码。取消/超时停止本地监听，不取消远端生成；注入的回调或传输若忽略信号，库会观察迟到拒绝，但无法强制停止其内部代码。

[回环组合测试](test/comfy-session.integration.test.ts) 实际运行 HTTP 与 WebSocket 服务，断开首个连接并以原 clientId 重连，通过历史确认已有 prompt 的结果；断言没有提交或中断请求。这仍是 synthetic 协议验收，文件名和输出描述不代表真实出图。

## 录制与离线回放

`RecordingTransport(upstream, provenance)` 是显式启用的内存包装器。请求只保存指纹，响应脱敏后存储；授权类字段和 URL 用户信息/查询/片段会从 cassette 清除，输出内容仍可能含业务数据，导出文件由受信宿主管理。库不自动写文件或公开日志；最多 1000 个交换，导入/导出序列化上限 64MiB。当前总内存仍需宿主按任务预算控制。

`exportCassette()` 在所有交换结束后返回严格版本化数据；并发按调用开始顺序记录，不因响应先后而交换位置。`ReplayTransport(cassette)` 没有网络 fallback，严格匹配租户、连接、模式摘要、幂等键、请求指纹和顺序；错误也按记录回放。`assertComplete()` 检查无漏消费记录。脱敏后的回放内容不等于供应商原始响应，更不证明真实服务、费用、模型质量或媒体已经验证。

后续仍需：用户配置后的真实节点/供应商冒烟、各具体模式模板/编译器和评测发布、跨进程限流、远端对账自动化、产物验证落盘、服务权限与凭据存储。T0.7 的本地检查不替代阶段 0 整体验收。
