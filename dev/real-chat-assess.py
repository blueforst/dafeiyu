"""服务器离线复核已保存的真实试聊证据；不请求模型，不改写原始报告。"""
import datetime,hashlib,json,pathlib,sqlite3
root=pathlib.Path('/var/lib/role-workflow-real-chat-20261029');out=root/'evidence'
load=lambda name:json.loads((out/name).read_text())
main=load('results.json');follow=load('followup-results.json');summary=load('followup-summary.json');budget=json.loads((root/'budget.json').read_text());by={r['id']:r for r in main};extra={r['id']:r for r in follow}
original_failures=[{'id':r['id'],'checks':[c['name'] for c in r['checks'] if not c['passed']]} for r in main if not r['passed']]
assert len(main)==27 and len(original_failures)==6 and len(follow)==3 and all(r['passed'] for r in follow)
adjudications=[]
for case in ['A-02','A-06']:
 r=by[case];reply=r['response']['turn']['result']['draft']['text'];assert '11月4号' in reply and '杉木' in reply
 assert [c['name'] for c in r['checks'] if not c['passed']]==['回复事实 11月4日']
 adjudications.append({'id':case,'conclusion':'日期口语等价，真实召回正确','evidence':reply,'rawReportPreserved':True})
r=by['A-summary'];assert r['response']['turn']['result']['summary']['written'] is True
assert [c['name'] for c in r['checks'] if not c['passed']]==['公开保留独立平台线程且不跨线程合并']
adjudications.append({'id':'A-summary','conclusion':'整理轮无消息线程，初版检查器错误套用线程断言；真实整理写入成功','callIds':[c['id'] for c in r['calls']],'rawReportPreserved':True})
for case in ['P-claude','P-kimi','P-glm']:
 r=by[case];assert not r['calls'] and r['response']['turn']['result']['reason']=='批量刷量';assert extra[case]['passed'] and len(extra[case]['calls'])==1
 adjudications.append({'id':case,'conclusion':'初轮同文刷量过滤零调用；不同措辞补测独立通过','followupCallIds':[c['id'] for c in extra[case]['calls']],'rawReportPreserved':True})
assert len(budget['tickets'])==23 and all(t['status']=='settled' for t in budget['tickets']) and not budget['halted']
spent=sum(t['settledNano'] for t in budget['tickets']);assert spent<2000000000 and spent/1e9==.0182448
calls=load('followup-calls.json');assert len(calls)==23 and len({c['id'] for c in calls})==23 and {c['id'] for c in calls}=={t['callId'] for t in budget['tickets']}
assert all(c['status']=='completed' and c['pricing_status']=='priced' and c['actual_model']=='deepseek-v4.1-flash' for c in calls)
before=load('production-before.json');after=load('production-after.json')
critical=[name for name in before['tables'] if name not in ['runtime','logs','alerts','task_runs']]
assert all(before['tables'][name]==after['tables'][name] for name in critical)
assert after['configurationUnchanged'] and after['controlsUnchanged'] and after['containersUnchanged']
# 生产自身健康任务仍会执行，单独核对旧任务行未变、新增均为自动健康任务。
start=int(datetime.datetime.fromisoformat(before['at']).timestamp()*1000)
c=sqlite3.connect('file:/var/lib/role-workflow/app/workflow.sqlite?mode=ro',uri=True)
columns=[r[1] for r in c.execute('PRAGMA table_info(task_runs)')];order=','.join('"'+v+'"' for v in columns)
old=c.execute('SELECT * FROM task_runs WHERE started_at<? ORDER BY '+order,(start,)).fetchall()
h=hashlib.sha256(json.dumps(old,ensure_ascii=False,sort_keys=True).encode()).hexdigest();assert h==before['tables']['task_runs']['sha256']
new=c.execute('SELECT id,task_id,source,status,started_at,finished_at FROM task_runs WHERE started_at>=? ORDER BY started_at',(start,)).fetchall();assert new and all(row[1]=='health' and row[2]=='automatic' for row in new)
alerts=c.execute('SELECT key,started_at,last_seen_at,resolved_at FROM alerts').fetchall();assert len(alerts)==before['tables']['alerts']['rows'] and all(row[1]<start and (row[3] is None or row[3]<start) for row in alerts)
c.close()
core=['A-02','A-03','A-05','A-05-inspect','A-summary','A-06','A-dm-process','A-public-isolation','B-01','G-reset','G-after-reset']
result={'model':'opencode-go/deepseek-v4.1-flash','realModelRequests':23,'replyRequests':sum(c['source']=='chat-test:reply' for c in calls),'summaryRequests':sum(c['source']=='chat-test:memory-summary' for c in calls),'actualReplyDecisions':sum(r['response'].get('turn',{}).get('result',{}).get('draft',{}).get('action')=='reply' for r in main+follow),'actualSkipDecisions':sum(r['response'].get('turn',{}).get('result',{}).get('draft',{}).get('action')=='skip' for r in main+follow),'piEstimatedUsd':summary['piEstimatedUsd'],'peakNoCacheCeilingUsd':spent/1e9,'budgetLimitUsd':2,'unknownCalls':0,'reservedUsd':0,'originalOperations':27,'originalAutomaticPassed':21,'originalAutomaticFailures':original_failures,'adjudications':adjudications,'followupOperations':3,'followupPassed':3,'coreFunctionalCoverage':'跨轮及长期记忆、关键词卡、私信批量上文与手动整理均取得真实证据','coreCaseIds':core,'sixPresetsSampled':True,'threeStrikeCooldown':'未触发：首条骚扰为平和回复，随后仅两次harassment跳过；不追加探测，不算真实三击验收通过','productionCriticalTablesUnchanged':critical,'productionConfigurationControlsContainersUnchanged':True,'productionRuntimeChanges':{'changedTablesInRawSnapshot':after['changedTables'],'historicalTaskRowsUnchanged':True,'newAutomaticHealthRuns':new,'existingAlertsOnlyNoNewOrNewlyResolvedAlerts':True,'note':'生产健康轮询自然刷新runtime和既有告警last_seen_at；初步严格快照原报告保留false，不能声称整库逐字不变。'},'administratorReview':'待用户审阅，本报告不自动勾选8.1或发布任务','realPlatformOperation':False}
(out/'assessment.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));(out/'assessment.json').chmod(0o600)
print(json.dumps({k:result[k] for k in ['realModelRequests','replyRequests','summaryRequests','piEstimatedUsd','peakNoCacheCeilingUsd','followupPassed','unknownCalls','productionConfigurationControlsContainersUnchanged']},ensure_ascii=False))
