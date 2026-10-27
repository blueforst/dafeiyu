import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { PiGenerator } from './model.js';
import { BrowserTransport } from './transport.js';
import { readSecret,loadConfig } from './config.js';
import { mkdirSync,readFileSync,writeFileSync,renameSync,existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const data=process.env.DATA_DIR||'/data';const s=new Store(data+'/workflow.sqlite');
const [command,arg,arg2]=process.argv.slice(2);
const ledgerPath=data+'/forget-ledger.json';
function ledger():Record<string,boolean>{try{return JSON.parse(readFileSync(ledgerPath,'utf8'));}catch{return {};}}
function saveLedger(v:Record<string,boolean>){writeFileSync(ledgerPath+'.tmp',JSON.stringify(v),{mode:0o600});renameSync(ledgerPath+'.tmp',ledgerPath);}
try{
 if(command==='status')console.log(JSON.stringify({control:s.get('control'),stats:s.stats(),config:loadConfig()},null,2));
 else if(command==='drafts')console.log(JSON.stringify(s.db.prepare("SELECT id,channel,body,draft,error FROM messages WHERE status IN ('draft','failed','unknown') ORDER BY created_at DESC LIMIT 50").all(),null,2));
 else if(command==='forget'&&arg){s.forget(arg);console.log('已遗忘并停止记录');}
 else if(command==='remember'&&arg){s.remember(arg);console.log('已恢复记录');}
 else if(command==='apply-forget-ledger'){for(const [id,forgot] of Object.entries(ledger()))if(forgot)s.forget(id);console.log('遗忘记录已重放');}
 else if(command==='retry'&&arg){const row=s.getMessage(arg);if(!row||!['failed','draft','skipped'].includes(row.status))throw Error('只允许重新处理已失败、草稿或跳过的消息；未知发送必须先核对');s.update(arg,'queued');console.log('已重新排队');}
 else if(command==='summarize'&&arg&&['public','private'].includes(arg2)){const w=new Workflow(s,new BrowserTransport('http://browser:3001',readSecret('browser_key')),new PiGenerator());await w.summarize(arg,arg2 as any);console.log('摘要更新完成');}
 else if(command==='model-check'){const c=loadConfig();const r=await new PiGenerator().complete(c,'你是接口验收助手。只输出 MODEL_OK。','请验证当前配置。');console.log(JSON.stringify({ok:r.text.includes('MODEL_OK'),input:r.input,output:r.output,cache:r.cache}));}
 else if(command==='backup'){
  mkdirSync(data+'/backups',{recursive:true});const path=data+'/backups/workflow-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite';
  s.db.exec("VACUUM INTO '"+path+"'");const copy=new DatabaseSync(path,{readOnly:true});console.log(JSON.stringify({path,integrity:copy.prepare('PRAGMA integrity_check').get()}));copy.close();
 }else throw Error('命令：status | drafts | forget 用户ID | remember 用户ID | retry 消息ID | summarize 用户ID public/private | model-check | backup | apply-forget-ledger');
}finally{s.db.close();}
