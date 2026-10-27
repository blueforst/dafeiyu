#!/bin/sh
set -eu
cd /srv/role-workflow
version="${1:?用法：upgrade.sh 新版本号}"
case "$version" in *[!A-Za-z0-9._-]*|'') echo "版本号无效" >&2; exit 2;; esac
mkdir -p /var/lib/role-workflow/releases
# 构建期先通过测试；运行中的实例不使用源码挂载。
docker build --target runtime -t "role-workflow-app:$version" .
docker build --target browser -t "role-workflow-browser:$version" .
python3 - <<'PY'
import pathlib,urllib.request,json
k=pathlib.Path('/var/lib/role-workflow/secrets/app/ingress_key').read_text().strip()
r=urllib.request.Request('http://127.0.0.1:8080/api/control/pause',method='POST',headers={'X-Ingress-Key':k,'X-Workflow-Control':'1'})
with urllib.request.urlopen(r,timeout=110) as p:print(p.read().decode())
PY
docker compose exec -T app node dist/cli.js backup
docker compose stop browser
tar -C /var/lib/role-workflow -czf "/var/lib/role-workflow/releases/browser-before-$version.tgz" browser
if [ -f .env ]; then cp .env /var/lib/role-workflow/releases/previous.env; fi
ROLE_TARGET_VERSION="$version" python3 - <<'PY'
import os,pathlib
p=pathlib.Path('.env');lines=p.read_text().splitlines() if p.exists() else []
updates={k:os.environ['ROLE_TARGET_VERSION'] for k in ['ROLE_VERSION','APP_VERSION','BROWSER_VERSION']}
seen=set();out=[]
for line in lines:
 key=line.split('=',1)[0] if '=' in line and not line.startswith('#') else None
 if key in updates:out.append(key+'='+updates[key]);seen.add(key)
 else:out.append(line)
out += [k+'='+v for k,v in updates.items() if k not in seen]
temporary=p.with_name('.env.upgrade.tmp');temporary.write_text('\n'.join(out)+'\n');temporary.chmod(0o600);temporary.replace(p)
PY
docker compose up -d --no-build
echo "升级完成，服务保持暂停；验收后再恢复。"
