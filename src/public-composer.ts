import type {Page} from 'playwright-core';
import {BrowserOperationError} from './browser-operation.js';

export type PublicPostComposerSnapshot={locationValid:boolean;modalCount:number;inputCount:number;submitCount:number;editable:boolean;submitEnabled:boolean;busy:boolean;text:string};
type ComposerOptions={requireSubmit?:boolean;expectedText?:string};

/** 只认独立发帖路由上的活动 modal，背景 Home 编辑器不能充当目标。 */
export async function readPublicPostComposer(page:Page):Promise<PublicPostComposerSnapshot>{
 return page.evaluate(()=>{
  const locationValid=location.origin==='https://x.com'&&location.pathname==='/compose/post'&&!location.search&&!location.hash;
  const visible=(node:Element)=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!node.closest('[hidden],[inert],[aria-hidden="true"]');};
  const modals=Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).filter(visible),modal=modals.length===1?modals[0]:null;
  const inputs=modal?Array.from(modal.querySelectorAll('[data-testid="tweetTextarea_0"]')):[],buttons=modal?Array.from(modal.querySelectorAll('[data-testid="tweetButton"]')):[];
  const input=inputs.length===1?inputs[0]:null,button=buttons.length===1?buttons[0]:null;
  const owned=(node:Element)=>node.closest('[role="dialog"][aria-modal="true"]')===modal&&!node.closest('article,[role="article"],[data-testid="quoteTweet"]');
  const editable=!!input&&owned(input)&&visible(input)&&input.getAttribute('role')==='textbox'&&input.getAttribute('contenteditable')==='true'&&input.getAttribute('aria-disabled')!=='true';
  const submitEnabled=!!button&&owned(button)&&visible(button)&&button instanceof HTMLButtonElement&&!button.disabled&&button.getAttribute('aria-disabled')!=='true';
  // 平台 modal 内还存在常驻进度条；不以任意 progressbar 推断仍在水合。
  const busy=!!modal&&(modal.getAttribute('aria-busy')==='true'||Array.from(modal.querySelectorAll('[aria-busy="true"]')).some(node=>owned(node)&&visible(node)));
  return {locationValid,modalCount:modals.length,inputCount:inputs.length,submitCount:buttons.length,editable,submitEnabled,busy,text:editable?(input as HTMLElement).innerText.replace(/\r\n/g,'\n'):''};
 });
}

function ready(snapshot:PublicPostComposerSnapshot,options:ComposerOptions){
 return snapshot.locationValid&&snapshot.modalCount===1&&snapshot.inputCount===1&&snapshot.submitCount===1&&snapshot.editable&&!snapshot.busy&&(!options.requireSubmit||snapshot.submitEnabled)&&(options.expectedText===undefined||snapshot.text.trim().normalize('NFC')===options.expectedText.trim().replace(/\r\n/g,'\n').normalize('NFC'));
}

/** 调用方在 intent 保存前再次读取；不在页面上写入定位标记。 */
export async function publicPostComposerLocators(page:Page,options:ComposerOptions={}){
 const proof=await readPublicPostComposer(page);
 if(!ready(proof,options))throw new BrowserOperationError('editor-unavailable',options.requireSubmit?'editor-validate':'post-open');
 const scope=page.locator('[role="dialog"][aria-modal="true"]:visible');
 if(await scope.count()!==1)throw new BrowserOperationError('editor-unavailable',options.requireSubmit?'editor-validate':'post-open');
 const input=scope.getByTestId('tweetTextarea_0'),submit=scope.getByTestId('tweetButton');
 if(await input.count()!==1||await submit.count()!==1||!await input.isEditable()||options.requireSubmit&&!await submit.isEnabled())throw new BrowserOperationError('editor-unavailable',options.requireSubmit?'editor-validate':'post-open');
 return {scope,input,submit,proof};
}

/** 等待实际 modal 水合，填字前允许提交按钮禁用，填字后等待启用。 */
export async function waitForPublicPostComposer(page:Page,options:ComposerOptions&{timeoutMs?:number;intervalMs?:number;stableMs?:number}={}){
 const timeout=Math.max(1,Math.min(20000,options.timeoutMs??12000)),until=Date.now()+timeout,interval=Math.max(1,Math.min(250,options.intervalMs??100)),stableMs=Math.max(0,Math.min(1000,options.stableMs??150));
 let signature='',stableAt=Date.now();
 while(Date.now()<=until){
  const snapshot=await readPublicPostComposer(page),next=JSON.stringify(snapshot);
  if(next!==signature){signature=next;stableAt=Date.now();}
  if(ready(snapshot,options)&&Date.now()-stableAt>=stableMs)return publicPostComposerLocators(page,options);
  if(Date.now()>=until)break;
  await page.waitForTimeout(Math.min(interval,until-Date.now()));
 }
 throw new BrowserOperationError('editor-unavailable',options.requireSubmit?'editor-validate':'post-open');
}
