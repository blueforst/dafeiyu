import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Persona,PersonaTrigger} from './persona.js';
import {validatePersona} from './persona.js';
import {PERSONA_PRESETS,PERSONA_PRESETS_V2} from './persona-presets.js';
import {panelDir,commitPersonaUpgrade,type PanelSettings} from './settings.js';
import type {PersonaOrigin} from './persona-library.js';
import type {Store} from './store.js';

/** 保留管理员改写；对比使用冻结的 v2 文本，不靠名称猜测来源。 */
export function upgradePersona(raw:any,origin?:PersonaOrigin):{persona:Persona;changed:boolean}{
 if(!raw||!Array.isArray(raw.sections)||!Array.isArray(raw.triggers))throw new Error('待升级人设结构无效');
 const old=origin?.kind==='preset'&&origin.presetVersion===2?PERSONA_PRESETS_V2.find(p=>p.id===origin.presetId)?.persona:undefined;
 const next=old?PERSONA_PRESETS.find(p=>p.id===origin!.presetId)?.persona:undefined;
 const persona=structuredClone(raw),moved:PersonaTrigger[]=[];
 persona.sections=persona.sections.filter((section:any)=>{
  if(typeof section.title!=='string'||!section.title.includes('被问到才用')||!section.content.trim())return true;
  const original=old?.sections.find(s=>s.id===section.id),preset=next?.triggers.find(t=>t.id===section.id),title=section.title.replace(/（被问到才用）|\(被问到才用\)/g,'').trim();
  moved.push(original&&preset&&section.content===original.content?structuredClone(preset):{id:section.id,title,condition:'别人问到或聊到「'+title+'」相关内容时使用。',content:section.content,enabled:true,order:0});return false;
 });
 persona.triggers=persona.triggers.map((trigger:any)=>{
  const {match,keywords,...card}=trigger;
  if(match==='keywords'||keywords!==undefined){
   const original=old?.triggers.find(t=>t.id===trigger.id),preset=next?.triggers.find(t=>t.id===trigger.id);
   if(original&&preset&&['title','condition','content','keywords'].every(key=>JSON.stringify((original as any)[key])===JSON.stringify(trigger[key])))return {...structuredClone(preset),enabled:trigger.enabled,order:trigger.order};
   if(typeof card.condition==='string'&&card.condition.startsWith('消息包含以下任一关键词：'))card.condition='对方聊到下列说法或类似意思时使用：'+(Array.isArray(keywords)?keywords.join('、'):card.condition.slice('消息包含以下任一关键词：'.length));
  }
  return card;
 });
 if(!persona.sections.length){const used=new Set([...persona.triggers,...moved].map((x:any)=>x.id));let id='role';while(used.has(id))id+='-base';persona.sections=[{id,title:'角色定义',content:''}];}
 let order=persona.triggers.reduce((n:number,t:PersonaTrigger)=>Math.max(n,t.order),-1);
 for(const card of moved){order=Math.min(order+1,10000);persona.triggers.push({...card,order});}
 return {persona,changed:JSON.stringify(persona)!==JSON.stringify(raw)};
}

export function upgradeSavedPersonas(store:Store):{changed:number;backup?:string}{
 const file=join(panelDir(),'settings.json');let original:string;
 try{original=readFileSync(file,'utf8');}catch(e:any){if(e.code==='ENOENT')return {changed:0};throw e;}
 const next:PanelSettings=JSON.parse(original),ids:string[]=[];
 for(const item of next.personaLibrary?.items??[]){const result=upgradePersona(item.persona,item.origin);if(result.changed){validatePersona(result.persona,{stored:true});item.persona=result.persona;item.revision++;ids.push(item.id);}}
 const legacy=next.persona?upgradePersona(next.persona):undefined;
 if(!ids.length&&!legacy?.changed)return {changed:0};
 const active=next.personaLibrary?.items.find(i=>i.id===next.personaLibrary!.activeId);
 if(next.personaLibrary&&!active)throw new Error('升级人设库缺少使用中项');
 if(active)next.persona=structuredClone(active.persona);else if(legacy){validatePersona(legacy.persona,{stored:true});next.persona=legacy.persona;}
 const revisions=next.revisions??{};
 next.revisions={...revisions,...(ids.length?{personaLibrary:(revisions.personaLibrary??0)+1}:{}),...((active&&ids.includes(active.id))||!active&&legacy?.changed?{persona:(revisions.persona??0)+1}:{})};
 const directory=join(process.env.DATA_DIR||'/data','backups');mkdirSync(directory,{recursive:true,mode:0o700});
 const backup='persona-upgrade-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json';
 writeFileSync(join(directory,backup),original,{mode:0o600,flag:'wx'});chmodSync(join(directory,backup),0o600);
 // 启动同步阶段没有异步空隙；备份失败或校验失败均不改原设置。
 commitPersonaUpgrade(next);
 store.log('persona-upgrade',JSON.stringify({ids,changed:ids.length||1,backup}));return {changed:ids.length||1,backup};
}
