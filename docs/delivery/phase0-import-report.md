# T0.13 合成夹具与实际导入记录

更新日期：2026-11-16。状态：**媒体与交换文件已生成，编辑器导入 `not_run`**。本记录不构成Resolve、Premiere或剪映兼容性结论，也不代表T0.13完成。

## 可复查产物

生成时间：2026-11-11T15:43:52.412Z（北京时间23:43:52）。本机目录：

```text
E:/project/ai/camery/artifacts/delivery/phase0-2026-11-11T15-43-43-050Z-f8ac2f2c/
```

目录由`.gitignore`排除，不随Git分发；包含`source-a.mov`、`source-b.mov`、`dialogue.wav`、`camery-phase0.fcpxml`、`camery-phase0.edl`和`manifest.json`六个文件。manifest保留工具版本、原始ffprobe JSON、预期切点及SHA-256；`importAcceptance.status`保持`not_run`，`targets`为空。

使用已安装工具重建另一份夹具（默认创建唯一新目录）：

```powershell
node scripts/delivery-fixture.mjs --ffmpeg=C:/App/ffmpeg/bin/ffmpeg.exe --ffprobe=C:/App/ffmpeg/bin/ffprobe.exe
```

[生成器](../../scripts/delivery-fixture.mjs)只实现固定25fps场景，不接收IR或替代生产导出器。显式指定工具路径，不自动安装；输出目录已存在即拒绝，FFmpeg使用`-n`、文档使用`wx`，生成失败保留该次输出并报告阶段。可用`--output=新的绝对目录`指定位置。FCPXML使用绝对file URL，移动目录后应重新生成或在编辑器中明确重连。

## 媒体实测与时间线预期

FFmpeg和ffprobe均为`2026-01-29-git-c898ddb8fe-full_build-www.gyan.dev`。媒体由本机颜色源与正弦波合成，不含外部素材、人声克隆或真实模型输出。

| 文件 | 生成参数与ffprobe核验结果 |
|---|---|
| source-a.mov | 红色、ProRes Proxy、1920×1080、25/1fps、150帧/6秒，无音轨，起始时间码00:00:00:00 |
| source-b.mov | 蓝色、同规格、100帧/4秒，无音轨，起始时间码00:00:00:00 |
| dialogue.wav | 440Hz正弦波、PCM s16le、48kHz、单声道、288000采样/6秒 |

序列25fps、150帧/6秒、非丢帧、起始时间码00:00:00:00。以下out均为排他端点：

| 事件 | 素材 | 源帧范围 | 序列帧范围 | 序列时间码范围 |
|---|---|---|---|---|
| 001 | source-a.mov | [25,75) | [0,50) | 00:00:00:00–00:00:02:00 |
| 002 | source-b.mov | [0,50) | [50,100) | 00:00:02:00–00:00:04:00 |
| 003 | source-a.mov | [75,125) | [100,150) | 00:00:04:00–00:00:06:00 |

FCPXML 1.10将完整6秒WAV连接于首个片段，并跨越两个切点。父片段源start为25帧，连接音频offset也为25帧，对应序列第0帧。CMX3600只有上述三个V/C事件，reel分别为`RED00001`、`BLUE0001`、`RED00001`；WAV是独立伴随文件，EDL不承诺携带多轨音频。

纯色不能仅靠画面证明源in/out，需查看导入后的片段属性；连续正弦波只能辅助核对音频位置/持续时间，不验证对白口型或真实音画同步。后续生产交付仍需带可辨帧标记、声音事件及实际素材的单独验收。

## 完整性记录

生成器SHA-256：`8c00b9bf8908a2dba533f6e9a43e9e026047b84598da591eade8f2bbfd490574`。生成后独立复核五个产物hash及交换文档与当前生成器输出一致。

| 文件 | SHA-256 |
|---|---|
| source-a.mov | da24aa2bd64f4937fd42ea6b4bd0710df58a12cf17e1d35df4388eec57ee326f |
| source-b.mov | f3b99ac3434e2c8af1fa7504f4c773a0283e6a9ab4681a980fd06f6456904591 |
| dialogue.wav | d95110809baa654d98f46192188a7bf4d21a7346d70557a4d5fb7c20b737d899 |
| camery-phase0.fcpxml | a0685adbe8bb0a339e7255ecb0320eb4e3727c863f63eb4b0ebc33efdcb28d52 |
| camery-phase0.edl | cd7ea99c8ca1f0b99a07f2dfe32202023224fc7ea6775f1c0744a4195d99f5f4 |

FCPXML坐标依据见生成器引用的[Apple DTD文档](https://developer.apple.com/documentation/professional-video-applications/document-type-definition)；规范结构检查不替代目标编辑器实际接受。

## 本地代码验证

新增6项夹具测试覆盖精确帧时间码、连接音频坐标、含中文/空格/&路径的XML转义、三事件EDL、CLI参数及拒绝覆盖已有目录。代码与TypeScript独立复审完成，原断言缺口已关闭。最终`pnpm check`退出0，共1529项测试、九包覆盖率门槛及6+10项评测通过；此前整仓失败与测试清理修复记录见[阶段0进展](../plan/phase0-progress.md)。这些检查没有运行编辑器导入。

## 实际操作结果与待执行核对

2026-11-12记录：已发现Resolve可执行文件`C:/App/davinci/Resolve.exe`，文件版本21.0.0.20；当时启动工具返回`Computer Use app approval timed out`，未取得可操作窗口或执行导入。该条是历史事实，不作为2026-11-16的当前阻塞结论。

2026-11-16实际启动记录：

- 当前`cua.computer.launch_app`成功返回，读到“软件更新”和“项目管理器”窗口；对项目管理器执行其公开的`Raise`后，获得正确截图，UI显示DaVinci Resolve 21 PUBLIC BETA及现有本地项目库。未打开或编辑既有工程，未将其名称/缩略图复制入仓库。
- 此前更新通知“跳过”按钮操作返回`coordinate input geometry is unavailable`，曾按Escape尝试取消通知，未下载更新。项目管理器“新建项目”操作返回`point (2006, 736) is outside window bounds { originX: 0, originY: 0, width: 1350, height: 768 }`。随后窗口列表没有Resolve，应用清单`isRunning:false`，只读进程查询也未发现Resolve。没有输入测试项目名称，没有确认任何新项目创建或执行导入。
- 本机`%APPDATA%/Blackmagic Design/DaVinci Resolve/Support/logs/davinci_resolve.log`在10:18:44.660记录`Main thread exited successfully`；该次读取文件SHA-256为`ef7c3793a97b5ccc4509d20e414d886931be5e41544929b8a2ed96f88357ae5a`。这是正常退出日志证据，不认定软件崩溃、GPU故障、格式不兼容或退出原因已定位。日志和现有工程缩略图未复制入Git。
- 已请用户手动打开独立项目`Camery_Phase0_Import_20261116`以越过当前桌面交互问题，用户回复“稍后处理”。停止该编辑器步骤，不改变系统缩放、显示器、GPU、权限或编辑器安全设置，不下载更新、不绕过工具控制。
- manifest继续保持`importAcceptance.status:not_run`和空targets；没有时间线、缺媒、轨道或播放验收结果。之前五个产物hash与生成器/交换文本复核通过不改变此状态。

用户稍后打开独立项目且取得可操作窗口后，执行以下步骤；每项保留版本、设置、结果和可复查证据，失败记录原始报错：

1. 记录实际Resolve版本/Free或Studio，建立独立项目，确认25fps、序列起点0；保持现有用户项目与媒体。
2. 导入FCPXML，检查媒体是否全部在线、三段顺序A/B/A、150帧总长、50/100帧切点；逐段查看源in/out，核对非相邻复用。
3. 核对独立音频从序列0至150帧，48kHz单声道，跨两个切点无拆断/偏移，检查播放和波形。实际音轨布局以观察为准，不能从FCPXML的lane直接宣称目标轨道结果。
4. 独立导入EDL，记录reel/文件名匹配设置，核对同一视频切点与源范围；再明确导入伴随WAV并对齐0，单列手工音频步骤。
5. 分别记录导入成功/失败、缺媒、偏移或格式降级；保存独立测试项目的证据位置，不以“能打开”替代时间线验收。只在真实核对后填写目标验收结果。

Premiere及剪映/CapCut在此前限定安装目录/注册表范围未检出可操作版本，仍待取得实际版本后各自测试；不推断整机不存在，不推断它们接受本夹具。当前不涉及OTIO、特效、转场、字幕、多帧率、AIGC标识或授权合规验收。
