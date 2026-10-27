// 在服务器执行：docker compose exec -T browser node --input-type=module < test/proxy-acceptance.mjs
import {chromium} from 'playwright-core';
import {browserProxy} from '/app/dist/browser.js';
import assert from 'node:assert/strict';
const result={};let browser;
try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,chromiumSandbox:true,proxy:browserProxy(process.env.BROWSER_PROXY_SERVER)});
 const page=await browser.newPage();await page.goto('https://api.ipify.org/?format=json',{timeout:25000,waitUntil:'domcontentloaded'});
 const data=JSON.parse(await page.locator('body').innerText());assert.notEqual(data.ip,process.env.DIRECT_EGRESS_IP||'43.133.80.237');result.browserExitIP=data.ip;result.proxyBrowserPassed=true;
}finally{await browser?.close();}
try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,chromiumSandbox:true,proxy:browserProxy('http://127.0.0.1:9')});
 const page=await browser.newPage();let message='';try{await page.goto('https://api.ipify.org/?format=json',{timeout:10000,waitUntil:'domcontentloaded'});}catch(e){message=e.message;}
 assert.match(message,/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/);result.unavailableProxyBlocksRequest=true;
}finally{await browser?.close();}
console.log(JSON.stringify(result));
