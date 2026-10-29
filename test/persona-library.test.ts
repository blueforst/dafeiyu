import {fakeConverse} from './tool-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PersonaService,legacyPersona,FIXED_SYSTEM_RULES } from '../src/persona.js';
import { readPanelSettings,mergePanelSettings } from '../src/settings.js';
import { registerPersonaLibraryRoutes } from '../src/persona-library-routes.js';
import { registerPersonaRoutes } from '../src/persona-routes.js';
import { DailyStateService } from '../src/daily-state.js';
import { defaultPersona,PERSONA_PRESETS } from '../src/persona-presets.js';
import { exampleConfig } from './config-fixture.js';
import type { Config } from '../src/types.js';
import type { Generator } from '../src/model.js';

function fixture(persona=exampleConfig.persona){
 const dir=mkdtempSync(join(tmpdir(),'persona-library-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 const store=new Store(join(dir,'workflow.sqlite')),config=()=>({...structuredClone(exampleConfig),persona}) as Config;
 const generator:Generator={async converse(...args:any[]){return fakeConverse(this,...args as [any,string,any[],any[]]);},async complete(){throw new Error('人设库不应调用模型');}},service=new PersonaService(store,generator,config);
 store.set('control','paused');return {dir,store,service,config,generator,file:join(dir,'panel/settings.json'),close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(dir,{recursive:true,force:true});}};
}

test('三种旧部署只读虚拟库与旧生效人设逐字一致，不写设置文件',()=>{
 for(const state of ['default','custom','saved']){
  const f=fixture(state==='custom'?'  配置人格原文\n第二行  ':exampleConfig.persona);try{
   if(state==='saved')mergePanelSettings('persona',legacyPersona('已保存人格正文'),0);
   const before=existsSync(f.file)?readFileSync(f.file,'utf8'):null,old=f.service.get(),view=f.service.library.list(),item=f.service.library.detail('current');
   assert.equal(view.activeId,'current');assert.equal(view.libraryRevision,0);assert.equal(view.items.length,1);assert.equal(item.name,'当前人设');assert.equal(item.origin.kind,'migrated');assert.deepEqual(item.persona,old.persona);assert.equal(item.revision,old.revision);assert.equal(item.fixedRules,FIXED_SYSTEM_RULES);
   assert.equal(existsSync(f.file)?readFileSync(f.file,'utf8'):null,before);if(state==='default')assert.deepEqual(item.persona,defaultPersona());
  }finally{f.close();}
 }
});

test('首次新建整体落库，未使用项保存不改生产镜像，切换与使用中保存才增加镜像修订',()=>{
 const f=fixture();try{
  mergePanelSettings('program',{mode:'draft'},0);const before=f.service.get(),made=f.service.library.create({from:'blank',name:'候选'}),id=made.item.id;
  assert.equal(made.item.revision,1);assert.equal(made.activeId,'current');assert.deepEqual(f.service.get(),before);assert.equal(readPanelSettings().personaLibrary?.items.length,2);assert.deepEqual(readPanelSettings().persona,before.persona);
  const saved=f.service.library.save(id,{revision:1,persona:legacyPersona('库内保密标记正文字串')});assert.equal(saved.item.revision,2);assert.deepEqual(f.service.get(),before);
  const switched=f.service.library.activate(id,saved.libraryRevision);assert.equal(switched.activeId,id);assert.equal(f.service.get().revision,before.revision+1);assert.equal(f.service.get().persona.sections[0].content,'库内保密标记正文字串');
  const renamed=f.service.library.save(id,{revision:2,name:'改名'});assert.equal(renamed.item.revision,3);assert.equal(f.service.get().revision,before.revision+1);
  f.service.library.save(id,{revision:3,persona:legacyPersona('再次改变正文')});assert.equal(f.service.get().revision,before.revision+2);assert.equal(f.store.get('control'),'paused');assert.equal(readPanelSettings().program?.mode,'draft');
  assert.ok(!JSON.stringify(f.store.logs()).includes('库内保密标记正文字串'));
 }finally{f.close();}
});

test('预设复制和空白来源正确，披露提醒只返回数据，旧版本读取镜像保持一致',()=>{
 const f=fixture();try{
  const preset=PERSONA_PRESETS.find(preset=>preset.id==='glm')!,made=f.service.library.create({from:'preset',presetId:'glm'});assert.deepEqual(made.item.persona,preset.persona);assert.equal(made.item.origin.presetVersion,3);
  const copied=f.service.library.create({from:'copy',sourceId:made.item.id});assert.ok(copied.item.name.includes('副本'));assert.deepEqual(copied.item.persona,made.item.persona);assert.equal(copied.item.origin.fromId,made.item.id);assert.equal(copied.item.origin.kind,'copy');
  const activated=f.service.library.activate(copied.item.id,copied.libraryRevision);assert.ok(activated.disclosure?.bioSuggestion.includes('非官方'));assert.equal(activated.disclosure?.requiresDisclosure,true);
  // 冻结旧版读取契约：面板 persona 优先于 config，未知的新分区被忽略。
  const oldGet=(settings:any,c:Config)=>settings.persona??legacyPersona(c.persona);assert.deepEqual(oldGet(JSON.parse(readFileSync(f.file,'utf8')),f.config()),f.service.get().persona);
  assert.equal(f.store.get('control'),'paused');assert.equal(readPanelSettings().health,undefined);
 }finally{f.close();}
});

test('数量、名称、使用中删除及两种修订冲突均不会覆盖原设置',()=>{
 const f=fixture();try{
  const made=f.service.library.create({from:'blank',name:'  唯一名称  '});assert.equal(made.item.name,'唯一名称');
  for(const bad of ['', '字'.repeat(41),'多\n行'])assert.throws(()=>f.service.library.create({from:'blank',name:bad}),/名称/);
  assert.throws(()=>f.service.library.create({from:'blank',name:'唯一名称'}),/存在/);
  const before=readFileSync(f.file,'utf8');assert.throws(()=>f.service.library.save(made.item.id,{revision:0,persona:legacyPersona('错误覆盖')}),{statusCode:409});assert.throws(()=>f.service.library.activate(made.item.id,0),{statusCode:409});assert.throws(()=>f.service.library.delete('current',0),{statusCode:409});assert.equal(readFileSync(f.file,'utf8'),before);
  for(let i=2;i<20;i++)f.service.library.create({from:'blank',name:'候选'+i});assert.equal(f.service.library.list().items.length,20);assert.throws(()=>f.service.library.create({from:'blank'}),/二十/);
  f.service.library.delete(made.item.id,made.item.revision);assert.equal(f.service.library.list().items.length,19);
 }finally{f.close();}
});

test('旧单人设保存更新库中使用中项，并继续用全局 persona 修订处理旧客户端冲突',()=>{
 const f=fixture();try{
  const one=f.service.save(legacyPersona('兼容接口第一次'),0);assert.equal(one.revision,1);assert.equal(f.service.library.detail('current').persona.sections[0].content,'兼容接口第一次');
  const made=f.service.library.create({from:'blank',name:'候选'});f.service.library.activate(made.item.id,made.libraryRevision);const before=f.service.get();assert.throws(()=>f.service.save(legacyPersona('过期'),1),{statusCode:409});
  const saved=f.service.save(legacyPersona('兼容接口新使用中'),before.revision);assert.equal(saved.revision,before.revision+1);assert.equal(f.service.library.detail(made.item.id).persona.sections[0].content,'兼容接口新使用中');
 }finally{f.close();}
});

test('坏库读取报错但生产镜像仍可用，失败不会修复或覆盖原文件',()=>{
 const f=fixture();try{
  f.service.save(legacyPersona('镜像正常'),0);const panel=readPanelSettings() as any;panel.personaLibrary.items=[];writeFileSync(f.file,JSON.stringify(panel));const before=readFileSync(f.file,'utf8');
  assert.throws(()=>f.service.library.list(),{statusCode:500});assert.throws(()=>f.service.library.create({from:'blank'}),{statusCode:500});assert.equal(f.service.get().persona.sections[0].content,'镜像正常');assert.deepEqual(f.service.activeIdentity(),{id:'current',name:'当前人设',revision:1});assert.equal(readFileSync(f.file,'utf8'),before);
 }finally{f.close();}
});

test('人设库管理接口覆盖CRUD与冲突，兼容单人设入口保持固定规则及修订字段',async()=>{
 const f=fixture(),app=Fastify();try{
  const daily=new DailyStateService(f.store,f.generator,f.config);registerPersonaLibraryRoutes(app,{store:f.store,persona:f.service});registerPersonaRoutes(app,{store:f.store,persona:f.service,daily,accountId:()=>''});
  const request=async(method:any,url:string,payload?:any)=>app.inject({method,url,payload});
  assert.equal((await request('GET','/api/personas')).json().activeId,'current');
  assert.equal((await request('GET','/api/persona/presets')).json().fixedRules,FIXED_SYSTEM_RULES);
  const made=(await request('POST','/api/personas',{from:'preset',presetId:'glm',name:'接口候选'})).json();assert.equal(made.ok,true);const url='/api/personas/'+made.item.id;
  const read=(await request('GET',url)).json();assert.equal(read.name,'接口候选');assert.equal(read.fixedRules,FIXED_SYSTEM_RULES);
  assert.equal((await request('PUT',url,{revision:0,name:'冲突'})).statusCode,409);
  const saved=(await request('PUT',url,{revision:read.revision,name:'新名称'})).json();assert.equal(saved.item.name,'新名称');
  const active=(await request('POST',url+'/activate',{libraryRevision:saved.libraryRevision})).json();assert.equal(active.disclosure.requiresDisclosure,true);
  assert.equal((await request('DELETE',url,{revision:saved.item.revision})).statusCode,409);
  const current=(await request('GET','/api/persona')).json();const legacy=await request('PUT','/api/persona',{revision:current.revision,persona:legacyPersona('接口兼容正文')});assert.equal(legacy.statusCode,200);assert.equal(legacy.json().fixedRules,FIXED_SYSTEM_RULES);
  const list=(await request('GET','/api/personas')).json();await request('POST','/api/personas/current/activate',{libraryRevision:list.libraryRevision});const updated=(await request('GET',url)).json();assert.equal((await request('DELETE',url,{revision:updated.revision})).statusCode,200);assert.equal((await request('GET',url)).statusCode,404);
  assert.equal(f.store.get('control'),'paused');
 }finally{await app.close();f.close();}
});

test('日程读取近七天包含失败和未生成日期，历史详情不高亮且接口只读',async()=>{
 const f=fixture(),app=Fastify();try{
  const at=Date.parse('2026-10-28T12:00:00+08:00'),daily=new DailyStateService(f.store,f.generator,f.config,()=>at);
  const content={date:'2026-10-27',fictional:true,periods:[{start:'09:00',end:'18:00',activity:'历史活动'}],meals:{breakfast:'面包',lunch:'米饭',dinner:'面'},activities:['阅读'],mood:'平静'};
  daily.edit('worker-a','2026-10-27',content,0);f.store.db.prepare('INSERT INTO daily_attempts(account_id,local_date,attempts,last_attempt_at,status,error) VALUES(?,?,?,?,?,?)').run('worker-a','2026-10-26',3,at-2*86400000,'failed','模型生成失败');
  registerPersonaRoutes(app,{store:f.store,persona:f.service,daily,accountId:()=> 'worker-a'});const before=JSON.stringify(f.store.db.prepare('SELECT * FROM daily_revisions').all()),response=await app.inject({url:'/api/persona/daily?date=2026-10-27'});assert.equal(response.statusCode,200);const result=response.json();assert.equal(result.date,'2026-10-27');assert.equal(result.currentPeriod,null);assert.equal(result.readOnly,true);assert.equal(result.today.personaName,'当前人设');assert.equal(result.days.length,7);assert.equal(result.days[0].date,'2026-10-28');assert.equal(result.days[0].status,'missing');assert.equal(result.days.find((day:any)=>day.date==='2026-10-26').status,'exhausted');
  assert.equal((await app.inject({url:'/api/persona/daily?date=2026-02-30'})).statusCode,400);assert.equal((await app.inject({method:'PUT',url:'/api/persona/daily',payload:{date:'2026-10-27',revision:1,content}})).statusCode,409);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM daily_revisions').all()),before);
 }finally{await app.close();f.close();}
});

test('人设导入导出往返只包含可移植内容，新建未启用并严格校验文件与名称',()=>{
 const f=fixture();try{
  const made=f.service.library.create({from:'preset',presetId:'glm'}),file=f.service.library.exportFile(made.item.id),before=f.service.get();
  assert.deepEqual(Object.keys(file).sort(),['format','name','persona','version']);assert.equal(file.format,'role-workflow-persona');assert.deepEqual(file.persona,made.item.persona);
  const imported=f.service.library.importFile({document:file});assert.notEqual(imported.item.id,made.item.id);assert.notEqual(imported.item.name,made.item.name);assert.deepEqual(imported.item.persona,made.item.persona);assert.equal(imported.item.origin.kind,'blank');
  assert.equal(imported.activeId,'current');assert.deepEqual(f.service.get(),before);assert.equal(f.service.library.detail(imported.item.id).origin.kind,'blank');
  const snapshot=readFileSync(f.file,'utf8');for(const document of [null,{}, {...file,version:3},{...file,format:'other'},{...file,persona:{sections:[],triggers:'bad'}},{...file,name:'x'.repeat(41)}])assert.throws(()=>f.service.library.importFile({document}));
  assert.throws(()=>f.service.library.importFile({document:file,name:made.item.name}),/已存在/);assert.equal(readFileSync(f.file,'utf8'),snapshot);assert.equal(f.store.get('control'),'paused');
  while(f.service.library.list().items.length<20)f.service.library.create({from:'blank'});const full=readFileSync(f.file,'utf8');assert.throws(()=>f.service.library.importFile({document:file}),/二十/);assert.equal(readFileSync(f.file,'utf8'),full);
 }finally{f.close();}
});
