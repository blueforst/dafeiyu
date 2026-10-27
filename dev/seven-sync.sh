#!/bin/sh
# 独立七页开发副本，避免覆盖原面板工作副本和生产数据。
set -eu
cd "$(dirname "$0")/.."
ssh dsh 'mkdir -p /srv/role-workflow-seven /var/lib/role-workflow-seven/artifacts'
rsync -az --delete --exclude node_modules --exclude .git --exclude dist --include .env.example --exclude .env --exclude '.env.*' --exclude .superpowers --exclude secrets --exclude data --exclude artifacts --exclude 交付资料 --exclude 部署记录 ./ dsh:/srv/role-workflow-seven/
