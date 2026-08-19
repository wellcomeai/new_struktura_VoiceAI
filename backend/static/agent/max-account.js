/* ============================================================================
 * agent/max-account.js — ЛИЧНЫЙ аккаунт мессенджера MAX агента (PyMax)
 *                        → /api/agent/max-account
 * Зеркалит telegram-account.js (личный Telegram), но у MAX авторизация
 * асинхронная: /start запускает фоновую задачу, а /verify-code и
 * /verify-password лишь передают ей код/пароль — поэтому после отправки UI
 * ОПРАШИВАЕТ статус, пока он не станет pending_password / connected / error.
 * Строка коннектора рендерится внутри списка коннекторов (connectors.js
 * вызывает maxAccountConnectorRowHtml/maxAccountSummaryHtml).
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные.
 * Документация: backend/static/agent/CLAUDE.md
 * ========================================================================== */

const MAX_ACC_API = '/api/agent/max-account';
let maxAccState = null;   // ответ GET /max-account (или null)
let maxAccBusy = false;   // защита от дабл-кликов на шагах авторизации
let maxAccPollTimer = null;

async function loadMaxAccount(){
  try{
    const r = await apiFetch(MAX_ACC_API);
    maxAccState = (r && r.status === 200) ? await r.json() : null;
  }catch(e){ maxAccState = null; }
  if(typeof renderConnectorsBlock === 'function') renderConnectorsBlock();
  if(typeof renderConnectorsList === 'function') renderConnectorsList();
  renderMaxAccountModal();
}

// ── Строка в списке коннекторов (вызывается из connectors.js) ──
function maxAccountConnectorRowHtml(){
  const s = maxAccState;
  if(!s || !s.configured) return '';
  const st = s.status || 'not_connected';
  let right, sub, subColor;
  if(st === 'connected'){
    const who = s.max_name ? esc(s.max_name) : (s.phone_masked || '');
    right = `${who ? `<div style="font-size:12px;color:#64748b">${who}</div>` : ''}`
      + `<button class="btn btn-secondary btn-sm" onclick="openMaxAccountModal()"><i class="fas fa-gear"></i> Настроить</button>`;
    sub = s.auto_reply_enabled ? 'Подключено · автоответ включён' : 'Подключено · автоответ выключен';
    subColor = '#166534';
  } else if(st === 'pending_code' || st === 'pending_password'){
    right = `<button class="btn btn-primary btn-sm" onclick="openMaxAccountModal()"><i class="fas fa-link"></i> Продолжить</button>`;
    sub = 'Авторизация не завершена';
    subColor = '#b45309';
  } else if(st === 'error'){
    right = `<button class="btn btn-primary btn-sm" onclick="openMaxAccountModal()"><i class="fas fa-link"></i> Переподключить</button>`;
    sub = 'Требует переподключения';
    subColor = '#b45309';
  } else {
    right = `<button class="btn btn-primary btn-sm" onclick="openMaxAccountModal()"><i class="fas fa-link"></i> Подключить</button>`;
    sub = 'Не подключено';
    subColor = '#94a3b8';
  }
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;`
    + `padding:12px 0;border-bottom:1px solid var(--border,#e2e8f0)">`
    + `<div style="display:flex;align-items:center;gap:10px">`
    + `<i class="fas fa-comment-dots" style="color:#6D28D9;font-size:18px;width:22px;text-align:center"></i>`
    + `<div><div style="font-weight:600;font-size:14px">MAX (личный аккаунт)</div>`
    + `<div style="font-size:12px;color:${subColor}">${sub}</div></div></div>`
    + `<div style="text-align:right">${right}</div></div>`;
}

// ── Строка в свёрнутом блоке коннекторов на дашборде ──
function maxAccountSummaryHtml(){
  const s = maxAccState;
  if(!s || !s.configured || s.status !== 'connected') return '';
  const who = s.max_name ? ' · ' + esc(s.max_name) : '';
  return `<div style="font-size:13px;color:var(--green-dark,#166534);margin:2px 0">`
    + `<i class="fas fa-circle-check"></i> MAX (личный)${who}</div>`;
}

// true, если карточку коннекторов стоит показывать ради MAX
function maxAccountAvailable(){
  return !!(maxAccState && maxAccState.configured);
}

// ── Модалка ──
function openMaxAccountModal(){
  const ov = document.getElementById('max-account-modal-overlay');
  if(ov) ov.classList.remove('hidden');
  renderMaxAccountModal();
}

function closeMaxAccountModal(){
  const ov = document.getElementById('max-account-modal-overlay');
  if(ov) ov.classList.add('hidden');
  _maxAccStopPolling();
}

function renderMaxAccountModal(){
  const el = document.getElementById('max-account-modal-body');
  if(!el) return;
  const s = maxAccState;
  if(!s || !s.configured){
    el.innerHTML = '<div class="empty">Коннектор MAX не настроен на сервере</div>';
    return;
  }
  const st = s.status || 'not_connected';

  const warn = `<div style="background:#F5F3FF;border-left:3px solid #6D28D9;padding:10px 12px;border-radius:8px;font-size:12px;color:#4C1D95;margin-bottom:14px">
      <b>Важно:</b> агент будет писать клиентам с вашего личного аккаунта MAX.
      Используется неофициальный доступ — не рассылайте сообщения по холодной базе,
      подключайте только рабочий номер с согласия владельца. Отправка ограничена
      лимитами, писать первым по номеру телефона агент может лишь изредка.
    </div>`;

  if(st === 'not_connected' || st === 'error'){
    el.innerHTML = `
      ${st === 'error' ? `<div style="background:#FEE2E2;border-left:3px solid #DC2626;padding:10px 12px;border-radius:8px;font-size:12px;color:#7F1D1D;margin-bottom:14px">Сессия недействительна (${esc(s.last_error || 'отозвана')}). Подключите аккаунт заново.</div>` : warn}
      <label class="form-label">Номер телефона аккаунта MAX</label>
      <input type="tel" class="form-input" id="maxacc-phone" placeholder="+79991234567" value="">
      <div style="font-size:12px;color:#64748b;margin:6px 0 14px">MAX пришлёт код подтверждения по SMS.</div>
      <button class="btn btn-primary" id="maxacc-submit" onclick="maxAccStart()"><i class="fas fa-paper-plane"></i> Получить код</button>`;
  } else if(st === 'pending_code'){
    el.innerHTML = `
      <div style="font-size:13px;margin-bottom:12px">Код отправлен на номер <b>${esc(s.phone_masked || '')}</b>. Введите код из SMS.</div>
      <label class="form-label">Код подтверждения</label>
      <input type="text" class="form-input" id="maxacc-code" placeholder="12345" autocomplete="one-time-code">
      <div style="height:14px"></div>
      <button class="btn btn-primary" id="maxacc-submit" onclick="maxAccVerifyCode()"><i class="fas fa-check"></i> Подтвердить</button>
      <button class="btn btn-secondary" onclick="maxAccRestart()" style="margin-left:8px">Начать заново</button>`;
  } else if(st === 'pending_password'){
    el.innerHTML = `
      <div style="font-size:13px;margin-bottom:12px">На аккаунте включена двухэтапная аутентификация. Введите пароль.</div>
      <label class="form-label">Пароль (2FA)</label>
      <input type="password" class="form-input" id="maxacc-password" placeholder="Пароль">
      <div style="height:14px"></div>
      <button class="btn btn-primary" id="maxacc-submit" onclick="maxAccVerifyPassword()"><i class="fas fa-check"></i> Войти</button>
      <button class="btn btn-secondary" onclick="maxAccRestart()" style="margin-left:8px">Начать заново</button>`;
  } else { // connected
    const who = s.max_name ? esc(s.max_name) : '';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <i class="fas fa-circle-check" style="color:#16A34A;font-size:20px"></i>
        <div>
          <div style="font-weight:600;font-size:14px">Подключён${who ? ': ' + who : ''}</div>
          <div style="font-size:12px;color:#64748b">${esc(s.phone_masked || '')}</div>
        </div>
      </div>
      ${warn}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--border,#e2e8f0)">
        <div>
          <div style="font-weight:600;font-size:13px">Автоответ на входящие</div>
          <div style="font-size:12px;color:#64748b">Агент сам отвечает на новые сообщения в MAX (проверка раз в минуту)</div>
        </div>
        <label class="switch"><input type="checkbox" id="maxacc-autoreply" ${s.auto_reply_enabled ? 'checked' : ''} onchange="maxAccToggleAutoReply(this.checked)"><span class="slider"></span></label>
      </div>
      <div style="padding:10px 0;border-top:1px solid var(--border,#e2e8f0)">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">Кому отвечать</div>
        <select class="form-input" id="maxacc-scope" onchange="maxAccSetScope(this.value)">
          <option value="contacts" ${s.reply_scope !== 'all' ? 'selected' : ''}>Только контактам агента (рекомендуется)</option>
          <option value="all" ${s.reply_scope === 'all' ? 'selected' : ''}>Всем новым личным сообщениям</option>
        </select>
        <div style="font-size:12px;color:#64748b;margin-top:6px">«Всем» — агент будет отвечать даже друзьям и родным, если они напишут. Используйте только для рабочего аккаунта.</div>
      </div>
      <div style="padding-top:14px;border-top:1px solid var(--border,#e2e8f0)">
        <button class="btn btn-secondary" onclick="maxAccDisconnect()"><i class="fas fa-link-slash"></i> Отключить аккаунт</button>
      </div>`;
  }
}

function _maxAccLock(lock, text){
  maxAccBusy = lock;
  const btn = document.getElementById('maxacc-submit');
  if(btn){
    btn.disabled = lock;
    if(lock) btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> ${text || 'Подождите…'}`;
  }
}

async function _maxAccPost(path, body){
  const r = await apiFetch(MAX_ACC_API + path, { method: 'POST', body: JSON.stringify(body) });
  if(r && r.status === 200){ maxAccState = await r.json(); return true; }
  const err = await r?.json().catch(() => ({}));
  showToast(maxAccErr(err.detail), 'error');
  return false;
}

function _maxAccStopPolling(){
  if(maxAccPollTimer){ clearTimeout(maxAccPollTimer); maxAccPollTimer = null; }
}

// Опрос статуса, пока фоновая задача авторизации не сменит его на ожидаемый.
// from_status — статус, из которого мы ждём перехода (pending_code/pending_password).
function _maxAccPollStatus(from_status, tries){
  _maxAccStopPolling();
  const left = (typeof tries === 'number') ? tries : 60; // ~2.5 мин при 2.5с шаге
  maxAccPollTimer = setTimeout(async () => {
    try{
      const r = await apiFetch(MAX_ACC_API);
      if(r && r.status === 200){
        const st = await r.json();
        maxAccState = st;
        if(st.status !== from_status){
          _maxAccLock(false);
          renderMaxAccountModal();
          if(typeof renderConnectorsList === 'function') renderConnectorsList();
          if(st.status === 'connected') showToast('MAX подключён', 'success');
          else if(st.status === 'error') showToast(maxAccErr(st.last_error), 'error');
          return;
        }
      }
    }catch(e){}
    if(left <= 1){
      _maxAccLock(false);
      showToast('MAX долго не отвечает — попробуйте ещё раз', 'error');
      return;
    }
    _maxAccPollStatus(from_status, left - 1);
  }, 2500);
}

async function maxAccStart(){
  if(maxAccBusy) return;
  const phone = (document.getElementById('maxacc-phone')?.value || '').trim();
  if(!phone){ showToast('Укажите номер телефона', 'error'); return; }
  _maxAccLock(true, 'Отправляем код…');
  try{ await _maxAccPost('/start', { phone }); }
  catch(e){ showToast('Ошибка сети', 'error'); }
  _maxAccLock(false);
  renderMaxAccountModal();
}

async function maxAccVerifyCode(){
  if(maxAccBusy) return;
  const code = (document.getElementById('maxacc-code')?.value || '').trim();
  if(!code){ showToast('Введите код', 'error'); return; }
  _maxAccLock(true, 'Проверяем код…');
  try{
    const ok = await _maxAccPost('/verify-code', { code });
    if(ok){ _maxAccPollStatus('pending_code'); return; } // ждём connected/pending_password/error
  }catch(e){ showToast('Ошибка сети', 'error'); }
  _maxAccLock(false);
}

async function maxAccVerifyPassword(){
  if(maxAccBusy) return;
  const password = document.getElementById('maxacc-password')?.value || '';
  if(!password){ showToast('Введите пароль', 'error'); return; }
  _maxAccLock(true, 'Входим…');
  try{
    const ok = await _maxAccPost('/verify-password', { password });
    if(ok){ _maxAccPollStatus('pending_password'); return; }
  }catch(e){ showToast('Ошибка сети', 'error'); }
  _maxAccLock(false);
}

// «Начать заново»: сбрасываем незавершённую авторизацию удалением строки.
async function maxAccRestart(){
  _maxAccStopPolling();
  try{ await apiFetch(MAX_ACC_API, { method: 'DELETE' }); }catch(e){}
  await loadMaxAccount();
}

async function maxAccToggleAutoReply(enabled){
  try{
    const r = await apiFetch(MAX_ACC_API + '/settings', { method: 'PATCH', body: JSON.stringify({ auto_reply_enabled: enabled }) });
    if(r && r.status === 200){
      maxAccState = await r.json();
      showToast(enabled ? 'Автоответ включён' : 'Автоответ выключен', 'success');
    } else {
      const err = await r?.json().catch(() => ({}));
      showToast(maxAccErr(err.detail), 'error');
    }
  }catch(e){ showToast('Ошибка сети', 'error'); }
  if(typeof renderConnectorsList === 'function') renderConnectorsList();
  renderMaxAccountModal();
}

async function maxAccSetScope(scope){
  try{
    const r = await apiFetch(MAX_ACC_API + '/settings', { method: 'PATCH', body: JSON.stringify({ reply_scope: scope }) });
    if(r && r.status === 200) maxAccState = await r.json();
  }catch(e){ showToast('Ошибка сети', 'error'); }
}

async function maxAccDisconnect(){
  if(!confirm('Отключить личный MAX? Агент перестанет писать клиентам и отвечать на входящие.')) return;
  try{
    const r = await apiFetch(MAX_ACC_API, { method: 'DELETE' });
    if(r && r.status === 200){
      showToast('MAX отключён', 'success');
      closeMaxAccountModal();
    }
  }catch(e){ showToast('Ошибка сети', 'error'); }
  await loadMaxAccount();
}

function maxAccErr(detail){
  const map = {
    not_configured: 'Коннектор MAX не настроен на сервере',
    already_connected: 'Аккаунт уже подключён',
    auth_not_started: 'Авторизация не начата — введите номер телефона',
    password_not_expected: 'Пароль сейчас не требуется',
    invalid_reply_scope: 'Неверное значение охвата',
    not_connected: 'MAX не подключён',
    phone_invalid: 'Неверный номер телефона',
    code_invalid: 'Неверный код — начните заново',
    code_expired: 'Код истёк — начните заново',
    password_invalid: 'Неверный пароль (2FA)',
    session_revoked: 'Сессия отозвана — подключите заново',
    max_not_registered: 'На этом номере нет аккаунта MAX',
    max_connect_timeout: 'MAX не отвечает — попробуйте позже',
    max_unavailable: 'Не удалось соединиться с MAX — попробуйте позже',
    sms_code_timeout: 'Код не был введён вовремя — начните заново',
    password_timeout: 'Пароль не был введён вовремя — начните заново',
    agent_not_found: 'Агент не найден',
  };
  return map[detail] || 'Ошибка MAX, попробуйте ещё раз';
}
