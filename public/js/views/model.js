import {h,set,fmtDateTime} from '../dom.js';
import {api} from '../api.js';
import {notice,refreshStatus} from '../state.js';
import {field,empty,editorGuard,errorBox,billingBadge,rowActions,fmtUsdText} from '../view-utils.js';
import {CUSTOM_APIS,fmtTokens} from './model-form.js';

const endpoint=k=>'/api/model/library/'+encodeURIComponent(k);
const NS='http://www.w3.org/2000/svg';
function svgEl(tag,attrs={},...children){
 const el=document.createElementNS(NS,tag);
 for(const [k,v]of Object.entries(attrs))if(v!=null)el.setAttribute(k,String(v));
 for(const child of children)if(child!=null)el.append(child instanceof Node?child:String(child));
 return el;
}
function iconReasoning(){
 return svgEl('svg',{viewBox:'0 0 24 24',class:'model-cap-icon','aria-label':'支持推理'},
  svgEl('title',{},'支持推理'),
  svgEl('path',{d:'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3z'})
 );
}
function iconVision(){
 return svgEl('svg',{viewBox:'0 0 24 24',class:'model-cap-icon','aria-label':'支持看图'},
  svgEl('title',{},'支持看图'),
  svgEl('path',{d:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z'}),
  svgEl('circle',{cx:12,cy:12,r:3})
 );
}

// 更换目标 origin 时不能把已输入的明文 Key 带到另一服务端。
const keyOrigin=value=>{
 try{
  const url=new URL(value);
  return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.origin:null;
 }catch{
  return null;
 }
};

function fmtModelPriceRate(v){
 if(v==null||!Number.isFinite(Number(v)))return '—';
 const n=Number(v);
 if(n===0)return '$0';
 if(n>=1)return '$'+n.toFixed(2);
 return fmtUsdText(n).text;
}

export function mount(root,ctx={}){
 let alive=true,library=null,catalog=[],selected='',busy=false,showCount=60,modelEditDirty=()=>false,dragModelId=null;
 const providerList=h('div',{class:'stack provider-list'});
 const addBtn=h('button',{id:'provider-add',type:'button',class:'btn small provider-add-btn',onclick:()=>addDialog()},'＋ 添加服务商');
 const sidebar=h('aside',{class:'provider-sidebar settings-secondary-list stack'},
  h('div',{class:'settings-nav-label'},'已添加的服务商'),
  providerList,
  addBtn
 );
 const mobile=h('select',{
  class:'input provider-mobile',
  'aria-label':'已添加服务商',
  onchange:()=>choose(mobile.value)
 });
 const mobileEditBtn=h('button',{
  class:'btn small provider-mobile-edit',
  type:'button',
  'aria-label':'编辑服务商',
  onclick:()=>{const p=current();if(p)editProviderDialog(p);}
 },'✎ 编辑');
 const mobileAddBtn=h('button',{
  class:'btn small provider-mobile-add',
  type:'button',
  onclick:()=>addDialog()
 },'＋ 添加');
 const right=h('div',{class:'provider-detail stack min-zero'});
 const error=h('div',{role:'alert'});
 const dialogRoot=h('div');
 const layout=h('div',{class:'model-library'},
  sidebar,
  h('div',{class:'min-zero stack'},
   h('div',{class:'provider-mobile-bar toolbar'},mobile,mobileEditBtn,mobileAddBtn),
   right
  )
 );
 const page=h('div',{class:'stack model-page'},error,layout,dialogRoot);
 set(root,page);
 ctx.setActions?.();

 const dirty=()=>modelEditDirty();
 const guard=editorGuard(ctx,page,dirty);

 async function load(){
  if(!alive)return;
  try{
   const [d,providers]=await Promise.all([api('/api/model'),api('/api/model/providers')]);
   if(!alive)return;
   library=d.library||{providers:[],active:{},revision:d.revision||0};
   catalog=Array.isArray(providers)?providers:providers.providers||[];
   selected=library.providers.some(p=>p.key===selected)
    ?selected
    :library.active?.default?.key||library.providers[0]?.key||'';
   render();
  }catch(e){
   if(alive)errorBox(error,e,load);
  }
 }

 function current(){
  return library?.providers.find(p=>p.key===selected);
 }

 function renderProviderList(){
  const ps=library?.providers||[];
  set(providerList,
   ps.length?ps.map(p=>{
    const isActive=p.active||library.active?.default?.key===p.key;
    const isSelected=p.key===selected;
    return h('div',{
     class:'provider-row'+(isSelected?' selected':''),
     tabindex:0,
     role:'button',
     onclick:e=>{if(e.target.closest('.provider-edit-btn'))return;choose(p.key);},
     onkeydown:e=>{
      if(e.target.closest('.provider-edit-btn'))return;
      if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(p.key);}
     }
    },
     h('span',{class:'status-dot '+(p.ready?'ready':'')}),
     h('span',{class:'grow provider-row-name'},p.name||p.provider),
     isActive?h('span',{class:'chip ws-badge info'},'使用中'):null,
     h('button',{
      type:'button',
      class:'btn small ghost provider-edit-btn',
      'aria-label':'编辑服务商',
      title:'编辑服务商',
      onclick:e=>{e.stopPropagation();editProviderDialog(p);}
     },'✎')
    );
   }):empty('尚未添加服务商')
  );
 }

 function render(){
  const ps=library?.providers||[];
  renderProviderList();
  set(mobile,
   h('option',{value:''},'选择服务商'),
   ps.map(p=>h('option',{value:p.key},(p.name||p.provider)+(p.active?' · 使用中':'')))
  );
  mobile.value=selected;
  mobileEditBtn.disabled=!current();
  renderDetail();
 }

 function choose(key){
  if(key===selected)return;
  if(dirty()){
   const confirm=h('div',{class:'confirm'},
    h('span',{},'当前窗口有未保存修改。'),
    h('button',{class:'btn small',type:'button',onclick:()=>confirm.remove()},'保留编辑'),
    h('button',{class:'btn small danger',type:'button',onclick:()=>{confirm.remove();modelEditDirty=()=>false;set(dialogRoot);selected=key;render();}},'放弃并切换')
   );
   error.replaceChildren(confirm);
   mobile.value=selected;
   return;
  }
  selected=key;
  showCount=60;
  render();
 }

 function renderDetail(){
  const p=current();
  if(!p){
   set(right,
    empty('添加服务商并保存 Key 后，自动拉取模型列表。'),
    h('button',{class:'btn primary',type:'button',onclick:()=>addDialog()},'添加服务商')
   );
   return;
  }

  const search=h('input',{
   id:'model-search',
   class:'input small model-search-input',
   placeholder:'搜索模型…',
   'aria-label':'搜索模型',
   oninput:()=>{showCount=60;renderModels();}
  });
  const modelsWrap=h('div',{class:'model-rows stack'});

  set(right,
   h('div',{class:'toolbar model-toolbar'},
    h('h3',{class:'card-h'},p.name||p.provider),
    h('span',{class:'muted small model-count-label'},`${p.models.length} 个模型`),
    search,
    h('span',{class:'grow'}),
    h('button',{
     class:'btn small',
     type:'button',
     onclick:()=>mutate(()=>api(endpoint(p.key)+'/refresh',{method:'POST',body:{revision:library.revision},timeoutMs:35000}),'模型列表已刷新')
    },'刷新列表'),
    h('button',{
     class:'btn small',
     type:'button',
     onclick:()=>editModel(p,{id:'',source:'manual',params:{reasoningLevel:'off'}})
    },'手动添加模型')
   ),
   p.fetchError?h('div',{class:'callout warn'},'拉取失败：'+p.fetchError):null,
   modelsWrap
  );

  renderModels();

  function renderModels(){
   const q=search.value.trim().toLowerCase();
   const allFiltered=p.models.filter(m=>!q||m.id.toLowerCase().includes(q)||(m.info?.name||'').toLowerCase().includes(q));
   if(!allFiltered.length){
    set(modelsWrap,empty('暂无符合条件的模型'));
    return;
   }

   const starIds=Array.isArray(p.starred)?p.starred:[];
   const starSet=new Set(starIds);
   const byId=new Map(allFiltered.map(m=>[m.id,m]));

   const starredModels=starIds.map(id=>byId.get(id)).filter(Boolean);
   const recentModels=allFiltered
    .filter(m=>!starSet.has(m.id)&&Number.isFinite(m.lastUsedAt)&&m.lastUsedAt>0)
    .sort((a,b)=>(b.lastUsedAt-a.lastUsedAt)||a.id.localeCompare(b.id));
   const otherModels=allFiltered
    .filter(m=>!starSet.has(m.id)&&!(Number.isFinite(m.lastUsedAt)&&m.lastUsedAt>0))
    .sort((a,b)=>a.id.localeCompare(b.id));

   const tbody=h('tbody');

   function appendSectionHeader(title,count,hintText=''){
    tbody.append(h('tr',{class:'model-sec-row',dataset:{sectionHeader:title}},
     h('td',{colspan:7},
      h('b',{},title),
      h('span',{class:'numbers muted'},String(count)),
      hintText?h('span',{class:'model-sec-hint muted small'},hintText):null
     )
    ));
   }

   function buildRow(m,section){
    const isStarred=starSet.has(m.id);
    const active=m.active||(library.active?.default?.key===p.key&&library.active?.default?.modelId===m.id);
    const test=m.lastTest;
    const info=m.info;
    const hasReasoning=Boolean(info?.reasoning??m.custom?.reasoning);
    const hasVision=Boolean(info?.vision);

    const starBtn=h('button',{
     type:'button',
     class:'model-star-btn'+(isStarred?' is-starred':''),
     'aria-label':isStarred?'取消星标':'加入星标',
     'aria-pressed':String(isStarred),
     title:isStarred?'取消星标':'加入星标',
     onclick:e=>{
      e.stopPropagation();
      const prev=[...starIds];
      const next=isStarred?starIds.filter(id=>id!==m.id):[...starIds,m.id];
      void saveStars(p,next,prev);
     }
    },isStarred?'★':'☆');

    const gripCell=h('td',{class:'model-grip-cell'},
     isStarred?h('span',{class:'model-grip','aria-hidden':'true',title:'拖动调整星标顺序'},'⋮⋮'):null
    );

    const caps=h('span',{class:'model-caps'},
     hasReasoning?iconReasoning():null,
     hasVision?iconVision():null
    );

    const nameCell=h('td',{class:'model-name-cell'},
     h('b',{class:'break'},m.id),
     (hasReasoning||hasVision)?caps:null,
     active?h('span',{class:'chip ws-badge info',style:'margin-left:8px'},'使用中'):null,
     m.missing?h('span',{class:'ws-badge warn',style:'margin-left:6px'},'接口未返回'):null
    );

    const ctxValue=info?.contextWindow
     ?fmtTokens(info.contextWindow)
     :m.custom?.contextWindow
     ?fmtTokens(m.custom.contextWindow)
     :null;
    const ctxCell=h('td',{class:'num model-ctx-cell'},
     ctxValue||h('span',{class:'muted'},'自定义')
    );

    let priceCell;
    if(info&&info.costKnown!==false&&info.cost&&(info.cost.input!=null||info.cost.output!=null)){
     const c=info.cost;
     const tipRows=[
      ['输入',fmtModelPriceRate(c.input)],
      ['输出',fmtModelPriceRate(c.output)],
      ...(c.cacheRead!=null?[['缓存读取',fmtModelPriceRate(c.cacheRead)]]:[]),
      ...(c.cacheWrite!=null?[['缓存写入',fmtModelPriceRate(c.cacheWrite)]]:[])
     ];
     priceCell=h('td',{class:'num model-price-cell tipcell',tabindex:0},
      `${fmtModelPriceRate(c.input)} / ${fmtModelPriceRate(c.output)}`,
      h('div',{class:'model-price-tip',role:'tooltip'},
       ...tipRows.map(([k,v])=>h('div',{class:'model-price-tip-row'},h('span',{},k),h('b',{class:'numbers'},v))),
       h('small',{},'美元 / 每百万 token · 来自 pi 目录')
      )
     );
    }else{
     priceCell=h('td',{class:'num model-price-cell'},h('span',{class:'muted'},'未定价'));
    }

    const testCell=h('td',{class:'model-test-cell'},
     test
      ?h('span',{
        class:'small '+(test.ok?'good':'bad'),
        title:(fmtDateTime(test.at)||'')+(test.error?' · '+test.error:'')
       },
       test.ok
        ?`✓ ${test.latencyMs??'未知'} ms`
        :`✕ 失败${test.error?' · '+test.error:''}`
      )
      :h('span',{class:'muted small'},'未测试')
    );

    const actionsCell=h('td',{class:'tasks-act-cell model-act-cell'},
     rowActions(
      active?null:h('button',{
       class:'btn small',
       type:'button',
       onclick:e=>{e.stopPropagation();activate(p,m);}
      },'设为使用中'),
      h('button',{
       class:'btn small',
       type:'button',
       onclick:e=>{
        e.stopPropagation();
        mutate(()=>api(endpoint(p.key)+'/models/'+encodeURIComponent(m.id)+'/test',{method:'POST',body:{revision:library.revision},timeoutMs:190000}),'测试已完成');
       }
      },'测试 ',billingBadge()),
      h('button',{
       class:'btn small',
       type:'button',
       onclick:e=>{e.stopPropagation();editModel(p,m);}
      },'编辑'),
      m.source==='manual'&&!active?h('button',{
       class:'btn small danger',
       type:'button',
       onclick:e=>{
        e.stopPropagation();
        mutate(()=>api(endpoint(p.key)+'/models/'+encodeURIComponent(m.id),{method:'DELETE',body:{revision:library.revision}}),'模型已删除');
       }
      },'删除'):null
     )
    );

    const tr=h('tr',{
     class:'model-row'+(active?' is-active-model':''),
     dataset:{modelId:m.id,section},
     tabindex:isStarred?0:undefined,
     draggable:isStarred?'true':undefined,
     onclick:e=>{
      if(e.target.closest('button,.tipcell'))return;
      tr.classList.toggle('selected');
     },
     onkeydown:isStarred?e=>{
      if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){
       e.preventDefault();
       const idx=starIds.indexOf(m.id);
       if(idx<0)return;
       const targetIdx=e.key==='ArrowUp'?idx-1:idx+1;
       if(targetIdx<0||targetIdx>=starIds.length)return;
       const prev=[...starIds];
       const next=[...starIds];
       next.splice(idx,1);
       next.splice(targetIdx,0,m.id);
       void saveStars(p,next,prev,m.id);
      }
     }:undefined,
     ondragstart:isStarred?e=>{
      dragModelId=m.id;
      tr.classList.add('is-dragging');
      if(e.dataTransfer){
       e.dataTransfer.effectAllowed='move';
       try{e.dataTransfer.setData('text/plain',m.id);}catch{}
      }
     }:undefined,
     ondragover:isStarred?e=>{
      if(!dragModelId||dragModelId===m.id)return;
      e.preventDefault();
      tr.classList.add('is-drop-target');
     }:undefined,
     ondragleave:isStarred?()=>{
      tr.classList.remove('is-drop-target');
     }:undefined,
     ondrop:isStarred?e=>{
      e.preventDefault();
      tr.classList.remove('is-drop-target');
      const fromId=dragModelId||(e.dataTransfer?.getData('text/plain')||'');
      dragModelId=null;
      if(!fromId||fromId===m.id)return;
      const fromIdx=starIds.indexOf(fromId);
      const toIdx=starIds.indexOf(m.id);
      if(fromIdx<0||toIdx<0)return;
      const prev=[...starIds];
      const next=[...starIds];
      next.splice(fromIdx,1);
      next.splice(toIdx,0,fromId);
      void saveStars(p,next,prev);
     }:undefined,
     ondragend:isStarred?()=>{
      dragModelId=null;
      tr.classList.remove('is-dragging','is-drop-target');
     }:undefined
    },
     h('td',{class:'model-star-cell'},starBtn),
     gripCell,
     nameCell,
     ctxCell,
     priceCell,
     testCell,
     actionsCell
    );
    return tr;
   }

   if(starredModels.length>0){
    appendSectionHeader('★ 星标',starredModels.length,'拖动 ⋮⋮ 或按 Alt+↑/↓ 调整顺序');
    for(const m of starredModels)tbody.append(buildRow(m,'starred'));
   }
   if(recentModels.length>0){
    appendSectionHeader('最近使用',recentModels.length,'最近 30 天调用过的，按时间排');
    for(const m of recentModels)tbody.append(buildRow(m,'recent'));
   }
   if(otherModels.length>0){
    appendSectionHeader('其他模型',otherModels.length);
    for(const m of otherModels.slice(0,showCount))tbody.append(buildRow(m,'other'));
   }

   const tableEl=h('div',{class:'table-wrap model-table-wrap'},
    h('table',{class:'data-table model-table'},
     h('thead',{},
      h('tr',{},
       h('th',{scope:'col',class:'col-star'},''),
       h('th',{scope:'col',class:'col-grip'},''),
       h('th',{scope:'col'},'模型'),
       h('th',{scope:'col',class:'num'},'上下文'),
       h('th',{scope:'col',class:'num'},'价格（输入 / 输出）'),
       h('th',{scope:'col'},'测试'),
       h('th',{scope:'col',class:'col-act'},'')
      )
     ),
     tbody
    )
   );

   set(modelsWrap,
    tableEl,
    otherModels.length>showCount?h('button',{
     class:'btn small',
     type:'button',
     onclick:()=>{showCount+=60;renderModels();}
    },'显示更多模型'):null
   );
  }
 }

 async function saveStars(p,nextIds,prevIds,focusModelId=''){
  p.starred=[...nextIds];
  renderDetail();
  if(focusModelId){
   queueMicrotask(()=>{
    const rowEl=right.querySelector(`.model-row[data-model-id="${CSS.escape(focusModelId)}"]`);
    rowEl?.focus();
   });
  }
  try{
   const res=await api(endpoint(p.key)+'/stars',{
    method:'PUT',
    body:{revision:library.revision,ids:nextIds}
   });
   if(!alive)return;
   if(res?.providers){
    library=res;
   }else if(res?.library){
    library=res.library;
   }else if(typeof res?.revision==='number'){
    library.revision=res.revision;
   }
   render();
   if(focusModelId){
    queueMicrotask(()=>{
     const rowEl=right.querySelector(`.model-row[data-model-id="${CSS.escape(focusModelId)}"]`);
     rowEl?.focus();
    });
   }
  }catch(e){
   if(!alive)return;
   p.starred=[...prevIds];
   renderDetail();
   notice('星标保存失败：'+e.message,'error');
  }
 }

 async function mutate(fn,success,allowDirty=false){
  if(!alive||busy)return;
  if(!allowDirty&&dirty()){notice('请先保存或放弃窗口内的修改','error');return;}
  busy=true;
  const buttons=[...page.querySelectorAll('button')].map(b=>[b,b.disabled]);
  for(const [b]of buttons)b.disabled=true;
  let ok=false;
  try{
   await fn();
   if(!alive)return;
   await load();
   if(!alive)return;
   ok=true;
  }catch(e){
   if(alive)notice(e.message,'error');
  }finally{
   busy=false;
   for(const [b,disabled]of buttons)if(b.isConnected)b.disabled=disabled;
  }
  if(ok&&alive){
   ctx.onSaved?.();
   notice(success,'ok');
   void refreshStatus().catch(()=>{});
  }
 }

 function modal(title,...content){
  modelEditDirty=()=>false;
  const close=()=>{modelEditDirty=()=>false;set(dialogRoot);};
  const body=h('div',{class:'modal-card stack',role:'dialog','aria-modal':'true','aria-label':title},
   h('div',{class:'toolbar'},
    h('h2',{class:'grow'},title),
    h('button',{class:'btn small',type:'button',onclick:close},'关闭')
   ),
   ...content
  );
  const overlay=h('div',{class:'modal-overlay'},body);
  set(dialogRoot,overlay);
  queueMicrotask(()=>body.querySelector('input,select,button')?.focus());
  return close;
 }

 function editProviderDialog(p){
  const isActive=Boolean(p.active||library.active?.default?.key===p.key);
  const draft={name:p.name||p.provider,baseUrl:p.baseUrl||'',key:''};
  const initial=JSON.stringify(draft);

  const nameInput=h('input',{
   class:'input',
   id:'provider-name',
   value:draft.name,
   oninput:e=>{draft.name=e.target.value;}
  });
  const stateHint=h('span',{class:'small muted'},
   p.hasKey?'已保存 '+(p.keyHint||'Key')+'，留空表示不改':'尚未设置 Key'
  );
  const keyInput=h('input',{
   class:'input',
   id:'api-key',
   type:'password',
   autocomplete:'new-password',
   placeholder:p.hasKey?'已保存 '+(p.keyHint||'Key')+'，留空表示不改':'填写 API Key',
   oninput:e=>{draft.key=e.target.value;}
  });
  const urlInput=h('input',{
   class:'input',
   id:'base-url',
   value:draft.baseUrl,
   oninput:e=>{
    const previous=keyOrigin(draft.baseUrl);
    const next=keyOrigin(e.target.value);
    if(!next||previous!==next){
     keyInput.value='';
     draft.key='';
    }
    draft.baseUrl=e.target.value;
    if(keyOrigin(draft.baseUrl)!==keyOrigin(p.baseUrl)){
     keyInput.placeholder='地址主机已改变，请重新填写 Key';
     stateHint.textContent='必须填写新主机对应的 Key';
    }else{
     keyInput.placeholder=p.hasKey?'已保存 '+(p.keyHint||'Key')+'，留空表示不改':'填写 API Key';
     stateHint.textContent=p.hasKey?'已保存 '+(p.keyHint||'Key')+'，留空表示不改':'尚未设置 Key';
    }
   }
  });

  let close;
  const delBtn=h('button',{
   class:'btn small danger',
   id:'provider-delete',
   type:'button',
   disabled:isActive,
   title:isActive?'使用中的服务商不能删除，请先切换使用中的模型':'删除服务商',
   onclick:()=>{
    close();
    mutate(()=>api(endpoint(p.key),{method:'DELETE',body:{revision:library.revision}}),'服务商已删除',true);
   }
  },'删除服务商');

  const saveBtn=h('button',{
   class:'btn primary',
   id:'provider-save',
   type:'button',
   onclick:async()=>{
    await mutate(async()=>{
     await api(endpoint(p.key),{
      method:'PUT',
      body:{
       revision:library.revision,
       name:draft.name.trim()||p.name,
       baseUrl:draft.baseUrl.trim(),
       apiKey:draft.key
      }
     });
     close();
    },'连接已保存',true);
   }
  },'保存连接');

  close=modal('编辑服务商',
   field('名称',nameInput),
   field('Base URL',urlInput),
   field('API Key',keyInput),
   stateHint,
   isActive?h('div',{class:'small muted'},'使用中的服务商不能删除，需先切换使用中的模型。'):null,
   h('div',{class:'toolbar'},
    delBtn,
    h('span',{class:'grow'}),
    h('button',{class:'btn',type:'button',onclick:()=>close()},'取消'),
    saveBtn
   )
  );
  modelEditDirty=()=>JSON.stringify(draft)!==initial;
 }

 async function activate(p,m){
  if(!m.info&&!m.custom){
   editModel(p,m,()=>{
    const next=library.providers.find(x=>x.key===p.key);
    const model=next?.models.find(x=>x.id===m.id);
    if(next&&model)activate(next,model);
   });
   return;
  }
  const untested=!m.lastTest?.ok;
  let close;
  if(untested){
   close=modal('该模型尚未通过测试',
    h('p',{},'仍可设为使用中；后续处理会采用此模型。'),
    h('div',{class:'toolbar'},
     h('button',{class:'btn',type:'button',onclick:()=>close()},'取消'),
     h('button',{
      class:'btn primary',
      type:'button',
      onclick:()=>{
       close();
       mutate(()=>api('/api/model/active',{method:'PUT',body:{key:p.key,modelId:m.id,revision:library.revision,confirmUntested:true}}),'使用中模型已切换');
      }
     },'仍然使用')
    )
   );
  }else{
   await mutate(()=>api('/api/model/active',{method:'PUT',body:{key:p.key,modelId:m.id,revision:library.revision}}),'使用中模型已切换');
  }
 }

 function editModel(p,m,onSaved){
  const isCustomProvider=p.provider==='custom';
  const defaultCustomApi=m.api||m.info?.api||p.models.find(x=>x.api)?.api||p.api||'openai-completions';
  const catalogApi=m.info?.api||catalog.find(x=>x.id===p.provider)?.apis?.[0]||'openai-completions';

  const id=h('input',{class:'input',value:m.id,readOnly:!!m.id});
  const apiSelect=h('select',{class:'input'},
   CUSTOM_APIS.map(a=>h('option',{value:a.value},a.title))
  );
  apiSelect.value=isCustomProvider?defaultCustomApi:catalogApi;

  const levels=m.info?.levels?.length?m.info.levels:['off','low','medium','high'];
  const reason=h('select',{class:'input'},
   levels.map(v=>h('option',{value:v},v==='off'?'关闭':v))
  );
  reason.value=m.params?.reasoningLevel||levels[0];

  const context=h('input',{class:'input',type:'number',min:1000,value:m.custom?.contextWindow??128000});
  const supports=h('input',{type:'checkbox',checked:!!m.custom?.reasoning});

  const info=m.info;
  const priceSummary=info&&info.costKnown!==false&&info.cost
   ?`输入 ${fmtModelPriceRate(info.cost.input)} · 输出 ${fmtModelPriceRate(info.cost.output)}${info.cost.cacheRead!=null?' · 缓存读取 '+fmtModelPriceRate(info.cost.cacheRead):''}${info.cost.cacheWrite!=null?' · 缓存写入 '+fmtModelPriceRate(info.cost.cacheWrite):''}`
   :'未定价';
  const capsSummary=[
   (info?.reasoning??m.custom?.reasoning)?'推理':null,
   info?.vision?'看图':null
  ].filter(Boolean).join(' · ')||'基础文本';

  const infoBlock=m.id?h('div',{class:'model-kvg'},
   h('span',{},'接口协议'),
   h('b',{class:'protocol-auto'},
    isCustomProvider?apiSelect.value:catalogApi,
    !isCustomProvider?h('small',{},'目录自带'):null
   ),
   h('span',{},'上下文'),
   h('b',{},info?.contextWindow?fmtTokens(info.contextWindow)+' token':m.custom?.contextWindow?fmtTokens(m.custom.contextWindow)+' token':'未设置'),
   h('span',{},'价格'),
   h('b',{},priceSummary,info&&info.costKnown!==false?h('small',{},'每百万 token'):null),
   h('span',{},'能力'),
   h('b',{},capsSummary)
  ):null;

  let close;
  close=modal(m.id?'编辑模型参数':'手动添加模型',
   m.id?infoBlock:field('模型 ID',id),
   isCustomProvider?field('接口协议',apiSelect):null,
   field('推理强度',reason),
   !m.info?h('div',{class:'stack'},
    field('上下文长度（token）',context),
    h('label',{class:'check'},supports,'支持推理')
   ):null,
   h('div',{class:'toolbar'},
    h('span',{class:'grow'}),
    h('button',{class:'btn',type:'button',onclick:()=>close()},'取消'),
    h('button',{
     class:'btn primary',
     type:'button',
     onclick:async()=>{
      try{
       const body={
        revision:library.revision,
        params:{reasoningLevel:reason.value},
        ...(isCustomProvider?{api:apiSelect.value}:{}),
        ...(!m.info?{custom:{contextWindow:Number(context.value),reasoning:supports.checked}}:{})
       };
       await api(endpoint(p.key)+'/models/'+encodeURIComponent(id.value.trim()),{method:'PUT',body});
       if(!alive)return;
       close();
       await load();
       if(alive)onSaved?.();
      }catch(e){
       if(alive)notice(e.message,'error');
      }
     }
    },'保存参数')
   )
  );
  const snapshot=()=>JSON.stringify({
   id:id.value,
   api:apiSelect.value,
   reasoningLevel:reason.value,
   contextWindow:context.value,
   reasoning:supports.checked
  });
  const initial=snapshot();
  modelEditDirty=()=>snapshot()!==initial;
 }

 function addDialog(preselected){
  const search=h('input',{id:'provider-search',class:'input',placeholder:'搜索服务商…',oninput:renderList});
  const list=h('div',{class:'provider-picker'});
  const detail=h('div',{class:'stack'});
  let close;

  function pick(p){
   let previousOrigin=keyOrigin(p.baseUrl||'');
   const name=h('input',{class:'input',value:p.name||p.id});
   const key=h('input',{class:'input',type:'password',autocomplete:'new-password'});
   const url=h('input',{
    class:'input',
    value:p.baseUrl||'',
    oninput:e=>{
     const next=keyOrigin(e.target.value);
     if(!next||previousOrigin!==next){
      key.value='';
      key.placeholder='地址目标已改变，请重新填写 Key';
     }
     previousOrigin=next;
    }
   });
   set(detail,
    h('b',{},p.name),
    field('名称',name),
    field('Base URL',url),
    field('API Key',key),
    h('button',{
     class:'btn primary',
     type:'button',
     onclick:async e=>{
      e.currentTarget.disabled=true;
      try{
       const result=await api('/api/model/library',{
        method:'POST',
        body:{
         revision:library.revision,
         provider:p.id,
         name:name.value,
         baseUrl:url.value,
         apiKey:key.value
        },
        timeoutMs:35000
       });
       if(!alive)return;
       selected=result.provider?.key||result.key||result.providers?.at(-1)?.key||'';
       close();
       await load();
       if(!alive)return;
       notice('服务商已保存，模型列表已尝试拉取','ok');
      }catch(error){
       if(alive){
        notice(error.message,'error');
        if(e.currentTarget)e.currentTarget.disabled=false;
       }
      }
     }
    },'添加并拉取模型')
   );
  }

  function renderList(){
   const q=search.value.toLowerCase();
   set(list,
    [['cn','国内'],['intl','海外']].map(([g,title])=>h('div',{},
     h('h3',{class:'small muted'},title),
     catalog.filter(p=>p.group===g&&(!q||[p.id,p.name].join(' ').toLowerCase().includes(q))).map(p=>h('button',{
      class:'provider-choice',
      type:'button',
      disabled:p.available===false,
      title:p.reason||'',
      onclick:()=>pick(p)
     },
      p.name,
      p.available===false?h('span',{class:'small muted'},p.reason||'暂未接入'):null
     ))
    )),
    h('button',{
     class:'provider-choice',
     type:'button',
     onclick:()=>pick({id:'custom',name:'自定义端点',baseUrl:''})
    },'自定义端点')
   );
  }

  close=modal('添加服务商',search,list,detail);
  renderList();
  if(typeof preselected==='string'){
   const provider=preselected==='custom'
    ?{id:'custom',name:'自定义端点',baseUrl:''}
    :catalog.find(p=>p.id===preselected);
   if(provider)pick(provider);
  }
 }

 load();
 return()=>{alive=false;guard();};
}
