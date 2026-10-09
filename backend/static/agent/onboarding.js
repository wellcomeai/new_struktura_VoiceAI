/* ============================================================================
 * agent/onboarding.js — Обучающая карусель перед мастером создания агента.
 * 6 слайдов: ИИ-сотрудник в четырёх каналах · хронология клиента · сам ставит
 * себе задачи · пример «продажи» · пример «клиника» · управление в чате.
 * Агент не только для исходящего обзвона: входящие и исходящие, роль задаёт
 * владелец. Показывается ВСЕГДА при создании (с кнопкой «Пропустить»), перед
 * wizard.showWizard() → renderWizard().
 *
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные.
 * Документация: backend/static/agent/CLAUDE.md
 * ========================================================================== */

let obStep = 0;
let obOnDone = null;

// Каналы агента — значок + подпись (MAX своей иконки в Font Awesome не имеет)
const OB_CH = {
  call: '<i class="fas fa-phone"></i> Звонок',
  tg:   '<i class="fab fa-telegram"></i> Telegram',
  max:  '<i class="fas fa-comment-dots"></i> MAX',
  sms:  '<i class="fas fa-comment-sms"></i> SMS',
};

// Иллюстрации — стилизованные мокапы реальных экранов Voicyfy (без картинок).
const OB_SLIDES = [
  {
    badge: 'ИИ-сотрудник',
    title: 'Не робот для звонков, а ваш сотрудник',
    text: 'Агент звонит и принимает звонки, переписывается в Telegram и MAX, отправляет SMS — и помнит всю хронологию по каждому клиенту. Работает и на входящих, и на исходящих: роль вы задаёте сами.',
    art: () => `<div class="ob-art ob-art-intro">
      <div class="ob-orb"><i class="fas fa-user-tie"></i><span class="ob-pulse"></span></div>
      <div class="ob-chips">
        <span class="ob-chip"><i class="fas fa-phone-volume"></i> Входящие и исходящие</span>
        <span class="ob-chip">${OB_CH.tg}</span>
        <span class="ob-chip">${OB_CH.max}</span>
        <span class="ob-chip">${OB_CH.sms}</span>
      </div>
    </div>`,
  },
  {
    badge: 'Память',
    title: 'Помнит всю историю клиента',
    text: 'Когда, о чём и в каком канале вы общались — агент видит единую хронологию. Позвонил клиент после переписки в Telegram — агент продолжит с того места, где остановились.',
    art: () => `<div class="ob-mock">
      <div class="ob-mock-head"><i class="fas fa-timeline"></i> Анна Смирнова · хронология</div>
      <div class="ob-row"><span class="ob-k">12 мар</span><span class="ob-ch">${OB_CH.call}</span><span class="ob-v">спросила цены, попросила прислать КП</span></div>
      <div class="ob-row"><span class="ob-k">12 мар</span><span class="ob-ch">${OB_CH.tg}</span><span class="ob-v">отправил КП файлом</span></div>
      <div class="ob-row"><span class="ob-k">15 мар</span><span class="ob-ch">${OB_CH.max}</span><span class="ob-v">«вернусь после праздников»</span></div>
      <div class="ob-row"><span class="ob-k">11 мая</span><span class="ob-ch">${OB_CH.call}</span><span class="ob-v">договорились о встрече</span></div>
    </div>`,
  },
  {
    badge: 'Сам ставит задачи',
    title: 'Ведёт клиента хоть целый год',
    text: 'После каждого разговора агент решает, что делать дальше, и сам ставит себе задачи: перезвонить, когда просили, напомнить о встрече, проверить, ответил ли клиент. Ни один контакт не теряется.',
    art: () => `<div class="ob-mock">
      <div class="ob-mock-head"><i class="fas fa-list-check"></i> Задачи агента · поставил сам</div>
      <div class="ob-row"><span class="ob-k">через 3 дня</span><span class="ob-v">проверить, ответила ли в Telegram</span></div>
      <div class="ob-row"><span class="ob-k">10 мая</span><span class="ob-v">позвонить после праздников, как просила</span></div>
      <div class="ob-row"><span class="ob-k">за час</span><span class="ob-v">напомнить о встрече по SMS</span></div>
      <div class="ob-row"><span class="ob-k">через месяц</span><span class="ob-v">спросить, как идёт внедрение</span></div>
    </div>`,
  },
  {
    badge: 'Пример · продажи',
    title: 'Менеджер по продажам',
    text: 'Обзванивает холодную базу: выясняет потребность, отвечает на возражения, назначает встречу и отправляет КП в мессенджер. Кто попросил «позже» — получит звонок ровно тогда, когда просил.',
    art: () => `<div class="ob-mock ob-talk">
      <div class="ob-bubble agent">Иван, добрый день! Это Алина из «Ромашки». Удобно пару минут?</div>
      <div class="ob-bubble client">Сейчас занят, наберите в четверг</div>
      <div class="ob-bubble agent">Конечно! Наберу в четверг в 11:00, а пока пришлю короткое описание в Telegram</div>
      <div class="ob-note"><i class="fas fa-calendar-plus"></i> Задача: звонок в четверг 11:00 · <i class="fab fa-telegram"></i> отправлено</div>
    </div>`,
  },
  {
    badge: 'Пример · клиника',
    title: 'Администратор клиники',
    text: 'Принимает входящие звонки, отвечает на вопросы и записывает на приём. За час до визита сам уточняет у пациента, придёт ли он, а при отмене — предлагает другое время.',
    art: () => `<div class="ob-mock ob-talk">
      <div class="ob-bubble client">Здравствуйте, хочу записаться к терапевту</div>
      <div class="ob-bubble agent">Есть завтра в 15:00 — записываю вас?</div>
      <div class="ob-note"><i class="fas fa-clock"></i> Завтра, 14:00 · агент сам перезванивает</div>
      <div class="ob-bubble agent">Напоминаю о приёме в 15:00 — вы придёте?</div>
      <div class="ob-bubble client">Да, буду</div>
    </div>`,
  },
  {
    badge: 'Управление словами',
    title: 'Командуете на простом языке',
    text: 'Через чат вы управляете всей базой обычными словами. Контакты, задачи и воронка ведутся автоматически и принадлежат только этому агенту.',
    art: () => `<div class="ob-mock ob-talk">
      <div class="ob-bubble client">Напомни всем, кто записан на завтра</div>
      <div class="ob-bubble agent">Готово — 9 напоминаний, отправлю за час до приёма ✅</div>
      <div class="ob-bubble client">Кто не ответил на сообщения за неделю?</div>
      <div class="ob-bubble agent">5 контактов — предлагаю им позвонить завтра с 10:00</div>
    </div>`,
  },
];
const OB_TOTAL = OB_SLIDES.length;

/**
 * Запустить обучающий модуль. onDone вызывается после прохождения/пропуска —
 * туда передаётся открытие реального мастера (renderWizard через openWizardSteps).
 */
function startOnboarding(onDone){
  obOnDone = (typeof onDone === 'function') ? onDone : null;
  obStep = 0;
  const ls = document.getElementById('loading-screen');
  if(ls) ls.classList.add('hidden');
  document.getElementById('onboarding-overlay').classList.remove('hidden');
  renderOnboarding();
}

function renderOnboarding(){
  const s = OB_SLIDES[obStep];

  const dots = OB_SLIDES.map((_, i) =>
    `<span class="ob-dot ${i===obStep?'on':''} ${i<obStep?'done':''}"></span>`
  ).join('');

  const isLast = obStep === OB_TOTAL - 1;
  const backBtn = obStep > 0
    ? `<button class="btn btn-secondary" onclick="obBack()"><i class="fas fa-arrow-left"></i> Назад</button>`
    : `<span></span>`;
  const nextBtn = isLast
    ? `<button class="btn btn-primary" onclick="obNext()"><i class="fas fa-rocket"></i> Создать агента</button>`
    : `<button class="btn btn-primary" onclick="obNext()">Далее <i class="fas fa-arrow-right"></i></button>`;

  document.getElementById('ob-content').innerHTML = `
    <div class="ob-stage-art">${s.art()}</div>
    <div class="ob-badge">${s.badge}</div>
    <h2 class="ob-title">${s.title}</h2>
    <p class="ob-text">${s.text}</p>`;
  document.getElementById('ob-dots').innerHTML = dots;
  document.getElementById('ob-actions').innerHTML = backBtn + nextBtn;
}

function obNext(){
  if(obStep < OB_TOTAL - 1){ obStep++; renderOnboarding(); }
  else { finishOnboarding(); }
}
function obBack(){ if(obStep > 0){ obStep--; renderOnboarding(); } }
function obSkip(){ finishOnboarding(); }

function finishOnboarding(){
  document.getElementById('onboarding-overlay').classList.add('hidden');
  const cb = obOnDone; obOnDone = null;
  if(cb) cb();
}
