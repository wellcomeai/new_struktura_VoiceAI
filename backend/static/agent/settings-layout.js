/* ============================================================================
 * agent/settings-layout.js — Широкая модалка настроек агента: разделы слева,
 * содержимое справа; логотип провайдера в бейдже типа модели.
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные.
 * Подключается из agent.html ПОСЛЕ panels.js и ПЕРЕД init.js.
 *
 * Разделы: элементы .settings-nav-item[data-section] переключают
 * .settings-section[data-section] в #instructions-modal-overlay. Поля формы и их
 * id не менялись — openInstructionsModal/saveInstructions (instructions-voice.js)
 * работают как раньше; здесь только оборачиваем открытие, чтобы всегда
 * начинать с первого раздела.
 * ========================================================================== */

function switchSettingsSection(key){
  const overlay = document.getElementById('instructions-modal-overlay');
  if(!overlay) return;
  overlay.querySelectorAll('.settings-nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === key));
  overlay.querySelectorAll('.settings-section').forEach(s => s.classList.toggle('active', s.dataset.section === key));
  const content = document.getElementById('settings-content');
  if(content) content.scrollTop = 0;
}

function _settingsBind(){
  document.querySelectorAll('#settings-nav .settings-nav-item').forEach(b => {
    b.addEventListener('click', () => switchSettingsSection(b.dataset.section));
  });
}

if(typeof openInstructionsModal === 'function'){
  const _origOpenInstructionsModal = openInstructionsModal;
  openInstructionsModal = function(){
    const r = _origOpenInstructionsModal.apply(this, arguments);
    try{ switchSettingsSection('general'); }catch(e){ /* ignore */ }
    return r;
  };
}

// Логотип провайдера в бейдже типа модели в карточке агента (renderAgentHeader
// пишет туда textContent — добавляем логотип поверх, саму функцию не правим).
function _syncTypeBadgeLogo(){
  const badge = document.getElementById('agent-type-badge');
  if(!badge || !window.VF || !VF.logo) return;
  const type = (typeof agentData !== 'undefined' && agentData) ? agentData.assistant_type : null;
  if(!type) return;
  const text = badge.textContent;
  badge.innerHTML = VF.logo(type, { bare:true, size:13 }) + esc(text);
}
if(typeof renderAgentHeader === 'function'){
  const _origRenderAgentHeaderForLogo = renderAgentHeader;
  renderAgentHeader = function(){
    const r = _origRenderAgentHeaderForLogo.apply(this, arguments);
    try{ _syncTypeBadgeLogo(); }catch(e){ /* ignore */ }
    return r;
  };
}

document.addEventListener('DOMContentLoaded', _settingsBind);
