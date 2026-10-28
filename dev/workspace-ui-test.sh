#!/bin/sh
# 三工作区与原功能回归均在服务器执行；容器不挂生产资料、不连接外网。
set -eu
cd "$(dirname "$0")/.."
ssh dsh 'sh -s' <<'REMOTE'
set -eu
candidate=/srv/role-workflow-proposals
artifacts=/var/lib/role-workflow-proposals/artifacts
mkdir -p "$artifacts/fixtures"
docker run --rm --network none -v "$candidate/dist:/app/dist:ro" -v "$artifacts/fixtures:/out" role-workflow-proposals-builder:dev node --input-type=module -e 'import {writeFileSync} from "node:fs";import {PERSONA_PRESETS,PERSONA_PRESETS_VERSION} from "./dist/persona-presets.js";import {FIXED_SYSTEM_RULES} from "./dist/persona.js";writeFileSync("/out/persona-presets-catalog.json",JSON.stringify({version:PERSONA_PRESETS_VERSION,items:PERSONA_PRESETS,fixedRules:FIXED_SYSTEM_RULES}));'
if ! docker inspect role-workflow-proposals-static >/dev/null 2>&1; then
 docker run -d --name role-workflow-proposals-static --network none --cpus 1 --memory 256m -e PUBLIC_DIR=/public -e PORT=8083 -v "$candidate/public:/public:ro" -v "$candidate/dev/proposals-static.mjs:/app/proposals-static.mjs:ro" role-workflow-proposals-builder:dev node /app/proposals-static.mjs
fi
result=0
for suite in workspace-shell-ui-acceptance persona-workspace-ui-acceptance settings-workspace-ui-acceptance feed-workspace-ui-acceptance five-pages-acceptance proposals-ui-acceptance model-library-ui-acceptance billing-charts-acceptance feed-alerts-acceptance fill-gaps-ui-acceptance persona-presets-ui-acceptance reply-style-ui-acceptance run-control-ui-acceptance persona-presets-e2e; do
 mkdir -p "$artifacts/$suite"
 chown 1000:1000 "$artifacts/$suite"
 printf '运行 %s\n' "$suite"
 if docker run --rm --network container:role-workflow-proposals-static --cpus 1 --memory 1100m --shm-size=512m --user 1000:1000 -e PANEL_URL=http://127.0.0.1:8083 -e PUBLIC_DIR=/public -e ARTIFACT_DIR="/artifacts/$suite" -e PRESET_CATALOG=/fixtures/persona-presets-catalog.json -v "$candidate/test:/app/test:ro" -v "$candidate/scripts:/app/scripts:ro" -v "$candidate/public:/app/public:ro" -v "$candidate/public:/public:ro" -v "$candidate/dist:/app/dist:ro" -v "$artifacts/fixtures:/fixtures:ro" -v "$artifacts:/artifacts" role-workflow-browser:0.1.18.6 timeout 300s node "/app/test/$suite.mjs" > "$artifacts/$suite.log" 2>&1; then
  printf '通过 %s\n' "$suite"
 else
  code=$?;result=1;printf '失败 %s（退出 %s），见 %s/%s.log\n' "$suite" "$code" "$artifacts" "$suite"
 fi
 done
exit "$result"
REMOTE
