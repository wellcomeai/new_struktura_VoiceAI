/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.4.0 - с ИСПРАВЛЕННЫМ мгновенным прерыванием ассистента
 * 
 * ОСНОВНЫЕ ИСПРАВЛЕНИЯ:
 * - Снижены пороги детекции звука
 * - Исправлено отслеживание currentResponseId
 * - Улучшена логика детекции прерывания
 * - Добавлена RMS амплитуда для стабильной детекции
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
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  
  // Определяем тип устройства
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  
  // Глобальные флаги для мобильных устройств
  window.audioContextInitialized = false;
  window.tempAudioContext = null;
  window.hasPlayedSilence = false;

  // ДИАГНОСТИЧЕСКИЙ ИНСТРУМЕНТ ДЛЯ ОТЛАДКИ ПРЕРЫВАНИЙ
  class InterruptionDiagnostics {
    constructor() {
      this.events = [];
      this.maxEvents = 100;
      this.isEnabled = DEBUG_MODE;
    }
    
    log(event, data = {}) {
      if (!this.isEnabled) return;
      
      const timestamp = Date.now();
      const entry = {
        timestamp,
        time: new Date(timestamp).toISOString(),
        event,
        data: { ...data }
      };
      
      this.events.push(entry);
      if (this.events.length > this.maxEvents) {
        this.events.shift();
      }
      
      console.log(`[DIAG] ${entry.time} | ${event}:`, data);
    }
    
    getReport() {
      return {
        totalEvents: this.events.length,
        events: this.events.slice(-20),
        summary: this.generateSummary()
      };
    }
    
    generateSummary() {
      const eventTypes = {};
      this.events.forEach(e => {
        eventTypes[e.event] = (eventTypes[e.event] || 0) + 1;
      });
      
      return {
        eventCounts: eventTypes,
        timespan: this.events.length > 0 ? 
          this.events[this.events.length - 1].timestamp - this.events[0].timestamp : 0
      };
    }
    
    exportLog() {
      return JSON.stringify(this.getReport(), null, 2);
    }
  }

  // Создаем глобальный экземпляр диагностики
  const interruptionDiag = new InterruptionDiagnostics();

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info') => {
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      const logPrefix = '[WellcomeAI Widget]';
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
      console.log(`${logPrefix} ${formattedMessage}`);
    } else if (DEBUG_MODE || type === 'error') {
      const prefix = '[WellcomeAI Widget]';
      if (type === 'error') {
        console.error(`${prefix} ERROR:`, message);
      } else if (type === 'warn') {
        console.warn(`${prefix} WARNING:`, message);
      } else if (DEBUG_MODE) {
        console.log(`${prefix}`, message);
      }
    }
  };

  // Функция для отслеживания ошибок
  const addToDebugQueue = (message, type = 'info') => {
    if (!DEBUG_MODE) return;
    
    const timestamp = new Date().toISOString();
    debugQueue.push({ timestamp, message, type });
    
    if (debugQueue.length > MAX_DEBUG_ITEMS) {
      debugQueue.shift();
    }
  };

  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  const updateDebugPanel = () => {
    if (!DEBUG_MODE) return;
  };

  // Функция для определения URL сервера
  const getServerUrl = () => {
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;
    
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-server')) {
        serverUrl = scriptTags[i].getAttribute('data-server');
        widgetLog(`Found server URL from data-server attribute: ${serverUrl}`);
        break;
      }
      
      if (scriptTags[i].dataset && scriptTags[i].dataset.server) {
        serverUrl = scriptTags[i].dataset.server;
        widgetLog(`Found server URL from dataset.server: ${serverUrl}`);
        break;
      }
      
      const src = scriptTags[i].getAttribute('src');
      if (src && (src.includes('widget.js') || src.includes('wellcomeai-widget.min.js'))) {
        try {
          const url = new URL(src, window.location.href);
          serverUrl = url.origin;
          widgetLog(`Extracted server URL from script src: ${serverUrl}`);
          break;
        } catch (e) {
          widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');
          
          if (src.startsWith('/')) {
            serverUrl = window.location.origin;
            widgetLog(`Using current origin for relative path: ${serverUrl}`);
            break;
          }
        }
      }
    }
    
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) {
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }
    
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com';
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }
    
    return serverUrl.replace(/\/$/, '');
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-assistantId') || scriptTags[i].hasAttribute('data-assistantid')) {
        const id = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid');
        widgetLog(`Found assistant ID from attribute: ${id}`);
        return id;
      }
      
      if (scriptTags[i].dataset && (scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid)) {
        const id = scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid;
        widgetLog(`Found assistant ID from dataset: ${id}`);
        return id;
      }
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) {
      widgetLog(`Found assistant ID in URL param: ${idFromUrl}`);
      return idFromUrl;
    }
    
    if (window.wellcomeAIAssistantId) {
      widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`);
      return window.wellcomeAIAssistantId;
    }
    
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo';
    }
    
    widgetLog('No assistant ID found in script tags, URL params or global variables!', 'error');
    return null;
  };

  // Получение позиции виджета
  const getWidgetPosition = () => {
    const defaultPosition = {
      horizontal: 'right',
      vertical: 'bottom',
      distance: '20px'
    };

    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-position')) {
        return parsePosition(scriptTags[i].getAttribute('data-position'));
      }
      
      if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
        return parsePosition(scriptTags[i].dataset.position);
      }
    }

    return defaultPosition;

    function parsePosition(positionString) {
      const position = { ...defaultPosition };
      
      if (!positionString) return position;
      
      const parts = positionString.toLowerCase().split('-');
      if (parts.length === 2) {
        if (parts[0] === 'top' || parts[0] === 'bottom') {
          position.vertical = parts[0];
          position.horizontal = parts[1];
        } else if (parts[1] === 'top' || parts[1] === 'bottom') {
          position.vertical = parts[1];
          position.horizontal = parts[0];
        }
      }
      
      return position;
    }
  };

  // Определяем URL сервера и ID ассистента
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID;
  
  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);

  // Создаем стили для виджета
  function createStyles() {
    const styleEl = document.createElement('style');
    styleEl.id = 'wellcomeai-widget-styles';
    styleEl.textContent = `
      .wellcomeai-widget-container {
        position: fixed;
        ${WIDGET_POSITION.vertical}: ${WIDGET_POSITION.distance};
        ${WIDGET_POSITION.horizontal}: ${WIDGET_POSITION.distance};
        z-index: 2147483647;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: 'Segoe UI', 'Roboto', sans-serif;
      }
      
      .wellcomeai-widget-button {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #4a86e8, #2b59c3);
        box-shadow: 0 4px 15px rgba(74, 134, 232, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
        z-index: 2147483647;
        border: none;
        outline: none;
      }
      
      .wellcomeai-widget-button:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 20px rgba(74, 134, 232, 0.5);
      }
      
      .wellcomeai-widget-button::before {
        content: '';
        position: absolute;
        width: 150%;
        height: 150%;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.2));
        transform: rotate(45deg);
        top: -30%;
        left: -30%;
        transition: all 0.6s ease;
      }
      
      .wellcomeai-widget-button:hover::before {
        transform: rotate(90deg);
      }
      
      .wellcomeai-widget-icon {
        color: white;
        font-size: 22px;
        z-index: 2;
        transition: all 0.3s ease;
      }
      
      .wellcomeai-widget-expanded {
        position: absolute;
        ${WIDGET_POSITION.vertical}: 0;
        ${WIDGET_POSITION.horizontal}: 0;
        width: 320px;
        height: 0;
        opacity: 0;
        pointer-events: none;
        background: white;
        border-radius: 20px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
        overflow: hidden;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        display: flex;
        flex-direction: column;
        z-index: 2147483646;
      }
      
      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 400px;
        opacity: 1;
        pointer-events: all;
      }
      
      .wellcomeai-widget-container.active .wellcomeai-widget-button {
        transform: scale(0.9);
        box-shadow: 0 2px 10px rgba(74, 134, 232, 0.3);
      }
      
      .wellcomeai-widget-header {
        padding: 15px 20px;
        background: linear-gradient(135deg, #4a86e8, #2b59c3);
        color: white;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-radius: 20px 20px 0 0;
      }
      
      .wellcomeai-widget-title {
        font-weight: 600;
        font-size: 16px;
        letter-spacing: 0.3px;
      }
      
      .wellcomeai-widget-close {
        background: none;
        border: none;
        color: white;
        font-size: 18px;
        cursor: pointer;
        opacity: 0.8;
        transition: all 0.2s;
      }
      
      .wellcomeai-widget-close:hover {
        opacity: 1;
        transform: scale(1.1);
      }
      
      .wellcomeai-widget-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #f9fafc;
        position: relative;
        padding: 20px;
      }
      
      .wellcomeai-main-circle {
        width: 180px;
        height: 180px;
        border-radius: 50%;
        background: linear-gradient(135deg, #ffffff, #e1f5fe, #4a86e8);
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
        position: relative;
        overflow: hidden;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .wellcomeai-main-circle::before {
        content: '';
        position: absolute;
        width: 140%;
        height: 140%;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.3), rgba(74, 134, 232, 0.2));
        animation: wellcomeai-wave 8s linear infinite;
        border-radius: 40%;
      }
      
      @keyframes wellcomeai-wave {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      
      .wellcomeai-main-circle.listening {
        background: linear-gradient(135deg, #ffffff, #e3f2fd, #2196f3);
        box-shadow: 0 0 30px rgba(33, 150, 243, 0.6);
      }
      
      .wellcomeai-main-circle.listening::before {
        animation: wellcomeai-wave 4s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(33, 150, 243, 0.3));
      }
      
      .wellcomeai-main-circle.listening::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        border: 3px solid rgba(33, 150, 243, 0.5);
        animation: wellcomeai-pulse 1.5s ease-out infinite;
      }
      
      @keyframes wellcomeai-pulse {
        0% { 
          transform: scale(0.95);
          opacity: 0.7;
        }
        50% { 
          transform: scale(1.05);
          opacity: 0.3;
        }
        100% { 
          transform: scale(0.95);
          opacity: 0.7;
        }
      }
      
      .wellcomeai-main-circle.speaking {
        background: linear-gradient(135deg, #ffffff, #e8f5e9, #4caf50);
        box-shadow: 0 0 30px rgba(76, 175, 80, 0.6);
      }
      
      .wellcomeai-main-circle.speaking::before {
        animation: wellcomeai-wave 3s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(76, 175, 80, 0.3));
      }
      
      .wellcomeai-main-circle.speaking::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle, transparent 50%, rgba(76, 175, 80, 0.1) 100%);
        border-radius: 50%;
        animation: wellcomeai-ripple 2s ease-out infinite;
      }
      
      @keyframes wellcomeai-ripple {
        0% { 
          transform: scale(0.8); 
          opacity: 0;
        }
        50% { 
          opacity: 0.5;
        }
        100% { 
          transform: scale(1.2); 
          opacity: 0;
        }
      }
      
      .wellcomeai-main-circle.interrupted {
        background: linear-gradient(135deg, #ffffff, #ffebee, #f44336);
        box-shadow: 0 0 30px rgba(244, 67, 54, 0.6);
        animation: wellcomeai-interrupt-flash 0.2s ease;
      }
      
      @keyframes wellcomeai-interrupt-flash {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.08); }
      }
      
      .wellcomeai-mic-icon {
        color: #4a86e8;
        font-size: 32px;
        z-index: 10;
      }
      
      .wellcomeai-main-circle.listening .wellcomeai-mic-icon {
        color: #2196f3;
      }
      
      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon {
        color: #4caf50;
      }
      
      .wellcomeai-main-circle.interrupted .wellcomeai-mic-icon {
        color: #f44336;
      }
      
      .wellcomeai-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px;
        bottom: -5px;
        opacity: 0.8;
        pointer-events: none;
      }
      
      .wellcomeai-audio-bars {
        display: flex;
        align-items: flex-end;
        height: 30px;
        gap: 2px;
        width: 100%;
        justify-content: center;
      }
      
      .wellcomeai-audio-bar {
        width: 3px;
        height: 2px;
        background-color: #4a86e8;
        border-radius: 1px;
        transition: height 0.1s ease;
      }
      
      .wellcomeai-loader-modal {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483646;
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s;
        border-radius: 20px;
      }
      
      .wellcomeai-loader-modal.active {
        opacity: 1;
        visibility: visible;
      }
      
      .wellcomeai-loader {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(74, 134, 232, 0.3);
        border-radius: 50%;
        border-top-color: #4a86e8;
        animation: wellcomeai-spin 1s linear infinite;
      }
      
      @keyframes wellcomeai-spin {
        to { transform: rotate(360deg); }
      }
      
      .wellcomeai-message-display {
        position: absolute;
        width: 90%;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: white;
        padding: 12px 15px;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        text-align: center;
        font-size: 14px;
        line-height: 1.4;
        opacity: 0;
        transition: all 0.3s;
        max-height: 100px;
        overflow-y: auto;
        z-index: 10;
      }
      
      .wellcomeai-message-display.show {
        opacity: 1;
      }
      
      @keyframes wellcomeai-button-pulse {
        0% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(74, 134, 232, 0); }
        100% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0); }
      }
      
      .wellcomeai-pulse-animation {
        animation: wellcomeai-button-pulse 2s infinite;
      }

      .wellcomeai-connection-error {
        color: #ef4444;
        background-color: rgba(254, 226, 226, 0.8);
        border: 1px solid #ef4444;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        margin-top: 10px;
        text-align: center;
        display: none;
      }
      
      .wellcomeai-connection-error.visible {
        display: block;
      }

      .wellcomeai-retry-button {
        background-color: #ef4444;
        color: white;
        border: none;
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
        margin-top: 8px;
        transition: all 0.2s;
      }
      
      .wellcomeai-retry-button:hover {
        background-color: #dc2626;
      }
      
      .wellcomeai-status-indicator {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 11px;
        color: #64748b;
        padding: 4px 8px;
        border-radius: 10px;
        background-color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        gap: 5px;
        opacity: 0;
        transition: opacity 0.3s;
      }
      
      .wellcomeai-status-indicator.show {
        opacity: 0.8;
      }
      
      .wellcomeai-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #10b981;
      }
      
      .wellcomeai-status-dot.disconnected {
        background-color: #ef4444;
      }
      
      .wellcomeai-status-dot.connecting {
        background-color: #f59e0b;
      }
      
      .wellcomeai-ios-audio-button {
        position: absolute;
        bottom: 60px;
        left: 50%;
        transform: translateX(-50%);
        background-color: #4a86e8;
        color: white;
        border: none;
        border-radius: 15px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: none;
        z-index: 100;
      }
      
      .wellcomeai-ios-audio-button.visible {
        display: block;
      }

      .wellcomeai-diag-button {
        position: absolute;
        top: 5px;
        right: 5px;
        background: #ff4444;
        color: white;
        border: none;
        border-radius: 3px;
        padding: 2px 6px;
        font-size: 10px;
        cursor: pointer;
        z-index: 1000;
      }
    `;
    document.head.appendChild(styleEl);
    widgetLog("Styles created and added to head");
  }

  // Загрузка Font Awesome для иконок
  function loadFontAwesome() {
    if (!document.getElementById('font-awesome-css')) {
      const link = document.createElement('link');
      link.id = 'font-awesome-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
      document.head.appendChild(link);
      widgetLog("Font Awesome loaded");
    }
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647";

    let widgetHTML = `
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button">
        <i class="fas fa-robot wellcomeai-widget-icon"></i>
      </div>
      
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">WellcomeAI</div>
          ${DEBUG_MODE ? '<button class="wellcomeai-diag-button" id="wellcomeai-diag-button">Export Diag</button>' : ''}
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>
            
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>
          
          <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>
          
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error">
            Ошибка соединения с сервером
            <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
              Повторить подключение
            </button>
          </div>
          
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
            Нажмите для активации аудио
          </button>
          
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Подключено</span>
          </div>
        </div>
      </div>
      
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active">
        <div class="wellcomeai-loader"></div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);
    widgetLog("HTML structure created and appended to body");
    
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    if (widgetButton) {
      widgetButton.style.opacity = '1';
      widgetButton.style.visibility = 'visible';
      widgetButton.style.pointerEvents = 'auto';
    }
  }

  // Функция для разблокировки аудио на iOS
  function unlockAudioOnIOS() {
    if (!isIOS) return Promise.resolve(true);
    
    widgetLog('Попытка разблокировки аудио на iOS');
    
    return new Promise((resolve) => {
      const tempAudio = document.createElement('audio');
      tempAudio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
      tempAudio.volume = 0;
      
      const playPromise = tempAudio.play();
      
      if (playPromise !== undefined) {
        playPromise.then(() => {
          widgetLog('Успешно разблокировано аудио через элемент audio');
          
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          if (window.tempAudioContext.state === 'suspended') {
            window.tempAudioContext.resume().then(() => {
              window.audioContextInitialized = true;
              widgetLog('AudioContext успешно активирован');
              resolve(true);
            }).catch(err => {
              widgetLog(`Не удалось активировать AudioContext: ${err.message}`, 'error');
              resolve(false);
            });
          } else {
            window.audioContextInitialized = true;
            resolve(true);
          }
        }).catch(err => {
          widgetLog(`Ошибка при разблокировке аудио: ${err.message}`, 'error');
          resolve(false);
        });
      } else {
        widgetLog('Используем метод разблокировки для устаревших устройств');
        setTimeout(() => {
          playSilence();
          resolve(true);
        }, 100);
      }
    });
  }
  
  // Функция для форсированной разблокировки аудио на iOS
  function forceIOSAudioUnlock() {
    if (!isIOS) return Promise.resolve(true);
    
    return new Promise((resolve) => {
      const frequencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      let index = 0;
      
      function playNextTone() {
        if (index >= frequencies.length) {
          window.hasPlayedSilence = true;
          window.audioContextInitialized = true;
          widgetLog('Завершено многократное разблокирование аудио на iOS');
          resolve(true);
          return;
        }
        
        try {
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          const ctx = window.tempAudioContext;
          
          if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
              const oscillator = ctx.createOscillator();
              const gainNode = ctx.createGain();
              
              gainNode.gain.value = 0.01;
              oscillator.type = 'sine';
              oscillator.frequency.value = frequencies[index];
              oscillator.connect(gainNode);
              gainNode.connect(ctx.destination);
              
              oscillator.start(0);
              oscillator.stop(0.1);
              
              setTimeout(() => {
                index++;
                playNextTone();
              }, 200);
            });
          } else {
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();
            
            gainNode.gain.value = 0.01;
            oscillator.type = 'sine';
            oscillator.frequency.value = frequencies[index];
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);
            
            oscillator.start(0);
            oscillator.stop(0.1);
            
            setTimeout(() => {
              index++;
              playNextTone();
            }, 200);
          }
        } catch (e) {
          widgetLog(`Ошибка при разблокировке тонов: ${e.message}`, 'warn');
          index++;
          setTimeout(playNextTone, 200);
        }
      }
      
      playNextTone();
    });
  }

  // Воспроизведение тишины (резервная функция для iOS)
  function playSilence() {
    try {
      if (!window.tempAudioContext) {
        window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      const silentBuffer = window.tempAudioContext.createBuffer(1, 1, 22050);
      const source = window.tempAudioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(window.tempAudioContext.destination);
      source.start(0);
      
      window.hasPlayedSilence = true;
      widgetLog("Played silence to unlock audio on iOS");
      
      if (window.tempAudioContext.state === 'suspended') {
        window.tempAudioContext.resume().then(() => {
          window.audioContextInitialized = true;
          widgetLog("Audio context successfully resumed on iOS");
        }).catch(err => {
          widgetLog(`Failed to resume audio context: ${err.message}`, 'error');
        });
      }
    } catch (e) {
      widgetLog(`Error playing silence: ${e.message}`, 'error');
    }
  }

  // Основная логика виджета
  function initWidget() {
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag.", 'error');
      alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
      return;
    }

    // Элементы UI
    const widgetContainer = document.getElementById('wellcomeai-widget-container');
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    const widgetClose = document.getElementById('wellcomeai-widget-close');
    const mainCircle = document.getElementById('wellcomeai-main-circle');
    const audioBars = document.getElementById('wellcomeai-audio-bars');
    const loaderModal = document.getElementById('wellcomeai-loader-modal');
    const messageDisplay = document.getElementById('wellcomeai-message-display');
    const connectionError = document.getElementById('wellcomeai-connection-error');
    const retryButton = document.getElementById('wellcomeai-retry-button');
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
    const diagButton = document.getElementById('wellcomeai-diag-button');
    
    if (!widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay) {
      widgetLog("Some UI elements were not found!", 'error');
      return;
    }
    
    widgetButton.style.opacity = '1';
    widgetButton.style.visibility = 'visible';
    widgetButton.style.pointerEvents = 'auto';
    
    // Переменные для обработки аудио
    let audioChunksBuffer = [];
    let audioPlaybackQueue = [];
    let isPlayingAudio = false;
    let hasAudioData = false;
    let audioDataStartTime = 0;
    let minimumAudioLength = 300;
    let isListening = false;
    let websocket = null;
    let audioContext = null;
    let mediaStream = null;
    let audioProcessor = null;
    let isConnected = false;
    let isWidgetOpen = false;
    let connectionFailedPermanently = false;
    let pingInterval = null;
    let lastPingTime = Date.now();
    let lastPongTime = Date.now();
    let connectionTimeout = null;
    
    // КРИТИЧЕСКИ ВАЖНЫЕ ПЕРЕМЕННЫЕ ДЛЯ ПРЕРЫВАНИЯ
    let currentResponseId = null;
    let samplesPlayedSoFar = 0;
    let audioSamplesExpected = 0;
    let soundDetectionCounter = 0;
    let lastInterruptionTime = 0;
    
    // ПЕРЕМЕННЫЕ ДЛЯ ЭХО-ПОДАВЛЕНИЯ И ОТЛАДКИ
    let lastPlaybackStartTime = 0;
    let isInEchoSuppressionPeriod = false;
    let gainNode = null;
    let debugDetectionCounter = 0;
    let lastDetectionLog = 0;
    
    // ИСПРАВЛЕННАЯ КОНФИГУРАЦИЯ ДЛЯ АГРЕССИВНОГО ПРЕРЫВАНИЯ
    const INTERRUPTION_CONFIG = {
      soundDetectionThreshold: isIOS ? 0.003 : (isMobile ? 0.005 : 0.008), // КРИТИЧЕСКИ СНИЖЕНЫ пороги
      consecutiveDetections: isIOS ? 1 : (isMobile ? 1 : 1), // МГНОВЕННАЯ реакция
      minimumInterruptionGap: 200, // СОКРАЩЕНА пауза между отменами
      gainReductionDuringPlayback: 0.6, // МЕНЕЕ агрессивное снижение чувствительности
      echoSuppressionTime: 150, // СОКРАЩЕНО время подавления эхо
      forceStopThreshold: 0.02 // Порог для принудительной остановки
    };
    
    // Конфигурация для оптимизации потока аудио
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,
      silenceDuration: 300,
      bufferCheckInterval: 50,
      soundDetectionThreshold: 0.02
    };
    
    const MOBILE_AUDIO_CONFIG = {
      silenceThreshold: 0.015,
      silenceDuration: 500,
      bufferCheckInterval: 100,
      soundDetectionThreshold: 0.015
    };
    
    const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;
    
    // ИСПРАВЛЕННАЯ ФУНКЦИЯ ОТПРАВКИ ОТМЕНЫ
    function sendCancel(itemId = null, sampleCount = 0, wasPlayingAudio = false) {
      interruptionDiag.log('send_cancel_start', {
        itemId,
        sampleCount,
        wasPlayingAudio,
        wsState: websocket ? websocket.readyState : 'no_websocket'
      });

      if (websocket && websocket.readyState === WebSocket.OPEN) {
        const timestamp = Date.now();
        
        const cancelPayload = {
          type: "response.cancel",
          event_id: `cancel_${timestamp}`
        };
        
        if (itemId) {
          cancelPayload.item_id = itemId;
        }
        if (sampleCount > 0) {
          cancelPayload.sample_count = sampleCount;
        }
        if (wasPlayingAudio !== undefined) {
          cancelPayload.was_playing_audio = wasPlayingAudio;
        }
        
        websocket.send(JSON.stringify(cancelPayload));
        widgetLog(`[INTERRUPTION] Sent response.cancel: itemId=${itemId || 'null'}, sampleCount=${sampleCount}, wasPlaying=${wasPlayingAudio}`);
        
        interruptionDiag.log('send_cancel_complete', {
          itemId,
          sampleCount,
          wasPlayingAudio
        });
      } else {
        widgetLog(`[INTERRUPTION] Cannot send cancel - websocket not ready`, 'error');
      }
    }
    
    // ФУНКЦИЯ МГНОВЕННОЙ ОСТАНОВКИ
    function immediateStopAllPlayback() {
      widgetLog('[INTERRUPTION] Мгновенная остановка всего воспроизведения');
      
      document.querySelectorAll('audio').forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = '';
          audio.remove();
        } catch (e) {
          // Игнорируем ошибки
        }
      });
      
      audioPlaybackQueue = [];
      audioChunksBuffer = [];
      isPlayingAudio = false;
      mainCircle.classList.remove('speaking');
    }
    
    // ФУНКЦИЯ ПРИНУДИТЕЛЬНОГО СБРОСА СОСТОЯНИЯ
    function forceResetState() {
      widgetLog('[INTERRUPTION] Принудительный сброс состояния');
      
      currentResponseId = null;
      samplesPlayedSoFar = 0;
      audioSamplesExpected = 0;
      soundDetectionCounter = 0;
      
      lastPlaybackStartTime = 0;
      isInEchoSuppressionPeriod = false;
      
      mainCircle.classList.remove('speaking', 'interrupted');
    }
    
    // Показать визуальную обратную связь о перебивании
    function showInterruptionFeedback() {
      mainCircle.classList.add('interrupted');
      setTimeout(() => {
        mainCircle.classList.remove('interrupted');
      }, 200);
    }
    
    // НОВАЯ ФУНКЦИЯ - Финализация прерывания после получения response.cancel.ack
    function finalizeInterruption(originalItemId, originalSampleCount, originalWasPlaying) {
      widgetLog(`[INTERRUPTION] Финализация прерывания: itemId=${originalItemId}, samples=${originalSampleCount}, wasPlaying=${originalWasPlaying}`);
      
      interruptionDiag.log('finalize_interruption_start', {
        originalItemId,
        originalSampleCount, 
        originalWasPlaying
      });
      
      const timestamp = Date.now();
      
      // 1. Очищаем буфер вывода аудио, если было воспроизведение
      if (originalItemId && originalWasPlaying) {
        setTimeout(() => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              type: "output_audio_buffer.clear",
              event_id: `clear_output_${timestamp}`
            }));
            widgetLog(`[INTERRUPTION] Sent output_audio_buffer.clear для ${originalItemId}`);
          }
        }, 50);
      }
      
      // 2. Обрезаем элемент диалога, если есть ID и воспроизведенные семплы
      if (originalItemId && originalSampleCount > 0) {
        setTimeout(() => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            const ACTUAL_AUDIO_SAMPLE_RATE = audioContext ? audioContext.sampleRate : 24000;
            const audioEndMs = Math.floor((originalSampleCount / ACTUAL_AUDIO_SAMPLE_RATE) * 1000);
            
            websocket.send(JSON.stringify({
              type: "conversation.item.truncate",
              event_id: `truncate_${timestamp}`,
              item_id: originalItemId,
              content_index: 0,
              audio_end_ms: audioEndMs
            }));
            widgetLog(`[INTERRUPTION] Sent conversation.item.truncate: itemId=${originalItemId}, audio_end_ms=${audioEndMs}`);
          }
        }, 100);
      }
      
      // 3. Сбрасываем состояние и начинаем новое прослушивание
      setTimeout(() => {
        forceResetState();
        
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({
            type: "input_audio_buffer.clear",
            event_id: `clear_input_${timestamp}`
          }));
        }
        
        if (isWidgetOpen && isConnected) {
          isListening = false;
          startListening();
        }
        
        interruptionDiag.log('finalize_interruption_complete', {
          originalItemId,
          newState: 'listening_started'
        });
      }, 200);
    }
    
    // Обновление индикатора статуса соединения
    function updateConnectionStatus(status, message) {
      if (!statusIndicator || !statusDot || !statusText) return;
      
      statusText.textContent = message || status;
      
      statusDot.classList.remove('connected', 'disconnected', 'connecting');
      
      if (status === 'connected') {
        statusDot.classList.add('connected');
      } else if (status === 'disconnected') {
        statusDot.classList.add('disconnected');
      } else {
        statusDot.classList.add('connecting');
      }
      
      statusIndicator.classList.add('show');
      
      setTimeout(() => {
        statusIndicator.classList.remove('show');
      }, 3000);
    }
    
    // Создаем аудио-бары для визуализации
    function createAudioBars(count = 20) {
      audioBars.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        audioBars.appendChild(bar);
      }
    }
    createAudioBars();
    
    // Функция для полной остановки всех аудио процессов
    function stopAllAudioProcessing() {
      isListening = false;
      immediateStopAllPlayback();
      hasAudioData = false;
      audioDataStartTime = 0;
      forceResetState();
      
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
        
        websocket.send(JSON.stringify({
          type: "response.cancel",
          event_id: `cancel_${Date.now()}`
        }));
      }
      
      resetAudioVisualization();
    }
    
    // Показать сообщение
    function showMessage(message, duration = 5000) {
      messageDisplay.textContent = message;
      messageDisplay.classList.add('show');
      
      if (duration > 0) {
        setTimeout(() => {
          messageDisplay.classList.remove('show');
        }, duration);
      }
    }

    // Скрыть сообщение
    function hideMessage() {
      messageDisplay.classList.remove('show');
    }
    
    // Показать ошибку соединения
    function showConnectionError(message) {
      if (connectionError) {
        connectionError.innerHTML = `
          ${message || 'Ошибка соединения с сервером'}
          <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
            Повторить подключение
          </button>
        `;
        connectionError.classList.add('visible');
        
        const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', function() {
            resetConnection();
          });
        }
      }
    }
    
    // Скрыть ошибку соединения
    function hideConnectionError() {
      if (connectionError) {
        connectionError.classList.remove('visible');
      }
    }
    
    // Сброс состояния соединения
    function resetConnection() {
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      hideConnectionError();
      showMessage("Попытка подключения...");
      updateConnectionStatus('connecting', 'Подключение...');
      connectWebSocket();
    }
    
    // Открыть виджет
    function openWidget() {
      widgetLog("Opening widget");
      
      widgetContainer.style.zIndex = "2147483647";
      widgetButton.style.zIndex = "2147483647";
      
      widgetContainer.classList.add('active');
      isWidgetOpen = true;
      
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "1";
        expandedWidget.style.height = "400px";
        expandedWidget.style.pointerEvents = "all";
        expandedWidget.style.zIndex = "2147483647";
      }
      
      if (isIOS) {
        if (iosAudioButton && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
          iosAudioButton.classList.add('visible');
          iosAudioButton.addEventListener('click', function() {
            unlockAudioOnIOS().then(success => {
              if (success) {
                iosAudioButton.classList.remove('visible');
                setTimeout(() => {
                  if (isConnected && !isListening && !isPlayingAudio) {
                    startListening();
                  }
                }, 500);
              }
            });
          });
        }
        
        if (!window.hasPlayedSilence) {
          unlockAudioOnIOS();
        }
      } else if (isMobile && !window.audioContextInitialized) {
        try {
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          window.audioContextInitialized = true;
          widgetLog("Mobile audio context initialized");
        } catch (e) {
          widgetLog(`Failed to initialize audio context: ${e.message}`, "error");
        }
      }
      
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        return;
      }
      
      if (isConnected && !isReconnecting) {
        if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
          if (iosAudioButton) {
            iosAudioButton.classList.add('visible');
          }
          showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
        } else {
          isListening = false;
          startListening();
        }
        updateConnectionStatus('connected', 'Подключено');
      } else if (!isConnected && !isReconnecting) {
        connectWebSocket();
      } else {
        widgetLog(`Cannot start listening yet: isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
        
        if (isReconnecting) {
          updateConnectionStatus('connecting', 'Переподключение...');
        }
      }
      
      widgetButton.classList.remove('wellcomeai-pulse-animation');
    }
    
    // Закрыть виджет
    function closeWidget() {
      widgetLog("Closing widget");
      
      stopAllAudioProcessing();
      
      widgetContainer.classList.remove('active');
      isWidgetOpen = false;
      
      hideMessage();
      hideConnectionError();
      
      if (statusIndicator) {
        statusIndicator.classList.remove('show');
      }
      
      if (iosAudioButton) {
        iosAudioButton.classList.remove('visible');
      }
      
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "0";
        expandedWidget.style.height = "0";
        expandedWidget.style.pointerEvents = "none";
      }
    }
    
    // ИСПРАВЛЕННАЯ ФУНКЦИЯ ИНИЦИАЛИЗАЦИИ АУДИО
    async function initAudio() {
      try {
        widgetLog("Запрос разрешения на доступ к микрофону...");
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону");
        }
        
        const audioConstraints = isIOS ? 
          { 
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false
          } : 
          isMobile ? 
          { 
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            sampleRate: 16000
          } :
          {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            sampleRate: 24000
          };
        
        if (isIOS) {
          await unlockAudioOnIOS();
        }
        
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Доступ к микрофону получен с эхо-подавлением`);
        } catch (micError) {
          widgetLog(`Ошибка доступа к микрофону: ${micError.message}`, 'error');
          if (isIOS) {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
            widgetLog('Доступ к микрофону получен с базовыми настройками для iOS');
          } else {
            throw micError;
          }
        }
        
        if (isIOS) {
          if (window.tempAudioContext) {
            audioContext = window.tempAudioContext;
            if (audioContext.state === 'suspended') {
              await audioContext.resume();
              window.audioContextInitialized = true;
            }
          } else {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
              sampleRate: 16000
            });
            window.tempAudioContext = audioContext;
            window.audioContextInitialized = true;
          }
        } else {
          const contextOptions = isMobile ? {} : { sampleRate: 24000 };
          audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
        }
        
        widgetLog(`AudioContext создан с частотой ${audioContext.sampleRate} Гц`);
        
        const bufferSize = isIOS ? 2048 : (isMobile ? 1024 : 2048);
        
        if (audioContext.createScriptProcessor) {
          audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        } else if (audioContext.createJavaScriptNode) {
          audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
        } else {
          throw new Error("Ваш браузер не поддерживает обработку аудио");
        }
        
        // Переменные для отслеживания звука
        let isSilent = true;
        let silenceStartTime = Date.now();
        let lastCommitTime = 0;
        let hasSentAudioInCurrentSegment = false;
        
        // КРИТИЧЕСКИ ИСПРАВЛЕННЫЙ ОБРАБОТЧИК АУДИО
        audioProcessor.onaudioprocess = function(e) {
          if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
            const inputBuffer = e.inputBuffer;
            let inputData = inputBuffer.getChannelData(0);
            
            if (inputData.length === 0) return;
            
            // УЛУЧШЕННЫЙ расчет амплитуды с RMS
            let maxAmplitude = 0;
            let rmsAmplitude = 0;
            for (let i = 0; i < inputData.length; i++) {
              const sample = Math.abs(inputData[i]);
              maxAmplitude = Math.max(maxAmplitude, sample);
              rmsAmplitude += sample * sample;
            }
            rmsAmplitude = Math.sqrt(rmsAmplitude / inputData.length);
            
            const now = Date.now();
            
            // ИСПРАВЛЕННАЯ логика эхо-подавления
            isInEchoSuppressionPeriod = (now - lastPlaybackStartTime) < INTERRUPTION_CONFIG.echoSuppressionTime;
            
            // ДИНАМИЧЕСКИЕ пороги
            let effectiveThreshold = INTERRUPTION_CONFIG.soundDetectionThreshold;
            
            if (isPlayingAudio) {
              // МЕНЕЕ агрессивное повышение порога
              effectiveThreshold = INTERRUPTION_CONFIG.soundDetectionThreshold * 1.2; // Было * 2
              
              if (gainNode) {
                gainNode.gain.value = INTERRUPTION_CONFIG.gainReductionDuringPlayback;
              }
            } else {
              if (gainNode) {
                gainNode.gain.value = 1.0;
              }
            }
            
            // ИСПОЛЬЗУЕМ RMS амплитуду для более стабильной детекции
            const hasSound = rmsAmplitude > effectiveThreshold;
            
            // Подробное логирование каждые 1000мс
            debugDetectionCounter++;
            if (debugDetectionCounter % 40 === 0 && now - lastDetectionLog > 1000) {
              widgetLog(`[DEBUG] isPlaying=${isPlayingAudio}, maxAmp=${maxAmplitude.toFixed(4)}, rmsAmp=${rmsAmplitude.toFixed(4)}, threshold=${effectiveThreshold.toFixed(4)}, hasSound=${hasSound}, responseId=${currentResponseId || 'null'}`);
              lastDetectionLog = now;
            }
            
            // КРИТИЧЕСКИ ВАЖНАЯ ЛОГИКА ДЕТЕКЦИИ ПРЕРЫВАНИЯ
            if (isPlayingAudio && hasSound && currentResponseId) {
              if (now - lastInterruptionTime > INTERRUPTION_CONFIG.minimumInterruptionGap) {
                soundDetectionCounter++;
                
                widgetLog(`[INTERRUPTION] Звук детектирован! Counter: ${soundDetectionCounter}/${INTERRUPTION_CONFIG.consecutiveDetections}, rmsAmp: ${rmsAmplitude.toFixed(4)}, responseId: ${currentResponseId}`);
                
                interruptionDiag.log('sound_detected_during_playback', {
                  maxAmplitude: maxAmplitude,
                  rmsAmplitude: rmsAmplitude,
                  threshold: effectiveThreshold,
                  soundCounter: soundDetectionCounter,
                  currentResponseId,
                  samplesPlayed: samplesPlayedSoFar,
                  isInEchoSuppression: isInEchoSuppressionPeriod
                });
                
                // МГНОВЕННАЯ реакция на детекцию
                if (soundDetectionCounter >= INTERRUPTION_CONFIG.consecutiveDetections) {
                  widgetLog(`[INTERRUPTION] ДЕТЕКТИРОВАНА РЕЧЬ! Немедленная остановка! ResponseId: ${currentResponseId}`);
                  
                  // Захватываем контекст ДО изменения состояния
                  const interruptedItemId = currentResponseId;
                  const interruptedSamplesPlayed = samplesPlayedSoFar;
                  const wasPlayingAudioFlag = isPlayingAudio;
                  
                  interruptionDiag.log('interruption_triggered', {
                    responseId: interruptedItemId,
                    samplesPlayed: interruptedSamplesPlayed,
                    timeSinceLastInterruption: now - lastInterruptionTime,
                    rmsAmplitude: rmsAmplitude
                  });
                  
                  // 1. МГНОВЕННАЯ остановка локального воспроизведения
                  immediateStopAllPlayback();
                  
                  // 2. Визуальная обратная связь
                  showInterruptionFeedback();
                  
                  // 3. Отправка команды отмены с правильными параметрами
                  sendCancel(interruptedItemId, interruptedSamplesPlayed, wasPlayingAudioFlag);
                  lastInterruptionTime = now;
                  
                  // 4. Сброс состояния
                  forceResetState();
                  soundDetectionCounter = 0;
                  
                  // 5. Очистка буфера для нового ввода
                  if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({
                      type: "input_audio_buffer.clear",
                      event_id: `clear_${Date.now()}`
                    }));
                  }
                  
                  hasAudioData = true;
                  audioDataStartTime = Date.now();
                }
              }
            } else {
              // Сброс счетчика если нет звука или нет ответа для прерывания
              if (soundDetectionCounter > 0) {
                soundDetectionCounter = 0;
              }
            }
            
            // Обновляем визуализацию
            updateAudioVisualization(inputData);
            
            // Преобразуем в PCM16 и отправляем
            const pcm16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              const sample = inputData[i];
              pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
            }
            
            try {
              const message = JSON.stringify({
                type: "input_audio_buffer.append",
                event_id: `audio_${Date.now()}`,
                audio: arrayBufferToBase64(pcm16Data.buffer)
              });
              
              websocket.send(message);
              hasSentAudioInCurrentSegment = true;
              
              if (!hasAudioData && hasSound && !isInEchoSuppressionPeriod) {
                hasAudioData = true;
                audioDataStartTime = Date.now();
              }
              
            } catch (error) {
              widgetLog(`Ошибка отправки аудио: ${error.message}`, "error");
            }
            
            // Логика определения тишины
            if (hasSound && !isInEchoSuppressionPeriod) {
              isSilent = false;
              silenceStartTime = now;
              
              if (!mainCircle.classList.contains('listening') && 
                  !mainCircle.classList.contains('speaking')) {
                mainCircle.classList.add('listening');
              }
            } else if (!isSilent) {
              const silenceDuration = now - silenceStartTime;
              const effectiveSilenceDuration = isIOS ? 800 : effectiveAudioConfig.silenceDuration;
              
              if (silenceDuration > effectiveSilenceDuration) {
                isSilent = true;
                
                if (now - lastCommitTime > 1000 && hasSentAudioInCurrentSegment) {
                  const iosDelay = isIOS ? 300 : 100;
                  
                  setTimeout(() => {
                    if (isSilent && isListening && !isReconnecting) {
                      commitAudioBuffer();
                      lastCommitTime = Date.now();
                      hasSentAudioInCurrentSegment = false;
                    }
                  }, iosDelay);
                }
              }
            }
          }
        };
        
        // Подключаем обработчик с улучшенной цепочкой обработки
        const streamSource = audioContext.createMediaStreamSource(mediaStream);
        
        // ДОБАВЛЯЕМ GAIN NODE для программного управления усилением
        gainNode = audioContext.createGain();
        gainNode.gain.value = 1.0;
        
        streamSource.connect(gainNode);
        gainNode.connect(audioProcessor);
        
        const dummyGain = audioContext.createGain();
        dummyGain.gain.value = 0;
        audioProcessor.connect(dummyGain);
        dummyGain.connect(audioContext.destination);
        
        widgetLog("Аудио инициализировано с исправленной детекцией прерывания");
        return true;
        
      } catch (error) {
        widgetLog(`Ошибка инициализации аудио: ${error.message}`, "error");
        
        if (isIOS && iosAudioButton) {
          iosAudioButton.classList.add('visible');
          showMessage("Нажмите кнопку ниже для активации микрофона", 0);
        } else {
          showMessage("Ошибка доступа к микрофону. Проверьте настройки браузера.");
        }
        
        return false;
      }
    }
    
    // ИСПРАВЛЕННАЯ ФУНКЦИЯ startListening
    async function startListening() {
      if (!isConnected || isReconnecting) {
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isReconnecting=${isReconnecting}`);
        return;
      }
      
      // ПРИНУДИТЕЛЬНО сбрасываем isListening если он завис
      if (isListening) {
        widgetLog('[INTERRUPTION] isListening был true, принудительно сбрасываем');
        isListening = false;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          await forceIOSAudioUnlock();
        }
      }
      
      isListening = true;
      widgetLog('[INTERRUPTION] Начинаем прослушивание с исправленной детекцией');
      
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
      }
      
      if (isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          await unlockAudioOnIOS();
          
          if (!window.audioContextInitialized) {
            if (iosAudioButton) {
              iosAudioButton.classList.add('visible');
            }
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
            isListening = false;
            return;
          }
        }
      }
      
      if (!audioContext) {
        const success = await initAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио', 'error');
          isListening = false;
          return;
        }
      } else if (audioContext.state === 'suspended') {
        try {
          await audioContext.resume();
          widgetLog('AudioContext возобновлен');
        } catch (error) {
          widgetLog(`Не удалось возобновить AudioContext: ${error}`, 'error');
          isListening = false;
          
          if (isIOS && iosAudioButton) {
            iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
          }
          
          return;
        }
      }
      
      hasAudioData = false;
      audioDataStartTime = 0;
      
      if (!isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
    }
    
    // Функция для отправки аудиобуфера
    function commitAudioBuffer() {
      if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) return;
      
      if (!hasAudioData) {
        widgetLog("WARNING: Не отправляем пустой аудиобуфер", "warn");
        return;
      }
      
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс), ожидаем больше данных`, "warn");
        
        const extraDelay = isMobile ? 200 : 50;
        
        setTimeout(() => {
          if (isListening && hasAudioData && !isReconnecting) {
            widgetLog(`Отправка аудиобуфера после дополнительной записи (${Date.now() - audioDataStartTime}мс)`);
            sendCommitBuffer();
          }
        }, minimumAudioLength - audioLength + extraDelay);
        
        return;
      }
      
      sendCommitBuffer();
    }
    
    // Функция для фактической отправки буфера
    function sendCommitBuffer() {
      widgetLog("Отправка аудиобуфера");
      
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < 100) {
        widgetLog(`Аудиобуфер слишком короткий для OpenAI (${audioLength}мс < 100мс), не отправляем`, "warn");
        
        hasAudioData = false;
        audioDataStartTime = 0;
        
        return;
      }
      
      if (isMobile) {
        setTimeout(() => {
          mainCircle.classList.remove('listening');
        }, 100);
      } else {
        mainCircle.classList.remove('listening');
      }
      
      websocket.send(JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}`
      }));
      
      if (isMobile && loaderModal) {
        loaderModal.classList.add('active');
        setTimeout(() => {
          loaderModal.classList.remove('active');
        }, 1000);
      }
      
      hasAudioData = false;
      audioDataStartTime = 0;
    }
    
    // Преобразование ArrayBuffer в Base64
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }
    
    // Преобразование Base64 в ArrayBuffer
    function base64ToArrayBuffer(base64) {
      try {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      } catch (e) {
        widgetLog(`Ошибка при декодировании base64: ${e.message}`, "error");
        return new ArrayBuffer(0);
      }
    }
    
    // Обновление визуализации аудио
    function updateAudioVisualization(audioData) {
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      const step = Math.floor(audioData.length / bars.length);
      
      for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          const index = i * step + j;
          if (index < audioData.length) {
            sum += Math.abs(audioData[index]);
          }
        }
        const average = sum / step;
        
        const multiplier = isMobile ? 150 : 100;
        
        const height = 2 + Math.min(28, Math.floor(average * multiplier));
        bars[i].style.height = `${height}px`;
      }
    }
    
    // Сброс визуализации аудио
    function resetAudioVisualization() {
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px';
      });
    }
    
    // Создаём простой WAV из PCM данных
    function createWavFromPcm(pcmBuffer, sampleRate = 24000) {
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      
      view.setUint8(0, 'R'.charCodeAt(0));
      view.setUint8(1, 'I'.charCodeAt(0));
      view.setUint8(2, 'F'.charCodeAt(0));
      view.setUint8(3, 'F'.charCodeAt(0));
      
      view.setUint32(4, 36 + pcmBuffer.byteLength, true);
      
      view.setUint8(8, 'W'.charCodeAt(0));
      view.setUint8(9, 'A'.charCodeAt(0));
      view.setUint8(10, 'V'.charCodeAt(0));
      view.setUint8(11, 'E'.charCodeAt(0));
      
      view.setUint8(12, 'f'.charCodeAt(0));
      view.setUint8(13, 'm'.charCodeAt(0));
      view.setUint8(14, 't'.charCodeAt(0));
      view.setUint8(15, ' '.charCodeAt(0));
      
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      
      view.setUint8(36, 'd'.charCodeAt(0));
      view.setUint8(37, 'a'.charCodeAt(0));
      view.setUint8(38, 't'.charCodeAt(0));
      view.setUint8(39, 'a'.charCodeAt(0));
      
      view.setUint32(40, pcmBuffer.byteLength, true);
      
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      
      return wavBuffer;
    }
    
    // ИСПРАВЛЕННАЯ ФУНКЦИЯ ВОСПРОИЗВЕДЕНИЯ с точным отслеживанием семплов
    function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        isPlayingAudio = false;
        mainCircle.classList.remove('speaking');
        forceResetState();
        
        if (!isWidgetOpen) {
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        
        if (isWidgetOpen) {
          setTimeout(() => {
            isListening = false;
            
            if (isIOS) {
              unlockAudioOnIOS().then(unlocked => {
                if (unlocked) {
                  startListening();
                } else if (iosAudioButton) {
                  iosAudioButton.classList.add('visible');
                  showMessage("Нажмите кнопку для активации микрофона", 0);
                }
              });
            } else {
              startListening();
            }
          }, 300);
        }
        return;
      }
      
      isPlayingAudio = true;
      
      // УСТАНАВЛИВАЕМ ВРЕМЯ НАЧАЛА ВОСПРОИЗВЕДЕНИЯ для эхо-подавления
      lastPlaybackStartTime = Date.now();
      
      mainCircle.classList.add('speaking');
      mainCircle.classList.remove('listening');
      
      const audioBase64 = audioPlaybackQueue.shift();
      
      try {
        const audioData = base64ToArrayBuffer(audioBase64);
        if (audioData.byteLength === 0) {
          playNextAudio();
          return;
        }
        
        const wavBuffer = createWavFromPcm(audioData);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);
        
        const audio = new Audio();
        audio.src = audioUrl;
        
        audio.volume = 0.7;
        
        audio.preload = 'auto';
        audio.load();
        
        audio.setAttribute('data-wellcome-audio', 'true');
        
        // ТОЧНОЕ ОТСЛЕЖИВАНИЕ ВОСПРОИЗВЕДЕННЫХ СЕМПЛОВ
        let startTime = null;
        const sampleRate = audioContext ? audioContext.sampleRate : 24000;
        const totalSamples = audioData.byteLength / 2;
        
        audio.ontimeupdate = function() {
          if (startTime && currentResponseId) {
            const currentTime = audio.currentTime;
            const playedSamples = Math.floor(currentTime * sampleRate);
            
            const previousTotal = samplesPlayedSoFar;
            samplesPlayedSoFar = previousTotal + playedSamples;
            
            if (Math.floor(currentTime * 2) % 1 === 0) {
              widgetLog(`[INTERRUPTION] Воспроизведено: ${samplesPlayedSoFar} семплов из ${audioSamplesExpected}`);
            }
          }
        };
        
        audio.oncanplaythrough = function() {
          widgetLog(`[INTERRUPTION] Начало воспроизведения аудио чанка`);
          
          const playPromise = audio.play();
          
          if (playPromise !== undefined) {
            playPromise.catch(error => {
              widgetLog(`Ошибка воспроизведения: ${error.message}`, "error");
              
              if (error.name === 'NotAllowedError') {
                if (isIOS && iosAudioButton) {
                  iosAudioButton.classList.add('visible');
                  showMessage("Нажмите кнопку для активации звука", 0);
                  
                  iosAudioButton.onclick = function() {
                    unlockAudioOnIOS().then(() => {
                      iosAudioButton.classList.remove('visible');
                      audio.play().catch(() => playNextAudio());
                    });
                  };
                }
              } else {
                playNextAudio();
              }
            });
          }
        };
        
        audio.onplay = function() {
          startTime = Date.now();
          widgetLog(`[INTERRUPTION] Начало воспроизведения аудио чанка: ${totalSamples} семплов`);
        };
        
        audio.onended = function() {
          widgetLog(`[INTERRUPTION] Завершение воспроизведения аудио чанка`);
          
          samplesPlayedSoFar += totalSamples;
          
          URL.revokeObjectURL(audioUrl);
          playNextAudio();
        };
        
        audio.onerror = function() {
          widgetLog('Ошибка воспроизведения аудио', 'error');
          URL.revokeObjectURL(audioUrl);
          playNextAudio();
        };
        
        if (isIOS) {
          unlockAudioOnIOS().then(() => {
            const playPromise = audio.play();
            if (playPromise) {
              playPromise.catch(() => playNextAudio());
            }
          });
        } else {
          const playPromise = audio.play();
          if (playPromise) {
            playPromise.catch(() => playNextAudio());
          }
        }
      } catch (error) {
        widgetLog(`Ошибка воспроизведения аудио: ${error.message}`, "error");
        playNextAudio();
      }
    }
    
    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') return;
      
      audioPlaybackQueue.push(audioBase64);
      
      if (!isPlayingAudio) {
        playNextAudio();
      }
    }

    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
      
      if (reconnectAttempts >= maxAttempts) {
        widgetLog('Maximum reconnection attempts reached');
        isReconnecting = false;
        connectionFailedPermanently = true;
        
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение. Попробуйте перезагрузить страницу.");
          updateConnectionStatus('disconnected', 'Отключено');
        } else {
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        return;
      }
      
      isReconnecting = true;
      
      if (isWidgetOpen) {
        showMessage("Соединение прервано. Переподключение...", 0);
        updateConnectionStatus('connecting', 'Переподключение...');
      }
      
      const delay = initialDelay > 0 ? 
                initialDelay : 
                isMobile ? 
                    Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) :
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
      
      reconnectAttempts++;
      
      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);
      
      setTimeout(() => {
        if (isReconnecting) {
          connectWebSocket().then(success => {
            if (success) {
              reconnectAttempts = 0;
              isReconnecting = false;
              
              if (isWidgetOpen) {
                showMessage("Соединение восстановлено", 3000);
                updateConnectionStatus('connected', 'Подключено');
                
                setTimeout(() => {
                  if (isWidgetOpen && !isListening) {
                    if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
                      if (iosAudioButton) {
                        iosAudioButton.classList.add('visible');
                      }
                      showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                    } else {
                      startListening();
                    }
                  }
                }, 1000);
              }
            } else {
              isReconnecting = false;
            }
          }).catch(() => {
            isReconnecting = false;
          });
        }
      }, delay);
    }
    
    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      try {
        loaderModal.classList.add('active');
        widgetLog("Подключение...");
        
        isReconnecting = true;
        
        hideConnectionError();
        
        if (!ASSISTANT_ID) {
          widgetLog('Assistant ID not found!', 'error');
          showMessage("Ошибка: ID ассистента не указан. Проверьте код встраивания.");
          loaderModal.classList.remove('active');
          return false;
        }
        
        widgetLog(`Connecting to WebSocket at: ${WS_URL}`);
        
        if (websocket) {
          try {
            websocket.close();
          } catch (e) {
            // Игнорируем ошибки при закрытии
          }
        }
        
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }
        
        websocket = new WebSocket(WS_URL);
        
        websocket.binaryType = 'arraybuffer';
        
        connectionTimeout = setTimeout(() => {
          widgetLog("Превышено время ожидания соединения", "error");
          
          if (websocket) {
            websocket.close();
          }
          
          isReconnecting = false;
          loaderModal.classList.remove('active');
          
          reconnectAttempts++;
          
          const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
          
          if (reconnectAttempts >= maxAttempts) {
            connectionFailedPermanently = true;
            
            if (isWidgetOpen) {
              showConnectionError("Не удалось подключиться к серверу");
              updateConnectionStatus('disconnected', 'Отключено');
            } else {
              widgetButton.classList.add('wellcomeai-pulse-animation');
            }
          } else {
            reconnectWithDelay(2000);
          }
        }, CONNECTION_TIMEOUT);
        
        // Обработка открытия соединения
        websocket.onopen = () => {
          widgetLog('WebSocket connection established');
          
          isConnected = true;
          isReconnecting = false;
          connectionFailedPermanently = false;
          reconnectAttempts = 0;
          
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          
          loaderModal.classList.remove('active');
          
          if (pingInterval) {
            clearInterval(pingInterval);
          }
          
          const pingIntervalMs = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
          
          pingInterval = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
              lastPingTime = Date.now();
              websocket.send(JSON.stringify({
                type: "ping",
                timestamp: lastPingTime
              }));
            }
          }, pingIntervalMs);
          
          lastPongTime = Date.now();
          
          if (isWidgetOpen) {
            if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
              if (iosAudioButton) {
                iosAudioButton.classList.add('visible');
              }
              showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
              updateConnectionStatus('connected', 'Подключено');
            } else {
              if (!isListening && !isPlayingAudio) {
                startListening();
              }
              updateConnectionStatus('connected', 'Подключено');
            }
          } else {
            widgetButton.classList.add('wellcomeai-pulse-animation');
          }
          
          hideConnectionError();
        };
        
        // ИСПРАВЛЕННАЯ ОБРАБОТКА СООБЩЕНИЙ от сервера
        websocket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const msgType = data.type;
            
            widgetLog(`Получено сообщение типа: ${msgType}`);
            
            // Обработка пинга/понга
            if (msgType === "pong") {
              lastPongTime = Date.now();
              return;
            }
            
            if (msgType === "connection_status") {
              if (data.status === "connected") {
                updateConnectionStatus('connected', 'Подключено');
              }
              return;
            }
            
            // КРИТИЧЕСКИ ВАЖНАЯ ОБРАБОТКА response.created
            if (msgType === 'response.created') {
              // ИСПРАВЛЕННОЕ извлечение ID ответа
              const responseId = data.response?.id || data.id;
              
              if (responseId) {
                currentResponseId = responseId;
                samplesPlayedSoFar = 0;
                audioSamplesExpected = 0;
                widgetLog(`[INTERRUPTION] Начало нового ответа (created): ${currentResponseId}`);
                
                interruptionDiag.log('response_created', {
                  responseId: currentResponseId,
                  dataStructure: Object.keys(data)
                });
              } else {
                widgetLog(`[INTERRUPTION] WARNING: response.created без ID: ${JSON.stringify(data)}`, 'warn');
              }
              return;
            }
            
            // Дополнительная проверка через response.output_item.added
            if (msgType === 'response.output_item.added') {
              const itemId = data.item?.id;
              if (itemId && !currentResponseId) {
                currentResponseId = itemId;
                samplesPlayedSoFar = 0;
                audioSamplesExpected = 0;
                widgetLog(`[INTERRUPTION] Начало ответа через output_item: ${currentResponseId}`);
              }
              return;
            }
            
            // ИСПРАВЛЕННАЯ ОБРАБОТКА аудио-дельт
            if (msgType === 'response.audio.delta') {
              const chunkResponseId = data.item_id || data.response_id;
              
              // Устанавливаем currentResponseId если его нет
              if (!currentResponseId && chunkResponseId) {
                currentResponseId = chunkResponseId;
                samplesPlayedSoFar = 0;
                audioSamplesExpected = 0;
                widgetLog(`[INTERRUPTION] ID ответа установлен через audio.delta: ${currentResponseId}`);
              }
              
              if (data.delta) {
                const audioData = base64ToArrayBuffer(data.delta);
                audioSamplesExpected += audioData.byteLength / 2;
                
                interruptionDiag.log('audio_delta_received', {
                  itemId: chunkResponseId,
                  currentResponseId: currentResponseId,
                  deltaSize: data.delta ? data.delta.length : 0,
                  totalExpectedSamples: audioSamplesExpected
                });
                
                addAudioToPlaybackQueue(data.delta);
              }
              return;
            }
            
            // НОВАЯ ОБРАБОТКА response.cancel.ack
            if (msgType === 'response.cancel.ack') {
              widgetLog(`[INTERRUPTION] Получен response.cancel.ack: success=${data.success}`);
              
              interruptionDiag.log('cancel_ack_received', {
                success: data.success,
                originalItemId: data.original_item_id,
                originalSampleCount: data.original_sample_count,
                originalWasPlaying: data.original_was_playing
              });
              
              if (data.success === true) {
                // ФИНАЛИЗИРУЕМ ПРЕРЫВАНИЕ с данными из ACK
                finalizeInterruption(
                  data.original_item_id,
                  data.original_sample_count,
                  data.original_was_playing
                );
              } else {
                widgetLog(`[INTERRUPTION] Cancel неуспешен: ${data.error || 'неизвестная ошибка'}`, 'warn');
                
                // Все равно сбрасываем состояние при неудачном cancel
                setTimeout(() => {
                  forceResetState();
                  
                  if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({
                      type: "input_audio_buffer.clear",
                      event_id: `clear_${Date.now()}`
                    }));
                  }
                  
                  if (isWidgetOpen && isConnected) {
                    isListening = false;
                    startListening();
                  }
                }, 300);
              }
              return;
            }
            
            // Обработка output_audio_buffer.clear.ack
            if (msgType === 'output_audio_buffer.clear.ack') {
              widgetLog(`[INTERRUPTION] Output buffer cleared: success=${data.success}`);
              if (!data.success) {
                widgetLog(`[INTERRUPTION] Output buffer clear failed: ${data.error}`, 'warn');
              }
              return;
            }
            
            // Обработка conversation.item.truncate.ack
            if (msgType === 'conversation.item.truncate.ack') {
              widgetLog(`[INTERRUPTION] Item truncated: success=${data.success}`);
              if (!data.success) {
                widgetLog(`[INTERRUPTION] Item truncate failed: ${data.error}`, 'warn');
              }
              return;
            }
            
            // ОБРАБОТКА ЗАВЕРШЕНИЯ ОТВЕТА
            if (msgType === 'response.done') {
              const responseId = data.response?.id || data.id;
              widgetLog(`[INTERRUPTION] Завершение ответа: ${responseId}`);
              
              interruptionDiag.log('response_done', {
                responseId: responseId
              });
              
              // НЕ сбрасываем currentResponseId здесь, так как аудио может еще воспроизводиться
              return;
            }
            
            // Обработка ошибок
            if (msgType === 'error') {
              const errorMessage = data.error?.message || data.message || "Неизвестная ошибка";
              widgetLog(`Ошибка от сервера: ${errorMessage}`, "error");
              
              // Специальная обработка ошибок отмены
              if (errorMessage.toLowerCase().includes('cancel') || errorMessage.toLowerCase().includes('response')) {
                widgetLog(`[INTERRUPTION] Ошибка отмены от сервера: ${errorMessage}`, 'warn');
                
                // Принудительно сбрасываем состояние при ошибке отмены
                setTimeout(() => {
                  forceResetState();
                  
                  if (isWidgetOpen && isConnected && !isListening) {
                    isListening = false;
                    startListening();
                  }
                }, 500);
              }
              
              showMessage(errorMessage);
              return;
            }
            
            // Обработка транскрипций
            if (msgType === 'conversation.item.input_audio_transcription.completed') {
              if (data.transcript && data.transcript.trim()) {
                widgetLog(`Транскрипция: ${data.transcript}`);
              }
              return;
            }
            
            // Обработка текстовых дельт (для отображения)
            if (msgType === 'response.content_part.added' && data.part?.text) {
              // Можно добавить отображение текста
              return;
            }
            
            // Обработка других событий сессии
            if (msgType === 'session.created' || msgType === 'session.updated') {
              widgetLog(`Сессия ${msgType}: обновлена конфигурация`);
              return;
            }
            
            // Логируем неизвестные типы сообщений
            if (DEBUG_MODE) {
              widgetLog(`Необработанное сообщение типа: ${msgType}`, 'warn');
            }
            
          } catch (error) {
            widgetLog(`Ошибка парсинга сообщения: ${error.message}`, "error");
          }
        };
        
        // Обработка закрытия соединения
        websocket.onclose = (event) => {
          widgetLog(`WebSocket closed: code=${event.code}, reason=${event.reason}`);
          
          isConnected = false;
          
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          
          if (audioContext && audioContext.state !== 'closed') {
            try {
              if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
              }
            } catch (e) {
              // Игнорируем ошибки
            }
          }
          
          stopAllAudioProcessing();
          
          loaderModal.classList.remove('active');
          
          if (!connectionFailedPermanently && !event.wasClean) {
            if (isWidgetOpen) {
              updateConnectionStatus('disconnected', 'Отключено');
            }
            
            reconnectWithDelay();
          }
        };
        
        // Обработка ошибок соединения
        websocket.onerror = (error) => {
          widgetLog(`WebSocket error: ${error}`, "error");
          
          isConnected = false;
          
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          
          loaderModal.classList.remove('active');
        };
        
        return true;
        
      } catch (error) {
        widgetLog(`Ошибка подключения WebSocket: ${error.message}`, "error");
        
        isReconnecting = false;
        isConnected = false;
        
        loaderModal.classList.remove('active');
        
        const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
        
        if (reconnectAttempts < maxAttempts) {
          reconnectWithDelay(3000);
        } else {
          connectionFailedPermanently = true;
          
          if (isWidgetOpen) {
            showConnectionError("Ошибка подключения к серверу");
            updateConnectionStatus('disconnected', 'Ошибка подключения');
          }
        }
        
        return false;
      }
    }
    
    // Обработчики событий
    widgetButton.addEventListener('click', function() {
      widgetLog("Button clicked");
      
      if (connectionFailedPermanently) {
        resetConnection();
        return;
      }
      
      openWidget();
    });
    
    widgetClose.addEventListener('click', function() {
      closeWidget();
    });
    
    if (retryButton) {
      retryButton.addEventListener('click', function() {
        resetConnection();
      });
    }
    
    // ЭКСПОРТ ДИАГНОСТИКИ для отладки
    if (diagButton) {
      diagButton.addEventListener('click', function() {
        const logData = interruptionDiag.exportLog();
        const blob = new Blob([logData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `interruption-diag-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        widgetLog('Диагностика экспортирована');
      });
    }
    
    // Глобальные функции для отладки
    window.exportInterruptionLog = function() {
      const logData = interruptionDiag.exportLog();
      const blob = new Blob([logData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `interruption-debug-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      console.log('Interruption diagnostics exported');
      return logData;
    };
    
    window.getInterruptionState = function() {
      return {
        currentResponseId,
        samplesPlayedSoFar,
        audioSamplesExpected,
        isPlayingAudio,
        isListening,
        isConnected,
        soundDetectionCounter,
        lastInterruptionTime,
        isInEchoSuppressionPeriod,
        config: INTERRUPTION_CONFIG
      };
    };
    
    window.testInterruption = function() {
      // Тестовая функция для проверки прерывания
      const testConfig = { ...INTERRUPTION_CONFIG };
      testConfig.soundDetectionThreshold = 0.001;
      testConfig.consecutiveDetections = 1;
      
      console.log('Test mode activated - говорите для тестирования детекции');
      
      // Временно заменяем конфигурацию
      Object.assign(INTERRUPTION_CONFIG, testConfig);
      
      setTimeout(() => {
        widgetLog('Тестовый режим детекции отключен через 30 секунд');
      }, 30000);
    };
    
    // Отображение состояния после DOM загрузки
    setTimeout(() => {
      const containerDiv = document.getElementById('wellcomeai-widget-container');
      if (containerDiv) {
        widgetLog("DOM check after initialization");
        widgetLog(`Container z-index = ${getComputedStyle(containerDiv).zIndex}`);
        widgetLog(`Button is visible = ${getComputedStyle(widgetButton).visibility !== 'hidden'}`);
        widgetLog(`Connection state = ${websocket ? websocket.readyState : 'no websocket'}`);
        widgetLog(`Status flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}`);
        widgetLog(`[INTERRUPTION] Variables: currentResponseId=${currentResponseId}, samplesPlayedSoFar=${samplesPlayedSoFar}, soundDetectionCounter=${soundDetectionCounter}`);
      }
    }, 1000);
    
    // Автоматическое подключение
    connectWebSocket();
  }

  // Функция инициализации
  function initialize() {
    widgetLog("Starting initialization process");
    
    if (document.getElementById('wellcomeai-widget-container')) {
      widgetLog("Widget already exists on the page, skipping initialization");
      return;
    }
    
    loadFontAwesome();
    createStyles();
    createWidgetHTML();
    initWidget();
    
    widgetLog("Initialization complete - исправленное мгновенное прерывание ассистента активировано");
  }

  // Проверяем готовность DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    widgetLog("DOM already loaded, initializing immediately");
    initialize();
  }

})();
