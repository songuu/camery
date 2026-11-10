# 私有化开发基础设施

阶段 0 当前只启动 PostgreSQL 16 + pgvector。应用、worker、媒体容器尚未实现，本档案不代表已经完成产品的一键部署。

## 启动

1. 将 `deploy/.env.example` 复制为 `deploy/.env`。
2. 在本机编辑 `.env`，设置随机且足够长的 `CAMERY_POSTGRES_PASSWORD`；不要将该文件提交到仓库。
3. 从仓库根目录运行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.private.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.private.yml up -d postgres
docker compose --env-file deploy/.env -f deploy/compose.private.yml ps
docker compose --env-file deploy/.env -f deploy/compose.private.yml exec postgres psql -U camery_admin -d camery -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
```

以上命令适用于 POSIX shell 和 PowerShell。如果修改了初始化用户或库名，扩展检查的 `-U`、`-d` 参数也要同步。

健康状态必须为 `healthy`，且 SQL 返回 `vector`，才能声称数据库已可用。`config --quiet` 仅验证配置展开，不验证 Docker 引擎、镜像下载或数据库启动。

默认端口只绑定回环地址。`camery_admin` 是初始化管理员，未来应用使用单独的最小权限角色；不要将初始化管理员直接作为生产应用身份。

## 数据与停止

- PostgreSQL 使用 Compose 命名卷 `postgres-data`；初始化脚本仅在空数据目录首次启动时执行。
- 普通停止：`docker compose --env-file deploy/.env -f deploy/compose.private.yml down`。命名卷保留；更改 `.env` 的初始化密码不会自动修改已有数据库账户。
- 当前使用上游 `pgvector/pgvector:pg16` 标签；发布镜像前需要锁定验证过的 digest，并完成备份/恢复测试。
- T0.1 后续的应用/媒体服务将挂载本地磁盘或 NAS；本档案暂不创建未被服务使用的媒体卷。S3 兼容存储在应用存储抽象落地时接入。
- 离线安装包、迁移、备份/恢复、完整服务健康检查属于后续阶段 0/发行任务，当前未完成。
