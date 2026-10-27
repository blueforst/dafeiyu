#!/bin/sh
# Production read-only panel acceptance (run only after the merge, Task 11).
# The script itself refuses to click anything unless processing is paused.
# Credentials are copied to a short-lived 0600 file owned by the container user and removed afterwards.
set -eu
ssh dsh 'set -eu
V=$(sed -n "s/^BROWSER_VERSION=//p" /srv/role-workflow/.env); [ -n "$V" ] || V=$(sed -n "s/^ROLE_VERSION=//p" /srv/role-workflow/.env)
A=/var/lib/role-workflow/acceptance
mkdir -p "$A"
C=$(mktemp -d /var/lib/role-workflow/acceptance-creds.XXXXXX)
trap "rm -rf \"$C\"" EXIT
install -m 600 -o 1000 -g 1000 /var/lib/role-workflow/admin-access.txt "$C/admin-access.txt"
chown 1000:1000 "$C"
docker run --rm --network host --cap-drop ALL --security-opt no-new-privileges:true \
  --security-opt seccomp=/srv/role-workflow/seccomp_profile.json --shm-size 256m --memory 768m \
  -v /srv/role-workflow/test:/app/test:ro -v "$C/admin-access.txt":/run/test/admin-access.txt:ro -v "$A":/artifacts \
  "role-workflow-browser:$V" node test/ui-acceptance.mjs'
