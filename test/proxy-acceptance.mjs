// 在服务器执行：docker compose exec -T browser node --input-type=module < test/proxy-acceptance.mjs
import {observer} from '/opt/role-camoufox/launch.mjs';
import {browserProxy} from '/app/dist/browser.js';
import assert from 'node:assert/strict';
const result={};let browser;
try{
 browser=await observer(browserProxy(process.env.BROWSER_PROXY_SERVER));
 const page=await browser.newPage();await page.goto('https://api.ipify.org/?format=json',{timeout:25000,waitUntil:'domcontentloaded'});
 const data=JSON.parse(await page.locator('body').innerText());assert.notEqual(data.ip,process.env.DIRECT_EGRESS_IP||'43.133.80.237');result.browserExitIP=data.ip;result.proxyBrowserPassed=true;
}finally{await browser?.close();}
try{
 browser=await observer(browserProxy('http://127.0.0.1:9'));
 const page=await browser.newPage();let message='';try{await page.goto('https://api.ipify.org/?format=json',{timeout:10000,waitUntil:'domcontentloaded'});}catch(e){message=e.message;}
 assert.match(message,/NS_ERROR_PROXY_CONNECTION_REFUSED|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_UNKNOWN_PROXY_HOST/);result.unavailableProxyBlocksRequest=true;
}finally{await browser?.close();}
console.log(JSON.stringify(result));
