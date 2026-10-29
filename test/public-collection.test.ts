import test from 'node:test';
import assert from 'node:assert/strict';
import type {Event} from '../src/types.js';
import {collectReadyPublic,selectRecentOwnPosts,waitForPublicTimeline,type PublicPageSnapshot} from '../src/public-collection.js';
import {PublicRelations} from '../src/public-relations.js';
import {nativeRelation} from './public-relation-fixture.js';

const worker='fixture_worker';
const event=(id:string,handle='visitor',text='@fixture_worker 普通合成评论',extra:Partial<Event>={}):Event=>({id:'fixture:'+id,platformId:id,targetId:id,channel:'public',userId:'x:'+handle,handle,text,url:'https://x.com/'+handle+'/status/'+id,conversationId:id,timestamp:1793000000000,timestampReliable:true,...extra});
const reply=(id:string,parent:Event,handle='visitor')=>event(id,handle,'合成回复',{conversationId:parent.platformId!,replyToId:parent.platformId!,replyToHandle:parent.handle});
type Frame={events:Event[];loading?:boolean;empty?:PublicPageSnapshot['empty'];error?:PublicPageSnapshot['error'];mainPresent?:boolean;url?:string};
function fixture(frame:(path:string,elapsed:number,now:number)=>Frame,deadline=30000){
 let clock=0,url='',arrived=0,reads=0;const navigations:string[]=[];
 const current=()=>frame(url,clock-arrived,clock);
 const relations=new PublicRelations();
 const input={page:{} as any,handle:worker,deadline,relations,readTweets:async()=>{reads++;const events=current().events;relations.observe(events.map(e=>nativeRelation(e,e.conversationId,e.replyToId??null,e.replyToHandle)));return events;},inspect:async()=>{const f=current();return {url:f.url??url,mainPresent:f.mainPresent!==false,loading:f.loading??false,empty:f.empty??null,error:f.error??null};},now:()=>clock,sleep:async(ms:number)=>{clock+=ms;},navigate:async(_page:any,next:string)=>{url=next;arrived=clock;navigations.push(next);}};
 return {input,navigations,get clock(){return clock;},get reads(){return reads;},setUrl(value:string){url=value;arrived=clock;}};
}

test('main提前出现但文章稍后水合时有界等待，不把第一次空解析当成功',async()=>{
 const f=fixture((_path,elapsed)=>({events:elapsed<1200?[]:[event('101')],loading:elapsed<1200}));
 const result=await collectReadyPublic({...f.input,source:0});assert.equal(result.events.length,1);assert.equal(result.events[0].platformId,'101');assert.ok(f.clock>=1600);assert.ok(f.reads>2);assert.equal(result.diagnostics[0].status,'ok');assert.equal(result.warnings.length,0);assert.deepEqual(f.navigations,['https://x.com/notifications/mentions']);
});

test('DOM无spinner但原生列表请求未结束时不能用旧缓存提前判ready',async()=>{
 const f=fixture((_path,elapsed)=>({events:elapsed<1300?[event('109')]:[event('109'),event('110')]}));
 const result=await collectReadyPublic({...f.input,source:0,pendingRequests:()=>f.clock<1400?1:0});assert.deepEqual(result.events.map(e=>e.platformId),['109','110']);assert.ok(f.clock>=1800);assert.equal(result.diagnostics[0].status,'ok');
});

test('原生列表请求失败不能用仍显示的旧缓存冒充完整采集',async()=>{
 const f=fixture(()=>({events:[event('111')]}));const result=await collectReadyPublic({...f.input,source:0,failedRequests:()=>f.clock>=200?1:0});assert.equal(result.events.length,1);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-page-error');assert.equal(result.diagnostics[0].failedPages,1);
});

test('三源保持通知、搜索和自己帖子轮换，普通正文不触发空状态或关键词过滤',async()=>{
 for(const source of [0,1]){
  const f=fixture(()=>({events:[event('102','visitor','@fixture_worker 普通正文说 No results，并非页面空提示。'),event('103',worker,'自己的正常正文')]}));const result=await collectReadyPublic({...f.input,source});assert.deepEqual(result.events.map(e=>e.platformId),['102']);assert.equal(result.events[0].accountId,worker);assert.equal(result.diagnostics[0].source,source===0?'mentions':'search');assert.equal(result.diagnostics[0].status,'ok');assert.match(f.navigations[0],source===0?/notifications\/mentions/:/search\?q=%40fixture_worker&f=live/);
 }
});

test('自己的profile、主帖和晚到的评论逐页等待，第一篇未就绪不能漏掉回复',async()=>{
 const own1=event('201',worker,'自己的合成帖子一'),own2=event('202',worker,'自己的合成帖子二');
 const f=fixture((path,elapsed)=>path==='https://x.com/'+worker?{events:[own1,own2]}:path===own1.url?{events:elapsed<1300?[own1]:[own1,reply('301',own1)],loading:elapsed<1300}:{events:[own2,reply('302',own2,'other_visitor')]});
 const result=await collectReadyPublic({...f.input,source:2});assert.deepEqual(f.navigations,['https://x.com/'+worker,own1.url,own2.url]);assert.deepEqual(result.events.map(e=>e.platformId),['301','302']);assert.equal(result.diagnostics[0].status,'ok');assert.equal(result.diagnostics[0].readyPages,3);assert.ok(f.clock>=3300);
});

test('删除/不可用的一篇主帖会明确失败，但不吞掉另一篇主帖已读的新评论',async()=>{
 const first=event('203',worker),second=event('204',worker);
 const f=fixture(path=>path==='https://x.com/'+worker?{events:[first,second]}:path===first.url?{events:[],error:'target-unavailable'}:{events:[second,reply('303',second)]});
 const result=await collectReadyPublic({...f.input,source:2});assert.deepEqual(result.events.map(e=>e.platformId),['303']);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-target-unavailable');assert.equal(result.diagnostics[0].failedPages,1);assert.equal(f.navigations.length,3);
});

test('线程没有自己的精确目标文章时不把推荐/前一页面当作评论',async()=>{
 const own=event('205',worker);const f=fixture(path=>path==='https://x.com/'+worker?{events:[own]}:{events:[event('304')],loading:false});
 const result=await collectReadyPublic({...f.input,source:2});assert.equal(result.events.length,0);assert.equal(result.diagnostics[0].status,'failed');assert.equal(result.diagnostics[0].code,'public-target-missing');assert.ok(result.warnings.length>0);
});

test('真正的空列表必须有明确状态标志，main空白或未知DOM不能当empty',async()=>{
 const empty=fixture(()=>({events:[],empty:'timeline'}));const confirmed=await collectReadyPublic({...empty.input,source:0});assert.equal(confirmed.diagnostics[0].status,'empty');assert.equal(confirmed.diagnostics[0].code,'public-confirmed-empty');assert.equal(confirmed.warnings.length,0);
 const missing=fixture(()=>({events:[]}));const unavailable=await collectReadyPublic({...missing.input,source:0});assert.equal(unavailable.diagnostics[0].status,'failed');assert.equal(unavailable.diagnostics[0].code,'public-parser-unready');assert.ok(unavailable.warnings.length>0);
});

test('自己的帖无回复有明确空标志时可确认empty，不需伪造回复',async()=>{
 const own=event('206',worker),f=fixture(path=>path==='https://x.com/'+worker?{events:[own]}:{events:[own],empty:'replies'});
 const result=await collectReadyPublic({...f.input,source:2});assert.equal(result.events.length,0);assert.equal(result.diagnostics[0].status,'empty');assert.equal(result.diagnostics[0].emptyPages,1);assert.equal(result.warnings.length,0);
});

test('预算截断保留已看见目标后的可靠评论，不导航下一篇且不计为页面失败',async()=>{
 const own1=event('207',worker),own2=event('208',worker);const f=fixture(path=>path==='https://x.com/'+worker?{events:[own1,own2]}:{events:[own1,reply('305',own1)],loading:true},1700);
 const result=await collectReadyPublic({...f.input,source:2});assert.deepEqual(result.events.map(e=>e.platformId),['305']);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-budget-exhausted');assert.equal(result.diagnostics[0].failedPages,0);assert.equal(f.navigations.length,2);assert.ok(result.warnings.some(w=>w.includes('public-budget-exhausted')));
});

test('导航失败返回固定诊断，已有文章不因后续加载错误丢失，异常不含正文',async()=>{
 const f=fixture((_path,elapsed)=>({events:[event('306')],error:elapsed>=100?'page-error':null}));const result=await collectReadyPublic({...f.input,source:0});assert.equal(result.events.length,1);assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-page-error');
 const privateError='不得落入诊断的任意正文';const fail=fixture(()=>({events:[]}));fail.input.navigate=async()=>{throw Error(privateError);};const stopped=await collectReadyPublic({...fail.input,source:1});assert.equal(stopped.diagnostics[0].code,'public-navigation-failed');assert.ok(!JSON.stringify(stopped).includes(privateError));
});

test('身份受限必须透传给安全暂停，而不是降成普通空页面',async()=>{
 const f=fixture(()=>({events:[]})),error=Object.assign(new Error('不打印具体账号内容'),{restricted:'locked'});f.input.navigate=async()=>{throw error;};await assert.rejects(()=>collectReadyPublic({...f.input,source:0}),value=>value===error);
});

test('跳转到别的位置、无可靠时间/正文及冻结注入时钟均不能无界接受',async()=>{
 const wrong=fixture(()=>({events:[event('307')],url:'https://x.com/home'}));const changed=await collectReadyPublic({...wrong.input,source:0});assert.equal(changed.events.length,0);assert.equal(changed.diagnostics[0].code,'public-wrong-location');
 const bad=fixture(()=>({events:[event('308','visitor','尚未完整',{timestampReliable:false})]}));const unready=await collectReadyPublic({...bad.input,source:0});assert.equal(unready.events.length,0);assert.equal(unready.diagnostics[0].status,'failed');
 const frozen=fixture(()=>({events:[]}));frozen.setUrl('https://x.com/notifications/mentions');frozen.input.sleep=async()=>{};const bounded=await waitForPublicTimeline({...frozen.input,pageTimeoutMs:50,intervalMs:10},{url:'https://x.com/notifications/mentions',kind:'mentions'});assert.ok(bounded.reads<=8);assert.equal(bounded.state,'failed');
});

test('明确置顶跳过，无置顶时按可靠时间降序，时间不可靠始终排最后',()=>{
 const pinned=event('701',worker,'置顶旧帖',{timestamp:100}),old=event('702',worker,'较早帖子',{timestamp:200}),latest=event('703',worker,'最新帖子',{timestamp:400}),middle=event('704',worker,'次新帖子',{timestamp:300}),unreliable=event('705',worker,'时间未知',{timestamp:999999,timestampReliable:false});
 const selected=selectRecentOwnPosts([pinned,old,unreliable,latest,middle],worker,[{platformId:'701',state:'pinned'}]);assert.deepEqual(selected.posts.map(e=>e.platformId),['703','704']);assert.equal(selected.pinnedSkipped,1);assert.equal(selected.unknown,false);
 const unpinned=selectRecentOwnPosts([old,unreliable,middle,latest],worker,[]);assert.deepEqual(unpinned.posts.map(e=>e.platformId),['703','704']);assert.equal(unpinned.unknown,false);
 assert.deepEqual(selectRecentOwnPosts([unreliable,old],worker,[]).posts.map(e=>e.platformId),['702','705']);
});

test('未知socialContext提示并按DOM顺序降级，但已识别置顶仍然排除',async()=>{
 const pinned=event('706',worker,'明确置顶',{timestamp:50}),first=event('707',worker,'DOM顺序第一',{timestamp:100}),newer=event('708',worker,'时间更新',{timestamp:500}),middle=event('709',worker,'第三条',{timestamp:300});const posts=[pinned,first,newer,middle];
 const f=fixture(path=>path==='https://x.com/'+worker?{events:posts}:{events:[posts.find(post=>post.url===path)!,reply('8'+path.split('/').at(-1),posts.find(post=>post.url===path)!)]});
 const result=await collectReadyPublic({...f.input,source:2,readPinStates:async()=>[{platformId:'706',state:'pinned'},{platformId:'707',state:'unknown'}]});assert.deepEqual(f.navigations,['https://x.com/'+worker,first.url,newer.url]);assert.ok(result.warnings.some(text=>text.includes('置顶')));assert.equal(result.diagnostics[0].status,'partial');assert.equal(result.diagnostics[0].code,'public-pin-unrecognized');assert.equal(result.diagnostics[0].failedPages,0);
});

test('profile的可靠时间排序用于两条扫描，缺时间的own候选排最后仍可读取其可靠回复',async()=>{
 const first=event('710',worker,'时间未知',{timestamp:0,timestampReliable:false}),second=event('711',worker,'可靠的own帖',{timestamp:200});const posts=[first,second];
 const f=fixture(path=>path==='https://x.com/'+worker?{events:posts}:{events:[posts.find(post=>post.url===path)!,reply('8'+path.split('/').at(-1),posts.find(post=>post.url===path)!)]});
 const result=await collectReadyPublic({...f.input,source:2});assert.deepEqual(f.navigations,['https://x.com/'+worker,second.url,first.url]);assert.deepEqual(result.events.map(e=>e.platformId),['8711','8710']);assert.equal(result.diagnostics[0].status,'ok');
 const cached=event('712',worker,'上一次页面短暂残留的旧候选',{timestamp:999999});const hydrated=fixture((path,elapsed)=>path==='https://x.com/'+worker?{events:elapsed<200?[cached]:posts}:{events:[posts.find(post=>post.url===path)!,reply('9'+path.split('/').at(-1),posts.find(post=>post.url===path)!)]});await collectReadyPublic({...hydrated.input,source:2});assert.ok(!hydrated.navigations.includes(cached.url));assert.deepEqual(hydrated.navigations,['https://x.com/'+worker,second.url,first.url]);
});
