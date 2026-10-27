#!/bin/sh
set -eu
cd /srv/role-workflow
previous=/var/lib/role-workflow/releases/previous.env
test -f "$previous" || { echo "没有已记录的上一版本" >&2; exit 1; }
docker compose stop
cp "$previous" .env
docker compose up -d --no-build
echo "已恢复上一镜像。若升级包含不兼容数据迁移，应先按运维文档恢复升级前数据库及遗忘记录。"
