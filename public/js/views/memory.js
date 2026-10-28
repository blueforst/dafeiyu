import { h, set, fmtDateTime } from '../dom.js';
import { api } from '../api.js';
import { notice, getStatus, onStatus } from '../state.js';
import { field, empty, json, table, editorGuard, errorBox, billingBadge } from '../view-utils.js';
import {mount as mountExperiences} from './experience-panel.js';

const CHANNEL = { public: '公开', private: '私信' };
const TYPE = { fact: '明确事实', preference: '偏好', topic: '未完话题', 'open-topic': '未完话题', experience: '角色经历', legacy: '旧摘要' };

export function mount(root, ctx) {
  let alive = true, selected = null, current = null, users = [], nextCursor = null, busy = false;
  let policy = null, policyRevision = 0, policySaved = '', edits = new Map(), accountEdited = false;
  const account = h('input', { id: 'memory-account', class: 'input', value: getStatus()?.accountId || '', placeholder: '工作账号；清空查看未知归属历史', oninput: () => { accountEdited = true; } });
  const channel = h('select', { id: 'memory-channel', class: 'input' }, h('option', { value: '' }, '全部渠道'), h('option', { value: 'public' }, '公开'), h('option', { value: 'private' }, '私信'));
  const search = h('input', { id: 'memory-search', class: 'input', placeholder: '搜索用户或会话…', onkeydown: e => { if (e.key === 'Enter') loadUsers(); } });
  const list = h('div', { id: 'memory-users', class: 'stack' }, empty('正在读取用户与会话…'));
  const details = h('div', { id: 'memory-detail', class: 'stack' }, empty('选择用户或会话，查看来源及可见范围。'));
  const policyBox = h('div', {}, empty('正在读取记忆策略…'));
  const more = h('button', { type: 'button', class: 'btn', hidden: true, onclick: () => loadUsers(true) }, '加载更多用户');
  const selectionConfirm = h('div', { class: 'confirm', hidden: true });
  const identity=h('select',{class:'input settings-secondary-mobile',id:'memory-identity','aria-label':'选择记忆身份',onchange:()=>{const user=users[Number(identity.value)];if(user)select(user);}});
  const tabs=h('div',{class:'segmented',role:'group','aria-label':'记忆视图'},[['users','用户记忆'],['experiences','角色经历'],['policy','策略']].map(([view,label])=>h('a',{href:'#/settings/memory?view='+view,class:'btn small',dataset:{memoryView:view}},label)));
  const controls=h('div',{class:'stack memory-user-controls'},h('div',{class:'toolbar'},search,h('button',{id:'memory-search-button',class:'btn small',type:'button',onclick:()=>loadUsers()},'搜索')),h('div',{class:'segmented'},[['','全部'],['public','公开'],['private','私信']].map(([id,label])=>h('button',{class:'btn small',type:'button','aria-pressed':String(channel.value===id),onclick:e=>{channel.value=id;for(const child of e.currentTarget.parentNode.children)child.setAttribute('aria-pressed',String(child===e.currentTarget));loadUsers();}},label))),h('details',{},h('summary',{},'更多筛选'),field('工作账号',account)));
  const secondaryList=h('aside',{class:'settings-secondary-list stack'},controls,list,more),mobileControls=h('div',{class:'settings-memory-mobile-controls stack'},identity),userPane=h('div',{class:'settings-secondary-layout settings-memory-users'},secondaryList,h('section',{class:'settings-secondary-detail stack'},mobileControls,details)),narrow=matchMedia('(max-width:860px)');
  function responsive(){if(narrow.matches)mobileControls.replaceChildren(controls,identity,more);else{secondaryList.prepend(controls);secondaryList.append(more);mobileControls.replaceChildren(identity);}}
  narrow.addEventListener('change',responsive);responsive();
  const experiencePane=h('div',{class:'settings-memory-experiences',hidden:true}),policyPane=h('div',{class:'settings-panel settings-memory-policy',hidden:true},policyBox),page=h('div',{class:'stack settings-memory'},ctx.workspace?null:h('h1',{class:'page-title'},'记忆'),ctx.setActions?null:tabs,selectionConfirm,userPane,experiencePane,policyPane);
  set(root, page);ctx.setActions?.(tabs);let experiences=null,usersLoaded=false,view='';
  const dirty = () => !!experiences?.dirty() || (!!policy && JSON.stringify(policy) !== policySaved) || [...edits.entries()].some(([id, text]) => text !== current?.items?.find(x => x.id === id)?.text);
  const cleanup = editorGuard(ctx, page, dirty);
  const query = scope => new URLSearchParams({ accountId: scope.accountId || '', channel: scope.channel || 'public' });
  function itemDirty() { return [...edits.entries()].some(([id, text]) => text !== current?.items?.find(x => x.id === id)?.text); }
  function select(user, discard = false) {
    if (!discard && itemDirty()) {
      set(selectionConfirm, h('span', {}, '当前用户有未保存的记忆修改。'), h('div', { class: 'confirm-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => { selectionConfirm.hidden = true; } }, '保留编辑'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => { selectionConfirm.hidden = true; select(user, true); } }, '放弃并切换')));
      selectionConfirm.hidden = false; identity.value=selected?String(users.findIndex(u=>u.userId===selected.userId&&u.channel===selected.channel&&u.accountId===selected.accountId)):'';return;
    }
    selected = user; edits = new Map(); loadDetails(); renderUsers();
  }
  function renderUsers() {
    set(list, users.length ? users.map(user => h('button', { type: 'button', class: 'memory-user' + (selected && selected.userId === user.userId && selected.accountId === user.accountId && selected.channel === user.channel ? ' selected' : ''), onclick: () => select(user) },
      h('b', {}, user.label || user.userId), h('span', { class: 'muted small' }, (user.accountId || '未知归属') + ' · ' + CHANNEL[user.channel] + (user.identityConfirmed ? '' : ' · 身份未确认')+(user.linkedTo?.length?' · 已关联':'')),
      h('span', { class: 'small' }, (user.forgotten ? '已遗忘／停止记录' : user.itemCount + ' 条记忆') + ' · 最近互动 ' + (fmtDateTime(user.lastInteractionAt) || '暂无')),
      h('span', { class: 'muted small' }, '整理时间 ' + (fmtDateTime(user.lastSummaryAt) || '尚未整理')))) : empty('没有符合筛选条件的用户或会话。'));
    set(identity,h('option',{value:''},'选择用户或会话'),users.map((user,index)=>h('option',{value:String(index)},(user.label||user.userId)+' · '+CHANNEL[user.channel])));const index=selected?users.findIndex(user=>user.userId===selected.userId&&user.accountId===selected.accountId&&user.channel===selected.channel):-1;if(selected&&index<0)identity.append(h('option',{value:'selected'},(selected.label||selected.userId)+' · '+CHANNEL[selected.channel]));identity.value=selected?(index<0?'selected':String(index)):'';more.hidden = nextCursor === null || nextCursor === undefined;
  }
  async function loadUsers(append = false) {
    if (busy) return; busy = true; more.disabled = true;
    try {
      const params = new URLSearchParams({ channel: channel.value, q: search.value.trim(), limit: '30' });
      if (account.value || accountEdited) params.set('accountId', account.value.trim());
      if (append && nextCursor !== null) params.set('cursor', nextCursor);
      const data = await api('/api/memory/users?' + params); if (!alive) return;
      usersLoaded=true; users = append ? [...users, ...data.users] : data.users; nextCursor = data.nextCursor; renderUsers();
    } catch (e) { if (alive) errorBox(list, e, () => loadUsers()); }
    finally { busy = false; more.disabled = false; }
  }
  async function loadDetails() {
    if (!selected) return; const scope = selected;
    set(details, empty('正在读取记忆与来源…'));
    try {
      const data = await api('/api/memory/users/' + encodeURIComponent(scope.userId) + '?' + query(scope));
      if (!alive || selected !== scope) return; current = data; renderDetails();
    } catch (e) { if (alive && selected === scope) errorBox(details, e, loadDetails); }
  }
  function renderDetails() {
    const data = current;
    set(details, h('div', {}, h('h2', { class: 'card-h' }, selected.label || data.userId), h('div', { class: 'muted small' }, (data.accountId || '未知归属') + ' · ' + CHANNEL[data.channel] + ' · ' + (data.forgotten ? '已遗忘，停止记录' : '允许记录'))),
      renderLinks(data),
      h('div', { class: 'toolbar' },
        h('button', { id: 'memory-preview', class: 'btn', type: 'button', onclick: () => action('preview') }, '只读召回预览'),
        h('button', { class: 'btn', type: 'button', disabled: data.forgotten, onclick: () => action('summarize') }, '重新整理 ',billingBadge()),
        h('button', { class: 'btn' + (data.forgotten ? '' : ' danger'), type: 'button', onclick: () => action(data.forgotten ? 'remember' : 'forget') }, data.forgotten ? '恢复后续记录' : '遗忘并停止记录')),
      h('div', { class: 'stack' }, data.items?.length ? data.items.map(renderItem) : empty('暂无长期记忆。')),
      data.linkedItems?.length?h('section',{class:'stack'},h('h3',{},'关联身份的记忆（只读）'),data.linkedItems.map(item=>h('div',{class:'subcard small pre-wrap'},h('b',{},CHANNEL[item.channel]+' · '+item.userId+' · 来源：'+linkSource(item.linkSource)),h('div',{},item.text)))):null,
      h('details', {}, h('summary', {}, '有来源的互动记录'), data.experiences?.length ? data.experiences.map(item => h('div', { class: 'subcard' }, h('div', { class: 'muted small' }, fmtDateTime(item.createdAt) + ' · ' + (item.channel === 'private' ? '私信' : '公开')), h('div', { class: 'pre-wrap' }, item.text), h('div', { class: 'muted small break' }, '来源：' + (item.sourceMessageId || '平台回执')), item.receipt ? json(item.receipt) : null)) : empty('暂无有来源的真实互动记录。虚构日程不会写入此处。')),
      h('details', {}, h('summary', {}, '近期可见互动'), data.recent?.length ? data.recent.map(row => h('div', { class: 'subcard pre-wrap' }, typeof row === 'string' ? row : JSON.stringify(row, null, 2))) : empty('暂无近期互动')),
      h('details', {}, h('summary', {}, '整理进度'), json(data.progress || {})), h('div', { id: 'memory-action-result', class: 'stack' }));
  }
  function linkSource(source){return {'chat-test':'试聊',platform:'平台读取',admin:'管理员'}[source]||source;}
  function renderLinks(data){
    const links=data.links?.links||[],blocks=data.links?.blocks||[],box=h('section',{class:'subcard stack memory-identity-links'},h('h3',{},'身份关联'));
    async function change(method,privateUserId,publicHandle){
      if(itemDirty()){notice('请先保存记忆修改再变更关联','error');return;}
      const scope=selected;try{await api('/api/memory/links',{method,body:{accountId:scope.accountId,privateUserId,...(publicHandle?{publicHandle}:{})}});if(!alive||selected!==scope)return;await loadDetails();await loadUsers();notice(method==='PUT'?'身份已关联':'管理员已解除关联','ok');}catch(error){if(alive&&selected===scope)notice(error.message,'error');}
    }
    for(const link of links)box.append(h('div',{class:'stack small'},h('span',{},'已关联 '+(data.channel==='private'?'@'+link.publicUserId.slice(2):link.privateUserId)+' · 来源：'+linkSource(link.source)),h('button',{class:'btn small',type:'button',onclick:()=>change('DELETE',link.privateUserId)},'解除关联')));
    if(!links.length)box.append(h('span',{class:'muted small'},blocks.length?'管理员已解除':'尚未关联公开身份'));
    if(data.channel==='private'&&!links.length){const input=h('input',{class:'input',placeholder:'@handle','aria-label':'公开身份 handle',maxlength:16}),confirm=h('div',{class:'callout warn stack',hidden:true},h('span',{},'关联后，私信记忆会在公开回复中作为背景，并有重合检查。是否确认关联？'));
      confirm.append(h('button',{class:'btn primary small',type:'button',onclick:()=>change('PUT',data.userId,input.value.trim())},'确认关联'),h('button',{class:'btn small',type:'button',onclick:()=>{confirm.hidden=true;}},'取消'));
      box.append(input,h('button',{class:'btn small',type:'button',onclick:()=>{confirm.hidden=false;}},'关联公开身份'),confirm);
    }
    return box;
  }
  function renderItem(item) {
    const input = h('textarea', { class: 'input', rows: 4, value: edits.get(item.id) ?? item.text, oninput: e => { edits.set(item.id, e.target.value); } });
    const status = h('span', { class: 'muted small' });
    const save = h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
      save.disabled = true; input.disabled = true; remove.disabled = true; cancel.disabled = true; status.textContent = '正在保存…';
      const snapshot = input.value;
      try { await api('/api/memory/items/' + encodeURIComponent(item.id), { method: 'PUT', body: { accountId: current.accountId, text: snapshot, revision: item.revision } }); if (!edits.has(item.id) || edits.get(item.id) === snapshot) edits.delete(item.id); await loadDetails(); notice('记忆条目已修订', 'ok'); }
      catch (e) { status.textContent = e.message; notice(e.message, 'error'); } finally { save.disabled = false; input.disabled = false; remove.disabled = false; cancel.disabled = false; }
    } }, '保存条目');
    const remove = h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
      remove.disabled = true;
      try { await api('/api/memory/items/' + encodeURIComponent(item.id), { method: 'DELETE', body: { accountId: current.accountId, revision: item.revision } }); edits.delete(item.id); await loadDetails(); await loadUsers(); notice('条目已删除，旧来源不会自动复活', 'ok'); }
      catch (e) { notice(e.message, 'error'); } finally { remove.disabled = false; }
    } }, '删除条目');
    const cancel = h('button', { class: 'btn small', type: 'button', onclick: () => { input.value = item.text; edits.delete(item.id); status.textContent = ''; } }, '撤销本条修改');
    return h('article', { class: 'subcard stack' }, h('div', { class: 'toolbar' }, h('b', { class: 'grow' }, TYPE[item.type] || item.type), h('span', { class: 'muted small' }, '修订 ' + item.revision + ' · ' + fmtDateTime(item.updatedAt))),
      item.sourceStatus !== 'complete' ? h('div', { class: 'callout warn' }, item.sourceStatus === 'incomplete' || item.sourceStatus === 'legacy' ? '来源不完整：旧摘要未建立可靠来源关系。' : '来源状态：' + item.sourceStatus) : null,
      input, h('div', { class: 'toolbar' }, save, cancel, remove, status),
      h('details', {}, h('summary', {}, '来源（' + (item.sources?.length ?? 0) + '）'), item.sources?.length ? item.sources.map(source => {
        let link = null;
        try { const url = new URL(source.url); if (url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) link = h('a', { href: url.href, target: '_blank', rel: 'noopener' }, '平台来源 →'); } catch {}
        return h('div', { class: 'subcard' }, h('div', { class: 'muted small' }, source.messageId + ' · ' + fmtDateTime(source.timestamp) + (source.available ? '' : ' · 原文已不可用')), link, source.text ? h('pre', { class: 'pre-wrap' }, source.text) : null);
      }) : empty('没有可验证的来源链接，不补造来源。')));
  }
  async function action(name) {
    if (!selected) return;
    if (name !== 'preview' && itemDirty()) { notice('请先保存记忆条目，或切换用户时明确放弃编辑后再执行', 'error'); return; }
    const box = document.getElementById('memory-action-result'); set(box, empty(name === 'preview' ? '正在读取…' : '正在执行…'));
    try {
      const data = await api('/api/memory/users/' + encodeURIComponent(selected.userId) + '/' + name, { method: 'POST', body: { accountId: selected.accountId, channel: selected.channel }, timeoutMs: 180000 }); if (!alive) return;
      if (name === 'preview') set(box, h('h3', {}, '只读召回预览'), h('div', { class: 'muted small' }, '以下为当前账号和渠道实际允许召回的内容。预览不写回。'), json(data));
      else { if (name === 'forget') edits.clear(); await loadDetails(); await loadUsers(); notice(name === 'summarize' ? (data.written ? '记忆已整理' : '本次未写入新记忆') : name === 'forget' ? '已遗忘并停止记录' : '已恢复后续记录', 'ok'); }
    } catch (e) { if (alive) errorBox(box, e); }
  }
  async function loadPolicy() {
    try {
      const data = await api('/api/memory/policy'); if (!alive) return; policy = structuredClone(data.policy); policyRevision = data.revision; policySaved = JSON.stringify(policy);
      const save = h('button', { id: 'memory-policy-save', type: 'button', class: 'btn primary', onclick: async () => {
        save.disabled = true;
        const snapshot = structuredClone(policy);
        try { const res = await api('/api/memory/policy', { method: 'PUT', body: { policy: snapshot, revision: policyRevision } }); policyRevision = res.revision; policySaved = JSON.stringify(snapshot); ctx.onSaved?.();notice('记忆策略已保存，下一轮生效', 'ok'); }
        catch (e) { notice(e.message, 'error'); } finally { save.disabled = false; }
      } }, '保存记忆策略');
      set(policyBox, h('div', { class: 'grid3' }, [['recentCount', '近期互动数量', 1, 20], ['recentDays', '近期窗口（天）', 1, 365], ['retentionDays', '原文保留（天）', 1, 365]].map(([key, label, min, max]) => field(label, h('input', { type: 'number', class: 'input', min, max, step: 1, value: policy[key], oninput: e => { policy[key] = Number(e.target.value); } })))),
        h('p', { class: 'muted small' }, '仅已确认发送的回复会作为角色说过的话。长期记忆按来源与可见范围保留。'), save);
    } catch (e) { if (alive) errorBox(policyBox, e, loadPolicy); }
  }
  const offStatus = onStatus(status => { if (!accountEdited && !account.value && status?.accountId) account.value = status.accountId; });
  function useRoute(route=ctx.route) {const params=route.params;if(!params?.has('user'))return;const userId=params.get('user'),accountId=params.get('account')||getStatus()?.accountId||'',ch=params.get('channel')==='private'?'private':'public';account.value=accountId;accountEdited=true;channel.value=ch;select({userId,accountId,channel:ch,label:userId,identityConfirmed:true});loadUsers();}
  function useView(route=ctx.route){const requested=route?.params?.get('view'),next=['users','experiences','policy'].includes(requested)?requested:'users';if(view&&next!==view&&dirty()){edits.clear();policy=null;policySaved='';experiences?.dispose();experiences=null;set(experiencePane);if(current)renderDetails();}if(next==='users'&&route?.params?.has('user')&&route.params.get('user')!==selected?.userId&&itemDirty()){edits.clear();if(current)renderDetails();}view=next;userPane.hidden=next!=='users';experiencePane.hidden=next!=='experiences';policyPane.hidden=next!=='policy';for(const button of tabs.children)button.setAttribute('aria-pressed',String(button.dataset.memoryView===next));if(next==='users'){if(route?.params?.has('user'))useRoute(route);else if(!usersLoaded)loadUsers();}else if(next==='policy'&&!policy)loadPolicy();else if(next==='experiences'&&!experiences){experiences=mountExperiences(experiencePane);const box=experiencePane.querySelector('details');if(box)box.open=true;}}
  const onRoute=e=>{if(e.detail.page==='memory'||(e.detail.page==='settings'&&e.detail.section==='memory'))useView(e.detail);};window.addEventListener('panel-route',onRoute);
  useView();
  return () => { alive = false; cleanup(); experiences?.dispose();narrow.removeEventListener('change',responsive); offStatus(); window.removeEventListener('panel-route',onRoute); };
}
