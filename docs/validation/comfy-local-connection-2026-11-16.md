# T0.7 本机ComfyUI连接实测

日期：2026-11-16。按用户“必须要连接上comfyui”的要求，已启动本机服务，**Camery现有HTTP/ComfyUI/WebSocket连接器真实连接通过**。本记录描述最初的连接阶段；同日模型到位后，另完成[Z-Image-Turbo真实出图与回放](comfy-zimage-live-2026-11-16.md)。服务保持后台运行，两个阶段的证据分开记录。

## 实际运行环境

| 项目 | 实测值 |
|---|---|
| Web / API地址 | `http://127.0.0.1:8188/`；仅监听127.0.0.1 |
| ComfyUI | `0.44.2`；Git HEAD `e6515b16ed360b01bd6548bffaca193f88f181fb` |
| 实际Python | `%LOCALAPPDATA%/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Scripts/python.exe`，版本3.13.12 |
| PyTorch / GPU | `2.12.1+cu130`，CUDA可用；NVIDIA GeForce RTX 5070 Ti |
| 监听进程 | 本次观测PID 27304；启动器曾返回27656，实际服务身份以当前8188监听进程为准 |
| 日志 | `%TEMP%/camery-comfy-c5da8368/stdout.log`及`stderr.log`；没有将原始日志加入Git |

直接运行外层`standalone-env/python.exe`最初报缺少torch；随后找到源码内既有`.venv`并自检通过，没有安装/更新依赖或修改Python环境。此前[只读盘点](comfy-local-inventory-2026-11-16.md)的端口未运行结论已被本次实际启动取代。

## 启动方式与进程边界

使用上述虚拟环境，在源码目录运行`main.py`，显式传入：

```text
--listen 127.0.0.1 --port 8188 --disable-auto-launch
--extra-model-paths-config <Desktop现有实例模型路径YAML>
```

实际YAML从`%APPDATA%/Comfy Desktop/instance-model-paths`的现有本地安装配置取得，沿用已登记共享模型目录。以隐藏窗口后台进程运行并分别保存stdout/stderr；启动后等待同一进程的HTTP就绪，没有因为早期拒绝连接重复启动实例。没有启动Desktop外壳、改其持久设置、开放公网监听或新增凭据。

服务会占用8188；后续使用当前地址即可。若需切换到Desktop管理的实例，先核对当前监听进程，再按实际需要停止本次后台实例，避免重复占用。停止前应核对实时PID、可执行文件和命令行，不根据本文旧PID直接结束进程。本次按连接请求保持服务运行，没有设置开机自启。

## Camery真实连接结果

探针直接加载仓库[现有连接器源码](../../packages/model-modes/src/index.ts)，使用`NodeHttpTransport`、`ComfyUiConnector.health`及`NodeWebSocketTransport.events`，没有使用模拟服务或回放cassette。

本次连接参数为：

```json
{
  "tenantId": "phase0-local",
  "connectionId": "comfy-local",
  "baseUrl": "http://127.0.0.1:8188/",
  "allowPrivateNetworks": true,
  "allowInsecureHttp": true,
  "timeoutMs": 10000,
  "maxInFlight": 2,
  "webSocket": { "sessionMs": 10000, "maxConnections": 1 }
}
```

这些是本次受信本机探针的作用域与参数，不是新增业务成员、云端账号或已持久化的产品连接管理记录。请求只读取本机；没有访问云端入口或读取密钥。

| 核对 | 实际结果 |
|---|---|
| GET `/system_stats` | HTTP 200；ComfyUI 0.44.2及CUDA设备返回正常 |
| `ComfyUiConnector.health` | `{reachable:true, devices:1}` |
| GET `/queue` | HTTP 200；running=0、pending=0 |
| GET `/object_info/EmptyImage` | HTTP 200，核心节点存在；仅供健康探针构造器使用，没有提交该节点生成图片 |
| GET `/object_info/CheckpointLoaderSimple` | HTTP 200，checkpoint可选列表长度0 |
| WebSocket `/ws?clientId=<本次唯一ID>` | 收到初始`status`，探针退出时关闭自己的连接 |
| Web入口GET `/` | HTTP 200、`text/html`；未据此宣称浏览器视觉/E2E验收 |

Camery组合探针退出0，`submittedWorkflows=0`。调用上下文摘要仅标识本次连接探针，不冒充已经验证/发布的模型模式pin。没有发送`/prompt`、清空队列或全局interrupt。

## 验收范围

同日后续出图准备：用户告知模型正在下载，本任务没有另起下载。已只读解析当前安装的`script_examples/basic_api_example.py`中API格式默认工作流，对照实际`/object_info/{class}`核对7个节点、6类节点、9条有向类型连线及必填输入，预检通过。等待后重新读取模型列表仍为空，下载保存路径尚未取得；没有提交工作流，不能将预检或用户下载意图记为模型就绪或真实出图。

连接阶段checkpoint列表为空，尚无真实出图证据。后续用户将Z-Image-Turbo放入`diffusion_models`，并有Qwen3编码器；补齐VAE后已用分体加载方式完成独立出图/回放。该模式不依赖CheckpointLoaderSimple，不能继续把checkpoint列表为空当作所有模型不可用，详见[后续实机验收](comfy-zimage-live-2026-11-16.md)。最初未提交的EmptyImage节点和健康请求仍不作为出图证据。

本轮没有生产源码、依赖、数据库或既有能力声明变更，没有新提交/推送。现有223项协议测试未重跑；以上是本次实机连接检查，不计为新增自动测试。
