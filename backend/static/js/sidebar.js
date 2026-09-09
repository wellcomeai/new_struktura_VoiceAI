/**
 * Voicyfy — единый сайдбар личного кабинета (v6.0).
 *
 * Раньше меню было скопировано руками в 17 страниц и везде разъехалось.
 * Теперь каждая страница держит пустой <nav class="sidebar-nav" id="sidebar-nav"></nav>
 * внутри <aside class="sidebar">, а этот скрипт:
 *   1. синхронно рисует единое меню (чтобы скрипты страниц, которые ищут
 *      [data-feature] и #telephony-nav-item, находили элементы);
 *   2. подсвечивает активный пункт по URL;
 *   3. добавляет раздел «Администрирование» админу (is_admin или email);
 *   4. рисует карточку кошелька с балансом и кнопкой «Пополнить» (Robokassa);
 *   5. применяет блокировку по тарифу для CRM/Телефонии, если страница сама
 *      этого не делает (класс plan-locked-feature).
 *
 * Стили меню берутся из CSS страницы (.sidebar-nav-item и т.д. есть везде);
 * стили карточки кошелька и модалки — инлайн ниже, с fallback-цветами.
 */
(function () {
  'use strict';

  var API = '/api';
  var ADMIN_EMAILS = ['well96well@gmail.com'];

  var MENU = [
    { section: 'Основное' },
    { href: '/static/dashboard.html', icon: 'fas fa-home', lucide: 'house', label: 'Дашборд', id: 'dashboard-nav-item' },
    { href: '/static/agent.html', icon: 'fas fa-headset', lucide: 'headset', label: 'Агент обзвона', id: 'agent-nav-item' },
    { href: '/static/voice-assistants.html', icon: 'fas fa-robot', lucide: 'audio-lines', label: 'Голосовые ассистенты', id: 'assistants-nav-item',
      aliases: ['/static/agents.html', '/static/gemini-agents.html', '/static/cartesia-agents.html',
                '/static/yandex-agents.html', '/static/cascade.html', '/static/fish-agents.html',
                '/static/knowledge-base.html'] },
    { href: '/static/conversations.html', icon: 'fas fa-comments', lucide: 'messages-square', label: 'Диалоги', id: 'conversations-nav-item' },
    { href: '/static/telephony.html', icon: 'fas fa-phone', lucide: 'phone', label: 'Телефония', id: 'telephony-nav-item', feature: 'telephony' },
    { href: '/static/crm.html', icon: 'fas fa-address-book', lucide: 'contact-round', label: 'CRM', id: 'crm-nav-item', feature: 'crm',
      aliases: ['/static/crm-contact.html'] },
    { section: 'Аккаунт' },
    { href: '/static/settings.html', icon: 'fas fa-gear', lucide: 'settings', label: 'Настройки', id: 'settings-nav-item' }
  ];

  var ADMIN_ITEMS = [
    { section: 'Администрирование', admin: true },
    { href: '/static/admin.html', icon: 'fas fa-user-shield', lucide: 'shield-check', label: 'Управление', id: 'admin-nav-item', admin: true }
  ];

  // Матрица доступа по тарифам (дублирует дашборд, чтобы работать на всех страницах)
  var FEATURE_ACCESS = {
    crm: ['free', 'referral_trial', 'start', 'profi', 'agent'],
    telephony: ['free', 'referral_trial', 'start', 'profi', 'agent']
  };

  function token() {
    try { return localStorage.getItem('auth_token'); } catch (e) { return null; }
  }

  function currentPath() {
    var p = location.pathname.replace(/\/+$/, '');
    if (p === '/static' || p === '') p = '/static/dashboard.html';
    return p;
  }

  function isActive(item) {
    var p = currentPath();
    if (item.href === p) return true;
    return (item.aliases || []).indexOf(p) !== -1;
  }

  function renderItem(item) {
    if (item.section) {
      var s = document.createElement('div');
      s.className = 'sidebar-section';
      s.textContent = item.section;
      if (item.admin) s.setAttribute('data-admin', '1');
      return s;
    }
    var a = document.createElement('a');
    a.href = item.href;
    a.className = 'sidebar-nav-item' + (isActive(item) ? ' active' : '');
    if (item.id) a.id = item.id;
    if (item.feature) a.setAttribute('data-feature', item.feature);
    if (item.admin) a.setAttribute('data-admin', '1');
    // На страницах с дизайн-системой (есть window.VF) — иконки Lucide, иначе Font Awesome
    a.innerHTML = (window.VF && item.lucide
      ? window.VF.icon(item.lucide) + '<span>' + item.label + '</span>' + (item.feature ? window.VF.icon('lock', 'lock') : '')
      : '<i class="' + item.icon + '"></i> ' + item.label);
    return a;
  }

  function renderNav() {
    var nav = document.getElementById('sidebar-nav') || document.querySelector('.sidebar-nav');
    if (!nav) return null;
    nav.innerHTML = '';
    MENU.forEach(function (item) { nav.appendChild(renderItem(item)); });
    return nav;
  }

  function injectAdmin(nav) {
    if (!nav || nav.querySelector('[data-admin]')) return;
    var already = Array.prototype.some.call(nav.querySelectorAll('.sidebar-section'), function (el) {
      return el.textContent.trim() === 'Администрирование';
    });
    if (already) return;
    var account = Array.prototype.find.call(nav.querySelectorAll('.sidebar-section'), function (el) {
      return el.textContent.trim() === 'Аккаунт';
    });
    ADMIN_ITEMS.forEach(function (item) {
      var el = renderItem(item);
      if (account) nav.insertBefore(el, account); else nav.appendChild(el);
    });
  }

  function isAdminUser(user) {
    if (!user) return false;
    return !!user.is_admin || ADMIN_EMAILS.indexOf(user.email) !== -1;
  }

  // ---------------------------------------------------------------------
  // Кошелёк
  // ---------------------------------------------------------------------
  var STYLE = [
    '.vf-wallet{margin:0 12px 10px;padding:12px 14px;border:1px solid var(--vf-border,var(--border-color,#e2e8f0));',
    'border-radius:12px;background:var(--vf-surface-2,var(--bg-light,#f8fafc))}',
    '.vf-wallet-label{display:flex;align-items:center;gap:6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--vf-text-4,var(--text-light,#94a3b8));font-weight:600}',
    '.vf-wallet-label .ic{width:14px;height:14px}',
    '.vf-wallet-balance{font-size:20px;font-weight:700;color:var(--vf-text,var(--text-dark,#0f172a));margin:4px 0 10px;font-family:"Syne",sans-serif;letter-spacing:-.02em}',
    '.vf-wallet-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:32px;',
    'border:none;border-radius:8px;background:var(--vf-accent,var(--primary-blue,#2563eb));color:#fff;font-weight:600;cursor:pointer;font-size:13px;box-shadow:0 1px 2px rgba(37,99,235,.3)}',
    '.vf-wallet-btn:hover{background:var(--vf-accent-hover,var(--primary-blue-dark,#1d4ed8))}',
    '.vf-wallet-link{display:block;margin-top:8px;font-size:12px;color:var(--vf-text-3,var(--text-gray,#64748b));text-decoration:none;text-align:center}',
    '.vf-wallet-link:hover{color:var(--vf-accent,var(--primary-blue,#2563eb))}',
    '.vf-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1rem}',
    '.vf-modal{background:#fff;border-radius:1rem;width:100%;max-width:420px;padding:1.5rem;box-shadow:0 20px 40px rgba(0,0,0,.2);font-family:inherit}',
    '.vf-modal h3{margin:0 0 .25rem;font-size:1.15rem;color:var(--text-dark,#0f172a)}',
    '.vf-modal p{margin:0 0 1rem;color:var(--text-gray,#64748b);font-size:.9rem}',
    '.vf-chips{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem}',
    '.vf-chip{padding:.45rem .8rem;border:1px solid var(--border-color,#e2e8f0);border-radius:999px;background:#fff;cursor:pointer;font-size:.85rem;color:var(--text-dark,#0f172a)}',
    '.vf-chip.active,.vf-chip:hover{border-color:var(--primary-blue,#2563eb);color:var(--primary-blue,#2563eb);background:var(--bg-blue-light,#eff6ff)}',
    '.vf-input{width:100%;padding:.65rem .85rem;border:1px solid var(--border-color,#e2e8f0);border-radius:.5rem;font-size:1rem;box-sizing:border-box}',
    '.vf-modal-actions{display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem}',
    '.vf-btn{padding:.6rem 1rem;border-radius:.5rem;border:1px solid var(--border-color,#e2e8f0);background:#fff;cursor:pointer;font-weight:600}',
    '.vf-btn-primary{background:var(--primary-blue,#2563eb);border-color:var(--primary-blue,#2563eb);color:#fff}',
    '.vf-btn[disabled]{opacity:.6;cursor:default}',
    '.vf-hint{font-size:.75rem;color:var(--text-light,#94a3b8);margin-top:.5rem}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('vf-sidebar-style')) return;
    var st = document.createElement('style');
    st.id = 'vf-sidebar-style';
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  function fmtRub(kop) {
    var rub = (kop || 0) / 100;
    return rub.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
  }

  function renderWalletCard(nav) {
    var aside = nav ? nav.closest('.sidebar') : document.querySelector('.sidebar');
    if (!aside || aside.querySelector('.vf-wallet')) return;
    var card = document.createElement('div');
    card.className = 'vf-wallet';
    card.id = 'vf-wallet-card';
    card.innerHTML =
      '<div class="vf-wallet-label">' + (window.VF ? window.VF.icon('wallet') : '<i class="fas fa-wallet"></i>') + ' Кошелёк Voicyfy</div>' +
      '<div class="vf-wallet-balance" id="vf-wallet-balance">…</div>' +
      '<button class="vf-wallet-btn" type="button" id="vf-wallet-topup">' + (window.VF ? window.VF.icon('plus', 'ic-sm') : '<i class="fas fa-plus"></i>') + ' Пополнить</button>' +
      '<a class="vf-wallet-link" href="/static/settings.html#wallet">История операций</a>';
    var footer = aside.querySelector('.sidebar-footer');
    if (footer) aside.insertBefore(card, footer); else aside.appendChild(card);
    card.querySelector('#vf-wallet-topup').addEventListener('click', openTopupModal);
  }

  var walletState = { balance: 0, min: 100, max: 100000 };

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var t = token();
    if (t) opts.headers['Authorization'] = 'Bearer ' + t;
    return fetch(API + path, opts);
  }

  function refreshBalance() {
    var el = document.getElementById('vf-wallet-balance');
    if (!el || !token()) return Promise.resolve(null);
    return apiFetch('/wallet/balance').then(function (r) {
      if (!r.ok) throw new Error('balance ' + r.status);
      return r.json();
    }).then(function (d) {
      walletState.balance = d.balance_kopeks || 0;
      walletState.min = d.min_topup_rub || 100;
      walletState.max = d.max_topup_rub || 100000;
      el.textContent = fmtRub(walletState.balance);
      document.dispatchEvent(new CustomEvent('vf:wallet', { detail: d }));
      return d;
    }).catch(function () { el.textContent = '—'; return null; });
  }

  function openTopupModal() {
    if (document.getElementById('vf-topup-modal')) return;
    var presets = [300, 500, 1000, 3000];
    var overlay = document.createElement('div');
    overlay.className = 'vf-modal-overlay';
    overlay.id = 'vf-topup-modal';
    overlay.innerHTML =
      '<div class="vf-modal" role="dialog" aria-modal="true">' +
      '<h3>Пополнить кошелёк</h3>' +
      '<p>Баланс: <b>' + fmtRub(walletState.balance) + '</b>. Минуты голосовых моделей списываются с кошелька, связь в телефонии оплачивается отдельно.</p>' +
      '<div class="vf-chips">' + presets.map(function (v) {
        return '<button type="button" class="vf-chip' + (v === 500 ? ' active' : '') + '" data-v="' + v + '">' + v + ' ₽</button>';
      }).join('') + '</div>' +
      '<input class="vf-input" id="vf-topup-amount" type="number" min="' + walletState.min + '" max="' + walletState.max + '" step="1" value="500">' +
      '<div class="vf-hint">От ' + walletState.min + ' ₽ до ' + walletState.max.toLocaleString('ru-RU') + ' ₽. Оплата через Робокассу.</div>' +
      '<div class="vf-modal-actions">' +
      '<button type="button" class="vf-btn" id="vf-topup-cancel">Отмена</button>' +
      '<button type="button" class="vf-btn vf-btn-primary" id="vf-topup-pay"><i class="fas fa-credit-card"></i> Перейти к оплате</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    var input = overlay.querySelector('#vf-topup-amount');
    overlay.querySelectorAll('.vf-chip').forEach(function (c) {
      c.addEventListener('click', function () {
        overlay.querySelectorAll('.vf-chip').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
        input.value = c.getAttribute('data-v');
      });
    });
    function close() { overlay.remove(); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#vf-topup-cancel').addEventListener('click', close);
    overlay.querySelector('#vf-topup-pay').addEventListener('click', function () {
      var amount = parseInt(input.value, 10);
      if (!amount || amount < walletState.min || amount > walletState.max) {
        input.focus(); input.style.borderColor = '#ef4444'; return;
      }
      var btn = this; btn.disabled = true;
      apiFetch('/wallet/topup', { method: 'POST', body: JSON.stringify({ amount_rub: amount }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d.payment_url) { alert('Не удалось создать платёж: ' + (res.d.detail || 'ошибка')); btn.disabled = false; return; }
          submitRobokassa(res.d);
        })
        .catch(function (e) { alert('Ошибка: ' + e.message); btn.disabled = false; });
    });
  }

  function submitRobokassa(data) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = data.payment_url;
    Object.keys(data.form_params || {}).forEach(function (k) {
      var inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = k; inp.value = data.form_params[k];
      form.appendChild(inp);
    });
    document.body.appendChild(form);
    form.submit();
  }

  // ---------------------------------------------------------------------
  // Тарифная блокировка (fallback, если страница сама не применяет)
  // ---------------------------------------------------------------------
  function applyPlanLocks(user) {
    var plan = user && (user.subscription_plan_code || user.subscription_plan || user.plan_code);
    if (!plan) return;
    document.querySelectorAll('#sidebar-nav [data-feature]').forEach(function (el) {
      var allowed = FEATURE_ACCESS[el.getAttribute('data-feature')];
      if (allowed && allowed.indexOf(plan) === -1) el.classList.add('plan-locked-feature');
    });
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    injectStyle();
    var nav = renderNav();
    if (!nav) return;

    // Быстрый путь: админ из кэша сессии (чтобы меню не мигало)
    try {
      if (sessionStorage.getItem('vf_is_admin') === '1') injectAdmin(nav);
    } catch (e) { /* ignore */ }

    renderWalletCard(nav);

    if (!token()) return;
    apiFetch('/users/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (user) {
      if (!user) return;
      var admin = isAdminUser(user);
      try { sessionStorage.setItem('vf_is_admin', admin ? '1' : '0'); } catch (e) { /* ignore */ }
      if (admin) injectAdmin(nav);
      // Блокировку по тарифу применяют сами страницы (дашборд/настройки);
      // здесь — только если через секунду никто не применил.
      setTimeout(function () {
        if (!document.querySelector('#sidebar-nav .plan-locked-feature')) applyPlanLocks(user);
      }, 1000);
    }).catch(function () { /* ignore */ });
    refreshBalance();
  }

  window.VoicyfySidebar = {
    refreshBalance: refreshBalance,
    openTopupModal: openTopupModal,
    fmtRub: fmtRub,
    MENU: MENU
  };

  if (document.readyState === 'loading' && !document.getElementById('sidebar-nav')) {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
