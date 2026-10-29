import {BlockList,isIP} from 'node:net';
import {lookup as dnsLookup} from 'node:dns';
import {Agent,fetch as undiciFetch} from 'undici';
import {AsyncLocalStorage} from 'node:async_hooks';

const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(address,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix] of [['2001::',32],['2001:2::',48],['2001:10::',28],['2001:20::',28],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)blocked.addSubnet(address,prefix,'ipv6');
export function publicModelAddress(address:string):boolean {
 const family=isIP(address);return family===4?!blocked.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
const failure=()=>new Error('模型地址无效：目标、解析地址或重定向受限');
function origins(raw:string):Set<string>{
 const result=new Set<string>();for(const value of raw.split(',').map(s=>s.trim()).filter(Boolean)){
  let url:URL;try{url=new URL(value);}catch{throw failure();}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!/^https?:\/\/(?:\[[^\]]+\]|[^/:]+):\d+\/?$/.test(value))throw new Error('内部模型允许项必须为含明确端口的 http(s) origin');
  result.add(url.origin);
 }return result;
}
export function modelTarget(raw:string,options:{base?:boolean;allowedOrigins?:Set<string>}={}):URL {
 let url:URL;try{url=new URL(raw.trim());}catch{throw new Error('模型地址无效：无法解析');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||options.base&&url.search)throw new Error('模型地址无效：协议、账号密码或 query/hash 不允许');
 const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
 const allowed=options.allowedOrigins??origins(process.env.MODEL_INTERNAL_TARGETS??'');
 if(!allowed.has(url.origin)&&(isIP(host)?!publicModelAddress(host):!host.includes('.')||['localhost.localdomain','localhost'].includes(host)||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')))throw failure();
 return url;
}
type Resolver=(host:string)=>Promise<Array<{address:string;family:number}>>;
const resolveAll:Resolver=host=>new Promise((resolve,reject)=>dnsLookup(host,{all:true,verbatim:true},(error,addresses)=>error?reject(error):resolve(addresses)));
/** 在实际建连的 lookup 校验全部地址，不允许校验后重新解析。 */
export function createModelFetch(options:{allowedTargets?:string;resolve?:Resolver}={}){
 const allowed=origins(options.allowedTargets??process.env.MODEL_INTERNAL_TARGETS??''),resolve=options.resolve??resolveAll,pools=new Map<string,Agent>();
 const guarded:typeof fetch=async(input,init)=>{
  const url=modelTarget(typeof input==='string'?input:input instanceof URL?input.href:input.url,{allowedOrigins:allowed});
  let dispatcher=pools.get(url.origin);
  if(!dispatcher){
   if(pools.size>=64)throw new Error('模型连接目标过多');
   const internal=allowed.has(url.origin);
   dispatcher=new Agent({connect:{lookup:(hostname,lookupOptions,callback)=>{
    void resolve(hostname).then(addresses=>{
     if(!addresses.length||addresses.some(item=>!isIP(item.address)||!internal&&!publicModelAddress(item.address)))throw failure();
     const requested=typeof lookupOptions==='number'?lookupOptions:lookupOptions.family,candidates=requested?addresses.filter(item=>item.family===requested):addresses;
     if(!candidates.length)throw failure();
     if(typeof lookupOptions==='object'&&lookupOptions.all)(callback as any)(null,candidates);
     else callback(null,candidates[0].address,candidates[0].family);
    }).catch(error=>callback(error as Error,'',0));
   }},keepAliveTimeout:1000,keepAliveMaxTimeout:1000});pools.set(url.origin,dispatcher);
  }
  // Node内置与npm Undici的Request不是同一构造器，显式转换以保留SDK流和中止信号。
  const request=typeof input==='object'&&!(input instanceof URL)?input:undefined;
  const inherited=request?{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,signal:request.signal}:{};
  return await undiciFetch(url.href,{...inherited,...init,duplex:'half',redirect:'error',dispatcher} as any) as unknown as Response;
 };
 return {fetch:guarded,close:async()=>{await Promise.all([...pools.values()].map(pool=>pool.close()));pools.clear();}};
}
let shared:ReturnType<typeof createModelFetch>|undefined,sharedPolicy:string|undefined;
export const modelFetch:typeof fetch=(input,init)=>{const policy=process.env.MODEL_INTERNAL_TARGETS??'';if(!shared||policy!==sharedPolicy){if(shared)void shared.close().catch(()=>{});shared=createModelFetch({allowedTargets:policy});sharedPolicy=policy;}return shared.fetch(input,init);};

// Pi的Google适配器明确不支持自定义fetch；按异步调用范围统一保护SDK的全局fetch。
// 普通应用RPC及宿主桥接不在该范围，继续使用原传输。
const modelScope=new AsyncLocalStorage<boolean>(),ordinaryFetch=globalThis.fetch;
globalThis.fetch=((input,init)=>modelScope.getStore()?modelFetch(input,init):ordinaryFetch(input,init)) as typeof fetch;
export function withModelEgress<T>(fn:()=>Promise<T>):Promise<T>{return modelScope.run(true,fn);}
