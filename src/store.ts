import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Event, Channel, Draft, Receipt } from './types.js';
export class Store {
 db:DatabaseSync;ledgerPath:string;
 constructor(path:string){mkdirSync(dirname(path),{recursive:true});this.ledgerPath=dirname(path)+'/forget-ledger.json';this.db=new DatabaseSync(path);this.db.exec(`
 PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,forgot INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',draft TEXT,receipt TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory(user_id TEXT NOT NULL,visibility TEXT NOT NULL,summary TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,visibility));
 CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS messages_queue ON messages(status,created_at);
 CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id,channel,created_at);
 `);this.applyLedger();}
 private updateLedger(userId:string,forgot:boolean){let l:Record<string,boolean>={};try{l=JSON.parse(readFileSync(this.ledgerPath,'utf8'));}catch{}l[userId]=forgot;writeFileSync(this.ledgerPath+'.tmp',JSON.stringify(l),{mode:0o600});renameSync(this.ledgerPath+'.tmp',this.ledgerPath);}
 private applyLedger(){let l:Record<string,boolean>={};try{l=JSON.parse(readFileSync(this.ledgerPath,'utf8'));}catch{}for(const [id,forgot] of Object.entries(l))if(forgot){this.db.prepare('INSERT INTO users(id,forgot,epoch) VALUES(?,1,1) ON CONFLICT(id) DO UPDATE SET forgot=1,epoch=epoch+1').run(id);this.db.prepare('DELETE FROM messages WHERE user_id=?').run(id);this.db.prepare('DELETE FROM memory WHERE user_id=?').run(id);}}
 get(key:string,fallback=''){return (this.db.prepare('SELECT value FROM runtime WHERE key=?').get(key) as any)?.value??fallback;}
 set(key:string,value:string){this.db.prepare('INSERT INTO runtime VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
 log(event:string,detail='',level='info'){this.db.prepare('INSERT INTO logs(at,level,event,detail) VALUES(?,?,?,?)').run(Date.now(),level,event,detail);}
 boot(){this.db.exec("UPDATE messages SET status='queued' WHERE status='generating'; UPDATE messages SET status='unknown' WHERE status='sending'");this.set('control','paused');this.log('boot','服务启动，保持暂停；发送中的任务已转为待回查');}
 user(id:string){return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;}
 forgotten(id:string){return !!this.user(id)?.forgot;}
 epoch(id:string){return Number(this.user(id)?.epoch||0);}
 ingest(e:Event){if(this.forgotten(e.userId))return false;this.db.prepare('INSERT OR IGNORE INTO users(id) VALUES(?)').run(e.userId);return this.db.prepare('INSERT OR IGNORE INTO messages(id,channel,user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(e.id,e.channel,e.userId,JSON.stringify(e),e.timestamp,Date.now()).changes>0;}
 pending(limit=2){return this.db.prepare("SELECT * FROM messages WHERE status='queued' ORDER BY created_at DESC LIMIT ?").all(limit) as any[];}
 unknown(){return this.db.prepare("SELECT * FROM messages WHERE status='unknown' ORDER BY created_at LIMIT 10").all() as any[];}
 update(id:string,status:string,values:{draft?:Draft;receipt?:Receipt;error?:string}={}){this.db.prepare('UPDATE messages SET status=?,draft=COALESCE(?,draft),receipt=COALESCE(?,receipt),error=?,updated_at=? WHERE id=?').run(status,values.draft?JSON.stringify(values.draft):null,values.receipt?JSON.stringify(values.receipt):null,values.error||null,Date.now(),id);}
 getMessage(id:string){return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as any;}
 context(userId:string,channel:Channel){
  if(this.forgotten(userId))return {memories:[],recent:[]};
  const memories=this.db.prepare(channel==='public'?"SELECT visibility,summary FROM memory WHERE user_id=? AND visibility='public'":"SELECT visibility,summary FROM memory WHERE user_id=?").all(userId);
  const rows=this.db.prepare("SELECT body,draft,status FROM messages WHERE user_id=? AND (?='private' OR channel='public') AND status IN ('confirmed','draft') ORDER BY created_at DESC LIMIT 3").all(userId,channel) as any[];
  return {memories,recent:rows.reverse().map(r=>({message:JSON.parse(r.body).text,reply:r.status==='confirmed'?JSON.parse(r.draft||'{}').text:undefined}))};
 }
 originals(userId:string,visibility:Channel){return (this.db.prepare("SELECT body,draft,status FROM messages WHERE user_id=? AND channel=? ORDER BY created_at DESC LIMIT 30").all(userId,visibility) as any[]).reverse().map(r=>({message:JSON.parse(r.body).text,reply:r.status==='confirmed'?JSON.parse(r.draft||'{}').text:undefined}));}
 summary(userId:string,visibility:Channel,summary:string,epoch:number){if(this.forgotten(userId)||this.epoch(userId)!==epoch)return false;this.db.prepare('INSERT INTO memory VALUES(?,?,?,?) ON CONFLICT(user_id,visibility) DO UPDATE SET summary=excluded.summary,updated_at=excluded.updated_at').run(userId,visibility,summary,Date.now());return true;}
 forget(userId:string){this.db.exec('BEGIN IMMEDIATE');try{this.updateLedger(userId,true);this.db.prepare('INSERT INTO users(id,forgot,epoch) VALUES(?,1,1) ON CONFLICT(id) DO UPDATE SET forgot=1,epoch=epoch+1').run(userId);this.db.prepare('DELETE FROM messages WHERE user_id=?').run(userId);this.db.prepare('DELETE FROM memory WHERE user_id=?').run(userId);this.db.exec('COMMIT');this.log('forget','用户记忆已删除并停止记录');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 remember(userId:string){this.db.exec('BEGIN IMMEDIATE');try{this.updateLedger(userId,false);this.db.prepare('INSERT INTO users(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET forgot=0,epoch=epoch+1').run(userId);this.db.exec('COMMIT');this.log('remember','用户已恢复记忆记录');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 sentCount(channel:Channel){return Number((this.db.prepare("SELECT count(*) AS n FROM messages WHERE channel=? AND status IN ('confirmed','sending','unknown') AND updated_at>?").get(channel,Date.now()-3600000) as any).n);}
 logs(limit=100){return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);}
 stats(){return {messages:this.db.prepare('SELECT channel,status,count(*) AS count FROM messages GROUP BY channel,status').all(),usage:this.db.prepare('SELECT SUM(input_tokens) AS input,SUM(output_tokens) AS output,SUM(cache_read) AS cache FROM usage').get(),oldestQueued:(this.db.prepare("SELECT MIN(created_at) AS at FROM messages WHERE status='queued'").get() as any)?.at};}
 usage(input:number,output:number,cache:number){this.db.prepare('INSERT INTO usage(at,input_tokens,output_tokens,cache_read) VALUES(?,?,?,?)').run(Date.now(),input,output,cache);}
 prune(days:number){this.db.prepare("DELETE FROM messages WHERE created_at<? AND status NOT IN ('sending','unknown')").run(Date.now()-days*86400000);this.db.prepare('DELETE FROM logs WHERE at<?').run(Date.now()-30*86400000);}
}
