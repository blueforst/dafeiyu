import {h,set} from '../../dom.js';
import {api} from '../../api.js';
import {empty,errorBox} from '../../view-utils.js';
export function mount(root,ctx){
  let alive=true;
  const card=h('div',{class:'ws-card sources-card'}),refresh=h('button',{class:'btn small',type:'button',onclick:load},'刷新状态');
  set(root,card);
  ctx.setActions?.(refresh);
  async function load(){
    refresh.disabled=true;
    try{
      const data=await api('/api/collection/sources');
      if(!alive)return;
      const items=data.sources||[];
      ctx.setSummary?.(items.filter(s=>s.enabled).length+' / '+items.length+' 启用');
      if(!items.length){
        set(card,empty('暂未取得采集来源状态'));
        return;
      }
      set(card,
        h('table',{class:'sources-table'},
          h('tbody',{},items.map(source=>{
            const desc=source.reason||(source.enabled?'按当前采集规则运行':'等待适配确认');
            return h('tr',{class:'collection-source',dataset:{sourceId:source.id}},
              h('td',{class:'source-name'},
                h('span',{class:'settings-state-dot '+(source.enabled?'normal':'attention'),'aria-hidden':'true'}),
                h('b',{},source.label||source.id)
              ),
              h('td',{class:'source-state'},
                h('span',{class:'ws-badge '+(source.enabled?'ok':'warn')},source.enabled?'已启用':'未启用')
              ),
              h('td',{class:'source-desc',title:desc},desc)
            );
          }))
        )
      );
    }catch(error){if(alive)errorBox(card,error,load);}
    finally{refresh.disabled=false;}
  }
  load();
  return()=>{alive=false;};
}
