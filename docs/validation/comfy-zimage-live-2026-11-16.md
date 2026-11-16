# T0.7 Z-Image-Turbo真实出图与回放验收

日期：2026-11-16。对应[实施计划阶段0](../plan/implementation_plan_v2.md)的“ComfyUI连接器用模板工作流在测试节点出图”和录制/回放。结论：**Camery现有连接器在本机ComfyUI完成一次真实模型出图、产物下载/解码和独立进程离线HTTP回放**。不将此项扩大为阶段0整体、所有供应商或模型质量验收完成。

## 模型与工作流来源

用户提供已下载的`diffusion_models/z_image_turbo_bf16.safetensors`，并已有`text_encoders/qwen_3_4b.safetensors`。实际模型是分体加载的Z-Image-Turbo，不能沿用之前的SD checkpoint默认工作流；`CheckpointLoaderSimple`列表为空不再表示本模式不可用。

依据[ComfyUI官方Z-Image示例](https://comfyanonymous.github.io/ComfyUI_examples/z_image/)读取示例PNG的API工作流元数据，再按本次固定测试提示词、种子和唯一输出前缀生成独立工作流。缺失的VAE从[Comfy Org模型仓库](https://huggingface.co/Comfy-Org/Z-Image-Turbo)固定版本`6fc90a3b1b653e935a0d175e260736de25b84df5`补齐，下载335304388字节；临时文件完整校验后才发布为`vae/ae.safetensors`，未覆盖已有文件。

该仓库模型卡标注Apache-2.0；这是本次技术测试的来源声明，不替代客户具体用途的许可核验或法务签核。三个文件均流式核对大小、SHA-256及检查前后mtime/size，未改写用户模型：

| 组件 | 实际字节 | 官方元数据与本机一致的SHA-256 |
|---|---|---|
| z_image_turbo_bf16.safetensors | 12309866400 | 2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6 |
| qwen_3_4b.safetensors | 8044982048 | 6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a |
| ae.safetensors | 335304388 | afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38 |

## 实际执行

节点为UNETLoader、CLIPLoader（lumina2）、VAELoader、CLIPTextEncode正/负条件、EmptySD3LatentImage、KSampler、VAEDecode、SaveImage，共9个节点。提交前实际查询每类`/object_info`，核对必填输入、类型连线与模型/枚举选项；队列为空才开始。

| 项目 | 实测记录 |
|---|---|
| 服务 | 本机`http://127.0.0.1:8188/`；ComfyUI 0.44.2，源码`e6515b16ed360b01bd6548bffaca193f88f181fb` |
| 运行环境 | Python 3.13.12，PyTorch 2.12.1+cu130，RTX 5070 Ti；沿用既有虚拟环境 |
| 画幅 / 批次 / 种子 | 1024×1024 / 1 / 20261116 |
| 采样 | 9步，CFG 1，euler / simple，denoise 1；BF16主模型 |
| 提示词语义 | 一只带弧形把手的红色陶瓷杯、浅色木桌、自然窗光、简单背景；无人物、文字或logo |
| HTTP提交次数 | **1**；未知结果不自动重提 |
| promptId | `2fa838ff-e12b-4aec-ac94-50f4aafcc4ef` |
| clientId | `52ad7810-32e2-491a-bdfe-e6045062d2ba`；监听沿用原提交身份 |
| 工作流摘要 | `sha256(JSON.stringify(workflow))`=`4e1fab887e28ad26e6807772941d13bba06f242a8c02ebbdc886e6088c6a2462`；不是pretty JSON文件字节摘要 |
| 进度与终态 | WebSocket执行/进度共17项；最终由HTTP history确认`remote_succeeded`，不只根据成功事件认定 |
| 完成时间 | `2026-11-16T03:25:10.460Z`（北京时间11:25:10）；服务日志记录执行约13.14秒 |

调用直接使用现有`ComfyUiConnector`、`NodeHttpTransport`、`ComfyProgressSession`、`NodeWebSocketTransport`与`RecordingTransport`，不是裸HTTP脚本替代产品连接器。调用上下文的摘要固定本次工作流，模型字节另由来源记录固定；没有发布新的全局ModelMode或把一次成功转成通用能力/质量统计。

## 产物和离线回放

下载来自该prompt的唯一输出`camery_phase0_zimage_52ad7810_00001_.png`。连接器取得的字节与服务原输出逐字节一致；ffprobe识别PNG、1024×1024、rgb24，FFmpeg完整解码退出0。

| 项目 | 结果 |
|---|---|
| 图片大小 / SHA-256 | 1029084字节 / `75c48b28df7c164b290d33a5adaaf384dcf57e0a270f8852cf45abadf3b33ee2` |
| 图像观察 | 助手视觉检查可见红杯、把手、木桌及自然窗光；未作人工审片签核或艺术质量评分 |
| 录制 | `live_provider`来源，29条HTTP交换；未替换现有synthetic黄金cassette |
| 回放 | `ReplayTransport`逐一重演16个submit/poll/download操作，结果一致并`assertComplete` |
| 独立回放复核 | 另一个进程将HTTP、HTTPS、TCP、TLS、DNS及fetch调用改为拒绝；仍消费全部29条交换，网络尝试0，下载图像摘要一致 |

这里“离线”指无网络fallback的HTTP操作回放及进程内网络拒绝验证；不是操作系统断网测试，也不是WebSocket事件流回放。本轮未注入真实WS断线/重连或杀生成进程，不把既有合成故障测试记作本轮实机证据。

## 本机可复查记录

目录（已被Git忽略，不随克隆分发）：

```text
E:/project/ai/camery/artifacts/delivery/comfy-zimage-20261116-uGqBpz/
```

包含12个文件：`model-provenance.json`、`workflow.json`、`attempt.json`、`submission.json`、`image.png`、`cassette.live.json`、`journal.json`、`progress.json`、`result.json`、`media-verification.json`、`offline-replay-verification.json`和`manifest.json`。manifest记录其他11个文件及9份关键Camery源码的SHA-256；回执在提交后立即保存，避免观察中断时盲目另提任务。

本轮没有修改生产源码、依赖、数据库、能力声明或评测基线；没有额外生成图片、调用付费API、清空队列、发送全局interrupt或改用户既有工程。服务保持运行。上述是单次实机验收，不增加已有自动测试计数，也未重跑整仓1529项。

## 剩余范围

本次补齐T0.7的一个真实ComfyUI模板出图场景。其他LLM/中转服务真实冒烟、更多模式/参考图/视频/取消能力、生产素材归档与正式采用仍按各自任务验证；本图片未进行AIGC标识或客户授权合规验收。法务/产品签核、设计伙伴和编辑器交付等阶段0剩余项不由本次出图替代。
