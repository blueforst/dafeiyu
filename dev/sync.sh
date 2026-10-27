#!/bin/sh
# Push the local working copy to the server dev copy (never production).
set -eu
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .git --exclude dist --include .env.example --exclude .env --exclude '.env.*' --exclude .superpowers --exclude secrets --exclude data --exclude artifacts --exclude 交付资料 --exclude 部署记录 ./ dsh:/srv/role-workflow-panel/
