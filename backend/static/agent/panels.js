/* ============================================================================
 * agent/panels.js — Сворачиваемые боковые панели «Работа» и «Агент» (v7).
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные.
 * Подключается из agent.html ПОСЛЕ dashboard.js и ПЕРЕД init.js.
 *
 * Что делает:
 *   • язычки на краях чата (.handle), кнопки в топбаре (.panel-btn) и в шапках
 *     панелей — всё с data-panel="left|right" — сворачивают/раскрывают панель;
 *   • состояние хранится в localStorage (agent_panels_v1), по умолчанию обе открыты;
 *   • клавиши [ и ] переключают панели (когда фокус не в поле ввода);
 *   • на мобильной раскладке (MOBILE_MQ из dashboard.js) панели живут в drawer,
 *     поэтому любой переключатель просто открывает drawer;
 *   • буква-аватар в переключателе агентов синхронизируется с именем
 *     (renderAgentHeader из dashboard.js оборачивается, сама функция не правится).
 * ========================================================================== */

const PANELS_STORAGE_KEY = 'agent_panels_v1';
let panelsState = { left: true, right: true };

function _panelsLoad(){
  try{
    const s = JSON.parse(localStorage.getItem(PANELS_STORAGE_KEY) || 'null');
    if(s && typeof s.left === 'boolean' && typeof s.right === 'boolean') panelsState = s;
  }catch(e){ /* ignore */ }
}
function _panelsSave(){
  try{ localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(panelsState)); }catch(e){ /* ignore */ }
}

function applyPanels(){
  const layout = document.getElementById('main-layout');
  if(!layout) return;
  layout.classList.toggle('left-closed', !panelsState.left);
  layout.classList.toggle('right-closed', !panelsState.right);
  document.querySelectorAll('.panel-btn[data-panel]').forEach(btn => {
    const side = btn.getAttribute('data-panel');
    const open = !!panelsState[side];
    btn.classList.toggle('is-on', !open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  });
}

function togglePanel(side){
  if(side !== 'left' && side !== 'right') return;
  // На узком экране панели лежат в drawer — просто открываем его.
  if(typeof MOBILE_MQ !== 'undefined' && MOBILE_MQ.matches){
    if(typeof openDrawer === 'function') openDrawer();
    return;
  }
  panelsState[side] = !panelsState[side];
  _panelsSave();
  applyPanels();
}

function _panelsBind(){
  document.querySelectorAll('[data-panel]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); togglePanel(el.getAttribute('data-panel')); });
  });
  document.addEventListener('keydown', e => {
    const t = e.target;
    if(t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    // Панели переключаем только на дашборде (не в мастере/онбординге и не при открытой модалке)
    const layout = document.getElementById('main-layout');
    if(!layout || layout.style.display === 'none') return;
    if(document.querySelector('.modal-overlay:not(.hidden)')) return;
    if(e.key === '[') { e.preventDefault(); togglePanel('left'); }
    else if(e.key === ']') { e.preventDefault(); togglePanel('right'); }
  });
}

// Буква-аватар в переключателе агентов: обёртка над renderAgentHeader (dashboard.js).
function _syncNavAvatar(){
  const el = document.getElementById('nav-agent-avatar');
  if(!el) return;
  const name = (typeof agentData !== 'undefined' && agentData && agentData.name) ? agentData.name : 'А';
  el.textContent = String(name).trim().charAt(0).toUpperCase() || 'А';
}
if(typeof renderAgentHeader === 'function'){
  const _origRenderAgentHeader = renderAgentHeader;
  renderAgentHeader = function(){
    const r = _origRenderAgentHeader.apply(this, arguments);
    try{ _syncNavAvatar(); }catch(e){ /* ignore */ }
    return r;
  };
}

// Выход с платформы: свой обработчик, не зависящий от sidebar.js. Снимаем токен,
// останавливаем фоновый опрос кредитов и уводим на страницу входа.
function agentLogout(){
  try{ localStorage.removeItem('auth_token'); }catch(e){ /* ignore */ }
  try{ sessionStorage.removeItem('vf_is_admin'); }catch(e){ /* ignore */ }
  try{ if(typeof creditsTimer !== 'undefined' && creditsTimer) clearInterval(creditsTimer); }catch(e){ /* ignore */ }
  window.location.replace('/static/login.html');
}

document.addEventListener('DOMContentLoaded', () => {
  const lo = document.getElementById('logout-btn');
  if(lo) lo.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); agentLogout(); });
  _panelsLoad();
  applyPanels();
  _panelsBind();
});
