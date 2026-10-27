// 在服务器已构建的独立开发副本执行；全部样本为合成资料，不调用模型或浏览器。
import { assembleReplyPrompt,FIXED_SYSTEM_RULES } from '../dist/reply-prompt.js';
const now=Date.parse('2026-10-28T12:30:00Z');
const fixtures=[
 {message:'你好，今天怎么样？',age:5,triggered:''},
 {message:'這個問題讓我覺得很開心',age:90,triggered:'【不提供步骤】\n只聊感受。'},
 {message:'Hello there, how are you doing?',age:180,triggered:''},
 {message:'今日はいい天気ですね',age:5,triggered:'【不提供步骤】\n只聊感受。'},
 {message:'정말 감사합니다',age:360,triggered:''},
 {message:'😀',age:5,triggered:'【不提供步骤】\n只聊感受。'},
 {message:'上班有点累了',age:61,triggered:''},
 {message:'你好 abc',age:10,triggered:'【不提供步骤】\n只聊感受。'}
];
const rows=['public','private'].flatMap(channel=>fixtures.map((fixture,index)=>{
 const input={...fixture,accountId:'synthetic-account',channel,conversationId:channel==='private'?'synthetic-conversation':undefined,staticText:'【角色定义】\n这是明确虚构的角色。',dailyState:'虚构日程：读书与休息',now,timestamp:now-fixture.age*60000,timestampReliable:true,recentReplies:[{accountId:'synthetic-account',channel,conversationId:channel==='private'?'synthetic-conversation':undefined,text:'收到，慢慢来～'}]};
 const next=assembleReplyPrompt(input);
 const oldSystem=[FIXED_SYSTEM_RULES,input.staticText,input.triggered,'【角色状态：虚构日程与真实经历分别解释】\n'+JSON.stringify({daily:{fictional:true,content:input.dailyState},experiences:{fictional:false,items:[]}})].filter(Boolean).join('\n\n');
 return {channel,index,oldSystem,nextSystem:next.system,kinds:next.meta.hintKinds};
}));
function consistency(key){let comparable=0,equal=0;for(let index=1;index<rows.length;index++)if(rows[index].channel===rows[index-1].channel){comparable++;if(rows[index][key]===rows[index-1][key])equal++;}return {definition:'同渠道相邻样本system逐字节相同比例',equal,comparable,ratio:comparable?equal/comparable:null};}
const hints=Object.fromEntries(['late','language','opening','expression','reply-check'].map(kind=>[kind,{count:rows.filter(r=>r.kinds.includes(kind)).length,ratio:rows.filter(r=>r.kinds.includes(kind)).length/rows.length}]));
console.log(JSON.stringify({evidence:'synthetic-offline',sampleCount:rows.length,modelCalls:0,browserOperations:0,system:{before:consistency('oldSystem'),after:consistency('nextSystem')},hintFrequency:hints,cacheReadComparison:{status:'not-measured',reason:'没有真实模型调用授权，未测量服务商实际缓存读取token'}},null,2));
