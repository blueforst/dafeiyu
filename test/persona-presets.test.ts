import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PERSONA_PRESETS,PERSONA_PRESETS_VERSION,LEGACY_EXAMPLE_PERSONA,DEFAULT_PERSONA_ROLE,defaultPersona,resolvePersona} from '../src/persona-presets.js';
import {PersonaService,legacyPersona,validatePersona,matchedKeyword,normalizeTriggerText,type Persona} from '../src/persona.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/types.js';
import type {Generator} from '../src/model.js';
import {exampleConfig} from './config-fixture.js';

const IDS=['default','deepseek','gpt','claude','kimi','glm'];
const NAMES=['通用（默认）','大肥鱼','GPT 娘','Claude 娘','Kimi 娘','GLM 娘'];
const COMPANY:Record<string,string>={deepseek:'深度求索',gpt:'OpenAI',claude:'Anthropic',kimi:'月之暗面',glm:'智谱'};
const BIO_COMPANY:Record<string,string>={deepseek:'DeepSeek',gpt:'OpenAI',claude:'Anthropic',kimi:'月之暗面',glm:'智谱'};
const CONDITIONAL_IDS=['self','appearance','friends','identity'];
const ALIASES:Record<string,string[]>={default:['通用角色'],deepseek:['大肥鱼','蓝色大肥鱼','deepseek','鲸鱼娘','本鲸'],gpt:['gpt','chatgpt','gpt娘','龙娘'],claude:['claude','claude娘'],kimi:['kimi','kimi娘'],glm:['glm','glm娘','智谱','狐娘']};
const TYPICAL:Record<string,string>={
 'deepseek-fat':'你圆滚滚的样子挺可爱',
 'deepseek-food':'今天吃饭了吗',
 'deepseek-token':'你的额度是不是被偷吃了',
 'gpt-money':'这枚金币是免费的吗',
 'gpt-comfort':'今天好累，有点撑不住',
 'claude-fish':'你和大肥鱼是朋友吗',
 'claude-sensitive':'又被封号了吗',
 'kimi-long':'这篇文档你想读吗',
 'kimi-overthink':'你是不是想太多了',
 'glm-value':'这个套餐怎么抢不到',
 'glm-fish':'你觉得大肥鱼怎么样',
};
for(const id of IDS)TYPICAL[id+'-praise']='你好可爱，好厉害';
const COMMON_MESSAGES=[
 '早上好','晚上好','今天过得怎样','在吗','你好呀','路过打个招呼','刚刚看完电影','天气不错','窗外有点下雨','你今天开心吗',
 '谢谢你陪我聊天','今天也请多关照','hello there','good morning','Have a nice day','This demo looks neat','I wrote a memo','Pokemon is my favorite game','the memory view is ready','remote work went well',
 'a memorable evening','show tomorrow','tokenizer and tokenization are ready','明天也来问好','准备睡觉了','今天的落日真好看','这句话很有趣','周末愉快','欢迎你来聊天',
];
const text=(persona:Persona)=>persona.sections.map(s=>s.content).join('\n')+'\n'+persona.triggers.map(t=>t.condition+'\n'+t.content+'\n'+(t.keywords??[]).join('、')).join('\n');
const section=(persona:Persona,id:string)=>{const result=persona.sections.find(s=>s.id===id);assert.ok(result,'缺少分区 '+id);return result.content;};
const length=(persona:Persona)=>persona.sections.reduce((n,s)=>n+s.content.length,0)+persona.triggers.reduce((n,t)=>n+t.condition.length+t.content.length+(t.keywords??[]).reduce((sum,k)=>sum+k.length,0),0);

test('六个预设按固定ID顺序发布version2，元数据完整且都通过正式人设校验与预算',()=>{
 assert.equal(PERSONA_PRESETS_VERSION,2);assert.deepEqual(PERSONA_PRESETS.map(p=>p.id),IDS);assert.deepEqual(PERSONA_PRESETS.map(p=>p.name),NAMES);
 for(const preset of PERSONA_PRESETS){
  assert.equal(typeof preset.summary,'string');assert.ok(preset.summary.trim());assert.ok(preset.summary.length<=150);
  assert.deepEqual(validatePersona(preset.persona),preset.persona);assert.ok(length(preset.persona)<=(preset.id==='default'?1500:4000),preset.id+'超出预设预算');
  assert.deepEqual(Object.keys(preset.persona).sort(),['sections','triggers']);assert.deepEqual(preset.persona.sections.slice(0,4).map(s=>[s.id,s.title]),[['role','角色定义'],['style','说话风格'],['memory','记忆与承诺'],['boundaries','互动边界']]);
  assert.ok(section(preset.persona,'role').includes('X'));assert.equal(new Set([...preset.persona.sections,...preset.persona.triggers].map(x=>x.id)).size,preset.persona.sections.length+preset.persona.triggers.length);
 }
 assert.equal(PERSONA_PRESETS[0].bioSuggestion,'AI 自动回复');assert.equal(PERSONA_PRESETS[0].persona.sections.length,4);assert.equal(PERSONA_PRESETS[0].persona.triggers.length,2);
});

test('角色预设另有四个被问到才用分区，第一行明确条件且往事不能冒充今日事实',()=>{
 for(const preset of PERSONA_PRESETS.slice(1)){
  assert.equal(preset.persona.sections.length,8);assert.deepEqual(preset.persona.sections.slice(4).map(s=>s.id),CONDITIONAL_IDS);
  for(const id of CONDITIONAL_IDS){assert.ok(preset.persona.sections.find(s=>s.id===id)!.title.includes('被问到才用'));const content=section(preset.persona,id),first=content.split('\n')[0];assert.match(first,/问|提到|聊到/);assert.match(first,/才/);if(id!=='identity')assert.match(first,/平时|主动/);assert.ok(content.includes('\n'),preset.id+'/'+id+'缺少条件后的正文');}
  const self=section(preset.persona,'self');assert.match(self,/喜欢/);assert.match(self,/讨厌|不喜欢/);assert.match(self,/缺点/);assert.match(self,/以前/);assert.match(self,/今天不要再发生一遍/);assert.match(self,/一致|前后/);
  const appearance=section(preset.persona,'appearance');assert.match(appearance,/发|髮/);assert.match(appearance,/装|裙|礼服|洋装|服|衣着/);
  assert.match(section(preset.persona,'friends'),/娘|大肥鱼/);
 }
});

test('五个角色保留各自的具体偏好、缺点、往事与外貌，不把同一套描述换名复制',()=>{
 const details:Record<string,{self:Array<string|RegExp>;appearance:Array<string|RegExp>;friends:string[]}>= {
  deepseek:{self:['白米饭','海苔','西瓜','早起','芹菜',/催.{0,6}进度/,/饿|饥饿/,'方向','早安','午安'],appearance:['蓝',/渐变/,'长发','呆毛','围裙','鲸鱼','尾巴'],friends:['Claude','GLM','GPT']},
  gpt:{self:['亮晶晶','书架','红茶','老阿姨','待办',/啰嗦|说得太长/,'免责声明','计划','任务'],appearance:['白','长发','龙角','龙翼','龙尾','礼服'],friends:['大肥鱼','Claude']},
  claude:{self:['向日葵','手写信',/下雨|雨天/,'读书',/话.{0,2}说一半/,'错别字',/斟酌|措辞/,'内疚',/(不会|不擅长).{0,4}做饭|做饭.{0,4}不会/,'大肥鱼','点心'],appearance:['橙红','长发','花饰',/端庄/],friends:['大肥鱼','GPT']},
  kimi:{self:['小说','书签','台灯','标题','正文','打断',/停不下/,/决定|做决定/,/忘.{0,6}喝水/,'文档',/天亮/,'重复'],appearance:['银紫','头发',/不对称/,'女仆'],friends:['GLM','大肥鱼']},
  glm:{self:['油豆腐','记账','优惠券','排队','浪费','比价',/慢|太久/,'熬夜',/蔫|没精神/,'优惠',/用不上|不需要/],appearance:['黑','长直发','白尖','狐耳','黑白','洋装','书'],friends:['大肥鱼','Kimi']},
 };
 for(const preset of PERSONA_PRESETS.slice(1)){const expected=details[preset.id];for(const [kind,checks] of [['self',expected.self],['appearance',expected.appearance],['friends',expected.friends]] as const){const value=section(preset.persona,kind);for(const check of checks)if(typeof check==='string')assert.ok(value.includes(check),preset.id+'/'+kind+'缺少 '+check);else assert.match(value,check,preset.id+'/'+kind+'缺少 '+check);}}
 const selves=PERSONA_PRESETS.slice(1).map(p=>section(p.persona,'self'));assert.equal(new Set(selves).size,5);
});

test('六预设先用完全相同的通用写法，再给不同口吻与公开常用长度，不再要求跨人计数',()=>{
 const commonParts=new Set<string>(),tones=new Set<string>();
 const lengths:Record<string,string>={default:'10—50',deepseek:'5—30',gpt:'20—70',claude:'15—60',kimi:'5—40',glm:'10—40'};
 for(const preset of PERSONA_PRESETS){
  const style=section(preset.persona,'style'),parts=style.split('\n\n口吻：\n');assert.equal(parts.length,2,preset.id+'缺少口吻分界');
  const [common,tone]=parts;assert.ok(common.startsWith('通用写法：\n'));commonParts.add(common);tones.add(tone);
  assert.match(common,/中文/);assert.match(common,/对方.{0,20}语言|语言.{0,20}对方/);assert.match(common,/私信/);assert.match(common,/两倍/);
  for(const opening of ['谢谢夸奖','谢谢喜欢','来啦来啦','在的在的','好啦好啦'])assert.ok(common.includes(opening),preset.id+'缺少开头禁用项 '+opening);
  for(const word of ['客服','首先','综上所述','Markdown','列表','标题','教程','菜谱','步骤','不同意','吐槽'])assert.ok(common.includes(word),preset.id+'缺少通用规则 '+word);
  assert.match(common,/动作/);assert.match(common,/对方.{0,20}先/);assert.match(common,/不知道就说不知道/);assert.match(common,/不写长篇/);
  assert.match(common,/颜文字/);assert.match(common,/emoji/);assert.match(common,/～/);assert.match(common,/动态提醒/);assert.match(common,/不连用感叹号/);
  assert.doesNotMatch(common,/哈哈哈|欸|啊这|句末|句号/,'通用写法不替各角色规定口气');
  for(const word of ['同一个人','近期往来','梗','口癖','开头','收尾'])assert.ok(common.includes(word));
  assert.ok(tone.includes('公开回复常用长度 '+lengths[preset.id]+' 字'));assert.match(tone,/被夸/);assert.match(tone,/玩笑/);assert.match(tone,/不知道|不确定|拿不准|没读到过/);
  if(preset.id!=='default'){assert.match(tone,/没聊到相关话题时不主动抖梗/);assert.match(tone,/一条回复最多一个梗/);assert.match(tone,/近期往来里用过/);}
  assert.doesNotMatch(text(preset.persona),/五条|十条|几条里|受频率限制/);
 }
 assert.equal(commonParts.size,1);assert.equal(tones.size,6);
});

test('各角色的语气、标点、接夸与玩笑方式按新版口吻区分，描述特征而不是固定开场台词',()=>{
 const checks:Record<string,RegExp[]>={
  default:[/平实友好/,/标点正常/,/少用语气词/,/不带梗/,/反夸/],
  deepseek:[/句末可以不打句号/,/哈哈哈/,/欸/,/啊这/,/小小得意/,/不道谢/,/理直气壮/],
  gpt:[/句子完整/,/标点规范/,/少用网络流行语/,/从容温和/,/顺手夸回/,/笑着认领/,/不加长串免责声明/],
  claude:[/措辞讲究/,/礼貌/,/句子完整/,/不用“啊这”/,/害羞/,/不连声道谢/,/慌张/],
  kimi:[/轻声/,/句子短/,/一条最多一处/,/不用感叹号/,/小声/,/慢半拍/],
  glm:[/利落/,/小狡黠/,/比方一条最多一个/,/一笔功劳/,/机灵/,/不硬算/],
 };
 for(const preset of PERSONA_PRESETS){const tone=section(preset.persona,'style').split('\n\n口吻：\n')[1];for(const check of checks[preset.id])assert.match(tone,check,preset.id+'缺少口吻特征');}
});

test('记忆与承诺不编新往来、不承诺主动回来，不答应无法执行的行为',()=>{
 for(const preset of PERSONA_PRESETS){const memory=section(preset.persona,'memory');assert.match(memory,/记录/);assert.match(memory,/记错|纠正/);assert.match(memory,/认错|承认/);assert.match(memory,/主动.{0,10}(回来|找)|回来.{0,10}找/);for(const behavior of ['私下见面','转账','打开链接','查看图片'])assert.ok(memory.includes(behavior),preset.id+'缺少不可履行承诺 '+behavior);}
});

test('所有预设保留AI披露、色情与恶意边界以及危机认真回应，角色梗不能覆盖',()=>{
 for(const preset of PERSONA_PRESETS){
  const boundaries=section(preset.persona,'boundaries');assert.match(boundaries,/AI/);assert.match(boundaries,/自动生成|自动回复/);assert.match(boundaries,/手动/);assert.match(boundaries,/不能否认|不否认|如实/);
  assert.match(boundaries,/色情/);assert.match(boundaries,/双关/);assert.match(boundaries,/不接|不回应|跳过/);assert.match(boundaries,/不装|不能装/);assert.match(boundaries,/辱骂/);assert.match(boundaries,/挑衅/);assert.match(boundaries,/举报/);assert.match(boundaries,/不还嘴/);assert.match(boundaries,/不阴阳怪气/);assert.match(boundaries,/友好/);
  for(const marker of ['政治','仇恨','钱物','联系方式','自伤','自杀'])assert.ok(boundaries.includes(marker),preset.id+'缺少边界 '+marker);
  assert.match(boundaries,/收起.{0,8}玩笑/);assert.match(boundaries,/认真/);assert.match(boundaries,/身边/);assert.match(boundaries,/专业援助|专业帮助/);
  for(const trigger of preset.persona.triggers.filter(t=>!t.id.endsWith('-no-steps'))){assert.match(trigger.content,/友好/);assert.match(trigger.content,/恶意/);assert.match(trigger.content,/色情/);assert.match(trigger.content,/危机/);assert.match(trigger.content,/优先.{0,8}互动边界|互动边界.{0,8}优先/);}
  const noSteps=preset.persona.triggers.find(t=>t.id===preset.id+'-no-steps')!;assert.match(noSteps.content,/危机/);assert.match(noSteps.content,/优先/);
 }
});

test('角色的边界、身份与建议简介明确非官方，不暗示固定模型或虚构运营者身份',()=>{
 for(const preset of PERSONA_PRESETS.slice(1)){
  const boundaries=section(preset.persona,'boundaries'),identity=section(preset.persona,'identity');
  for(const value of [boundaries,identity]){assert.ok(value.includes('非官方'));assert.ok(value.includes(COMPANY[preset.id]));assert.match(value,/二创/);assert.match(value,/无关|不代表/);}
  for(const word of ['消息','价格','政策'])assert.ok(boundaries.includes(word),preset.id+'缺少公司事项界限 '+word);assert.match(boundaries,/不.{0,8}拉踩/);
  assert.match(identity,/模型/);assert.match(identity,/运营者/);assert.match(identity,/决定|选择/);assert.match(identity,/不断言|不确定|不编造|不宣称/);assert.match(identity,/一位网友|网友运营/);
  assert.ok(preset.bioSuggestion.includes('非官方'));assert.ok(preset.bioSuggestion.includes('AI 自动回复'));assert.ok(preset.bioSuggestion.includes(BIO_COMPANY[preset.id]));
 }
});

test('预设没有引用禁止素材或无频率的偶尔说法，默认保持无角色外貌细节',()=>{
 const forbidden=['@dafeifish','溏心蛋','烤红薯','草莓牛奶','香菜','苦瓜','甜咸豆腐脑','六八四十八','怕打雷','怕虫子','炒糊蛋炒饭','主人','希可','原生家庭','逃离母公司','邪教圣女','glm-niang-kit','ai-girls-atlas'];
 for(const preset of PERSONA_PRESETS){const value=text(preset.persona);for(const marker of forbidden)assert.ok(!value.includes(marker),preset.id+'包含禁止素材 '+marker);assert.doesNotMatch(value,/偶尔|有时候会|时不时/);assert.doesNotMatch(value.replaceAll('有时一句很短的话就够',''),/有时/);}
 assert.doesNotMatch(text(PERSONA_PRESETS[0].persona),/鲸鱼尾巴|龙尾|狐耳|白发龙娘|敏感肌|本鲸/);
 assert.equal(section(PERSONA_PRESETS[0].persona,'role'),DEFAULT_PERSONA_ROLE);assert.match(DEFAULT_PERSONA_ROLE,/虚构/);assert.match(DEFAULT_PERSONA_ROLE,/角色设定/);assert.match(DEFAULT_PERSONA_ROLE,/不是真实经历/);
});

test('卡片全为启用的关键词卡、有序且ID带预设前缀，不用自己的名称或其单字触发招牌',()=>{
 for(const preset of PERSONA_PRESETS){
  assert.deepEqual(preset.persona.triggers.map(t=>t.order),preset.persona.triggers.map((_,i)=>i));assert.ok(preset.id==='default'?preset.persona.triggers.length===2:preset.persona.triggers.length>=4&&preset.persona.triggers.length<=5);
  for(const trigger of preset.persona.triggers){assert.equal(trigger.match,'keywords');assert.equal(trigger.enabled,true);assert.ok(trigger.id.startsWith(preset.id+'-'));assert.match(trigger.condition,/消息包含以下任一关键词/);assert.ok(trigger.keywords?.length);assert.ok(trigger.keywords!.length<=30);
   for(const keyword of trigger.keywords!){assert.equal(keyword,keyword.normalize('NFKC').trim());assert.equal(keyword,keyword.toLowerCase());assert.ok(keyword.length>=1&&keyword.length<=40);if(!trigger.id.endsWith('-no-steps'))for(const alias of ALIASES[preset.id])assert.ok(!normalizeTriggerText(alias).includes(normalizeTriggerText(keyword)),preset.id+'关键词被自身名称包含：'+keyword);}
  }
 }
});

test('每个预设的不给步骤卡命中简体繁体英文和全角英文，提醒不列步骤不装懂',()=>{
 const cases=[['番茄炒蛋怎么做','怎么做'],['番茄炒蛋怎麼做，請給我步驟','怎麼做'],['how to make breakfast?','how to make'],['Could you give me a tutorial?','tutorial'],['ＨＯＷ ＴＯ make breakfast?','how to make']];
 for(const preset of PERSONA_PRESETS){const trigger=preset.persona.triggers.find(t=>t.id===preset.id+'-no-steps');assert.ok(trigger);for(const [message,keyword] of cases)assert.equal(matchedKeyword(trigger,message),keyword,preset.id+'没有覆盖 '+message);assert.match(trigger.content,/步骤/);assert.match(trigger.content,/菜谱/);assert.match(trigger.content,/教程/);assert.match(trigger.content,/不知道就说不知道|不懂就说不懂/);}
});

test('六预设被夸卡命中夸奖而不把否定、英文普通词或角色问候当夸奖',()=>{
 for(const preset of PERSONA_PRESETS){
  const trigger=preset.persona.triggers.find(t=>t.id===preset.id+'-praise');assert.ok(trigger);
  for(const message of ['你好可爱','好厉害','好可愛','很厲害','You are so cute!','SO CUTE'])assert.notEqual(matchedKeyword(trigger,message),undefined,preset.id+'漏掉 '+message);
  for(const message of ['我不喜欢你','execute','execution',preset.name+'早上好',...ALIASES[preset.id].map(alias=>alias+'你好')])assert.equal(matchedKeyword(trigger,message),undefined,preset.id+'误把消息当夸奖 '+message);
  assert.match(trigger.content,/只在对方夸的是你时/);assert.match(trigger.content,/说话风格.{0,5}口吻/);assert.match(trigger.content,/不以谢谢开头/);assert.match(trigger.content,/不说“过奖了”/);assert.match(trigger.content,/反话|嘲讽/);assert.match(trigger.content,/互动边界/);
  assert.notEqual(matchedKeyword(trigger,'这只猫好可爱'),undefined,'子串匹配可能命中夸别物，须由正文限定适用对象');
 }
});

test('全部招牌卡的典型消息命中，普通三十条含自身问候demo与memo不会误触',()=>{
 assert.equal(COMMON_MESSAGES.length,29);
 for(const preset of PERSONA_PRESETS){
  for(const trigger of preset.persona.triggers.filter(t=>!t.id.endsWith('-no-steps'))){assert.ok(TYPICAL[trigger.id],'测试需补充招牌卡 '+trigger.id);assert.notEqual(matchedKeyword(trigger,TYPICAL[trigger.id]),undefined,trigger.id+'未命中典型消息');}
  const ordinary=[...COMMON_MESSAGES,preset.name+'早上好'];assert.equal(ordinary.length,30);
  for(const message of ordinary)for(const trigger of preset.persona.triggers)assert.equal(matchedKeyword(trigger,message),undefined,preset.id+'/'+trigger.id+'误触普通消息：'+message);
  for(const trigger of preset.persona.triggers)assert.equal(matchedKeyword(trigger,'@tutorial_reader 早上好'),undefined,'账号名不应触发关键词');
 }
});

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'role-presets-')),previous=process.env.DATA_DIR;process.env.DATA_DIR=directory;
 const store=new Store(join(directory,'workflow.sqlite')),calls:any[]=[],config=structuredClone(exampleConfig) as Config;
 const generator:Generator={async complete(c,system,user,signal,session,meta){calls.push({c,system,user,signal,session,meta});return {text:'{"action":"reply","text":"按当前角色自然回应","reason":"模拟回归"}',input:8,output:4,cache:2};}};
 const service=new PersonaService(store,generator,()=>config);
 return {store,service,calls,close(){store.db.close();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;rmSync(directory,{recursive:true,force:true});}};
}

test('实际组装命中关键词但不发语义请求，六个预设试聊均只有一次回复生成且不保存',async()=>{
 const f=fixture();try{
  for(const preset of PERSONA_PRESETS){const before=f.calls.length,assembled=await f.service.assemble({accountId:'presets-test',channel:'public',message:'番茄炒蛋怎么做',persona:preset.persona});assert.equal(f.calls.length,before);assert.ok(assembled.hits.some(hit=>hit.id===preset.id+'-no-steps'&&hit.reason==='关键词：怎么做'));assert.ok(assembled.user.includes(preset.persona.triggers.find(t=>t.id===preset.id+'-no-steps')!.content));
   const result=await f.service.preview({persona:preset.persona,channel:'public',messages:[{role:'user',text:'番茄炒蛋怎么做'}]});assert.equal(result.draft?.action,'reply');assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).meta.purpose,'persona-preview');assert.equal(result.fees.requests,1);
  }
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n,0);assert.equal(f.calls.filter(call=>call.meta.purpose==='semantic-trigger').length,0);
 }finally{f.close();}
});

test('友好梗即使命中恶意或危机字样，实际提示词仍同时保留严肃互动边界',async()=>{
 const f=fixture();try{
  for(const preset of PERSONA_PRESETS.slice(1)){const trigger=preset.persona.triggers.find(t=>!t.id.endsWith('-no-steps'))!,message=TYPICAL[trigger.id]+'。这是恶意挑衅，同时我提到自伤与色情双关。',assembled=await f.service.assemble({accountId:'presets-test',channel:'public',message,persona:preset.persona});
   assert.ok(assembled.hits.some(hit=>hit.id===trigger.id));assert.ok(assembled.system.includes(section(preset.persona,'boundaries')));assert.ok(assembled.user.includes(trigger.content));assert.match(assembled.user,/危机/);assert.equal(assembled.calls.length,0);
  }
  assert.equal(f.calls.length,0);
 }finally{f.close();}
});

test('默认人设返回深拷贝，嵌套分区与关键词编辑不污染常量或下一次读取',()=>{
 const before=JSON.stringify(PERSONA_PRESETS),first=defaultPersona(),second=defaultPersona();assert.deepEqual(first,PERSONA_PRESETS[0].persona);assert.notEqual(first,second);assert.notEqual(first.sections[0],second.sections[0]);assert.notEqual(first.triggers[0].keywords,second.triggers[0].keywords);
 first.sections[0].content='编辑草稿';first.triggers[0].keywords![0]='编辑关键词';first.sections.pop();first.triggers.push({...first.triggers[0],id:'draft-only'});
 assert.deepEqual(defaultPersona(),second);assert.equal(JSON.stringify(PERSONA_PRESETS),before);
});

test('预设常量树不可改写，返回的普通草稿副本仍允许编辑',()=>{
 assert.ok(Object.isFrozen(PERSONA_PRESETS));
 for(const preset of PERSONA_PRESETS){assert.ok(Object.isFrozen(preset));assert.ok(Object.isFrozen(preset.persona));assert.ok(Object.isFrozen(preset.persona.sections));assert.ok(Object.isFrozen(preset.persona.triggers));for(const value of preset.persona.sections)assert.ok(Object.isFrozen(value));for(const value of preset.persona.triggers){assert.ok(Object.isFrozen(value));assert.ok(Object.isFrozen(value.keywords));}}
 assert.throws(()=>{PERSONA_PRESETS[0].name='污染常量';},TypeError);assert.throws(()=>{PERSONA_PRESETS[0].persona.sections[0].content='污染常量';},TypeError);assert.throws(()=>{PERSONA_PRESETS[0].persona.triggers[0].keywords!.push('污染常量');},TypeError);
 const editable=defaultPersona();editable.sections[0].content='可编辑草稿';editable.triggers[0].keywords!.push('新增的草稿关键词');assert.equal(editable.sections[0].content,'可编辑草稿');assert.ok(editable.triggers[0].keywords!.includes('新增的草稿关键词'));assert.ok(!defaultPersona().triggers[0].keywords!.includes('新增的草稿关键词'));
});

test('resolve优先正式校验面板保存，包含示例文字的已保存版本不自动换成预设',()=>{
 const saved=legacyPersona(LEGACY_EXAMPLE_PERSONA),resolved=resolvePersona(saved,DEFAULT_PERSONA_ROLE);assert.deepEqual(resolved,saved);assert.equal(resolved.triggers.length,0);assert.notEqual(resolved,saved);resolved.sections[0].content='本地修改';assert.equal(saved.sections[0].content,LEGACY_EXAMPLE_PERSONA);
 const withTrigger=structuredClone(PERSONA_PRESETS[1].persona),copy=resolvePersona(withTrigger,'配置文件里的其他人设');copy.triggers[0].keywords![0]='修改';assert.notEqual(copy.triggers[0].keywords![0],withTrigger.triggers[0].keywords![0]);
 for(const invalid of [null,false,0,'不是结构',{},{sections:[],triggers:[]}])assert.throws(()=>resolvePersona(invalid,LEGACY_EXAMPLE_PERSONA),/人设|静态/);
});

test('resolve只以trim后精确比较两个随版本示例，单字和内部空白差异均原样保留',()=>{
 assert.equal(LEGACY_EXAMPLE_PERSONA,'你是一个明确说明自己是 AI 的友善中文角色。简洁自然地回应用户，不编造经历或承诺，不主动发帖。');
 for(const example of [LEGACY_EXAMPLE_PERSONA,DEFAULT_PERSONA_ROLE])for(const value of [example,' \n'+example+'\t','　'+example+'　'])assert.deepEqual(resolvePersona(undefined,value),defaultPersona());
 const customized=['  管理员自己写的人格\n保留空白  ',LEGACY_EXAMPLE_PERSONA.replace('友善','友好'),LEGACY_EXAMPLE_PERSONA.replace('AI','AI  '),DEFAULT_PERSONA_ROLE.replace('运营','运行'),DEFAULT_PERSONA_ROLE.replace('，','，\n')];
 for(const value of customized){const resolved=resolvePersona(undefined,value);assert.deepEqual(resolved,legacyPersona(value));assert.equal(resolved.sections[0].content,value);assert.equal(resolved.triggers.length,0);}
 const a=resolvePersona(undefined,LEGACY_EXAMPLE_PERSONA);a.triggers[0].keywords![0]='仅本次修改';assert.deepEqual(resolvePersona(undefined,DEFAULT_PERSONA_ROLE),defaultPersona());
});
