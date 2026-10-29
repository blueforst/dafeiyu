import type {Page,Locator} from 'playwright-core';

const editorSelector='[contenteditable="true"][role="textbox"],textarea';
const sendSelector='button[aria-label="Send"],button[title="Send"],button[data-testid*="-send-"],button[data-testid$="-send"]';
export type NativeComposer={state:'ready'|'unknown';editorTestId:string;sendTestId:string;editorCount:number;sendCount:number};
/** 接受确认核对同会话的唯一可编辑 composer；填入正文后才要求唯一发送控件。 */
export async function readNativeComposer(page:Page,conversationId:string):Promise<NativeComposer>{
 return page.locator('[data-testid="xchatEmbedRoute"]').evaluate((host,{conversationId,editorSelector,sendSelector})=>{
  const unknown:NativeComposer={state:'unknown',editorTestId:'',sendTestId:'',editorCount:0,sendCount:0};
  if(location.origin!=='https://x.com'||!['/i/chat/'+conversationId,'/i/chat/requests/'+conversationId,'/i/chat/requests/other/'+conversationId].includes(location.pathname))return unknown;
  const root=host.shadowRoot;if(!root)return unknown;
  const panels=root.querySelectorAll('[data-testid="dm-conversation-panel"]');if(panels.length!==1)return unknown;const panel=panels[0];
  if(Array.from(panel.querySelectorAll('[data-testid="dm-message-request-prompt"],[data-testid="dm-message-request-accept-button"],[aria-busy="true"]')).some(node=>!node.closest('[role="log"],[data-dm-message-row],[role="article"],article')))return unknown;
  const owned=(node:Element)=>!node.closest('[role="log"],[data-dm-message-row],[role="article"],article,[hidden],[aria-hidden="true"],header,[data-testid="dm-conversation-header"]')&&node.getClientRects().length>0;
  const editors=Array.from(panel.querySelectorAll(editorSelector)).filter(owned).filter(node=>node.getAttribute('aria-disabled')!=='true'&&!(node instanceof HTMLTextAreaElement&&(node.disabled||node.readOnly)));
  const buttons=Array.from(panel.querySelectorAll(sendSelector)).filter(owned);const counts={...unknown,editorCount:editors.length,sendCount:buttons.length};
  if(editors.length!==1||buttons.length>1)return counts;
  const editor=editors[0],editorTestId=editor.getAttribute('data-testid')??'';
  // 空 composer 显示语音入口，发送按钮会在输入后出现；接受确认只要求唯一可编辑输入。
  if(buttons.length===0){const text=editor instanceof HTMLTextAreaElement?editor.value:(editor as HTMLElement).innerText;if(text.trim()||editorTestId&&!/^[A-Za-z0-9_-]{1,120}$/.test(editorTestId))return counts;return {...counts,state:'ready',editorTestId};}
  // 共同所属容器必须在会话 panel 内，不能把无关的顶部按钮配给输入框。
  let owner=editors[0].parentElement,bound=false;for(let depth=0;owner&&owner!==panel&&depth<8;depth++,owner=owner.parentElement)if(owner.contains(buttons[0])){bound=true;break;}
  if(!bound)return counts;
  const sendTestId=buttons[0].getAttribute('data-testid')??'';
  if([editorTestId,sendTestId].some(id=>id&&!/^[A-Za-z0-9_-]{1,120}$/.test(id)))return counts;
  return {...counts,state:'ready',editorTestId,sendTestId};
 },{conversationId,editorSelector,sendSelector});
}
export async function nativeComposerLocators(page:Page,conversationId:string,options:{requireSubmit?:boolean}={}):Promise<{input:Locator;submit:Locator;proof:NativeComposer}>{
 const proof=await readNativeComposer(page,conversationId);if(proof.state!=='ready')throw Error('新 Chat 输入框或发送控件尚未可靠绑定');
 const panel=page.locator('[data-testid="xchatEmbedRoute"] [data-testid="dm-conversation-panel"]');
 const eligible=':not([role="log"] *,[data-dm-message-row] *,[role="article"] *,article *,[hidden] *,[aria-hidden="true"] *,header *,[data-testid="dm-conversation-header"] *)';
 const input=proof.editorTestId?panel.locator('[data-testid="'+proof.editorTestId+'"]'):panel.locator('[contenteditable="true"][role="textbox"]'+eligible+',textarea'+eligible).filter({visible:true});
 const submit=proof.sendTestId?panel.locator('[data-testid="'+proof.sendTestId+'"]'):panel.locator(sendSelector.split(',').map(selector=>selector+eligible).join(',')).filter({visible:true});
 if(await input.count()!==1||!await input.isVisible()||options.requireSubmit!==false&&(await submit.count()!==1||!await submit.isVisible()))throw Error('新 Chat 编辑器结构已变化');
 return {input,submit,proof};
}

