# 数据库备份与恢复

两级备份，解决两个不同的问题：

| 层级 | 位置 | 触发 | 保留 | 解决的问题 |
|---|---|---|---|---|
| 服务器本地 | 服务器 `/home/deploy/backups/` | 服务器 cron，每天 03:00 UTC（北京 11:00） | 14 天 | 误删数据、误操作回滚 |
| **本机异地** | 本机 `backups/` | 本机 launchd，每天 12:30 CST | 30 天 | **服务器整机挂掉** |

服务器上的备份如果和服务器一起没了，就没有备份。所以必须有异地副本。

## 服务器挂了怎么恢复

在**任意一台有 Docker 的机器**上：

```bash
git clone git@github.com:seanli-lol/yunqi-pms.git
cd yunqi-pms

# 1. 造 .env（密钥从旧服务器的 .env 找，或重新生成）
cp .env.example .env 2>/dev/null || cp backend/.env.example backend/.env
# 编辑 .env：DB_ENGINE=mysql + 五项连接参数 + DATA_SECRET_KEY
# ⚠️ DATA_SECRET_KEY 必须是原来那把，否则存量证件号密文全部解不开

# 2. 起库
docker compose up -d mysql
# 等 docker compose ps 显示 mysql healthy

# 3. 从本机备份恢复
./scripts/restore.sh backups/pms-20261123-034534.sql.gz
# 会要求输入 yes 确认

# 4. 起前后端
docker compose up -d --build
```

## 日常操作

```bash
# 手动备份（服务器上）
cd /home/deploy/yunqi-pms && ./scripts/backup.sh

# 手动拉取到本机
/path/to/yunqi-pms/scripts/pull-backup.sh

# 立即触发一次 launchd 拉取（不用等到 12:30）
launchctl start com.yunqi.pms.backup-pull

# 看拉取日志
tail -20 backups/pull.log

# 看服务器备份日志
ssh -i ~/.ssh/pms_deploy -p 22 deploy@YOUR_SERVER_IP 'tail -20 /home/deploy/backups/backup.log'
```

## 校验备份是否可用

每份备份都有配对的 `.summary.txt`，记录表数与关键表行数：

```bash
cat backups/pms-*.summary.txt | head -15
```

`backup.sh` 和 `pull-backup.sh` 都会在生成/拉取后立即校验（`gzip -t` + 是否含 `CREATE TABLE` + 体积下限），
空备份或截断文件会被判定为失败——**没验证过的备份等于没有备份**。

## 定时任务

**服务器**（cron）：
```bash
crontab -l
# 0 3 * * * /home/deploy/yunqi-pms/scripts/backup.sh >> /home/deploy/backups/backup.log 2>&1
```

**本机**（launchd，macOS 不用 cron）：
```bash
launchctl list | grep yunqi
# -	0	com.yunqi.pms.backup-pull

# 卸载
launchctl unload ~/Library/LaunchAgents/com.yunqi.pms.backup-pull.plist
```

用 launchd 而非 cron 的原因：macOS 上 cron 已废弃，且 launchd 在合盖/休眠错过时间后
会在下次唤醒时补跑，cron 会直接跳过。

## 可调参数

`backup.sh`：`BACKUP_DIR`（默认 `/home/deploy/backups`）、`KEEP_DAYS`（默认 14）、`BACKUP_PREFIX`
`pull-backup.sh`：`PULL_DEST`（默认 `<仓库根>/backups`，已被 `.gitignore` 忽略）、`KEEP_DAYS`（默认 30）、
`SSH_KEY`/`SSH_PORT`/`SSH_USER`/`SSH_HOST`

> 本机备份落在项目根目录的 `backups/` 下（不再放用户家目录），在项目里直接就能找到；
> `.gitignore` 已忽略 `backups/`、`*.sql.gz`、`*.summary.txt`，备份文件**永远不会被 git 追踪**。
> 提醒：`backups/` 只存在于当前这台机器，换机器 clone 仓库不会带上历史备份。
