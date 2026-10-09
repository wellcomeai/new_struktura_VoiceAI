/*
 * Примеры голосов: кнопка ▶ рядом с голосом проигрывает фразу «Это мой пример
 * голоса, которым я буду говорить на платформе Voicyfy».
 *
 * Файлы сгенерированы scripts/voice_samples.py и лежат в R2:
 * voice-samples/<провайдер>/<голос в нижнем регистре>.wav (у Fish — по имени).
 * Новый голос без файла просто не играет (кнопка гаснет с подсказкой).
 *
 * Использование: VoiceSamples.button('openai', 'marin') → HTML кнопки (или ''
 * если примера нет). Клики обрабатываются делегированием на document в фазе
 * захвата, поэтому кнопка внутри плитки голоса не выбирает сам голос.
 */
(function () {
  'use strict';

  const BASE = 'https://pub-da39fb994f3d43fcb81db15f5821fe1d.r2.dev/voice-samples';
  const PROVIDERS = ['openai', 'gemini', 'fish'];
  // Готовые голоса Fish (FISH_VOICES в backend/models/fish_assistant.py) → имя файла
  const FISH_FILES = {
    '1ac3ce2f7ba24e90ac2a08055c253fe7': 'svetlana',
    '5ddd9a81cc554841a53b75e355d52628': 'sergey',
  };

  const ICON_PLAY = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

  let audio = null;      // один плеер на страницу
  let currentKey = null; // "провайдер:голос", который играет или грузится

  function url(provider, voice) {
    if (!voice || PROVIDERS.indexOf(provider) < 0) return null;
    const file = provider === 'fish' ? FISH_FILES[voice] : String(voice).toLowerCase();
    return file ? `${BASE}/${provider}/${encodeURIComponent(file)}.wav` : null;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function button(provider, voice, opts) {
    if (!url(provider, voice)) return '';
    const label = (opts && opts.label) || '';
    const key = provider + ':' + voice;
    const state = key === currentKey ? (audio && !audio.paused ? ' is-playing' : ' is-loading') : '';
    return `<button type="button" class="vs-play${label ? ' vs-play-label' : ''}${state}" data-vs-provider="${esc(provider)}" data-vs-voice="${esc(voice)}" title="Послушать пример" aria-label="Послушать пример голоса ${esc(voice)}"><span class="vs-ico">${state === ' is-playing' ? ICON_PAUSE : ICON_PLAY}</span>${label ? `<span>${esc(label)}</span>` : ''}</button>`;
  }

  // Кнопки перерисовываются вместе с плитками, поэтому состояние держим по ключу
  // и обновляем все кнопки этого голоса, какие сейчас есть в DOM.
  function paint() {
    document.querySelectorAll('.vs-play').forEach(btn => {
      const key = btn.dataset.vsProvider + ':' + btn.dataset.vsVoice;
      const active = key === currentKey;
      const playing = active && audio && !audio.paused;
      btn.classList.toggle('is-playing', playing);
      btn.classList.toggle('is-loading', active && !playing);
      btn.querySelector('.vs-ico').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    });
  }

  function stop() {
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    currentKey = null;
    paint();
  }

  function toggle(btn) {
    const provider = btn.dataset.vsProvider, voice = btn.dataset.vsVoice;
    const key = provider + ':' + voice;
    if (key === currentKey) { stop(); return; }
    const src = url(provider, voice);
    if (!src) return;
    if (!audio) {
      audio = new Audio();
      audio.preload = 'auto';
      audio.addEventListener('playing', paint);
      audio.addEventListener('ended', stop);
      audio.addEventListener('error', () => {
        if (!currentKey) return;   // ошибка от сброса src в stop()
        const [p, v] = currentKey.split(':');
        document.querySelectorAll(`.vs-play[data-vs-provider="${p}"][data-vs-voice="${CSS.escape(v)}"]`).forEach(b => {
          b.disabled = true; b.title = 'Пример этого голоса пока недоступен';
        });
        stop();
      });
    }
    currentKey = key;
    audio.src = src;
    paint();
    audio.play().catch(() => { if (currentKey === key) stop(); });
  }

  function onActivate(e) {
    const btn = e.target.closest && e.target.closest('.vs-play');
    if (!btn) return;
    if (e.type === 'keydown') {
      // Enter/пробел на кнопке не должны всплыть до плитки и выбрать голос;
      // нажатие кнопки браузер всё равно превратит в click.
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!btn.disabled) toggle(btn);
  }

  // Фаза захвата: успеваем остановить событие до обработчика плитки голоса
  document.addEventListener('click', onActivate, true);
  document.addEventListener('keydown', onActivate, true);

  const style = document.createElement('style');
  style.textContent = `
    .vs-play { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      width: 24px; height: 24px; padding: 0; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--vf-border, #d4d4d8); background: var(--vf-surface, #fff);
      color: var(--vf-text-2, #52525b); transition: color .15s, border-color .15s, background .15s; }
    .vs-play:hover { color: var(--vf-accent, #2563eb); border-color: var(--vf-accent, #2563eb); }
    .vs-play:focus-visible { outline: 2px solid var(--vf-accent, #2563eb); outline-offset: 1px; }
    .vs-play.is-playing, .vs-play.is-loading { color: #fff; background: var(--vf-accent, #2563eb); border-color: var(--vf-accent, #2563eb); }
    .vs-play.is-loading .vs-ico { animation: vs-pulse 1s ease-in-out infinite; }
    .vs-play:disabled { opacity: .4; cursor: not-allowed; }
    .vs-play .vs-ico { display: inline-flex; }
    .vs-play.vs-play-label { width: auto; height: 28px; padding: 0 12px 0 10px; font-size: 12.5px; font-weight: 500; }
    @keyframes vs-pulse { 50% { opacity: .35; } }
  `;
  document.head.appendChild(style);

  window.VoiceSamples = { url, button, stop };
})();
