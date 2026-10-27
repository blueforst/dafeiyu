#!/bin/sh
# 所有类型检查、构建和自动回归均在服务器执行。
set -eu
ssh dsh 'cd /srv/role-workflow-proposals && docker build --target builder -t role-workflow-proposals-builder:dev . && mkdir -p dist && docker run --rm -v /srv/role-workflow-proposals/dist:/out role-workflow-proposals-builder:dev cp -a /app/dist/. /out/'
