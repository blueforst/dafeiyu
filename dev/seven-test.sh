#!/bin/sh
# 构建、类型检查和回归仅在服务器独立目录执行。
set -eu
ssh dsh 'cd /srv/role-workflow-seven && docker build --target builder -t role-workflow-seven-builder:dev . && mkdir -p dist && docker run --rm -v /srv/role-workflow-seven/dist:/out role-workflow-seven-builder:dev cp -a /app/dist/. /out/'
