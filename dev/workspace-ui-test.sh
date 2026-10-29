#!/bin/sh
# 三工作区与原功能回归均在服务器执行；容器不挂生产资料、不连接外网。
set -eu
cd "$(dirname "$0")/.."
# 可只复验失败套件；默认仍执行完整业务覆盖。
suites="${WORKSPACE_SUITES:-refinements-ui-acceptance workspace-shell-ui-acceptance workspace-lifecycle-ui-acceptance persona-workspace-ui-acceptance settings-workspace-ui-acceptance feed-workspace-ui-acceptance five-pages-acceptance proposals-ui-acceptance model-library-ui-acceptance billing-charts-acceptance feed-alerts-acceptance fill-gaps-ui-acceptance persona-presets-ui-acceptance reply-style-ui-acceptance run-control-ui-acceptance persona-presets-e2e browser-health-acceptance browser-broker-acceptance}"
for suite in $suites; do
 case "$suite" in *[!a-z0-9-]*|'') echo '验收套件名称无效' >&2; exit 2;; esac
 test -f "test/$suite.mjs" || { echo '验收套件不存在' >&2; exit 2; }
done
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=6 dsh sh -s -- $suites <<'REMOTE'
set -eu
candidate=/srv/role-workflow-proposals
artifacts=/var/lib/role-workflow-proposals/artifacts
mkdir -p "$artifacts/fixtures"
docker run --rm --network none -v "$candidate/dist:/app/dist:ro" -v "$artifacts/fixtures:/out" role-workflow-proposals-builder:dev node --input-type=module -e 'import {writeFileSync} from "node:fs";import {PERSONA_PRESETS,PERSONA_PRESETS_VERSION} from "./dist/persona-presets.js";import {FIXED_SYSTEM_RULES} from "./dist/persona.js";writeFileSync("/out/persona-presets-catalog.json",JSON.stringify({version:PERSONA_PRESETS_VERSION,items:PERSONA_PRESETS,fixedRules:FIXED_SYSTEM_RULES}));'
if ! docker inspect role-workflow-proposals-static >/dev/null 2>&1; then
 docker run -d --name role-workflow-proposals-static --network none --cpus 1 --memory 256m -e PUBLIC_DIR=/public -e PORT=8083 -v "$candidate/public:/public:ro" -v "$candidate/dev/proposals-static.mjs:/app/proposals-static.mjs:ro" role-workflow-proposals-builder:dev node /app/proposals-static.mjs
fi
# 每次保留上轮目录和日志；批次端到端会拒绝复用非空目录，不能用续跑绕过。
history=$(mktemp -d "$artifacts/previous-run.XXXXXX")
result=0
for suite in "$@"; do
 if [ -e "$artifacts/$suite" ]; then mv "$artifacts/$suite" "$history/$suite"; fi
 if [ -e "$artifacts/$suite.log" ]; then mv "$artifacts/$suite.log" "$history/$suite.log"; fi
 mkdir -p "$artifacts/$suite"
 chown 1000:1000 "$artifacts/$suite"
 printf '运行 %s\n' "$suite"
 if docker run --rm --network container:role-workflow-proposals-static --cpus 1 --memory 1100m --shm-size=512m --user 1000:1000 -e PANEL_URL=http://127.0.0.1:8083 -e PUBLIC_DIR=/public -e ARTIFACT_DIR="/artifacts/$suite" -e PRESET_CATALOG=/fixtures/persona-presets-catalog.json -v "$candidate/test:/app/test:ro" -v "$candidate/scripts:/app/scripts:ro" -v "$candidate/public:/app/public:ro" -v "$candidate/public:/public:ro" -v "$candidate/dist:/app/dist:ro" -v "$artifacts/fixtures:/fixtures:ro" -v "$artifacts:/artifacts" role-workflow-browser:0.1.19.1 timeout 300s node "/app/test/$suite.mjs" > "$artifacts/$suite.log" 2>&1; then
  printf '通过 %s\n' "$suite"
 else
  code=$?;result=1;printf '失败 %s（退出 %s），见 %s/%s.log\n' "$suite" "$code" "$artifacts" "$suite"
 fi
 done
exit "$result"
REMOTE
