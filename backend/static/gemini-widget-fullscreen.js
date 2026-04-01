/**
 * 🚀 Gemini Fullscreen Voice Widget v2.0.0 - PRODUCTION
 *
 * CHANGELOG v2.0.0 (fixes over v1.0.0):
 *   - FIX: same URL → onload не срабатывал (сброс src + requestAnimationFrame)
 *   - FIX: z-index порядок — overlay теперь выше всего (2147483647)
 *   - FIX: STATE.mode не обновлялся при handleMinimize()
 *   - NEW: btn + panel уходят off-screen при открытии картинки (position-aware translate)
 *   - NEW: современный frosted-glass pill с [Свернуть | ✕] в image-режиме
 *   - NEW: кнопка «Закрыть» прямо из fullscreen overlay
 *   - NEW: градиентные scrim-overlay сверху и снизу картинки
 *   - NEW: анимация entrance для img-controls с transition-delay
 *
 * Supports:
 *   data-model="2.5"  → /ws/gemini/{id}       (gemini-2.5-flash-native-audio)
 *   data-model="3.1"  → /ws/gemini-31/{id}    (gemini-3.1-flash-live-preview)
 *
 * UI States:
 *   BUTTON  — small pulsing button in corner
 *   DIALOG  — expanded 320×460 panel with sphere
 *   IMAGE   — fullscreen overlay (on show_image function call)
 *             minimize button → back to DIALOG (audio continues)
 *             close (✕)      → back to BUTTON  (disconnect)
 *
 * @version 2.0.0
 * @author WellcomeAI Team
 */

(function () {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================

    const CONFIG = {
        assistantId: null,
        serverUrl: null,
        model: '2.5',
        position: 'bottom-right',

        audio: {
            inputSampleRate: 16000,
            outputSampleRate: 24000,
            playbackSampleRate: 24000,
            actualSampleRate: null,
            needsResampling: false
        },

        vad: {
            enabled: true,
            speechThreshold: -38,
            visualSilenceThreshold: -45
        },

        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        },

        setup: {
            waitAfterSetup: 800,
            maxSetupWait: 10000
        }
    };

    // ============================================================================
    // STATE
    // ============================================================================

    const STATE = {
        ws: null,
        isConnected: false,
        isSetupComplete: false,
        readyToRecord: false,
        isRecording: false,
        isPlaying: false,
        isSpeaking: false,

        audioContext: null,
        mediaStream: null,
        audioWorkletNode: null,
        audioStreamNode: null,
        pingInterval: null,
        reconnectAttempts: 0,
        setupTimeout: null,

        audioWorkletReady: false,
        streamWorkletReady: false,

        isIOS: false,
        isAndroid: false,
        isMobile: false,

        lastInterruptionTime: 0,
        lastSpeechNotifyTime: 0,

        mode: 'button', // 'button' | 'dialog' | 'image'
        currentImageUrl: null,

        ui: {}
    };

    // ============================================================================
    // AUDIOWORKLET — RECORDER
    // ============================================================================

    const RECORDER_WORKLET_CODE = `
class RecorderWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 512;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
        this.inputRate = sampleRate;
        this.targetRate = 16000;
        this.resampleRatio = this.inputRate / this.targetRate;
    }

    downsample(inputData) {
        if (this.resampleRatio === 1) return inputData;
        const outputLength = Math.floor(inputData.length / this.resampleRatio);
        const output = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * this.resampleRatio;
            const srcFloor = Math.floor(srcIndex);
            const srcCeil  = Math.min(srcFloor + 1, inputData.length - 1);
            const t = srcIndex - srcFloor;
            output[i] = inputData[srcFloor] * (1 - t) + inputData[srcCeil] * t;
        }
        return output;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const downsampled = this.downsample(input[0]);
        for (let i = 0; i < downsampled.length; i++) {
            this.buffer[this.bufferIndex++] = downsampled[i];
            if (this.bufferIndex >= this.bufferSize) {
                this.port.postMessage({ type: 'audioData', data: this.buffer.slice(0, this.bufferIndex) });
                this.bufferIndex = 0;
            }
        }
        return true;
    }
}
registerProcessor('recorder-worklet', RecorderWorkletProcessor);
`;

    // ============================================================================
    // AUDIOWORKLET — STREAM PLAYER
    // ============================================================================

    const STREAM_WORKLET_CODE = `
class AudioStreamProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.audioQueue = [];
        this.currentBuffer = null;
        this.bufferIndex = 0;
        this.samplesProcessed = 0;
        this.isActive = false;

        this.port.onmessage = (e) => {
            if (e.data.type === 'audioData') {
                this.audioQueue.push(e.data.buffer);
                if (!this.isActive) {
                    this.isActive = true;
                    this.port.postMessage({ type: 'started' });
                }
            } else if (e.data.type === 'clear') {
                this.audioQueue = [];
                this.currentBuffer = null;
                this.bufferIndex = 0;
                this.isActive = false;
                this.port.postMessage({ type: 'cleared' });
            } else if (e.data.type === 'stop') {
                this.isActive = false;
                this.port.postMessage({ type: 'stopped' });
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output[0]) return true;
        const out = output[0];
        for (let i = 0; i < out.length; i++) {
            if (!this.currentBuffer || this.bufferIndex >= this.currentBuffer.length) {
                if (this.audioQueue.length > 0) {
                    this.currentBuffer = this.audioQueue.shift();
                    this.bufferIndex = 0;
                } else { out[i] = 0; continue; }
            }
            out[i] = this.currentBuffer[this.bufferIndex++];
            this.samplesProcessed++;
        }
        if (this.samplesProcessed % 4800 === 0) {
            this.port.postMessage({ type: 'stats', queueLength: this.audioQueue.length, samplesProcessed: this.samplesProcessed });
        }
        return true;
    }
}
registerProcessor('audio-stream-processor', AudioStreamProcessor);
`;

    // ============================================================================
    // INIT
    // ============================================================================

    function init() {
        console.log('[FSW] 🚀 Gemini Fullscreen Widget v2.0.0');

        const ua = navigator.userAgent.toLowerCase();
        STATE.isIOS     = /iphone|ipad|ipod/.test(ua);
        STATE.isAndroid = /android/.test(ua);
        STATE.isMobile  = STATE.isIOS || STATE.isAndroid;

        if (STATE.isIOS) console.log('[FSW] iOS device detected');

        const tag = findScriptTag();
        if (!tag) return console.error('[FSW] script tag not found');

        CONFIG.assistantId = tag.getAttribute('data-assistantId') || tag.dataset.assistantid;
        CONFIG.serverUrl   = tag.getAttribute('data-server')      || tag.dataset.server;
        CONFIG.model       = tag.getAttribute('data-model')       || tag.dataset.model || '2.5';
        const pos          = tag.getAttribute('data-position')    || tag.dataset.position;
        if (pos) CONFIG.position = pos;

        if (!CONFIG.assistantId || !CONFIG.serverUrl) {
            return console.error('[FSW] missing assistantId or server');
        }

        if (!document.getElementById('fsw-fa-css')) {
            const l = document.createElement('link');
            l.id = 'fsw-fa-css'; l.rel = 'stylesheet';
            l.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(l);
        }

        injectStyles();
        buildDOM();
        cacheUI();
        bindEvents();

        document.addEventListener('click',      resumeAudioCtx, { once: true });
        document.addEventListener('touchstart', resumeAudioCtx, { once: true });

        console.log(`[FSW] ✅ Init OK | model:${CONFIG.model} | pos:${CONFIG.position}`);
    }

    function findScriptTag() {
        const bySrc = document.querySelector('script[src*="gemini-widget-fullscreen.js"][data-assistantId]')
                   || document.querySelector('script[src*="gemini-widget-fullscreen.js"]');
        if (bySrc) return bySrc;
        const all = document.querySelectorAll('script[data-assistantId]');
        return all.length ? all[all.length - 1] : document.currentScript;
    }

    // ============================================================================
    // STYLES
    // ============================================================================

    function getPosCSS() {
        const parts = CONFIG.position.toLowerCase().split('-');
        const v = parts.includes('top')  ? 'top'   : 'bottom';
        const h = parts.includes('left') ? 'left'  : 'right';
        return { v, h };
    }

    function injectStyles() {
        const old = document.getElementById('fsw-styles');
        if (old) old.remove();

        const { v, h } = getPosCSS();
        const isTop = v === 'top';

        // position-aware translate for image-mode slide-off
        // btn/panel slide toward their own corner (out of view)
        const tx = h === 'right' ? '90px' : '-90px';
        const ty = v === 'bottom' ? '90px' : '-90px';

        const s = document.createElement('style');
        s.id = 'fsw-styles';
        s.textContent = `

/* ── TRIGGER BUTTON ── */
#fsw-btn {
    position: fixed; ${v}: 20px; ${h}: 20px;
    z-index: 2147483646;
    width: 60px; height: 60px; border-radius: 50%;
    background: linear-gradient(135deg, #4a86e8, #2b59c3);
    box-shadow: 0 8px 32px rgba(74,134,232,.3), 0 0 0 1px rgba(255,255,255,.1);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; border: none; outline: none;
    transition: transform .45s cubic-bezier(.4,0,.2,1),
                opacity   .45s cubic-bezier(.4,0,.2,1),
                box-shadow .3s ease;
    overflow: hidden;
}
#fsw-btn:hover { box-shadow: 0 10px 30px rgba(74,134,232,.4), 0 0 0 1px rgba(255,255,255,.15); }
#fsw-btn.dialog-open { transform: scale(0.9); box-shadow: 0 4px 15px rgba(0,0,0,.2); }
@keyframes fsw-btn-pulse { 0%{box-shadow:0 0 0 0 rgba(74,134,232,.7)} 70%{box-shadow:0 0 0 10px rgba(74,134,232,0)} 100%{box-shadow:0 0 0 0 rgba(74,134,232,0)} }
#fsw-btn.pulse { animation: fsw-btn-pulse 2s infinite; }

/* IMAGE MODE — slide btn off-screen toward its corner */
#fsw-btn.fsw-image-mode {
    transform: translate(${tx}, ${ty}) scale(0.6) !important;
    opacity: 0 !important;
    pointer-events: none !important;
    animation: none !important;
}

.fsw-btn-inner { position: relative; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; }
.fsw-pulse-ring { position: absolute; width: 100%; height: 100%; border-radius: 50%; animation: fsw-pulse-ring 3s ease-out infinite; background: radial-gradient(rgba(255,255,255,.8) 0%, rgba(255,255,255,0) 70%); opacity: 0; }
@keyframes fsw-pulse-ring { 0%{transform:scale(.5);opacity:0} 25%{opacity:.4} 100%{transform:scale(1.2);opacity:0} }

.fsw-bars-mini { display: flex; align-items: center; height: 26px; gap: 4px; justify-content: center; }
.fsw-bar-mini  { width: 3px; border-radius: 1.5px; background: #fff; opacity: .9; animation: fsw-eq 1.2s ease-in-out infinite; }
.fsw-bar-mini:nth-child(1){height:7px;animation-delay:0s}
.fsw-bar-mini:nth-child(2){height:12px;animation-delay:.3s}
.fsw-bar-mini:nth-child(3){height:18px;animation-delay:.1s}
.fsw-bar-mini:nth-child(4){height:9px;animation-delay:.5s}
@keyframes fsw-eq { 0%,100%{height:5px} 50%{height:18px} }

/* ── DIALOG PANEL ── */
#fsw-panel {
    position: fixed; ${v}: 20px; ${h}: 20px;
    z-index: 2147483645;
    width: 320px; height: 0; opacity: 0; pointer-events: none;
    background: rgba(255,255,255,.95);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-radius: 20px;
    box-shadow: 0 10px 30px rgba(0,0,0,.15), 0 0 0 1px rgba(0,0,0,.05);
    overflow: hidden;
    transition: height  .5s  cubic-bezier(.175,.885,.32,1.275),
                opacity .4s  ease,
                transform .45s cubic-bezier(.4,0,.2,1);
    display: flex; flex-direction: column;
}
#fsw-panel.open { height: 460px; opacity: 1; pointer-events: all; }

/* IMAGE MODE — slide panel off-screen toward its corner */
#fsw-panel.fsw-image-mode {
    transform: translate(${tx}, ${ty}) scale(0.85) !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

/* ── HEADER ── */
#fsw-header {
    padding: 15px 20px;
    background: linear-gradient(135deg, #1e3a8a, #3b82f6);
    color: #fff; display: flex; justify-content: space-between; align-items: center;
    border-radius: 20px 20px 0 0; flex-shrink: 0;
}
#fsw-title { font: 600 16px/1 'Segoe UI',Roboto,sans-serif; letter-spacing: .3px; }
#fsw-close-btn { background:none; border:none; color:#fff; font-size:18px; cursor:pointer; opacity:.8; transition:opacity .2s,transform .2s; padding:0; }
#fsw-close-btn:hover { opacity:1; transform:scale(1.1); }

/* ── BODY ── */
#fsw-body {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background: #f9fafc; position: relative; padding: 20px 20px 10px;
}

/* ── SPHERE ── */
#fsw-sphere {
    width: 180px; height: 180px; border-radius: 50%;
    background: linear-gradient(135deg, #f3f4f6, #e5e7eb);
    box-shadow: 0 10px 25px rgba(0,0,0,.1), inset 0 2px 5px rgba(255,255,255,.5);
    position: relative; overflow: hidden;
    transition: background .3s, box-shadow .3s;
    display: flex; align-items: center; justify-content: center;
}
#fsw-sphere::before {
    content: ''; position: absolute; width: 140%; height: 140%; border-radius: 40%;
    background: linear-gradient(45deg, rgba(255,255,255,.3), rgba(74,134,232,.2));
    animation: fsw-wave 8s linear infinite;
}
@keyframes fsw-wave { to{ transform: rotate(360deg); } }

#fsw-sphere.listening {
    background: linear-gradient(135deg, #dbeafe, #eff6ff);
    box-shadow: 0 0 30px rgba(37,99,235,.5), inset 0 2px 5px rgba(255,255,255,.5);
}
#fsw-sphere.listening::before { animation-duration:4s; background:linear-gradient(45deg,rgba(255,255,255,.5),rgba(37,99,235,.3)); }
#fsw-sphere.listening::after  { content:''; position:absolute; width:100%; height:100%; border-radius:50%; border:3px solid rgba(37,99,235,.5); animation:fsw-ring 1.5s ease-out infinite; }
@keyframes fsw-ring { 0%{transform:scale(.95);opacity:.7} 50%{transform:scale(1.05);opacity:.3} 100%{transform:scale(.95);opacity:.7} }

#fsw-sphere.speaking {
    background: linear-gradient(135deg, #dcfce7, #ecfdf5);
    box-shadow: 0 0 30px rgba(5,150,105,.5), inset 0 2px 5px rgba(255,255,255,.5);
}
#fsw-sphere.speaking::before { animation-duration:3s; background:linear-gradient(45deg,rgba(255,255,255,.5),rgba(5,150,105,.3)); }
#fsw-sphere.speaking::after  { content:''; position:absolute; width:100%; height:100%; border-radius:50%; background:radial-gradient(circle,transparent 50%,rgba(5,150,105,.1) 100%); animation:fsw-ripple 2s ease-out infinite; }
@keyframes fsw-ripple { 0%{transform:scale(.8);opacity:0} 50%{opacity:.5} 100%{transform:scale(1.2);opacity:0} }

#fsw-sphere.interrupted {
    background: linear-gradient(135deg, #fef3c7, #fffbeb);
    box-shadow: 0 0 30px rgba(217,119,6,.5), inset 0 2px 5px rgba(255,255,255,.5);
}

.fsw-mic-icon { color: #3b82f6; font-size: 32px; z-index: 10; transition: color .3s ease; }
#fsw-sphere.listening   .fsw-mic-icon { color: #2563eb; }
#fsw-sphere.speaking    .fsw-mic-icon { color: #059669; }
#fsw-sphere.interrupted .fsw-mic-icon { color: #d97706; }

/* ── WAVE BARS ── */
.fsw-audio-vis  { position: absolute; width: 100%; max-width: 160px; height: 30px; bottom: -5px; opacity: .8; pointer-events: none; }
.fsw-audio-bars { display: flex; align-items: flex-end; height: 30px; gap: 2px; width: 100%; justify-content: center; }
.fsw-wave-bar   { width: 3px; height: 2px; background: #3b82f6; border-radius: 1px; transition: height .1s ease; }

/* ── LOADER ── */
#fsw-loader {
    position: absolute; inset: 0; border-radius: 20px;
    background: rgba(255,255,255,.85); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; visibility: hidden; transition: opacity .3s, visibility .3s;
}
#fsw-loader.show { opacity: 1; visibility: visible; }
.fsw-spinner { width: 40px; height: 40px; border-radius: 50%; border: 3px solid rgba(59,130,246,.2); border-top-color: #3b82f6; animation: fsw-spin 1s linear infinite; }
@keyframes fsw-spin { to{ transform: rotate(360deg); } }

/* ── ERROR ── */
#fsw-error {
    display: none; color: #ef4444; background: rgba(254,226,226,.8);
    border: 1px solid #ef4444; padding: 8px 12px; border-radius: 8px;
    font-size: 13px; font-weight: 500; margin-top: 10px; text-align: center;
    position: relative; z-index: 20;
}
#fsw-error.show { display: block; }
#fsw-retry { background: #ef4444; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; margin-top: 8px; display: block; }

/* ── STATUS ── */
#fsw-status {
    position: absolute; bottom: 50px; left: 50%; transform: translateX(-50%);
    font-size: 11px; color: #475569; padding: 4px 8px; border-radius: 10px;
    background: rgba(255,255,255,.8); display: flex; align-items: center; gap: 5px;
    opacity: 0; transition: opacity .3s; white-space: nowrap;
}
#fsw-status.show { opacity: .8; }
#fsw-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
#fsw-dot.connecting   { background: #f59e0b; }
#fsw-dot.disconnected { background: #ef4444; }
#fsw-dot.interrupted  { background: #d97706; }

/* ═══════════════════════════════════════════════════════
   FULLSCREEN IMAGE OVERLAY — v2.0.0 redesign
   ═══════════════════════════════════════════════════════ */

#fsw-overlay {
    position: fixed; inset: 0;
    z-index: 2147483647;          /* HIGHEST — above panel and button */
    background: #000;
    opacity: 0; pointer-events: none;
    transition: opacity .45s cubic-bezier(.4,0,.2,1);
}
#fsw-overlay.show { opacity: 1; pointer-events: all; }

/* Main image */
#fsw-img {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity .55s cubic-bezier(.4,0,.2,1);
}
#fsw-img.show { opacity: 1; }

/* Top scrim — makes controls always readable */
.fsw-scrim-top {
    position: absolute; top: 0; left: 0; right: 0;
    height: 140px;
    background: linear-gradient(to bottom, rgba(0,0,0,.65) 0%, transparent 100%);
    pointer-events: none;
    z-index: 2;
}

/* Bottom scrim — for description text */
.fsw-scrim-bottom {
    position: absolute; bottom: 0; left: 0; right: 0;
    height: 160px;
    background: linear-gradient(to top, rgba(0,0,0,.75) 0%, transparent 100%);
    pointer-events: none;
    z-index: 2;
}

/* ── FROSTED GLASS PILL CONTROLS ── */
#fsw-img-controls {
    position: absolute;
    top: 20px;
    right: 20px;
    z-index: 10;
    display: flex;
    align-items: center;
    background: rgba(15, 15, 15, 0.52);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 50px;
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.06) inset;
    /* entrance animation */
    opacity: 0;
    transform: translateY(-12px) scale(.96);
    transition: opacity .4s ease, transform .4s ease;
    /* delayed entrance after overlay appears */
    transition-delay: .25s;
}
#fsw-overlay.show #fsw-img-controls {
    opacity: 1;
    transform: translateY(0) scale(1);
}

#fsw-minimize-img {
    display: flex; align-items: center; gap: 7px;
    background: none; border: none; outline: none;
    color: rgba(255,255,255,.9);
    font: 500 13px/1 'Segoe UI', Roboto, sans-serif;
    letter-spacing: .2px;
    padding: 11px 16px 11px 14px;
    cursor: pointer;
    transition: background .2s, color .2s;
    white-space: nowrap;
}
#fsw-minimize-img:hover {
    background: rgba(255,255,255,.1);
    color: #fff;
}
#fsw-minimize-img i { font-size: 12px; opacity: .85; }

.fsw-ctrl-sep {
    width: 1px; height: 22px;
    background: rgba(255,255,255,.18);
    flex-shrink: 0;
}

#fsw-img-close {
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; outline: none;
    color: rgba(255,255,255,.8);
    font-size: 13px;
    padding: 11px 14px;
    cursor: pointer;
    transition: background .2s, color .2s;
}
#fsw-img-close:hover {
    background: rgba(239, 68, 68, .35);
    color: #fff;
}

/* ── IMAGE DESCRIPTION ── */
#fsw-img-desc {
    position: absolute;
    bottom: 32px; left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    font: 500 15px/1.55 'Segoe UI', Roboto, sans-serif;
    color: rgba(255,255,255,.95);
    text-align: center;
    max-width: min(560px, 80vw);
    text-shadow: 0 1px 6px rgba(0,0,0,.5);
    /* entrance animation */
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
    transition: opacity .5s ease, transform .5s ease;
    transition-delay: .4s;
    pointer-events: none;
}
#fsw-img-desc.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
}
        `;
        document.head.appendChild(s);
    }

    // ============================================================================
    // DOM
    // ============================================================================

    function buildDOM() {
        ['fsw-btn','fsw-panel','fsw-overlay'].forEach(id => document.getElementById(id)?.remove());

        document.body.insertAdjacentHTML('beforeend', `
<button id="fsw-btn" class="pulse" aria-label="Голосовой ассистент">
  <div class="fsw-btn-inner">
    <div class="fsw-pulse-ring"></div>
    <div class="fsw-bars-mini">
      <div class="fsw-bar-mini"></div>
      <div class="fsw-bar-mini"></div>
      <div class="fsw-bar-mini"></div>
      <div class="fsw-bar-mini"></div>
    </div>
  </div>
</button>

<div id="fsw-panel">
  <div id="fsw-header">
    <span id="fsw-title">Голосовой Ассистент</span>
    <button id="fsw-close-btn" aria-label="Закрыть"><i class="fas fa-times"></i></button>
  </div>
  <div id="fsw-body">
    <div id="fsw-sphere">
      <i class="fas fa-microphone fsw-mic-icon"></i>
      <div class="fsw-audio-vis">
        <div class="fsw-audio-bars" id="fsw-audio-bars"></div>
      </div>
    </div>
    <div id="fsw-error">Ошибка соединения<br><button id="fsw-retry">Повторить</button></div>
    <div id="fsw-status"><div id="fsw-dot"></div><span id="fsw-status-text">Подключение...</span></div>
    <div id="fsw-loader" class="show"><div class="fsw-spinner"></div></div>
  </div>
</div>

<div id="fsw-overlay">
  <img id="fsw-img" src="" alt="">
  <div class="fsw-scrim-top"></div>
  <div class="fsw-scrim-bottom"></div>

  <!-- Frosted-glass pill: Свернуть | ✕ -->
  <div id="fsw-img-controls">
    <button id="fsw-minimize-img" aria-label="Свернуть">
      <i class="fas fa-compress-alt"></i>
      Свернуть
    </button>
    <div class="fsw-ctrl-sep"></div>
    <button id="fsw-img-close" aria-label="Завершить">
      <i class="fas fa-times"></i>
    </button>
  </div>

  <div id="fsw-img-desc"></div>
</div>`);

        const barsEl = document.getElementById('fsw-audio-bars');
        for (let i = 0; i < 20; i++) {
            const b = document.createElement('div');
            b.className = 'fsw-wave-bar';
            barsEl.appendChild(b);
        }
    }

    function cacheUI() {
        STATE.ui = {
            btn:        document.getElementById('fsw-btn'),
            panel:      document.getElementById('fsw-panel'),
            sphere:     document.getElementById('fsw-sphere'),
            waveBars:   document.querySelectorAll('.fsw-wave-bar'),
            loader:     document.getElementById('fsw-loader'),
            dot:        document.getElementById('fsw-dot'),
            statusEl:   document.getElementById('fsw-status'),
            statusTxt:  document.getElementById('fsw-status-text'),
            errorEl:    document.getElementById('fsw-error'),
            retryBtn:   document.getElementById('fsw-retry'),
            closeBtn:   document.getElementById('fsw-close-btn'),
            overlay:    document.getElementById('fsw-overlay'),
            img:        document.getElementById('fsw-img'),
            minimize:   document.getElementById('fsw-minimize-img'),  // updated id
            imgClose:   document.getElementById('fsw-img-close'),     // NEW
            imgDesc:    document.getElementById('fsw-img-desc'),
        };
    }

    function bindEvents() {
        STATE.ui.btn.addEventListener('click', handleOpen);
        STATE.ui.closeBtn.addEventListener('click', handleClose);
        STATE.ui.retryBtn.addEventListener('click', connectWebSocket);
        STATE.ui.minimize.addEventListener('click', handleMinimize);
        STATE.ui.imgClose.addEventListener('click', handleClose);  // NEW: close from image mode
    }

    // ============================================================================
    // MODE TRANSITIONS
    // ============================================================================

    async function handleOpen() {
        if (STATE.mode !== 'button') return;
        toMode('dialog');
        if (!STATE.audioContext) await initAudioContext();
        if (!STATE.isConnected && !STATE.ws) connectWebSocket();
        else if (STATE.isConnected && STATE.readyToRecord && !STATE.isRecording) startRecording();
    }

    function handleClose() {
        // Works from both dialog and image modes
        if (STATE.mode === 'image') hideImageOverlay();
        toMode('button');
        if (STATE.isRecording) stopRecording();
        stopPlayback();
        if (STATE.ws) { try { STATE.ws.close(); } catch {} STATE.ws = null; }
        STATE.isConnected     = false;
        STATE.isSetupComplete = false;
        STATE.readyToRecord   = false;
        if (STATE.pingInterval) { clearInterval(STATE.pingInterval); STATE.pingInterval = null; }
        if (STATE.setupTimeout) { clearTimeout(STATE.setupTimeout);  STATE.setupTimeout = null; }
        STATE.reconnectAttempts = 0;
    }

    function handleMinimize() {
        // image → dialog — audio keeps running
        STATE.mode = 'dialog'; // set BEFORE hideImageOverlay so toMode won't conflict
        hideImageOverlay();
        // Panel already has .open (it was open before image), btn already .dialog-open
        // fsw-image-mode removal in hideImageOverlay slides them back in
    }

    function toMode(mode) {
        STATE.mode = mode;
        const ui = STATE.ui;
        if (mode === 'button') {
            ui.panel.classList.remove('open');
            ui.btn.classList.remove('dialog-open');
            ui.btn.classList.add('pulse');
        } else if (mode === 'dialog') {
            ui.panel.classList.add('open');
            ui.btn.classList.add('dialog-open');
            ui.btn.classList.remove('pulse');
        }
    }

    // ============================================================================
    // IMAGE OVERLAY  (v2.0.0 — fixes same-URL + slide-off)
    // ============================================================================

    function showImageOverlay(url, description) {
        const ui = STATE.ui;
        STATE.mode = 'image';

        // ── Slide btn + panel off-screen toward their corner ──
        ui.btn.classList.add('fsw-image-mode');
        ui.panel.classList.add('fsw-image-mode');

        // Reset description immediately (before new image loads)
        ui.imgDesc.classList.remove('show');
        ui.imgDesc.textContent = '';

        // Show overlay backdrop first
        ui.overlay.classList.add('show');

        // ── FIX: same-URL onload never fires when src hasn't changed ──
        // Reset src → force browser to treat next assignment as new load
        ui.img.classList.remove('show');
        ui.img.onload  = null;
        ui.img.onerror = null;
        ui.img.src = '';

        // Use rAF to ensure src='' has flushed before reassignment
        requestAnimationFrame(() => {
            STATE.currentImageUrl = url;

            ui.img.onload = () => {
                ui.img.classList.add('show');
                if (description?.trim()) {
                    ui.imgDesc.textContent = description;
                    ui.imgDesc.classList.add('show');
                }
            };

            ui.img.onerror = () => {
                console.warn('[FSW] Image failed to load:', url);
                hideImageOverlay();
                if (STATE.mode !== 'button') toMode('dialog');
            };

            ui.img.src = url;
        });
    }

    function hideImageOverlay() {
        const ui = STATE.ui;

        // Remove image mode from btn + panel — they slide back in
        ui.btn.classList.remove('fsw-image-mode');
        ui.panel.classList.remove('fsw-image-mode');

        // Start fade-out sequence
        ui.img.classList.remove('show');
        ui.imgDesc.classList.remove('show');

        setTimeout(() => {
            ui.overlay.classList.remove('show');
            // Clear after overlay fully fades so no flicker
            ui.img.onload  = null;
            ui.img.onerror = null;
            ui.img.src = '';
            ui.imgDesc.textContent = '';
        }, 450); // matches overlay transition duration

        STATE.currentImageUrl = null;
    }

    // ============================================================================
    // UI STATE UPDATES
    // ============================================================================

    function updateUIState(state, message) {
        const ui = STATE.ui;
        if (!ui.sphere) return;

        ui.sphere.classList.remove('listening', 'speaking', 'interrupted');
        ui.dot.classList.remove('connecting', 'disconnected', 'interrupted');

        if (message) {
            ui.statusTxt.textContent = message;
            ui.statusEl.classList.add('show');
            setTimeout(() => ui.statusEl.classList.remove('show'), 3000);
        }

        switch (state) {
            case 'connecting':
                ui.dot.classList.add('connecting');
                ui.loader.classList.add('show');
                break;
            case 'connected':
                ui.loader.classList.remove('show');
                ui.errorEl.classList.remove('show');
                break;
            case 'recording':
                ui.sphere.classList.add('listening');
                break;
            case 'playing':
                ui.sphere.classList.add('speaking');
                break;
            case 'interrupted':
                ui.sphere.classList.add('interrupted');
                ui.dot.classList.add('interrupted');
                break;
            case 'error':
                ui.dot.classList.add('disconnected');
                ui.errorEl.classList.add('show');
                ui.loader.classList.remove('show');
                break;
            case 'disconnected':
                ui.dot.classList.add('disconnected');
                break;
        }
    }

    function updateAudioVisualization(audioData) {
        if (!STATE.ui.waveBars?.length) return;
        const bars = STATE.ui.waveBars;
        const step = Math.floor(audioData.length / bars.length);
        for (let i = 0; i < bars.length; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) {
                const idx = i * step + j;
                if (idx < audioData.length) sum += Math.abs(audioData[idx]);
            }
            bars[i].style.height = (2 + Math.min(28, Math.floor((sum / step) * 150))) + 'px';
        }
    }

    function resetAudioVisualization() {
        STATE.ui.waveBars?.forEach(b => b.style.height = '2px');
    }

    // ============================================================================
    // AUDIO CONTEXT
    // ============================================================================

    async function initAudioContext() {
        if (STATE.audioContext) {
            if (STATE.audioContext.state === 'suspended') await STATE.audioContext.resume();
            return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        STATE.audioContext = new Ctx({
            sampleRate: CONFIG.audio.playbackSampleRate,
            latencyHint: 'interactive'
        });
        CONFIG.audio.actualSampleRate = STATE.audioContext.sampleRate;
        CONFIG.audio.needsResampling  = STATE.audioContext.sampleRate !== CONFIG.audio.outputSampleRate;

        console.log(`[FSW] AudioContext: ${CONFIG.audio.actualSampleRate}Hz | needsResample: ${CONFIG.audio.needsResampling}`);
        await loadAudioWorklets();
    }

    async function resumeAudioCtx() {
        if (STATE.audioContext?.state === 'suspended') await STATE.audioContext.resume();
    }

    async function loadAudioWorklets() {
        const addModule = async (code) => {
            const blob = new Blob([code], { type: 'application/javascript' });
            const url  = URL.createObjectURL(blob);
            await STATE.audioContext.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
        };
        try {
            await addModule(RECORDER_WORKLET_CODE);
            STATE.audioWorkletReady = true;
            await addModule(STREAM_WORKLET_CODE);
            STATE.streamWorkletReady = true;
            console.log('[FSW] ✅ AudioWorklets loaded');
        } catch (e) {
            console.error('[FSW] ❌ AudioWorklet load failed:', e);
        }
    }

    // ============================================================================
    // WEBSOCKET
    // ============================================================================

    function getWSEndpoint() {
        const base = CONFIG.serverUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        return CONFIG.model === '3.1'
            ? `${base}/ws/gemini-31/${CONFIG.assistantId}`
            : `${base}/ws/gemini/${CONFIG.assistantId}`;
    }

    function connectWebSocket() {
        updateUIState('connecting', 'Подключение...');
        try {
            STATE.ws = new WebSocket(getWSEndpoint());
            STATE.ws.binaryType = 'arraybuffer';

            STATE.ws.onopen = () => {
                console.log('[FSW] ✅ WS connected');
                STATE.isConnected = true;
                STATE.reconnectAttempts = 0;
                updateUIState('connected', 'Соединение установлено');

                STATE.pingInterval = setInterval(() => {
                    if (STATE.ws?.readyState === WebSocket.OPEN) {
                        STATE.ws.send(JSON.stringify({ type: 'ping' }));
                    }
                }, CONFIG.ws.pingInterval);

                // Fallback if setup.complete never arrives
                STATE.setupTimeout = setTimeout(() => {
                    if (!STATE.isSetupComplete) {
                        STATE.isSetupComplete = true;
                        STATE.readyToRecord = true;
                        if (STATE.mode !== 'button') startRecording();
                    }
                }, CONFIG.setup.maxSetupWait);
            };

            STATE.ws.onmessage = handleWSMessage;

            STATE.ws.onerror = (err) => {
                console.error('[FSW] WS error:', err);
                updateUIState('error', 'Ошибка сервера');
            };

            STATE.ws.onclose = (ev) => {
                console.log('[FSW] WS closed:', ev.code);
                STATE.isConnected = false;
                STATE.readyToRecord = false;
                stopPlayback();
                if (STATE.isRecording) stopRecording();
                if (STATE.pingInterval) { clearInterval(STATE.pingInterval); STATE.pingInterval = null; }
                updateUIState('disconnected', 'Отключено');

                if (STATE.mode !== 'button' && STATE.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
                    STATE.reconnectAttempts++;
                    console.log(`[FSW] Reconnect attempt ${STATE.reconnectAttempts}...`);
                    setTimeout(connectWebSocket, CONFIG.ws.reconnectDelay);
                }
            };

        } catch (e) {
            console.error('[FSW] WS init error:', e);
            updateUIState('error', 'Ошибка сети');
        }
    }

    // ============================================================================
    // MESSAGE HANDLER
    // ============================================================================

    function handleWSMessage(event) {
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        switch (data.type) {

            case 'gemini.setup.complete':
                STATE.isSetupComplete = true;
                clearTimeout(STATE.setupTimeout);
                updateUIState('connected', 'Настройка завершена');
                setTimeout(() => {
                    STATE.readyToRecord = true;
                    if (STATE.mode !== 'button') startRecording();
                }, CONFIG.setup.waitAfterSetup);
                break;

            case 'response.audio.delta':
                handleAudioDelta(data);
                break;

            case 'assistant.speech.started':
                STATE.isSpeaking = true;
                updateUIState('playing', 'Ассистент говорит');
                if (!STATE.isPlaying) startAudioStream();
                break;

            case 'assistant.speech.ended':
                STATE.isSpeaking = false;
                stopPlayback();
                if (STATE.isRecording) updateUIState('recording', 'Слушаю...');
                if (STATE.ws?.readyState === WebSocket.OPEN) {
                    STATE.ws.send(JSON.stringify({ type: 'audio_playback.stopped' }));
                }
                break;

            case 'conversation.interrupted':
                STATE.isSpeaking = false;
                stopPlayback();
                updateUIState('interrupted', 'Прервано');
                setTimeout(() => {
                    if (STATE.isRecording) updateUIState('recording', 'Слушаю...');
                }, 800);
                break;

            // ── SHOW IMAGE ──
            case 'function_call.completed':
                if (data.function === 'show_image' && data.result?.url) {
                    // Ensure dialog is open before going to image mode
                    if (STATE.mode === 'button') toMode('dialog');
                    showImageOverlay(data.result.url, data.result.description || '');
                }
                break;

            case 'pong':
                break;

            case 'connection_status':
                console.log('[FSW] Server status:', data.message);
                break;

            case 'error':
                console.error('[FSW] Server error:', data.error);
                updateUIState('error', data.error?.message || 'Ошибка');
                break;
        }
    }

    // ============================================================================
    // RECORDING
    // ============================================================================

    async function startRecording() {
        if (STATE.isRecording) return;
        console.log('[FSW] 🎙️ Starting recording...');

        if (STATE.audioContext?.state === 'suspended') {
            await STATE.audioContext.resume();
        }

        if (!STATE.audioWorkletReady) await initAudioContext();

        try {
            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            const source      = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
            const workletNode = new AudioWorkletNode(STATE.audioContext, 'recorder-worklet');

            workletNode.port.onmessage = (event) => {
                if (!STATE.isRecording) return;

                const audioData = event.data.data;
                const pcmData   = float32ToPCM16(audioData);

                updateAudioVisualization(audioData);

                const rms = calculateRMS(audioData);
                const db  = 20 * Math.log10(rms + 1e-10);

                if (db > CONFIG.vad.speechThreshold) {
                    if (!STATE.isSpeaking) {
                        STATE.ui.sphere.classList.add('listening');
                    }
                    const now = Date.now();
                    if (STATE.ws?.readyState === WebSocket.OPEN && now - STATE.lastSpeechNotifyTime > 500) {
                        STATE.lastSpeechNotifyTime = now;
                        STATE.ws.send(JSON.stringify({ type: 'speech.user_started' }));
                    }
                }

                if (STATE.ws?.readyState === WebSocket.OPEN) {
                    STATE.ws.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: arrayBufferToBase64(pcmData.buffer)
                    }));
                }
            };

            source.connect(workletNode);
            // NOTE: do NOT connect workletNode to destination — would echo mic
            STATE.audioWorkletNode = { source, workletNode };
            STATE.isRecording = true;

            updateUIState('recording', 'Слушаю...');
            console.log('[FSW] ✅ Recording started');

        } catch (err) {
            console.error('[FSW] Mic error:', err);
            updateUIState('error', 'Нет доступа к микрофону');
        }
    }

    function stopRecording() {
        if (!STATE.isRecording) return;
        STATE.isRecording = false;

        if (STATE.ws?.readyState === WebSocket.OPEN) {
            STATE.ws.send(JSON.stringify({ type: 'speech.user_stopped' }));
        }

        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(t => t.stop());
            STATE.mediaStream = null;
        }

        if (STATE.audioWorkletNode) {
            try {
                STATE.audioWorkletNode.source.disconnect();
                STATE.audioWorkletNode.workletNode?.disconnect();
            } catch {}
            STATE.audioWorkletNode = null;
        }

        resetAudioVisualization();
        console.log('[FSW] 🛑 Recording stopped');
    }

    // ============================================================================
    // PLAYBACK
    // ============================================================================

    function handleAudioDelta(data) {
        if (!data.delta) return;
        try {
            const binaryString = atob(data.delta);
            const bytes  = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

            const pcm16   = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;

            let audioData = float32;
            if (CONFIG.audio.needsResampling) {
                audioData = resampleAudio(float32, CONFIG.audio.outputSampleRate, CONFIG.audio.actualSampleRate);
            }

            STATE.audioStreamNode?.port.postMessage({ type: 'audioData', buffer: audioData });
            if (!STATE.isPlaying) startAudioStream();

        } catch (e) {
            console.error('[FSW] Audio delta error:', e);
        }
    }

    function startAudioStream() {
        if (STATE.isPlaying || !STATE.streamWorkletReady) return;
        try {
            if (!STATE.audioStreamNode) {
                STATE.audioStreamNode = new AudioWorkletNode(STATE.audioContext, 'audio-stream-processor');
                STATE.audioStreamNode.connect(STATE.audioContext.destination);
            }
            STATE.isPlaying = true;
        } catch (e) {
            console.error('[FSW] Stream start error:', e);
        }
    }

    function stopPlayback() {
        if (!STATE.isPlaying) return;
        STATE.audioStreamNode?.port.postMessage({ type: 'clear' });
        STATE.isPlaying = false;
        resetAudioVisualization();
    }

    // ============================================================================
    // UTILS
    // ============================================================================

    function resampleAudio(inputBuffer, inputRate, outputRate) {
        if (inputRate === outputRate) return inputBuffer;
        const ratio = inputRate / outputRate;
        const out   = new Float32Array(Math.round(inputBuffer.length / ratio));
        for (let i = 0; i < out.length; i++) {
            const s = i * ratio;
            const f = Math.floor(s);
            const c = Math.min(f + 1, inputBuffer.length - 1);
            out[i]  = inputBuffer[f] * (1 - (s - f)) + inputBuffer[c] * (s - f);
        }
        return out;
    }

    function float32ToPCM16(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16;
    }

    function calculateRMS(float32Array) {
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) sum += float32Array[i] * float32Array[i];
        return Math.sqrt(sum / float32Array.length);
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary  = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    // ============================================================================
    // STARTUP
    // ============================================================================

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
