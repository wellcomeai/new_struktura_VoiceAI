/* ============================================================================
 * agent/chat.js — Чат с оркестратором (стриминг ответов и tool-status) → /api/agent/chat[/stream]
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные,
 * доступны между всеми файлами agent/*.js и из inline-onclick в разметке.
 * Подключается из agent.html. Документация: backend/static/agent/CLAUDE.md
 * ========================================================================== */

// ════════════════ CHAT ════════════════
// Пул из 25 подсказок. При каждом новом чате показываем случайные 10.
// icon — FontAwesome, label — текст на плитке, prompt — что уйдёт агенту.
const CHAT_SUGGESTIONS = [
  { icon:'fa-chart-pie',        label:'Статистика агента',     prompt:'Покажи мою статистику за всё время' },
  { icon:'fa-compass',          label:'Воронка контактов',     prompt:'Покажи разбивку контактов по стадиям воронки' },
  { icon:'fa-person-walking',   label:'Кто в работе',          prompt:'Покажи контакты в стадии «в работе»' },
  { icon:'fa-circle-check',     label:'Успешные',              prompt:'Покажи контакты со стадией «успех»' },
  { icon:'fa-ban',              label:'Отказы',                prompt:'Покажи контакты, которые отказались' },
  { icon:'fa-user-plus',        label:'Последние контакты',    prompt:'Покажи последние добавленные контакты' },
  { icon:'fa-calendar-day',     label:'Расписание на сегодня', prompt:'Какие звонки запланированы на сегодня?' },
  { icon:'fa-calendar-week',    label:'Расписание на неделю',  prompt:'Покажи расписание звонков на ближайшую неделю' },
  { icon:'fa-forward',          label:'Ближайшие звонки',      prompt:'Покажи мои ближайшие запланированные звонки' },
  { icon:'fa-calendar-plus',    label:'Запланировать звонок',  prompt:'Помоги запланировать звонок контакту' },
  { icon:'fa-phone-slash',      label:'Недозвоны',             prompt:'Покажи, кому не дозвонились — очередь на перезвон' },
  { icon:'fa-chart-line',       label:'Отчёт за неделю',       prompt:'Сделай отчёт по звонкам за последнюю неделю' },
  { icon:'fa-calendar-check',   label:'Отчёт за месяц',        prompt:'Сделай отчёт по звонкам за последний месяц' },
  { icon:'fa-clock-rotate-left',label:'Последние звонки',      prompt:'Покажи историю последних звонков' },
  { icon:'fa-bullseye',         label:'Конверсия',             prompt:'Какая у меня конверсия звонков за неделю?' },
  { icon:'fa-user',             label:'Добавить контакт',      prompt:'Хочу добавить новый контакт в базу обзвона' },
  { icon:'fa-file-import',      label:'Импорт списка',         prompt:'Помоги загрузить список контактов для обзвона' },
  { icon:'fa-rocket',           label:'Обзвонить новых',       prompt:'Запланируй обзвон всех новых контактов' },
  { icon:'fa-phone-volume',     label:'Позвонить сейчас',      prompt:'Позвони контакту прямо сейчас' },
  { icon:'fa-circle-pause',     label:'Пауза по контакту',     prompt:'Поставь контакт на паузу — не звонить какое-то время' },
  { icon:'fa-lightbulb',        label:'Что ты умеешь',         prompt:'Что ты умеешь? Расскажи о своих возможностях' },
  { icon:'fa-mug-hot',          label:'Итоги дня',             prompt:'Подведи итоги звонков за сегодня' },
  { icon:'fa-clock',            label:'Лучшее время звонка',   prompt:'В какое время лучше звонить моим контактам?' },
  { icon:'fa-rotate',           label:'Кого перезвонить',      prompt:'Кому стоит перезвонить в первую очередь?' },
  { icon:'fa-receipt',          label:'Сводка по агенту',      prompt:'Дай краткую сводку: контакты, задачи, звонки' },
];

function pickSuggestions(n){
  const arr = CHAT_SUGGESTIONS.slice();
  for(let i=arr.length-1; i>0; i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr.slice(0, n);
}

// Рисует приветственный экран с 10 случайными плитками в окно чата.
function renderWelcome(){
  const msgs = document.getElementById('chat-messages');
  if(!msgs) return;
  msgs.innerHTML = '';
  const tiles = pickSuggestions(10).map(s =>
    `<button class="chat-tile" onclick="suggestionClick(this)" data-prompt="${esc(s.prompt)}">
       <span class="chat-tile-ic"><i class="fas ${s.icon}"></i></span>
       <span class="chat-tile-label">${esc(s.label)}</span>
     </button>`
  ).join('');
  const wrap = document.createElement('div');
  wrap.className = 'chat-welcome';
  wrap.id = 'chat-welcome';
  wrap.innerHTML =
    `<img class="chat-welcome-img" src="/static/images/IMG_2820.PNG" alt="Voicyfy">
     <div class="chat-welcome-title">Привет!<br>Я ваш агент Voicyfy</div>
     <div class="chat-welcome-sub">Помогаю управлять обзвоном: контакты, задачи, звонки и аналитика.<br>Выберите подсказку или напишите запрос сами.</div>
     <div class="chat-tiles">${tiles}</div>`;
  msgs.appendChild(wrap);
}

// Убирает приветственный экран (когда начинается диалог).
function hideWelcome(){
  const w = document.getElementById('chat-welcome');
  if(w) w.remove();
}

// Клик по плитке → отправляем её текст как сообщение агенту.
function suggestionClick(el){
  const prompt = el.getAttribute('data-prompt') || '';
  if(!prompt) return;
  const inp = document.getElementById('chat-input');
  if(inp) inp.value = prompt;
  sendMessage();
}

// Начать новый диалог: чистим серверную историю + показываем welcome заново.
async function newChat(){
  const btn = document.getElementById('chat-new-btn');
  if(btn) btn.disabled = true;
  try{ await apiFetch(API + '/chat/clear', { method:'POST' }); }catch(e){}
  renderWelcome();
  if(btn) btn.disabled = false;
  const inp = document.getElementById('chat-input');
  if(inp) inp.focus();
}

const TOOL_LABELS = {
  get_contact_call_history:'Изучаю историю звонков', get_agent_contacts:'Загружаю контакты',
  get_agent_stats:'Считаю статистику', get_agent_tasks:'Проверяю задачи',
  create_agent_contact:'Создаю контакт', create_agent_task:'Планирую звонок',
  update_contact_memory:'Обновляю память контакта', send_telegram_notification:'Отправляю уведомление',
  update_contact_info:'Обновляю данные контакта', move_contact_stage:'Меняю стадию воронки',
  delete_agent_task:'Удаляю задачу',
  search_contacts:'Ищу контакты', get_contact_details:'Открываю карточку контакта',
  get_contacts_by_stage:'Считаю воронку', bulk_create_contacts:'Добавляю контакты',
  delete_agent_contact:'Удаляю контакт', append_contact_note:'Дописываю заметку',
  update_agent_task:'Переношу звонок', get_upcoming_schedule:'Смотрю расписание',
  bulk_schedule_calls:'Планирую серию звонков', trigger_immediate_call:'Звоню прямо сейчас',
  snooze_contact:'Ставлю контакт на паузу', get_call_transcript:'Открываю транскрипт',
  get_period_report:'Готовлю отчёт за период', get_failed_calls:'Собираю недозвоны',
};

async function sendMessage(){
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if(!text) return;
  inp.value=''; inp.style.height='auto';
  hideWelcome();
  addBubble(text,'user');
  document.getElementById('chat-send').disabled = true;
  const t0 = Date.now();

  // Fallback на старый /chat (legacy v2-агенты или сбой стрима).
  async function fallbackToPlainChat(stream){
    if(stream) stream.remove();
    const tId = showTyping();
    try{
      const r = await apiFetch(API + '/chat', { method:'POST', body:JSON.stringify({ message:text }) });
      removeTyping(tId);
      if(r && r.status===200){
        const d = await r.json();
        const el = ((Date.now()-t0)/1000).toFixed(1);
        addAgentBubble(d.reply, d.debug_log||[], el);
        loadStats(); loadRecentCalls(); loadTasks();
      } else {
        const err = await r?.json().catch(()=>({}));
        addBubble(errText(err.detail),'assistant');
      }
    }catch(e){ removeTyping(tId); addBubble('Ошибка сети.','assistant'); }
  }

  const stream = createStreamingBubble();
  let st = { acc:'', toolEvents:[], bubble:stream.bubble, status:stream.status,
             think:stream.think, t0, raf:null, dirty:false, done:false };
  try{
    const token = getToken();
    if(!token){ location.href='/static/login.html'; return; }
    const resp = await fetch(withAgentId(API + '/chat/stream'), {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json' },
      body: JSON.stringify({ message:text }),
    });

    if(resp.status===401){ localStorage.removeItem('auth_token'); location.href='/static/login.html'; return; }
    if(!resp.ok || !resp.body){
      // 409 (legacy v2) или сетевой сбой → fallback на обычный /chat.
      if(resp.status===409){ await fallbackToPlainChat(stream.wrap); document.getElementById('chat-send').disabled=false; return; }
      if(resp.status===402){ await handle402(resp); stream.wrap.remove(); document.getElementById('chat-send').disabled=false; return; }
      if(resp.status===400 || resp.status===404){
        const err = await resp.json().catch(()=>({}));
        stream.wrap.remove(); addBubble(errText(err.detail),'assistant');
        document.getElementById('chat-send').disabled=false; return;
      }
      await fallbackToPlainChat(stream.wrap); document.getElementById('chat-send').disabled=false; return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while(true){
      const { value, done } = await reader.read();
      if(done) break;
      buf += decoder.decode(value, { stream:true });
      let nl;
      while((nl = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
        if(line) handleStreamEvent(JSON.parse(line), st);
      }
    }
    if(buf.trim()){ try{ handleStreamEvent(JSON.parse(buf.trim()), st); }catch(e){} }

    if(!st.done){
      // Поток оборвался без события done — fallback, чтобы не виснуть.
      await fallbackToPlainChat(stream.wrap);
    } else {
      loadStats(); loadRecentCalls(); loadTasks();
    }
  }catch(e){
    if(st.raf) cancelAnimationFrame(st.raf);
    if(!st.done){ await fallbackToPlainChat(stream.wrap); }
  }finally{
    document.getElementById('chat-send').disabled = false;
  }
}

// Создаёт пустой пузырь ассистента с индикатором «думаю» и строкой статуса.
function createStreamingBubble(){
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div'); div.className='msg assistant';
  div.innerHTML = `<div class="msg-avatar">ИИ</div><div class="msg-body">`+
    `<div class="msg-bubble md" data-stream-bubble><div class="typing-row" data-think><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`+
    `<div class="tool-status" data-status style="display:none"></div>`+
    `</div>`;
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
  return {
    wrap: div,
    bubble: div.querySelector('[data-stream-bubble]'),
    status: div.querySelector('[data-status]'),
    think: div.querySelector('[data-think]'),
  };
}

function _streamRender(st){
  st.dirty = false;
  st.bubble.innerHTML = renderMarkdown(st.acc);
  const msgs = document.getElementById('chat-messages');
  msgs.scrollTop = msgs.scrollHeight;
}

function handleStreamEvent(ev, st){
  const msgs = document.getElementById('chat-messages');
  if(ev.type==='start') return;

  if(ev.type==='tool_call'){
    st.toolEvents.push({ ts:Date.now()/1000, type:'tool_call', data:{ tool:ev.tool, args:ev.args } });
    const label = TOOL_LABELS[ev.tool] || ev.tool || 'Инструмент';
    st.status.style.display = 'flex';
    st.status.classList.remove('done');
    st.status.innerHTML = `<span class="ts-spinner"></span><span>${esc(label)}…</span>`;
    msgs.scrollTop = msgs.scrollHeight;
    return;
  }
  if(ev.type==='tool_result'){
    st.toolEvents.push({ ts:Date.now()/1000, type:'tool_result', data:{ tool:ev.tool, result:ev.result } });
    let info = 'готово';
    const res = ev.result;
    if(res && typeof res==='object'){
      const c = res.count!==undefined ? 'найдено: '+res.count : '';
      const ok = res.ok!==undefined ? (res.ok?'успешно':'ошибка') : '';
      info = [c, ok].filter(Boolean).join(' · ') || 'готово';
    }
    st.status.classList.add('done');
    st.status.innerHTML = `<span class="ts-check">✓</span><span>${esc(info)}</span>`;
    return;
  }
  if(ev.type==='tool_error'){
    st.toolEvents.push({ ts:Date.now()/1000, type:'tool_error', data:{ tool:ev.tool, error:ev.error } });
    st.status.classList.add('done');
    st.status.innerHTML = `<span class="ts-check" style="color:var(--danger,#e05)">✕</span><span>ошибка</span>`;
    return;
  }
  if(ev.type==='token'){
    if(st.think){ st.think.remove(); st.think=null; st.bubble.innerHTML=''; }
    if(st.status && st.status.style.display!=='none'){ st.status.style.display='none'; }
    st.acc += ev.text;
    if(!st.dirty){
      st.dirty = true;
      st.raf = requestAnimationFrame(()=>_streamRender(st));
    }
    return;
  }
  if(ev.type==='clear_partial'){
    st.acc = '';
    if(st.bubble) st.bubble.innerHTML = '';
    return;
  }
  if(ev.type==='done'){
    st.done = true;
    if(st.raf) cancelAnimationFrame(st.raf);
    if(st.think){ st.think.remove(); st.think=null; }
    if(st.status){ st.status.remove(); st.status=null; }
    st.bubble.innerHTML = renderMarkdown(ev.reply);
    const el = ((Date.now()-st.t0)/1000).toFixed(1);
    const debugLog = ev.debug_log || st.toolEvents;
    const body = st.bubble.parentElement;
    const dbg = renderDebugBlock(debugLog, el);
    if(dbg){
      // Вставить debug-блок после времени (msg-time добавим, если нет).
      let time = body.querySelector('.msg-time');
      if(!time){
        time = document.createElement('div'); time.className='msg-time';
        time.textContent = new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
        body.appendChild(time);
      }
      time.insertAdjacentHTML('afterend', dbg);
    } else {
      if(!body.querySelector('.msg-time')){
        const time = document.createElement('div'); time.className='msg-time';
        time.textContent = new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
        body.appendChild(time);
      }
    }
    msgs.scrollTop = msgs.scrollHeight;
    return;
  }
  if(ev.type==='error'){
    st.done = true;
    if(st.raf) cancelAnimationFrame(st.raf);
    if(st.think){ st.think.remove(); st.think=null; }
    if(st.status){ st.status.remove(); st.status=null; }
    st.bubble.innerHTML = renderMarkdown(st.acc || 'Ошибка обработки запроса.');
    return;
  }
}

function addBubble(text, role){
  const msgs = document.getElementById('chat-messages');
  const now = new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  const div = document.createElement('div');
  div.className = 'msg '+role;
  const body = role==='user' ? esc(text).replace(/\n/g,'<br>') : renderMarkdown(text);
  const bubbleCls = role==='user' ? 'msg-bubble' : 'msg-bubble md';
  div.innerHTML = `<div class="msg-avatar">${role==='user'?'Вы':'ИИ'}</div><div class="msg-body"><div class="${bubbleCls}">${body}</div><div class="msg-time">${now}</div></div>`;
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}

// Строит блок debug-лога (тег «N действий · Xс» + сворачиваемый список).
// Используется и стрим-путём (handleStreamEvent), и fallback-путём (addAgentBubble).
function renderDebugBlock(debugLog, elapsed){
  debugLog = debugLog || [];
  const toolCalls = debugLog.filter(e=>e.type==='tool_call');
  const logEntries = debugLog.filter(e => ['gpt_thinking','tool_call','tool_result','tool_error','gpt_response'].includes(e.type));
  if(!logEntries.length) return '';
  const logId = 'dbg-'+Date.now()+'-'+Math.floor(Math.random()*1e4);
  const entriesHtml = logEntries.map(e => {
    const typeMap = { gpt_thinking:{cls:'de-thinking',label:'Думаю'}, tool_call:{cls:'de-tool_call',label:e.data?.tool||'Инструмент'}, tool_result:{cls:'de-tool_result',label:'Результат'}, tool_error:{cls:'de-tool_error',label:'Ошибка'}, gpt_response:{cls:'de-gpt_response',label:'Ответ'} };
    const t = typeMap[e.type] || {cls:'de-thinking',label:e.type};
    let main='', detail='';
    if(e.type==='tool_call'){ main = TOOL_LABELS[e.data?.tool]||e.data?.tool||''; const a=e.data?.args; if(a&&Object.keys(a).length) detail=Object.entries(a).slice(0,3).map(([k,v])=>k+': '+(typeof v==='object'?JSON.stringify(v).slice(0,60):String(v).slice(0,60))).join('\n'); }
    else if(e.type==='tool_result'){ const res=e.data?.result; if(res&&typeof res==='object'){ const c=res.count!==undefined?'найдено: '+res.count:''; const ok=res.ok!==undefined?(res.ok?'успешно':'ошибка'):''; main=[c,ok].filter(Boolean).join(' · ')||'получен ответ'; } else main='получен ответ'; }
    else if(e.type==='gpt_thinking'){ main = typeof e.data==='string'?e.data.slice(0,80):'обрабатываю'; }
    else if(e.type==='gpt_response'){ main = typeof e.data==='string'?e.data.slice(0,80):''; }
    else if(e.type==='tool_error'){ main = e.data?.error||'ошибка'; }
    return `<div class="debug-entry"><div class="debug-entry-header"><span class="debug-entry-type ${t.cls}">${t.label}</span>${main?`<span class="debug-entry-text">${esc(main)}</span>`:''}</div>${detail?`<div class="debug-entry-detail">${esc(detail)}</div>`:''}</div>`;
  }).join('');
  const n = toolCalls.length;
  const tag = n>0 ? `${n} ${n===1?'действие':n<5?'действия':'действий'} · ${elapsed}с` : `${elapsed}с`;
  return `<div class="debug-tag" id="tag-${logId}" onclick="toggleLog('${logId}')"><span>${tag}</span><span class="chevron">&#8964;</span></div><div class="debug-log" id="${logId}" style="display:none">${entriesHtml}</div>`;
}

function addAgentBubble(text, debugLog, elapsed){
  const msgs = document.getElementById('chat-messages');
  const now = new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  const div = document.createElement('div'); div.className='msg assistant';
  div.innerHTML = `<div class="msg-avatar">ИИ</div><div class="msg-body"><div class="msg-bubble md">${renderMarkdown(text)}</div><div class="msg-time">${now}</div>${renderDebugBlock(debugLog, elapsed)}</div>`;
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}
function toggleLog(id){ const l=document.getElementById(id), t=document.getElementById('tag-'+id); if(!l||!t)return; const open=l.style.display!=='none'; l.style.display=open?'none':'block'; t.classList.toggle('open',!open); }
function showTyping(){ const msgs=document.getElementById('chat-messages'); const id='typ-'+Date.now(); const div=document.createElement('div'); div.className='msg assistant'; div.id=id; div.innerHTML=`<div class="msg-avatar">ИИ</div><div class="msg-body"><div class="typing-row"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`; msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight; return id; }
function removeTyping(id){ document.getElementById(id)?.remove(); }


