import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { PersonaService,legacyPersona } from '../src/persona.js';
import type { Config } from '../src/types.js';
import { exampleConfig } from './config-fixture.js';

function fixture(text='普通口语'){
 const dir=mkdtempSync(tmpdir()+'/style-preview-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(dir+'/workflow.sqlite'),requests:Array<{system:string;user:string}>=[];
 const generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},complete:async(_c:any,system:string,user:string)=>{requests.push({system,user});return {text:JSON.stringify({action:'reply',text,reason:''}),input:1,output:1,cache:0};}};
 const persona=new PersonaService(store,generator,()=>structuredClone(exampleConfig) as Config);
 return {store,persona,requests,close(){store.db.close();rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}
const request={persona:legacyPersona('隔离试聊角色'),channel:'public',messages:[{role:'user',text:'今天聊点什么'}]};

test('试聊格式只作标记，合法正文照常返回，空标记也明确提供',async()=>{
 for(const [text,issues] of [['1. 先喝水\n2. 再散步',['list-or-steps']],['**今天天气不错**',['markdown']],['普通口语',[]]] as const){
  const f=fixture(text);try{const result=await f.persona.preview(request);assert.equal(result.draft?.text,text);assert.deepEqual(result.format,{issues});assert.deepEqual(result.draft?.format,{issues});assert.equal(result.error,undefined);assert.equal(f.requests.length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get()?.n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory').get()?.n,0);}finally{f.close();}
 }
});

test('模拟记忆支持旧文字和有界近期往来对象，公开过滤私信且不读取真实记录',async()=>{
 const f=fixture();try{
  const legacy=await f.persona.preview({...request,memory:'管理员提供的模拟记忆'});assert.ok(legacy.segments.find(s=>s.kind==='memory')?.content.includes('管理员提供的模拟记忆'));
  const result=await f.persona.preview({...request,memory:{items:['管理员模拟事实'],recent:[{id:'old',channel:'public',message:'昨天的问候',reply:'已发出的独特口癖',timestamp:1},{channel:'private',message:'不得公开的私信原文',reply:'不得公开的私信回复',timestamp:2}]}});
  const recent=result.segments.find(s=>s.kind==='recent')!;assert.ok(recent.content.includes('已发出的独特口癖'));assert.ok(!JSON.stringify(result.segments).includes('不得公开'));assert.equal(f.requests.length,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get()?.n,0);
  await assert.rejects(f.persona.preview({...request,memory:{items:'字'.repeat(8001)}}),/8,000/);
  await assert.rejects(f.persona.preview({...request,memory:{recent:[{message:'模拟消息',reply:123}]}}),/近期往来/);
  await assert.rejects(f.persona.preview({...request,memory:[]}),/文字或对象/);assert.equal(f.requests.length,2);
 }finally{f.close();}
});
