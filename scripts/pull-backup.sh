#!/usr/bin/env bash
# 云栖 PMS · 本机拉取服务器备份（异地灾备）
#
# 用途：把服务器 /home/deploy/backups/ 下的数据库备份同步到本机，
#       解决"服务器整机挂掉时，服务器上的备份也一起没了"的问题。
#
# 设计：单向拉取（本地 ← 服务器）、只读（绝不写服务器）、失败不影响线上。
#       rsync 只下载缺失/变更的文件，重复跑不会重复传输。
#
# 用法：
#   手动   ~/bin/pms-pull-backup.sh
#   定时   由 launchd 调起（见 ~/Library/LaunchAgents/com.yunqi.pms.backup-pull.plist）
#
# 可调环境变量：
#   PULL_DEST   本地存放目录（默认 ~/Backups/yunqi-pms）
#   KEEP_DAYS   本地保留天数（默认 30 天，比服务器 14 天更久——异地留底要长一些）
#   SSH_KEY / SSH_PORT / SSH_USER / SSH_HOST  连接参数
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/pms_deploy}"
SSH_PORT="${SSH_PORT:-22}"
SSH_USER="${SSH_USER:-deploy}"
SSH_HOST="${SSH_HOST:-YOUR_SERVER_IP}"
REMOTE_DIR="${REMOTE_DIR:-/home/deploy/backups}"
PULL_DEST="${PULL_DEST:-$HOME/Backups/yunqi-pms}"
KEEP_DAYS="${KEEP_DAYS:-30}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

mkdir -p "$PULL_DEST"

# 1) 连通性预检：服务器不可达时快速失败，不留半截状态
if ! ssh -i "$SSH_KEY" -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=20 \
      "$SSH_USER@$SSH_HOST" true 2>/dev/null; then
  die "无法连接服务器 $SSH_HOST:$SSH_PORT（网络中断或密钥失效）"
fi

# 2) 单向拉取：--ignore-existing 只下载本地没有的（备份文件一次生成永不改，
#    不需要覆盖）；--partial 支持断点续传，大库中断了下次接着传。
log "从 $SSH_HOST:$REMOTE_DIR 拉取 → $PULL_DEST"
RSYNC_LOG="$(mktemp)"
if ! rsync -az --ignore-existing --partial --stats \
      -e "ssh -i $SSH_KEY -p $SSH_PORT -o BatchMode=yes -o ConnectTimeout=20" \
      "$SSH_USER@$SSH_HOST:$REMOTE_DIR/" "$PULL_DEST/" >"$RSYNC_LOG" 2>&1; then
  cat "$RSYNC_LOG"
  rm -f "$RSYNC_LOG"
  die "rsync 拉取失败"
fi
# rsync --stats 输出的实际字段是 "Number of files transferred: 2"
# （注意是 "Number of files"，不是 "Number of regular files"——后者是旧版/其他实现的说法）
NEW_FILES="$(awk -F': *' '/Number of files transferred/ {print $2; exit}' "$RSYNC_LOG")"
NEW_FILES="${NEW_FILES:-?}"
rm -f "$RSYNC_LOG"

# 3) 本地校验：拉到的每份备份都必须能解压且含建表语句。
#    这一步是异地备份的价值所在——没验证过的备份等于没有备份。
BAD=0
CHECKED=0
while IFS= read -r -d '' f; do
  CHECKED=$((CHECKED + 1))
  if ! gzip -t "$f" 2>/dev/null; then
    log "WARN: $f gzip 校验失败（文件可能损坏/未传完）"
    BAD=$((BAD + 1))
    continue
  fi
  if ! gzip -dc "$f" 2>/dev/null | grep -q "CREATE TABLE"; then
    log "WARN: $f 不含 CREATE TABLE（可能是空备份）"
    BAD=$((BAD + 1))
  fi
done < <(find "$PULL_DEST" -maxdepth 1 -type f -name 'pms-*.sql.gz' -print0)

[ "$CHECKED" -eq 0 ] && die "本地没有任何备份文件，拉取可能未生效"

# 4) 清理本地过期备份（按 mtime；比服务器保留更久）
DELETED=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  rm -f "${old%.sql.gz}.summary.txt"
  DELETED=$((DELETED + 1))
done < <(find "$PULL_DEST" -maxdepth 1 -type f -name 'pms-*.sql.gz' -mtime +"$KEEP_DAYS" -print0)

log "拉取完成：新增/更新 ${NEW_FILES} 个文件，本地共 ${CHECKED} 份备份（校验失败 ${BAD} 份）"
[ "$DELETED" -gt 0 ] && log "清理本地过期备份 ${DELETED} 份（保留 ${KEEP_DAYS} 天）"
[ "$BAD" -gt 0 ] && die "有 ${BAD} 份备份校验失败，请检查服务器磁盘与传输"

# 5) 打印一份"最新可用备份"摘要，方便随时人工确认灾备可用
LATEST="$(find "$PULL_DEST" -maxdepth 1 -type f -name 'pms-*.sql.gz' -print0 \
          | xargs -0 ls -t 2>/dev/null | head -1 || true)"
if [ -n "$LATEST" ]; then
  log "最新备份：$(basename "$LATEST")  $(du -h "$LATEST" | cut -f1)  表数 $(gzip -dc "$LATEST" | grep -c '^CREATE TABLE')"
fi
