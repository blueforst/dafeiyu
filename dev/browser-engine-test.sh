#!/bin/sh
# 在服务器测试已构建的浏览器镜像，产物只写入隔离验收目录。
set -eu
image=${1:?请指定已构建的浏览器候选镜像}
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifacts=${ENGINE_ARTIFACT_DIR:-/var/lib/role-workflow-browser-trial/artifacts/camoufox}
mkdir -p "$artifacts"
test -z "$(ls -A "$artifacts")" || { echo '验收目录非空，请另选ENGINE_ARTIFACT_DIR以保留旧证据' >&2; exit 2; }
chown 1000:1000 "$artifacts"
set --
if [ -n "${ENGINE_LEGACY_PRESET:-}" ];then
 test -f "$ENGINE_LEGACY_PRESET"
 set -- -e LEGACY_DEVICE_PRESET=/fixtures/legacy-device.json -v "$ENGINE_LEGACY_PRESET:/fixtures/legacy-device.json:ro"
fi
sh "$project/dev/server-heavy.sh" run --network none --init --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --security-opt "seccomp=$project/seccomp_profile.json" \
  --shm-size 256m --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  -e HOME=/tmp/engine-home -e DISPLAY=:98 -e XDG_RUNTIME_DIR=/tmp/runtime-node \
  -e MOZ_MARIONETTE=1 -e MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 \
  -e EXPECTED_FIREFOX_VERSION="${EXPECTED_FIREFOX_VERSION:-158.0.1}" \
  "$@" \
  -v "$project/test:/app/test:ro" -v "$artifacts:/artifacts" \
  --entrypoint sh "$image" -c '
    mkdir -p /tmp/runtime-node /tmp/engine-home
    Xvfb :98 -screen 0 1440x900x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
    count=0
    until [ -S /tmp/.X11-unix/X98 ]; do
      count=$((count+1)); [ "$count" -lt 30 ] || exit 1; sleep 1
    done
    openbox >/tmp/openbox.log 2>&1 &
    sleep 1
    exec timeout --kill-after=5s 120s node test/browser-engine-acceptance.mjs'
