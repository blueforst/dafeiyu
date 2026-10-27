import type { Event, Identity, Receipt } from './types.js';
export interface Transport {
 identity():Promise<Identity>;
 collect(handle:string):Promise<{events:Event[];warnings:string[]}>;
 context(event:Event,handle:string):Promise<string>;
 send(event:Event,text:string,handle:string):Promise<Receipt>;
 lookup(event:Event,text:string,handle:string):Promise<Receipt>;
 control(mode:'paused'|'auto'|'manual'):Promise<void>;
}
export class BrowserTransport implements Transport {
 constructor(private endpoint:string,private key:string){}
 async rpc(path:string,data?:unknown):Promise<any>{const r=await fetch(this.endpoint+path,{method:data===undefined?'GET':'POST',headers:{'x-browser-key':this.key,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(90000)});const x:any=await r.json();if(!r.ok)throw new Error(x.error||'浏览器请求失败');return x;}
 identity(){return this.rpc('/identity');}
 collect(handle:string){return this.rpc('/collect',{handle});}
 context(event:Event,handle:string){return this.rpc('/context',{event,handle}).then(x=>x.text);}
 send(event:Event,text:string,handle:string){return this.rpc('/send',{event,text,handle,requestId:event.id});}
 lookup(event:Event,text:string,handle:string){return this.rpc('/lookup',{event,text,handle});}
 async control(mode:'paused'|'auto'|'manual'){await this.rpc('/control',{mode});}
}
