import type {Store} from './store.js';
import {applyMigration} from './migrations.js';
import {invalidateReplayMemory} from './persona-replay.js';

export const PLATFORM_IDENTITY_LINKS=false;
export type LinkSource='chat-test'|'platform'|'admin';
export type IdentityLink={accountId:string;privateUserId:string;publicUserId:string;source:LinkSource;createdAt:number;updatedAt:number};
export class IdentityLinkError extends Error {constructor(message:string,public statusCode=400){super(message);}}
export class IdentityLinks {
 constructor(private store:Store,private now:()=>number=Date.now,private chatTest=false){
  applyMigration(store.db,14,'公开与私信身份关联',`
   CREATE TABLE identity_links(account_id TEXT NOT NULL,private_user_id TEXT NOT NULL,public_user_id TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('chat-test','platform','admin')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(account_id,private_user_id));
   CREATE INDEX identity_links_public ON identity_links(account_id,public_user_id);
   CREATE TABLE identity_link_blocks(account_id TEXT NOT NULL,private_user_id TEXT NOT NULL,public_user_id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(account_id,private_user_id,public_user_id));
  `);
 }
 private validate(account:string,privateId?:string,publicId?:string){
  if(typeof account!=='string'||!account.trim()||account.length>200)throw new IdentityLinkError('工作账号无效');
  if(privateId!==undefined&&(typeof privateId!=='string'||!/^(dm|conversation):[^\s]{1,280}$/.test(privateId)))throw new IdentityLinkError('私信会话标识无效');
  if(publicId!==undefined&&(typeof publicId!=='string'||!/^x:[a-z0-9_]{1,15}$/.test(publicId)))throw new IdentityLinkError('公开 handle 无效');
 }
 private view(row:any):IdentityLink{return {accountId:row.account_id,privateUserId:row.private_user_id,publicUserId:row.public_user_id,source:row.source,createdAt:row.created_at,updatedAt:row.updated_at};}
 publicOf(account:string,privateId:string){const row=this.store.db.prepare('SELECT * FROM identity_links WHERE account_id=? AND private_user_id=?').get(account,privateId);return row?this.view(row):undefined;}
 privatesOf(account:string,publicId:string){return this.store.db.prepare('SELECT * FROM identity_links WHERE account_id=? AND public_user_id=? ORDER BY private_user_id').all(account,publicId).map(row=>this.view(row));}
 detail(account:string,userId:string){
  const links=/^(dm|conversation):/.test(userId)?[this.publicOf(account,userId)].filter((r):r is IdentityLink=>!!r):this.privatesOf(account,userId);
  const blocks=this.store.db.prepare('SELECT private_user_id,public_user_id,at FROM identity_link_blocks WHERE account_id=? AND (private_user_id=? OR public_user_id=?) ORDER BY at DESC').all(account,userId,userId).map((r:any)=>({privateUserId:r.private_user_id,publicUserId:r.public_user_id,at:r.at}));
  return {links,blocks};
 }
 link(account:string,privateId:string,publicId:string,source:LinkSource){
  if(typeof privateId!=='string'||typeof publicId!=='string')throw new IdentityLinkError('身份标识无效');
  this.validate(account,privateId,publicId);
  if(!['platform','admin','chat-test'].includes(source)||source==='chat-test'&&(!this.chatTest||account!=='chat_test'))throw new IdentityLinkError('身份关联来源无效');
  const old=this.publicOf(account,privateId);
  if(source!=='admin'){
   if(this.store.db.prepare('SELECT 1 FROM identity_link_blocks WHERE account_id=? AND private_user_id=? AND public_user_id=?').get(account,privateId,publicId))return {linked:false,reason:'admin-blocked'};
   if(old&&old.publicUserId!==publicId){this.store.log('identity-link-conflict',JSON.stringify({accountId:account,privateUserId:privateId,publicUserId:publicId}),'warn');return {linked:false,reason:'conflict'};}
   if(old)return {linked:true,link:old};
  }
  this.store.db.exec('BEGIN IMMEDIATE');try{
   // 改写前作废旧关联两端，写入后再作废新关联两端。
   invalidateReplayMemory(this.store,account,privateId);invalidateReplayMemory(this.store,account,publicId);
   const at=this.now();this.store.db.prepare('INSERT INTO identity_links VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,private_user_id) DO UPDATE SET public_user_id=excluded.public_user_id,source=excluded.source,updated_at=excluded.updated_at').run(account,privateId,publicId,source,old?.createdAt??at,at);
   if(source==='admin')this.store.db.prepare('DELETE FROM identity_link_blocks WHERE account_id=? AND private_user_id=? AND public_user_id=?').run(account,privateId,publicId);
   invalidateReplayMemory(this.store,account,privateId);invalidateReplayMemory(this.store,account,publicId);
   this.store.db.exec('COMMIT');return {linked:true,link:this.publicOf(account,privateId)!};
  }catch(error){this.store.db.exec('ROLLBACK');throw error;}
 }
 unlink(account:string,privateId:string){
  if(typeof privateId!=='string')throw new IdentityLinkError('私信会话标识无效');
  this.validate(account,privateId);const old=this.publicOf(account,privateId);if(!old)return {ok:true,...this.detail(account,privateId)};
  this.store.db.exec('BEGIN IMMEDIATE');try{
   invalidateReplayMemory(this.store,account,privateId);
   this.store.db.prepare('INSERT INTO identity_link_blocks VALUES(?,?,?,?) ON CONFLICT(account_id,private_user_id,public_user_id) DO UPDATE SET at=excluded.at').run(account,privateId,old.publicUserId,this.now());
   this.store.db.prepare('DELETE FROM identity_links WHERE account_id=? AND private_user_id=?').run(account,privateId);
   this.store.db.exec('COMMIT');return {ok:true,...this.detail(account,privateId)};
  }catch(error){this.store.db.exec('ROLLBACK');throw error;}
 }
}
