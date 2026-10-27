// 仅在服务器隔离 Camoufox 环境执行，不访问实际平台或挂载真实 profile。
import assert from 'node:assert/strict';
import { observer } from '/opt/role-camoufox/launch.mjs';
import { readTweets,readDM,replyArticleIndex } from '../dist/browser.js';
const browser=await observer();let passed=0;
try {
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.setContent('<main><article data-testid="tweet"><div role="link" data-testid="quoteTweet"><a href="/quoted/status/999"><time datetime="2026-10-27T08:00:00Z"></time></a><div data-testid="tweetText">引用内容</div></div><a href="/alice/status/123"><time datetime="2026-10-27T08:00:00Z"></time></a><div data-testid="tweetText">主帖正文</div></article></main>');
 const tweets=await readTweets(page);assert.equal(tweets.length,1);assert.equal(tweets[0].platformId,'123');assert.equal(tweets[0].text,'主帖正文');passed++;
 assert.equal(await replyArticleIndex(page,'123'),0);await assert.rejects(replyArticleIndex(page,'999'),/主帖/);passed++;
 await page.setContent('<main><article data-testid="tweet"><a href="/alice/status/123"><time></time></a><div data-testid="tweetText">缺少时间</div></article></main>');
 const untimed=(await readTweets(page))[0];assert.equal(untimed.timestamp,0);assert.equal(untimed.timestampReliable,false);passed++;
 await page.setContent('<main><div data-testid="messageEntry" data-direction="in" data-message-id="m1"><time datetime="2026-10-27T08:00:00Z"></time><div data-testid="messageEntryContent">入站消息</div></div></main>');
 const incoming=(await readDM(page,'1-2')).events[0];assert.equal(incoming.platformId,'m1');assert.equal(incoming.timestampReliable,true);passed++;
 await page.setContent('<main><div data-testid="messageEntry" data-direction="out" data-message-id="m2"><div data-testid="messageEntryContent">自己的消息</div></div></main>');
 assert.equal((await readDM(page,'1-2')).events.length,0);passed++;
 await page.setContent('<main><div data-testid="messageEntry" data-direction="in"><div data-testid="messageEntryContent">没有平台 ID</div></div></main>');
 await assert.rejects(readDM(page,'1-2'),/平台消息 ID/);passed++;
 await page.setContent('<main><div data-testid="messageEntry" data-message-id="m3"><div data-testid="messageEntryContent">无法确认方向</div></div></main>');
 await assert.rejects(readDM(page,'1-2'),/方向/);passed++;
 console.log(JSON.stringify({transportDOMChecks:passed,passed,engine:'camoufox',evidence:'isolated-fixture'}));
}finally {await browser.close();}
