import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DailyStateService,type DailyContent } from '../src/daily-state.js';
import { PersonaService } from '../src/persona.js';
import type { Generator } from '../src/model.js';
import type { Config } from '../src/types.js';
import { exampleConfig } from './config-fixture.js';

function content(date='2026-10-28'):DailyContent{return {date,fictional:true,periods:[{start:'06:00',end:'24:00',activity:'读书'}],meals:{breakfast:'粥',lunch:'饭',dinner:'面'},activities:['读书'],mood:'平静'};}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'role-daily-persona-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite'));store.set('control','running');
 const at=Date.parse('2026-10-28T07:00:00+08:00');
 const generator:Generator={async complete(c,system,user){return {text:JSON.stringify(content(JSON.parse(user).date)),input:10,output:10,cache:0};}};
 let identity={id:'first',name:'第一人设',revision:3};
 const original=PersonaService.prototype.activeIdentity;
 PersonaService.prototype.activeIdentity=()=>structuredClone(identity);
 const daily=new DailyStateService(store,generator,()=>structuredClone(exampleConfig) as Config,()=>at);
 return {store,daily,generator,set identity(next:typeof identity){identity=next;},close(){PersonaService.prototype.activeIdentity=original;store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};
}

test('旧日程没有元数据时显示未记录，读取不新增runtime记录',()=>{
 const f=fixture();try{
  f.store.db.prepare('INSERT INTO daily_revisions(account_id,local_date,revision,content,source,generated_at,config_revision) VALUES(?,?,?,?,?,?,?)').run('worker','2026-10-28',1,JSON.stringify(content()),'automatic',1,0);
  const before=f.store.db.prepare('SELECT * FROM runtime ORDER BY key').all();
  assert.equal(f.daily.get('worker')?.persona,null);assert.equal(f.daily.get('worker')?.personaName,'未记录');
  assert.equal(f.daily.history('worker')[0]?.personaName,'未记录');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM runtime ORDER BY key').all(),before);
 }finally{f.close();}
});

test('生成记录开始时的人设快照，生成中切换不改写来源，数据库迁移不变',async()=>{
 const f=fixture();try{
  const migrations=f.store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  let finish!:(response:any)=>void;
  f.generator.complete=async()=>new Promise(resolve=>{finish=resolve;});
  const pending=f.daily.ensure('worker');
  f.identity={id:'second',name:'第二人设',revision:1};
  finish({text:JSON.stringify(content()),input:10,output:10,cache:0});
  const result=await pending;
  assert.equal(result.status,'ready');assert.deepEqual(result.state?.persona,{id:'first',name:'第一人设',revision:3});
  assert.deepEqual(JSON.parse(f.store.get('daily-persona:worker:2026-10-28:1')),{id:'first',name:'第一人设',revision:3});
  assert.equal(f.daily.history('worker')[0]?.personaName,'第一人设');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),migrations);
 }finally{f.close();}
});

test('编辑保存新修订人设来源，清理三十天前元数据而保留日程与其他runtime键',()=>{
 const f=fixture();try{
  f.store.set('daily-persona:another:2026-09-27:1','{}');
  f.store.set('daily-persona:another:2026-09-28:1','{}');
  f.store.set('daily-persona:not-a-date','保留异常键');
  f.store.set('another-runtime','保持不变');
  f.daily.edit('worker','2026-10-28',content(),0);
  f.identity={id:'second',name:'第二人设',revision:1};
  const edited=f.daily.edit('worker','2026-10-28',content(),1);
  assert.equal(edited.revision,2);assert.equal(edited.personaName,'第二人设');
  assert.deepEqual(edited.persona,{id:'second',name:'第二人设',revision:1});
  assert.deepEqual(JSON.parse(f.store.get('daily-persona:worker:2026-10-28:1')),{id:'first',name:'第一人设',revision:3});
  assert.equal(f.store.get('daily-persona:another:2026-09-27:1'),'');
  assert.equal(f.store.get('daily-persona:another:2026-09-28:1'),'{}');
  assert.equal(f.store.get('daily-persona:not-a-date'),'保留异常键');
  assert.equal(f.store.get('another-runtime'),'保持不变');
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM daily_revisions').get() as any).n,2);
 }finally{f.close();}
});

test('无效来源元数据只显示未记录，不阻断日程读取',()=>{
 const f=fixture();try{
  f.daily.edit('worker','2026-10-28',content(),0);
  f.store.set('daily-persona:worker:2026-10-28:1','{损坏');
  assert.equal(f.daily.get('worker')?.personaName,'未记录');assert.equal(f.daily.describe('worker').status,'ready');
 }finally{f.close();}
});
