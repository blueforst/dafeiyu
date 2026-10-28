"""工作区发布只读证据：保存摘要，不复制生产库、设置或 profile。"""
import argparse,datetime,hashlib,json,pathlib,sqlite3,subprocess,urllib.request
parser=argparse.ArgumentParser();parser.add_argument('--phase',required=True);parser.add_argument('--release-dir',required=True);args=parser.parse_args()
assert args.phase.replace('-','').isalnum();out=pathlib.Path(args.release_dir);assert str(out).startswith('/var/lib/role-workflow/releases/')
out.mkdir(parents=True,exist_ok=True);out.chmod(0o700)
def digest(data):return hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True,default=lambda v:v.hex() if isinstance(v,bytes) else str(v)).encode()).hexdigest()
key=pathlib.Path('/var/lib/role-workflow/secrets/app/ingress_key').read_text().strip()
def read(path):
 request=urllib.request.Request('http://127.0.0.1:8080'+path,headers={'X-Ingress-Key':key})
 with urllib.request.urlopen(request,timeout=30) as response:return json.load(response)
status=read('/api/status');persona=read('/api/persona');model=read('/api/model');program=read('/api/program');tasks=read('/api/tasks');feed=read('/api/feed');triage=read('/api/triage/summary')
api={'control':status['control'],'busy':status['busy'],'accountId':status.get('accountId'),'mode':status.get('config',{}).get('mode'),'persona':{'hash':digest({'persona':persona.get('persona'),'revision':persona.get('revision')}),'revision':persona.get('revision')},'model':{'hash':digest(model),'provider':model.get('effective',{}).get('provider'),'id':model.get('effective',{}).get('id')},'programSettings':program.get('settings'),'programRevision':program.get('revision'),'replyHours':program.get('replyHours'),'feedPending':feed.get('pending'),'triagePrivate':{k:triage.get(k) for k in ['privateRecent','privatePerDay']},'plans':{'revision':tasks.get('revision'),'items':[{k:t.get(k) for k in ['id','enabled','time','intervalSeconds']} for t in tasks.get('tasks',[])]}}
if args.phase!='before':
 library=read('/api/personas');active=read('/api/personas/'+library['activeId']);api['personaLibrary']={'activeId':library['activeId'],'libraryRevision':library['libraryRevision'],'items':[{k:p.get(k) for k in ['id','name','revision','origin']} for p in library['items']],'active':active['active'],'activeHash':digest(active['persona'])};api['chatTestStatus']=read('/api/chat-test/status');conversations=read('/api/feed/conversations?limit=10');api['conversations']={'pending':conversations['pending'],'items':len(conversations['items'])}
connection=sqlite3.connect('file:/var/lib/role-workflow/app/workflow.sqlite?mode=ro',uri=True);connection.execute('BEGIN');tables={}
for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
 quoted='"'+name.replace('"','""')+'"';columns=[row[1] for row in connection.execute('PRAGMA table_info('+quoted+')')];rows=connection.execute('SELECT * FROM '+quoted+' ORDER BY '+','.join('"'+c.replace('"','""')+'"' for c in columns)).fetchall();tables[name]={'rows':len(rows),'hash':digest(rows)}
controls=dict(connection.execute('SELECT key,value FROM runtime WHERE key IN (?,?,?,?,?)',('control','activeAccount','model:sessionNamespace','lastTick','nextTick')))
namespace={k:digest(v) for k,v in connection.execute('SELECT key,value FROM runtime') if 'session' in k.lower()}
schema=connection.execute('SELECT version,name FROM schema_migrations ORDER BY version').fetchall();indexes=connection.execute("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").fetchall()
activity={name:dict(connection.execute('SELECT status,COUNT(*) FROM '+name+' GROUP BY status')) for name in ['messages','outbox','llm_calls']};runningTasks=connection.execute('SELECT task_id,source,status FROM task_runs WHERE status=?',('running',)).fetchall();connection.rollback();connection.close()
files={}
for base in ['/var/lib/role-workflow/config','/var/lib/role-workflow/app/panel','/var/lib/role-workflow/secrets/app','/var/lib/role-workflow/secrets/browser']:
 for p in pathlib.Path(base).rglob('*'):
  if p.is_file():files[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
for name in ['forget-ledger.json','forget-history.json','forgotten-sources.json','memory-mutations.json']:
 p=pathlib.Path('/var/lib/role-workflow/app')/name;files[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
for name in ['transport-journal.json','posting-preflight-v1.json','device-preset.json']:
 p=pathlib.Path('/var/lib/role-workflow/browser')/name;files[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
containers=[]
for name in ['role-workflow-app-1','role-workflow-browser-1']:
 d=json.loads(subprocess.check_output(['docker','inspect',name]))[0];containers.append({'name':name,'id':d['Id'],'image':d['Config']['Image'],'imageId':d['Image'],'sourceRevision':d['Config'].get('Labels',{}).get('org.opencontainers.image.revision'),'versionLabel':d['Config'].get('Labels',{}).get('org.opencontainers.image.version'),'status':d['State']['Status'],'health':d['State'].get('Health',{}).get('Status')})
versions={}
for line in pathlib.Path('/srv/role-workflow/.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1)
  if k in ['ROLE_VERSION','APP_VERSION','BROWSER_VERSION']:versions[k]=v
envNonVersions=[line for line in pathlib.Path('/srv/role-workflow/.env').read_text().splitlines() if line.split('=',1)[0] not in ['ROLE_VERSION','APP_VERSION','BROWSER_VERSION']]
result={'environmentNonVersionsHash':digest(envNonVersions),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'api':api,'tables':tables,'controls':controls,'sessionNamespaces':namespace,'schema':schema,'indexHash':digest(indexes),'activity':activity,'runningTasks':runningTasks,'files':files,'containers':containers,'versions':versions,'productionChatTestDirectoryExists':pathlib.Path('/var/lib/role-workflow/app/chat-test').exists()}
if args.phase!='before':
 before=json.loads((out/'before.json').read_text());excluded={'runtime','logs','alerts','task_runs','program_stages'};critical=[n for n in before['tables'] if n not in excluded];differences=[n for n in critical if before['tables'][n]!=tables.get(n)]
 changedFiles=[p for p in set(files)|set(before['files']) if files.get(p)!=before['files'].get(p)]
 result['comparison']={'criticalTablesChanged':differences,'changedFiles':changedFiles,'environmentNonVersionsUnchanged':before['environmentNonVersionsHash']==result['environmentNonVersionsHash'],'schemaUnchanged':digest(before['schema'])==digest(schema),'indexesUnchanged':before['indexHash']==result['indexHash'],'personaUnchanged':before['api']['persona']==api['persona'],'modelUnchanged':before['api']['model']==api['model'],'controlModeUnchanged':(before['api']['control'],before['api']['mode'])==(api['control'],api['mode']),'pendingUnchanged':before['api']['feedPending']==api['feedPending'],'plansUnchanged':before['api']['plans']==api['plans'],'sessionNamespacesUnchanged':before['sessionNamespaces']==namespace,'changedOperationalTables':[n for n in excluded if before['tables'].get(n)!=tables.get(n)]}
p=out/(args.phase+'.json');assert not p.exists(),'阶段证据已存在，禁止静默覆盖';p.write_text(json.dumps(result,ensure_ascii=False,indent=2));p.chmod(0o600)
print(json.dumps({'phase':args.phase,'control':api['control'],'mode':api['mode'],'activity':activity,'runningTasks':runningTasks,'versions':versions,'replyHours':api['replyHours'],'comparison':result.get('comparison')},ensure_ascii=False))
