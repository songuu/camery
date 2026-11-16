# 阶段0当前锁文件镜像验收

日期：2026-11-16（Asia/Shanghai）。对应[实施计划T0.1](../plan/implementation_plan_v2.md)和[阶段0进展](../plan/phase0-progress.md)。结论：**本机当前构建输入已完成冻结依赖镜像构建及同镜像API/worker Compose验收**；远端CI和阶段0整体仍未完成。

## 环境变化与构建结果

本轮开始Docker Linux引擎未运行，使用已安装的`docker desktop start`恢复；原`camery-phase0-postgres-1`随后为`healthy`。此前TypeScript完整元数据读取失败，本轮在允许联网的本机进程中实际取回`https://registry.npmjs.org/typescript`：HTTP 200、15937191字节、响应读取完整，才重新尝试构建。沙箱内的`EACCES`不被当作registry服务故障。

未修改依赖版本、registry、供应链策略、锁文件或Dockerfile；执行：

```powershell
docker build --progress=plain --file deploy/Dockerfile.api --tag camery-api:phase0-20261116 .
```

构建退出0。冻结安装步骤实际执行，255项锁文件供应链校验通过；生产部署另校验106项。API/worker bundle、固定制片/章节方法内容和生产依赖成功构建、装配。构建日志在本机临时目录`camery-image-build-20261116.log`，SHA-256为`1999f84bc2682436ab5c8e3643d16436fdf1874dd985833edb15d8a424400eef`；日志未复制入仓库。

## 镜像身份与输入边界

| 项目 | 实测结果 |
|---|---|
| 验收镜像 | `camery-api:phase0-20261116`与`camery-api:phase0` |
| 本地镜像ID / RepoDigest | `sha256:3fa095ccb334057581ef9200a0b3c571f4467b97c13c9963c7a2e6aaaa5aac3c` |
| 创建时间 | `2026-11-16T02:09:49.044626649Z` |
| 平台 | `linux/amd64` |
| Node / 运行身份 | `v24.22.2` / `node`，容器实测UID 1000 |
| 基础镜像 | Dockerfile固定`node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9` |
| 旧镜像保留标签 | `camery-api:phase0-before-20261116` |
| 旧镜像ID | `sha256:e4ad5807f2428e2f070b75a31cf987eb27f37a7450141d166b2f746b0be64d4d` |

`phase0`是可变本地标签，报告中的digest才标识此次验收对象。旧镜像保留后才调整该标签，API/worker测试前后均核对它指向同一新digest。没有推送镜像或Git变更。

工作区仍含未提交改动，最后Git提交`1fdb5a8`不能单独标识本轮构建内容。补充记录实际文件字节摘要：

| 输入 | SHA-256 |
|---|---|
| deploy/Dockerfile.api | bea385a7b19d65d9a192d2ae1d7b9e39e0235f338407c48c1ed546d5181e30df |
| pnpm-lock.yaml | c4717632aa3410b2b6f67817655bbba777d0e5839733e06e841def15c5153f61 |
| .dockerignore | bbf8360b69601bf560b33e93faef020dc8fac6a1f33ba406eb1a5cdc7a89e669 |
| 140个构建输入的聚合摘要 | 25dcf3935cd19ff4e4075dddec6f18fbcd17875e22692bc8444c4b1df6645a2d |

聚合算法：枚举Dockerfile中非`--from`的COPY源文件/目录，另加入Dockerfile和`.dockerignore`；递归读取普通文件，拒绝符号链接，排除被忽略的凭据、依赖、覆盖率和dist文件；路径统一`/`，按JavaScript默认字符串顺序排序，逐项形成`{path,sha256}`数组，再对其`JSON.stringify`的UTF-8字节计算SHA-256。该摘要用于识别本轮源输入，不声明其他平台重建一定得到相同镜像digest。媒体夹具、调研文档与本机凭据不进入应用构建上下文。

## 运行时与真实Compose验收

先以无网络、只读根目录、移除capabilities及禁止提权的临时容器核对：`main.mjs`、`worker.mjs`可读，无sourceMappingURL，`tsx`不可解析，实际UID 1000。再使用已有专用本地PG网络及已有测试入口：

| 命令 | 实际结果与证明范围 |
|---|---|
| `pnpm test:private-api:local` | 1/1通过（约20秒）；真实临时受限LOGIN、文件secret、认证/跨项目拒绝、注销、重启后仍撤销、日志不含测试凭据、非root/只读及正常停止退出0 |
| `pnpm test:private-worker:local` | 1/1通过（约13.54秒）；真实章节制片/方法、人工闸门、正常SIGTERM、SIGKILL退出137后新进程恢复、单份预算/方法日志、输出契约、无关任务未领取 |

两项均使用新镜像，不以旧镜像测试替代当前增量。测试创建并清理自己的临时租户、受限角色、secret及Compose项目；末次`docker ps -a`未发现API/worker smoke容器。原`camery-phase0-postgres-1`仍健康，没有删除或重建其数据卷。

worker强杀点在已持久化的人工等待闸门，不是本轮新增“外部工具执行中杀进程”证据；执行中故障保证仍以既有durable/Agent专项为准。两项属于历史累计中的同名Compose测试，本轮重跑不增加不同测试数；累计1711保持不变。此次镜像验收没有重跑整仓或完整数据库专项；同日后续整仓1529项检查已另行完成，见[退出条件核对](phase0-exit-audit-2026-11-16.md)。

## 尚未完成

- 未推送当前工作区，没有与这些未提交输入匹配的远端CI结果；本机镜像成功不替代CI验收。
- 前端、媒体服务、通用业务端点、发行/离线包与完整备份恢复仍按各自任务推进；本报告不扩张两个现有服务的能力范围。
- 此次镜像验收未覆盖真实ComfyUI；同日后续[Z-Image-Turbo真实出图及离线回放](comfy-zimage-live-2026-11-16.md)已通过。其他供应商真实配置、编辑器导入、法务产品签核及至少两家设计伙伴仍缺各自证据。交付夹具本轮五个产物hash、生成器hash和交换文本复核一致，导入状态仍为`not_run`，详见[交付记录](../delivery/phase0-import-report.md)。
