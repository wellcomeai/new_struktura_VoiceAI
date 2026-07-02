/* ============================================================================
 * agent-docs/docs.js — логика страницы «Документация Voicyfy Agent».
 *
 * 1) Мобильное меню-оглавление (бургер + оверлей).
 * 2) Scrollspy: подсветка текущего раздела в сайдбаре (IntersectionObserver).
 * 3) Автогенерация навигации «← Предыдущая / Следующая →» в конце глав
 *    из порядка ссылок сайдбара.
 * 4) Переключатель «До / Во время / После» в главе «Архитектура».
 * 5) Универсальная карусель-тур (механика agent/onboarding.js): слайды с
 *    мокапами, точки-прогресс, кнопки, свайп на мобильных.
 *
 * Страница публичная: без авторизации и запросов к API.
 * Документация модуля: backend/static/agent-docs/CLAUDE.md
 * ========================================================================== */

(function(){
'use strict';

/* ── 1. Мобильное меню ──────────────────────────────────────────────── */
const burger  = document.getElementById('tb-burger');
const overlay = document.getElementById('sb-overlay');
function closeSidebar(){ document.body.classList.remove('sb-open'); }
if(burger)  burger.addEventListener('click', () => document.body.classList.toggle('sb-open'));
if(overlay) overlay.addEventListener('click', closeSidebar);

/* ── 2. Scrollspy ───────────────────────────────────────────────────── */
const links = Array.from(document.querySelectorAll('.sb-link'));
const byId  = {};
links.forEach(a => { byId[a.getAttribute('href').slice(1)] = a; a.addEventListener('click', closeSidebar); });

const spy = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if(!e.isIntersecting) return;
    links.forEach(a => a.classList.remove('on'));
    const link = byId[e.target.id];
    if(link) link.classList.add('on');
  });
}, { rootMargin: '-20% 0px -70% 0px' });
document.querySelectorAll('.chapter').forEach(s => spy.observe(s));

/* ── 3. Навигация «предыдущая / следующая» ──────────────────────────── */
const order = links.map(a => ({
  id: a.getAttribute('href').slice(1),
  title: a.textContent.trim(),
}));
order.forEach((item, i) => {
  const section = document.getElementById(item.id);
  if(!section) return;
  const prev = order[i-1], next = order[i+1];
  const nav = document.createElement('div');
  nav.className = 'chapter-nav';
  nav.innerHTML =
    (prev ? `<a href="#${prev.id}"><span class="cn-dir"><i class="fas fa-arrow-left"></i> Предыдущий раздел</span><span class="cn-title">${prev.title}</span></a>` : '<span></span>') +
    (next ? `<a class="next" href="#${next.id}"><span class="cn-dir">Следующий раздел <i class="fas fa-arrow-right"></i></span><span class="cn-title">${next.title}</span></a>` : '');
  section.appendChild(nav);
});

/* ── 4. Переключатель в главе «Архитектура» ─────────────────────────── */
const ARCH = {
  before: {
    orchOn: true, voiceOn: false,
    orch: `<ul>
      <li><i class="fas fa-circle"></i> Получает задачу и цель звонка</li>
      <li><i class="fas fa-circle"></i> Изучает карточку, память и историю разговоров</li>
      <li><i class="fas fa-circle"></i> Использует документы агента и базу знаний</li>
      <li><i class="fas fa-circle"></i> Готовит стратегию и персональное приветствие (Precall)</li>
    </ul>`,
    voice: `<div class="aa-idle">Ожидает: разговор ещё не начался.</div>`,
  },
  during: {
    orchOn: false, voiceOn: true,
    orch: `<div class="aa-idle">Не участвует: управление полностью передано голосовому агенту.</div>`,
    voice: `<ul>
      <li><i class="fas fa-circle"></i> Слушает и отвечает в реальном времени</li>
      <li><i class="fas fa-circle"></i> Задаёт вопросы и обрабатывает возражения</li>
      <li><i class="fas fa-circle"></i> Использует календарь, письма, SMS и базу знаний</li>
      <li><i class="fas fa-circle"></i> Сам решает, когда завершить разговор</li>
    </ul>`,
  },
  after: {
    orchOn: true, voiceOn: false,
    orch: `<ul>
      <li><i class="fas fa-circle"></i> Анализирует полный транскрипт разговора (Postcall)</li>
      <li><i class="fas fa-circle"></i> Обновляет память и стадию контакта</li>
      <li><i class="fas fa-circle"></i> Создаёт повторные задачи, отправляет SMS</li>
      <li><i class="fas fa-circle"></i> Уведомляет в Telegram, вызывает Webhook</li>
    </ul>`,
    voice: `<div class="aa-idle">Работа завершена: транскрипт передан оркестратору.</div>`,
  },
};
const archTabs = document.getElementById('arch-tabs');
if(archTabs){
  const orchCard  = document.getElementById('arch-orch');
  const voiceCard = document.getElementById('arch-voice');
  const orchBody  = document.getElementById('arch-orch-body');
  const voiceBody = document.getElementById('arch-voice-body');
  function setArch(key){
    const st = ARCH[key]; if(!st) return;
    archTabs.querySelectorAll('.arch-tab').forEach(b => b.classList.toggle('on', b.dataset.arch === key));
    orchCard.classList.toggle('on', st.orchOn);
    voiceCard.classList.toggle('on', st.voiceOn);
    orchBody.innerHTML  = st.orch;
    voiceBody.innerHTML = st.voice;
  }
  archTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.arch-tab');
    if(btn) setArch(btn.dataset.arch);
  });
  setArch('before');
}

/* ── 5. Карусель-тур ────────────────────────────────────────────────── */
/* Слайды жизненного цикла исходящего звонка. Мокапы — в стиле реального
 * продукта (классы ob-* перенесены из agent/agent.css). */
const TOUR_CALL = [
  {
    badge: 'Шаг 1 · Задача',
    title: 'Появляется задача на звонок',
    text: 'Задачу создаёт CRM через API, вы — через чат или интерфейс, либо сам оркестратор после предыдущего разговора. Задача — это цель звонка, а не сценарий.',
    art: `<div class="ob-mock">
      <div class="ob-mock-head"><i class="far fa-calendar-check"></i> Новая задача</div>
      <div class="ob-row"><span class="ob-k">Контакт</span><span class="ob-v">Иван Петров · +7 999 123-45-67</span></div>
      <div class="ob-row"><span class="ob-k">Цель</span><span class="ob-v">Заявка на Toyota Camry 2022 — уточнить бюджет, предложить варианты</span></div>
      <div class="ob-row"><span class="ob-k">Когда</span><span class="ob-v">завтра, 11:00</span></div>
    </div>`,
  },
  {
    badge: 'Шаг 2 · Precall',
    title: 'Оркестратор собирает всё о клиенте',
    text: 'Перед звонком оркестратор изучает задачу, карточку контакта, память, историю прошлых разговоров и SMS, документы агента и базу знаний — как менеджер, открывший CRM перед звонком.',
    art: `<div class="ob-mock">
      <div class="ob-mock-head"><i class="fas fa-brain"></i> Precall · сбор контекста</div>
      <div class="ob-row"><span class="ob-k">Память</span><span class="ob-v">интересовался Camry, просил позвонить после отпуска</span></div>
      <div class="ob-row"><span class="ob-k">История</span><span class="ob-v">2 звонка · последний — вторник</span></div>
      <div class="ob-row"><span class="ob-k">Документы</span><span class="ob-v">Кто мы · Что предлагаем · Правила и цели</span></div>
    </div>`,
  },
  {
    badge: 'Шаг 3 · Стратегия',
    title: 'Готовится персональное приветствие',
    text: 'На основе собранного контекста оркестратор формирует первую фразу, тон и ключевые акценты именно для этого звонка. Поэтому два разных клиента услышат разные приветствия.',
    art: `<div class="ob-mock">
      <div class="ob-mock-head"><i class="fas fa-wand-magic-sparkles"></i> Стратегия звонка</div>
      <div class="ob-row"><span class="ob-k">Первая фраза</span><span class="ob-v">«Иван, добрый день! Это Алина из „Авто Японии“…»</span></div>
      <div class="ob-row"><span class="ob-k">Тон</span><span class="ob-v">деловой, без давления</span></div>
      <div class="ob-row"><span class="ob-k">Акцент</span><span class="ob-v">напомнить о прошлом интересе, уточнить бюджет</span></div>
    </div>`,
  },
  {
    badge: 'Шаг 4 · Разговор',
    title: 'Голосовой агент ведёт живой диалог',
    text: 'Управление полностью у голосового агента: он слушает, отвечает, обрабатывает возражения и адаптируется при смене темы. Оркестратор в разговоре не участвует.',
    art: `<div class="ob-mock ob-talk">
      <div class="ob-bubble agent">Иван, удобно сейчас пару минут?</div>
      <div class="ob-bubble client">Да, слушаю.</div>
      <div class="ob-bubble agent">По вашей заявке на Camry появились варианты. Какой бюджет рассматриваете?</div>
    </div>`,
  },
  {
    badge: 'Шаг 5 · Инструменты',
    title: 'Использует инструменты прямо в разговоре',
    text: 'Если клиент просит записать его на встречу — агент проверяет календарь и создаёт событие. Просит КП — отправляет письмо. Задаёт сложный вопрос — агент ищет ответ в базе знаний.',
    art: `<div class="ob-mock ob-talk">
      <div class="ob-bubble client">Запишите меня на консультацию в пятницу.</div>
      <div class="ob-bubble agent">Секунду, проверяю расписание <span class="ob-kb"><i class="fas fa-calendar-days"></i> Google Calendar</span></div>
      <div class="ob-bubble agent">Есть время в 15:00 — записал вас и отправил подтверждение.</div>
    </div>`,
  },
  {
    badge: 'Шаг 6 · Postcall',
    title: 'Оркестратор разбирает транскрипт',
    text: 'После завершения звонка оркестратор получает полный транскрипт и определяет: достигнута ли цель, заинтересован ли клиент, что нового удалось узнать и какие действия нужны дальше.',
    art: `<div class="ob-mock">
      <div class="ob-mock-head"><i class="fas fa-clipboard-check"></i> Postcall · анализ</div>
      <div class="ob-row"><span class="ob-k">Итог</span><span class="ob-v">заинтересован, записан на консультацию</span></div>
      <div class="ob-row"><span class="ob-k">Новые факты</span><span class="ob-v">бюджет до 3 млн, рассматривает трейд-ин</span></div>
      <div class="ob-row"><span class="ob-k">Цель звонка</span><span class="ob-v">достигнута ✅</span></div>
    </div>`,
  },
  {
    badge: 'Шаг 7 · Действия',
    title: 'Система обновляется автоматически',
    text: 'Память пополняется, контакт двигается по воронке, создаётся напоминание о встрече, в Telegram уходит уведомление, а Webhook передаёт результат в CRM. Всё — без вашего участия.',
    art: `<div class="ob-mock">
      <div class="ob-mock-head"><i class="fas fa-rotate"></i> После звонка · автоматически</div>
      <div class="ob-row"><span class="ob-k">Память</span><span class="ob-v">+ бюджет до 3 млн, трейд-ин, встреча в пятницу</span></div>
      <div class="ob-row"><span class="ob-k">Задача</span><span class="ob-v">напомнить о встрече в пятницу утром</span></div>
      <div class="ob-row"><span class="ob-k">Telegram</span><span class="ob-v">уведомление о заинтересованном клиенте отправлено</span></div>
      <div class="ob-funnel">
        <span class="ob-stage">Новый</span><i class="fas fa-arrow-right-long"></i><span class="ob-stage on">В работе</span><i class="fas fa-arrow-right-long"></i><span class="ob-stage">Успех</span>
      </div>
    </div>`,
  },
];

const TOURS = { call: TOUR_CALL };

function initTour(root){
  const slides = TOURS[root.dataset.tour];
  if(!slides || !slides.length) return;
  let step = 0;

  root.innerHTML = `
    <div class="tour-art"></div>
    <span class="tour-badge"></span>
    <div class="tour-title"></div>
    <p class="tour-text"></p>
    <div class="tour-dots"></div>
    <div class="tour-actions">
      <button class="btn btn-secondary" data-act="back" type="button"><i class="fas fa-arrow-left"></i> Назад</button>
      <span class="tour-step"></span>
      <button class="btn btn-primary" data-act="next" type="button">Далее <i class="fas fa-arrow-right"></i></button>
    </div>`;

  const art   = root.querySelector('.tour-art');
  const badge = root.querySelector('.tour-badge');
  const title = root.querySelector('.tour-title');
  const text  = root.querySelector('.tour-text');
  const dots  = root.querySelector('.tour-dots');
  const stepEl= root.querySelector('.tour-step');
  const back  = root.querySelector('[data-act="back"]');
  const next  = root.querySelector('[data-act="next"]');

  function render(){
    const s = slides[step];
    art.innerHTML   = s.art;
    badge.textContent = s.badge;
    title.textContent = s.title;
    text.textContent  = s.text;
    stepEl.textContent = (step + 1) + ' из ' + slides.length;
    dots.innerHTML = slides.map((_, i) =>
      `<button class="tour-dot ${i===step?'on':''} ${i<step?'done':''}" data-dot="${i}" type="button" aria-label="Слайд ${i+1}"></button>`
    ).join('');
    back.disabled = step === 0;
    if(step === slides.length - 1){
      next.innerHTML = '<i class="fas fa-rotate-left"></i> Сначала';
    } else {
      next.innerHTML = 'Далее <i class="fas fa-arrow-right"></i>';
    }
  }

  back.addEventListener('click', () => { if(step > 0){ step--; render(); } });
  next.addEventListener('click', () => { step = (step === slides.length - 1) ? 0 : step + 1; render(); });
  dots.addEventListener('click', (e) => {
    const d = e.target.closest('[data-dot]');
    if(d){ step = Number(d.dataset.dot); render(); }
  });

  /* Свайп на мобильных */
  let touchX = null;
  root.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if(touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if(Math.abs(dx) < 45) return;
    if(dx < 0 && step < slides.length - 1){ step++; render(); }
    if(dx > 0 && step > 0){ step--; render(); }
  }, { passive: true });

  render();
}

document.querySelectorAll('[data-tour]').forEach(initTour);

})();
