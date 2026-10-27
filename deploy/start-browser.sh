#!/bin/sh
set -eu
# 只有拿到同一 profile 的独占锁后，才清理崩溃遗留的 Firefox 锁。
if [ "${ROLE_PROFILE_LOCKED:-}" != 1 ]; then
 exec flock -n /profile/workflow-profile.lock env ROLE_PROFILE_LOCKED=1 /app/start-browser.sh
fi
rm -f /profile/camoufox/lock /profile/camoufox/.parentlock /profile/camoufox/parent.lock
exec /usr/local/bin/node /app/dist/browser.js
