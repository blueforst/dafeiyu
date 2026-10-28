import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { MemoryService } from '../src/memory.js';
import { PersonaService,legacyPersona } from '../src/persona.js';
import { commitPersonaLibrary,mergePanelSettings,readPanelSettings,writeModelKey } from '../src/settings.js';
import type { Config } from '../src/types.js';
import type { Generator } from '../src/model.js';
import { exampleConfig } from './config-fixture.js';

function fixture(){
 const root=fs.mkdtempSync(join(tmpdir(),'persona-library-fault-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
 const store=new Store(join(root,'workflow.sqlite')),config=()=>structuredClone(exampleConfig) as Config;
 const generator:Generator={async complete(){throw new Error('本组故障验证不允许调用模型');}};
 new MemoryService(store,generator,config);const persona=new PersonaService(store,generator,config);store.set('control','manual');
 mergePanelSettings('program',{mode:'auto',publicPerDay:180,privatePerDay:400,replyHours:{enabled:true,closeDelayMinutes:30}},0);
 mergePanelSettings('model',{provider:'custom',id:'mock-persistence',baseUrl:'https://mock.invalid',reasoningLevel:'off',maxTokens:4096,timeoutMs:60000},0);
 mergePanelSettings('memory',{recentCount:3,recentDays:7,retentionDays:30},0);mergePanelSettings('health',{requiredPhrases:['AI']},0);writeModelKey('mock@fixture.invalid','local-fixture-key');
 persona.save(legacyPersona('镜像专有正文，不能出现在故障日志。'),0);
 return {root,store,persona,file:join(root,'panel/settings.json'),keyFile:join(root,'panel/model-keys.json'),close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}};
}
const bytes=(file:string)=>fs.readFileSync(file,'utf8');
const otherDomains=(panel:any)=>Object.fromEntries(['model','modelLibrary','memory','program','tasks','promptHints','triage','health'].map(key=>[key,panel[key]]));
const eio=()=>Object.assign(new Error('注入磁盘写入失败'),{code:'EIO'});

test('坏人设库不阻断生产镜像组装，也不覆盖原文件或其他设置域',async()=>{
 const f=fixture();try{
  const good=readPanelSettings(),mirror=f.persona.get(),keys=bytes(f.keyFile),others=otherDomains(good);
  for(const mutate of [(panel:any)=>panel.personaLibrary.version=99,(panel:any)=>panel.personaLibrary.items=[],(panel:any)=>panel.personaLibrary.items[0].persona.sections[0].content='字'.repeat(20001)]){
   const broken=structuredClone(good);mutate(broken);fs.writeFileSync(f.file,JSON.stringify(broken));const before=bytes(f.file);
   assert.throws(()=>f.persona.library.list(),{statusCode:500});assert.throws(()=>f.persona.library.create({from:'blank'}),{statusCode:500});assert.throws(()=>f.persona.library.save('current',{revision:mirror.revision,persona:legacyPersona('不能覆盖')}),{statusCode:500});assert.deepEqual(f.persona.get(),mirror);
   const assembled=await f.persona.assemble({accountId:'real_bot',channel:'public',message:'今天继续聊项目。'});assert.ok(assembled.system.includes('镜像专有正文'));assert.equal(bytes(f.file),before);assert.equal(bytes(f.keyFile),keys);assert.deepEqual(otherDomains(readPanelSettings()),others);assert.equal(f.store.get('control'),'manual');
  }
  assert.ok(!JSON.stringify(f.store.logs()).includes('镜像专有正文'));
 }finally{f.close();}
});

test('整库、单项和兼容镜像修订冲突不改字节，其他域最新值保持',()=>{
 const f=fixture();try{
  const state=f.persona.library.read(),item=state.library.items[0],beforeLibrary=structuredClone(state.library);
  mergePanelSettings('program',{maxPerRound:3},readPanelSettings().revisions?.program);mergePanelSettings('memory',{recentCount:4},readPanelSettings().revisions?.memory);const before=bytes(f.file),keys=bytes(f.keyFile);
  assert.throws(()=>f.persona.library.save(item.id,{revision:item.revision-1,persona:legacyPersona('陈旧项')}),{statusCode:409});
  assert.throws(()=>commitPersonaLibrary(beforeLibrary,{expectedLibraryRevision:state.libraryRevision-1}),{statusCode:409});
  assert.throws(()=>commitPersonaLibrary(beforeLibrary,{expectedLibraryRevision:state.libraryRevision,itemId:item.id,expectedItemRevision:item.revision-1}),{statusCode:409});
  assert.throws(()=>commitPersonaLibrary(beforeLibrary,{expectedLibraryRevision:state.libraryRevision,expectedPersonaRevision:f.persona.get().revision-1}),{statusCode:409});
  assert.equal(bytes(f.file),before);assert.equal(bytes(f.keyFile),keys);
  f.persona.library.save(item.id,{revision:item.revision,name:'允许改名'});assert.equal(readPanelSettings().program?.maxPerRound,3);assert.equal(readPanelSettings().memory?.recentCount,4);assert.equal(bytes(f.keyFile),keys);
 }finally{f.close();}
});

for(const phase of ['writeFileSync','chmodSync','renameSync'] as const)test('原子人设保存的 '+phase+' 故障保留原镜像与整库且清理临时文件',()=>{
 const f=fixture();let interception:ReturnType<typeof mock.method>|undefined;
 try{
  const before=bytes(f.file),keys=bytes(f.keyFile),panel=readPanelSettings(),item=f.persona.library.getActive(),original=(fs as any)[phase];let injected=0;
  interception=mock.method(fs,phase,((...args:any[])=>{const target=String(args[0]);if(target.startsWith(f.file+'.')&&target.endsWith('.tmp')){injected++;if(phase==='writeFileSync')original(args[0],'{"partial":',args[2]);throw eio();}return original(...args);}) as any);syncBuiltinESMExports();
  assert.throws(()=>f.persona.library.save(item.id,{revision:item.revision,persona:legacyPersona('不应生效的新镜像')}),{code:'EIO'});assert.equal(injected,1);assert.equal(bytes(f.file),before);assert.equal(bytes(f.keyFile),keys);assert.deepEqual(readPanelSettings(),panel);assert.equal(f.persona.get().persona.sections[0].content,'镜像专有正文，不能出现在故障日志。');assert.ok(fs.readdirSync(join(f.root,'panel')).every(name=>!name.endsWith('.tmp')));
 }finally{interception?.mock.restore();syncBuiltinESMExports();f.close();}
});
