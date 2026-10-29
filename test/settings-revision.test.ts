import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mergePanelSettings,readPanelSettings,SettingsConflictError,panelDir } from '../src/settings.js';
import { loadConfig } from '../src/config.js';
import { writeExampleConfig } from './config-fixture.js';
function sandbox(){const dir=mkdtempSync(tmpdir()+'/role-revisions-'),old=process.env.DATA_DIR;process.env.DATA_DIR=dir;const path=dir+'/config.json';writeExampleConfig(path);return {path,close(){if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}};}
test('各页面独立修订与字段合并不会覆盖同时保存的其他设置',()=>{
 const s=sandbox();try{
  const persona=mergePanelSettings('persona',{sections:[{id:'old',content:'保留原文'}]},0);assert.equal(persona.revision,1);
  mergePanelSettings('tasks',{plans:{daily:{enabled:true,time:'06:00'},main:{intervalSeconds:90}}},0);
  mergePanelSettings('tasks',{plans:{daily:{time:'07:00'}}},1);
  mergePanelSettings('program',{mode:'auto',publicPerHour:12},0);mergePanelSettings('memory',{recentCount:4,recentDays:5,retentionDays:20},0);
  const current=readPanelSettings();assert.equal(current.persona?.sections[0].content,'保留原文');assert.equal(current.tasks?.plans.daily.enabled,true);assert.equal(current.tasks?.plans.daily.time,'07:00');assert.equal(current.revisions?.persona,1);
  const config=loadConfig(s.path);assert.equal(config.pollSeconds,90);assert.equal(config.mode,'auto');assert.equal(config.publicPerHour,12);assert.deepEqual(config.memoryPolicy,{recentCount:4,recentDays:5,retentionDays:20});assert.equal(config.retentionDays,20);
  assert.throws(()=>mergePanelSettings('persona',{sections:[]},0),SettingsConflictError);assert.equal(readPanelSettings().persona?.sections.length,1);
 }finally{s.close();}
});
test('保存纯配置不包含运行控制字段且拒绝原型污染',()=>{
 const s=sandbox();try{mergePanelSettings('persona',{sections:[]});assert.equal((readPanelSettings() as any).control,undefined);assert.throws(()=>mergePanelSettings('program',JSON.parse('{"__proto__":{"polluted":true}}')));assert.equal(({} as any).polluted,undefined);}finally{s.close();}
});
test('损坏设置只允许明确模型保存恢复；其他分区不能静默清空',()=>{
 const s=sandbox();try{
  mkdirSync(panelDir(),{recursive:true});writeFileSync(panelDir()+'/settings.json','{broken');assert.throws(()=>mergePanelSettings('persona',{sections:[]}));
  const result=mergePanelSettings('model',{provider:'custom',baseUrl:'https://model.example',id:'test',api:'openai-completions',reasoningLevel:'off',maxTokens:4096,timeoutMs:60000},0);assert.equal(result.revision,1);assert.equal(Object.hasOwn(readPanelSettings().model??{},'maxTokens'),false);
 }finally{s.close();}
});
