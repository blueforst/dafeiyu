import type {Page} from 'playwright-core';
import {waitForPrivateUI,discoverPrivateInboxes,inspectPrivateConversation,type PrivateCollectionInput,type PrivateCollectionResult,type PrivateInboxKind,type ChatDiagnostic} from './chat-dom.js';
import type {PrivateRequestCandidate} from './private-requests.js';
import type {Event} from './types.js';
import {readNativeComposer} from './xchat-composer.js';

export type NativeInboxSnapshot={state:'ready'|'empty'|'loading'|'unknown'|'blocked';kind:PrivateInboxKind;path:string;links:Array<{conversationId:string;url:string}>;invalid:number;canOpenOther:boolean};
export type XChatCollectionResult=PrivateCollectionResult&{requests:PrivateRequestCandidate[];privateAcceptances:Array<{conversationId:string;status:'accepted'}>};
const paths={inbox:'/i/chat',requests:'/i/chat/requests',other:'/i/chat/requests/other'};
const source=(kind:PrivateInboxKind)=>kind==='other'?'other' as const:kind;
const report=(kind:PrivateInboxKind,status:ChatDiagnostic['status'],code:string,eventCount=0):ChatDiagnostic=>({channel:'private',source:source(kind),status,code,eventCount});

/** 请求来源使用独立的原生 panel／scroller／option 契约，不套用 All 空态。 */
export async function readNativeRequestInbox(page:Page,kind:'requests'|'other'):Promise<NativeInboxSnapshot>{
 return page.evaluate(({kind,expectedPath})=>{
  const path=location.pathname,base:NativeInboxSnapshot={state:'unknown',kind,path,links:[],invalid:0,canOpenOther:false};
  if(location.origin!=='https://x.com'||path!==expectedPath||location.search||location.hash)return base;
  const hosts=document.querySelectorAll('[data-testid="xchatEmbedRoute"]');if(hosts.length!==1||!hosts[0].shadowRoot)return base;
  const root=hosts[0].shadowRoot;
  const panels=root.querySelectorAll('[data-testid="dm-inbox-panel"]'),requests=root.querySelectorAll('[data-testid="dm-message-requests"]');
  if(panels.length!==1||requests.length!==1||!panels[0].contains(requests[0])||!requests[0].getClientRects().length)return base;
  const panel=requests[0],outside=(node:Element)=>!node.closest('[data-dm-message-row],article,[role="article"],[data-testid="messageEntry"]'),ownedUI=(node:Element)=>outside(node)&&!node.closest('[role="option"]');
  if(Array.from(panel.querySelectorAll('input[type="password"]')).some(ownedUI))return {...base,state:'blocked'};
  if(Array.from(panel.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-testid="spinner"]')).some(ownedUI))return {...base,state:'loading'};
  const other=panel.querySelectorAll('[data-testid="dm-message-requests-other-button"]');
  base.canOpenOther=kind==='requests'&&other.length===1&&outside(other[0])&&other[0].getClientRects().length>0&&!other[0].closest('[role="listbox"]');
  const listboxes=Array.from(panel.querySelectorAll('[role="listbox"]')).filter(outside),scrollers=panel.querySelectorAll('[data-testid="dm-message-requests-scroller"]');
  let invalid=0;const links:NativeInboxSnapshot['links']=[];
  if(listboxes.length===1&&scrollers.length===1&&listboxes[0].contains(scrollers[0])&&(kind==='other'?listboxes[0].getAttribute('aria-label')==='Other':['Message Requests','Requests'].includes(listboxes[0].getAttribute('aria-label')??''))){
   for(const anchor of Array.from(scrollers[0].querySelectorAll('a[href]')).slice(0,200)){
    if(!outside(anchor)||!anchor.getClientRects().length)continue;
    const option=anchor.id.match(/^dm-conversation-option-(\d+):(\d+)$/),test=anchor.getAttribute('data-testid')?.match(/^dm-message-request-item-(\d+):(\d+)$/);
    let url:URL;try{url=new URL(anchor.getAttribute('href')??'',location.origin);}catch{invalid++;continue;}
    const prefix=kind==='other'?'/i/chat/requests/other/':'/i/chat/requests/',ids=url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length).match(/^(\d+)-(\d+)$/):null;
    if(!option||!test||!ids||anchor.getAttribute('role')!=='option'||url.origin!=='https://x.com'||url.search||url.hash||url.username||url.password||option[1]!==ids[1]||option[2]!==ids[2]||test[1]!==ids[1]||test[2]!==ids[2]){invalid++;continue;}
    links.push({conversationId:ids[1]+'-'+ids[2],url:url.href});
   }
  }
  if(links.length)return {...base,state:'ready',links:[...new Map(links.map(row=>[row.url,row])).values()],invalid};
  // 实际平台的请求专用空态；必须同时排除列表内容、加载和隐藏空态。
  const empties=Array.from(panel.querySelectorAll('[data-testid="dm-message-requests-empty"]')).filter(ownedUI),back=panel.querySelectorAll('[data-testid="dm-message-requests-back"]');
  const otherHeader=kind==='other'&&back.length===1&&back[0].parentElement?.textContent?.trim()==='Other';
  const emptyText=empties.length===1?(empties[0].textContent??'').trim().replace(/\s+/g,' '):'';
  if(empties.length===1&&empties[0].getClientRects().length>0&&!empties[0].querySelector('a,button,input')&&!listboxes.some(node=>node.querySelector('a[href]'))&&!invalid&&(kind==='requests'?/^No message requests\s*You don.t have any message requests from accounts in your network$/.test(emptyText):otherHeader&&/^No message requests(?:\s+.{1,600})?$/.test(emptyText)))return {...base,state:'empty'};
  return {...base,invalid};
 },{kind,expectedPath:paths[kind]});
}
export async function waitNativeRequestInbox(page:Page,kind:'requests'|'other',deadline:number):Promise<NativeInboxSnapshot>{
 let last:NativeInboxSnapshot={kind,path:'',state:'unknown',links:[],invalid:0,canOpenOther:false},previous='',stable=Date.now();
 const until=Math.min(deadline,Date.now()+16000);
 for(let reads=0;reads<160&&Date.now()<until;reads++){
  last=await readNativeRequestInbox(page,kind);const signature=JSON.stringify(last);if(signature!==previous){previous=signature;stable=Date.now();}
  if(['ready','empty','blocked'].includes(last.state)&&Date.now()-stable>=300)return last;
  await page.waitForTimeout(Math.min(100,Math.max(1,until-Date.now())));
 }
 return {...last,...(['ready','empty'].includes(last.state)?{state:'unknown' as const}:{})};
}

/** 仅点取证过的导航控件；不拼接请求入口 URL，不点击消息内容中的控件。 */
export async function openNativeRequestSource(page:Page,kind:'requests'|'other',deadline:number,canContinue:()=>boolean=()=>true):Promise<boolean>{
 const guard=()=>{if(!canContinue()||Date.now()>=deadline)throw Error('私信来源检查已停止');};guard();
 const root=page.locator('[data-testid="xchatEmbedRoute"]');if(await root.count()!==1)return false;
 if(kind==='requests'){
  if(new URL(page.url()).pathname!=='/i/chat')return false;
  const trigger=root.locator('[data-testid="dm-inbox-header"] [data-testid="dm-inbox-dropdown-trigger"]');
  if(await trigger.count()!==1||!await trigger.isVisible()||!await trigger.isEnabled())return false;
  const id=await trigger.getAttribute('id');if(!id||await trigger.getAttribute('aria-haspopup')!=='menu')return false;
  guard();if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click({timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
  const menu=root.locator('[data-testid="dm-inbox-dropdown-content"][role="menu"]');
  await menu.waitFor({state:'visible',timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
  if(await menu.count()!==1||await menu.getAttribute('aria-labelledby')!==id)return false;
  const item=menu.locator('[data-testid="dm-inbox-dropdown-requests"][role="menuitemradio"]');
  if(await item.count()!==1||!await item.isVisible()||await item.getAttribute('aria-disabled')==='true'||await item.getAttribute('data-disabled')!==null)return false;
  guard();await item.click({timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
 }else{
  if(new URL(page.url()).pathname!==paths.requests)return false;
  const button=root.locator('[data-testid="dm-inbox-panel"] [data-testid="dm-message-requests"] [data-testid="dm-message-requests-other-button"]');
  if(await button.count()!==1||!await button.isVisible()||!await button.isEnabled()||!await button.evaluate(node=>!node.closest('[role="listbox"],[data-dm-message-row],[role="article"],article')))return false;
  guard();await button.click({timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
 }
 await page.waitForURL(url=>url.origin==='https://x.com'&&url.pathname===paths[kind],{timeout:Math.max(1,Math.min(10000,deadline-Date.now()))});guard();return true;
}

export async function readNativeRequestPrompt(page:Page,conversationId:string){
 return page.locator('[data-testid="xchatEmbedRoute"]').evaluate((host,conversationId)=>{
  const path=location.pathname,validLocation=location.origin==='https://x.com'&&['/i/chat/'+conversationId,'/i/chat/requests/'+conversationId,'/i/chat/requests/other/'+conversationId].includes(path);
  const root=host.shadowRoot,unknown={state:'unknown' as const,peerHandle:''};if(!root||!validLocation)return unknown;
  const outside=(node:Element)=>!node.closest('[data-dm-message-row],[role="log"],[role="article"],article');
  const panels=root.querySelectorAll('[data-testid="dm-conversation-panel"]');if(panels.length!==1)return unknown;const panel=panels[0];if(Array.from(panel.querySelectorAll('[aria-busy="true"]')).some(outside))return unknown;
  const prompts=Array.from(panel.querySelectorAll('[data-testid="dm-message-request-prompt"]')).filter(outside),accept=Array.from(panel.querySelectorAll('[data-testid="dm-message-request-accept-button"]')).filter(outside),remove=Array.from(panel.querySelectorAll('[data-testid="dm-message-request-delete-button"]')).filter(outside);
  if(prompts.length===1&&accept.length===1&&remove.length===1&&prompts[0].contains(accept[0])&&prompts[0].contains(remove[0])&&!prompts[0].closest('[data-dm-message-row],[role="article"],article')&&prompts[0].getClientRects().length>0){
   const profiles=prompts[0].querySelectorAll('a[data-testid="dm-message-request-profile-link"]');let peerHandle='';
   if(profiles.length===1){try{const url=new URL(profiles[0].getAttribute('href')??'');if(url.origin==='https://x.com'&&/^\/[A-Za-z0-9_]{1,15}$/.test(url.pathname)&&profiles[0].textContent==='@'+url.pathname.slice(1))peerHandle=url.pathname.slice(1);}catch{}}
   return {state:'pending' as const,peerHandle};
  }
  return unknown;
 },conversationId);
}

export async function collectNativePrivate(input:PrivateCollectionInput&{selfUserId:string;canContinue?:()=>boolean;offsets?:Map<string,number>;unsettled?:Array<{conversationId:string;url:string;source:'requests'|'other'}>;confirmAccepted?:(conversationId:string)=>void}):Promise<XChatCollectionResult|null>{
 const {page,handle,deadline,navigate,selfUserId}=input,diagnostics:ChatDiagnostic[]=[],events:Event[]=[],requests:PrivateRequestCandidate[]=[],observations:PrivateCollectionResult['observations']=[],pageStates:PrivateCollectionResult['pageStates']=[];
 const protection={hasUnlockedSession:false,unlockPending:false,needsHuman:false},links:Array<{conversationId:string;url:string;kind:PrivateInboxKind}>=[],privateAcceptances:XChatCollectionResult['privateAcceptances']=[];
 const active=()=>Date.now()<deadline&&(input.canContinue?.()??true);
 const own=(id:string)=>/^\d{1,25}-\d{1,25}$/.test(id)&&id.split('-').includes(selfUserId)&&new Set(id.split('-')).size===2;
 const take=(found:Array<{conversationId:string;url:string}>,kind:PrivateInboxKind)=>{const rows=found.filter(row=>own(row.conversationId)),key=handle+':'+kind,offset=(input.offsets?.get(key)??0)%Math.max(1,rows.length);for(let i=0;i<Math.min(2,rows.length);i++)links.push({...rows[(offset+i)%rows.length],kind});input.offsets?.set(key,offset+Math.min(2,rows.length));};
 if(!active())return {events,requests,privateAcceptances,diagnostics:[report('inbox','partial','private-collection-deadline')],observations,pageStates,chatProtection:protection,warnings:['私信采集预算已结束。']};
 await navigate(page,'https://x.com/messages',deadline);const ui=await waitForPrivateUI({...input.readiness,page,kind:'inbox',deadline});
 if(ui.contract!=='xchat-observation-v1')return null;
 pageStates.push({...ui,source:'inbox'});protection.hasUnlockedSession=['ready','empty'].includes(ui.state);protection.unlockPending=ui.state==='locked';protection.needsHuman=ui.state==='locked';
 if(ui.state==='locked')diagnostics.push(report('inbox','blocked','chat-native-locked'));
 else{
  const found=await discoverPrivateInboxes(page,{...input.readiness,deadline});take(found.conversations,'inbox');
  diagnostics.push(report('inbox',ui.state==='empty'?'empty':ui.state==='ready'?'ok':'unknown',ui.code));
  for(const kind of ['requests','other'] as const){
   if(!active()){diagnostics.push(report(kind,'partial','private-collection-deadline'));break;}
   try{
    if(!await openNativeRequestSource(page,kind,deadline,active)){diagnostics.push(report(kind,'partial',kind==='requests'?'chat-request-entry-missing':'chat-other-entry-missing'));break;}
    const snapshot=await waitNativeRequestInbox(page,kind,deadline);take(snapshot.links,kind);
    diagnostics.push(report(kind,snapshot.state==='empty'?'empty':snapshot.state==='ready'?(snapshot.invalid?'partial':'ok'):snapshot.state==='blocked'?'blocked':'unknown',snapshot.state==='empty'?'private-requests-empty':snapshot.state==='ready'?'private-requests-ready':snapshot.state==='blocked'?'chat-native-locked':'private-inbox-unverified'));
    if(snapshot.state==='blocked'){protection.needsHuman=true;protection.unlockPending=true;break;}
    if(kind==='requests'&&!snapshot.canOpenOther){diagnostics.push(report('other','partial','chat-other-entry-missing'));break;}
   }catch(error){if((error as any)?.restricted)throw error;diagnostics.push(report(kind,'failed','private-navigation-failed'));break;}
  }
 }
 const unique=[...new Map(links.map(row=>[row.conversationId,row])).values()].slice(0,6),unsettled=(input.unsettled??[]).filter(row=>own(row.conversationId));
 if(unsettled.length){
  const key=handle+':acceptance-lookup',offset=input.offsets?.get(key)??0,pending=unsettled[offset%unsettled.length];input.offsets?.set(key,offset+1);
  if(!unique.some(row=>row.conversationId===pending.conversationId)){
   if(unique.length>=6){const duplicate=unique.findIndex(row=>unique.filter(other=>other.kind===row.kind).length>1);unique.splice(duplicate<0?unique.length-1:duplicate,1);}
   unique.unshift({conversationId:pending.conversationId,url:pending.url,kind:pending.source});
  }
 }
 for(const link of unique){
  if(!active()){diagnostics.push(report(link.kind,'partial','private-collection-deadline'));break;}
  try{
   await navigate(page,link.url,deadline);const read=await inspectPrivateConversation(page,link.conversationId,{...input.readiness,deadline,selfUserId});
   const prompt=await readNativeRequestPrompt(page,link.conversationId);diagnostics.push(...read.diagnostics.map(row=>prompt.state==='pending'?{...row,eventCount:0}:row));
   const reliable=active()?read.events.map(event=>({...event,accountId:handle.toLowerCase(),...(prompt.peerHandle?{peerHandle:prompt.peerHandle}:{})})):[];
   let queueable=0;const composer=await readNativeComposer(page,link.conversationId);
   if(prompt.state==='pending')for(const event of reliable)requests.push({event,source:link.kind==='other'?'other':'requests',url:link.url});
   else if(read.contract==='xchat-native-v2'&&composer.state==='ready'&&read.all.some(row=>row.timestampReliable&&row.direction!=='unknown')){
    input.confirmAccepted?.(link.conversationId);privateAcceptances.push({conversationId:link.conversationId,status:'accepted'});events.push(...reliable);queueable=reliable.length;
   }
   else if(reliable.length)diagnostics.push(report(link.kind,'unsupported','private-native-composer-unverified'));
   observations.push({conversationId:link.conversationId,source:link.kind,contract:read.contract,messageCount:read.all.length,outgoing:read.all.filter(row=>row.direction==='out').length,unknownDirection:read.all.filter(row=>row.direction==='unknown').length,queueable,blockedCodes:[...new Set(read.all.flatMap(row=>row.blockedCodes))],composer});
   if(prompt.state==='pending')diagnostics.push(report(link.kind,'partial','private-request-observed'));
  }catch(error){if((error as any)?.restricted)throw error;diagnostics.push(report(link.kind,'failed','private-navigation-failed'));}
 }
 return {events,requests,privateAcceptances,diagnostics,observations,pageStates,chatProtection:protection,warnings:[...new Set(diagnostics.filter(row=>!['ok','empty'].includes(row.status)).map(row=>row.code==='private-request-observed'?'有私信请求等待规则核对与接受。':'私信来源或消息证据尚未完整，请查看分项诊断。'))]};
}
