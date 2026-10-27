import { Store } from './store.js';
import { PiGenerator } from './model.js';
import { MemoryService } from './memory.js';
import { billingTotals } from './llm-store.js';
import { loadConfig } from './config.js';
import { ReplyTriage } from './reply-triage.js';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const data=process.env.DATA_DIR||'/data';const s=new Store(data+'/workflow.sqlite');
const generator=new PiGenerator(s),memory=new MemoryService(s,generator);
const [command,arg,arg2]=process.argv.slice(2);
try{
 if(command==='status')console.log(JSON.stringify({control:s.get('control'),stats:{...s.stats(),usage:billingTotals(s.db)},config:loadConfig()},null,2));
 else if(command==='drafts')console.log(JSON.stringify(s.db.prepare("SELECT id,channel,body,draft,error FROM messages WHERE status IN ('draft','failed','unknown') ORDER BY created_at DESC LIMIT 50").all(),null,2));
 else if(command==='forget'&&arg){s.forget(arg);console.log('已遗忘并停止记录');}
 else if(command==='remember'&&arg){s.remember(arg);console.log('已恢复记录');}
 else if(command==='apply-forget-ledger'){s.replayForgetLedger();console.log('遗忘记录已重放');}
 else if(command==='retry'&&arg){const row=s.getMessage(arg);if(!row)throw Error('消息不存在或来源标识不唯一，请使用完整消息ID');new ReplyTriage(s).requeue(row.id,row.account_id);console.log('已重新排队；仍受时效、额度、退避与草稿审核约束');}
 else if(command==='summarize'&&arg&&['public','private'].includes(arg2)){
  const account=s.get('activeAccount').trim().toLowerCase();if(!/^[a-z0-9_]{1,15}$/.test(account))throw Error('没有已确认的工作账号，不能把未知归属记录交给模型整理');
  const result=await memory.summarize(arg,arg2 as 'public'|'private',account,{force:true,source:'cli'});console.log(result.written?'摘要更新完成':'摘要未更新：'+('reason' in result?result.reason:'数据修订已变化'));
 }
 else if(command==='model-check'){const c=loadConfig();const r=await generator.complete(c,'你是接口验收助手。只输出 MODEL_OK。','请验证当前配置。',undefined,undefined,{purpose:'model-test',source:'cli'});console.log(JSON.stringify({ok:r.text.includes('MODEL_OK'),input:r.input,output:r.output,cache:r.cache,callId:r.callId,usage:r.usage,cost:r.cost,pricingStatus:r.pricingStatus}));}
 else if(command==='backup'){
  mkdirSync(data+'/backups',{recursive:true});const path=data+'/backups/workflow-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite';
  s.db.exec("VACUUM INTO '"+path+"'");const copy=new DatabaseSync(path,{readOnly:true});console.log(JSON.stringify({path,integrity:copy.prepare('PRAGMA integrity_check').get()}));copy.close();
 }else throw Error('命令：status | drafts | forget 用户ID | remember 用户ID | retry 消息ID | summarize 用户ID public/private | model-check | backup | apply-forget-ledger');
}finally{s.db.close();}
