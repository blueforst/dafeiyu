#!/usr/bin/python3
import json,pathlib,subprocess,datetime,urllib.request,ssl,socket
root=pathlib.Path('/var/lib/role-workflow')
result={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'issues':[]}
try:
 req=urllib.request.Request('http://127.0.0.1:8080/api/status',headers={'X-Ingress-Key':(root/'secrets/app/ingress_key').read_text().strip()})
 with urllib.request.urlopen(req,timeout=15) as r: status=json.load(r)
 result['status']=status
 if status['control']=='running' and status['lastTick'] and status['now']-status['lastTick']>20*60*1000:result['issues'].append('运行轮次超过20分钟未完成')
 for c,t in status['cooldown'].items():
  if t>status['now']:result['issues'].append(c+' 通道退避中')
except Exception as e:result['issues'].append('面板服务不可达：'+str(e)[:150])
containers=subprocess.run(['docker','compose','ps','--format','json'],cwd='/srv/role-workflow',capture_output=True,text=True)
result['containers']=[]
for line in containers.stdout.splitlines():
 try:
  c=json.loads(line);result['containers'].append({k:c.get(k) for k in ['Service','Image','State','Health']})
  if c.get('State')!='running' or c.get('Health')!='healthy':result['issues'].append(c.get('Service','未知')+' 容器未就绪')
 except json.JSONDecodeError:result['issues'].append('容器状态解析失败')
obs_path=root/'infrastructure-observation.json'
if obs_path.exists():
 obs=json.loads(obs_path.read_text())
 started=datetime.datetime.fromisoformat(obs['startedAt'])
 obs['elapsedHours']=round((datetime.datetime.now(datetime.timezone.utc)-started).total_seconds()/3600,3)
 obs['samples']=obs.get('samples',0)+1
 obs['unhealthySamples']=obs.get('unhealthySamples',0)+(1 if result['issues'] else 0)
 obs['lastCheckedAt']=result['time']
 obs['completed']=obs['elapsedHours']>=12 and obs['samples']>=144 and obs['unhealthySamples']==0
 obs['businessObservationStarted']=bool(result.get('status',{}).get('observationStartedAt'))
 obs_path.write_text(json.dumps(obs,ensure_ascii=False,indent=2))
 result['observation']=obs
try:
 with socket.create_connection(('43.133.80.237',443),timeout=10) as sock:
  with ssl.create_default_context().wrap_socket(sock,server_hostname='43.133.80.237') as conn:
   expires=ssl.cert_time_to_seconds(conn.getpeercert()['notAfter'])
   result['certificate_hours_remaining']=round((expires-datetime.datetime.now().timestamp())/3600,1)
   if result['certificate_hours_remaining']<24:result['issues'].append('证书有效期不足24小时')
except Exception as e:result['issues'].append('证书检查失败：'+str(e)[:150])
out=root/'monitor-latest.json';out.write_text(json.dumps(result,ensure_ascii=False,indent=2))
if result['issues']:print(json.dumps(result['issues'],ensure_ascii=False))
