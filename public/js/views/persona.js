import { h, set, fmtDateTime } from '../dom.js';
import { api } from '../api.js';
import { notice } from '../state.js';
import { mount as mountReplay } from './persona-replay.js';
import { field, empty, money, editorGuard, errorBox, billingBadge } from '../view-utils.js';

const DAILY_STATUS = { ready: '已生成', unavailable: '当前账号未确认', missing: '暂无当日日程', absent: '暂无当日日程', generating: '正在生成', failed: '生成失败', backoff: '失败后退避', exhausted: '当天自动尝试已用完', paused: '业务暂停', superseded: '旧结果已被新修订取代' };
const DAILY_SOURCE = { automatic: '自动生成', 'manual-generation': '人工重新生成', 'manual-edit': '人工编辑' };

export function mount(root, ctx) {
  let alive = true, saved = '', savedDaily = '', revision = 0, persona = null, daily = null, dailyDraft = null;
  let promptHints = null, hintSaved = '', hintRevision = 0;
  let replayCleanup = () => {};
  let previewBusy = false, saving = false, dailyBusy = false, dailySaving = false, messages = [];
  const sections = h('div', { class: 'stack' });
  const rules = h('div', { class: 'stack' });
  const fixed = h('pre', { id: 'fixed-rules', class: 'pre-wrap muted' });
  const tally = h('span', { class: 'muted small' });
  const content = h('div', { class: 'stack' }, empty('正在读取人设…'));
  const dailyBox = h('div', { class: 'stack' }, empty('正在读取当日日程…'));
  const dailyEditor = h('div', { class: 'stack' });
  const chat = h('div', { class: 'chat-history', 'aria-live': 'polite' });
  const result = h('div', { class: 'stack' });
  const message = h('textarea', { id: 'preview-message', class: 'input', rows: 3, maxlength: 4000, placeholder: '输入模拟用户消息…' });
  const channel = h('select', { id: 'preview-channel', class: 'input' }, h('option', { value: 'public' }, '公开互动'), h('option', { value: 'private' }, '私信'));
  const memory = h('textarea', { id: 'preview-memory', class: 'input', rows: 2, maxlength: 4000, placeholder: '可选，只在本次试聊使用的模拟记忆' });
  const previewDaily = h('textarea', { id: 'preview-daily', class: 'input', rows: 2, maxlength: 4000, placeholder: '可选，试聊中的虚构日程' });
  const previewButton = h('button', { id: 'persona-preview', class: 'btn primary', type: 'button', onclick: preview }, '发送试聊 ', billingBadge());
  const save = h('button', { id: 'persona-save', class: 'btn primary', type: 'button', onclick: savePersona }, '保存人设');
  const add = h('button', { id: 'trigger-add', class: 'btn', type: 'button', onclick: () => {
    persona.triggers.push({ id: crypto.randomUUID(), title: '', condition: '', content: '', match:'semantic', enabled: true, order: persona.triggers.length }); renderRules(); update();
  } }, '添加触发规则');
  const page = h('div', { class: 'stack' }, h('div', {}, h('h1', { class: 'page-title' }, '人设')),
    content,
    h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '虚构日程'), dailyBox, dailyEditor),
    h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '多轮试聊'),
      h('div', { class: 'grid2' }, field('互动场景', channel), field('模拟记忆', memory)),
      field('模拟虚构日程', previewDaily), chat, field('本轮消息', message),
      h('div', { class: 'toolbar' }, previewButton, h('button', { type: 'button', class: 'btn', onclick: resetChat }, '开始新对话'), null), result));
  const panels = [content, page.children[2], page.children[3]];
  const tabs = h('div', { class:'segmented', role:'tablist', 'aria-label':'人设分区' });
  const names = [['persona','人设'],['daily','今日日程'],['preview','试聊']];
  for (const [id,title] of names) tabs.append(h('button', { class:'btn', id:'persona-tab-'+id, type:'button', role:'tab', onclick:()=>{location.hash='#/persona/'+id;} }, title));
  page.children[0].after(tabs);
  const selectTab = (target=ctx.route) => { const selected = names.some(([id])=>id===target.section)?target.section:'persona'; names.forEach(([id],i)=>{panels[i].hidden=id!==selected; tabs.children[i].setAttribute('aria-selected',String(id===selected)); tabs.children[i].setAttribute('aria-pressed',String(id===selected));}); };
  const routeListener=e=>{if(e.detail.page==='persona')selectTab(e.detail);};
  window.addEventListener('panel-route',routeListener); selectTab();
  set(root, page);
  const dirty = () => (promptHints && JSON.stringify(promptHints)!==hintSaved) || (!!persona && JSON.stringify(persona) !== saved) || (!!dailyDraft && JSON.stringify(dailyDraft) !== savedDaily);
  const cleanup = editorGuard(ctx, page, dirty);
  channel.addEventListener('change', resetChat);

  function update() {
    if (!persona) return;
    const length = persona.sections.reduce((n, x) => n + x.content.length, 0) + persona.triggers.reduce((n, x) => n + x.condition.length + x.content.length + (x.keywords||[]).reduce((sum,word)=>sum+word.length,0), 0);
    tally.textContent = length.toLocaleString() + ' / 20,000 字符' + (JSON.stringify(persona) !== saved ? ' · 未保存' : ' · 已保存');
    tally.className = length > 20000 ? 'bad small' : 'muted small';
    save.disabled = saving || length > 20000;
  }
  function renderSections() {
    set(sections, persona.sections.map((section, index) => {
      const input = h('textarea', { id: 'persona-section-' + index, class: 'input', rows: index === 0 ? 7 : 4, value: section.content, oninput: e => { section.content = e.target.value; update(); } });
      return field(section.title, input);
    }));
  }
  function renderRules() {
    set(rules, persona.triggers.length ? persona.triggers.map((rule, index) => {
      const edit = (key, rows, label) => field(label, h(rows ? 'textarea' : 'input', { class: 'input', rows: rows || undefined, value: rule[key], oninput: e => { rule[key] = e.target.value; update(); } }));
      const condition=h('textarea',{class:'input',rows:2,value:rule.condition,oninput:e=>{rule.condition=e.target.value;update();}});
      const mode=h('select',{class:'input','aria-label':'触发方式'},h('option',{value:'semantic'},'语义判断'),h('option',{value:'keywords'},'关键词（不调用模型）'));
      mode.value=rule.match||'semantic';
      const keywords=h('textarea',{class:'input',rows:3,maxlength:2000,'aria-label':'关键词（每行一个）',placeholder:'怎么做\n教程\n步骤',value:(rule.keywords||[]).join('\n')});
      const keywordBox=h('div',{class:'stack',hidden:mode.value!=='keywords'},field('关键词（每行一个）',keywords,'1–30 个，每个 1–40 字符；只匹配当前消息正文。'));
      const autoCondition=()=>{if(rule.match==='keywords'&&!rule.condition.trim()&&(rule.keywords||[]).length){rule.condition='消息包含以下任一关键词：'+rule.keywords.join('、');condition.value=rule.condition;}};
      mode.onchange=()=>{rule.match=mode.value;keywordBox.hidden=mode.value!=='keywords';autoCondition();update();};
      keywords.oninput=()=>{const oldGenerated='消息包含以下任一关键词：'+(rule.keywords||[]).join('、');const generated=rule.condition===oldGenerated;rule.keywords=keywords.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(generated)rule.condition='';autoCondition();update();};
      return h('section', { class: 'subcard', dataset: { rule: rule.id } },
        h('div', { class: 'toolbar' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: rule.enabled, onchange: e => { rule.enabled = e.target.checked; update(); } }), '启用'),
          h('span', { class: 'muted small grow' }, '规则 ' + (index + 1)),
          h('button', { class: 'btn small', type: 'button', disabled: index === 0, onclick: () => moveRule(index, -1) }, '上移'),
          h('button', { class: 'btn small', type: 'button', disabled: index === persona.triggers.length - 1, onclick: () => moveRule(index, 1) }, '下移'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => { persona.triggers.splice(index, 1); renumber(); renderRules(); update(); } }, '删除规则')),
        edit('title', 0, '名称'),field('触发方式',mode),keywordBox,field('自然语言触发条件',condition,'关键词规则未填写时，将按关键词自动生成条件说明。'), edit('content', 4, '命中后加入的提示词'));
    }) : empty('尚未添加触发规则。回复直接使用静态分区，不产生语义判定调用。'));
  }
  function renumber() { persona.triggers.forEach((x, i) => { x.order = i; }); }
  function moveRule(index, delta) { const other = index + delta; [persona.triggers[index], persona.triggers[other]] = [persona.triggers[other], persona.triggers[index]]; renumber(); renderRules(); update(); }
  async function loadPersona() {
    try {
      const data = await api('/api/persona'); if (!alive) return;
      persona = structuredClone(data.persona); revision = data.revision; saved = JSON.stringify(persona);
      fixed.textContent = data.fixedRules;
      set(content, h('section', { class: 'card stack' }, h('h2', { class: 'card-h' }, '始终生效的静态分区'), sections),
        h('details', { class: 'card stack' }, h('summary', {}, '语义与关键词触发规则'), h('div', { class:'toolbar' }, add), rules),
        h('details', { class: 'card' }, h('summary', {}, '固定系统约束 · 只读'), fixed), h('div', { class: 'toolbar' }, save, tally));
      renderSections(); renderRules(); update();
      mountHints();
      const replayBox=h('details',{class:'card'},h('summary',{},'回放对比与质量统计')); const replayBody=h('div',{class:'settings-body stack'}); replayBox.append(replayBody);content.append(replayBox);let replayOff=null;replayBox.ontoggle=()=>{if(replayBox.open&&!replayOff)replayOff=mountReplay(replayBody,{getCandidate:()=>({persona:structuredClone(persona),personaRevision:revision,promptHints:promptHints?structuredClone(promptHints):undefined})});}; replayCleanup=()=>replayOff?.();
    } catch (e) { if (alive) errorBox(content, e, loadPersona); }
  }
  async function savePersona() {
    if (!persona || saving) return; saving = true; update();
    for(const rule of persona.triggers)if(rule.match==='keywords'&&!rule.condition.trim()&&(rule.keywords||[]).length)rule.condition='消息包含以下任一关键词：'+rule.keywords.join('、');
    const snapshot = structuredClone(persona);
    try { const data = await api('/api/persona', { method: 'PUT', body: { persona: snapshot, revision } }); if (!alive) return; revision = data.revision; const normalized=data.persona||snapshot;saved = JSON.stringify(normalized);if(JSON.stringify(persona)===JSON.stringify(snapshot)){persona=structuredClone(normalized);renderSections();renderRules();} notice('人设已保存，下一轮处理生效', 'ok'); }
    catch (e) { notice(e.message, 'error'); }
    finally { saving = false; update(); }
  }
  function resetChat() { if (previewBusy) return; messages = []; set(chat); set(result); }
  async function preview() {
    if (!persona || previewBusy || !message.value.trim()) return;
    const text = message.value.trim(); previewBusy = true; previewButton.disabled = true; channel.disabled = true; previewButton.textContent = '正在试聊…';
    const submittedMessage = message.value;
    const draftMessages = [...messages, { role: 'user', text }];
    try {
      const data = await api('/api/persona/preview', { method: 'POST', timeoutMs: 360000, body: { persona, channel: channel.value, messages: draftMessages, memory: memory.value, dailyState: previewDaily.value, ...(promptHints ? {promptHints} : {}) } });
      if (!alive) return; messages = draftMessages; if (message.value === submittedMessage) message.value = '';
      if (data.draft?.action === 'reply') messages.push({ role: 'assistant', text: data.draft.text });
      set(chat, messages.map(x => h('div', { class: 'chat-message', dataset: { role: x.role } }, h('b', {}, x.role === 'user' ? '模拟用户' : '角色'), h('div', { class: 'pre-wrap' }, x.text))));
      set(result, data.error ? h('div', { class: 'callout bad' }, data.error) : null, data.warning ? h('div', { class: 'callout warn' }, data.warning) : null,
        data.draft?.action === 'skip' ? h('div', { class: 'callout warn' }, '跳过：' + data.draft.reason) : null,
        h('div', { class: 'status-line' }, '本轮 ' + (data.fees?.requests ?? data.calls?.length ?? 0) + ' 次调用 · ' + (data.latencyMs ?? 0) + ' ms · 估算 ' + money(data.fees?.estimatedUsd) + ' · 未定价 ' + (data.fees?.unpriced ?? 0) + ' · 未知 ' + (data.fees?.unknown ?? 0)),
        data.postingPolicy ? h('div',{class:'small muted'},'公开长度策略：'+(data.postingPolicy.simulation?'普通账号模拟':data.postingPolicy.accountId||'当前账号')+' · '+(data.postingPolicy.rule?.limit??280)+' '+({'weighted-characters':'加权字符','normalized-code-points':'规范化码点','javascript-characters':'JS字符'}[data.postingPolicy.rule?.unit]||'加权字符')) : null,
        data.meta ? h('div',{class:'small muted'},'提示词 '+(data.meta.promptVersion||'未知')+' · '+(data.meta.sampleSource||'模拟采样')+' · 样本 '+(data.meta.sampleCount??0)) : null,
        data.hints?.length ? h('details',{},h('summary',{},'动态提醒（'+data.hints.length+'）'),data.hints.map(x=>h('div',{class:'subcard small'},x.text,h('div',{class:'muted'},x.reason)))) : null,
        h('div', {}, h('h3', {}, '语义命中'), data.hits?.length ? data.hits.map(x => h('div', { class: 'subcard' }, h('b', {}, x.title), h('p', {}, x.reason))) : empty('本轮没有命中规则')),
        h('div', {}, h('h3', {}, '实际提示词分段'), (data.segments ?? []).map(x => h('details', { class: 'subcard' }, h('summary', {}, (x.title || x.kind)+' · '+(x.role==='system'?'系统层':'消息层')+' · '+(x.stable?'稳定前缀':'动态内容')), h('pre', { class: 'pre-wrap' }, x.content)))),
        h('a', { href: '#/billing' }, '到计费页查看原调用流水 →'));
    } catch (e) { notice(e.message, 'error'); }
    finally { previewBusy = false; previewButton.disabled = false; channel.disabled = false; set(previewButton,'发送试聊 ',billingBadge()); }
  }
  async function loadDaily() {
    try { const data = await api('/api/persona/daily'); if (!alive) return; daily = data; dailyDraft = null; savedDaily = ''; renderDaily(); }
    catch (e) { if (alive) errorBox(dailyBox, e, loadDaily); }
  }
  function renderDaily() {
    const today = daily.today;
    set(dailyBox, h('div', { class: 'toolbar' }, h('span', { class: 'chip o' }, '虚构设定'), h('span', {}, daily.date), h('span', { class: 'muted small' }, '计划 ' + (daily.scheduleTime || '06:00') + ' · 北京时间'), h('a', { href: '#/settings/tasks' }, '调整计划 →')),
      h('div', { class: 'status-line' }, '状态：' + (DAILY_STATUS[daily.status] || daily.status || (today ? '已生成' : '暂无')) + ' · 自动尝试 ' + (daily.attempts ?? 0) + '/3' + (daily.nextRetryAt ? ' · 下次可重试 ' + fmtDateTime(daily.nextRetryAt) : '')),
      daily.error ? h('div', { class: 'callout warn' }, daily.error) : null,
      today ? h('div', {}, h('div', { class: 'muted small' }, '来源：' + (DAILY_SOURCE[today.source] || today.source || '模型生成') + ' · ' + fmtDateTime(today.generatedAt) + ' · 修订 ' + today.revision),
        renderDailyContent(today.content, daily.currentPeriod)) : empty('暂无当日虚构日程。不会沿用昨日内容。'),
      daily.fees ? h('div', { class: 'status-line' }, '关联模型调用 ' + (daily.fees.requests ?? 0) + ' 次 · 估算 ' + money(daily.fees.estimatedUsd) + ' · 未定价 ' + (daily.fees.unpriced ?? 0) + ' · 未知 ' + (daily.fees.unknown ?? 0)) : null,
      h('div', { class: 'toolbar' }, h('button', { id: 'daily-regenerate', class: 'btn', type: 'button', disabled: dailyBusy || dailySaving, onclick: generateDaily }, dailyBusy ? '正在生成…' : '重新生成当日日程',billingBadge()),
        h('button', { id: 'daily-edit', class: 'btn', type: 'button', disabled: dailyBusy || dailySaving, onclick: editDaily }, '编辑日程'),
        null),
      h('details', {}, h('summary', {}, '近七日日程历史'), (daily.history ?? []).length ? daily.history.map(item => h('details', { class: 'subcard' }, h('summary', {}, (item.content?.date || item.date) + ' · 修订 ' + item.revision + ' · ' + fmtDateTime(item.generatedAt)), renderDailyContent(item.content))) : empty('暂无历史')));
    if (!dailyDraft) set(dailyEditor);
  }
  function renderDailyContent(value, current) {
    if (!value) return empty('日程内容不可用');
    return h('div', { class: 'stack' }, h('ul', { class: 'timeline' }, (value.periods ?? []).map(period => h('li', { class: current && (current.start === period.start || current === period.activity) ? 'current' : '' }, h('span', { class: 'muted small' }, period.start + '—' + period.end), h('div', {}, period.activity)))),
      h('div', { class: 'grid3' }, ['breakfast', 'lunch', 'dinner'].map((key, index) => h('div', {}, h('b', {}, ['早餐', '午餐', '晚餐'][index]), h('div', { class: 'pre-wrap' }, value.meals?.[key] || '暂无')))),
      h('div', { class: 'pre-wrap' }, '活动：' + (value.activities ?? []).join('；')), h('div', { class: 'pre-wrap' }, '心情：' + (value.mood || '暂无')));
  }
  async function generateDaily() {
    if (dailyBusy || dailySaving) return; dailyBusy = true; renderDaily();
    if (dailyDraft && JSON.stringify(dailyDraft) !== savedDaily) { dailyBusy = false; renderDaily(); notice('请先保存或取消当前日程编辑', 'error'); return; }
    try { const response = await api('/api/persona/daily/generate', { method: 'POST', body: { revision: daily.today?.revision ?? 0 }, timeoutMs: 180000 }); if (alive) { await loadDaily(); if (response.status === 'ready' && response.state) notice('当日日程已生成', 'ok'); else notice(response.error || DAILY_STATUS[response.status] || '当日日程尚未生成，请查看状态', response.status === 'generating' ? 'info' : 'error'); } }
    catch (e) { notice(e.message, 'error'); }
    finally { dailyBusy = false; if (alive) renderDaily(); }
  }
  function editDaily() {
    if (dailyDraft) { dailyEditor.scrollIntoView({ block: 'nearest' }); return; }
    dailyDraft = structuredClone(daily.today?.content || { date: daily.date, fictional: true, periods: [], meals: { breakfast: '', lunch: '', dinner: '' }, activities: [], mood: '' });
    savedDaily = JSON.stringify(dailyDraft); renderDailyEditor();
  }
  function renderDailyEditor() {
    const periods = h('div', { class: 'stack' }, dailyDraft.periods.map((period, index) => h('div', { class: 'period-editor' },
      field('开始', h('input', { type: 'time', class: 'input', value: period.start, onchange: e => { period.start = e.target.value; } })),
      field('结束', h('input', { type: 'time', class: 'input', value: period.end, onchange: e => { period.end = e.target.value; } })),
      field('活动', h('input', { class: 'input', value: period.activity, oninput: e => { period.activity = e.target.value; } })),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { dailyDraft.periods.splice(index, 1); renderDailyEditor(); } }, '删除时段'))));
    const saveDaily = h('button', { id: 'daily-save', class: 'btn primary', type: 'button', onclick: async () => {
      if (dailySaving) return; dailySaving = true;
      const snapshot = structuredClone(dailyDraft);
      for (const element of dailyEditor.querySelectorAll('input,textarea,button')) element.disabled = true;
      renderDaily();
      try { await api('/api/persona/daily', { method: 'PUT', body: { date: daily.date, content: snapshot, revision: daily.today?.revision ?? 0 } }); if (alive) { await loadDaily(); notice('虚构日程已保存', 'ok'); } }
      catch (e) { notice(e.message, 'error'); } finally { dailySaving = false; if (alive) { renderDaily(); if (dailyDraft) renderDailyEditor(); } }
    } }, '保存日程');
    set(dailyEditor, h('div', { class: 'subcard stack' }, h('h3', {}, '编辑当日虚构日程'), periods,
      h('button', { class: 'btn', type: 'button', onclick: () => { dailyDraft.periods.push({ start: '09:00', end: '10:00', activity: '' }); renderDailyEditor(); } }, '添加时段'),
      h('div', { class: 'grid3' }, ['breakfast', 'lunch', 'dinner'].map((key, i) => field(['早餐', '午餐', '晚餐'][i], h('input', { class: 'input', value: dailyDraft.meals[key], oninput: e => { dailyDraft.meals[key] = e.target.value; } })))),
      field('活动（每行一项）', h('textarea', { class: 'input', rows: 3, value: dailyDraft.activities.join('\n'), oninput: e => { dailyDraft.activities = e.target.value.split('\n').filter(Boolean); } })),
      field('心情', h('input', { id: 'daily-mood', class: 'input', value: dailyDraft.mood, oninput: e => { dailyDraft.mood = e.target.value; } })),
      h('div', { class: 'toolbar' }, saveDaily, h('button', { class: 'btn', type: 'button', onclick: () => { dailyDraft = null; savedDaily = ''; set(dailyEditor); } }, '取消编辑'))));
  }
  async function mountHints() {
    const box=h('details',{class:'card'},h('summary',{},'动态提醒')); const body=h('div',{class:'settings-body stack'});box.append(body);content.append(box);
    try {const d=await api('/api/persona/prompt-hints');if(!alive)return;promptHints=structuredClone(d.promptHints);hintRevision=d.revision;hintSaved=JSON.stringify(promptHints);
      const fields=[['lateEnabled','迟到提醒'],['languageEnabled','跟随对方语言'],['openingEnabled','避免开头重复'],['expressionEnabled','表情节制'],['replyCheckEnabled','生成前自检']];
      set(body,h('div',{class:'grid2'},fields.map(([key,label])=>h('label',{class:'check'},h('input',{type:'checkbox',checked:!!promptHints[key],onchange:e=>{promptHints[key]=e.target.checked;}}),label))),h('div',{class:'grid2'},[['lateMinutes','迟到阈值（分钟）',30,360],['openingCount','开头采样数量',1,12],['kaomojiPer10','每10条颜文字次数',0,10],['emojiPer10','每10条 emoji 次数',0,10],['tildePer10','每10条波浪号次数',0,10]].map(([key,label,min,max])=>field(label,h('input',{class:'input',type:'number',min,max,value:promptHints[key],oninput:e=>{promptHints[key]=Number(e.target.value);}})))),h('button',{class:'btn primary',onclick:async e=>{const b=e.currentTarget;b.disabled=true;try{const value=structuredClone(promptHints),r=await api('/api/persona/prompt-hints',{method:'PUT',body:{promptHints:value,revision:hintRevision}});hintRevision=r.revision;hintSaved=JSON.stringify(value);notice('动态提醒已保存，下一轮生效','ok');}catch(error){notice(error.message,'error');}finally{b.disabled=false;}}},'保存提醒'));
    }catch(e){errorBox(body,e);}
  }
  loadPersona(); loadDaily();
  return () => { alive = false; cleanup(); replayCleanup(); window.removeEventListener('panel-route',routeListener); };
}
