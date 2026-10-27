import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {registerModelRoutes} from '../src/model-routes.js';
import {ModelLibraryService} from '../src/model-library.js';
import {mergePanelSettings,readPanelSettings,writeModelKey,keySlot} from '../src/settings.js';
import {writeExampleConfig} from './config-fixture.js';

const KEY='library-secret-12345678';
const custom=(extra:any={})=>({provider:'custom',name:'自定义甲',baseUrl:'https://relay-one.example/v1',api:'openai-completions',apiKey:KEY,...extra});
const result=()=>({text:'MODEL_OK',input:9,output:2,cache:3,stopReason:'stop',latencyMs:18});
function setup(options:any={}){
 const directory=mkdtempSync(tmpdir()+'/role-library-'),previous={DATA_DIR:process.env.DATA_DIR,SECRETS_DIR:process.env.SECRETS_DIR,CONFIG_PATH:process.env.CONFIG_PATH};mkdirSync(directory+'/data');mkdirSync(directory+'/secrets');writeExampleConfig(directory+'/config.json');process.env.DATA_DIR=directory+'/data';process.env.SECRETS_DIR=directory+'/secrets';process.env.CONFIG_PATH=directory+'/config.json';
 const store=new Store(directory+'/data/test.sqlite'),deps={store,run:options.run??(async()=>result()),discover:options.discover??(async()=>({models:[{id:'unknown-one',known:false},{id:'unknown-two',known:false}],total:2}))},service=new ModelLibraryService(deps),app=Fastify();registerModelRoutes(app,deps);
 return {service,store,app,async close(){await app.close();store.db.close();for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(directory,{recursive:true,force:true});}};
}
async function addAndEdit(t:ReturnType<typeof setup>,extra:any={}){let library=await t.service.add({...custom(extra),revision:t.service.read().revision});const key=library.providers.at(-1)!.key;library=await t.service.updateModel(key,'unknown-one',{revision:library.revision,params:{reasoningLevel:'off',maxTokens:4096,timeoutMs:60000},custom:{contextWindow:65536,reasoning:false}});return {key,library};}

test('旧面板模型迁移保留参数、Key、测试结果，读取不改变运行配置',async()=>{
 const t=setup();try{
  const model={provider:'custom',baseUrl:'https://legacy.example/v1',api:'openai-completions' as const,id:'legacy-unknown',reasoningLevel:'low' as const,maxTokens:3072,timeoutMs:90000,custom:{contextWindow:131072,reasoning:true}};mergePanelSettings('model',model,0);writeModelKey(keySlot(model.provider,model.baseUrl),KEY);t.store.set('model:lastTest',JSON.stringify({ok:true,at:123,latencyMs:40,provider:model.provider,id:model.id}));
  const before=structuredClone(readPanelSettings().model),library=await t.service.view(),p=library.providers[0];assert.equal(p.key,'custom-legacy');assert.equal(library.active.default?.modelId,model.id);assert.equal(p.models[0].lastTest?.ok,true);assert.deepEqual(p.models[0].custom,model.custom);assert.equal(p.models[0].params.maxTokens,3072);assert.equal(p.keyHint,'••••5678');assert.deepEqual(readPanelSettings().model,before);assert.equal(readPanelSettings().revisions?.model,1);assert.ok(!JSON.stringify(library).includes(KEY));assert.deepEqual(await t.service.view(),library);
 }finally{await t.close();}
});

test('添加自动发现、未知模型要求参数、未测试启用需明确确认',async()=>{
 const calls:any[]=[];const t=setup({discover:async(input:any)=>{calls.push(input);return {models:[{id:'unknown-one',known:false}],total:1};}});try{
  let library=await t.service.add({...custom(),revision:t.service.read().revision}),key=library.providers[0].key;assert.equal(calls.length,1);assert.equal(calls[0].apiKey,KEY);assert.equal(library.providers[0].models[0].params.maxTokens,4096);
  await assert.rejects(()=>t.service.activate({key,modelId:'unknown-one',revision:library.revision,confirmUntested:true}),/上下文长度/);
  library=await t.service.updateModel(key,'unknown-one',{revision:library.revision,custom:{contextWindow:128000,reasoning:false}});
  await assert.rejects(()=>t.service.activate({key,modelId:'unknown-one',revision:library.revision}),error=>(error as any).statusCode===409&&(error as any).extra.requiresConfirmation===true);
  library=await t.service.activate({key,modelId:'unknown-one',revision:library.revision,confirmUntested:true});assert.equal(readPanelSettings().model?.id,'unknown-one');assert.equal(readPanelSettings().model?.maxTokens,4096);assert.equal(library.active.default?.key,key);assert.ok(!JSON.stringify(library).includes(KEY));
 }finally{await t.close();}
});

test('切换服务商再切回保留连接与参数，使用中服务商不能删除',async()=>{
 const t=setup();try{
  const a=await addAndEdit(t);let library=await t.service.activate({key:a.key,modelId:'unknown-one',revision:a.library.revision,confirmUntested:true});const b=await addAndEdit(t,{name:'自定义乙',baseUrl:'https://relay-two.example/v1'});library=await t.service.activate({key:b.key,modelId:'unknown-one',revision:b.library.revision,confirmUntested:true});
  await assert.rejects(()=>t.service.remove(b.key,library.revision),/先切换/);library=await t.service.activate({key:a.key,modelId:'unknown-one',revision:library.revision,confirmUntested:true});assert.equal(readPanelSettings().model?.baseUrl,'https://relay-one.example/v1');assert.equal(library.providers.find(p=>p.key===b.key)?.hasKey,true);assert.equal(library.providers.find(p=>p.key===a.key)?.models[0].params.maxTokens,4096);
 }finally{await t.close();}
});

test('刷新保留使用、已测试和已编辑模型并标记未返回，未编辑发现条目可替换',async()=>{
 let ids=['unknown-one','unknown-two'];const t=setup({discover:async()=>({models:ids.map(id=>({id,known:false})),total:ids.length})});try{
  const state=await addAndEdit(t);let library=await t.service.activate({key:state.key,modelId:'unknown-one',revision:state.library.revision,confirmUntested:true});ids=['new-model'];library=await t.service.refresh(state.key,library.revision);const models=library.providers[0].models;assert.equal(models.find(x=>x.id==='unknown-one')?.missing,true);assert.equal(models.some(x=>x.id==='unknown-two'),false);assert.equal(models.some(x=>x.id==='new-model'),true);assert.equal(library.active.default?.modelId,'unknown-one');
 }finally{await t.close();}
});

test('目录发现失败保留服务商并回退目录，自定义失败可以手动添加',async()=>{
 const t=setup({discover:async()=>{throw new Error('上游失败 '+KEY);}});try{
  let library=await t.service.add({provider:'deepseek',apiKey:KEY,revision:t.service.read().revision});assert.ok(library.providers[0].models.length>0);assert.equal(library.providers[0].models[0].source,'catalog');assert.match(library.providers[0].fetchError||'',/上游失败/);assert.ok(!JSON.stringify(library).includes(KEY));
  library=await t.service.add({...custom(),revision:library.revision});const key=library.providers.at(-1)!.key;assert.equal(library.providers.at(-1)?.models.length,0);library=await t.service.updateModel(key,'manual-model',{revision:library.revision,custom:{contextWindow:128000,reasoning:false}});assert.equal(library.providers.at(-1)?.models[0].source,'manual');
 }finally{await t.close();}
});

test('修改主机必须重填Key且旧Key不会发送到新主机，连接修改清除测试结果',async()=>{
 const t=setup();try{
  const state=await addAndEdit(t);let tested=await t.service.test(state.key,'unknown-one',state.library.revision);assert.equal(tested.library.providers[0].ready,true);
  await assert.rejects(()=>t.service.update(state.key,{baseUrl:'https://new-host.example/v1',revision:tested.library.revision}),/重新填写 API Key/);assert.equal(readPanelSettings().modelLibrary?.providers[0].baseUrl,'https://relay-one.example/v1');
  const library=await t.service.update(state.key,{baseUrl:'https://new-host.example/v1',apiKey:'new-key-87654321',revision:tested.library.revision});assert.equal(library.providers[0].ready,false);assert.equal(library.providers[0].keyHint,'••••4321');assert.equal(library.providers[0].models[0].lastTest,undefined);
 }finally{await t.close();}
});

test('每模型最小测试计入统一流水，只测试使用中模型才更新兼容测试结果',async()=>{
 const calls:any[]=[];const t=setup({run:async(...args:any[])=>{calls.push(args);return result();}});try{
  const state=await addAndEdit(t);let tested=await t.service.test(state.key,'unknown-one',state.library.revision);assert.equal(tested.result.ok,true);assert.equal(calls[0][4].maxTokens,16);assert.equal(calls[0][4].reasoning,'off');assert.equal(t.store.db.prepare("SELECT COUNT(*) n FROM llm_calls WHERE purpose='model-test'").get()?.n,1);assert.equal(t.store.get('model:lastTest','null'),'null');
  const library=await t.service.activate({key:state.key,modelId:'unknown-one',revision:tested.library.revision});tested=await t.service.test(state.key,'unknown-one',library.revision);assert.equal(JSON.parse(t.store.get('model:lastTest')).id,'unknown-one');assert.equal(tested.library.providers[0].models[0].lastTest?.ok,true);
 }finally{await t.close();}
});

test('旧PUT同步登记和使用中物化是一次设置提交，其他设置不丢失',async()=>{
 const t=setup();try{
  mergePanelSettings('persona',{sections:[{id:'kept',content:'保留'}]},0);const saved=await t.app.inject({method:'PUT',url:'/api/model',payload:{settings:{...custom(),id:'legacy-entry',reasoningLevel:'off',maxTokens:2048,timeoutMs:60000,custom:{contextWindow:128000,reasoning:false}},apiKey:KEY,revision:0}});assert.equal(saved.statusCode,200,saved.body);
  const panel=readPanelSettings();assert.equal(panel.revisions?.model,1);assert.equal(panel.revisions?.modelLibrary,1);assert.equal(panel.modelLibrary?.active.default?.modelId,'legacy-entry');assert.equal(panel.persona?.sections[0].content,'保留');assert.ok(!saved.body.includes(KEY));
 }finally{await t.close();}
});

test('修订冲突不覆盖模型或密钥，旧model独立修改后按实际运行值修复库',async()=>{
 const t=setup();try{
  const state=await addAndEdit(t);let library=await t.service.activate({key:state.key,modelId:'unknown-one',revision:state.library.revision,confirmUntested:true});const revision=library.revision;
  library=await t.service.update(state.key,{name:'新名称',revision});await assert.rejects(()=>t.service.update(state.key,{apiKey:'do-not-write-0000',name:'过期修改',revision}),error=>(error as any).statusCode===409);assert.equal((await t.service.view()).providers[0].keyHint,'••••5678');
  const old=readPanelSettings().model!;mergePanelSettings('model',{...old,maxTokens:1024},readPanelSettings().revisions?.model);const fixed=await t.service.view();assert.equal(fixed.providers[0].models.find(m=>m.id==='unknown-one')?.params.maxTokens,1024);assert.equal(readPanelSettings().model?.maxTokens,1024);
 }finally{await t.close();}
});

test('接口返回明确修订/确认冲突，模型参数只保存白名单字段',async()=>{
 const t=setup();try{
  const library=await t.service.add({...custom(),revision:t.service.read().revision}),key=library.providers[0].key;
  const edit=await t.app.inject({method:'PUT',url:'/api/model/library/'+key+'/models/unknown-one',payload:{revision:library.revision,params:{maxTokens:2048,apiKey:'must-not-persist',timeoutMs:60000,reasoningLevel:'off'},custom:{contextWindow:128000,reasoning:false}}});assert.equal(edit.statusCode,200,edit.body);assert.ok(!edit.body.includes('must-not-persist'));assert.ok(!JSON.stringify(readPanelSettings()).includes('must-not-persist'));
  const active=await t.app.inject({method:'PUT',url:'/api/model/active',payload:{key,modelId:'unknown-one',revision:edit.json().revision}});assert.equal(active.statusCode,409);assert.equal(active.json().requiresConfirmation,true);
  const stale=await t.app.inject({method:'POST',url:'/api/model/library/'+key+'/refresh',payload:{revision:library.revision}});assert.equal(stale.statusCode,409);
 }finally{await t.close();}
});

test('按模型库接口文档完成添加、参数、测试计费、启用及兼容model读回',async()=>{
 const t=setup();try{
  const initial=await t.app.inject({method:'GET',url:'/api/model'});assert.equal(initial.statusCode,200,initial.body);assert.equal(initial.json().source,'config');assert.equal(initial.json().settings,null);
  const added=await t.app.inject({method:'POST',url:'/api/model/library',payload:{...custom(),revision:initial.json().library.revision}});assert.equal(added.statusCode,200,added.body);const key=added.json().providers[0].key,path='/api/model/library/'+encodeURIComponent(key)+'/models/unknown-one';
  const edited=await t.app.inject({method:'PUT',url:path,payload:{revision:added.json().revision,params:{reasoningLevel:'high',maxTokens:3072,timeoutMs:45000},custom:{contextWindow:65536,reasoning:true}}});assert.equal(edited.statusCode,200,edited.body);
  const tested=await t.app.inject({method:'POST',url:path+'/test',payload:{revision:edited.json().revision}});assert.equal(tested.statusCode,200,tested.body);assert.equal(tested.json().result.ok,true);assert.ok(tested.json().result.callId);const call=t.store.db.prepare('SELECT purpose,status,source FROM llm_calls WHERE id=?').get(tested.json().result.callId)!;assert.equal(call.purpose,'model-test');assert.equal(call.status,'completed');assert.equal(call.source,'model-library:'+key);
  const activated=await t.app.inject({method:'PUT',url:'/api/model/active',payload:{key,modelId:'unknown-one',revision:tested.json().library.revision}});assert.equal(activated.statusCode,200,activated.body);
  const read=await t.app.inject({method:'GET',url:'/api/model'});assert.equal(read.statusCode,200,read.body);const saved=read.json();assert.equal(saved.source,'panel');assert.deepEqual(saved.library.active.default,{key,modelId:'unknown-one'});assert.equal(saved.settings.id,'unknown-one');assert.equal(saved.settings.baseUrl,'https://relay-one.example/v1');assert.equal(saved.settings.api,'openai-completions');assert.equal(saved.settings.reasoningLevel,'high');assert.equal(saved.settings.maxTokens,3072);assert.equal(saved.settings.timeoutMs,45000);assert.deepEqual(saved.settings.custom,{contextWindow:65536,reasoning:true});assert.equal(saved.library.providers[0].models.find((m:any)=>m.id==='unknown-one').lastTest.ok,true);assert.equal(saved.keys['custom@relay-one.example'],'••••5678');assert.equal(saved.library.providers[0].keyHint,'••••5678');
  for(const response of [initial,added,edited,tested,activated,read])assert.ok(!response.body.includes(KEY));
 }finally{await t.close();}
});
