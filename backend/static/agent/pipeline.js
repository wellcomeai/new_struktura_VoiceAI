/* ============================================================================
 * agent/pipeline.js — Воронка-канбан с drag&drop, ленивая загрузка по стадиям → GET /contacts?status=, PATCH /contacts/{id}/status
 * Часть страницы /static/agent.html (Voicyfy Agent).
 * Классический скрипт (НЕ ES-модуль): функции и состояние — глобальные,
 * доступны между всеми файлами agent/*.js и из inline-onclick в разметке.
 * Подключается из agent.html. Документация: backend/static/agent/CLAUDE.md
 * ========================================================================== */

// ── Канбан воронки ──
async function openPipelineModal(){
  document.getElementById('pipeline-modal-overlay').classList.remove('hidden');
  await loadPipeline();
}
function closePipelineModal(){
  document.getElementById('pipeline-modal-overlay').classList.add('hidden');
}

// Ленивая загрузка: каждая колонка грузится отдельным запросом по стадии
// (первые PIPELINE_PAGE карточек), заголовок показывает реальный total,
// внизу колонки кнопка «Ещё N» подгружает следующую страницу.
const PIPELINE_PAGE = 100;
let plState = {};   // stage -> { offset, total }

async function fetchPipelineStage(stage, offset){
  const qs = new URLSearchParams({ status: stage, limit: PIPELINE_PAGE, offset });
  const r = await apiFetch(API + '/contacts?' + qs);
  if(!r || r.status !== 200) return null;
  return r.json();
}

function plMoreHtml(stage){
  const st = plState[stage];
  if(!st) return '';
  const left = st.total - st.offset;
  if(left <= 0) return '';
  return `<button class="btn btn-secondary btn-sm pl-more" id="pl-more-${stage}" onclick="plLoadMore('${stage}')" style="margin-top:4px">
    <i class="fas fa-angles-down"></i> Ещё ${Math.min(left, PIPELINE_PAGE)}</button>`;
}

async function loadPipeline(){
  const wrap = document.getElementById('pipeline-board');
  wrap.innerHTML = '<div class="empty">Загрузка...</div>';
  plState = {};
  try{
    const results = await Promise.all(STAGE_ORDER.map(s => fetchPipelineStage(s, 0)));
    if(results.some(r => !r)){ wrap.innerHTML = '<div class="empty">Ошибка</div>'; return; }
    wrap.innerHTML = STAGE_ORDER.map((s, i) => {
      const m = STAGE_META[s];
      const data = results[i];
      const list = data.contacts || [];
      plState[s] = { offset: list.length, total: data.total || 0 };
      const cards = list.length ? list.map(pipelineCard).join('') : '<div class="pl-empty">Пусто</div>';
      return `
        <div class="pl-col" data-stage="${s}" ondragover="plDragOver(event)" ondragleave="plDragLeave(event)" ondrop="plDrop(event)">
          <div class="pl-col-head" style="border-top:3px solid ${m.color}">
            <span style="font-weight:600">${m.label}</span>
            <span class="pl-count" id="pl-count-${s}">${plState[s].total}</span>
          </div>
          <div class="pl-col-body">
            <div id="pl-cards-${s}" style="display:flex;flex-direction:column;gap:8px">${cards}</div>
            <div id="pl-more-wrap-${s}">${plMoreHtml(s)}</div>
          </div>
        </div>`;
    }).join('');
  }catch(e){ wrap.innerHTML = '<div class="empty">Ошибка сети</div>'; }
}

async function plLoadMore(stage){
  const st = plState[stage];
  if(!st) return;
  const btn = document.getElementById('pl-more-' + stage);
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
  try{
    const data = await fetchPipelineStage(stage, st.offset);
    if(!data){ showToast('Не удалось загрузить контакты','error'); return; }
    const list = data.contacts || [];
    const holder = document.getElementById('pl-cards-' + stage);
    if(holder) holder.insertAdjacentHTML('beforeend', list.map(pipelineCard).join(''));
    st.total = data.total || st.total;
    st.offset += list.length;
    if(!list.length) st.offset = st.total; // защита от зацикливания
    const cnt = document.getElementById('pl-count-' + stage);
    if(cnt) cnt.textContent = st.total;
  }catch(e){ showToast('Ошибка сети','error'); }
  finally{
    const wrapMore = document.getElementById('pl-more-wrap-' + stage);
    if(wrapMore) wrapMore.innerHTML = plMoreHtml(stage);
  }
}

let plDragId = null;
function plDragStart(e){
  plDragId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function plDragEnd(e){ e.currentTarget.classList.remove('dragging'); }
function plDragOver(e){ e.preventDefault(); e.currentTarget.classList.add('pl-over'); }
function plDragLeave(e){ e.currentTarget.classList.remove('pl-over'); }
async function plDrop(e){
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove('pl-over');
  const stage = col.dataset.stage;
  const id = plDragId; plDragId = null;
  if(!id) return;
  const ok = await changeContactStage(id, stage);
  if(ok) loadPipeline();
}


