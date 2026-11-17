# 原创开发服务与常驻宿主

本档案接入阶段1 T1.3的创意brief、世界观/人物/主线候选、人工编辑审阅和分集候选。它复用API镜像的`development-worker.mjs`入口及已有durable/预算账本；每阶段独立任务，宿主不自动确认、采用、结算或配置项目预算。正式开发IR/ChangeSet与真实文本模型质量仍按[完整计划](../docs/plan/original-development-phase1.md)继续。

## 安装边界

安装身份先显式执行`migrateDurable`、`migrateAgents`和`migrateDevelopment`，核对已应用迁移校验和。三个运行LOGIN分开：认证API身份只拥有既有认证/来源能力；development数据身份仅`camery_script`四表SELECT/INSERT；development任务身份仅已有durable/预算工作流能力。后两者由`grantDevelopmentRuntimeRole`和`grantDevelopmentTaskRuntimeRole`显式安装，启动仅验证。共享task角色校验拒绝REPLICATION、schema USAGE转授权、其他角色成员关系、额外表/列/sequence能力，不能使用数据库管理员或数据身份代替任务身份。

授权成员与会话依既有[API安装方式](../packages/access/POSTGRES.md)创建。安装者另用`PostgresBudgetLedger.createProject`初始化同一tenant/project与币种的项目预算。每个新run使用两份固定reservation，run总tokens/cost上限必须覆盖两份预留且steps至少2；全项目预算是跨运行共享上限，不能只按单run预算配置。运行身份不能创建项目预算、改额度或将预留自动结算；unknown使用既有受信operator完整回执对账。

API和worker都不在启动时安装schema、创建角色、授予权限或联系模型。应先备份数据库并完成上述安装；失败关闭功能或回退镜像，保留追加历史，不删除结果和预算日志。

## 保存创意和浏览已有运行

复制[配置示例](./.env.development.example)为本机`deploy/.env.development`，填写授权项目与两个受保护URL文件路径。URL中容器数据库地址为`postgres:5432`，用户名/密码按URL编码；遵循[secret文件权限说明](./README.md)，保证容器UID 1000可读。原始URL、令牌和正文不能进入构建参数或版本控制。

```sh
docker compose --env-file deploy/.env --env-file deploy/.env.api --env-file deploy/.env.development -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.development.yml config --quiet
docker compose --env-file deploy/.env --env-file deploy/.env.api --env-file deploy/.env.development -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.development.yml build api
docker compose --env-file deploy/.env --env-file deploy/.env.api --env-file deploy/.env.development -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.development.yml up -d --wait api
```

不加text叠层时可以经认证保存/修改创意、读取历史和审阅已有候选，capabilities明确未配置文本模型，开始新生成被拒绝。前端的默认10集是编辑器初值；集数、每集规划时长和创意由用户明确提交。GET/poll和重开页面只读取现有状态，不发模型请求。

## 开启文本模型和worker

文本配置文件为有界UTF-8 JSON，字段如下；示例的预留仅展示格式和预算关系，**不是已验证的价格或账单**。实际供应方须支持选定的OpenAI兼容结构化输出。未知价格省略`pricing`但保持正cost预留；有可信价格时可添加`pricing.inputMicrosPerMillionTokens`和`outputMicrosPerMillionTokens`两个非负安全整数。

```json
{
  "label": "项目文本模型",
  "baseUrl": "https://models.example/v1",
  "connectionId": "development-text",
  "modelIdentity": "your-text-model",
  "structuredOutput": "json_schema",
  "timeoutMs": 120000,
  "allowPrivateNetworks": false,
  "allowInsecureHttp": false,
  "currency": "CNY",
  "reservation": {"tokens": 32768, "costMicros": 1000000},
  "limits": {"steps": 2, "tokens": 65536, "costMicros": 2000000}
}
```

token保存在独立secret文件。文件每个最多8KiB且必须是普通文件；token拒绝控制字符，允许文件尾一个换行。profile只能来自宿主，不接受HTTP请求提供URL、密钥、modelTier、方法pin或预算；层级固定balanced。`modeDigest`由部署profile派生，调用时核对完整execution、tenant和project。ComfyUI图像连接保持原状，不能代替这里的文本供应方。

```sh
docker compose --env-file deploy/.env --env-file deploy/.env.api --env-file deploy/.env.development -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.development.yml -f deploy/compose.development-text.yml config --quiet
docker compose --env-file deploy/.env --env-file deploy/.env.api --env-file deploy/.env.development -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.development.yml -f deploy/compose.development-text.yml up -d api development-worker
docker compose --env-file deploy/.env --env-file deploy/.env.api --env-file deploy/.env.development -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.development.yml -f deploy/compose.development-text.yml stop development-worker
```

worker不公开网络端口，以镜像非root用户、只读根目录、capabilities全移除及禁止提权运行；收到SIGTERM后停止新调度并等待当前有界attempt结束，330秒grace覆盖最大模型超时及任务尾部。其公平轮询全部运行、每轮默认20条（1–50），间隔默认1000ms（50–60000ms），只精确领取当前tenant/task。即使业务已审阅或brief过期，也保留原durable任务尾部恢复路径。reconciling等待人工对账，失败/取消不换ID自动重发。

## 逐阶段重做

旧运行继续使用`original.development-stage@1`和原journal；显式重做分支使用同名workflow的版本2，worker启动必须注册两个版本。重新生成设定仍是完整两阶段计划；单独重做分集只继承真实已审阅设定的来源引用，既有候选、模型回执、审阅作者/时点和旧预算日志保持原样。继承设定不会创建新foundation任务、构造旧模型session或再次分配预算，因此旧供应方密钥移除不妨碍读取与复用已完成的上游。

仅分集分支使用宿主完整profile精确派生的一阶段profile：`limits.steps=1`，tokens/cost上限各等于一份reservation。配置文件仍声明完整两阶段上限，不能由HTTP客户端自行修改价格、模型或限额；模型runtime只接受完整宿主profile及它的唯一一阶段派生值。预算示例中的价格仍须按实际供应方核实，预留不等同已结算账单。

重做必须经项目`task:run`权限与可信源Task/steps检查。仍在运行、reconciling或`cancelled`但仍有unknown external步骤的旧目标，必须先沿原任务对账；不能靠新分支自动重复调用或释放旧预留。修改brief后旧设定不能悄悄复用，应启动新的完整开发。原始运行和新分支均可读取，单独分集的新候选仍需用户明确审阅；这不是正式IR采用。

安装者需显式应用新增origin迁移并给独立development数据身份新增`run_origins`的SELECT/INSERT，不能改写已安装0001/0002的checksum。运行时不自行升级权限或迁移。回退先关闭development功能，保留新分支及旧回执、预算和审计历史，不能删除origin来伪装旧版可读。

容器running仅证明进程存在；业务事实以持久化运行/候选/审阅和预算日志为准。真实HTTP协议夹具、PG恢复与构建成功不证明真实模型连贯性、人工评分或正式IR采用；完整阶段1验收仍保留。
