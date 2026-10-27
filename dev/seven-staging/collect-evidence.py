"""收集隔离候选的散列、挂载和公开状态；不输出配置正文或凭据。"""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

source = Path('/srv/role-workflow-seven')
output = Path('/var/lib/role-workflow-seven/artifacts/environment.json')

def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    return result.stdout.strip()

def read_status(url, key=None):
    headers = {'X-Ingress-Key': key} if key else {}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as response:
        value = json.load(response)
    model = (value.get('config') or {}).get('model') or {}
    return {'control': value.get('control'), 'busy': value.get('busy'),
            'mode': (value.get('config') or {}).get('mode'),
            'modelConfigured': model.get('configured'),
            'accountConfirmed': bool((value.get('browser') or {}).get('loggedIn')),
            'lastTick': value.get('lastTick')}

images = {}
for name in ['role-workflow-app:seven-page-candidate', 'role-workflow-browser:seven-page-candidate']:
    images[name] = command('docker', 'image', 'inspect', name, '--format', '{{.Id}}')
containers = {}
for name in ['role-workflow-app-1', 'role-workflow-browser-1', 'role-workflow-seven-app-1']:
    raw = json.loads(command('docker', 'inspect', name))[0]
    containers[name] = {'image': raw['Config']['Image'], 'imageId': raw['Image'],
                        'status': raw['State']['Status'],
                        'mounts': [{key: item[key] for key in ['Type', 'Source', 'Destination', 'RW']} for item in raw['Mounts']]}
hashes = {}
for folder in ['src', 'public', 'test', 'deploy']:
    for path in sorted((source / folder).rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            hashes[str(path.relative_to(source))] = hashlib.sha256(path.read_bytes()).hexdigest()
timers = {}
for name in ['role-monitor.timer', 'role-cert-renew.timer', 'role-maintenance-seven-staging.timer']:
    timers[name] = {'enabled': command('systemctl', 'is-enabled', name),
                    'active': command('systemctl', 'is-active', name)}
production_key = Path('/var/lib/role-workflow/secrets/app/ingress_key').read_text().strip()
value = {'at': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
         'evidence': '独立服务器候选；未执行真实模型或平台发送验收',
         'images': images, 'containers': containers, 'sourceSha256': hashes, 'timers': timers,
         'staging': read_status('http://127.0.0.1:8082/api/status'),
         'productionReadOnly': read_status('http://127.0.0.1:8080/api/status', production_key)}
output.write_text(json.dumps(value, ensure_ascii=False, indent=2))
print(json.dumps({'path': str(output), 'candidateImages': images, 'staging': value['staging'],
                  'productionReadOnly': value['productionReadOnly'], 'timers': timers}, ensure_ascii=False))
