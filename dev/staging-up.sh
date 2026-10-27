#!/bin/sh
# Build and (re)start the staging stack on the server, then wait until the panel answers.
set -eu
cd /srv/role-workflow-panel
docker compose -f dev/staging/compose.yaml up -d --build --remove-orphans >/var/lib/role-workflow-panel/artifacts/staging-up.log 2>&1 || { tail -40 /var/lib/role-workflow-panel/artifacts/staging-up.log; exit 1; }
i=0
until curl -fsS -o /dev/null http://127.0.0.1:8081/healthz; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "staging did not become ready"; docker compose -f dev/staging/compose.yaml logs --tail 40 app; exit 1; }
  sleep 1
done
echo "staging ready on 127.0.0.1:8081"
