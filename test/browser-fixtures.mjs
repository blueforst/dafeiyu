import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readTweets,readDM } from '../dist/browser.js';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,chromiumSandbox:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.setContent('<main><article data-testid="tweet"><a href="/alice/status/123"><time datetime="2026-10-27T08:00:00Z"></time></a><div data-testid="tweetText">公开测试</div><div data-testid="tweetPhoto"></div></article></main>');
 const events=await readTweets(page);assert.equal(events.length,1);assert.equal(events[0].id,'x:123');assert.equal(events[0].mediaUnavailable,true);
 await page.setContent('<main style="width:900px"><div data-testid="messageEntry" data-direction="in" data-message-id="m1"><div data-testid="messageEntryContent">私信测试</div></div></main>');
 const dm=await readDM(page,'1-2');assert.equal(dm.events.length,1);assert.equal(dm.events[0].text,'私信测试');
 await page.setContent('<main><div data-testid="messageEntry" data-direction="out" data-message-id="m2"><div data-testid="messageEntryContent">自己的消息</div></div></main>');
 const own=await readDM(page,'1-2').catch(()=>({events:[]}));assert.equal(own.events.length,0);
 console.log(JSON.stringify({browserFixtureTests:3,passed:3,sandbox:true}));
}finally{await browser.close();}
