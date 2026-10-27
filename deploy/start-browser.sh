#!/bin/sh
set -eu
# 只有拿到同一 profile 的独占锁后，才清理崩溃遗留的 Chromium 锁。
if [ "${ROLE_PROFILE_LOCKED:-}" != 1 ]; then
 exec flock -n /profile/workflow-profile.lock env ROLE_PROFILE_LOCKED=1 /app/start-browser.sh
fi
rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket
exec /usr/local/bin/node /app/dist/browser.js
