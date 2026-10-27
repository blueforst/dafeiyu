#!/bin/sh
# 本轮候选只同步到独立目录，不接触生产或已有七页验收数据。
set -eu
cd "$(dirname "$0")/.."
ssh dsh 'mkdir -p /srv/role-workflow-proposals /var/lib/role-workflow-proposals/artifacts'
rsync -az --delete --exclude node_modules --exclude .git --exclude dist --include .env.example --exclude .env --exclude '.env.*' --exclude .superpowers --exclude secrets --exclude data --exclude artifacts --exclude 交付资料 --exclude 部署记录 ./ dsh:/srv/role-workflow-proposals/
