#!/bin/sh
set -eu
# 独立诊断窗口使用 Camoufox，不与业务 profile 共用锁。
profile="${MANUAL_PROFILE_DIR:-/profile/manual-login-check}"
mkdir -p "$profile"
if [ "${ROLE_MANUAL_LOCKED:-}" != 1 ]; then
 exec flock -n "$profile/manual-profile.lock" env ROLE_MANUAL_LOCKED=1 /app/open-manual-browser.sh
fi
rm -f "$profile/camoufox/lock" "$profile/camoufox/.parentlock" "$profile/camoufox/parent.lock"
exec /usr/local/bin/node /app/dist/manual-browser.js
