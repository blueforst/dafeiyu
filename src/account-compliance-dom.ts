import type {Page} from 'playwright-core';

export type ComplianceProfileSnapshot={url:string;mainCount:number;nameCount:number;handles:string[];ownEditLinks:number;detailsComplete:boolean;loading:boolean;failed:boolean;name:string;bio:string;bioCount:number;automatedLabels:number;automatedLabelConflict:boolean};
export type ComplianceProfileReading={reliable:boolean;name:string;bio:string;automatedLabel:boolean|null};
export type ComplianceQualitySnapshot={url:string;mainCount:number;loading:boolean;failed:boolean;matches:Array<{associationValid:boolean;nativeChecked:boolean|null;ariaChecked:string|null}>};
export type ComplianceFiltersSnapshot={url:string;mainCount:number;loading:boolean;failed:boolean;links:string[]};

function ownPath(url:string,path:string){try{const value=new URL(url);return value.origin==='https://x.com'&&!value.username&&!value.password&&value.pathname.replace(/\/$/,'').toLowerCase()===path.toLowerCase()&&!value.search&&!value.hash;}catch{return false;}}
const unknownProfile=():ComplianceProfileReading=>({reliable:false,name:'',bio:'',automatedLabel:null});

/** 资料证据必须共同属于当前目标账号；未知结构不能被当成空简介或缺标签。 */
export function inspectComplianceProfileSnapshot(snapshot:ComplianceProfileSnapshot,expectedHandle:string):ComplianceProfileReading{
 const handle=expectedHandle.replace(/^@/,'').toLowerCase();
 if(!/^[a-z0-9_]{1,15}$/.test(handle)||!ownPath(snapshot.url,'/'+handle)||snapshot.mainCount!==1||snapshot.nameCount!==1||snapshot.handles.length!==1||snapshot.handles[0].toLowerCase()!==handle||snapshot.ownEditLinks!==1||!snapshot.detailsComplete||snapshot.loading||snapshot.failed||!snapshot.name.trim()||snapshot.bioCount>1)return unknownProfile();
 return {reliable:true,name:snapshot.name,bio:snapshot.bio,automatedLabel:snapshot.automatedLabelConflict||![0,1].includes(snapshot.automatedLabels)?null:snapshot.automatedLabels===1};
}

/** 只读唯一、明确关联的质量过滤控件；原生与ARIA冲突时继续未知。 */
export function inspectComplianceQualitySnapshot(snapshot:ComplianceQualitySnapshot):boolean|null{
 if(!ownPath(snapshot.url,'/settings/notifications/filters')&&!ownPath(snapshot.url,'/settings/notifications'))return null;
 if(snapshot.mainCount!==1||snapshot.loading||snapshot.failed||snapshot.matches.length!==1)return null;
 const control=snapshot.matches[0];if(!control.associationValid)return null;
 const aria=control.ariaChecked==='true'?true:control.ariaChecked==='false'?false:null;
 if(control.ariaChecked!==null&&aria===null)return null;
 if(control.nativeChecked!==null&&aria!==null&&control.nativeChecked!==aria)return null;
 return control.nativeChecked??aria;
}

export function inspectComplianceFiltersSnapshot(snapshot:ComplianceFiltersSnapshot):string|null{
 if(!ownPath(snapshot.url,'/settings/notifications')||snapshot.mainCount!==1||snapshot.loading||snapshot.failed||snapshot.links.length!==1)return null;
 const link=snapshot.links[0];return /^\/settings\/notifications\/[a-z0-9_/-]+$/i.test(link)?link:null;
}

export type ComplianceWaitOptions={timeoutMs?:number;stableMs?:number;intervalMs?:number;now?:()=>number;sleep?:(milliseconds:number)=>Promise<void>};
/** 连续结构稳定才采信，次数与墙钟均有上限，注入时钟异常也不会无限读取。 */
export async function waitForStableComplianceSnapshot<T>(options:ComplianceWaitOptions&{read:()=>Promise<T>;ready:(snapshot:T)=>boolean;signature?:(snapshot:T)=>string}):Promise<{snapshot:T|null;stable:boolean;reads:number}>{
 const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
 const timeout=bounded(options.timeoutMs,10000,1,15000),interval=bounded(options.intervalMs,100,1,1000),stableMs=bounded(options.stableMs,400,0,2000),now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const start=now(),wallStart=Date.now(),limit=Math.ceil(timeout/interval)+3;let last:T|null=null,previous='',unchangedAt=start,reads=0;
 while(reads<limit&&Date.now()-wallStart<=timeout+interval){
  if(reads&&now()-start>=timeout)break;
  last=await options.read();reads++;const at=now(),signature=(options.signature??JSON.stringify)(last);
  if(signature!==previous){previous=signature;unchangedAt=at;}
  if(options.ready(last)&&reads>=2&&at-unchangedAt>=stableMs)return {snapshot:last,stable:true,reads};
  if(at-start>=timeout)break;await sleep(Math.max(1,Math.min(interval,timeout-(at-start))));
 }
 return {snapshot:last,stable:false,reads};
}

/** evaluate函数自包含，只读取可见原生DOM，不调用平台接口或点击任何元素。 */
export async function readComplianceProfileSnapshot(page:Page):Promise<ComplianceProfileSnapshot>{
 return page.evaluate(()=>{
  const visible=(node:Element)=>{if(node.closest('[hidden],[aria-hidden="true"]'))return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&!!node.getClientRects().length;};
  const excluded='article,[data-testid="tweet"],[data-testid="UserCell"],[data-testid="HoverCard"],[role="dialog"],[data-testid="UserDescription"],[data-testid="UserProfileHeader_Items"]';
  const mains=Array.from(document.querySelectorAll('main')).filter(visible),main=mains.length===1?mains[0]:null;
  const primary=main?Array.from(main.querySelectorAll('[data-testid="primaryColumn"]')).filter(visible):[];
  const scope=primary.length===1?primary[0]:primary.length?null:main;
  const owned=(node:Element)=>visible(node)&&!node.closest('article,[data-testid="tweet"],[data-testid="UserCell"],[data-testid="HoverCard"],[role="dialog"]');
  const names=scope?Array.from(scope.querySelectorAll('[data-testid="UserName"]')).filter(owned):[],name=names.length===1?names[0]:null;
  const content=(node:Element|null)=>(node as HTMLElement|null)?.innerText?.trim()??node?.textContent?.trim()??'';
  const handles=name?Array.from(new Set((content(name).match(/(?:^|\s)@([a-zA-Z0-9_]{1,15})(?=\s|$)/g)??[]).map(value=>value.trim().slice(1).toLowerCase()))):[];
  const handle=handles.length===1?handles[0]:'';
  const edit=scope?Array.from(scope.querySelectorAll('a[href="/settings/profile"]')).filter(owned):[];
  const bios=scope?Array.from(scope.querySelectorAll('[data-testid="UserDescription"]')).filter(owned):[];
  const profileLinks=scope?Array.from(scope.querySelectorAll('a[href]')).filter(owned).map(node=>node.getAttribute('href')??''):[];
  const following=profileLinks.filter(href=>href.toLowerCase()==='/'+handle+'/following').length;
  const followers=profileLinks.filter(href=>['/'+handle+'/followers','/'+handle+'/verified_followers'].includes(href.toLowerCase())).length;
  // “自动化”字样必须位于资料专用标签，或在去除可编辑资料和时间线后的平台行中且链接指向该标注的管理账号。
  const labelCandidates=scope?Array.from(scope.querySelectorAll('[data-testid="UserLabel"],[data-testid="UserAutomatedLabel"],a[href]')).filter(node=>owned(node)&&!node.closest(excluded)&&node!==name&&!name?.contains(node)):[];
  const labelRoots=new Set<Element>();let labelConflict=false;
  for(const candidate of labelCandidates){
   const dedicated=candidate.matches('[data-testid="UserLabel"],[data-testid="UserAutomatedLabel"]');
   const root=dedicated?candidate:candidate.parentElement;if(!root||root===scope||!owned(root)||root.closest(excluded)||name?.contains(root))continue;
   const text=content(root).replace(/\s+/g,' ').trim(),match=/^(?:Automated by\s+@([a-zA-Z0-9_]{1,15})|由\s*@([a-zA-Z0-9_]{1,15})\s*自动(?:化)?(?:管理)?)\s*[?？]?$/i.exec(text);
   if(!match){if(dedicated&&/automated|自动/i.test(text))labelConflict=true;continue;}
   const owner=(match[1]??match[2]).toLowerCase(),links=Array.from(root.querySelectorAll('a[href]')).filter(owned);
   if(root.matches('a[href]'))links.unshift(root);
   if(links.some(link=>(link.getAttribute('href')??'').toLowerCase()==='/'+owner))labelRoots.add(root);else labelConflict=true;
  }
  // 嵌套专用节点与其链接父节点代表同一个标签。
  const labels=Array.from(labelRoots).filter(node=>!Array.from(labelRoots).some(other=>other!==node&&other.contains(node)));
  const states=scope?Array.from(scope.querySelectorAll('[role="alert"],[data-testid="error-detail"]')).filter(owned):[];
  const progress=scope?Array.from(scope.querySelectorAll('[role="progressbar"],[data-testid="spinner"],[data-testid="loading"],[aria-busy="true"]')).filter(owned):[];
  const nameText=content(name).split(/\r?\n/).map(value=>value.trim()).filter(value=>value&&!/^@[a-zA-Z0-9_]{1,15}$/.test(value)).join('\n');
  return {url:location.href,mainCount:mains.length,nameCount:names.length,handles,ownEditLinks:edit.length,detailsComplete:following===1&&followers===1,loading:!!scope&&(scope.getAttribute('aria-busy')==='true'||progress.some(node=>!node.closest('[data-testid="cellInnerDiv"]'))),failed:!scope||states.some(node=>/something went wrong|try reloading|could(?:n.t| not) (?:load|retrieve)|unable to load|发生错误|出了点问题|加载失败|重新加载/i.test(content(node))),name:nameText,bio:bios.length===1?content(bios[0]):'',bioCount:bios.length,automatedLabels:labels.length,automatedLabelConflict:labelConflict||labels.length>1};
 });
}

export async function readComplianceFiltersSnapshot(page:Page):Promise<ComplianceFiltersSnapshot>{
 return page.evaluate(()=>{
  const visible=(node:Element)=>{if(node.closest('[hidden],[aria-hidden="true"]'))return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&!!node.getClientRects().length;};
  const mains=Array.from(document.querySelectorAll('main')).filter(visible),main=mains.length===1?mains[0]:null;
  const nodes=main?Array.from(main.querySelectorAll('a[href]')).filter(node=>visible(node)&&!node.closest('article,[role="dialog"]')):[];
  const links=nodes.filter(node=>/^(?:Filters|过滤|筛选)$/i.test((node.textContent??'').trim())).map(node=>node.getAttribute('href')??'');
  const loading=!!main&&(main.getAttribute('aria-busy')==='true'||Array.from(main.querySelectorAll('[role="progressbar"],[aria-busy="true"]')).some(visible));
  const failed=!!main&&Array.from(main.querySelectorAll('[role="alert"],[data-testid="error-detail"]')).filter(visible).some(node=>/something went wrong|try reloading|unable to load|发生错误|加载失败|重新加载/i.test(node.textContent??''));
  return {url:location.href,mainCount:mains.length,loading,failed,links};
 });
}

export async function readComplianceQualitySnapshot(page:Page):Promise<ComplianceQualitySnapshot>{
 return page.evaluate(()=>{
  const visible=(node:Element)=>{if(node.closest('[hidden],[aria-hidden="true"]'))return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&!!node.getClientRects().length;};
  const mains=Array.from(document.querySelectorAll('main')).filter(visible),main=mains.length===1?mains[0]:null;
  const controlSelector='[role="switch"],[role="checkbox"],input[type="checkbox"]',title=/^(?:Quality filter|质量过滤|优质内容过滤|质量筛选|品质筛选)$/i;
  const text=(node:Element)=>(node.textContent??'').replace(/\s+/g,' ').trim();
  const all=main?Array.from(main.querySelectorAll(controlSelector)).filter(node=>visible(node)&&!node.closest('article,[role="dialog"]')):[];
  const matches:ComplianceQualitySnapshot['matches']=[];
  for(const node of all){
   const explicit:string[]=[];let invalid=false;
   const ariaLabel=node.getAttribute('aria-label');if(ariaLabel)explicit.push(ariaLabel.trim());
   const references=(node.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);if(new Set(references).size!==references.length)invalid=true;
   for(const id of references){const targets=Array.from(document.querySelectorAll('[id]')).filter(target=>target.id===id);if(targets.length!==1||!main?.contains(targets[0])||!visible(targets[0])){invalid=true;continue;}explicit.push(text(targets[0]));}
   const id=node.getAttribute('id'),labels=id?Array.from(document.querySelectorAll('label[for]')).filter(label=>label.getAttribute('for')===id&&main?.contains(label)&&visible(label)):[];
   if(labels.length&&(labels.length!==1||Array.from(document.querySelectorAll('[id]')).filter(target=>target.id===id).length!==1))invalid=true;
   explicit.push(...labels.map(text));const wrapping=node.closest('label');if(wrapping&&main?.contains(wrapping)&&visible(wrapping))explicit.push(text(wrapping));
   let found=explicit.some(value=>title.test(value)),associationValid=found&&!invalid;
   // 原生div设置行通常没有label；只接受最近的、恰好包含一个可见控件与一个确切标题的有界祖先。
   if(!found){let parent=node.parentElement;for(let depth=0;parent&&parent!==main&&depth<5;depth++,parent=parent.parentElement){
    const controls=Array.from(parent.querySelectorAll(controlSelector)).filter(visible);
    const titles=Array.from(parent.querySelectorAll('span,div,label')).filter(candidate=>visible(candidate)&&title.test(text(candidate))&&!Array.from(candidate.children).some(child=>title.test(text(child))));
    if(!titles.length)continue;
    let controlBranch:Element=node;while(controlBranch.parentElement&&controlBranch.parentElement!==parent)controlBranch=controlBranch.parentElement;
    const walker=document.createTreeWalker(controlBranch,NodeFilter.SHOW_TEXT);let extraControlText=false;while(walker.nextNode()){const textNode=walker.currentNode,parentNode=textNode.parentElement;if(textNode.textContent?.trim()&&parentNode&&visible(parentNode)&&!parentNode.closest(controlSelector)){extraControlText=true;break;}}
    found=true;associationValid=!invalid&&!extraControlText&&controls.length===1&&controls[0]===node&&titles.length===1;break;
   }}
   if(found)matches.push({associationValid,nativeChecked:node instanceof HTMLInputElement?node.checked:null,ariaChecked:node.getAttribute('aria-checked')});
  }
  const loading=!!main&&(main.getAttribute('aria-busy')==='true'||Array.from(main.querySelectorAll('[role="progressbar"],[aria-busy="true"]')).some(visible));
  const failed=!!main&&Array.from(main.querySelectorAll('[role="alert"],[data-testid="error-detail"]')).filter(visible).some(node=>/something went wrong|try reloading|unable to load|发生错误|加载失败|重新加载/i.test(node.textContent??''));
  return {url:location.href,mainCount:mains.length,loading,failed,matches};
 });
}

export async function readReadyComplianceProfile(page:Page,handle:string,options:ComplianceWaitOptions={}):Promise<ComplianceProfileReading>{
 const result=await waitForStableComplianceSnapshot({...options,read:()=>readComplianceProfileSnapshot(page),ready:snapshot=>inspectComplianceProfileSnapshot(snapshot,handle).reliable});
 return result.stable&&result.snapshot?inspectComplianceProfileSnapshot(result.snapshot,handle):unknownProfile();
}
export async function readReadyComplianceFilters(page:Page,options:ComplianceWaitOptions={}):Promise<string|null>{
 const result=await waitForStableComplianceSnapshot({...options,read:()=>readComplianceFiltersSnapshot(page),ready:snapshot=>inspectComplianceFiltersSnapshot(snapshot)!==null});
 return result.stable&&result.snapshot?inspectComplianceFiltersSnapshot(result.snapshot):null;
}
export async function readReadyComplianceQuality(page:Page,options:ComplianceWaitOptions={}):Promise<boolean|null>{
 const result=await waitForStableComplianceSnapshot({...options,read:()=>readComplianceQualitySnapshot(page),ready:snapshot=>inspectComplianceQualitySnapshot(snapshot)!==null});
 return result.stable&&result.snapshot?inspectComplianceQualitySnapshot(result.snapshot):null;
}
