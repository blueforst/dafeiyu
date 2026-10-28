import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {Workflow} from '../src/workflow.js';
import {PersonaService,type Persona} from '../src/persona.js';
import type {Generator} from '../src/model.js';
import type {Config,Event,Channel} from '../src/types.js';
import type {Transport} from '../src/transport.js';
import {exampleConfig} from './config-fixture.js';

const fixturePath=process.env.REPLY_BASELINE_PATH??fileURLToPath(new URL('./fixtures/reply-pipeline-v5.json',import.meta.url));
const at=Date.parse('2026-10-28T04:34:00Z');
const persona:Persona={sections:[{id:'role',title:'始终生效',content:'固定夹具人格：自然回应，记住已发生的往来。'}],triggers:[
 {id:'praise',title:'被夸',condition:'被夸时',content:'谦逊接住夸奖。',enabled:true,order:0,match:'keywords',keywords:['可爱']},
 {id:'work',title:'工作话题',condition:'谈到项目上线',content:'关心项目进展，不编造项目细节。',enabled:true,order:1,match:'semantic'}
]};

async function record(channel:Channel){
 const dir=mkdtempSync(join(tmpdir(),'reply-consistency-')),old=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite')),calls:any[]=[],stages:string[]=[];
 const config:Config=structuredClone(exampleConfig) as Config;
 const generator:Generator={async complete(c,system,user,_signal,sessionId,meta={}){
  calls.push({system,user,sessionId,metadata:meta,model:c.model});
  return {text:meta.purpose==='semantic-trigger'?JSON.stringify({matches:[{id:'work',reason:'明确说到项目上线'}]}):JSON.stringify({action:'reply',text:'项目快上线了，记得给自己留点喘气的时间。',reason:'回应当前话题'}),input:12,output:8,cache:0,callId:'fixture-call-'+calls.length};
 }};
 const event:Event={id:'x:900001',platformId:'900001',channel,userId:channel==='public'?'x:lin':'dm:fixture',handle:'lin',text:'你好可爱，我的项目下周上线，可以聊聊吗？',url:'https://x.com/lin/status/900001',conversationId:'900001',timestamp:at-2*3600000,timestampReliable:true,accountId:'fixture_bot',quote:{handle:'quoted',platformId:'800001',text:'明确标记的引用资料',media:false},card:{domain:'example.invalid',title:'卡片标题'}};
 const merged:Event[]=[{...event,id:'x:900000',platformId:'900000',text:'前一条消息：进度已经过半。',timestamp:at-2*3600000-60000}];
 const memory={memories:[{text:'对方喜欢读书',channel}],recent:[{message:'项目开始排期了',reply:'进展可以慢慢说。',timestamp:at-86400000,channel}],experiences:[{kind:'post',text:'此前发过的虚构晨间阅读帖子'}]};
 const transport={context:async()=>JSON.stringify({posts:[{platformId:'800000',handle:'lin',text:'明确可读的上文'}],targetId:'900001',contextIncomplete:false})} as unknown as Transport;
 const workflow=new Workflow(store,transport,generator,()=>config);
 try{
  store.set('activeAccount','fixture_bot');store.set('model:sessionNamespace','fixed-namespace');
  const service=new PersonaService(store,generator,()=>config);
  workflow.services={persona:service,memory:{context:()=>memory} as any,program:{run:async(name:string,_meta:any,fn:()=>Promise<any>)=>{stages.push(name);return fn();}} as any};
  workflow.abort=new AbortController();
  const result=await (workflow as any).generateDraft(event,config,persona,{recentCount:3,recentDays:7,retentionDays:30},{state:{content:'12:00–13:00 虚构午餐'}},'fixed-round',merged);
  return {channel,calls,stages,draft:result.draft};
 }finally{workflow.stop();store.db.close();rmSync(dir,{recursive:true,force:true});if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;}
}

test('公开与私信生产提示词符合 v5 明确变更后的冻结基线，调用顺序保持一致',{timeout:10000},async t=>{
 t.mock.method(Date,'now',()=>at);
 const value=[];for(const channel of ['public','private'] as Channel[])value.push(await record(channel));
 if(process.env.WRITE_REPLY_BASELINE==='1'){
  mkdirSync(dirname(fixturePath),{recursive:true});writeFileSync(fixturePath,JSON.stringify(value,null,2)+'\n');
 }else assert.deepEqual(value,JSON.parse(readFileSync(fixturePath,'utf8')));
 for(const row of value){assert.equal(row.calls.length,2);assert.equal(row.calls[0].metadata.purpose,'semantic-trigger');assert.equal(row.calls[1].metadata.purpose,'reply');assert.ok(row.calls[1].system.includes('固定夹具人格'));assert.ok(row.calls[1].user.includes('前一条消息'));assert.ok(row.calls[1].user.includes('对方喜欢读书'));assert.ok(row.calls[1].user.includes('此前发过'));}
});
