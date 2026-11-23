#!/usr/bin/env bash
# 云栖 PMS · MySQL 自动备份
#
# 做什么：用 mysqldump 导出一份逻辑备份（单事务一致性快照），gzip 压缩后落到
#         $BACKUP_DIR，并按保留策略清理过期文件；失败时保留现场并返回非 0。
# 怎么用：
#   手动         ./scripts/backup.sh
#   定时（cron） 0 3 * * * /path/to/repo/scripts/backup.sh >> /home/deploy/backups/backup.log 2>&1
#
# 可调环境变量（都有默认值）：
#   BACKUP_DIR     备份目录（默认 /home/deploy/backups）
#   KEEP_DAYS      保留天数（默认 14 天；每天一份，够回滚两周）
#   BACKUP_PREFIX  文件名前缀（默认 pms）
#   COMPOSE_FILE   compose 文件路径（默认仓库根的 docker-compose.yml）
#
# 设计取舍：
#   - 走 `docker compose exec` 而不是宿主机 mysql 客户端：宿主机不必装客户端，
#     且口令由容器环境变量提供，不落到命令行/进程表（--defaults 之外的泄露面）。
#   - --single-transaction：InnoDB 一致性快照，不锁表，白天手动跑也不影响前台开单。
#   - 备份成功后立刻校验（gzip -t + 是否含 CREATE TABLE），空文件/截断文件当失败处理
#     —— 一个 0 字节的"备份"比没有备份更危险，它会让人以为有退路。
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/deploy/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_PREFIX="${BACKUP_PREFIX:-pms}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.yml}"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"

ts() { date +%Y%m%d-%H%M%S; }

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

die() {
  log "ERROR: $*"
  exit 1
}

mkdir -p "$BACKUP_DIR"

STAMP="$(ts)"
OUT="$BACKUP_DIR/${BACKUP_PREFIX}-${STAMP}.sql.gz"
TMP="$OUT.part"

log "开始备份 → $OUT"

# 1) 导出 + 压缩。口令从容器内 $MYSQL_ROOT_PASSWORD 读，不出现在宿主机参数里。
#    pipefail 已在顶部开启：mysqldump 失败会让整条管道失败，不会留下半个"成功"的文件。
if ! docker compose -f "$COMPOSE_FILE" exec -T "$MYSQL_SERVICE" \
      sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
             --single-transaction --quick --routines --triggers \
             --default-character-set=utf8mb4 "$MYSQL_DATABASE"' \
      | gzip -9 > "$TMP"; then
  rm -f "$TMP"
  die "mysqldump 失败（容器未运行？磁盘满？）"
fi

# 2) 校验：能解压 + 含建表语句 + 体积合理。空备份当失败处理。
gzip -t "$TMP" 2>/dev/null || { rm -f "$TMP"; die "备份文件 gzip 校验失败（文件损坏）"; }

SIZE_BYTES="$(stat -c %s "$TMP" 2>/dev/null || stat -f %z "$TMP")"
if [ "$SIZE_BYTES" -lt 1024 ]; then
  rm -f "$TMP"
  die "备份文件仅 ${SIZE_BYTES} 字节，判定为空备份"
fi

if ! gzip -dc "$TMP" | grep -q "CREATE TABLE"; then
  rm -f "$TMP"
  die "备份内容不含 CREATE TABLE，判定无效"
fi

mv "$TMP" "$OUT"

# 3) 记录一行人能读的摘要（表数 + 关键行数），方便日后核对备份是否"真的完整"
SUMMARY="$BACKUP_DIR/${BACKUP_PREFIX}-${STAMP}.summary.txt"
{
  echo "backup: ${BACKUP_PREFIX}-${STAMP}.sql.gz"
  echo "time:   $(date -Iseconds)"
  echo "size:   ${SIZE_BYTES} bytes"
  echo "tables: $(gzip -dc "$OUT" | grep -c '^CREATE TABLE')"
  for t in hotels rooms reservations guests payments folio_items users; do
    n="$(gzip -dc "$OUT" | grep -o "INSERT INTO \`$t\`" | wc -l | tr -d ' ')"
    echo "  $t: $n INSERT statements"
  done
} > "$SUMMARY"

log "完成：$(du -h "$OUT" | cut -f1)  $(gzip -dc "$OUT" | grep -c '^CREATE TABLE') 张表"

# 4) 清理过期备份（按修改时间，同时清掉配对的 summary）
DELETED=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  rm -f "${old%.sql.gz}.summary.txt"
  DELETED=$((DELETED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.sql.gz" \
              -mtime +"$KEEP_DAYS" -print0)

[ "$DELETED" -gt 0 ] && log "清理过期备份 ${DELETED} 份（保留 ${KEEP_DAYS} 天）"

log "完成。当前保留 $(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.sql.gz" | wc -l | tr -d ' ') 份"
