/* ============================================================================
 * agent/memory.js — Память агента (блокнот оркестратора) → /api/agent/memory
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные,
 * доступны между всеми файлами agent/*.js и из inline-onclick в разметке.
 * Подключается из agent.html. Документация: backend/static/agent/CLAUDE.md
 *
 * Память — список коротких заметок с id по секциям (instructions /
 * observations / plans). Агент ведёт её инструментом update_agent_memory,
 * владелец здесь может добавить, поправить или удалить отдельную заметку.
 * Все правки точечные — полной перезаписи нет (см. backend/services/agent_memory.py).
 * ========================================================================== */

// ════════════════ ПАМЯТЬ АГЕНТА ════════════════

let agentMemoryState = null;      // ответ GET /memory
let memoryEditingId = null;       // id заметки, открытой на редактирование

async function loadAgentMemoryStatus(){
  try{
    const r = await apiFetch(withAgentId(API + '/memory'));
    if(!r || r.status !== 200){ agentMemoryState = null; renderMemoryBlock(); return; }
    agentMemoryState = await r.json();
  }catch(e){ agentMemoryState = null; }
  renderMemoryBlock();
  if(!document.getElementById('memory-modal-overlay').classList.contains('hidden')) renderMemoryModal();
}

function memorySectionLabel(key){
  const s = (agentMemoryState?.sections || []).find(x => x.key === key);
  return s ? s.label : key;
}

function renderMemoryBlock(){
  const el = document.getElementById('memory-status-block');
  if(!el) return;
  const s = agentMemoryState;
  if(!s){ el.innerHTML = '<div class="empty">Недоступно</div>'; return; }
  if(!s.count){ el.innerHTML = '<div class="empty">Пока пусто — агент заполнит по ходу работы</div>'; return; }
  const per = {};
  (s.notes || []).forEach(n => { per[n.section] = (per[n.section] || 0) + 1; });
  const parts = (s.sections || []).filter(x => per[x.key]).map(x => `${esc(x.label)}: ${per[x.key]}`);
  el.innerHTML = `<div style="font-size:13px;color:var(--green-dark,#166534)">`
    + `<i class="fas fa-circle-check"></i> ${s.count} ${memoryPlural(s.count)}</div>`
    + `<div style="font-size:12px;color:#94a3b8;margin-top:4px">${parts.join(' · ')}</div>`;
}

function memoryPlural(n){
  const m10 = n % 10, m100 = n % 100;
  if(m10 === 1 && m100 !== 11) return 'заметка';
  if(m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'заметки';
  return 'заметок';
}

function openMemoryModal(){
  memoryEditingId = null;
  document.getElementById('memory-modal-overlay').classList.remove('hidden');
  renderMemoryModal();
  if(!agentMemoryState) loadAgentMemoryStatus();
}

function closeMemoryModal(){
  memoryEditingId = null;
  document.getElementById('memory-modal-overlay').classList.add('hidden');
}

function renderMemoryModal(){
  const s = agentMemoryState;
  const meta = document.getElementById('memory-modal-meta');
  const list = document.getElementById('memory-notes-list');
  const clearBtn = document.getElementById('memory-clear-btn');
  const sel = document.getElementById('memory-add-section');

  if(sel && s && !sel.options.length){
    (s.sections || []).forEach(x => {
      const o = document.createElement('option'); o.value = x.key; o.textContent = x.label; sel.appendChild(o);
    });
  }
  if(!s){
    meta.textContent = 'Загрузка…';
    list.innerHTML = '';
    clearBtn.style.display = 'none';
    return;
  }
  meta.innerHTML = `<i class="fas fa-brain"></i> ${s.count} из ${s.notes_limit} заметок · `
    + `${(s.chars_used||0).toLocaleString('ru-RU')} / ${(s.chars_limit||0).toLocaleString('ru-RU')} символов`;
  clearBtn.style.display = s.count ? '' : 'none';

  if(!s.count){
    list.innerHTML = '<div class="empty">Память пуста. Агент начнёт заполнять её после первых звонков и разговоров с вами.</div>';
    return;
  }
  let html = '';
  (s.sections || []).forEach(sec => {
    const rows = (s.notes || []).filter(n => n.section === sec.key);
    html += `<div style="margin-bottom:14px">`
      + `<div style="font-size:12.5px;font-weight:600;color:var(--vf-text-2,#475569);margin-bottom:6px">${esc(sec.label)} <span style="color:#94a3b8;font-weight:400">· ${rows.length}</span></div>`;
    if(!rows.length){
      html += `<div style="font-size:12.5px;color:#94a3b8;padding:4px 0">пусто</div>`;
    }
    rows.forEach(n => { html += renderMemoryNoteRow(n); });
    html += `</div>`;
  });
  list.innerHTML = html;
  if(memoryEditingId){
    const ta = document.getElementById('memory-edit-' + memoryEditingId);
    if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function renderMemoryNoteRow(n){
  const who = n.source === 'owner' ? 'вы' : 'агент';
  const when = n.updated_at ? fmtDate(n.updated_at + (n.updated_at.endsWith('Z') ? '' : 'Z')) : '';
  const metaLine = `<span style="font-size:11.5px;color:#94a3b8">${esc(n.id)} · ${who}${when ? ' · ' + esc(when) : ''}</span>`;
  if(memoryEditingId === n.id){
    return `<div style="border:1px solid var(--vf-accent,#2563eb);border-radius:8px;padding:8px 10px;margin-bottom:6px">
      <textarea class="form-input" id="memory-edit-${esc(n.id)}" rows="3" maxlength="400" style="min-height:60px">${esc(n.text)}</textarea>
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:6px">
        ${metaLine}
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm" onclick="cancelEditMemoryNote()">Отмена</button>
          <button class="btn btn-primary btn-sm" onclick="saveMemoryNote('${esc(n.id)}')"><i class="fas fa-check"></i> Сохранить</button>
        </div>
      </div>
    </div>`;
  }
  return `<div style="border:1px solid var(--vf-border,#e2e8f0);border-radius:8px;padding:8px 10px;margin-bottom:6px;display:flex;gap:10px;align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div style="font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word">${esc(n.text)}</div>
      <div style="margin-top:3px">${metaLine}</div>
    </div>
    <div style="display:flex;gap:4px;flex:0 0 auto">
      <button class="btn btn-secondary btn-sm" title="Изменить" onclick="editMemoryNote('${esc(n.id)}')"><i class="fas fa-pen"></i></button>
      <button class="btn btn-danger btn-sm" title="Удалить" onclick="deleteMemoryNote('${esc(n.id)}')"><i class="fas fa-trash"></i></button>
    </div>
  </div>`;
}

function editMemoryNote(id){ memoryEditingId = id; renderMemoryModal(); }
function cancelEditMemoryNote(){ memoryEditingId = null; renderMemoryModal(); }

async function memoryRequest(url, options, okMsg){
  try{
    const r = await apiFetch(withAgentId(API + url), options);
    if(r && r.status === 200){
      agentMemoryState = await r.json();
      renderMemoryBlock();
      renderMemoryModal();
      if(okMsg) showToast(okMsg, 'success');
      return true;
    }
    const err = await r?.json().catch(()=>({}));
    showToast(memoryErrText(err.detail) || 'Ошибка', 'error');
  }catch(e){ showToast('Ошибка сети', 'error'); }
  return false;
}

function memoryErrText(d){
  if(!d) return '';
  const s = typeof d === 'string' ? d : (Array.isArray(d) && d[0]?.msg) || JSON.stringify(d);
  if(s.startsWith('limit_notes')) return 'Достигнут лимит заметок — удалите лишние';
  if(s.startsWith('limit_chars')) return 'Память заполнена — удалите или сократите заметки';
  if(s.startsWith('note_too_long')) return 'Заметка слишком длинная (до 400 символов)';
  if(s === 'duplicate') return 'Такая заметка уже есть';
  if(s === 'not_found') return 'Заметка не найдена — обновите список';
  if(s === 'bad_section') return 'Неверная секция';
  return errText(d) || s;
}

async function addMemoryNote(){
  const sel = document.getElementById('memory-add-section');
  const ta = document.getElementById('memory-add-text');
  const text = (ta.value || '').trim();
  if(!text){ showToast('Введите текст заметки', 'error'); return; }
  const btn = document.getElementById('memory-add-btn');
  btn.disabled = true;
  const ok = await memoryRequest('/memory', {
    method: 'POST',
    body: JSON.stringify({ section: sel.value, text }),
  }, 'Заметка добавлена');
  btn.disabled = false;
  if(ok) ta.value = '';
}

async function saveMemoryNote(id){
  const ta = document.getElementById('memory-edit-' + id);
  const text = (ta?.value || '').trim();
  if(!text){ showToast('Текст не может быть пустым', 'error'); return; }
  const ok = await memoryRequest('/memory/' + encodeURIComponent(id), {
    method: 'PUT',
    body: JSON.stringify({ text }),
  }, 'Заметка обновлена');
  if(ok) memoryEditingId = null, renderMemoryModal();
}

async function deleteMemoryNote(id){
  if(!confirm('Удалить эту заметку из памяти агента?')) return;
  await memoryRequest('/memory/' + encodeURIComponent(id), { method: 'DELETE' }, 'Заметка удалена');
}

async function clearAgentMemory(){
  if(!confirm('Очистить всю память агента? Все заметки во всех секциях будут удалены. Это действие необратимо.')) return;
  const btn = document.getElementById('memory-clear-btn');
  btn.disabled = true;
  await memoryRequest('/memory', { method: 'DELETE' }, 'Память очищена');
  btn.disabled = false;
}
