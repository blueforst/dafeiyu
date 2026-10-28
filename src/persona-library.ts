import { randomUUID } from 'node:crypto';
import { commitPersonaLibrary,readPanelSettings,type PanelSettings } from './settings.js';
import { FIXED_SYSTEM_RULES,legacyPersona,validatePersona,type Persona,type PersonaService } from './persona.js';
import { PERSONA_PRESETS,PERSONA_PRESETS_VERSION } from './persona-presets.js';
import type { Store } from './store.js';

export type PersonaIdentity={id:string;name:string;revision:number};
export type PersonaOrigin={kind:'blank'|'preset'|'copy'|'migrated';presetId?:string;presetVersion?:number;fromId?:string};
export type PersonaLibraryItem=PersonaIdentity&{createdAt:number;updatedAt:number;origin:PersonaOrigin;persona:Persona};
export type PersonaLibrary={version:1;activeId:string;items:PersonaLibraryItem[]};
export class PersonaLibraryError extends Error {constructor(message:string,public statusCode=400){super(message);}}
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function name(raw:unknown):string {if(typeof raw!=='string')throw new PersonaLibraryError('人设名称需要一至四十字');const value=raw.trim();if(!value||Array.from(value).length>40||/[\u0000-\u001f\u007f]/.test(value))throw new PersonaLibraryError('人设名称需要一至四十字，不能包含控制字符');return value;}
const identity=(item:PersonaLibraryItem):PersonaIdentity=>({id:item.id,name:item.name,revision:item.revision});

/** 库不存在时提供只读的虚拟 current；生产仍从兼容 persona 镜像读取。 */
export class PersonaLibraryService {
 constructor(private store:Store,private persona:PersonaService,private now:()=>number=Date.now){}
 private checked(raw:unknown):PersonaLibrary {
  if(!object(raw)||raw.version!==1||typeof raw.activeId!=='string'||!Array.isArray(raw.items)||raw.items.length<1||raw.items.length>20)throw new Error('库结构无效');
  const ids=new Set<string>(),names=new Set<string>();
  const items:PersonaLibraryItem[]=raw.items.map((item:any)=>{
   if(!object(item)||typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(item.id)||ids.has(item.id)||!Number.isSafeInteger(item.revision)||item.revision<0||!Number.isSafeInteger(item.createdAt)||item.createdAt<0||!Number.isSafeInteger(item.updatedAt)||item.updatedAt<0||!object(item.origin)||!['blank','preset','copy','migrated'].includes(item.origin.kind))throw new Error('人设条目无效');
   const title=name(item.name);if(names.has(title))throw new Error('名称重复');ids.add(item.id);names.add(title);
   if(item.origin.presetId!==undefined&&(typeof item.origin.presetId!=='string'||!Number.isSafeInteger(item.origin.presetVersion)||item.origin.presetVersion<1))throw new Error('预设来源无效');
   if(item.origin.kind==='preset'&&typeof item.origin.presetId!=='string')throw new Error('预设来源无效');
   if(item.origin.kind==='copy'&&typeof item.origin.fromId!=='string')throw new Error('复制来源无效');
   const origin:PersonaOrigin=item.origin.kind==='preset'?{kind:'preset',presetId:item.origin.presetId,presetVersion:item.origin.presetVersion}:item.origin.kind==='copy'?{kind:'copy',fromId:item.origin.fromId,...(item.origin.presetId?{presetId:item.origin.presetId,presetVersion:item.origin.presetVersion}:{})}:{kind:item.origin.kind==='blank'?'blank':'migrated'};
   return {id:item.id,name:title,revision:item.revision,createdAt:item.createdAt,updatedAt:item.updatedAt,origin,persona:validatePersona(item.persona)};
  });
  if(!ids.has(raw.activeId))throw new Error('使用中人设不存在');
  return {version:1,activeId:raw.activeId,items};
 }
 read():{library:PersonaLibrary;libraryRevision:number;panel:PanelSettings} {
  const panel=readPanelSettings();
  if(panel.personaLibrary===undefined){const current=this.persona.get(),at=this.now();return {library:{version:1,activeId:'current',items:[{id:'current',name:'当前人设',revision:current.revision,createdAt:at,updatedAt:at,origin:{kind:'migrated'},persona:structuredClone(current.persona)}]},libraryRevision:panel.revisions?.personaLibrary??0,panel};}
  try{return {library:this.checked(panel.personaLibrary),libraryRevision:panel.revisions?.personaLibrary??0,panel};}
  catch{this.store.log('persona-library-error','人设库损坏，兼容人设镜像保持原状','warn');throw new PersonaLibraryError('人设库文件损坏或校验失败，请检查设置文件',500);}
 }
 private find(library:PersonaLibrary,id:unknown):PersonaLibraryItem {if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw new PersonaLibraryError('人设标识无效');const item=library.items.find(item=>item.id===id);if(!item)throw new PersonaLibraryError('人设不存在或已删除',404);return item;}
 private unique(library:PersonaLibrary,title:string,id?:string){if(library.items.some(item=>item.id!==id&&item.name===title))throw new PersonaLibraryError('人设名称已存在');}
 private nextName(library:PersonaLibrary,base:string){const prefix=Array.from(base).slice(0,35).join('');for(let n=0;;n++){const value=prefix+(n?' '+(n+1):'');if(!library.items.some(item=>item.name===value))return value;}}
 disclosure(item:PersonaLibraryItem){const origin=item.origin;if(!origin.presetId)return undefined;const preset=PERSONA_PRESETS.find(preset=>preset.id===origin.presetId);return preset&&preset.bioSuggestion?{presetId:preset.id,bioSuggestion:preset.bioSuggestion,requiresDisclosure:preset.id!=='default',message:preset.id==='default'?'今日日程不会自动改变':'恢复业务前请修改 X 账号名称和简介，并考虑把“非官方”加入合规检查披露词'}:undefined;}
 list(){const {library,libraryRevision}=this.read();return {activeId:library.activeId,libraryRevision,items:library.items.map(({persona,...item})=>({...item,characters:persona.sections.reduce((n,s)=>n+s.content.length,0)+persona.triggers.reduce((n,t)=>n+t.content.length+t.condition.length+(t.keywords?.reduce((sum,word)=>sum+word.length,0)??0),0)}))};}
 detail(id:string){const {library}=this.read(),item=this.find(library,id);return {...structuredClone(item),active:library.activeId===id,fixedRules:FIXED_SYSTEM_RULES,disclosure:this.disclosure(item)};}
 getActive(){const {library}=this.read();return structuredClone(this.find(library,library.activeId));}
 activeIdentity(){return identity(this.getActive());}
 private persist(library:PersonaLibrary,libraryRevision:number,panel:PanelSettings,opts:{itemId?:string;expectedItemRevision?:number;expectedPersonaRevision?:number}={}){return commitPersonaLibrary(library,{expectedLibraryRevision:libraryRevision,previousPersona:this.persona.get().persona,...opts});}
 private response(item:PersonaLibraryItem,library:PersonaLibrary,libraryRevision:number){return {ok:true,item:{...structuredClone(item),fixedRules:FIXED_SYSTEM_RULES,disclosure:this.disclosure(item)},activeId:library.activeId,libraryRevision};}
 create(raw:any){
  if(!object(raw)||!['blank','preset','copy'].includes(raw.from))throw new PersonaLibraryError('请选择空白、预设或复制新建');
  const {library,libraryRevision,panel}=this.read();if(library.items.length>=20)throw new PersonaLibraryError('最多保存二十个人设，请先删除不用的人设');
  let persona:Persona,origin:PersonaOrigin,base:string;
  if(raw.from==='preset'){const preset=PERSONA_PRESETS.find(preset=>preset.id===raw.presetId);if(!preset)throw new PersonaLibraryError('内置预设不存在');persona=structuredClone(preset.persona);origin={kind:'preset',presetId:preset.id,presetVersion:PERSONA_PRESETS_VERSION};base=preset.name;}
  else if(raw.from==='copy'){const source=this.find(library,raw.sourceId);persona=structuredClone(source.persona);origin={kind:'copy',fromId:source.id,...(source.origin.presetId?{presetId:source.origin.presetId,presetVersion:source.origin.presetVersion}:{})};base=source.name+' · 副本';}
  else{persona=legacyPersona('');origin={kind:'blank'};base='新人设';}
  const title=raw.name===undefined?this.nextName(library,base):name(raw.name);this.unique(library,title);const at=this.now(),item:PersonaLibraryItem={id:randomUUID(),name:title,revision:1,createdAt:at,updatedAt:at,origin,persona};library.items.push(item);
  const saved=this.persist(library,libraryRevision,panel);this.store.log('persona-create',JSON.stringify(identity(item)));return this.response(item,library,saved.revision);
 }
 exportFile(id:string){const item=this.detail(id);return {format:'role-workflow-persona',version:1,name:item.name,persona:item.persona};}
 importFile(raw:unknown){
  if(!object(raw)||!object(raw.document)||raw.document.format!=='role-workflow-persona'||raw.document.version!==1)throw new PersonaLibraryError('请选择本系统导出的人设 JSON 文件（版本 1）');
  const persona=validatePersona(raw.document.persona),base=name(raw.document.name),{library,libraryRevision,panel}=this.read();
  if(library.items.length>=20)throw new PersonaLibraryError('最多保存二十个人设，请先删除不用的人设');
  const title=raw.name===undefined?this.nextName(library,base):name(raw.name);this.unique(library,title);
  const at=this.now(),item:PersonaLibraryItem={id:randomUUID(),name:title,revision:1,createdAt:at,updatedAt:at,origin:{kind:'blank'},persona};
  library.items.push(item);const saved=this.persist(library,libraryRevision,panel);this.store.log('persona-import',JSON.stringify(identity(item)));return this.response(item,library,saved.revision);
 }
 save(id:string,raw:any,opts:{expectedPersonaRevision?:number}={}){
  if(!object(raw)||!Number.isSafeInteger(raw.revision)||raw.revision<0)throw new PersonaLibraryError('保存时需要当前人设修订号');
  const {library,libraryRevision,panel}=this.read(),item=this.find(library,id);if(raw.revision!==item.revision)throw new PersonaLibraryError('人设修订已变化，请重新读取后保存',409);
  const title=raw.name===undefined?item.name:name(raw.name);this.unique(library,title,id);const content=raw.persona===undefined?item.persona:validatePersona(raw.persona),previousRevision=item.revision;
  item.name=title;item.persona=content;item.revision++;item.updatedAt=this.now();const saved=this.persist(library,libraryRevision,panel,{itemId:id,expectedItemRevision:previousRevision,...opts});this.store.log('persona-save',JSON.stringify(identity(item)));return {...this.response(item,library,saved.revision),personaRevision:saved.personaRevision};
 }
 activate(id:string,expectedLibraryRevision:unknown){
  const {library,libraryRevision,panel}=this.read();if(!Number.isSafeInteger(expectedLibraryRevision)||expectedLibraryRevision!==libraryRevision)throw new PersonaLibraryError('人设库修订已变化，请重新读取后切换',409);
  const item=this.find(library,id);library.activeId=id;const saved=this.persist(library,libraryRevision,panel),disclosure=this.disclosure(item);this.store.log('persona-activate',JSON.stringify(identity(item)));return {...this.response(item,library,saved.revision),disclosure:disclosure?.requiresDisclosure?disclosure:undefined};
 }
 delete(id:string,expectedRevision:unknown){
  const {library,libraryRevision,panel}=this.read(),item=this.find(library,id);if(library.activeId===id)throw new PersonaLibraryError('使用中的人设不能删除，请先切换到其他人设',409);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==item.revision)throw new PersonaLibraryError('人设修订已变化，请重新读取后删除',409);
  library.items=library.items.filter(item=>item.id!==id);const saved=this.persist(library,libraryRevision,panel,{itemId:id,expectedItemRevision:item.revision});this.store.log('persona-delete',JSON.stringify(identity(item)));return {ok:true,activeId:library.activeId,libraryRevision:saved.revision};
 }
}
