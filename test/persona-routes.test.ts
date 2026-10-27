import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PersonaService,legacyPersona } from '../src/persona.js';
import { DailyStateService } from '../src/daily-state.js';
import { registerPersonaRoutes } from '../src/persona-routes.js';
import type { Config } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'persona-api-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite'));store.set('control','paused');
 const config=()=>structuredClone(exampleConfig) as Config;
 const generator:Generator={async complete(){return {text:'{"action":"reply","text":"你好","reason":"回应"}',input:10,output:3,cache:0};}};
 const persona=new PersonaService(store,generator,config),daily=new DailyStateService(store,generator,config);
 const app=Fastify({bodyLimit:16384});
 app.addHook('onRequest',async(req,reply)=>{if(req.headers['x-test-auth']!=='valid')return reply.code(401).send({error:'未授权'});});
 registerPersonaRoutes(app,{store,persona,daily,accountId:()=> 'worker-a'});await app.ready();
 return {app,store,async close(){await app.close();store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};
}
const headers={'x-test-auth':'valid'};

test('人设API沿用宿主鉴权，保存修订冲突明确且不恢复处理',async()=>{
 const f=await fixture();try{
  assert.equal((await f.app.inject({url:'/api/persona'})).statusCode,401);
  const read=await f.app.inject({url:'/api/persona',headers});assert.equal(read.statusCode,200);assert.equal(read.json().revision,0);assert.equal(read.json().scheduleTime,'06:00');
  const save=await f.app.inject({method:'PUT',url:'/api/persona',headers,payload:{persona:legacyPersona('接口草稿'),revision:0}});assert.equal(save.statusCode,200);assert.equal(save.json().revision,1);
  assert.equal((await f.app.inject({method:'PUT',url:'/api/persona',headers,payload:{persona:legacyPersona('旧稿'),revision:0}})).statusCode,409);assert.equal(f.store.get('control'),'paused');
 }finally{await f.close();}
});

test('人设与试聊路由容许128KiB以内文稿，超出body limit仍拒绝',async()=>{
 const f=await fixture();try{
  const payload={persona:legacyPersona('a'.repeat(19000)),channel:'public',messages:[{role:'user',text:'b'.repeat(10000)}]};
  const response=await f.app.inject({method:'POST',url:'/api/persona/preview',headers,payload});assert.equal(response.statusCode,200);assert.equal(response.json().draft.text,'你好');
  const large=await f.app.inject({method:'POST',url:'/api/persona/preview',headers,payload:{...payload,extra:'x'.repeat(130000)}});assert.equal(large.statusCode,413);
 }finally{await f.close();}
});
