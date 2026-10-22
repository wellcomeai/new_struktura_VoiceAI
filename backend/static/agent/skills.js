/* ============================================================================
 * agent/skills.js — Раздел «Skills» в модалке настроек агента: скачать скилл
 * (/static/agent-api.md → SKILL.md) для Claude Code / Codex, статус API-ключа
 * пользователя и готовые примеры запросов с кнопкой «Копировать».
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные.
 * Подключается из agent.html ПОСЛЕ settings-layout.js и ПЕРЕД init.js.
 * ========================================================================== */

const SKILL_KEY_PLACEHOLDER = 'Мой API-ключ: vfy_...';

// Примеры без agent_id: агент сам найдёт агентов через GET /api/agent/list.
const SKILL_EXAMPLES = [
  {
    title: 'Разобраться, как устроен агент',
    text:
`Прочитай скилл Voicyfy (SKILL.md). Посмотри моих агентов и расскажи, как устроен один из них: чем он занимается, какая у него голосовая модель и голос, какая модель оркестратора, что написано в документах компании и инструкциях, какие правила лежат в памяти агента. Если агентов несколько — сначала покажи список.
${SKILL_KEY_PLACEHOLDER}`,
  },
  {
    title: 'Настроить агента под задачу',
    text:
`Прочитай скилл Voicyfy (SKILL.md). Настрой моего агента под стоматологию «Улыбка» в Казани. За день до приёма он звонит пациенту и подтверждает запись; если пациент не может прийти — предлагает перенести визит и сообщает мне в Telegram. Не дозвонился — пишет пациенту в Telegram и через 3 часа проверяет, ответил ли он. Представляется Анной, говорит дружелюбно и коротко, без давления. Если агентов несколько — спроси, какого настроить. Перед сохранением покажи, что поменяешь.
${SKILL_KEY_PLACEHOLDER}`,
  },
  {
    title: 'Добавить правила в память',
    text:
`Прочитай скилл Voicyfy (SKILL.md). Добавь моему агенту в память правила: коммерческое предложение отправляй клиенту только в PDF; о каждом клиенте, который готов купить, сразу пиши мне в Telegram. Сначала проверь, нет ли похожих правил.
${SKILL_KEY_PLACEHOLDER}`,
  },
  {
    title: 'Поменять манеру разговора',
    text:
`Прочитай скилл Voicyfy (SKILL.md). Сделай голосового агента формальнее: обращение только на «вы», без шуток и сленга, короткие фразы, на возражение «дорого» — предложить рассрочку. Покажи инструкции голосового агента до и после.
${SKILL_KEY_PLACEHOLDER}`,
  },
];

function renderSkillExamples(){
  const wrap = document.getElementById('i-skills-examples');
  if(!wrap) return;
  wrap.innerHTML = SKILL_EXAMPLES.map((ex, i) => `
    <div class="skill-example">
      <div class="skill-example-head">
        <span>${esc(ex.title)}</span>
        <button type="button" class="btn btn-secondary btn-sm" onclick="copySkillExample(${i})"><i class="fas fa-copy"></i> Копировать</button>
      </div>
      <pre class="skill-code">${esc(ex.text)}</pre>
    </div>`).join('');
}

async function copySkillExample(i){
  const ex = SKILL_EXAMPLES[i];
  if(!ex) return;
  try{
    if(navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(ex.text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = ex.text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast('Скопировано — вставьте свой API-ключ в конце','success');
  }catch(e){ showToast('Не удалось скопировать','error'); }
}

async function loadSkillsKeyStatus(){
  const wrap = document.getElementById('i-skills-key');
  if(!wrap) return;
  wrap.innerHTML = '<span class="form-hint">Проверяем ключ…</span>';
  let st = null;
  try{
    const r = await apiFetch('/api/users/api-key');
    if(r && r.ok) st = await r.json();
  }catch(e){ st = null; }
  if(!st){
    wrap.innerHTML = '<span class="form-hint">Не удалось проверить ключ.</span>';
    return;
  }
  if(st.has_key){
    wrap.innerHTML = `<span class="skill-key-ok"><i class="fas fa-check-circle"></i> Ключ создан: <code>${esc(st.key_prefix || 'vfy_')}…</code></span>`;
  } else {
    wrap.innerHTML = '<a class="btn btn-secondary btn-sm" href="/static/settings.html#api-key-section" target="_blank" rel="noopener"><i class="fas fa-key"></i> Перейти к ключу</a>'
      + '<span class="form-hint">Ключ ещё не создан.</span>';
  }
}

// Кнопка «Сохранить» на вкладке Skills не нужна — сохранять там нечего.
if(typeof switchSettingsSection === 'function'){
  const _origSwitchSettingsSection = switchSettingsSection;
  switchSettingsSection = function(key){
    const r = _origSwitchSettingsSection.apply(this, arguments);
    const saveBtn = document.getElementById('instructions-save-btn');
    if(saveBtn) saveBtn.style.display = key === 'skills' ? 'none' : '';
    if(key === 'skills') loadSkillsKeyStatus();
    return r;
  };
}

document.addEventListener('DOMContentLoaded', renderSkillExamples);
