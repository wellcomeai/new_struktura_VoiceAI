/**
 * 🚀 Gemini Fullscreen Voice Widget v1.0.0
 * Supports: gemini-2.5-flash + gemini-3.1-flash-live
 *
 * States:
 *   1. BUTTON   — small pulsing button in corner
 *   2. DIALOG   — expanded 320×460 panel with sphere
 *   3. IMAGE    — fullscreen overlay with image (audio continues)
 *
 * Attributes:
 *   data-assistantId  — agent ID
 *   data-server       — server URL
 *   data-model        — "2.5" | "3.1" (default: "2.5")
 *   data-position     — "bottom-right" | "bottom-left" | "top-right" | "top-left"
 *
 * @version 1.0.0
 * @author WellcomeAI Team
 */

(function () {
    'use strict';

    // ─────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────
    const CONFIG = {
        assistantId: null,
        serverUrl: null,
        model: '2.5',
        position: 'bottom-right',
        audio: {
            outputSampleRate: 24000,
            playbackSampleRate: 24000,
            actualSampleRate: null,
            needsResampling: false
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

    // ─────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────
    const STATE = {
        // connection
        ws: null,
        isConnected: false,
        isSetupComplete: false,
        readyToRecord: false,
        reconnectAttempts: 0,
        pingInterval: null,
        setupTimeout: null,
        // audio
        audioContext: null,
        mediaStream: null,
        audioWorkletNode: null,
        audioStreamNode: null,
        audioWorkletReady: false,
        streamWorkletReady: false,
        // ui mode: 'button' | 'dialog' | 'image'
        mode: 'button',
        isRecording: false,
        isPlaying: false,
        isSpeaking: false,
        currentImageUrl: null,
        ui: {}
    };

    // ─────────────────────────────────────────────
    // AUDIO WORKLETS
    // ─────────────────────────────────────────────
    const RECORDER_WORKLET = `
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
    downsample(input) {
        if (this.resampleRatio === 1) return input;
        const outLen = Math.floor(input.length / this.resampleRatio);
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const src = i * this.resampleRatio;
            const f = Math.floor(src);
            const c = Math.min(f + 1, input.length - 1);
            out[i] = input[f] * (1 - (src - f)) + input[c] * (src - f);
        }
        return out;
    }
    process(inputs) {
        const ch = inputs[0]?.[0];
        if (!ch) return true;
        const ds = this.downsample(ch);
        for (let i = 0; i < ds.length; i++) {
            this.buffer[this.bufferIndex++] = ds[i];
            if (this.bufferIndex >= this.bufferSize) {
                this.port.postMessage({ type: 'audioData', data: this.buffer.slice(0, this.bufferIndex) });
                this.bufferIndex = 0;
            }
        }
        return true;
    }
}
registerProcessor('recorder-worklet-fs', RecorderWorkletProcessor);
`;

    const STREAM_WORKLET = `
class AudioStreamProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = [];
        this.current = null;
        this.idx = 0;
        this.port.onmessage = (e) => {
            if (e.data.type === 'audioData') this.queue.push(e.data.buffer);
            else if (e.data.type === 'clear') { this.queue = []; this.current = null; this.idx = 0; }
        };
    }
    process(_, outputs) {
        const out = outputs[0]?.[0];
        if (!out) return true;
        for (let i = 0; i < out.length; i++) {
            if (!this.current || this.idx >= this.current.length) {
                this.current = this.queue.shift() || null;
                this.idx = 0;
            }
            out[i] = this.current ? this.current[this.idx++] : 0;
        }
        return true;
    }
}
registerProcessor('stream-worklet-fs', AudioStreamProcessor);
`;

    // ─────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────
    function init() {
        const tag = findScriptTag();
        if (!tag) return console.error('[FS-WIDGET] script tag not found');

        CONFIG.assistantId = tag.dataset.assistantid || tag.getAttribute('data-assistantId');
        CONFIG.serverUrl   = tag.dataset.server;
        CONFIG.model       = tag.dataset.model || '2.5';
        CONFIG.position    = tag.dataset.position || 'bottom-right';

        if (!CONFIG.assistantId || !CONFIG.serverUrl) {
            return console.error('[FS-WIDGET] missing assistantId or server');
        }

        loadFontAwesome();
        injectStyles();
        buildDOM();
        cacheUI();
        bindEvents();

        document.addEventListener('click', initAudio, { once: true });
        document.addEventListener('touchstart', initAudio, { once: true });
    }

    function findScriptTag() {
        const bySrc = document.querySelector('script[src*="gemini-widget-fullscreen.js"][data-assistantId]')
                   || document.querySelector('script[src*="gemini-widget-fullscreen.js"]');
        if (bySrc) return bySrc;
        const all = document.querySelectorAll('script[data-assistantId]');
        return all.length ? all[all.length - 1] : document.currentScript;
    }

    function loadFontAwesome() {
        if (document.getElementById('fa-css-fs')) return;
        const l = document.createElement('link');
        l.id = 'fa-css-fs';
        l.rel = 'stylesheet';
        l.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
        document.head.appendChild(l);
    }

    // ─────────────────────────────────────────────
    // STYLES
    // ─────────────────────────────────────────────
    function posCSS() {
        const p = CONFIG.position.split('-');
        return `${p[0]}: 20px; ${p[1]}: 20px;`;
    }

    function injectStyles() {
        const old = document.getElementById('fs-widget-styles');
        if (old) old.remove();
        const s = document.createElement('style');
        s.id = 'fs-widget-styles';
        s.textContent = `
/* ── trigger button ── */
#fsw-btn {
    position: fixed; ${posCSS()}
    z-index: 2147483647;
    width: 60px; height: 60px; border-radius: 50%;
    background: linear-gradient(135deg, #4a86e8, #2b59c3);
    box-shadow: 0 8px 32px rgba(74,134,232,.35);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; border: none; outline: none;
    transition: transform .3s, box-shadow .3s;
}
#fsw-btn:hover { transform: scale(1.06); }
#fsw-btn.pulse { animation: fsw-pulse 2s infinite; }
@keyframes fsw-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(74,134,232,.7); }
    70%  { box-shadow: 0 0 0 10px rgba(74,134,232,0); }
    100% { box-shadow: 0 0 0 0 rgba(74,134,232,0); }
}
.fsw-bars-mini { display:flex; align-items:center; gap:3px; height:26px; }
.fsw-bar-mini  { width:3px; border-radius:2px; background:#fff; opacity:.9;
    animation: fsw-eq 1.2s ease-in-out infinite; }
.fsw-bar-mini:nth-child(1){height:7px;animation-delay:0s}
.fsw-bar-mini:nth-child(2){height:12px;animation-delay:.3s}
.fsw-bar-mini:nth-child(3){height:18px;animation-delay:.1s}
.fsw-bar-mini:nth-child(4){height:9px;animation-delay:.5s}
@keyframes fsw-eq { 0%,100%{height:5px} 50%{height:18px} }

/* ── dialog panel ── */
#fsw-panel {
    position: fixed; ${posCSS()}
    z-index: 2147483646;
    width: 320px; height: 0; opacity: 0; pointer-events: none;
    background: rgba(255,255,255,.96);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-radius: 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,.18);
    display: flex; flex-direction: column;
    overflow: hidden;
    transition: height .45s cubic-bezier(.175,.885,.32,1.275),
                opacity .35s ease;
}
#fsw-panel.open { height: 460px; opacity: 1; pointer-events: all; }
#fsw-header {
    padding: 14px 18px;
    background: linear-gradient(135deg,#1e3a8a,#3b82f6);
    color: #fff; display: flex; justify-content: space-between; align-items: center;
    border-radius: 20px 20px 0 0; flex-shrink: 0;
}
#fsw-title { font: 600 15px/1 'Segoe UI',sans-serif; letter-spacing:.3px; }
#fsw-close-btn {
    background:none;border:none;color:#fff;font-size:17px;cursor:pointer;
    opacity:.8; transition:opacity .2s, transform .2s;
}
#fsw-close-btn:hover { opacity:1; transform:scale(1.1); }
#fsw-body {
    flex:1; display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    background:#f9fafc; position:relative; padding:20px 20px 12px;
}

/* sphere */
#fsw-sphere {
    width:180px; height:180px; border-radius:50%;
    background:linear-gradient(135deg,#f3f4f6,#e5e7eb);
    box-shadow:0 10px 25px rgba(0,0,0,.1), inset 0 2px 5px rgba(255,255,255,.5);
    position:relative; overflow:hidden;
    display:flex; align-items:center; justify-content:center;
    transition: background .3s, box-shadow .3s;
}
#fsw-sphere::before {
    content:''; position:absolute; width:140%; height:140%; border-radius:40%;
    background:linear-gradient(45deg,rgba(255,255,255,.3),rgba(74,134,232,.2));
    animation:fsw-wave 8s linear infinite;
}
@keyframes fsw-wave { to{ transform:rotate(360deg); } }
#fsw-sphere.listening {
    background:linear-gradient(135deg,#dbeafe,#eff6ff);
    box-shadow:0 0 30px rgba(37,99,235,.5),inset 0 2px 5px rgba(255,255,255,.5);
}
#fsw-sphere.listening::before { animation-duration:4s; background:linear-gradient(45deg,rgba(255,255,255,.5),rgba(37,99,235,.3)); }
#fsw-sphere.listening::after  { content:''; position:absolute; width:100%; height:100%; border-radius:50%; border:3px solid rgba(37,99,235,.5); animation:fsw-ring 1.5s ease-out infinite; }
@keyframes fsw-ring { 0%{transform:scale(.95);opacity:.7} 50%{transform:scale(1.05);opacity:.3} 100%{transform:scale(.95);opacity:.7} }
#fsw-sphere.speaking {
    background:linear-gradient(135deg,#dcfce7,#ecfdf5);
    box-shadow:0 0 30px rgba(5,150,105,.5),inset 0 2px 5px rgba(255,255,255,.5);
}
#fsw-sphere.speaking::before { animation-duration:3s; background:linear-gradient(45deg,rgba(255,255,255,.5),rgba(5,150,105,.3)); }
#fsw-sphere.speaking::after  { content:''; position:absolute; width:100%; height:100%; border-radius:50%; background:radial-gradient(circle,transparent 50%,rgba(5,150,105,.1) 100%); animation:fsw-ripple 2s ease-out infinite; }
@keyframes fsw-ripple { 0%{transform:scale(.8);opacity:0} 50%{opacity:.5} 100%{transform:scale(1.2);opacity:0} }
#fsw-sphere.interrupted {
    background:linear-gradient(135deg,#fef3c7,#fffbeb);
    box-shadow:0 0 30px rgba(217,119,6,.5),inset 0 2px 5px rgba(255,255,255,.5);
}
#fsw-mic { color:#3b82f6; font-size:32px; z-index:10; transition:color .3s; }
#fsw-sphere.listening .fsw-mic  { color:#2563eb; }
#fsw-sphere.speaking .fsw-mic   { color:#059669; }
#fsw-sphere.interrupted .fsw-mic{ color:#d97706; }

/* waveform bars */
#fsw-waves { display:flex; align-items:flex-end; gap:2px; height:30px; margin-top:10px; }
.fsw-wave-bar { width:3px; height:2px; background:#3b82f6; border-radius:1px; transition:height .1s; }

/* status */
#fsw-status {
    position:absolute; bottom:48px; left:50%; transform:translateX(-50%);
    font:11px/1 'Segoe UI',sans-serif; color:#475569;
    padding:4px 8px; border-radius:10px; background:rgba(255,255,255,.8);
    display:flex; align-items:center; gap:5px;
    opacity:0; transition:opacity .3s; white-space:nowrap;
}
#fsw-status.show { opacity:.85; }
#fsw-dot { width:6px; height:6px; border-radius:50%; background:#10b981; }
#fsw-dot.connecting { background:#f59e0b; }
#fsw-dot.disconnected { background:#ef4444; }

/* error */
#fsw-error {
    display:none; color:#ef4444; background:rgba(254,226,226,.85);
    border:1px solid #ef4444; border-radius:8px;
    font:13px/1.4 'Segoe UI',sans-serif; padding:8px 12px;
    text-align:center; margin-top:10px;
}
#fsw-error.show { display:block; }
#fsw-retry {
    margin-top:6px; background:#ef4444; color:#fff; border:none;
    border-radius:4px; padding:4px 10px; font-size:12px; cursor:pointer;
}

/* loader */
#fsw-loader {
    position:absolute; inset:0; border-radius:20px;
    background:rgba(255,255,255,.86); backdrop-filter:blur(5px);
    display:flex; align-items:center; justify-content:center;
    opacity:0; visibility:hidden; transition:opacity .3s,visibility .3s;
}
#fsw-loader.show { opacity:1; visibility:visible; }
.fsw-spinner {
    width:38px; height:38px; border-radius:50%;
    border:3px solid rgba(59,130,246,.2); border-top-color:#3b82f6;
    animation:fsw-spin 1s linear infinite;
}
@keyframes fsw-spin { to{ transform:rotate(360deg); } }

/* ── fullscreen image overlay ── */
#fsw-overlay {
    position: fixed; inset: 0;
    z-index: 2147483645;
    background: #000;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none;
    transition: opacity .4s ease;
}
#fsw-overlay.show { opacity: 1; pointer-events: all; }
#fsw-img {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    opacity: 0; transition: opacity .5s ease;
}
#fsw-img.show { opacity: 1; }
#fsw-minimize {
    position: absolute; top: 18px; right: 18px;
    width: 44px; height: 44px; border-radius: 50%;
    background: rgba(0,0,0,.55); border: 1.5px solid rgba(255,255,255,.25);
    color: #fff; font-size: 18px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background .2s, transform .2s;
    z-index: 10;
}
#fsw-minimize:hover { background:rgba(0,0,0,.75); transform:scale(1.08); }
#fsw-img-desc {
    position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,.5); color: #fff;
    font: 14px/1.5 'Segoe UI',sans-serif; padding: 8px 18px; border-radius: 20px;
    max-width: 80%; text-align: center;
    opacity: 0; transition: opacity .4s .3s;
}
#fsw-img-desc.show { opacity: 1; }
        `;
        document.head.appendChild(s);
    }

    // ─────────────────────────────────────────────
    // DOM
    // ─────────────────────────────────────────────
    function buildDOM() {
        // remove old
        ['fsw-btn','fsw-panel','fsw-overlay'].forEach(id => document.getElementById(id)?.remove());

        // trigger button
        document.body.insertAdjacentHTML('beforeend', `
<button id="fsw-btn" class="pulse" title="Голосовой ассистент">
  <div class="fsw-bars-mini">
    <div class="fsw-bar-mini"></div><div class="fsw-bar-mini"></div>
    <div class="fsw-bar-mini"></div><div class="fsw-bar-mini"></div>
  </div>
</button>

<div id="fsw-panel">
  <div id="fsw-header">
    <span id="fsw-title">Голосовой ассистент</span>
    <button id="fsw-close-btn"><i class="fas fa-times"></i></button>
  </div>
  <div id="fsw-body">
    <div id="fsw-sphere">
      <i class="fas fa-microphone fsw-mic" id="fsw-mic"></i>
    </div>
    <div id="fsw-waves"></div>
    <div id="fsw-error">Ошибка соединения<br><button id="fsw-retry">Повторить</button></div>
    <div id="fsw-status"><div id="fsw-dot"></div><span id="fsw-status-text">Подключение...</span></div>
    <div id="fsw-loader" class="show"><div class="fsw-spinner"></div></div>
  </div>
</div>

<div id="fsw-overlay">
  <img id="fsw-img" src="" alt="">
  <button id="fsw-minimize" title="Свернуть"><i class="fas fa-chevron-down"></i></button>
  <div id="fsw-img-desc"></div>
</div>`);

        // create wave bars
        const w = document.getElementById('fsw-waves');
        for (let i = 0; i < 20; i++) {
            const b = document.createElement('div');
            b.className = 'fsw-wave-bar';
            w.appendChild(b);
        }
    }

    function cacheUI() {
        STATE.ui = {
            btn:       document.getElementById('fsw-btn'),
            panel:     document.getElementById('fsw-panel'),
            sphere:    document.getElementById('fsw-sphere'),
            waveBars:  document.querySelectorAll('.fsw-wave-bar'),
            loader:    document.getElementById('fsw-loader'),
            dot:       document.getElementById('fsw-dot'),
            statusEl:  document.getElementById('fsw-status'),
            statusTxt: document.getElementById('fsw-status-text'),
            errorEl:   document.getElementById('fsw-error'),
            retryBtn:  document.getElementById('fsw-retry'),
            closeBtn:  document.getElementById('fsw-close-btn'),
            overlay:   document.getElementById('fsw-overlay'),
            img:       document.getElementById('fsw-img'),
            minimize:  document.getElementById('fsw-minimize'),
            imgDesc:   document.getElementById('fsw-img-desc'),
        };
    }

    function bindEvents() {
        STATE.ui.btn.addEventListener('click', onBtnClick);
        STATE.ui.closeBtn.addEventListener('click', onClose);
        STATE.ui.retryBtn.addEventListener('click', connectWS);
        STATE.ui.minimize.addEventListener('click', onMinimize);
    }

    // ─────────────────────────────────────────────
    // MODE TRANSITIONS
    // ─────────────────────────────────────────────
    async function onBtnClick() {
        if (STATE.mode !== 'button') return;
        setMode('dialog');
        if (!STATE.audioContext) await initAudio();
        if (!STATE.isConnected && !STATE.ws) connectWS();
        else if (STATE.isConnected && STATE.readyToRecord && !STATE.isRecording) startRecording();
    }

    function onClose() {
        // dialog → button, disconnect
        hideImage();
        setMode('button');
        stopRecording();
        stopPlayback();
        if (STATE.ws) { STATE.ws.close(); STATE.ws = null; }
        STATE.isConnected = false;
        STATE.readyToRecord = false;
        if (STATE.pingInterval) { clearInterval(STATE.pingInterval); STATE.pingInterval = null; }
    }

    function onMinimize() {
        // image → dialog (audio keeps going)
        hideImage();
        setMode('dialog');
    }

    function setMode(mode) {
        STATE.mode = mode;
        const ui = STATE.ui;
        if (mode === 'button') {
            ui.panel.classList.remove('open');
            ui.btn.classList.add('pulse');
        } else if (mode === 'dialog') {
            ui.panel.classList.add('open');
            ui.btn.classList.remove('pulse');
        } else if (mode === 'image') {
            // overlay shown separately in showImage()
        }
    }

    // ─────────────────────────────────────────────
    // IMAGE DISPLAY
    // ─────────────────────────────────────────────
    function showImage(url, description) {
        const ui = STATE.ui;
        STATE.currentImageUrl = url;
        STATE.mode = 'image';

        // fade out old image first if any
        ui.img.classList.remove('show');
        ui.imgDesc.classList.remove('show');

        ui.overlay.classList.add('show');
        ui.img.src = url;

        ui.img.onload = () => {
            ui.img.classList.add('show');
            if (description) {
                ui.imgDesc.textContent = description;
                ui.imgDesc.classList.add('show');
            }
        };
        ui.img.onerror = () => {
            console.warn('[FS-WIDGET] Image load failed:', url);
        };
    }

    function hideImage() {
        const ui = STATE.ui;
        ui.img.classList.remove('show');
        ui.imgDesc.classList.remove('show');
        setTimeout(() => {
            ui.overlay.classList.remove('show');
            ui.img.src = '';
            ui.imgDesc.textContent = '';
        }, 400);
        STATE.currentImageUrl = null;
    }

    // ─────────────────────────────────────────────
    // UI STATE
    // ─────────────────────────────────────────────
    function uiState(state, msg) {
        const ui = STATE.ui;
        ui.sphere.classList.remove('listening','speaking','interrupted');
        ui.dot.classList.remove('connecting','disconnected');

        if (msg) {
            ui.statusTxt.textContent = msg;
            ui.statusEl.classList.add('show');
            setTimeout(() => ui.statusEl.classList.remove('show'), 3000);
        }

        switch(state) {
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

    function updateWaves(data) {
        const bars = STATE.ui.waveBars;
        if (!bars?.length) return;
        const step = Math.floor(data.length / bars.length);
        for (let i = 0; i < bars.length; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) sum += Math.abs(data[i * step + j] || 0);
            bars[i].style.height = (2 + Math.min(28, Math.floor(sum / step * 150))) + 'px';
        }
    }

    function resetWaves() {
        STATE.ui.waveBars?.forEach(b => b.style.height = '2px');
    }

    // ─────────────────────────────────────────────
    // AUDIO INIT
    // ─────────────────────────────────────────────
    async function initAudio() {
        if (STATE.audioContext) {
            if (STATE.audioContext.state === 'suspended') await STATE.audioContext.resume();
            return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        STATE.audioContext = new Ctx({ sampleRate: CONFIG.audio.playbackSampleRate, latencyHint: 'interactive' });
        CONFIG.audio.actualSampleRate = STATE.audioContext.sampleRate;
        CONFIG.audio.needsResampling = STATE.audioContext.sampleRate !== CONFIG.audio.outputSampleRate;
        await loadWorklets();
    }

    async function loadWorklets() {
        const load = (code, name) => {
            const blob = new Blob([code], { type: 'application/javascript' });
            const url  = URL.createObjectURL(blob);
            return STATE.audioContext.audioWorklet.addModule(url).then(() => URL.revokeObjectURL(url));
        };
        try {
            await load(RECORDER_WORKLET, 'recorder-worklet-fs');
            STATE.audioWorkletReady = true;
            await load(STREAM_WORKLET, 'stream-worklet-fs');
            STATE.streamWorkletReady = true;
        } catch(e) { console.error('[FS-WIDGET] worklet load failed', e); }
    }

    // ─────────────────────────────────────────────
    // WEBSOCKET
    // ─────────────────────────────────────────────
    function wsEndpoint() {
        const base = CONFIG.serverUrl.replace(/^http/, 'ws');
        return CONFIG.model === '3.1'
            ? `${base}/ws/gemini-31/${CONFIG.assistantId}`
            : `${base}/ws/gemini/${CONFIG.assistantId}`;
    }

    function connectWS() {
        uiState('connecting', 'Подключение...');
        try {
            STATE.ws = new WebSocket(wsEndpoint());
            STATE.ws.binaryType = 'arraybuffer';

            STATE.ws.onopen = () => {
                STATE.isConnected = true;
                STATE.reconnectAttempts = 0;
                uiState('connected', 'Соединение установлено');
                STATE.pingInterval = setInterval(() => {
                    if (STATE.ws?.readyState === WebSocket.OPEN) STATE.ws.send(JSON.stringify({ type: 'ping' }));
                }, CONFIG.ws.pingInterval);
                STATE.setupTimeout = setTimeout(() => {
                    if (!STATE.isSetupComplete) {
                        STATE.isSetupComplete = true;
                        STATE.readyToRecord = true;
                        if (STATE.mode === 'dialog') startRecording();
                    }
                }, CONFIG.setup.maxSetupWait);
            };

            STATE.ws.onmessage = onMessage;

            STATE.ws.onerror = () => uiState('error', 'Ошибка сервера');

            STATE.ws.onclose = () => {
                STATE.isConnected = false;
                STATE.readyToRecord = false;
                stopPlayback();
                if (STATE.isRecording) stopRecording();
                uiState('disconnected', 'Отключено');
                if (STATE.pingInterval) { clearInterval(STATE.pingInterval); STATE.pingInterval = null; }
                if (STATE.mode !== 'button' && STATE.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
                    STATE.reconnectAttempts++;
                    setTimeout(connectWS, CONFIG.ws.reconnectDelay);
                }
            };
        } catch(e) {
            console.error('[FS-WIDGET] WS error', e);
            uiState('error', 'Ошибка сети');
        }
    }

    // ─────────────────────────────────────────────
    // MESSAGE HANDLER
    // ─────────────────────────────────────────────
    function onMessage(event) {
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        switch(data.type) {
            case 'gemini.setup.complete':
                STATE.isSetupComplete = true;
                clearTimeout(STATE.setupTimeout);
                uiState('connected', 'Настройка завершена');
                setTimeout(() => {
                    STATE.readyToRecord = true;
                    if (STATE.mode === 'dialog') startRecording();
                }, CONFIG.setup.waitAfterSetup);
                break;

            case 'response.audio.delta':
                handleAudioDelta(data);
                break;

            case 'assistant.speech.started':
                STATE.isSpeaking = true;
                uiState('playing', 'Ассистент говорит');
                if (!STATE.isPlaying) startAudioStream();
                break;

            case 'assistant.speech.ended':
                STATE.isSpeaking = false;
                stopPlayback();
                if (STATE.isRecording) uiState('recording', 'Слушаю...');
                break;

            case 'conversation.interrupted':
                STATE.isSpeaking = false;
                stopPlayback();
                uiState('interrupted', 'Прервано');
                setTimeout(() => { if (STATE.isRecording) uiState('recording', 'Слушаю...'); }, 800);
                break;

            case 'function_call.completed':
                if (data.function === 'show_image' && data.result?.url) {
                    showImage(data.result.url, data.result.description || '');
                    // open dialog if minimized so user sees minimize button exists
                    if (STATE.mode === 'button') setMode('dialog');
                }
                break;

            case 'error':
                uiState('error', data.error?.message || 'Ошибка');
                break;
        }
    }

    // ─────────────────────────────────────────────
    // AUDIO — RECORDING
    // ─────────────────────────────────────────────
    async function startRecording() {
        if (STATE.isRecording || !STATE.audioWorkletReady) return;
        try {
            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            const src  = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
            const node = new AudioWorkletNode(STATE.audioContext, 'recorder-worklet-fs');

            node.port.onmessage = (e) => {
                if (!STATE.isRecording) return;
                const pcm = float32ToPCM(e.data.data);
                updateWaves(e.data.data);
                if (STATE.ws?.readyState === WebSocket.OPEN) {
                    STATE.ws.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: bufToB64(pcm.buffer)
                    }));
                }
            };

            src.connect(node);
            STATE.audioWorkletNode = { src, node };
            STATE.isRecording = true;
            uiState('recording', 'Слушаю...');
        } catch(e) {
            console.error('[FS-WIDGET] mic error', e);
            uiState('error', 'Нет доступа к микрофону');
        }
    }

    function stopRecording() {
        if (!STATE.isRecording) return;
        STATE.isRecording = false;
        STATE.mediaStream?.getTracks().forEach(t => t.stop());
        STATE.mediaStream = null;
        if (STATE.audioWorkletNode) {
            try { STATE.audioWorkletNode.src.disconnect(); STATE.audioWorkletNode.node.disconnect(); } catch {}
            STATE.audioWorkletNode = null;
        }
        resetWaves();
    }

    // ─────────────────────────────────────────────
    // AUDIO — PLAYBACK
    // ─────────────────────────────────────────────
    function handleAudioDelta(data) {
        if (!data.delta) return;
        try {
            const bytes  = Uint8Array.from(atob(data.delta), c => c.charCodeAt(0));
            const pcm16  = new Int16Array(bytes.buffer);
            const f32    = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
            const audio  = CONFIG.audio.needsResampling
                ? resample(f32, CONFIG.audio.outputSampleRate, CONFIG.audio.actualSampleRate) : f32;
            STATE.audioStreamNode?.port.postMessage({ type: 'audioData', buffer: audio });
            if (!STATE.isPlaying) startAudioStream();
        } catch(e) { console.error('[FS-WIDGET] audio delta', e); }
    }

    function startAudioStream() {
        if (STATE.isPlaying || !STATE.streamWorkletReady) return;
        try {
            if (!STATE.audioStreamNode) {
                STATE.audioStreamNode = new AudioWorkletNode(STATE.audioContext, 'stream-worklet-fs');
                STATE.audioStreamNode.connect(STATE.audioContext.destination);
            }
            STATE.isPlaying = true;
        } catch(e) { console.error('[FS-WIDGET] stream error', e); }
    }

    function stopPlayback() {
        if (!STATE.isPlaying) return;
        STATE.audioStreamNode?.port.postMessage({ type: 'clear' });
        STATE.isPlaying = false;
        resetWaves();
    }

    // ─────────────────────────────────────────────
    // UTILS
    // ─────────────────────────────────────────────
    function float32ToPCM(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return out;
    }

    function bufToB64(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function resample(buf, inRate, outRate) {
        if (inRate === outRate) return buf;
        const ratio = inRate / outRate;
        const out   = new Float32Array(Math.round(buf.length / ratio));
        for (let i = 0; i < out.length; i++) {
            const s = i * ratio;
            const f = Math.floor(s), c = Math.min(f + 1, buf.length - 1);
            out[i] = buf[f] * (1 - (s - f)) + buf[c] * (s - f);
        }
        return out;
    }

    // ─────────────────────────────────────────────
    // STARTUP
    // ─────────────────────────────────────────────
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
