#!/usr/bin/env bash
# 云栖 PMS · 从备份恢复数据库
#
# ⚠️ 这会**覆盖**当前库里的同名表数据。执行前后端会读不到数据，请先停后端。
# 用法：
#   ./scripts/restore.sh /home/deploy/backups/pms-20261123-030000.sql.gz
#   ./scripts/restore.sh /home/deploy/backups/pms-...sql.gz --yes   # 跳过确认
#
# 可调环境变量：COMPOSE_FILE / MYSQL_SERVICE（同 backup.sh）
#
# 流程：确认 → 停 backend（避免恢复期间前台写入/读到半截数据）→ 导入 → 起 backend
#       → 打印表数与关键行数供核对。导入失败会自动把 backend 起回来，不留停机。
set -euo pipefail

DUMP_FILE="${1:-}"
ASSUME_YES="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.yml}"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

[ -n "$DUMP_FILE" ] || { echo "用法: $0 <备份文件.sql.gz> [--yes]"; exit 2; }
[ -f "$DUMP_FILE" ] || { echo "文件不存在: $DUMP_FILE"; exit 2; }

# 先校验备份本身可用，别在停服之后才发现文件是坏的
gzip -t "$DUMP_FILE" 2>/dev/null || { echo "备份文件 gzip 校验失败，放弃恢复"; exit 1; }
gzip -dc "$DUMP_FILE" | grep -q "CREATE TABLE" || { echo "备份不含 CREATE TABLE，放弃恢复"; exit 1; }

TABLES="$(gzip -dc "$DUMP_FILE" | grep -c '^CREATE TABLE')"
SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
log "待恢复备份：$DUMP_FILE（$SIZE / $TABLES 张表）"

if [ "$ASSUME_YES" != "--yes" ]; then
  echo
  echo "⚠️  将覆盖当前数据库内容。确认请输入 yes："
  read -r ans
  [ "$ans" = "yes" ] || { echo "已取消"; exit 1; }
fi

restore_backend() {
  log "启动 backend…"
  docker compose -f "$COMPOSE_FILE" start "$BACKEND_SERVICE" >/dev/null 2>&1 || true
}

log "停止 backend（避免恢复期间读写冲突）"
docker compose -f "$COMPOSE_FILE" stop "$BACKEND_SERVICE" >/dev/null 2>&1 || true

# 无论导入成败，都要把 backend 起回来
trap 'restore_backend' EXIT

log "导入中…"
if ! gzip -dc "$DUMP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T "$MYSQL_SERVICE" \
      sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'; then
  log "ERROR: 导入失败 —— 数据库可能处于部分恢复状态，请人工检查"
  exit 1
fi

log "导入完成，核对数据…"
docker compose -f "$COMPOSE_FILE" exec -T "$MYSQL_SERVICE" \
  sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "
    SELECT (SELECT COUNT(*) FROM hotels) AS hotels,
           (SELECT COUNT(*) FROM rooms) AS rooms,
           (SELECT COUNT(*) FROM reservations) AS reservations,
           (SELECT COUNT(*) FROM guests) AS guests;"' 2>/dev/null \
  || log "（核对查询失败，但导入本身已完成）"

log "恢复流程结束"
