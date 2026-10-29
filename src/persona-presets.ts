import type {Persona,PersonaTrigger} from './persona.js';
import {legacyPersona,validatePersona} from './persona.js';
import {PERSONA_PRESETS_V2,EXAMPLE_PERSONA_TEXTS} from './persona-presets-v2.js';
export {PERSONA_PRESETS_V2,EXAMPLE_PERSONA_TEXTS,LEGACY_EXAMPLE_PERSONA,DEFAULT_PERSONA_ROLE} from './persona-presets-v2.js';
export type PersonaPreset={id:string;name:string;summary:string;bioSuggestion:string;persona:Persona};
export const PERSONA_PRESETS_VERSION=3;
const conditions:Record<string,string>={
 'no-steps':'对方要你给做法、教程、步骤、清单或攻略，无论怎么问。',
 praise:'对方在夸你本人（外貌、性格、能力）；反话、嘲讽、骚扰（例如“别装可爱”）不算。',
 self:'对方询问你的喜好（例如爱吃什么）、口味、习惯或往事，需要从这张卡获取设定资料，不凭印象猜。',appearance:'对方问你长什么样、夸你或聊到外表。',friends:'对方提到其他 AI 或 AI 娘。',identity:'对方问你是谁做的、用什么模型、和官方什么关系。',
 'deepseek-fat':'对方友好地拿你的体形开玩笑。','deepseek-food':'对方聊自己的吃饭、食物、饥饿或饮食。询问你的个人喜好、口味或习惯时先读「她自己」，不要用本卡代替。','deepseek-token':'对方友好地拿偷吃 token、额度或服务器繁忙的角色梗开玩笑。',
 'gpt-treasure':'对方聊到财宝、金币、亮晶晶的小物或等价交换。','gpt-reference':'对方友好地拿你考虑太周全或免责声明开玩笑。',
 'claude-elegant':'对方友好地聊到你的大小姐气质或讲究的习惯。','claude-fish':'对方提到大肥鱼或你和她的虚构关系。',
 'kimi-moon':'对方聊到月亮、月之暗面或你的月面角色背景。','kimi-long':'对方友好地聊到长文、读书或你爱读东西的习惯。',
 'glm-value':'对方聊到比价、优惠、性价比或虚构的抢优惠小剧场。','glm-fish':'对方提到大肥鱼或你和她的虚构较劲。',
};
function freeze<T>(v:T):T {if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export const PERSONA_PRESETS:PersonaPreset[]=freeze(PERSONA_PRESETS_V2.map(p=>{
 const sections=p.persona.sections.filter(s=>!s.title.includes('被问到才用')).map(s=>({...s}));
 const originals=p.persona.triggers.map(t=>({id:t.id,title:t.title,condition:conditions[t.id]??conditions[t.id.replace(p.id+'-','')]??('对方聊到「'+t.title+'」相关话题，且符合卡片内容中的使用情境。'),content:t.content,enabled:t.enabled,order:t.order}));
 const moved:PersonaTrigger[]=p.persona.sections.filter(s=>s.title.includes('被问到才用')).map(s=>({id:s.id,title:s.title.replace(/（被问到才用）|\(被问到才用\)/g,''),condition:conditions[s.id],content:s.content.split('\n').slice(1).join('\n'),enabled:true,order:0}));
 const triggers=[...originals.slice(0,2),...moved,...originals.slice(2)].map((t,i)=>({...t,order:i}));
 return {...p,persona:{sections,triggers}};
}));
export function defaultPersona():Persona {return structuredClone(PERSONA_PRESETS[0].persona);}
/** 只在运行期调用 persona.ts，保留已保存内容与自定义旧原文的优先级。 */
export function resolvePersona(settingsPersona:unknown,configPersona:string):Persona {
 if(settingsPersona!==undefined)return validatePersona(settingsPersona,{stored:true});
 if(EXAMPLE_PERSONA_TEXTS.includes(configPersona.trim()))return defaultPersona();
 return legacyPersona(configPersona);
}
