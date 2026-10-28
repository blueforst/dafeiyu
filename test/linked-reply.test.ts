import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {MemoryService} from '../src/memory.js';
import {Workflow} from '../src/workflow.js';
import {Outbox} from '../src/outbox.js';
import {ActivityFeed} from '../src/activity-feed.js';
import {ReplyTriage} from '../src/reply-triage.js';
import {generateReply} from '../src/reply-pipeline.js';
import {assembleReplyPrompt,REPLY_PROMPT_VERSION} from '../src/reply-prompt.js';
import {buildReplyHints} from '../src/reply-hints.js';
import {exampleConfig} from './config-fixture.js';
import type {Config,Event} from '../src/types.js';
import type {Transport} from '../src/transport.js';
const secret='下个月要去大阪看樱花';
function fixture(){
 const path=mkdtempSync(tmpdir()+'/linked-reply-'),previous=process.env.DATA_DIR;process.env.DATA_DIR=path;
 const store=new Store(path+'/workflow.sqlite'),config={...structuredClone(exampleConfig),mode:'auto',replyHours:{enabled:false,closeDelayMinutes:30}} as Config;
 let sends=0;const generator={complete:async()=>({text:JSON.stringify({action:'reply',text:secret+'了吧！',reason:'回应'}),input:1,output:1,cache:0})};
 const memory=new MemoryService(store,generator,()=>config),outbox=new Outbox(store),triage=new ReplyTriage(store);
 const event:Event={id:'x:100',platformId:'100',targetId:'100',channel:'public',userId:'x:alice',handle:'alice',text:'你还记得我的计划吗？',url:'https://x.com/alice/status/100',conversationId:'100',timestamp:Date.now(),timestampReliable:true};
 const transport:Transport={identity:async()=>({handle:'privacy_bot',loggedIn:true,needsHuman:false}),control:async()=>{},collect:async()=>({events:[event],warnings:[]}),context:async()=>({messages:[]}),send:async()=>{sends++;return {status:'confirmed',id:'sent100'};},lookup:async()=>({status:'unknown'}),post:async()=>({status:'unknown'}),lookupPost:async()=>({status:'unknown'})};
 const workflow=new Workflow(store,transport,generator,()=>config);workflow.services={memory,outbox,triage};store.set('activeAccount','privacy_bot');
 memory.links.link('privacy_bot','dm:thread','x:alice','admin');store.db.prepare('INSERT INTO memory_items(id,account_id,user_id,channel,kind,text,source_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('secret','privacy_bot','dm:thread','private','fact',secret,'complete',1,1);
 return {store,config,memory,event,workflow,generator,sends:()=>sends,close(){workflow.stop();store.db.close();rmSync(path,{recursive:true,force:true});if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;}};
}
for(const mode of ['auto','draft'] as const)test('私信重合：'+mode+' 保持草稿且零提交，明确批准后可提交',async()=>{const f=fixture();try{
 f.config.mode=mode;f.event.peerHandle='bob';await f.workflow.resume();await f.workflow.tick();const row=f.store.getMessage(f.event.id,'privacy_bot');assert.equal(row.status,'draft');const draft=JSON.parse(row.draft);assert.equal(draft.validation.code,'private-overlap');assert.equal(draft.privacy.overlap,secret);assert.equal(row.error,'可能提及私信内容');assert.equal(f.sends(),0);assert.equal(f.memory.links.publicOf('privacy_bot','dm:thread')!.publicUserId,'x:alice');
 const feed=new ActivityFeed(f.store,()=> 'privacy_bot',()=>f.config.maxAgeHours);feed.mutate(row.id,'approve',{text:draft.text,revision:row.updated_at});await f.workflow.tick();assert.equal(f.sends(),1);assert.equal(f.store.getMessage(row.id,'privacy_bot').status,'confirmed');
}finally{f.close();}});
test('重合检查只用于公开且有私信背景的回复，不改变私信校验',async()=>{const f=fixture();try{
 for(const channel of ['public','private'] as const){const value=await generateReply({config:f.config,accountId:'privacy_bot',generator:f.generator,conversation:()=>[],memory:()=>({privateBackground:channel==='public'?[]:[{type:'fact',text:secret}]}),recentReplies:()=>[],sessionId:'test'},{...f.event,channel});assert.equal(value.draft.privacy,undefined);assert.equal(value.validation?.allowed,true);}
}finally{f.close();}});
test('v5 时区固定约束、迟到文案及私信背景独立段落只在公开出现',()=>{
 const now=Date.parse('2026-10-29T19:53:00Z'),input={accountId:'bot',channel:'public' as const,message:'你好呀',staticText:'角色',now,memory:{memories:[],recent:[],privateBackground:[{type:'fact',text:secret}]}};
 const prompt=assembleReplyPrompt(input),kinds=prompt.segments.map(s=>s.kind);assert.equal(REPLY_PROMPT_VERSION,'reply-context-v5');assert.equal(kinds.indexOf('private-background'),kinds.indexOf('memory')+1);assert.match(prompt.system,/不知道对方那边几点/);assert.match(prompt.segments.at(-1)!.content,/你这边：.*对方的当地时间未知/);assert.match(prompt.segments.find(s=>s.kind==='daily')!.content,/这是你自己的日程和时段/);assert.ok(!prompt.segments.find(s=>s.kind==='memory')!.content.includes(secret));
 assert.equal(assembleReplyPrompt({...input,channel:'private'}).segments.some(s=>s.kind==='private-background'),false);
 const late=buildReplyHints({...input,timestamp:now-2*3600000,timestampReliable:true}).hints.find(h=>h.kind==='late')!;assert.match(late.text,/自然地为迟到致歉一次/);assert.doesNotMatch(late.text,/按现在的时段问候/);
});
