/*
 * Телефония: верификация физлица, телефонный кошелёк и админ-меню.
 *
 * Подключается в конце telephony.html и пользуется функциями страницы
 * (window.TEL: api, setLoading, showNotification, loadTelephonyStatus …).
 * Наружу отдаёт window.TELV: onStatus(status), openForm(), openWallet(),
 * refreshAdmin().
 *
 * API: /api/telephony/verification, /hosted/*, /telephony-wallet*, /admin/*
 * (backend/api/telephony_hosted.py), тестовый пул — /api/telephony/test-numbers/admin/*.
 */
(function () {
  'use strict';

  var CONSENT_URL = '/static/verification-consent.html';
  var PRIVACY_URL = '/static/privacy-policy.html';

  var STATUS_LABELS = {
    submitted: 'На проверке',
    needs_revision: 'Нужно исправить',
    approved: 'Одобрена',
    rejected: 'Отклонена',
  };
  var FILE_HINTS = {
    passport_main: 'Разворот с фотографией, все поля читаются, без бликов',
    passport_registration: 'Страница с действующей регистрацией',
    selfie: 'Вы держите раскрытый паспорт и лист, где от руки написано «Верификация Voicyfy» и сегодняшняя дата',
  };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function todayRu() {
    return new Date().toLocaleDateString('ru-RU');
  }
  function T() { return window.TEL; }

  function overlay(id, title, bodyHtml, footerHtml, wide) {
    var old = document.getElementById(id);
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = id;
    el.innerHTML =
      '<div class="modal ' + (wide ? 'modal-wide' : '') + '" style="max-height:92vh;display:flex;flex-direction:column;">' +
        '<div class="modal-header"><h3 class="modal-title">' + title + '</h3>' +
        '<button class="modal-close" data-close>&times;</button></div>' +
        '<div class="modal-body" style="overflow:auto;">' + bodyHtml + '</div>' +
        (footerHtml ? '<div class="modal-footer">' + footerHtml + '</div>' : '') +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      if (e.target === el || e.target.hasAttribute('data-close')) close();
    });
    function close() { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 200); }
    requestAnimationFrame(function () { el.classList.add('show'); });
    return { el: el, close: close };
  }

  // ===========================================================================
  // Статус заявки на карточке «Физическое лицо»
  // ===========================================================================
  var verificationState = null;
  var ensureTried = false;

  async function loadVerification() {
    try {
      verificationState = await T().api.get('/telephony/verification');
    } catch (e) {
      verificationState = null;
    }
    return verificationState;
  }

  function renderIndividualCard() {
    var box = document.getElementById('individual-verification-state');
    var btn = document.getElementById('open-individual-form-btn');
    if (!box || !btn) return;
    var v = verificationState && verificationState.verification;
    btn.classList.remove('hidden');
    if (!v) {
      box.innerHTML = '';
      btn.innerHTML = '<i class="fas fa-id-card"></i> Пройти верификацию физлица';
      return;
    }
    var color = { submitted: '#b45309', needs_revision: '#b91c1c', approved: '#15803d', rejected: '#b91c1c' }[v.status] || '#475569';
    var html = '<div style="padding:.6rem .8rem;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;font-size:.875rem;">' +
      'Заявка: <b style="color:' + color + '">' + esc(STATUS_LABELS[v.status] || v.status) + '</b>' +
      (v.submitted_at ? ' · отправлена ' + fmtDate(v.submitted_at) : '');
    if (v.reviewer_comment) html += '<div style="margin-top:.35rem;">Комментарий проверяющего: <b>' + esc(v.reviewer_comment) + '</b></div>';
    if (v.status === 'rejected') html += '<div style="margin-top:.35rem;">Если считаете это ошибкой, напишите в <a href="https://t.me/voicyfy_support" target="_blank">поддержку</a>.</div>';
    html += '</div>';
    box.innerHTML = html;
    if (v.status === 'needs_revision') {
      btn.innerHTML = '<i class="fas fa-pen"></i> Исправить и отправить снова';
    } else if (v.status === 'approved') {
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> Подключить номера';
    } else {
      btn.classList.add('hidden');
    }
  }

  async function onStatus(status) {
    if (status && status.is_connected) return;
    await loadVerification();
    var v = verificationState && verificationState.verification;
    // Одобрили, а запись телефонии ещё не заведена (аккаунт номеров был не готов) —
    // /hosted/status заводит её, после чего страница переходит в режим физлица
    if (v && v.status === 'approved' && !ensureTried) {
      ensureTried = true;
      try {
        var hs = await T().api.get('/telephony/hosted/status');
        if (hs.is_hosted) { T().loadTelephonyStatus(); return; }
      } catch (e) { /* покажем карточку */ }
    }
    renderIndividualCard();
  }

  // ===========================================================================
  // Анкета физлица
  // ===========================================================================
  // [поле, подпись, тип, ширина в колонках сетки (1–3), placeholder, pattern]
  var FIELD_LAYOUT = [
    ['last_name', 'Фамилия', 'text', 1],
    ['first_name', 'Имя', 'text', 1],
    ['middle_name', 'Отчество (если есть)', 'text', 1],
    ['birth_date', 'Дата рождения', 'date', 1],
    ['birth_place', 'Место рождения (как в паспорте)', 'text', 2],
    ['passport_series', 'Серия', 'text', 1, '4 цифры', '\\d{4}'],
    ['passport_number', 'Номер', 'text', 1, '6 цифр', '\\d{6}'],
    ['division_code', 'Код подразделения', 'text', 1, '123-456'],
    ['issued_by', 'Кем выдан', 'text', 2],
    ['issue_date', 'Дата выдачи', 'date', 1],
    ['registration_address', 'Адрес регистрации', 'text', 3],
    ['phone', 'Контактный телефон', 'tel', 1, '+7 900 000-00-00'],
  ];


  function toInputDate(v) {
    // дд.мм.гггг → гггг-мм-дд для <input type=date>
    var m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v || '');
    return m ? (m[3] + '-' + m[2] + '-' + m[1]) : (v || '');
  }

  async function openForm() {
    var st = verificationState || await loadVerification();
    if (!st) { T().showNotification('Не удалось загрузить данные верификации', 'error'); return; }
    var v = st.verification;
    if (v && v.status === 'approved') {
      try { await T().api.get('/telephony/hosted/status'); } catch (e) { /* ignore */ }
      T().loadTelephonyStatus();
      return;
    }
    if (v && (v.status === 'submitted' || v.status === 'rejected')) {
      renderIndividualCard();
      T().showNotification(v.status === 'submitted' ? 'Заявка уже на проверке' : 'Заявка отклонена', 'info');
      return;
    }
    if (!st.storage_ready) {
      T().showNotification('Приём документов временно недоступен, попробуйте позже', 'error');
      return;
    }
    var pre = st.prefill || {};
    var fields = FIELD_LAYOUT.map(function (f) {
      var val = f[2] === 'date' ? toInputDate(pre[f[0]]) : (pre[f[0]] || '');
      return '<div class="form-group vf-span' + f[3] + '" style="margin:0;">' +
        '<label for="vf-' + f[0] + '">' + esc(f[1]) + '</label>' +
        '<input class="form-control" id="vf-' + f[0] + '" name="' + f[0] + '" type="' + f[2] + '"' +
        (f[4] ? ' placeholder="' + esc(f[4]) + '"' : '') +
        (f[5] ? ' pattern="' + f[5] + '" inputmode="numeric"' : '') +
        (f[0] === 'middle_name' ? '' : ' required') +
        ' value="' + esc(val) + '"></div>';
    }).join('');
    var files = Object.keys(st.file_kinds).map(function (kind) {
      return '<div class="form-group" style="margin:0;">' +
        '<label for="vf-file-' + kind + '">' + esc(st.file_kinds[kind]) + '</label>' +
        '<input class="form-control" id="vf-file-' + kind + '" name="' + kind + '" type="file" required ' +
        'accept="' + (kind === 'selfie' ? 'image/jpeg,image/png' : 'image/jpeg,image/png,application/pdf') + '">' +
        '<div style="font-size:.75rem;color:var(--text-gray);margin-top:.25rem;">' + esc(FILE_HINTS[kind] || '') +
        (kind === 'selfie' ? ' (например, «Верификация Voicyfy ' + todayRu() + '»)' : '') + '. JPG, PNG' +
        (kind === 'selfie' ? '' : ' или PDF') + ', до 10 МБ.</div></div>';
    }).join('');
    var revision = v && v.status === 'needs_revision' && v.reviewer_comment
      ? '<div style="padding:.7rem .9rem;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;margin-bottom:1rem;font-size:.875rem;">' +
        'Что исправить: <b>' + esc(v.reviewer_comment) + '</b><br>Файлы нужно загрузить заново.</div>'
      : '';
    var body =
      '<form id="vf-individual-form" novalidate>' + revision +
      '<p style="color:var(--text-gray);font-size:.875rem;margin:0 0 1rem;">Данные нужны, чтобы оформить номер по закону о связи. ' +
      'Мы храним их в защищённом хранилище в России и показываем только проверяющему. ' +
      'Для постоянной работы советуем верификацию как ИП — так номера будут оформлены на вас напрямую.</p>' +
      '<div class="vf-form-grid">' + fields + '</div>' +
      '<h4 style="margin:1.25rem 0 .5rem;">Фотографии</h4>' +
      '<div style="display:grid;gap:.75rem;">' + files + '</div>' +
      '<label style="display:flex;gap:.6rem;align-items:flex-start;margin-top:1.25rem;font-size:.875rem;line-height:1.45;">' +
        '<input type="checkbox" id="vf-consent" style="margin-top:.2rem;">' +
        '<span>Я даю <a href="' + CONSENT_URL + '" target="_blank">согласие на обработку паспортных данных</a> ' +
        'для верификации и оформления номеров и ознакомлен(а) с <a href="' + PRIVACY_URL + '" target="_blank">политикой обработки персональных данных</a>.</span>' +
      '</label>' +
      '<div id="vf-form-error" style="color:#b91c1c;font-size:.875rem;margin-top:.75rem;"></div>' +
      '</form>';
    var footer = '<button class="btn btn-secondary" data-close>Отмена</button>' +
      '<button class="btn btn-primary" id="vf-submit-btn"><i class="fas fa-paper-plane"></i> Отправить на проверку</button>';
    var m = overlay('vf-individual-modal', 'Верификация физического лица', body, footer, true);
    m.el.querySelector('#vf-submit-btn').addEventListener('click', function () { submitForm(m); });
  }

  function dateToRu(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    return m ? (m[3] + '.' + m[2] + '.' + m[1]) : (v || '');
  }

  async function submitForm(m) {
    var form = m.el.querySelector('#vf-individual-form');
    var err = m.el.querySelector('#vf-form-error');
    err.textContent = '';
    var bad = Array.prototype.find.call(form.querySelectorAll('input[required]'), function (i) {
      return !i.value || (i.pattern && !new RegExp('^' + i.pattern + '$').test(i.value.replace(/\s/g, '')));
    });
    if (bad) {
      var label = form.querySelector('label[for="' + bad.id + '"]');
      err.textContent = 'Проверьте поле «' + (label ? label.textContent : bad.name) + '»';
      bad.focus();
      return;
    }
    if (!form.querySelector('#vf-consent').checked) {
      err.textContent = 'Нужно согласие на обработку паспортных данных';
      return;
    }
    var fd = new FormData();
    FIELD_LAYOUT.forEach(function (f) {
      var val = form.querySelector('#vf-' + f[0]).value.trim();
      fd.append(f[0], f[2] === 'date' ? dateToRu(val) : val);
    });
    ['passport_main', 'passport_registration', 'selfie'].forEach(function (kind) {
      var input = form.querySelector('#vf-file-' + kind);
      if (input.files[0]) fd.append(kind, input.files[0]);
    });
    fd.append('consent', 'true');
    var btn = m.el.querySelector('#vf-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Отправляем…';
    try {
      var resp = await fetch('/api/telephony/verification', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + T().api.getToken() },
        body: fd,
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) throw new Error(data.detail || data.message || 'Не удалось отправить заявку');
      m.close();
      T().showNotification(data.message || 'Заявка отправлена на проверку', 'success');
      await loadVerification();
      renderIndividualCard();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Отправить на проверку';
    }
  }

  // ===========================================================================
  // Телефонный кошелёк
  // ===========================================================================
  var TX_LABELS = { topup: 'Пополнение', number: 'Номер', renewal: 'Продление номера', call: 'Звонок', sms: 'SMS', manual_adjust: 'Коррекция', refund: 'Возврат' };

  async function openWallet() {
    var data, hs;
    try {
      T().setLoading(true);
      data = await T().api.get('/telephony/telephony-wallet?limit=30');
      hs = await T().api.get('/telephony/hosted/status');
    } catch (e) {
      T().showNotification(e.message || 'Не удалось загрузить баланс', 'error');
      return;
    } finally {
      T().setLoading(false);
    }
    var rows = (data.transactions || []).map(function (t) {
      var plus = t.amount_rub > 0;
      return '<tr><td style="white-space:nowrap;">' + fmtDate(t.created_at) + '</td>' +
        '<td>' + esc(TX_LABELS[t.type] || t.type) + (t.phone_number ? ' · ' + esc(t.phone_number) : '') + '</td>' +
        '<td style="text-align:right;color:' + (plus ? '#15803d' : '#0f172a') + ';white-space:nowrap;">' +
        (plus ? '+' : '') + t.amount_rub.toFixed(2) + ' ₽</td></tr>';
    }).join('');
    var body =
      '<div style="font-size:2rem;font-weight:800;">' + data.balance_rub.toFixed(2) + ' ₽</div>' +
      '<p style="color:var(--text-gray);font-size:.875rem;margin:.25rem 0 1rem;">С этого баланса оплачиваются номера (раз в месяц) и минуты связи по тарифам оператора. ' +
      'Разговор с ассистентом (ИИ) оплачивается с основного кошелька. Звонки идут, пока на балансе не меньше ' + hs.min_call_balance_rub + ' ₽.</p>' +
      '<div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap;">' +
        '<div class="form-group" style="margin:0;"><label for="vf-topup-amount">Сумма, ₽</label>' +
        '<input class="form-control" id="vf-topup-amount" type="number" min="' + hs.min_topup_rub + '" step="1" value="500" style="width:160px;"></div>' +
        '<button class="btn btn-success" id="vf-topup-btn"><i class="fas fa-credit-card"></i> Пополнить</button>' +
      '</div>' +
      '<h4 style="margin:1.25rem 0 .5rem;">История</h4>' +
      (rows ? '<table class="numbers-table"><tbody>' + rows + '</tbody></table>'
            : '<p style="color:var(--text-gray);font-size:.875rem;">Операций пока нет</p>');
    var m = overlay('vf-wallet-modal', 'Телефонный баланс', body, '<button class="btn btn-secondary" data-close>Закрыть</button>');
    m.el.querySelector('#vf-topup-btn').addEventListener('click', async function () {
      var amount = parseInt(m.el.querySelector('#vf-topup-amount').value, 10);
      if (!amount || amount < hs.min_topup_rub) {
        T().showNotification('Минимальная сумма — ' + hs.min_topup_rub + ' ₽', 'warning');
        return;
      }
      try {
        T().setLoading(true);
        var pay = await T().api.post('/telephony/telephony-wallet/topup', { amount_rub: amount });
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = pay.payment_url;
        Object.keys(pay.form_params || {}).forEach(function (k) {
          var inp = document.createElement('input');
          inp.type = 'hidden'; inp.name = k; inp.value = pay.form_params[k];
          form.appendChild(inp);
        });
        document.body.appendChild(form);
        form.submit();
      } catch (e) {
        T().setLoading(false);
        T().showNotification(e.message || 'Не удалось создать платёж', 'error');
      }
    });
  }

  // ===========================================================================
  // Админ-меню телефонии
  // ===========================================================================
  var adminTab = 'verifications';
  var isAdmin = false;

  function adminCardHtml() {
    return '<div id="tel-admin-card" class="card">' +
      '<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">' +
        '<div><h2 class="card-title">🛠 Администрирование телефонии</h2>' +
        '<p class="card-description">Видно только администраторам</p></div>' +
        '<div class="number-tabs" id="tel-admin-tabs">' +
          '<button class="number-tab" data-tab="verifications"><i class="fas fa-id-card"></i> Заявки</button>' +
          '<button class="number-tab" data-tab="hosted"><i class="fas fa-user"></i> Номера физлиц</button>' +
          '<button class="number-tab" data-tab="pool"><i class="fas fa-flask"></i> Тестовый пул</button>' +
        '</div>' +
      '</div>' +
      '<div id="tel-admin-body"><div class="tn-muted">Загрузка…</div></div>' +
    '</div>';
  }

  async function initAdmin() {
    try {
      var me = await T().api.get('/users/me');
      isAdmin = !!me.is_admin;
    } catch (e) { isAdmin = false; }
    if (!isAdmin) return;
    var container = document.querySelector('.content-container');
    container.insertAdjacentHTML('afterbegin', adminCardHtml());
    document.querySelectorAll('#tel-admin-tabs .number-tab').forEach(function (b) {
      b.addEventListener('click', function () { adminTab = b.dataset.tab; refreshAdmin(); });
    });
    var params = new URLSearchParams(location.search);
    if (params.get('admin')) adminTab = params.get('admin') === 'pool' ? 'pool'
      : (params.get('admin') === 'hosted' ? 'hosted' : 'verifications');
    await refreshAdmin();
    if (params.get('vid')) openVerificationDetails(params.get('vid'));
  }

  async function refreshAdmin() {
    if (!isAdmin) return;
    document.querySelectorAll('#tel-admin-tabs .number-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === adminTab);
    });
    var body = document.getElementById('tel-admin-body');
    if (!body) return;
    try {
      if (adminTab === 'verifications') await renderVerifications(body);
      else if (adminTab === 'hosted') await renderHosted(body);
      else await renderPool(body);
    } catch (e) {
      body.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message || 'Ошибка загрузки') + '</p>';
    }
  }

  var verifFilter = 'submitted';

  async function renderVerifications(body) {
    var data = await T().api.get('/telephony/admin/verifications' + (verifFilter ? '?status=' + verifFilter : ''));
    var filters = [['submitted', 'На проверке'], ['needs_revision', 'На доработке'], ['approved', 'Одобрены'], ['rejected', 'Отклонены'], ['', 'Все']];
    var html = '<div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.75rem;">' +
      filters.map(function (f) {
        return '<button class="btn btn-sm ' + (f[0] === verifFilter ? 'btn-primary' : 'btn-secondary') + '" data-vfilter="' + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div>';
    if (!data.items.length) {
      html += '<p class="tn-muted">Заявок нет</p>';
    } else {
      html += '<table class="numbers-table"><thead><tr><th>Email</th><th>Статус</th><th>Подача</th><th>Отправлена</th><th></th></tr></thead><tbody>' +
        data.items.map(function (v) {
          return '<tr><td>' + esc(v.email) + '</td><td>' + esc(STATUS_LABELS[v.status] || v.status) + '</td>' +
            '<td>№' + v.attempt + '</td><td>' + fmtDate(v.submitted_at) + '</td>' +
            '<td><button class="btn btn-secondary btn-sm" data-vid="' + v.id + '"' + (v.has_documents ? '' : ' disabled title="Документы удалены по сроку хранения"') + '>' +
            '<i class="fas fa-folder-open"></i> Документы</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-vfilter]').forEach(function (b) {
      b.addEventListener('click', function () { verifFilter = b.dataset.vfilter; refreshAdmin(); });
    });
    body.querySelectorAll('[data-vid]').forEach(function (b) {
      b.addEventListener('click', function () { openVerificationDetails(b.dataset.vid); });
    });
  }

  async function openVerificationDetails(id, byUser) {
    var d;
    try {
      T().setLoading(true);
      d = await T().api.get(byUser ? '/telephony/admin/verifications/by-user/' + id : '/telephony/admin/verifications/' + id);
    } catch (e) {
      T().showNotification(e.message || 'Заявка не найдена', 'error');
      return;
    } finally {
      T().setLoading(false);
    }
    var fields = Object.keys(d.fields || {}).map(function (k) {
      return '<tr><td style="color:var(--text-gray);white-space:nowrap;">' + esc(k) + '</td><td>' + esc(d.fields[k]) + '</td></tr>';
    }).join('');
    var files = Object.keys(d.files || {}).map(function (kind) {
      var f = d.files[kind];
      return '<div style="border:1px solid #e2e8f0;border-radius:10px;padding:.5rem;">' +
        '<div style="font-size:.8rem;margin-bottom:.35rem;">' + esc(f.label) + '</div>' +
        (f.is_pdf
          ? '<a class="btn btn-secondary btn-sm" href="' + esc(f.url) + '" target="_blank"><i class="fas fa-file-pdf"></i> Открыть PDF</a>'
          : '<a href="' + esc(f.url) + '" target="_blank"><img src="' + esc(f.url) + '" alt="" style="width:100%;max-height:260px;object-fit:contain;background:#f8fafc;border-radius:6px;"></a>') +
        '</div>';
    }).join('');
    var body =
      '<div style="margin-bottom:.75rem;">' + esc(d.email) + ' · <b>' + esc(STATUS_LABELS[d.status] || d.status) + '</b> · подача №' + d.attempt +
      (d.consent_at ? ' · согласие ' + fmtDate(d.consent_at) + ' (ред. ' + esc(d.consent_version) + ')' : '') + '</div>' +
      (d.reviewer_comment ? '<div style="margin-bottom:.75rem;">Комментарий: <b>' + esc(d.reviewer_comment) + '</b> (' + esc(d.reviewed_by || '') + ')</div>' : '') +
      (fields ? '<table class="numbers-table" style="margin-bottom:1rem;"><tbody>' + fields + '</tbody></table>'
              : '<p class="tn-muted">' + (d.documents_available
                  ? 'Не удалось загрузить анкету из хранилища — попробуйте открыть позже'
                  : 'Анкета удалена по сроку хранения') + '</p>') +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem;">' + files + '</div>' +
      (d.status === 'submitted'
        ? '<div class="form-group" style="margin-top:1rem;"><label for="vf-review-comment">Комментарий для пользователя (для доработки обязателен)</label>' +
          '<textarea class="form-control" id="vf-review-comment" rows="2"></textarea></div>'
        : '');
    var footer = d.status === 'submitted'
      ? '<button class="btn btn-danger" data-act="reject">Отклонить</button>' +
        '<button class="btn btn-secondary" data-act="revision">На доработку</button>' +
        '<button class="btn btn-success" data-act="approve"><i class="fas fa-check"></i> Одобрить</button>'
      : '<button class="btn btn-secondary" data-close>Закрыть</button>';
    var m = overlay('vf-review-modal', 'Документы верификации', body, footer, true);
    m.el.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var comment = (m.el.querySelector('#vf-review-comment') || {}).value || '';
        if (b.dataset.act === 'revision' && !comment.trim()) {
          T().showNotification('Напишите, что нужно исправить', 'warning');
          return;
        }
        try {
          T().setLoading(true);
          await T().api.post('/telephony/admin/verifications/' + d.id + '/decision', { action: b.dataset.act, comment: comment });
          m.close();
          T().showNotification('Решение сохранено, пользователь получит письмо', 'success');
          refreshAdmin();
        } catch (e) {
          T().showNotification(e.message || 'Ошибка', 'error');
        } finally {
          T().setLoading(false);
        }
      });
    });
  }

  async function renderHosted(body) {
    var d = await T().api.get('/telephony/admin/hosted-numbers');
    var statusLabel = { active: 'Работает', suspended: 'Приостановлен' };
    var html = d.host_ready ? '' :
      '<div style="padding:.7rem .9rem;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;margin-bottom:1rem;font-size:.875rem;">' +
      'Аккаунт для номеров физлиц не готов: у владельца (HOSTED_NUMBERS_OWNER_EMAIL) должен быть верифицированный аккаунт телефонии с приложением.</div>';
    html += '<h4 style="margin:.25rem 0 .5rem;">Куплены физлицами</h4>';
    html += d.rented.length
      ? '<table class="numbers-table"><thead><tr><th>Номер</th><th>Email</th><th>Статус</th><th>Оплачен до</th><th>Цена</th><th>Баланс</th><th></th></tr></thead><tbody>' +
        d.rented.map(function (r) {
          return '<tr><td><span class="phone-number">' + esc(T().formatPhoneNumber(r.phone_number)) + '</span></td>' +
            '<td>' + esc(r.email) + '</td><td>' + esc(statusLabel[r.status] || r.status) + '</td>' +
            '<td>' + fmtDate(r.paid_until) + '</td><td style="white-space:nowrap;">' + r.monthly_rub + ' ₽/мес</td>' +
            '<td style="white-space:nowrap;">' + r.telephony_balance_rub.toFixed(2) + ' ₽</td>' +
            '<td style="white-space:nowrap;"><button class="btn btn-secondary btn-sm" data-docs="' + r.user_id + '"><i class="fas fa-folder-open"></i> Документы</button> ' +
            '<button class="btn btn-secondary btn-sm" data-release="' + r.id + '" data-phone="' + esc(r.phone_number) + '" title="Забрать номер у пользователя в запас">Забрать</button></td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="tn-muted">Пока никто не купил номер</p>';
    html += '<h4 style="margin:1.25rem 0 .5rem;">Свободны (запас)</h4>';
    html += d.stock.length
      ? '<table class="numbers-table"><thead><tr><th>Номер</th><th>Регион</th><th>Цена Voximplant</th><th></th></tr></thead><tbody>' +
        d.stock.map(function (s) {
          return '<tr><td><span class="phone-number">' + esc(T().formatPhoneNumber(s.phone_number)) + '</span></td>' +
            '<td>' + esc(s.region || '—') + '</td><td>' + (s.vox_monthly_rub !== null ? s.vox_monthly_rub + ' ₽/мес' : '—') + '</td>' +
            '<td style="white-space:nowrap;"><button class="btn btn-secondary btn-sm" data-unstock="' + s.id + '">Убрать из запаса</button> ' +
            '<button class="btn btn-danger btn-sm" data-deactivate="' + s.id + '" data-phone="' + esc(s.phone_number) + '">Отключить</button></td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="tn-muted">Свободных номеров нет. Номер, от которого отказался или который не оплатил пользователь, попадает сюда; свой номер можно добавить на вкладке «Тестовый пул».</p>';
    html += '<h4 style="margin:1.25rem 0 .5rem;">Коррекция телефонного баланса</h4>' +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-end;">' +
        '<div class="form-group" style="margin:0;"><label>Email</label><input class="form-control" id="vf-adj-email" style="width:220px;"></div>' +
        '<div class="form-group" style="margin:0;"><label>Сумма, ₽ (− списать)</label><input class="form-control" id="vf-adj-amount" type="number" step="0.01" style="width:140px;"></div>' +
        '<div class="form-group" style="margin:0;"><label>Комментарий</label><input class="form-control" id="vf-adj-notes" style="width:220px;"></div>' +
        '<button class="btn btn-secondary" id="vf-adj-btn">Применить</button>' +
      '</div>';
    body.innerHTML = html;
    body.querySelectorAll('[data-docs]').forEach(function (b) {
      b.addEventListener('click', function () { openVerificationDetails(b.dataset.docs, true); });
    });
    body.querySelectorAll('[data-release]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var ok = await VF.confirm({ title: 'Забрать номер ' + T().formatPhoneNumber(b.dataset.phone) + '?',
          message: 'Номер перестанет работать у пользователя и вернётся в запас. Деньги не возвращаются автоматически.',
          confirmText: 'Забрать', danger: true });
        if (!ok) return;
        await adminAction('/telephony/admin/hosted-numbers/' + b.dataset.release + '/release');
      });
    });
    body.querySelectorAll('[data-unstock]').forEach(function (b) {
      b.addEventListener('click', function () {
        adminAction('/telephony/admin/hosted-stock/' + b.dataset.unstock, { in_stock: false }, 'PUT');
      });
    });
    body.querySelectorAll('[data-deactivate]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var ok = await VF.confirm({ title: 'Отключить ' + T().formatPhoneNumber(b.dataset.phone) + ' в Voximplant?',
          message: 'Аренда номера прекратится, вернуть номер будет нельзя.', confirmText: 'Отключить', danger: true });
        if (!ok) return;
        await adminAction('/telephony/admin/hosted-numbers/' + b.dataset.deactivate + '/deactivate');
      });
    });
    body.querySelector('#vf-adj-btn').addEventListener('click', function () {
      adminAction('/telephony/admin/telephony-wallet/adjust', {
        email: body.querySelector('#vf-adj-email').value.trim(),
        amount_rub: parseFloat(body.querySelector('#vf-adj-amount').value),
        notes: body.querySelector('#vf-adj-notes').value.trim() || null,
      });
    });
  }

  async function adminAction(url, payload, method) {
    try {
      T().setLoading(true);
      var res = await T().api.fetch(url, { method: method || 'POST', body: payload || {} });
      T().showNotification((res && res.message) || 'Готово', 'success');
      await refreshAdmin();
      T().loadMyNumbers();
    } catch (e) {
      T().showNotification(e.message || 'Ошибка', 'error');
    } finally {
      T().setLoading(false);
    }
  }

  function leftText(lease) {
    if (!lease) return '';
    var s = typeof lease.seconds_left === 'number' ? lease.seconds_left
      : Math.max(0, Math.round((new Date(lease.expires_at) - new Date()) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  async function renderPool(body) {
    var rows = await T().api.get('/telephony/test-numbers/admin/pool');
    var list = Array.isArray(rows) ? rows : (rows.numbers || rows.items || []);
    if (!list.length) {
      body.innerHTML = '<p class="tn-muted">У администраторов нет номеров Voximplant</p>';
      return;
    }
    body.innerHTML =
      '<p class="tn-muted" style="margin-top:0;">Галочка «Тестовый пул» отдаёт номер новым пользователям на несколько минут. ' +
      'Если привязать к номеру из пула своего ассистента, номер временно выйдет из пула — «Отвязать» в «Мои номера» вернёт его. ' +
      '«Запас физлиц» — номер предлагается физлицам как готовый.</p>' +
      '<table class="numbers-table"><thead><tr><th>Номер</th><th>Владелец</th><th>Тестовый пул</th><th>Запас физлиц</th><th>Сейчас</th><th></th></tr></thead><tbody>' +
      list.map(function (p) {
        var now = p.lease
          ? 'Аренда: ' + esc(p.lease.user_email || '') + ' · ' + leftText(p.lease)
          : (p.return_to_test_pool ? 'Админ привязал своего ассистента' : (p.assistant_type ? 'Привязан ассистент' : '—'));
        return '<tr><td><span class="phone-number">' + esc(T().formatPhoneNumber(p.phone_number)) + '</span></td>' +
          '<td>' + esc(p.owner_email) + '</td>' +
          '<td><input type="checkbox" data-pool="' + p.id + '"' + (p.is_test_pool ? ' checked' : '') + '></td>' +
          '<td><input type="checkbox" data-stock="' + p.id + '"' + (p.hosted_stock ? ' checked' : '') + (p.is_test_pool ? ' disabled' : '') + '></td>' +
          '<td style="font-size:.85rem;">' + now + '</td>' +
          '<td>' + (p.lease ? '<button class="btn btn-secondary btn-sm" data-lease="' + p.lease.id + '">Освободить</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    body.querySelectorAll('[data-pool]').forEach(function (c) {
      c.addEventListener('change', function () {
        adminAction('/telephony/test-numbers/admin/pool/' + c.dataset.pool, { is_test_pool: c.checked }, 'PUT');
      });
    });
    body.querySelectorAll('[data-stock]').forEach(function (c) {
      c.addEventListener('change', function () {
        adminAction('/telephony/admin/hosted-stock/' + c.dataset.stock, { in_stock: c.checked }, 'PUT');
      });
    });
    body.querySelectorAll('[data-lease]').forEach(function (b) {
      b.addEventListener('click', function () {
        adminAction('/telephony/test-numbers/admin/leases/' + b.dataset.lease + '/release').then(function () {
          if (T().reloadTestNumber) T().reloadTestNumber();
        });
      });
    });
  }

  // ===========================================================================
  window.TELV = { onStatus: onStatus, openForm: openForm, openWallet: openWallet, refreshAdmin: refreshAdmin };

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.TEL) return;
    var btn = document.getElementById('open-individual-form-btn');
    if (btn) btn.addEventListener('click', openForm);
    // В онбординге страница показывает только тестовый номер
    if (!document.body.classList.contains('tn-ob-focus')) initAdmin();
  });
})();
