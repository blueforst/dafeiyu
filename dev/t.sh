#!/bin/sh
# Type-check and run unit tests on the server inside the pinned Node 24 image.
# Usage: dev/t.sh [test files...]   (default: test/*.test.ts)
set -eu
files="${*:-test/*.test.ts}"
ssh dsh "cd /srv/role-workflow-panel && docker run --rm -v /srv/role-workflow-panel:/app -w /app node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 sh -c 'npm run -s check && node --import tsx --test $files'"
