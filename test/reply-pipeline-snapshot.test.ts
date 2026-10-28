import test from 'node:test';
import assert from 'node:assert/strict';
import {generateReply} from '../src/reply-pipeline.js';
import type {Config,Event} from '../src/types.js';
import type {Generator} from '../src/model.js';
import {exampleConfig} from './config-fixture.js';

test('上下文异步读取期间切换人设不改变本轮快照的归属',{timeout:10000},async()=>{
 let active={id:'first',name:'第一份人设',revision:1};const snapshots:any[]=[];
 const event:Event={id:'x:123',platformId:'123',channel:'public',userId:'x:user',handle:'user',text:'今天的项目进度如何？',url:'https://x.com/user/status/123',conversationId:'123',timestamp:Date.now(),timestampReliable:true,accountId:'bot'};
 const generator:Generator={async complete(){return {text:JSON.stringify({action:'reply',text:'先说说你现在做到哪一步。',reason:'回应当前话题'}),input:1,output:1,cache:0};}};
 await generateReply({config:structuredClone(exampleConfig) as Config,accountId:'bot',generator,sessionId:'stable-session',
  conversation:async()=>{await Promise.resolve();active={id:'second',name:'第二份人设',revision:2};return '读取到的对话';},memory:()=>({memories:[],recent:[]}),recentReplies:()=>[],
  personaIdentity:()=>active,snapshot:(_event,data)=>snapshots.push(data)
 },event);
 assert.equal(snapshots[0].personaId,'first');assert.equal(snapshots[0].personaName,'第一份人设');assert.equal(snapshots[0].personaRevision,1);
});
