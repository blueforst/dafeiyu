#!/bin/sh
set -eu
cd /srv/role-workflow
version="${1:?用法：rollback.sh 已重新构建的版本号}"
case "$version" in *[!A-Za-z0-9._-]*|'') echo '版本号无效' >&2; exit 2;; esac
docker image inspect "role-workflow-app:$version" "role-workflow-browser:$version" >/dev/null 2>&1 || {
 echo '目标镜像不存在，请从对应 Git 提交重新构建后再切换。' >&2; exit 1;
}
ROLE_TARGET_VERSION="$version" python3 - <<'PY'
import os,pathlib,urllib.request
k=pathlib.Path('/var/lib/role-workflow/secrets/app/ingress_key').read_text().strip()
r=urllib.request.Request('http://127.0.0.1:8080/api/control/pause',method='POST',headers={'X-Ingress-Key':k,'X-Workflow-Control':'1'})
with urllib.request.urlopen(r,timeout=110) as response:response.read()
p=pathlib.Path('.env');lines=p.read_text().splitlines();updates={k:os.environ['ROLE_TARGET_VERSION'] for k in ['ROLE_VERSION','APP_VERSION','BROWSER_VERSION']};seen=set();out=[]
for line in lines:
 key=line.split('=',1)[0] if '=' in line and not line.startswith('#') else None
 if key=='BROWSER_ENGINE':continue
 if key in updates:out.append(key+'='+updates[key]);seen.add(key)
 else:out.append(line)
out += [k+'='+v for k,v in updates.items() if k not in seen]
t=p.with_name('.env.rollback.tmp');t.write_text('\n'.join(out)+'\n');t.chmod(0o600);t.replace(p)
PY
docker compose up -d --no-build
echo '已切换到指定镜像，服务保持暂停。'
