/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.4.3 - Refined Interruptions & Server Error Handling
 * 
 * Этот скрипт динамически создает и встраивает виджет голосового ассистента
 * на любой сайт, в том числе на Tilda и другие конструкторы сайтов.
 * Улучшена поддержка мобильных устройств и iOS.
 * Исправлена возможность мгновенного перебивания ассистента голосом.
 * Добавлены расширенные механизмы прерывания и диагностика.
 * Внесены исправления на основе анализа логов v09.02.
 */

(function() {
  // Настройки виджета
  const DEBUG_MODE = true; 
  const MAX_RECONNECT_ATTEMPTS = 5; 
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10; 
  const PING_INTERVAL = 15000; 
  const MOBILE_PING_INTERVAL = 10000; 
  const CONNECTION_TIMEOUT = 20000; 
  const MAX_DEBUG_ITEMS = 10; 

  // Глобальное хранение состояния
  let reconnectAttempts = 0;
  let globalPingIntervalId = null; 
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  
  window.audioContextInitialized = false;
  window.tempAudioContext = null;
  window.hasPlayedSilence = false;

  const widgetLog = (message, type = 'info') => {
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      const logPrefix = '[WellcomeAI Widget]'; const timestamp = new Date().toISOString().slice(11, 23);
      console.log(`${logPrefix} ${timestamp} | ${type.toUpperCase()} | ${message}`);
    } else if (DEBUG_MODE || type === 'error') {
      const prefix = '[WellcomeAI Widget]';
      if (type === 'error') console.error(`${prefix} ERROR:`, message);
      else if (type === 'warn') console.warn(`${prefix} WARNING:`, message);
      else if (DEBUG_MODE) console.log(`${prefix}`, message);
    }
  };

  const addToDebugQueue = (message, type = 'info') => { /* ... (без изменений) ... */ };
  const getDebugInfo = () => { /* ... (без изменений) ... */ };
  const updateDebugPanel = () => { /* ... (без изменений) ... */ };
  const getServerUrl = () => { /* ... (без изменений, как в v1.4.2) ... */ 
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-server')) { serverUrl = scriptTags[i].getAttribute('data-server'); widgetLog(`Found server URL from data-server attribute: ${serverUrl}`); break; }
      if (scriptTags[i].dataset && scriptTags[i].dataset.server) { serverUrl = scriptTags[i].dataset.server; widgetLog(`Found server URL from dataset.server: ${serverUrl}`); break; }
      const src = scriptTags[i].getAttribute('src');
      if (src && (src.includes('widget.js') || src.includes('wellcomeai-widget.min.js'))) {
        try { const url = new URL(src, window.location.href); serverUrl = url.origin; widgetLog(`Extracted server URL from script src: ${serverUrl}`); break; }
        catch (e) { widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn'); if (src.startsWith('/')) { serverUrl = window.location.origin; widgetLog(`Using current origin for relative path: ${serverUrl}`); break; } }
      }
    }
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) { serverUrl = window.location.protocol + '//' + serverUrl; widgetLog(`Added protocol to server URL: ${serverUrl}`); }
    if (!serverUrl) { serverUrl = 'https://realtime-saas.onrender.com'; widgetLog(`Using fallback server URL: ${serverUrl}`); }
    return serverUrl.replace(/\/$/, '');
  };
  const getAssistantId = () => { /* ... (без изменений, как в v1.4.2) ... */ 
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-assistantId') || scriptTags[i].hasAttribute('data-assistantid')) { const id = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid'); widgetLog(`Found assistant ID from attribute: ${id}`); return id; }
      if (scriptTags[i].dataset && (scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid)) { const id = scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid; widgetLog(`Found assistant ID from dataset: ${id}`); return id; }
    }
    const urlParams = new URLSearchParams(window.location.search); const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) { widgetLog(`Found assistant ID in URL param: ${idFromUrl}`); return idFromUrl; }
    if (window.wellcomeAIAssistantId) { widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`); return window.wellcomeAIAssistantId; }
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) { widgetLog(`Using demo ID on demo page`); return 'demo'; }
    widgetLog('No assistant ID found!', 'error'); return null;
  };
  const getWidgetPosition = () => { /* ... (без изменений, как в v1.4.2) ... */ 
    const defaultPosition = { horizontal: 'right', vertical: 'bottom', distance: '20px' }; const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-position')) return parsePosition(scriptTags[i].getAttribute('data-position'));
      if (scriptTags[i].dataset && scriptTags[i].dataset.position) return parsePosition(scriptTags[i].dataset.position);
    } return defaultPosition;
    function parsePosition(positionString) {
      const position = { ...defaultPosition }; if (!positionString) return position;
      const parts = positionString.toLowerCase().split('-');
      if (parts.length === 2) { if (parts[0] === 'top' || parts[0] === 'bottom') { position.vertical = parts[0]; position.horizontal = parts[1]; } else if (parts[1] === 'top' || parts[1] === 'bottom') { position.vertical = parts[1]; position.horizontal = parts[0]; } }
      return position;
    }
  };

  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID;
  
  widgetLog(`Config: Server=${SERVER_URL}, Assistant=${ASSISTANT_ID}, Pos=${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WS URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);

  class InterruptionDiagnostics { /* ... (без изменений, как в v1.4.2) ... */ 
    constructor() { this.events = []; this.maxEvents = 100; this.isEnabled = DEBUG_MODE; }
    log(event, data = {}) { if (!this.isEnabled) return; const timestamp = Date.now(); const entry = { timestamp, time: new Date(timestamp).toISOString(), event, data: JSON.parse(JSON.stringify(data)) }; this.events.push(entry); if (this.events.length > this.maxEvents) this.events.shift(); console.log(`[DIAG] ${entry.time.slice(11,23)} | ${event}:`, entry.data); }
    getReport() { return { totalEvents: this.events.length, events: this.events.slice(-20), summary: this.generateSummary() }; }
    generateSummary() { const eventTypes = {}; this.events.forEach(e => { eventTypes[e.event] = (eventTypes[e.event] || 0) + 1; }); return { eventCounts: eventTypes, timespan: this.events.length > 0 ? this.events[this.events.length - 1].timestamp - this.events[0].timestamp : 0 }; }
    exportLog() { return JSON.stringify(this.getReport(), null, 2); }
  }
  const interruptionDiag = new InterruptionDiagnostics();
  window.getInterruptionDiagnostics = () => interruptionDiag.getReport();
  window.exportInterruptionLog = () => { /* ... (без изменений, как в v1.4.2) ... */ 
    const log = interruptionDiag.exportLog(); const blob = new Blob([log], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `interruption-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    widgetLog("Interruption log exported.");
  };

  function createStyles() { /* ... (без изменений, как в v1.4.2) ... */ 
    const styleEl = document.createElement('style'); styleEl.id = 'wellcomeai-widget-styles';
    styleEl.textContent = `
      .wellcomeai-widget-container { position: fixed; ${WIDGET_POSITION.vertical}: ${WIDGET_POSITION.distance}; ${WIDGET_POSITION.horizontal}: ${WIDGET_POSITION.distance}; z-index: 2147483647; transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); font-family: 'Segoe UI', 'Roboto', sans-serif; }
      .wellcomeai-widget-button { width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #4a86e8, #2b59c3); box-shadow: 0 4px 15px rgba(74, 134, 232, 0.4); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.3s ease; position: relative; overflow: hidden; z-index: 2147483647; border: none; outline: none; }
      .wellcomeai-widget-button:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(74, 134, 232, 0.5); }
      .wellcomeai-widget-button::before { content: ''; position: absolute; width: 150%; height: 150%; background: linear-gradient(45deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.2)); transform: rotate(45deg); top: -30%; left: -30%; transition: all 0.6s ease; }
      .wellcomeai-widget-button:hover::before { transform: rotate(90deg); }
      .wellcomeai-widget-icon { color: white; font-size: 22px; z-index: 2; transition: all 0.3s ease; }
      .wellcomeai-widget-expanded { position: absolute; ${WIDGET_POSITION.vertical}: 0; ${WIDGET_POSITION.horizontal}: 0; width: 320px; height: 0; opacity: 0; pointer-events: none; background: white; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15); overflow: hidden; transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); display: flex; flex-direction: column; z-index: 2147483646; }
      .wellcomeai-widget-container.active .wellcomeai-widget-expanded { height: 400px; opacity: 1; pointer-events: all; }
      .wellcomeai-widget-container.active .wellcomeai-widget-button { transform: scale(0.9); box-shadow: 0 2px 10px rgba(74, 134, 232, 0.3); }
      .wellcomeai-widget-header { padding: 15px 20px; background: linear-gradient(135deg, #4a86e8, #2b59c3); color: white; display: flex; justify-content: space-between; align-items: center; border-radius: 20px 20px 0 0; position: relative; }
      .wellcomeai-widget-title { font-weight: 600; font-size: 16px; letter-spacing: 0.3px; }
      .wellcomeai-widget-close { background: none; border: none; color: white; font-size: 18px; cursor: pointer; opacity: 0.8; transition: all 0.2s; }
      .wellcomeai-widget-close:hover { opacity: 1; transform: scale(1.1); }
      .wellcomeai-widget-content { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #f9fafc; position: relative; padding: 20px; }
      .wellcomeai-main-circle { width: 180px; height: 180px; border-radius: 50%; background: linear-gradient(135deg, #ffffff, #e1f5fe, #4a86e8); box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1); position: relative; overflow: hidden; transition: all 0.3s ease; display: flex; align-items: center; justify-content: center; }
      .wellcomeai-main-circle::before { content: ''; position: absolute; width: 140%; height: 140%; background: linear-gradient(45deg, rgba(255, 255, 255, 0.3), rgba(74, 134, 232, 0.2)); animation: wellcomeai-wave 8s linear infinite; border-radius: 40%; }
      @keyframes wellcomeai-wave { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      .wellcomeai-main-circle.listening { background: linear-gradient(135deg, #ffffff, #e3f2fd, #2196f3); box-shadow: 0 0 30px rgba(33, 150, 243, 0.6); }
      .wellcomeai-main-circle.listening::before { animation: wellcomeai-wave 4s linear infinite; background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(33, 150, 243, 0.3)); }
      .wellcomeai-main-circle.listening::after { content: ''; position: absolute; width: 100%; height: 100%; border-radius: 50%; border: 3px solid rgba(33, 150, 243, 0.5); animation: wellcomeai-pulse 1.5s ease-out infinite; }
      @keyframes wellcomeai-pulse { 0% { transform: scale(0.95); opacity: 0.7; } 50% { transform: scale(1.05); opacity: 0.3; } 100% { transform: scale(0.95); opacity: 0.7; } }
      .wellcomeai-main-circle.speaking { background: linear-gradient(135deg, #ffffff, #e8f5e9, #4caf50); box-shadow: 0 0 30px rgba(76, 175, 80, 0.6); }
      .wellcomeai-main-circle.speaking::before { animation: wellcomeai-wave 3s linear infinite; background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(76, 175, 80, 0.3)); }
      .wellcomeai-main-circle.speaking::after { content: ''; position: absolute; width: 100%; height: 100%; background: radial-gradient(circle, transparent 50%, rgba(76, 175, 80, 0.1) 100%); border-radius: 50%; animation: wellcomeai-ripple 2s ease-out infinite; }
      @keyframes wellcomeai-ripple { 0% { transform: scale(0.8); opacity: 0;} 50% { opacity: 0.5; } 100% { transform: scale(1.2); opacity: 0; } }
      .wellcomeai-main-circle.interrupted { background: linear-gradient(135deg, #ffffff, #ffebee, #f44336); box-shadow: 0 0 30px rgba(244, 67, 54, 0.6); animation: wellcomeai-interrupt-flash 0.2s ease; }
      @keyframes wellcomeai-interrupt-flash { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      .wellcomeai-mic-icon { color: #4a86e8; font-size: 32px; z-index: 10; }
      .wellcomeai-main-circle.listening .wellcomeai-mic-icon { color: #2196f3; }
      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon { color: #4caf50; }
      .wellcomeai-main-circle.interrupted .wellcomeai-mic-icon { color: #f44336; }
      .wellcomeai-audio-visualization { position: absolute; width: 100%; max-width: 160px; height: 30px; bottom: -5px; opacity: 0.8; pointer-events: none; }
      .wellcomeai-audio-bars { display: flex; align-items: flex-end; height: 30px; gap: 2px; width: 100%; justify-content: center; }
      .wellcomeai-audio-bar { width: 3px; height: 2px; background-color: #4a86e8; border-radius: 1px; transition: height 0.1s ease; }
      .wellcomeai-loader-modal { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255, 255, 255, 0.7); display: flex; align-items: center; justify-content: center; z-index: 2147483646; opacity: 0; visibility: hidden; transition: all 0.3s; border-radius: 20px; }
      .wellcomeai-loader-modal.active { opacity: 1; visibility: visible; }
      .wellcomeai-loader { width: 40px; height: 40px; border: 3px solid rgba(74, 134, 232, 0.3); border-radius: 50%; border-top-color: #4a86e8; animation: wellcomeai-spin 1s linear infinite; }
      @keyframes wellcomeai-spin { to { transform: rotate(360deg); } }
      .wellcomeai-message-display { position: absolute; width: 90%; bottom: 20px; left: 50%; transform: translateX(-50%); background: white; padding: 12px 15px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; font-size: 14px; line-height: 1.4; opacity: 0; transition: all 0.3s; max-height: 100px; overflow-y: auto; z-index: 10; }
      .wellcomeai-message-display.show { opacity: 1; }
      @keyframes wellcomeai-button-pulse { 0% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(74, 134, 232, 0); } 100% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0); } }
      .wellcomeai-pulse-animation { animation: wellcomeai-button-pulse 2s infinite; }
      .wellcomeai-connection-error { color: #ef4444; background-color: rgba(254, 226, 226, 0.8); border: 1px solid #ef4444; padding: 8px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; margin-top: 10px; text-align: center; display: none; }
      .wellcomeai-connection-error.visible { display: block; }
      .wellcomeai-retry-button { background-color: #ef4444; color: white; border: none; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; margin-top: 8px; transition: all 0.2s; }
      .wellcomeai-retry-button:hover { background-color: #dc2626; }
      .wellcomeai-status-indicator { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-size: 11px; color: #64748b; padding: 4px 8px; border-radius: 10px; background-color: rgba(255, 255, 255, 0.7); display: flex; align-items: center; gap: 5px; opacity: 0; transition: opacity 0.3s; }
      .wellcomeai-status-indicator.show { opacity: 0.8; }
      .wellcomeai-status-dot { width: 6px; height: 6px; border-radius: 50%; background-color: #10b981; }
      .wellcomeai-status-dot.disconnected { background-color: #ef4444; }
      .wellcomeai-status-dot.connecting { background-color: #f59e0b; }
      .wellcomeai-ios-audio-button { position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); background-color: #4a86e8; color: white; border: none; border-radius: 15px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; display: none; z-index: 100; }
      .wellcomeai-ios-audio-button.visible { display: block; }
    `;
    document.head.appendChild(styleEl); widgetLog("Styles created.");
  }

  function loadFontAwesome() { /* ... (без изменений, как в v1.4.2) ... */ 
    if (!document.getElementById('font-awesome-css')) { const link = document.createElement('link'); link.id = 'font-awesome-css'; link.rel = 'stylesheet'; link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'; document.head.appendChild(link); widgetLog("Font Awesome loaded."); }
  }

  function createWidgetHTML() { /* ... (без изменений, как в v1.4.2) ... */ 
    const widgetContainer = document.createElement('div'); widgetContainer.className = 'wellcomeai-widget-container'; widgetContainer.id = 'wellcomeai-widget-container'; widgetContainer.style.zIndex = "2147483647";
    widgetContainer.innerHTML = `
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button"><i class="fas fa-robot wellcomeai-widget-icon"></i></div>
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header"><div class="wellcomeai-widget-title">WellcomeAI</div><button class="wellcomeai-widget-close" id="wellcomeai-widget-close"><i class="fas fa-times"></i></button></div>
        <div class="wellcomeai-widget-content">
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle"><i class="fas fa-microphone wellcomeai-mic-icon"></i><div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization"><div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div></div></div>
          <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error"></div>
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">Нажмите для активации аудио</button>
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator"><div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div><span id="wellcomeai-status-text">Подключено</span></div>
        </div>
      </div>
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active"><div class="wellcomeai-loader"></div></div>`;
    document.body.appendChild(widgetContainer); widgetLog("HTML structure created.");
    const widgetButton = document.getElementById('wellcomeai-widget-button'); if (widgetButton) { widgetButton.style.opacity = '1'; widgetButton.style.visibility = 'visible'; widgetButton.style.pointerEvents = 'auto'; }
  }

  function unlockAudioOnIOS() { /* ... (без изменений, как в v1.4.2) ... */ 
    if (!isIOS) return Promise.resolve(true); widgetLog('Attempting iOS audio unlock...');
    return new Promise((resolve) => {
      const tempAudio = document.createElement('audio'); tempAudio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
      tempAudio.volume = 0; const playPromise = tempAudio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => { widgetLog('Audio unlocked via temp audio element.'); if (!window.tempAudioContext) window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)(); if (window.tempAudioContext.state === 'suspended') { window.tempAudioContext.resume().then(() => { window.audioContextInitialized = true; widgetLog('AudioContext resumed.'); resolve(true); }).catch(err => { widgetLog(`AudioContext resume failed: ${err.message}`, 'error'); resolve(false); }); } else { window.audioContextInitialized = true; resolve(true); } }).catch(err => { widgetLog(`Temp audio play failed: ${err.message}`, 'error'); resolve(false); });
      } else { widgetLog('Legacy iOS audio unlock.'); setTimeout(() => { playSilence(); resolve(true); }, 100); }
    });
  }
  function forceIOSAudioUnlock() { /* ... (без изменений, как в v1.4.2) ... */ 
    if (!isIOS) return Promise.resolve(true);
    return new Promise((resolve) => {
      const frequencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]; let index = 0;
      function playNextTone() {
        if (index >= frequencies.length) { window.hasPlayedSilence = true; window.audioContextInitialized = true; widgetLog('Multi-tone iOS unlock complete.'); resolve(true); return; }
        try {
          if (!window.tempAudioContext) window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          const ctx = window.tempAudioContext;
          const playToneAction = () => { const oscillator = ctx.createOscillator(); const gainNode = ctx.createGain(); gainNode.gain.value = 0.01; oscillator.type = 'sine'; oscillator.frequency.value = frequencies[index]; oscillator.connect(gainNode); gainNode.connect(ctx.destination); oscillator.start(ctx.currentTime); oscillator.stop(ctx.currentTime + 0.1); setTimeout(() => { index++; playNextTone(); }, 200); };
          if (ctx.state === 'suspended') ctx.resume().then(playToneAction).catch(e => { widgetLog(`Ctx resume err (force): ${e.message}`, 'warn'); index++; setTimeout(playNextTone, 200);});
          else playToneAction();
        } catch (e) { widgetLog(`Tone unlock err: ${e.message}`, 'warn'); index++; setTimeout(playNextTone, 200); }
      } playNextTone();
    });
  }
  function playSilence() { /* ... (без изменений, как в v1.4.2) ... */ 
    try {
      if (!window.tempAudioContext) window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      const silentBuffer = window.tempAudioContext.createBuffer(1, 1, 22050); const source = window.tempAudioContext.createBufferSource(); source.buffer = silentBuffer; source.connect(window.tempAudioContext.destination); source.start(0);
      window.hasPlayedSilence = true; widgetLog("Played silence for iOS unlock.");
      if (window.tempAudioContext.state === 'suspended') { window.tempAudioContext.resume().then(() => { window.audioContextInitialized = true; widgetLog("Audio ctx resumed (silence)."); }).catch(err => widgetLog(`Ctx resume err (silence): ${err.message}`, 'error'));}
    } catch (e) { widgetLog(`Play silence err: ${e.message}`, 'error'); }
  }

  function initWidget() {
    if (!ASSISTANT_ID) { widgetLog("Assistant ID missing!", 'error'); alert('WellcomeAI: Assistant ID missing.'); return; }

    const widgetContainer = document.getElementById('wellcomeai-widget-container');
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    const widgetClose = document.getElementById('wellcomeai-widget-close');
    const mainCircle = document.getElementById('wellcomeai-main-circle');
    const audioBars = document.getElementById('wellcomeai-audio-bars');
    const loaderModal = document.getElementById('wellcomeai-loader-modal');
    const messageDisplay = document.getElementById('wellcomeai-message-display');
    const connectionErrorEl = document.getElementById('wellcomeai-connection-error');
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
    
    if (!widgetButton||!widgetClose||!mainCircle||!audioBars||!loaderModal||!messageDisplay||!connectionErrorEl) { widgetLog("UI elements missing!", 'error'); return; }
    
    widgetButton.style.opacity = '1'; widgetButton.style.visibility = 'visible'; widgetButton.style.pointerEvents = 'auto';
    
    let audioChunksBuffer = []; let audioPlaybackQueue = []; let isPlayingAudio = false;
    let hasAudioData = false; let audioDataStartTime = 0; let minimumAudioLength = 300;
    let isListening = false; let websocket = null; let audioContext = null;
    let mediaStream = null; let audioProcessor = null; let isConnected = false;
    let isWidgetOpen = false; let connectionFailedPermanently = false;
    let currentPingInterval = null; let lastPingTime = Date.now();
    let connectionTimeoutTimer = null; 
    
    let currentResponseId = null; let samplesPlayedSoFar = 0; let audioSamplesExpected = 0;
    let soundDetectionCounter = 0; let lastInterruptionTime = 0;
    
    let lastPlaybackStartTime = 0; let isInEchoSuppressionPeriod = false;
    let gainNode = null; let debugDetectionCounter = 0; let lastDetectionLog = 0;
    
    const AUDIO_CONFIG = { silenceThreshold: 0.01, silenceDuration: 300, bufferCheckInterval: 50, soundDetectionThreshold: 0.02 };
    const MOBILE_AUDIO_CONFIG = { silenceThreshold: 0.015, silenceDuration: 500, bufferCheckInterval: 100, soundDetectionThreshold: 0.015 };
    const INTERRUPTION_CONFIG = { soundDetectionThreshold: isIOS ? 0.01 : (isMobile ? 0.015 : 0.02), consecutiveDetections: isIOS ? 3 : (isMobile ? 3 : 2), minimumInterruptionGap: 500, gainReductionDuringPlayback: 0.3, echoSuppressionTime: 300, forceStopThreshold: 0.05 };
    const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;
    
    const ACTUAL_AUDIO_SAMPLE_RATE = 24000;

    // ИСПРАВЛЕНИЕ 1 (sendCancel): Убираем item_id и sample_count из response.cancel,
    // отправляем truncate и clear более осторожно.
    function sendCancel(itemId = null, sampleCount = 0, wasPlayingAudio = false) {
      interruptionDiag.log('send_cancel_start', { itemId, sampleCount, wsState: websocket?.readyState, wasPlayingAudio });
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        const timestamp = Date.now();
        
        // 1. Основная команда отмены - без item_id и sample_count, как показала практика
        const cancelPayload = { type: "response.cancel", event_id: `cancel_${timestamp}` };
        websocket.send(JSON.stringify(cancelPayload));
        widgetLog(`[INTERRUPTION] Sent response.cancel (generic)`);
        interruptionDiag.log('command_sent_response.cancel_generic', { payload: cancelPayload });
        
        // 2. Очистка буфера вывода аудио - отправляем только если ассистент говорил
        // и избегаем отправки, если это просто закрытие виджета без активного ответа
        if (wasPlayingAudio) {
            setTimeout(() => {
              if (websocket && websocket.readyState === WebSocket.OPEN) {
                const clearOutputPayload = { type: "output_audio_buffer.clear", event_id: `clear_output_${timestamp}_${Math.random().toString(36).substring(2,7)}`};
                websocket.send(JSON.stringify(clearOutputPayload));
                widgetLog(`[INTERRUPTION] Sent output_audio_buffer.clear (was playing)`);
                interruptionDiag.log('command_sent_output_audio_buffer.clear', { payload: clearOutputPayload });
              }
            }, 150); // Немного увеличена задержка
        } else {
            widgetLog(`[INTERRUPTION] Skipped output_audio_buffer.clear (was not playing or no active response)`);
            interruptionDiag.log('skipped_output_audio_buffer.clear', { wasPlayingAudio });
        }
        
        // 3. Обрезка элемента диалога - только если есть itemId и sampleCount
        if (itemId && sampleCount > 0) {
          setTimeout(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
              const audioEndMs = Math.floor((sampleCount / ACTUAL_AUDIO_SAMPLE_RATE) * 1000);
              const truncatePayload = { type: "conversation.item.truncate", event_id: `truncate_${timestamp}_${Math.random().toString(36).substring(2,7)}`, item_id: itemId, content_index: 0, audio_end_ms: audioEndMs };
              websocket.send(JSON.stringify(truncatePayload));
              widgetLog(`[INTERRUPTION] Sent conversation.item.truncate: itemId=${itemId}, audio_end_ms=${audioEndMs}`);
              interruptionDiag.log('command_sent_conversation.item.truncate', { payload: truncatePayload });
            }
          }, 250); // Немного увеличена задержка
        } else {
            const reason = !itemId ? "no itemId" : "sampleCount is 0";
            widgetLog(`[INTERRUPTION] Skipped conversation.item.truncate (${reason})`);
            interruptionDiag.log('skipped_truncate', {itemId, sampleCount, reason});
        }
        interruptionDiag.log('send_cancel_sequence_initiated', { itemId, sampleCount });
      } else {
        interruptionDiag.log('send_cancel_failed_not_connected', { itemId, sampleCount, wsState: websocket?.readyState });
      }
    }
    
    function immediateStopAllPlayback() { /* ... (без изменений, как в v1.4.2) ... */ 
        widgetLog('[INTERRUPTION] Immediate stop all playback.');
        interruptionDiag.log('immediate_stop_all_playback_called');
        document.querySelectorAll('audio[data-wellcome-audio="true"]').forEach(audio => { try { audio.pause(); audio.currentTime = 0; if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src); audio.src = ''; audio.load(); audio.remove(); } catch (e) { widgetLog(`Error stopping audio: ${e.message}`, 'warn'); } });
        audioPlaybackQueue = []; audioChunksBuffer = []; isPlayingAudio = false;
        mainCircle.classList.remove('speaking');
    }
    
    function forceResetState() { /* ... (без изменений, как в v1.4.2, но с audioSamplesExpected) ... */ 
        widgetLog('[INTERRUPTION] Force reset state.');
        interruptionDiag.log('force_reset_state_called', { oldResponseId: currentResponseId, oldSamplesPlayed: samplesPlayedSoFar, oldSamplesExpected: audioSamplesExpected });
        currentResponseId = null; samplesPlayedSoFar = 0; audioSamplesExpected = 0;
        soundDetectionCounter = 0; lastPlaybackStartTime = 0; isInEchoSuppressionPeriod = false;
        mainCircle.classList.remove('speaking', 'interrupted');
    }
    
    function showInterruptionFeedback() { /* ... (без изменений, как в v1.4.2) ... */ mainCircle.classList.add('interrupted'); setTimeout(() => mainCircle.classList.remove('interrupted'), 200); }
    function updateConnectionStatus(status, message) { /* ... (без изменений, как в v1.4.2) ... */ if (!statusIndicator || !statusDot || !statusText) return; statusText.textContent = message || status; statusDot.classList.remove('connected', 'disconnected', 'connecting'); if (status === 'connected') statusDot.classList.add('connected'); else if (status === 'disconnected') statusDot.classList.add('disconnected'); else statusDot.classList.add('connecting'); statusIndicator.classList.add('show'); setTimeout(() => statusIndicator.classList.remove('show'), 3000); }
    function createAudioBars(count = 20) { /* ... (без изменений, как в v1.4.2) ... */ audioBars.innerHTML = ''; for (let i = 0; i < count; i++) { const bar = document.createElement('div'); bar.className = 'wellcomeai-audio-bar'; audioBars.appendChild(bar); } }
    createAudioBars();
    
    function stopAllAudioProcessing() {
      widgetLog('[INTERRUPTION] Stopping all audio processing.');
      const wasPlaying = isPlayingAudio; // Запоминаем, играло ли аудио
      isListening = false; immediateStopAllPlayback(); hasAudioData = false; audioDataStartTime = 0;
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_stop_all_${Date.now()}`}));
        // Передаем `wasPlaying` в sendCancel
        sendCancel(currentResponseId, samplesPlayedSoFar, wasPlaying); 
      }
      forceResetState(); // Сбрасываем ID и счетчики после отправки команд
      resetAudioVisualization();
    }
    
    function showMessage(message, duration = 5000) { /* ... (без изменений, как в v1.4.2) ... */ messageDisplay.textContent = message; messageDisplay.classList.add('show'); if (duration > 0) setTimeout(() => messageDisplay.classList.remove('show'), duration); }
    function hideMessage() { /* ... (без изменений, как в v1.4.2) ... */ messageDisplay.classList.remove('show'); }
    function showConnectionError(message) { /* ... (без изменений, как в v1.4.2, но с уникальным ID для кнопки retry) ... */
        if (connectionErrorEl) { connectionErrorEl.innerHTML = `${message || 'Ошибка соединения с сервером'}<button class="wellcomeai-retry-button" id="wellcomeai-retry-button-inner">Повторить</button>`; connectionErrorEl.classList.add('visible'); const newRetryButton = connectionErrorEl.querySelector('#wellcomeai-retry-button-inner'); if (newRetryButton) newRetryButton.onclick = () => resetConnection(); } // Используем onclick для простоты
    }
    function hideConnectionError() { /* ... (без изменений, как в v1.4.2) ... */ if (connectionErrorEl) connectionErrorEl.classList.remove('visible'); }
    function resetConnection() { /* ... (без изменений, как в v1.4.2) ... */ reconnectAttempts = 0; connectionFailedPermanently = false; hideConnectionError(); showMessage("Попытка подключения..."); updateConnectionStatus('connecting', 'Подключение...'); connectWebSocket(); }
    
    function openWidget() { /* ... (без изменений, как в v1.4.2, но onclick для iosAudioButton) ... */
        widgetLog("Opening widget"); widgetContainer.style.zIndex = "2147483647"; widgetButton.style.zIndex = "2147483647";
        widgetContainer.classList.add('active'); isWidgetOpen = true;
        const expandedWidget = document.getElementById('wellcomeai-widget-expanded'); if (expandedWidget) { expandedWidget.style.opacity = "1"; expandedWidget.style.height = "400px"; expandedWidget.style.pointerEvents = "all"; expandedWidget.style.zIndex = "2147483647"; }
        if (isIOS) { if (iosAudioButton && (!window.audioContextInitialized || !window.hasPlayedSilence)) { iosAudioButton.classList.add('visible'); iosAudioButton.onclick = () => { unlockAudioOnIOS().then(success => { if (success) { iosAudioButton.classList.remove('visible'); setTimeout(() => { if (isConnected && !isListening && !isPlayingAudio) startListening(); }, 500);}});};} if (!window.hasPlayedSilence) unlockAudioOnIOS();
        } else if (isMobile && !window.audioContextInitialized) { try { if (!window.tempAudioContext) window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)(); window.audioContextInitialized = true; widgetLog("Mobile audio context initialized"); } catch (e) { widgetLog(`Failed to init mobile audio ctx: ${e.message}`, "error"); }}
        if (connectionFailedPermanently) { showConnectionError('Не удалось подключиться. Нажмите "Повторить".'); return; }
        if (isConnected && !isReconnecting) { if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) showMessage("Нажмите кнопку ниже для активации голосового помощника", 0); else { isListening = false; startListening(); } updateConnectionStatus('connected', 'Подключено');
        } else if (!isConnected && !isReconnecting) connectWebSocket();
        else { widgetLog(`Cannot start listening: conn=${isConnected}, listen=${isListening}, play=${isPlayingAudio}, reconn=${isReconnecting}`); if (isReconnecting) updateConnectionStatus('connecting', 'Переподключение...'); }
        widgetButton.classList.remove('wellcomeai-pulse-animation');
    }
    
    function closeWidget() { /* ... (без изменений, как в v1.4.2) ... */
        widgetLog("Closing widget"); stopAllAudioProcessing(); widgetContainer.classList.remove('active'); isWidgetOpen = false;
        hideMessage(); hideConnectionError(); if (statusIndicator) statusIndicator.classList.remove('show');
        if (iosAudioButton) iosAudioButton.classList.remove('visible');
        const expandedWidget = document.getElementById('wellcomeai-widget-expanded'); if (expandedWidget) { expandedWidget.style.opacity = "0"; expandedWidget.style.height = "0"; expandedWidget.style.pointerEvents = "none"; }
    }
    
    async function initAudio() { /* ... (без изменений, как в v1.4.2, но с ACTUAL_AUDIO_SAMPLE_RATE) ... */
        try {
            widgetLog("Запрос разрешения на доступ к микрофону...");
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Ваш браузер не поддерживает доступ к микрофону");
            const audioConstraints = isIOS ? { echoCancellation: true, noiseSuppression: true, autoGainControl: false } : isMobile ? { echoCancellation: true, noiseSuppression: true, autoGainControl: false, sampleRate: 16000 } : { echoCancellation: true, noiseSuppression: true, autoGainControl: false, sampleRate: ACTUAL_AUDIO_SAMPLE_RATE };
            if (isIOS) await unlockAudioOnIOS();
            try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints }); widgetLog(`Доступ к микрофону получен.`); }
            catch (micError) { widgetLog(`Ошибка доступа к микрофону: ${micError.name} - ${micError.message}`, 'error'); if (isIOS) { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } }); widgetLog('Доступ к микрофону iOS (fallback).'); } else throw micError; }
            let contextSampleRate = ACTUAL_AUDIO_SAMPLE_RATE; if (isIOS || isMobile) contextSampleRate = 16000;
            if (isIOS) { if (window.tempAudioContext && window.tempAudioContext.sampleRate === contextSampleRate) audioContext = window.tempAudioContext; else { if(window.tempAudioContext) try { await window.tempAudioContext.close(); } catch(e){} audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: contextSampleRate }); window.tempAudioContext = audioContext; } if (audioContext.state === 'suspended') { await audioContext.resume(); } window.audioContextInitialized = true;
            } else { audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: contextSampleRate }); }
            widgetLog(`AudioContext создан с частотой ${audioContext.sampleRate} Гц (запрошено ${contextSampleRate}Hz)`);
            const bufferSize = isIOS ? 2048 : (isMobile ? 1024 : (audioContext.sampleRate === 16000 ? 1024 : 2048) );
            if (audioContext.createScriptProcessor) audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1); else if (audioContext.createJavaScriptNode) audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1); else throw new Error("Ваш браузер не поддерживает ScriptProcessorNode/JavaScriptNode");
            let isSilent = true; let silenceStartTime = Date.now(); let lastCommitTime = 0; let hasSentAudioInCurrentSegment = false;
            audioProcessor.onaudioprocess = function(e) {
              if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
                const inputBuffer = e.inputBuffer; let inputData = inputBuffer.getChannelData(0); if (inputData.length === 0) return;
                let maxAmplitude = 0; for (let i = 0; i < inputData.length; i++) maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
                const now = Date.now(); isInEchoSuppressionPeriod = (now - lastPlaybackStartTime) < INTERRUPTION_CONFIG.echoSuppressionTime;
                let effectiveThreshold = INTERRUPTION_CONFIG.soundDetectionThreshold;
                if (isPlayingAudio || isInEchoSuppressionPeriod) { effectiveThreshold = INTERRUPTION_CONFIG.soundDetectionThreshold * 2; if (gainNode) gainNode.gain.value = INTERRUPTION_CONFIG.gainReductionDuringPlayback; } else { if (gainNode) gainNode.gain.value = 1.0; }
                const hasSound = maxAmplitude > effectiveThreshold;
                debugDetectionCounter++; if (DEBUG_MODE && debugDetectionCounter % 20 === 0 && now - lastDetectionLog > 500) { widgetLog(`[AUD PROC DEBUG] isPlaying:${isPlayingAudio}, maxAmp:${maxAmplitude.toFixed(4)}, thr:${effectiveThreshold.toFixed(4)}, hasSound:${hasSound}, echoSupp:${isInEchoSuppressionPeriod}, listen:${isListening}`); lastDetectionLog = now; }
                if (isPlayingAudio && hasSound) {
                  interruptionDiag.log('sound_detected_during_playback', { amplitude: maxAmplitude.toFixed(4), threshold: effectiveThreshold.toFixed(4), soundCounter: soundDetectionCounter, currentResponseId, samplesPlayed: samplesPlayedSoFar, isInEchoSuppression: isInEchoSuppressionPeriod });
                  if (now - lastInterruptionTime > INTERRUPTION_CONFIG.minimumInterruptionGap) {
                    soundDetectionCounter++; widgetLog(`[INTERRUPTION] Звук детектирован! Counter: ${soundDetectionCounter}/${INTERRUPTION_CONFIG.consecutiveDetections}, амплитуда: ${maxAmplitude.toFixed(4)}`);
                    if (soundDetectionCounter >= INTERRUPTION_CONFIG.consecutiveDetections) {
                      widgetLog(`[INTERRUPTION] ДЕТЕКТИРОВАНА РЕЧЬ ПОЛЬЗОВАТЕЛЯ!`); interruptionDiag.log('interruption_triggered', { responseId: currentResponseId, samplesPlayed: samplesPlayedSoFar, timeSinceLastInterruption: now - lastInterruptionTime, amplitude: maxAmplitude.toFixed(4) });
                      const كانيللعب = isPlayingAudio; // Запоминаем, играло ли аудио перед остановкой
                      immediateStopAllPlayback(); showInterruptionFeedback();
                      sendCancel(currentResponseId, samplesPlayedSoFar, كانيللعب); // Передаем флаг
                      lastInterruptionTime = now; forceResetState(); soundDetectionCounter = 0;
                      if (websocket && websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_interrupt_${Date.now()}` }));
                      hasAudioData = true; audioDataStartTime = Date.now();
                    }
                  }
                } else if (soundDetectionCounter > 0) soundDetectionCounter = 0;
                updateAudioVisualization(inputData); const pcm16Data = new Int16Array(inputData.length); for (let i = 0; i < inputData.length; i++) pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32767)));
                try { websocket.send(JSON.stringify({ type: "input_audio_buffer.append", event_id: `audio_${Date.now()}`, audio: arrayBufferToBase64(pcm16Data.buffer) })); hasSentAudioInCurrentSegment = true; if (!hasAudioData && hasSound && !isInEchoSuppressionPeriod) { hasAudioData = true; audioDataStartTime = Date.now(); } } catch (error) { widgetLog(`Ошибка отправки аудио: ${error.message}`, "error"); }
                if (hasSound && !isInEchoSuppressionPeriod) { isSilent = false; silenceStartTime = now; if (!mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking')) mainCircle.classList.add('listening');
                } else if (!isSilent) { const silenceDuration = now - silenceStartTime; const effectiveSilenceDuration = isIOS ? 800 : effectiveAudioConfig.silenceDuration; if (silenceDuration > effectiveSilenceDuration) { isSilent = true; if (now - lastCommitTime > 1000 && hasSentAudioInCurrentSegment) { const iosDelay = isIOS ? 300 : 100; setTimeout(() => { if (isSilent && isListening && !isReconnecting) { commitAudioBuffer(); lastCommitTime = Date.now(); hasSentAudioInCurrentSegment = false; } }, iosDelay); } } }
              }
            };
            const streamSource = audioContext.createMediaStreamSource(mediaStream); gainNode = audioContext.createGain(); gainNode.gain.value = 1.0; streamSource.connect(gainNode); gainNode.connect(audioProcessor); const dummyGain = audioContext.createGain(); dummyGain.gain.value = 0; audioProcessor.connect(dummyGain); dummyGain.connect(audioContext.destination);
            widgetLog("Аудио инициализировано."); return true;
        } catch (error) { widgetLog(`Ошибка инициализации аудио: ${error.name} - ${error.message}`, "error"); if (isIOS && iosAudioButton) { iosAudioButton.classList.add('visible'); showMessage("Нажмите кнопку для активации микрофона", 0); } else showMessage("Ошибка доступа к микрофону. Проверьте настройки."); return false; }
    }
    
    async function startListening() { /* ... (без изменений, как в v1.4.2) ... */ 
        if (!isConnected || isReconnecting) { widgetLog(`Cannot start listening: connected=${isConnected}, reconnecting=${isReconnecting}`); return; }
        if (isListening) { widgetLog('[INTERRUPTION] isListening was true, resetting.'); isListening = false; await new Promise(resolve => setTimeout(resolve, 100)); }
        if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) await forceIOSAudioUnlock();
        isListening = true; widgetLog('[INTERRUPTION] Starting listening.');
        if (websocket && websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_start_${Date.now()}` }));
        if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) { await unlockAudioOnIOS(); if (!window.audioContextInitialized) { if (iosAudioButton) iosAudioButton.classList.add('visible'); showMessage("Нажмите для активации микрофона", 0); isListening = false; return; } }
        if (!audioContext) { const success = await initAudio(); if (!success) { widgetLog('Failed to init audio.', 'error'); isListening = false; return; } }
        else if (audioContext.state === 'suspended') { try { await audioContext.resume(); widgetLog('AudioContext resumed.'); } catch (error) { widgetLog(`Failed to resume AudioContext: ${error}`, 'error'); isListening = false; if (isIOS && iosAudioButton) { iosAudioButton.classList.add('visible'); showMessage("Нажмите для активации микрофона", 0); } return; } }
        hasAudioData = false; audioDataStartTime = 0;
        if (!isPlayingAudio) { mainCircle.classList.add('listening'); mainCircle.classList.remove('speaking'); }
    }
    
    function commitAudioBuffer() { /* ... (без изменений, как в v1.4.2) ... */ 
        if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) return;
        if (!hasAudioData) { widgetLog("Not sending empty audio buffer.", "warn"); return; }
        const audioLength = Date.now() - audioDataStartTime;
        if (audioLength < minimumAudioLength) { widgetLog(`Audio buffer too short (${audioLength}ms), waiting.`, "warn"); const extraDelay = isMobile ? 200 : 50; setTimeout(() => { if (isListening && hasAudioData && !isReconnecting) { widgetLog(`Sending buffer after extra wait (${Date.now() - audioDataStartTime}ms)`); sendCommitBuffer(); } }, minimumAudioLength - audioLength + extraDelay); return; }
        sendCommitBuffer();
    }
    function sendCommitBuffer() { /* ... (без изменений, как в v1.4.2) ... */
        widgetLog("Sending audio buffer commit."); const audioLength = Date.now() - audioDataStartTime;
        if (audioLength < 100) { widgetLog(`Buffer < 100ms, not sending.`, "warn"); hasAudioData = false; audioDataStartTime = 0; return; }
        if (isMobile) setTimeout(() => mainCircle.classList.remove('listening'), 100); else mainCircle.classList.remove('listening');
        websocket.send(JSON.stringify({ type: "input_audio_buffer.commit", event_id: `commit_${Date.now()}` }));
        if (isMobile && loaderModal) { loaderModal.classList.add('active'); setTimeout(() => loaderModal.classList.remove('active'), 1000); }
        hasAudioData = false; audioDataStartTime = 0;
    }
    
    function arrayBufferToBase64(buffer) { /* ... (без изменений, как в v1.4.2) ... */ const bytes = new Uint8Array(buffer); let binary = ''; for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); }
    function base64ToArrayBuffer(base64) { /* ... (без изменений, как в v1.4.2) ... */ try { const bs = atob(base64); const b = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) b[i] = bs.charCodeAt(i); return b.buffer; } catch (e) { widgetLog(`Base64 to ArrayBuffer error: ${e.message}`, "error"); return new ArrayBuffer(0); } }
    function updateAudioVisualization(audioData) { /* ... (без изменений, как в v1.4.2) ... */ const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar'); const step = Math.floor(audioData.length / bars.length); for (let i = 0; i < bars.length; i++) { let sum = 0; for (let j = 0; j < step; j++) { const index = i * step + j; if (index < audioData.length) sum += Math.abs(audioData[index]); } const average = sum / step; const multiplier = isMobile ? 150 : 100; const height = 2 + Math.min(28, Math.floor(average * multiplier)); bars[i].style.height = `${height}px`; } }
    function resetAudioVisualization() { /* ... (без изменений, как в v1.4.2) ... */ const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar'); bars.forEach(bar => bar.style.height = '2px'); }
    function createWavFromPcm(pcmBuffer, sampleRate = ACTUAL_AUDIO_SAMPLE_RATE) { /* ... (без изменений, как в v1.4.2) ... */
      const wavHeader = new ArrayBuffer(44); const view = new DataView(wavHeader);
      view.setUint8(0, 'R'.charCodeAt(0)); view.setUint8(1, 'I'.charCodeAt(0)); view.setUint8(2, 'F'.charCodeAt(0)); view.setUint8(3, 'F'.charCodeAt(0)); view.setUint32(4, 36 + pcmBuffer.byteLength, true); view.setUint8(8, 'W'.charCodeAt(0)); view.setUint8(9, 'A'.charCodeAt(0)); view.setUint8(10, 'V'.charCodeAt(0)); view.setUint8(11, 'E'.charCodeAt(0)); view.setUint8(12, 'f'.charCodeAt(0)); view.setUint8(13, 'm'.charCodeAt(0)); view.setUint8(14, 't'.charCodeAt(0)); view.setUint8(15, ' '.charCodeAt(0)); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint8(36, 'd'.charCodeAt(0)); view.setUint8(37, 'a'.charCodeAt(0)); view.setUint8(38, 't'.charCodeAt(0)); view.setUint8(39, 'a'.charCodeAt(0)); view.setUint32(40, pcmBuffer.byteLength, true);
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength); const wavBytes = new Uint8Array(wavBuffer); wavBytes.set(new Uint8Array(wavHeader), 0); wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength); return wavBuffer;
    }
    
    // ИСПРАВЛЕНИЕ 2 (playNextAudio): Улучшенное управление currentResponseId
    function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        const wasPlayingAudioBeforeReset = isPlayingAudio; // Фиксируем состояние
        isPlayingAudio = false; mainCircle.classList.remove('speaking');
        const oldResponseIdForLog = currentResponseId; 
        if (wasPlayingAudioBeforeReset || currentResponseId) { // Сбрасываем только если что-то было активно
            forceResetState(); 
            interruptionDiag.log('audio_queue_empty_state_reset', { afterResponseId: oldResponseIdForLog, wasPlaying: wasPlayingAudioBeforeReset });
        }
        if (!isWidgetOpen) widgetButton.classList.add('wellcomeai-pulse-animation');
        if (isWidgetOpen && isConnected && !isReconnecting) { widgetLog('[PLAYBACK] Audio queue empty, restarting listening.'); setTimeout(() => { isListening = false; startListening(); }, 300); }
        return;
      }
      isPlayingAudio = true; lastPlaybackStartTime = Date.now();
      mainCircle.classList.add('speaking'); mainCircle.classList.remove('listening');
      const audioBase64 = audioPlaybackQueue.shift();
      try {
        const audioData = base64ToArrayBuffer(audioBase64); if (audioData.byteLength === 0) { playNextAudio(); return; }
        const wavBuffer = createWavFromPcm(audioData, ACTUAL_AUDIO_SAMPLE_RATE); 
        const blob = new Blob([wavBuffer], { type: 'audio/wav' }); const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(); audio.setAttribute('data-wellcome-audio', 'true');
        audio.src = audioUrl; audio.volume = 0.7; audio.preload = 'auto';
        let startTime = null; const sampleRate = ACTUAL_AUDIO_SAMPLE_RATE;
        const totalSamplesInChunk = audioData.byteLength / 2; let samplesPlayedInThisChunk = 0;
        const initialSamplesPlayedSoFar = samplesPlayedSoFar;
        const chunkResponseId = currentResponseId; // Захватываем ID для этого чанка

        audio.ontimeupdate = function() {
          if (startTime && chunkResponseId) { // Используем захваченный ID
            const currentTime = audio.currentTime; const currentPlayedInChunk = Math.floor(currentTime * sampleRate);
            // Обновляем samplesPlayedSoFar только если ID текущего ответа совпадает с ID этого чанка
            if(currentResponseId === chunkResponseId) {
                samplesPlayedSoFar = initialSamplesPlayedSoFar + currentPlayedInChunk;
            }
            samplesPlayedInThisChunk = currentPlayedInChunk;
            if (DEBUG_MODE && Math.floor(currentTime * 2) % 1 === 0) { widgetLog(`[PLAYBACK] ${chunkResponseId}: ${samplesPlayedSoFar} s (chunk: ${samplesPlayedInThisChunk}/${totalSamplesInChunk}) of ${audioSamplesExpected || '?'}`); interruptionDiag.log('audio_playback_progress', { responseId: chunkResponseId, samplesPlayedSoFar, samplesInChunk: samplesPlayedInThisChunk, totalSamplesInChunk, expectedTotal: audioSamplesExpected, currentTime: currentTime.toFixed(2) }); }
          }
        };
        audio.onplay = function() { startTime = Date.now(); widgetLog(`[PLAYBACK] Start chunk: ${totalSamplesInChunk}s. RespID: ${chunkResponseId || 'N/A'}`); interruptionDiag.log('audio_chunk_play_started', { responseId: chunkResponseId, totalSamplesInChunk, samplesPlayedSoFar_before_chunk: initialSamplesPlayedSoFar }); };
        audio.onended = function() {
          widgetLog(`[PLAYBACK] End chunk. RespID: ${chunkResponseId || 'N/A'}`);
          if (chunkResponseId && currentResponseId === chunkResponseId) { // Обновляем, только если ID не изменился
             samplesPlayedSoFar = initialSamplesPlayedSoFar + totalSamplesInChunk;
          }
          interruptionDiag.log('audio_chunk_play_ended', { responseId: chunkResponseId, samplesPlayedSoFar_after_chunk: samplesPlayedSoFar, totalSamplesInChunk });
          URL.revokeObjectURL(audioUrl); playNextAudio();
        };
        audio.onerror = function(e) { widgetLog(`Audio playback error: ${e.target.error?.message || 'Unknown'}`, 'error'); interruptionDiag.log('audio_playback_error', { responseId: chunkResponseId, error: e.target.error?.message || 'Unknown' }); URL.revokeObjectURL(audioUrl); playNextAudio(); };
        const playPromise = audio.play();
        if (playPromise) playPromise.catch(error => { widgetLog(`Audio play() error: ${error.message}`, "error"); interruptionDiag.log('audio_play_promise_error', { responseId: chunkResponseId, error: error.message }); if (audioUrl) URL.revokeObjectURL(audioUrl); playNextAudio(); });
      } catch (error) { widgetLog(`General playNextAudio error: ${error.message}`, "error"); interruptionDiag.log('playNextAudio_general_error', { responseId: currentResponseId, error: error.message }); playNextAudio(); }
    }
    
    function addAudioToPlaybackQueue(audioBase64) { /* ... (без изменений, как в v1.4.2) ... */ if (!audioBase64 || typeof audioBase64 !== 'string') return; audioPlaybackQueue.push(audioBase64); if (!isPlayingAudio) playNextAudio(); }
    function reconnectWithDelay(initialDelay = 0) { /* ... (без изменений, как в v1.4.2) ... */
        const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
        if (reconnectAttempts >= maxAttempts) { widgetLog('Max reconnect attempts.'); isReconnecting = false; connectionFailedPermanently = true; if (isWidgetOpen) { showConnectionError("Не удалось восстановить. Попробуйте перезагрузить."); updateConnectionStatus('disconnected', 'Отключено'); } else widgetButton.classList.add('wellcomeai-pulse-animation'); return; }
        isReconnecting = true; if (isWidgetOpen) { showMessage("Соединение прервано. Переподключение...", 0); updateConnectionStatus('connecting', 'Переподключение...'); }
        const delay = initialDelay > 0 ? initialDelay : isMobile ? Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) : Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
        reconnectAttempts++; widgetLog(`Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${maxAttempts})`);
        setTimeout(() => { if (isReconnecting) { connectWebSocket().then(success => { if (success) { reconnectAttempts = 0; isReconnecting = false; if (isWidgetOpen) { showMessage("Соединение восстановлено", 3000); updateConnectionStatus('connected', 'Подключено'); setTimeout(() => { if (isWidgetOpen && !isListening) { if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) { if (iosAudioButton) iosAudioButton.classList.add('visible'); showMessage("Нажмите для активации микрофона", 0); } else startListening(); } }, 1000);}} else isReconnecting = false; }).catch(() => isReconnecting = false); } }, delay);
    }
    
    async function connectWebSocket() { /* ... (без изменений, как в v1.4.2, кроме websocket.onmessage) ... */
      try {
        loaderModal.classList.add('active'); widgetLog("Подключение..."); isReconnecting = true; hideConnectionError();
        if (!ASSISTANT_ID) { widgetLog('Assistant ID not found!', 'error'); showMessage("Ошибка: ID ассистента не найден."); loaderModal.classList.remove('active'); return false; }
        widgetLog(`Connecting to: ${WS_URL}`);
        if (websocket) try { websocket.close(); } catch (e) {}
        if (currentPingInterval) { clearInterval(currentPingInterval); currentPingInterval = null; }
        if (connectionTimeoutTimer) clearTimeout(connectionTimeoutTimer);
        websocket = new WebSocket(WS_URL); websocket.binaryType = 'arraybuffer';
        connectionTimeoutTimer = setTimeout(() => { /* ... (логика таймаута без изменений) ... */
            widgetLog("Таймаут соединения", "error"); if (websocket) websocket.close(); isReconnecting = false; loaderModal.classList.remove('active');
            reconnectAttempts++; const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
            if (reconnectAttempts >= maxAttempts) { connectionFailedPermanently = true; if (isWidgetOpen) { showConnectionError("Не удалось подключиться. Попробуйте позже."); updateConnectionStatus('disconnected', 'Отключено'); } else widgetButton.classList.add('wellcomeai-pulse-animation'); }
            else { const delay = isMobile ? Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) : Math.min(30000, Math.pow(2, reconnectAttempts) * 1000); widgetLog(`Переподключение через ${delay/1000}с (${reconnectAttempts}/${maxAttempts})`); if (isWidgetOpen) { showMessage(`Таймаут. Повтор через ${Math.round(delay/1000)}с...`); updateConnectionStatus('connecting', 'Переподключение...'); } setTimeout(() => connectWebSocket(), delay); }
        }, CONNECTION_TIMEOUT);
        websocket.onopen = function() { /* ... (логика onopen без изменений) ... */
            clearTimeout(connectionTimeoutTimer); widgetLog('WebSocket подключен'); isConnected = true; isReconnecting = false;
            reconnectAttempts = 0; connectionFailedPermanently = false; loaderModal.classList.remove('active');
            lastPingTime = Date.now(); lastPongTime = Date.now();
            const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
            currentPingInterval = setInterval(() => { if (websocket && websocket.readyState === WebSocket.OPEN) { try { websocket.send(JSON.stringify({ type: "ping" })); lastPingTime = Date.now(); if (Date.now() - lastPongTime > pingIntervalTime * 3) { widgetLog("Ping timeout", "warn"); clearInterval(currentPingInterval); websocket.close(); reconnectWithDelay(1000); } } catch (e) { widgetLog(`Ping error: ${e.message}`, "error"); }}}, pingIntervalTime);
            hideConnectionError(); if (isWidgetOpen) updateConnectionStatus('connected', 'Подключено');
            if (isWidgetOpen) { if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) { if (iosAudioButton) iosAudioButton.classList.add('visible'); showMessage("Нажмите для активации микрофона", 0); } else { isListening = false; startListening(); } }
        };
        
        // ОБНОВЛЕННЫЙ websocket.onmessage
        websocket.onmessage = function(event) {
          try {
            if (event.data instanceof Blob) return; if (!event.data) return;
            const data = JSON.parse(event.data); lastPongTime = Date.now();
            const msg_type = data.type;
            const veryFrequentMessagesForDiag = ['input_audio_buffer.append.ack', 'pong', 'response.audio_transcript.delta', 'conversation.item.input_audio_transcription.delta'];
            if (!veryFrequentMessagesForDiag.includes(msg_type)) interruptionDiag.log('websocket_message_received', { type: msg_type, data: (msg_type === 'audio' || msg_type === 'response.audio.delta') ? {type:msg_type, len: data.delta?.length || data.data?.length, item_id: data.item_id} : data });
            
            if (msg_type === 'response.created') { if (currentResponseId) interruptionDiag.log('response_created_while_active', { oldId: currentResponseId, newId: data.response?.id }); currentResponseId = data.response?.id; samplesPlayedSoFar = 0; audioSamplesExpected = 0; widgetLog(`[INTERRUPTION] New response (created): ${currentResponseId}`); }
            if (msg_type === 'response.output_item.added') { if (!currentResponseId && data.item?.id) { currentResponseId = data.item.id; samplesPlayedSoFar = 0; audioSamplesExpected = 0; widgetLog(`[INTERRUPTION] New response (item_added): ${currentResponseId}`); } }
            if (msg_type === 'response.audio.delta') { if (data.delta && currentResponseId && (data.item_id === currentResponseId || !data.item_id ) ) { try { const chunk = base64ToArrayBuffer(data.delta); audioSamplesExpected += chunk.byteLength / 2; } catch (e) { widgetLog(`Err calc expected samples: ${e.message}`, 'warn'); interruptionDiag.log('error_calculating_expected_samples', { error: e.message, deltaLength: data.delta?.length }); } } }
            if (msg_type === 'response.done') { widgetLog(`[INTERRUPTION] Response done: ${currentResponseId || 'N/A'}`); /* ID сбрасывается позже */ }
            
            const frequentMessages = ['input_audio_buffer.append.ack', 'input_audio_buffer.clear.ack', 'input_audio_buffer.cleared', 'input_audio_buffer.commit.ack', 'input_audio_buffer.committed', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'conversation.item.created', 'conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed', 'response.created', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'rate_limits.updated', 'pong'];
            if (!frequentMessages.includes(msg_type) && !veryFrequentMessagesForDiag.includes(msg_type)) widgetLog(`Received (uncommon): ${msg_type}`);
            
            if (data.type === 'response.cancel.ack') { widgetLog(`[INTERRUPTION] Cancel ACK: success=${data.success}`); if (data.success) showMessage("Ответ прерван", 1000); return; }
            if (data.type === 'output_audio_buffer.clear.ack') { widgetLog(`[INTERRUPTION] Output buffer clear ACK: success=${data.success}`); interruptionDiag.log('output_audio_buffer_clear_ack_received', { success: data.success, eventId: data.event_id }); return; }
            if (data.type === 'conversation.item.truncate.ack') { widgetLog(`[INTERRUPTION] Truncate ACK: success=${data.success}`); interruptionDiag.log('truncate_ack_received', { success: data.success, eventId: data.event_id }); return; }
            if (data.type === 'session.created' || data.type === 'session.updated') return;
            if (data.type === 'connection_status') { if (data.status === 'connected') { isConnected = true; reconnectAttempts = 0; connectionFailedPermanently = false; hideConnectionError(); if (isWidgetOpen) { isListening = false; startListening(); } } return; }
            if (data.type === 'error') {
              // Игнорируем ошибку "Unknown parameter: 'item_id'" для response.cancel, т.к. мы перестали ее отправлять.
              // if (data.error?.message?.includes("Unknown parameter: 'item_id'") && data.error?.message?.toLowerCase().includes("response.cancel")) {
              //   widgetLog(`[INTERRUPTION] Server rejected item_id for cancel (expected). Ignoring.`, 'warn');
              //   return;
              // }
              if (data.error?.code === 'input_audio_buffer_commit_empty') { if (isWidgetOpen && !isReconnecting) setTimeout(() => { isListening = false; startListening(); }, 500); return; }
              if (data.error?.message?.includes('Cancellation failed')) { widgetLog(`[INTERRUPTION] Warn: Cancellation failed (no active resp?)`, 'warn'); return; }
              // Ошибка "Invalid value: 'out...ear'" теперь должна быть менее вероятной
              widgetLog(`Server error: ${data.error?.message || 'Unknown'}`, "error"); showMessage(data.error?.message || 'Ошибка на сервере', 5000); return;
            } 
            if (data.type === 'response.text.delta') { if (data.delta) { showMessage(data.delta, 0); if (!isWidgetOpen) widgetButton.classList.add('wellcomeai-pulse-animation'); } return; }
            if (data.type === 'response.text.done') { setTimeout(() => hideMessage(), 5000); return; }
            if (data.type === 'response.audio.delta') { if (data.delta) audioChunksBuffer.push(data.delta); return; }
            if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') return;
            if (data.type === 'response.audio.done') { if (audioChunksBuffer.length > 0) { const fullAudio = audioChunksBuffer.join(''); addAudioToPlaybackQueue(fullAudio); audioChunksBuffer = []; } return; }
            if (data.type === 'response.done') { if (isWidgetOpen && !isReconnecting) { if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) { if (iosAudioButton) iosAudioButton.classList.add('visible'); showMessage("Нажмите для активации микрофона", 0); } else setTimeout(() => { if(isConnected && !isReconnecting && !isListening /* Только если не слушает уже */) { isListening = false; startListening(); }}, 800); } return; }
            if (frequentMessages.includes(msg_type) || veryFrequentMessagesForDiag.includes(msg_type)) return;
            widgetLog(`Неизвестный тип сообщения: ${data.type}`, "warn");
          } catch (parseError) {
            if (event.data === 'pong') { lastPongTime = Date.now(); return; }
            widgetLog(`Ошибка парсинга JSON: ${parseError.message}`, "warn"); interruptionDiag.log('websocket_message_error', { error: parseError.message, data: event.data?.substring(0, 100) });
          }
        };
        
        websocket.onclose = function(event) { /* ... (логика onclose без изменений) ... */
            widgetLog(`WebSocket закрыт: ${event.code}, ${event.reason}`); isConnected = false; isListening = false;
            if (currentPingInterval) { clearInterval(currentPingInterval); currentPingInterval = null; }
            if (event.code === 1000 || event.code === 1001) { isReconnecting = false; widgetLog('Чистое закрытие WebSocket, не переподключаемся'); return; }
            reconnectWithDelay();
        };
        websocket.onerror = function(errorEvent) { /* ... (логика onerror без изменений) ... */
            widgetLog(`WebSocket ошибка: ${errorEvent.message || 'Unknown'}`, 'error'); if (isWidgetOpen) { showMessage("Ошибка соединения"); updateConnectionStatus('disconnected', 'Ошибка'); }
        };
        return true;
      } catch (error) { /* ... (логика catch без изменений) ... */
        widgetLog(`Ошибка подключения WebSocket: ${error}`, 'error'); isReconnecting = false; loaderModal.classList.remove('active');
        reconnectAttempts++; const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
        if (reconnectAttempts >= maxAttempts) { connectionFailedPermanently = true; if (isWidgetOpen) { showConnectionError("Не удалось подключиться. Попробуйте позже."); updateConnectionStatus('disconnected', 'Отключено'); } }
        else reconnectWithDelay(); return false;
      }
    }

    widgetButton.addEventListener('click', (e) => { /* ... (без изменений) ... */ widgetLog('Button clicked'); e.preventDefault(); e.stopPropagation(); openWidget(); });
    widgetClose.addEventListener('click', (e) => { /* ... (без изменений) ... */ widgetLog('Close button clicked'); e.preventDefault(); e.stopPropagation(); closeWidget(); });
    mainCircle.addEventListener('click', () => { /* ... (без изменений) ... */
        widgetLog(`Circle clicked: open=${isWidgetOpen}, listen=${isListening}, playing=${isPlayingAudio}, reconn=${isReconnecting}`);
        if (isIOS) { unlockAudioOnIOS().then(unlocked => { if (unlocked) { widgetLog('iOS audio unlocked by circle click'); if (iosAudioButton) iosAudioButton.classList.remove('visible'); if (isWidgetOpen && !isReconnecting) { if (isConnected) { isListening = false; startListening(); } else if (connectionFailedPermanently) showConnectionError("Нет соединения. Нажмите 'Повторить'."); else connectWebSocket(); } } });
        } else { if (isWidgetOpen && !isReconnecting) { if (isConnected) { isListening = false; startListening(); } else if (connectionFailedPermanently) showConnectionError("Нет соединения. Нажмите 'Повторить'."); else connectWebSocket(); } }
    });
    if (isIOS && iosAudioButton) { /* ... (без изменений, но с onclick) ... */
        iosAudioButton.onclick = () => { unlockAudioOnIOS().then(success => { if (success) { iosAudioButton.classList.remove('visible'); setTimeout(() => { if (isConnected && !isReconnecting) { isListening = false; startListening(); } }, 500); } else { forceIOSAudioUnlock().then(() => { iosAudioButton.classList.remove('visible'); setTimeout(() => { if (isConnected && !isReconnecting) { isListening = false; startListening(); } }, 500); }); } }); };
    }
    // Обработчик для кнопки retry уже добавляется в showConnectionError
    connectWebSocket();
    
    setTimeout(() => { /* ... (DOM check без изменений) ... */
      widgetLog('DOM check post-init');
      const wc=document.getElementById('wellcomeai-widget-container'), wb=document.getElementById('wellcomeai-widget-button');
      if(wc) widgetLog(`Container zIndex: ${getComputedStyle(wc).zIndex}`); else widgetLog('Container NOT FOUND!','error');
      if(wb) widgetLog(`Button visible: ${getComputedStyle(wb).display !== 'none'}`); else widgetLog('Button NOT FOUND!','error');
      widgetLog(`WS state: ${websocket?.readyState ?? 'No WS'}. Flags: conn=${isConnected}, listen=${isListening}, play=${isPlayingAudio}, reconn=${isReconnecting}, open=${isWidgetOpen}`);
      if (isMobile) { widgetLog(`Mobile audio: init=${window.audioContextInitialized}, playedSilence=${window.hasPlayedSilence}, ctxState=${audioContext?.state}, ctxRate=${audioContext?.sampleRate}`);}
      interruptionDiag.log('post_init_check', { isConnected, isListening, isPlayingAudio, currentResponseId, samplesPlayedSoFar, audioSamplesExpected });
    }, 2000);

    if (DEBUG_MODE) { /* ... (кнопка Diag без изменений) ... */
      function addDiagnosticButton() { const diagButton = document.createElement('button'); diagButton.textContent = 'Diag'; diagButton.style.cssText = `position:absolute;top:5px;right:35px;background:#ffc107;color:black;border:none;border-radius:3px;padding:2px 5px;font-size:9px;font-weight:bold;cursor:pointer;z-index:10000;`; diagButton.onclick = window.exportInterruptionLog; const widgetHeader = document.querySelector('.wellcomeai-widget-header'); if (widgetHeader) { widgetHeader.appendChild(diagButton); widgetLog("Diag button added."); } else widgetLog("Header not found for Diag button.", 'warn'); }
      setTimeout(addDiagnosticButton, 1500); 
    }
  } // End of initWidget

  function initializeWidget() {
    if (window.wellcomeAIWidgetInitialized && !DEBUG_MODE) { // В DEBUG_MODE разрешаем повторную инициализацию для отладки
        widgetLog('Widget script already initialized. Skipping in production.');
        return;
    }
    if(window.wellcomeAIWidgetInitialized && DEBUG_MODE){
        widgetLog('DEBUG: Widget script already initialized, but re-initializing due to DEBUG_MODE.');
        // Попытка очистить старые элементы, если они есть (может быть неполной)
        const oldContainer = document.getElementById('wellcomeai-widget-container');
        if(oldContainer) oldContainer.remove();
        const oldStyles = document.getElementById('wellcomeai-widget-styles');
        if(oldStyles) oldStyles.remove();
    }
    window.wellcomeAIWidgetInitialized = true;

    widgetLog('Initializing...');
    widgetLog(`Device type: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);
    loadFontAwesome();
    createStyles();
    createWidgetHTML();
    initWidget();
    widgetLog('Initialization complete - v1.4.3');
  }
  
  // Логика первоначальной загрузки
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWidget);
    widgetLog('Will initialize on DOMContentLoaded');
  } else {
    widgetLog('DOM already loaded, initializing immediately');
    initializeWidget();
  }
})();
