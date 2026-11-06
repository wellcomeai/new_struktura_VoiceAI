/* ============================================================================
 * agent/capabilities.js — меню «Что умеет агент» у поля чата (кнопка рядом с микрофоном).
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные.
 *
 * Две вкладки: «Оркестратор» (инструменты чата и разбора событий —
 * backend/services/agent_tools.py: build_chat_tools) и «Голос в звонке»
 * (функции голосового ассистента агента — _default_voice_functions в
 * backend/api/agent.py + search_pinecone + функции коннекторов
 * TOOLKIT_VOICE_FUNCTIONS). Добавляя тулзу агенту, допишите её сюда.
 * «Спросить ИИ» только вставляет вопрос в поле ввода, не отправляет.
 * ========================================================================== */

// need — пометка «работает, если подключено …» (не скрываем функцию, а поясняем).
const AGENT_CAPS = {
  orchestrator: {
    title: 'Оркестратор',
    icon: 'fa-robot',
    lead: 'Мозг агента. Работает здесь в чате, в Telegram и после каждого звонка или сообщения: ведёт базу, планирует, пишет клиентам и присылает вам отчёты. Просто попросите словами.',
    groups: [
      { name: 'Контакты', items: [
        { id: 'find_contact', icon: 'fa-address-book', name: 'Найти человека', desc: 'По имени, телефону или компании — даже с опечаткой или в другом падеже.' },
        { id: 'search_contacts', icon: 'fa-magnifying-glass', name: 'Подборка по фильтрам', desc: 'Стадия, компания, «не звонили 7 дней», «молчит после сообщения» и т.д.' },
        { id: 'get_contact_details', icon: 'fa-id-card', name: 'Карточка контакта', desc: 'Все данные клиента, стадия, память и ближайший шаг.' },
        { id: 'create_agent_contact', icon: 'fa-user-plus', name: 'Добавить контакт', desc: 'Новый клиент в базу одной фразой.' },
        { id: 'bulk_create_contacts', icon: 'fa-users-rectangle', name: 'Добавить списком', desc: 'Несколько контактов сразу — вставьте список в сообщение.' },
        { id: 'update_contact_info', icon: 'fa-user-pen', name: 'Изменить данные', desc: 'Имя, телефон, компания, email контакта.' },
        { id: 'append_contact_note', icon: 'fa-note-sticky', name: 'Заметка к контакту', desc: 'Дописать комментарий в карточку клиента.' },
        { id: 'update_contact_memory', icon: 'fa-brain', name: 'Память о клиенте', desc: 'Запоминает факты о клиенте, чтобы следующий разговор шёл с учётом прошлого.' },
        { id: 'delete_agent_contact', icon: 'fa-user-minus', name: 'Удалить контакт', desc: 'Убрать клиента из базы вместе с его задачами.' },
      ]},
      { name: 'Воронка', items: [
        { id: 'get_contacts_by_stage', icon: 'fa-filter', name: 'Воронка', desc: 'Сколько клиентов на каждой стадии.' },
        { id: 'move_contact_stage', icon: 'fa-shuffle', name: 'Сменить стадию', desc: 'Перевести клиента: в работе, успех, отказ, «не звонить».' },
        { id: 'bulk_move_contacts_stage', icon: 'fa-layer-group', name: 'Сменить стадию группе', desc: 'Перевести сразу всех по фильтру.' },
        { id: 'snooze_contact', icon: 'fa-circle-pause', name: 'Пауза по контакту', desc: 'Не беспокоить клиента до нужной даты.' },
      ]},
      { name: 'Звонки и задачи', items: [
        { id: 'trigger_immediate_call', icon: 'fa-phone-volume', name: 'Позвонить сейчас', desc: 'Голосовой агент наберёт клиента прямо сейчас.' },
        { id: 'create_agent_task', icon: 'fa-calendar-plus', name: 'Запланировать звонок', desc: 'Звонок или сообщение на нужную дату — хоть через год.' },
        { id: 'bulk_schedule_calls', icon: 'fa-rocket', name: 'Массовый обзвон', desc: 'Обзвон по фильтру с интервалом и в рабочие часы.' },
        { id: 'update_agent_task', icon: 'fa-pen-to-square', name: 'Перенести задачу', desc: 'Сдвинуть время или поменять задание звонка.' },
        { id: 'delete_agent_task', icon: 'fa-trash-can', name: 'Отменить задачу', desc: 'Убрать один запланированный звонок.' },
        { id: 'bulk_cancel_calls', icon: 'fa-circle-xmark', name: 'Отменить группе', desc: 'Снять запланированные звонки сразу у многих.' },
        { id: 'get_upcoming_schedule', icon: 'fa-calendar-days', name: 'Расписание', desc: 'Что запланировано на сегодня, неделю, месяц.' },
        { id: 'get_agent_tasks', icon: 'fa-list-check', name: 'Список задач', desc: 'Все задачи агента с их статусом.' },
        { id: 'schedule_reply_check', icon: 'fa-hourglass-half', name: 'Проверка ответа', desc: 'Через N времени проверит, ответил ли клиент, и решит, что делать дальше.' },
      ]},
      { name: 'История и отчёты', items: [
        { id: 'get_contact_timeline', icon: 'fa-route', name: 'Хронология клиента', desc: 'Все звонки и переписка с клиентом по всем каналам в одной ленте.' },
        { id: 'get_contact_call_history', icon: 'fa-clock-rotate-left', name: 'История звонков', desc: 'Звонки клиента с итогами.' },
        { id: 'get_call_transcript', icon: 'fa-file-lines', name: 'Транскрипт и запись', desc: 'Текст разговора и ссылка на аудиозапись.' },
        { id: 'get_failed_calls', icon: 'fa-phone-slash', name: 'Недозвоны', desc: 'Кому не дозвонились — очередь на перезвон.' },
        { id: 'get_agent_stats', icon: 'fa-chart-pie', name: 'Статистика', desc: 'Звонки, контакты и результаты за всё время.' },
        { id: 'get_period_report', icon: 'fa-chart-line', name: 'Отчёт за период', desc: 'Итоги за день, неделю или месяц: конверсия, отказы, успехи.' },
      ]},
      { name: 'Сообщения клиентам и вам', items: [
        { id: 'send_sms', icon: 'fa-comment-sms', name: 'SMS клиенту', desc: 'Отправить SMS с номера агента.', need: 'номер с SMS' },
        { id: 'telegram_send_message', icon: 'fa-paper-plane', name: 'Написать в Telegram', desc: 'Сообщение клиенту от личного Telegram агента, можно с файлом.', need: 'личный Telegram' },
        { id: 'telegram_get_thread', icon: 'fa-comments', name: 'Переписка в Telegram', desc: 'Прочитать диалог с клиентом.', need: 'личный Telegram' },
        { id: 'schedule_telegram_message', icon: 'fa-clock', name: 'Отложенное в Telegram', desc: 'Сообщение уйдёт в нужное время.', need: 'личный Telegram' },
        { id: 'max_send_message', icon: 'fa-comment', name: 'Написать в MAX', desc: 'Сообщение клиенту в MAX, можно с файлом.', need: 'MAX' },
        { id: 'max_get_thread', icon: 'fa-comments', name: 'Переписка в MAX', desc: 'Прочитать диалог с клиентом в MAX.', need: 'MAX' },
        { id: 'schedule_max_message', icon: 'fa-clock', name: 'Отложенное в MAX', desc: 'Сообщение в MAX уйдёт в нужное время.', need: 'MAX' },
        { id: 'bulk_schedule_messages', icon: 'fa-comments', name: 'Рассылка', desc: 'Персональные сообщения по фильтру в Telegram или MAX.', need: 'Telegram или MAX' },
        { id: 'send_telegram_notification', icon: 'fa-bell', name: 'Уведомить вас', desc: 'Пришлёт вам отчёт, файл или запись звонка в Telegram-бот агента.', need: 'бот агента' },
      ]},
      { name: 'Файлы', items: [
        { id: 'create_pdf_document', icon: 'fa-file-lines', name: 'PDF-документ', desc: 'КП, памятка, отчёт — готовый PDF со ссылкой.' },
        { id: 'create_spreadsheet', icon: 'fa-th', name: 'Таблица Excel', desc: 'Любая таблица в xlsx.' },
        { id: 'export_contacts_table', icon: 'fa-download', name: 'Выгрузка базы', desc: 'Контакты по фильтру или вся база в Excel.' },
        { id: 'read_google_sheet', icon: 'fa-th', name: 'Google Таблица', desc: 'Читает таблицу по открытой ссылке: прайс, наличие, расписание — и находит нужные строки.' },
        { id: 'get_agent_files', icon: 'fa-folder-open', name: 'Мои файлы', desc: 'Документы, которые агент уже создал.' },
      ]},
      { name: 'Знания, память, интеграции', items: [
        { id: 'search_knowledge_base', icon: 'fa-book', name: 'База знаний', desc: 'Ответы по вашим документам: цены, условия, регламенты.', need: 'база знаний' },
        { id: 'update_agent_memory', icon: 'fa-bookmark', name: 'Память агента', desc: 'Запоминает ваши правила и свои наблюдения надолго.' },
        { id: 'send_webhook', icon: 'fa-link', name: 'Вебхук в CRM', desc: 'Передать данные в вашу CRM или сервис.' },
        { id: 'google_calendar', icon: 'fa-calendar-check', name: 'Google Календарь', desc: 'Создать встречу или найти свободное время.', need: 'Google Календарь' },
        { id: 'gmail', icon: 'fa-envelope', name: 'Gmail', desc: 'Отправить письмо или прочитать почту.', need: 'Gmail' },
      ]},
    ],
  },
  voice: {
    title: 'Голос в звонке',
    icon: 'fa-phone',
    lead: 'Говорит с клиентом в самом звонке. Функций у голоса меньше — только то, что нужно прямо в разговоре. Стадию, следующий шаг и отчёт вам делает оркестратор после звонка.',
    groups: [
      { name: 'Всегда включено', items: [
        { id: 'send_sms', icon: 'fa-comment-sms', name: 'SMS во время звонка', desc: 'Клиент просит адрес, ссылку или реквизиты — голос сразу отправит SMS.', need: 'номер с SMS' },
        { id: 'read_google_sheet', icon: 'fa-th', name: 'Google Таблица', desc: 'Смотрит прайс, наличие или расписание по ссылке из инструкций голосового агента.', need: 'ссылка в инструкциях' },
        { id: 'hangup_call', icon: 'fa-phone-slash', name: 'Завершить звонок', desc: 'Вежливо прощается и кладёт трубку, когда разговор окончен.' },
      ]},
      { name: 'Включается при подключении', items: [
        { id: 'search_pinecone', icon: 'fa-book', name: 'База знаний', desc: 'Отвечает по вашим документам прямо в разговоре.', need: 'база знаний' },
        { id: 'google_calendar_create_event', icon: 'fa-calendar-plus', name: 'Записать в календарь', desc: 'Создаёт встречу в Google Календаре во время звонка.', need: 'Google Календарь' },
        { id: 'google_calendar_find_events', icon: 'fa-calendar-days', name: 'Проверить календарь', desc: 'Смотрит занятые слоты, чтобы предложить время.', need: 'Google Календарь' },
        { id: 'gmail_send_email', icon: 'fa-envelope', name: 'Отправить письмо', desc: 'Шлёт клиенту письмо с вашего Gmail.', need: 'Gmail' },
        { id: 'gmail_fetch_emails', icon: 'fa-inbox', name: 'Прочитать почту', desc: 'Находит нужное письмо в вашем Gmail.', need: 'Gmail' },
      ]},
      { name: 'После звонка — оркестратор', items: [
        { id: 'postcall', icon: 'fa-robot', name: 'Разбор звонка', desc: 'Читает разговор, ставит стадию, планирует следующий шаг, пишет вам и клиенту.' },
      ]},
    ],
  },
};

let capsMode = 'orchestrator';
let capsQuery = '';

function capsAskPrompt(mode, item){
  if(mode === 'voice'){
    if(item.id === 'postcall') return 'Расскажи, как ты разбираешь звонок после разговора: что делаешь сам и как мне это настроить.';
    return `Расскажи о функции голосового агента «${item.name}»: что она делает во время звонка, как её включить и что написать в инструкциях голосового агента, чтобы он её использовал.`;
  }
  return `Расскажи о функции «${item.name}»: что она делает, когда её использовать и приведи 2–3 примера запросов.`;
}

function capsFind(mode, id){
  for(const g of AGENT_CAPS[mode].groups) for(const it of g.items) if(it.id === id) return it;
  return null;
}

function renderCapsMenu(){
  const pop = document.getElementById('caps-pop');
  if(!pop) return;
  const conf = AGENT_CAPS[capsMode];
  const q = capsQuery.trim().toLowerCase().replace(/ё/g, 'е');
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const groups = conf.groups.map(g => {
    const items = g.items.filter(it => !q || norm(it.name + ' ' + it.desc + ' ' + (it.need || '')).includes(q));
    if(!items.length) return '';
    return `<div class="caps-group">
      <div class="caps-group-title">${esc(g.name)}</div>
      ${items.map(it => `
        <div class="caps-item">
          <span class="caps-ic"><i class="fas ${it.icon}"></i></span>
          <span class="caps-body">
            <span class="caps-name">${esc(it.name)}${it.need ? `<span class="caps-need" title="Работает, если подключено: ${esc(it.need)}">${esc(it.need)}</span>` : ''}</span>
            <span class="caps-desc">${esc(it.desc)}</span>
          </span>
          <button type="button" class="caps-ask" data-caps-ask="${esc(it.id)}" title="Вставить вопрос об этой функции в сообщение">
            <i class="fas fa-wand-magic-sparkles"></i><span>Спросить ИИ</span>
          </button>
        </div>`).join('')}
    </div>`;
  }).join('');

  const tab = m => `<button type="button" role="tab" class="caps-tab${capsMode === m ? ' active' : ''}" data-caps-mode="${m}" aria-selected="${capsMode === m}">
      <i class="fas ${AGENT_CAPS[m].icon}"></i>${esc(AGENT_CAPS[m].title)}
      <span class="caps-count">${AGENT_CAPS[m].groups.reduce((n, g) => n + g.items.length, 0)}</span>
    </button>`;

  pop.innerHTML = `
    <div class="caps-head">
      <div class="caps-title"><span class="caps-title-ic"><i class="fas fa-screwdriver-wrench"></i></span>Что умеет агент</div>
      <button type="button" class="caps-close" data-caps-close aria-label="Закрыть"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="caps-tabs" role="tablist">${tab('orchestrator')}${tab('voice')}</div>
    <div class="caps-lead">${esc(conf.lead)}</div>
    <div class="caps-search"><i class="fas fa-magnifying-glass"></i>
      <input type="text" id="caps-search" placeholder="Найти функцию…" value="${esc(capsQuery)}" autocomplete="off">
    </div>
    <div class="caps-list">${groups || '<div class="caps-empty">Ничего не нашлось. Спросите агента своими словами — он подскажет.</div>'}</div>
    <div class="caps-foot"><i class="fas fa-circle-info"></i>Функции с пометкой работают, когда подключено нужное: Telegram, MAX, база знаний, календарь.</div>`;
}

function openCapsMenu(){
  const pop = document.getElementById('caps-pop');
  const btn = document.getElementById('chat-caps');
  if(!pop || !btn) return;
  renderCapsMenu();
  pop.hidden = false;
  btn.classList.add('active');
  btn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => pop.classList.add('open'));
}

function closeCapsMenu(){
  const pop = document.getElementById('caps-pop');
  const btn = document.getElementById('chat-caps');
  if(!pop || pop.hidden) return;
  pop.classList.remove('open');
  pop.hidden = true;
  if(btn){ btn.classList.remove('active'); btn.setAttribute('aria-expanded', 'false'); }
}

function toggleCapsMenu(){
  const pop = document.getElementById('caps-pop');
  if(pop && !pop.hidden) closeCapsMenu(); else openCapsMenu();
}

// «Спросить ИИ»: вставляем вопрос в поле ввода (не отправляем — можно дописать).
function capsAsk(id){
  const item = capsFind(capsMode, id);
  const inp = document.getElementById('chat-input');
  if(!item || !inp) return;
  inp.value = capsAskPrompt(capsMode, item);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  closeCapsMenu();
  inp.focus();
  try{ inp.setSelectionRange(inp.value.length, inp.value.length); }catch(e){}
}

document.addEventListener('click', e => {
  const pop = document.getElementById('caps-pop');
  if(!pop || pop.hidden) return;
  const ask = e.target.closest('[data-caps-ask]');
  if(ask){ capsAsk(ask.getAttribute('data-caps-ask')); return; }
  const tab = e.target.closest('[data-caps-mode]');
  if(tab){
    capsMode = tab.getAttribute('data-caps-mode');
    renderCapsMenu();
    return;
  }
  if(e.target.closest('[data-caps-close]')){ closeCapsMenu(); return; }
  if(!e.target.closest('#caps-pop') && !e.target.closest('#chat-caps')) closeCapsMenu();
});

document.addEventListener('input', e => {
  if(e.target && e.target.id === 'caps-search'){
    capsQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderCapsMenu();
    const s = document.getElementById('caps-search');
    if(s){ s.focus(); try{ s.setSelectionRange(pos, pos); }catch(err){} }
  }
});

document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    const pop = document.getElementById('caps-pop');
    if(pop && !pop.hidden){ closeCapsMenu(); const b = document.getElementById('chat-caps'); if(b) b.focus(); }
  }
});
