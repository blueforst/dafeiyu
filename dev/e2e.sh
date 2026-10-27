#!/bin/sh
# 使用生产 Camoufox 镜像执行独立 staging 界面验收。
# Panel settings are wiped first so every run starts from a clean staging state.
set -eu
ssh dsh 'set -eu
cd /srv/role-workflow-panel
V=$(sed -n "s/^BROWSER_VERSION=//p" /srv/role-workflow/.env); [ -n "$V" ] || V=$(sed -n "s/^ROLE_VERSION=//p" /srv/role-workflow/.env)
rm -rf /var/lib/role-workflow-panel/app/panel
# Restart the staging app so control starts at "paused" (a failed takeover leaves it "draining").
docker compose -f dev/staging/compose.yaml restart app >/dev/null
i=0; until curl -fsS -o /dev/null http://127.0.0.1:8081/api/status; do i=$((i+1)); [ $i -gt 60 ] && { echo "staging app not ready"; exit 1; }; sleep 1; done
rm -f /var/lib/role-workflow-panel/artifacts/*.png
docker run --rm --network host --cap-drop ALL --security-opt no-new-privileges:true \
  --security-opt seccomp=/srv/role-workflow/seccomp_profile.json --shm-size 256m --memory 768m \
  -v /srv/role-workflow-panel/test:/app/test:ro -v /var/lib/role-workflow-panel/artifacts:/artifacts \
  "role-workflow-browser:$V" node test/panel-e2e.mjs'
