"""候选重启后的真实 HTTP 验收，仅可用于 8082 隔离模拟环境。"""
import json
import time
from pathlib import Path
import urllib.request

base = 'http://127.0.0.1:8082'
def request(path, body=None):
    headers = {'Content-Type': 'application/json', 'X-Workflow-Control': '1'}
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers), timeout=180) as response:
        assert response.status == 200
        return json.load(response)

for attempt in range(20):
    try:
        assert request('/healthz')['ok']
        break
    except OSError:
        if attempt == 19:
            raise
        time.sleep(0.5)

paths = ['/api/status', '/api/persona', '/api/persona/daily', '/api/memory/policy', '/api/memory/users',
         '/api/program', '/api/program/logs', '/api/messages', '/api/tasks', '/api/tasks/runs',
         '/api/billing/summary', '/api/billing/calls']
values = {path: request(path) for path in paths}
assert values['/api/status']['control'] == 'paused'
assert values['/api/status']['accountId'] == 'staging_bot'
assert values['/api/program']['stage']['name'] == 'waiting'
health = next(task for task in values['/api/tasks']['tasks'] if task['id'] == 'health')
assert health['effectiveHostPlan']['source'] == 'simulation'
for name in ['morning-post', 'evening-post', 'backup']:
    assert not next(task for task in values['/api/tasks']['tasks'] if task['id'] == name)['enabled']
preview = request('/api/persona/preview', {'persona': values['/api/persona']['persona'], 'channel': 'public',
                  'messages': [{'role': 'user', 'text': '隔离候选重启后试聊验收'}]})
assert preview['draft']['action'] == 'reply'
calls = request('/api/billing/calls?interactionId=' + preview['interactionId'])['items']
assert len(calls) == preview['fees']['requests']
assert all(call['pricingStatus'] == 'unpriced' for call in calls)
assert request('/api/status')['control'] == 'paused'
result = {'evidence': '候选镜像实际 HTTP 与模拟模型，不访问 X', 'getRoutes': paths,
          'programWaiting': True, 'hostSource': health['effectiveHostPlan']['source'],
          'previewCalls': len(calls), 'controlAfter': 'paused', 'implicitNewTasksEnabled': False,
          'passed': True}
destination = Path('/var/lib/role-workflow-seven/artifacts/candidate-smoke.json')
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
