#!/bin/sh
set -eu
# 人工诊断窗口沿用同一个代理入口，不读取或复制上游节点凭据。
profile="${MANUAL_PROFILE_DIR:-/profile/manual-login-check}"
mkdir -p "$profile"
if [ "${ROLE_MANUAL_LOCKED:-}" != 1 ]; then
 exec flock -n "$profile/manual-profile.lock" env ROLE_MANUAL_LOCKED=1 /app/open-manual-browser.sh
fi
rm -f "$profile/SingletonLock" "$profile/SingletonCookie" "$profile/SingletonSocket"
set -- chromium "--user-data-dir=$profile" --no-first-run --no-default-browser-check --window-size=1440,900 --window-position=0,0
if [ -n "${BROWSER_PROXY_SERVER:-}" ]; then
 /usr/local/bin/node --input-type=module -e 'import {browserProxy} from "/app/dist/browser.js"; browserProxy(process.env.BROWSER_PROXY_SERVER);'
 set -- "$@" "--proxy-server=$BROWSER_PROXY_SERVER" --disable-quic
fi
exec "$@" https://x.com/i/flow/login
