import type {Locator,Page} from 'playwright-core';
import {BrowserOperationError} from './browser-operation.js';

export type PublicPostComposerSnapshot={locationValid:boolean;modalCount:number;inputCount:number;submitCount:number;editable:boolean;submitEnabled:boolean;busy:boolean;text:string};
type ComposerOptions={requireSubmit?:boolean;expectedText?:string};
const normalizedText=(text:string)=>text.trim().replace(/\r\n/g,'\n').normalize('NFC');

export async function assertPublicComposerText(input:Locator,text:string,stage:'post-fill'|'reply-fill'|'editor-validate'='editor-validate'){
 if(await input.count()!==1||!await input.isVisible()||!await input.isEditable()||normalizedText(await input.innerText())!==normalizedText(text))throw new BrowserOperationError('editor-unavailable',stage);
}

/** 回复按钮可能晚于正文进入可用状态；等待中正文和作用域不能改变。 */
export async function waitForPublicComposerSubmit(page:Page,input:Locator,submit:Locator,text:string,options:{timeoutMs?:number;intervalMs?:number;stableMs?:number}={}){
 const until=Date.now()+Math.max(1,Math.min(10000,options.timeoutMs??3000)),interval=Math.max(1,Math.min(250,options.intervalMs??50)),stableMs=Math.max(0,Math.min(500,options.stableMs??100));let enabledAt:number|null=null;
 while(true){
  await assertPublicComposerText(input,text);
  const count=await submit.count();if(count>1)throw new BrowserOperationError('editor-unavailable','editor-validate');
  if(count===1&&await submit.isVisible()&&await submit.isEnabled()){if(enabledAt===null)enabledAt=Date.now();if(Date.now()-enabledAt>=stableMs)return;}else enabledAt=null;
  if(Date.now()>=until)throw new BrowserOperationError('editor-unavailable','editor-validate');
  await page.waitForTimeout(Math.max(1,Math.min(interval,until-Date.now())));
 }
}

/** 只设置浏览器选区，正文由可信键盘输入；不改DOM正文、React状态或派发合成事件。 */
export async function enterPublicComposerText(page:Page,input:Locator,text:string,stage:'post-fill'|'reply-fill'='reply-fill'){
 const until=Date.now()+10000;
 while(true){const count=await input.count();if(count>1)throw new BrowserOperationError('editor-unavailable',stage);if(count===1&&await input.isVisible()&&await input.isEditable())break;if(Date.now()>=until)throw new BrowserOperationError('editor-unavailable',stage);await page.waitForTimeout(50);}
 await input.evaluate(node=>{
  if(!node.closest('[role="dialog"]')||node.getAttribute('role')!=='textbox'||node.getAttribute('contenteditable')!=='true')throw new Error('公开编辑器归属不符');
  (node as HTMLElement).focus();const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();if(!selection)throw new Error('浏览器选区不可用');selection.removeAllRanges();selection.addRange(range);
 });
 await page.keyboard.press('Backspace');
 const waitForText=async(value:string)=>{const until=Date.now()+3000;while(Date.now()<until){if(normalizedText(await input.innerText())===normalizedText(value))return;await page.waitForTimeout(50);}throw new BrowserOperationError('editor-unavailable',stage);};
 await waitForText('');
 if(text){
  await input.evaluate(node=>{
   const contents=node.querySelectorAll('[data-contents="true"]');if(contents.length>1)throw new Error('公开编辑器正文容器不唯一');
   let caret:Element=node;
   if(contents.length===1){const leaves=contents[0].querySelectorAll('[data-text="true"]');if(leaves.length!==1)throw new Error('公开编辑器空正文叶子不唯一');caret=leaves[0].tagName==='BR'?leaves[0].parentElement!:leaves[0];}
   (node as HTMLElement).focus();const range=document.createRange();range.selectNodeContents(caret);range.collapse(true);const selection=getSelection();if(!selection)throw new Error('浏览器选区不可用');selection.removeAllRanges();selection.addRange(range);
  });
  await page.keyboard.insertText(text);
  await waitForText(text);
 }
 await assertPublicComposerText(input,text,stage);
}

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
 return snapshot.locationValid&&snapshot.modalCount===1&&snapshot.inputCount===1&&snapshot.submitCount===1&&snapshot.editable&&!snapshot.busy&&(!options.requireSubmit||snapshot.submitEnabled)&&(options.expectedText===undefined||normalizedText(snapshot.text)===normalizedText(options.expectedText));
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
