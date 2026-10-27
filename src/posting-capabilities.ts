import { randomUUID } from 'node:crypto';
import type { Identity } from './types.js';
import type { Store } from './store.js';
import { CAPABILITY_TTL_MS,effectivePostingLimit,type PostingCapability,type PostingOperation } from './posting-policy.js';
export type PostingCapabilities={accountId:string;sessionId:string;post:PostingCapability;reply:PostingCapability};
export class BrowserPostingCapabilities {
 readonly sessionId=randomUUID();private account='';private revision=0;private snapshot?:PostingCapabilities;
 invalidate(reason='浏览器会话或人工接管状态已变化'){this.revision++;if(this.snapshot)for(const op of ['post','reply'] as const){this.snapshot[op]={...this.snapshot[op],status:'stale',expiresAt:0,reason,revision:this.sessionId+':'+this.revision+':'+op};}}
 observe(identity:Identity,now=Date.now()):PostingCapabilities{
  const handle=String(identity.handle??'').trim().replace(/^@/,'').toLowerCase(),account=identity.loggedIn&&!identity.needsHuman&&!identity.restricted&&/^[a-z0-9_]{1,15}$/.test(handle)?handle:'';
  if(account!==this.account){this.invalidate('登录账号已变化，旧权限不再适用');this.account=account;this.snapshot=undefined;}
  // 过期、人工释放或身份元数据变化后重新读取当前身份，生成新的unknown证据；不复用旧checkedAt。
  if(this.snapshot&&(['post','reply'] as const).some(op=>this.snapshot![op].status==='stale'||this.snapshot![op].expiresAt<=now||this.snapshot![op].userId!==identity.userId))this.snapshot=undefined;
  if(!this.snapshot){
   const item=(operation:PostingOperation):PostingCapability=>({accountId:account,userId:identity.userId,operation,sessionId:this.sessionId,status:'unknown',limit:280,countingMode:'weighted-characters',source:'当前页面身份；未取得已验收的原生长帖能力字段',checkedAt:now,expiresAt:now+CAPABILITY_TTL_MS,revision:this.sessionId+':'+(++this.revision)+':'+operation,reason:account?'当前页面没有可确认并已验收的长帖权限与计数证据':'当前登录账号尚未可靠确认'});
   this.snapshot={accountId:account,sessionId:this.sessionId,post:item('post'),reply:item('reply')};
  }
  return structuredClone(this.snapshot);
 }
}
/** GET 只读本地缓存；启动后旧浏览器会话的记录只用于解释，不能放开权限。 */
export class PostingCapabilitiesService {
 private readonly bootId=randomUUID();private knownSession='';
 constructor(private store:Store,private account:()=>string,private now:()=>number=Date.now){}
 get(accountId=this.account()){
  const account=accountId.toLowerCase();let cached:any;try{cached=JSON.parse(this.store.get('posting-capabilities:'+account,'null'));}catch{}
  const now=this.now();const item=(op:PostingOperation):PostingCapability=>{
   const raw=cached?.snapshot?.[op];
   if(raw&&raw.accountId===account){const fresh=cached.bootId===this.bootId&&raw.sessionId===this.knownSession&&raw.expiresAt>now;return {...raw,status:fresh?raw.status:'stale',reason:fresh?raw.reason:cached.invalidatedReason??'能力缓存已过期或进程／浏览器会话已变化'};}
   return {accountId:account,operation:op,sessionId:'',status:'unknown',limit:280,countingMode:'weighted-characters',source:'短帖默认规则',checkedAt:0,expiresAt:0,revision:'unknown:'+op,reason:account?'尚未显式读取当前账号能力':'当前账号未确认，使用普通账号模拟限制'};
  };
  const post=item('post'),reply=item('reply');return {accountId:account,simulation:!account,sessionId:this.knownSession,post,reply,effective:{post:effectivePostingLimit('post',post,account,now,this.knownSession),reply:effectivePostingLimit('reply',reply,account,now,this.knownSession)}};
 }
 accept(snapshot:PostingCapabilities){
  const account=this.account().toLowerCase(),now=this.now();
  const conflict=(message:string):never=>{this.invalidate(message);throw new Error(message);};
  if(!account||snapshot?.accountId!==account||typeof snapshot.sessionId!=='string'||!snapshot.sessionId||snapshot.sessionId.length>250)conflict('能力响应与当前工作账号不符');
  let previous:any;try{previous=JSON.parse(this.store.get('posting-capabilities:'+account,'null'))?.snapshot;}catch{}
  const evidence=(x:PostingCapability)=>JSON.stringify([x.accountId,x.userId??'',x.operation,x.sessionId,x.status,x.limit,x.countingMode,x.adapterRevision??'',x.source,x.checkedAt,x.expiresAt,x.reason??'']);
  for(const op of ['post','reply'] as const){
   const x=snapshot[op];
   if(!x||x.accountId!==account||x.operation!==op||x.sessionId!==snapshot.sessionId||!['unknown','stale','confirmed'].includes(x.status)||!['weighted-characters','unicode-codepoints'].includes(x.countingMode)||!Number.isSafeInteger(x.limit)||x.limit<1||x.limit>25000||typeof x.source!=='string'||x.source.length>500||typeof x.revision!=='string'||!x.revision||x.revision.length>250||!Number.isSafeInteger(x.checkedAt)||x.checkedAt<0||x.checkedAt>now+60000||!Number.isSafeInteger(x.expiresAt)||x.expiresAt<x.checkedAt||x.expiresAt-x.checkedAt>CAPABILITY_TTL_MS)conflict('浏览器能力响应无效或证据冲突');
   if(previous?.[op]?.revision===x.revision&&evidence(previous[op])!==evidence(x))conflict('能力修订与已保存证据冲突，旧能力已失效');
  }
  this.knownSession=snapshot.sessionId;this.store.set('posting-capabilities:'+account,JSON.stringify({bootId:this.bootId,snapshot}));return this.get(account);
 }

 invalidate(reason:string){
  this.knownSession='';const account=this.account().toLowerCase();let snapshot:any;try{snapshot=JSON.parse(this.store.get('posting-capabilities:'+account,'null'))?.snapshot;}catch{}
  if(snapshot)this.store.set('posting-capabilities:'+account,JSON.stringify({bootId:'',invalidatedReason:reason,snapshot}));
 }
}
