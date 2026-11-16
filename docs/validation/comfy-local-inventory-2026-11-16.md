# T0.7 本机ComfyUI只读盘点

日期：2026-11-16。对应[阶段0真实模板出图验收](../plan/implementation_plan_v2.md)及[现有连接器](../../packages/model-modes/README.md)。这是启动前的只读盘点。**同日后续已启动服务、通过[HTTP/WS连接](comfy-local-connection-2026-11-16.md)，并在用户模型到位后完成[Z-Image-Turbo真实出图与回放](comfy-zimage-live-2026-11-16.md)**；以下无模型/端口未运行仅描述早期检查时点。

## 已验证事实

| 项目 | 启动前检查证据（后续服务状态见连接实测） |
|---|---|
| 桌面程序 | `C:/App/comfy/Comfy Desktop/Comfy Desktop.exe`存在，检查时无Comfy进程 |
| 安装登记 | Comfy Desktop的`installations.json`登记本地独立版包`v0.42.1-env1`、win-nvidia变体；该包号不是当前ComfyUI源码版本 |
| 实际源码 | `%LOCALAPPDATA%/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI`；`comfyui_version.py`为`0.44.2`，实际Git HEAD为`e6515b16ed360b01bd6548bffaca193f88f181fb`，与登记的baseTag/commit相符 |
| 端口记录与当前状态 | 残留配置记录8188；实际GET `http://127.0.0.1:8188/system_stats`返回`ECONNREFUSED`。已在本机用户上下文复核，不将沙箱网络或Git所有权错误作为应用故障 |
| 共享模型配置 | Desktop生成的实例模型路径配置指向`%LOCALAPPDATA%/Comfy-Desktop/ComfyUI-Shared/models`；源码目录未见活动`extra_model_paths.yaml` |
| 模型文件检查 | 共享目录4个普通文件、源码models目录36个普通文件；两者均未发现下列8种扩展名的权重，未发现被跳过的符号链接：`.safetensors/.ckpt/.gguf/.pt/.pth/.bin/.sft/.onnx` |

以上仅限已登记的模型目录和检查时点，不断言整机其他磁盘不存在模型；安装标签或源码存在不等于Python/GPU、节点依赖和工作流已可执行。没有把残留端口文件或进程ID当作当前运行会话，也没有等待一个未运行的服务。

## 操作边界与剩余项

- 本轮只读安装登记、允许范围内的路径配置、源码版本、目录元数据及回环状态；没有读取账号令牌、Cookie或浏览器会话，也未访问登记的云端入口。
- 没有启动或安装模型、下载权重、猜测checkpoint、改Desktop设置、复用用户未保存工作流、调用付费服务、清空队列或发送全局interrupt。
- 真实验收仍需一个可运行的测试节点及其API模板、模型/自定义节点和适用许可范围；若使用本机安装，先由环境所有者准备可测试模型和运行条件。用户此前已说明配置后补，本轮不重复索取凭据，也不以占位图或纯色节点替代模型出图。
- 节点可用后，用[既有ComfyUI连接器](../../packages/model-modes/src/connectors/comfy.ts)完成独立模板提交、同一promptId的状态/WS观察、结果下载、媒体解码与hash记录；提交结果未知时先查历史，不盲目重提。完整生产归档、预算审批与业务采用仍按各自任务实施。
- 本记录不是LIN-002或T0.7完成证据，不激活未实施的本地集成增补。既有223项协议/回放测试保留其原验证范围，本轮未新增或重跑测试，也没有更新真实能力声明。
