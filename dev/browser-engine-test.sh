#!/bin/sh
# 在服务器测试已构建的浏览器镜像，产物只写入隔离验收目录。
set -eu
image=${1:-role-workflow-browser:0.1.12}
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifacts=/var/lib/role-workflow-browser-trial/artifacts/camoufox
mkdir -p "$artifacts"
chown 1000:1000 "$artifacts"
docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --security-opt "seccomp=$project/seccomp_profile.json" --pids-limit 768 --memory 1280m \
  --shm-size 256m --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  -e HOME=/tmp/engine-home -e DISPLAY=:98 -e XDG_RUNTIME_DIR=/tmp/runtime-node \
  -v "$project/test:/app/test:ro" -v "$artifacts:/artifacts" \
  --entrypoint sh "$image" -c '
    mkdir -p /tmp/runtime-node /tmp/engine-home
    Xvfb :98 -screen 0 1440x900x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
    count=0
    until [ -S /tmp/.X11-unix/X98 ]; do
      count=$((count+1)); [ "$count" -lt 30 ] || exit 1; sleep 1
    done
    exec node test/browser-engine-acceptance.mjs'
