"""服务器专用：只读核对生产数据，不保存正文或凭据。"""
import argparse,datetime,hashlib,json,pathlib,sqlite3,subprocess
parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['before','after']);args=parser.parse_args()
root=pathlib.Path('/var/lib/role-workflow-real-chat-20261029/evidence')
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,default=lambda v:v.hex() if isinstance(v,bytes) else str(v)).encode()).hexdigest()
connection=sqlite3.connect('file:/var/lib/role-workflow/app/workflow.sqlite?mode=ro',uri=True);connection.execute('BEGIN')
tables={}
for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
 quoted='"'+name.replace('"','""')+'"';columns=[r[1] for r in connection.execute('PRAGMA table_info('+quoted+')')]
 rows=connection.execute('SELECT * FROM '+quoted+' ORDER BY '+','.join('"'+c.replace('"','""')+'"' for c in columns)).fetchall()
 tables[name]={'rows':len(rows),'sha256':digest(rows)}
controls={}
try:controls=dict(connection.execute("SELECT key,value FROM runtime WHERE key IN ('control','activeAccount','expectedAccount','mode')"))
except sqlite3.OperationalError:pass
connection.rollback();connection.close()
files={}
for base in ['/var/lib/role-workflow/config','/var/lib/role-workflow/app/panel']:
 for p in pathlib.Path(base).rglob('*'):
  if p.is_file():files[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
for p in pathlib.Path('/var/lib/role-workflow/app').glob('*ledger*.json'):
 files[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
containers=[]
for name in ['role-workflow-app-1','role-workflow-browser-1']:
 d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 containers.append({'name':name,'id':d['Id'],'image':d['Config']['Image'],'status':d['State']['Status'],'health':d['State'].get('Health',{}).get('Status')})
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tables':tables,'controls':controls,'files':files,'containers':containers}
if args.phase=='after':
 before=json.loads((root/'production-before.json').read_text())
 changes=[name for name in tables if tables[name]!=before['tables'].get(name)]
 # 健康轮询和日志可随时间自然刷新，业务表、调用流水和控制必须完全不变。
 volatile={'runtime','logs','health_alerts','health_alert_events','health_reports'}
 result['changedTables']=changes;result['businessChangedTables']=[x for x in changes if x not in volatile]
 result['configurationUnchanged']=files==before['files'];result['controlsUnchanged']=controls==before['controls'];result['containersUnchanged']=containers==before['containers']
 result['productionBusinessUnchanged']=not result['businessChangedTables'] and all(result[k] for k in ['configurationUnchanged','controlsUnchanged','containersUnchanged'])
p=root/('production-'+args.phase+'.json');p.write_text(json.dumps(result,ensure_ascii=False,indent=2));p.chmod(0o600)
print(json.dumps({k:v for k,v in result.items() if k in ['at','controls','changedTables','businessChangedTables','configurationUnchanged','controlsUnchanged','containersUnchanged','productionBusinessUnchanged']},ensure_ascii=False))
