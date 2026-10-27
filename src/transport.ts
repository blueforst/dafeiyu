import type { Event, Identity, Receipt } from './types.js';
import type { PostingCapabilities } from './posting-capabilities.js';
import {healthSettings,type HealthSettings,type BrowserResourceHealth,type ComplianceObservation} from './unattended-health.js';
import { rpcResourceOK } from './posting-policy.js';
export type TransportRequestOptions={signal?:AbortSignal;deadline?:number;timeoutMs?:number};
export interface Transport {
 identity(options?:TransportRequestOptions):Promise<Identity>;
 capabilities?():Promise<PostingCapabilities>;
 health?():Promise<BrowserResourceHealth&{ready?:boolean;mode?:string}>;
 compliance?(handle:string,options?:TransportRequestOptions):Promise<ComplianceObservation>;
 collect(handle:string,options?:TransportRequestOptions):Promise<{events:Event[];warnings:string[]}>;
 collectPublic?(handle:string,options?:TransportRequestOptions):Promise<{events:Event[];warnings:string[]}>;
 collectPrivate?(handle:string,options?:TransportRequestOptions):Promise<{events:Event[];warnings:string[]}>;
 context(event:Event,handle:string,options?:TransportRequestOptions):Promise<string>;
 send(event:Event,text:string,handle:string,options?:TransportRequestOptions):Promise<Receipt>;
 lookup(event:Event,text:string,handle:string,options?:TransportRequestOptions):Promise<Receipt>;
 post?(text:string,handle:string,requestId:string,options?:TransportRequestOptions):Promise<Receipt>;
 lookupPost?(text:string,handle:string,requestId:string,options?:TransportRequestOptions):Promise<Receipt>;
 control(mode:'paused'|'auto'|'manual'):Promise<void>;
}
export class BrowserTransport implements Transport {
 constructor(private endpoint:string,private key:string,private runtimeSettings:()=>Partial<HealthSettings>=()=>({})){}
 async rpc(path:string,data?:unknown,options:TransportRequestOptions={}):Promise<any>{
  let settings:HealthSettings;try{settings=healthSettings(this.runtimeSettings());}catch{settings=healthSettings();}
  const payload=data===undefined?undefined:{...(data as Record<string,unknown>),runtimeHealth:settings};
  if(payload!==undefined&&!rpcResourceOK(payload))throw new Error('浏览器请求体超过资源保护边界');
  const timeout=Math.max(1,Math.min(300000,options.timeoutMs??settings.rpcTimeoutSeconds*1000)),timeoutSignal=AbortSignal.timeout(timeout),signal=options.signal?AbortSignal.any([options.signal,timeoutSignal]):timeoutSignal;
  const r=await fetch(this.endpoint+path,{method:data===undefined?'GET':'POST',headers:{'x-browser-key':this.key,'content-type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload),signal});
  const x:any=await r.json();if(!r.ok)throw Object.assign(new Error(x.error||'浏览器请求失败'),{restricted:x.restricted,browserPaused:x.browserPaused,browserMode:x.browserMode});return x;
 }
 identity(options?:TransportRequestOptions){return this.rpc('/identity',undefined,options);}
 capabilities(){return this.rpc('/capabilities',{});}
 health(){return this.rpc('/health');}
 compliance(handle:string,options?:TransportRequestOptions){return this.rpc('/compliance',{handle},options);}
 collect(handle:string,options?:TransportRequestOptions){return this.rpc('/collect',{handle,...(options?.deadline!==undefined?{deadline:options.deadline}:{})},options);}
 collectPublic(handle:string,options?:TransportRequestOptions){return this.rpc('/collect/public',{handle,...(options?.deadline!==undefined?{deadline:options.deadline}:{})},options);}
 collectPrivate(handle:string,options?:TransportRequestOptions){return this.rpc('/collect/private',{handle,...(options?.deadline!==undefined?{deadline:options.deadline}:{})},options);}
 context(event:Event,handle:string,options?:TransportRequestOptions){return this.rpc('/context',{event,handle},options).then(x=>x.text);}
 send(event:Event,text:string,handle:string,options?:TransportRequestOptions){return this.rpc('/send',{event,text,handle,requestId:event.outboxId||event.id},options);}
 lookup(event:Event,text:string,handle:string,options?:TransportRequestOptions){return this.rpc('/lookup',{event,text,handle,requestId:event.outboxId||event.id},options);}
 post(text:string,handle:string,requestId:string,options?:TransportRequestOptions){return this.rpc('/post',{text,handle,requestId},options);}
 lookupPost(text:string,handle:string,requestId:string,options?:TransportRequestOptions){return this.rpc('/lookup-post',{text,handle,requestId},options);}
 async control(mode:'paused'|'auto'|'manual'){await this.rpc('/control',{mode});}
}
