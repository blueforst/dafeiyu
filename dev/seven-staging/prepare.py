"""只创建专用隔离数据，不读取或复制生产数据库、凭据、浏览器 profile。"""
import json
import os
import secrets
from pathlib import Path

root = Path('/var/lib/role-workflow-seven')
for name in ['app', 'config', 'secrets/app', 'maintenance/requests', 'maintenance/results', 'artifacts']:
    path = root / name
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, 1000, 1000)
config_path = root / 'config/config.json'
if not config_path.exists():
    config = json.loads(Path('/srv/role-workflow-seven/config.example.json').read_text())
    config['model'].update(baseUrl='http://mock-model:8080/v1', id='staging-model')
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2))
for name in ['ingress_key', 'browser_key', 'model_api_key']:
    path = root / 'secrets/app' / name
    if not path.exists():
        path.write_text(secrets.token_hex(24))
    os.chmod(path, 0o600)
    os.chown(path, 1000, 1000)
print('独立 staging 配置、凭据及空数据目录已准备')
