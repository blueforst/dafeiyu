import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {Program,registerProgramRoutes} from '../src/program.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {registerTriageRoutes} from '../src/triage-routes.js';
import {loadConfig} from '../src/config.js';
import {readPanelSettings} from '../src/settings.js';
import {exampleConfig} from './config-fixture.js';

function fixture(){
 const root=mkdtempSync(tmpdir()+'/limits-settings-'),saved={DATA_DIR:process.env.DATA_DIR,CONFIG_PATH:process.env.CONFIG_PATH};process.env.DATA_DIR=root;process.env.CONFIG_PATH=root+'/config.json';
 const raw:any=structuredClone(exampleConfig);delete raw.replyHours;writeFileSync(process.env.CONFIG_PATH,JSON.stringify(raw));
 const store=new Store(root+'/workflow.sqlite'),app=Fastify(),program=new Program(store),triage=new ReplyTriage(store);
 registerProgramRoutes(app,{store,program,workflow:{control:()=> 'paused',busy:false,lastTick:0,nextTick:0,accountId:()=> 'fixture_bot',sentCount:()=>0}});
 registerTriageRoutes(app,{triage,accountId:()=> 'fixture_bot',privatePerDay:()=>loadConfig().privatePerDay??400});
 return {root,app,raw,store,path:process.env.CONFIG_PATH,write:(value:any)=>writeFileSync(process.env.CONFIG_PATH!,JSON.stringify(value)),async close(){await app.close();store.db.close();rmSync(root,{recursive:true,force:true});for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}

test('未配置的新字段缺省为400与默认开启30分钟，读取不写面板文件',async()=>{
 const f=fixture();try{const config=loadConfig();assert.equal(config.privatePerDay,400);assert.deepEqual(config.replyHours,{enabled:true,closeDelayMinutes:30});const response=await f.app.inject({url:'/api/program'});assert.equal(response.statusCode,200);assert.equal(response.json().settings.privatePerDay,400);assert.deepEqual(response.json().settings.replyHours,{enabled:true,closeDelayMinutes:30});assert.equal(response.json().replyHours.closeTime,'23:30');assert.equal(response.json().replyHours.openTime,'08:00');assert.equal(typeof response.json().replyHours.open,'boolean');assert.equal(existsSync(f.root+'/panel/settings.json'),false);const summary=await f.app.inject({url:'/api/triage/summary'});assert.equal(summary.statusCode,200);assert.equal(summary.json().privateRecent,0);assert.equal(summary.json().privatePerDay,400);}finally{await f.close();}
});

test('运行接口保存私信与时段边界值，非法请求拒绝且设置不变',async()=>{
 const f=fixture();try{
  let revision=0;
  for(const settings of [{privatePerDay:1,replyHours:{enabled:true,closeDelayMinutes:0}},{privatePerDay:500,replyHours:{enabled:false,closeDelayMinutes:180}}]){const response=await f.app.inject({method:'PUT',url:'/api/program/settings',payload:{settings,revision}});assert.equal(response.statusCode,200,response.body);revision++;assert.equal(response.json().revision,revision);assert.equal(response.json().settings.privatePerDay,settings.privatePerDay);assert.deepEqual(response.json().settings.replyHours,settings.replyHours);}
  const before=readFileSync(f.root+'/panel/settings.json','utf8');
  for(const settings of [{privatePerDay:0},{privatePerDay:501},{privatePerDay:1.5},{privatePerDay:'400'},{privatePerDay:null},{replyHours:null},{replyHours:{enabled:1,closeDelayMinutes:30}},{replyHours:{enabled:true,closeDelayMinutes:-1}},{replyHours:{enabled:true,closeDelayMinutes:181}},{replyHours:{enabled:true,closeDelayMinutes:1.5}},{replyHours:{enabled:true,closeDelayMinutes:30,unknown:true}}]){const response=await f.app.inject({method:'PUT',url:'/api/program/settings',payload:{settings,revision}});assert.equal(response.statusCode,400,JSON.stringify(settings));assert.equal(readFileSync(f.root+'/panel/settings.json','utf8'),before);}
  assert.equal(readPanelSettings().revisions?.program,2);
 }finally{await f.close();}
});

test('配置文件拒绝私信与时段非法值，接口时段在开关点正确',async t=>{
 let now=Date.parse('2026-10-28T15:29:59Z');t.mock.method(Date,'now',()=>now);
 const f=fixture();try{
  for(const patch of [{privatePerDay:0},{privatePerDay:501},{privatePerDay:2.5},{privatePerDay:null},{replyHours:null},{replyHours:{enabled:'true',closeDelayMinutes:30}},{replyHours:{enabled:true,closeDelayMinutes:-1}},{replyHours:{enabled:true,closeDelayMinutes:181}}]){f.write({...f.raw,...patch});assert.throws(()=>loadConfig(),/私信|范围|时段/);}
  f.write(f.raw);const before=(await f.app.inject({url:'/api/program'})).json();assert.equal(before.replyHours.open,true);now=Date.parse('2026-10-28T15:30:00Z');const closed=(await f.app.inject({url:'/api/program'})).json();assert.equal(closed.replyHours.open,false);assert.equal(closed.replyHours.reason,'reply-hours-closed');assert.equal(closed.replyHours.opensAt,Date.parse('2026-10-29T00:00:00Z'));now=Date.parse('2026-10-29T00:00:00Z');assert.equal((await f.app.inject({url:'/api/program'})).json().replyHours.open,true);
 }finally{await f.close();}
});
