#!/bin/sh
# 用户要求不保留旧镜像或整份备份；只在新生产版本验收后执行。
set -eu
cd /srv/role-workflow
python3 - <<'PY'
from pathlib import Path
import json,subprocess,shutil
containers=json.loads(subprocess.check_output(['docker','inspect','role-workflow-app-1','role-workflow-browser-1'],text=True))
assert all(c['State']['Running'] and c['State'].get('Health',{}).get('Status')=='healthy' for c in containers),'生产容器未通过健康检查，停止清理'
running=subprocess.check_output(['docker','ps','-aq'],text=True).split()
protected={c['Image'] for c in json.loads(subprocess.check_output(['docker','inspect',*running],text=True))} if running else set()
refs=subprocess.check_output(['docker','images','--format','{{.Repository}}:{{.Tag}} {{.ID}}','--no-trunc'],text=True).splitlines()
removed=[]
for row in refs:
 ref,image_id=row.split()
 if ref.startswith(('role-workflow-app:','role-workflow-browser:')) and image_id not in protected:
  subprocess.run(['docker','image','rm',ref],check=True);removed.append(ref)
for image_id in subprocess.check_output(['docker','images','--filter','dangling=true','-q','--no-trunc'],text=True).split():
 if image_id in protected:continue
 info=json.loads(subprocess.check_output(['docker','image','inspect',image_id],text=True))[0]
 if '/etc/role-supervisord.conf' in (info.get('Config',{}).get('Cmd') or []):
  subprocess.run(['docker','image','rm',image_id],check=True);removed.append(image_id)
root=Path('/var/lib/role-workflow/releases')
for p in root.iterdir():
 if p.name.startswith('before-') or p.name.endswith(('.tgz','.tar.gz')) or p.name.startswith(('env-before-','compose-before-')) or p.name=='previous.env':
  if p.is_dir():shutil.rmtree(p)
  else:p.unlink()
p=Path('/var/lib/role-workflow/browser-profile-backups')
if p.exists():shutil.rmtree(p)
print(json.dumps({'已移除本项目旧镜像':removed},ensure_ascii=False))
PY
docker builder prune --all --force
