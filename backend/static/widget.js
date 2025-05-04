(function() {
  // Настройки виджета
  const DEBUG_MODE = false; // Отключаем режим отладки в продакшене
  const MAX_RECONNECT_ATTEMPTS = 5; // Максимальное количество попыток переподключения
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10; // Увеличенное количество попыток для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 20000; // Таймаут для установления соединения (в миллисекундах)
  const MAX_DEBUG_ITEMS = 10; // Максимальное количество записей отладки

  // Глобальное хранение состояния (перемещены на верхний уровень)
  let reconnectAttempts = 0;
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];

  // Определяем тип устройства (скорректированы regex)
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent); // Отдельно для Android
  const isMobile = isIOS || isAndroid || /Poco|mi|Redmi|GT/i.test(navigator.userAgent); // Проверяем и Android-подобные в userAgent

  // Глобальные флаги для мобильных устройств (особенно iOS)
  window.audioContextInitialized = false;
  window.tempAudioContext = null; // Используется для iOS разблокировки
  window.hasPlayedSilence = false; // Флаг, что тишина была воспроизведена для iOS

  // Аудио переменные (перемещены на верхний уровень)
  // let audioChunksBuffer = []; // Не используется в текущей логике отправки по тишине, можно убрать
  let audioPlaybackQueue = []; // Очередь для воспроизведения аудио с сервера
  let isPlayingAudio = false; // Флаг активного воспроизведения с сервера
  let hasAudioData = false; // Флаг, что были обнаружены голосовые данные после начала прослушивания
  let audioDataStartTime = 0; // Время начала обнаружения голосовых данных
  let minimumAudioLength = 300; // Минимальная длина аудио (мс) для начала определения тишины после голоса
  let isListening = false; // Флаг активной записи с микрофона
  let websocket = null; // WebSocket объект
  let audioContext = null; // AudioContext
  let mediaStream = null; // MediaStream с микрофона
  let audioProcessor = null; // ScriptProcessorNode или AudioWorkletNode
  let isConnected = false; // Флаг активного WebSocket соединения
  let isWidgetOpen = false; // Флаг открытого виджета
  let connectionFailedPermanently = false; // Флаг постоянной ошибки соединения
  let lastPingTime = Date.now(); // Время последнего пинга
  let lastCommitTime = 0; // Время последней отправки буфера на сервер
  let voiceDetector = null; // Экземпляр VoiceActivityDetector
  let shouldRestoreMicrophoneAfterPlayback = false; // Флаг для iOS: нужно ли восстановить микрофон после воспроизведения
  let androidMicMonitorIntervalId = null; // ID интервала для мониторинга микрофона на Android

  // UI элементы (объявляем здесь, присваиваем в initWidget)
  let widgetContainer = null;
  let widgetButton = null;
  let widgetClose = null;
  let mainCircle = null;
  let audioBars = null;
  let loaderModal = null;
  let messageDisplay = null;
  let connectionError = null;
  let retryButton = null;
  let statusIndicator = null;
  let statusDot = null;
  let statusText = null;
  let iosAudioButton = null;

  // Конфигурация для оптимизации потока аудио
  const AUDIO_CONFIG = {
    silenceThreshold: 0.01, // Порог для определения тишины
    silenceDuration: 300, // Длительность тишины для отправки (мс)
    bufferCheckInterval: 50, // Частота проверки буфера (мс) - НЕ ИСПОЛЬЗУЕТСЯ В ЭТОМ КОДЕ ЯВНО
    soundDetectionThreshold: 0.02 // Чувствительность к звуку для VAD (только для desktop fallback)
  };

  // Специальные настройки для мобильных устройств (Android)
  const ANDROID_AUDIO_CONFIG = {
    silenceThreshold: 0.018, // Специальный порог для Android
    silenceDuration: 600, // Оптимизированная длительность тишины
    bufferCheckInterval: 80, // НЕ ИСПОЛЬЗУЕТСЯ
    soundDetectionThreshold: 0.02 // Менее чувствительное определение для Android VAD
  };

  // Отдельные настройки для iOS
  const IOS_AUDIO_CONFIG = {
    silenceThreshold: 0.012, // Более низкий порог для iOS
    silenceDuration: 800, // Увеличенная длительность тишины
    bufferCheckInterval: 120, // НЕ ИСПОЛЬЗУЕТСЯ
    soundDetectionThreshold: 0.01 // Более чувствительное определение звука для iOS VAD
  };

  // Выбираем нужную конфигурацию в зависимости от устройства
  const effectiveAudioConfig = isIOS ?
    IOS_AUDIO_CONFIG :
    (isMobile ? ANDROID_AUDIO_CONFIG : AUDIO_CONFIG);

  // --- Вспомогательные функции (перемещены на верхний уровень) ---

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info') => {
    // На сервере Render будет доступен объект global (для серверной части виджета)
    // Этот код выполняется в браузере, поэтому проверяем window
    if (typeof window !== 'undefined' && window.location) {
      const logPrefix = '[WellcomeAI Widget]';
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;

      if (DEBUG_MODE || type === 'error' || type === 'warn') {
        if (type === 'error') {
          console.error(`${logPrefix} ERROR:`, message);
        } else if (type === 'warn') {
          console.warn(`${logPrefix} WARNING:`, message);
        } else if (DEBUG_MODE) {
          console.log(`${logPrefix}`, message);
        }
      } else {
        // В продакшене логируем только ошибки и предупреждения, если DEBUG_MODE = false
        if (type === 'error' || type === 'warn') {
           console.log(`${logPrefix} ${formattedMessage}`); // Или console.error/warn
        }
      }
    }
  };

  // Функция для отслеживания ошибок (упрощена без отладочной панели)
  const addToDebugQueue = (message, type = 'info') => {
    if (!DEBUG_MODE) return; // Пропускаем в рабочем режиме

    const timestamp = new Date().toISOString();
    debugQueue.push({
      timestamp,
      message,
      type
    });

    // Ограничиваем размер очереди
    if (debugQueue.length > MAX_DEBUG_ITEMS) {
      debugQueue.shift();
    }
     updateDebugPanel(); // Обновляем панель, если DEBUG_MODE включен
  };

  // Получить отладочную информацию в виде строки
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  // Обновление отладочной панели (стабы для совместимости)
  const updateDebugPanel = () => {
    if (!DEBUG_MODE) return;
    // TODO: Здесь должна быть логика обновления UI отладочной панели
    // Для текущей версии просто логируем в консоль через widgetLog
    widgetLog("Debug panel update called (stub).", "debug");
  };


  // Функция для определения URL сервера
  const getServerUrl = () => {
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;

    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-server') || (scriptTags[i].dataset && scriptTags[i].dataset.server)) {
        serverUrl = scriptTags[i].getAttribute('data-server') || scriptTags[i].dataset.server;
        widgetLog(`Found server URL from data-server attribute: ${serverUrl}`);
        break;
      }

      const src = scriptTags[i].getAttribute('src');
      if (src && src.includes('widget.js')) {
        try {
          const url = new URL(src, window.location.href);
          serverUrl = url.origin;
          widgetLog(`Extracted server URL from script src: ${serverUrl}`);
          break;
        } catch (e) {
          widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');
          if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) {
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
      if (scriptTags[i].hasAttribute('data-position') || (scriptTags[i].dataset && scriptTags[i].dataset.position)) {
        return parsePosition(scriptTags[i].getAttribute('data-position') || scriptTags[i].dataset.position);
      }
    }

    return defaultPosition;

    function parsePosition(positionString) {
      const position = { ...defaultPosition
      };
      if (!positionString) return position;
      const parts = positionString.split('-');
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

  // Формируем WebSocket URL с указанием ID ассистента
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID;

  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isAndroid ? 'Android' : 'Desktop')}, Mobile: ${isMobile}`);


  // Создаем стили для виджета
  function createStyles() {
    if (document.getElementById('wellcomeai-widget-styles')) {
        //widgetLog("Styles already exist.", "debug");
        return;
    }
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
        z-index: 2147483647;
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
      
      /* Кнопка принудительной активации аудио для iOS */
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
    // Проверяем, не создан ли уже контейнер виджета
    if (document.getElementById('wellcomeai-widget-container')) {
        //widgetLog("Widget HTML already exists.", "debug");
        return;
    }

    widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647"; // Высокий z-index

    let widgetHTML = `
      <!-- Кнопка (минимизированное состояние) -->
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button">
        <i class="fas fa-robot wellcomeai-widget-icon"></i>
      </div>
      
      <!-- Развернутый виджет -->
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">WellcomeAI</div>
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <!-- Основной элемент - круг с иконкой микрофона -->
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>
            
            <!-- Аудио визуализация -->
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>
          
          <!-- Сообщение -->
          <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>
          
          <!-- Сообщение об ошибке соединения -->
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error">
            <span>Ошибка соединения с сервером</span>
            <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
              Повторить подключение
            </button>
          </div>
          
          <!-- Специальная кнопка для активации аудио на iOS -->
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
            Нажмите для активации аудио
          </button>
          
          <!-- Индикатор статуса -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Подключено</span>
          </div>
        </div>
      </div>
      
      <!-- Модальное окно загрузки -->
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active">
        <div class="wellcomeai-loader"></div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);
    widgetLog("HTML structure created and appended to body");
  }

  // Класс для определения голосовой активности (перемещен)
  class VoiceActivityDetector {
    constructor(options = {}) {
      this.threshold = options.threshold || 0.015;
      this.minSilenceDuration = options.minSilenceDuration || 1000;
      this.minSpeechDuration = options.minSpeechDuration || 300;
      this.smoothingFactor = options.smoothingFactor || 0.2;

      this.lastVoiceDetection = 0;
      this.silenceStartTime = 0;
      this.isSilent = true;
      this.averageVolume = 0;
      this.isFirstFrame = true;
      this.activeFrameCount = 0;
      this.totalFrameCount = 0;
      this.hasVoiceActivity = false;

      // Адаптивный порог определения голоса
      this.adaptiveThreshold = this.threshold;
      this.backgroundNoiseLevel = 0;
      this.backgroundSamples = [];
    }

    // Обработка нового аудиофрейма
    process(audioData) {
      if (!audioData || audioData.length === 0) return { volume: 0, threshold: this.adaptiveThreshold, hasVoice: false, isSilent: true, silenceDuration: Date.now() - this.lastVoiceDetection, hasVoiceActivity: this.hasVoiceActivity };

      let sumSquares = 0;
      for (let i = 0; i < audioData.length; i++) {
        sumSquares += audioData[i] * audioData[i];
      }
      const rms = Math.sqrt(sumSquares / audioData.length);

      if (this.isFirstFrame) {
        this.averageVolume = rms;
        this.isFirstFrame = false;
      } else {
        this.averageVolume = this.averageVolume * (1 - this.smoothingFactor) + rms * this.smoothingFactor;
      }

      this.totalFrameCount++;

      if (this.totalFrameCount < 50) {
        this.backgroundSamples.push(rms);
        if (this.backgroundSamples.length > 20) {
          const sortedSamples = [...this.backgroundSamples].sort((a, b) => a - b);
          const backgroundSampleCount = Math.floor(sortedSamples.length * 0.3);
          if (backgroundSampleCount > 0) {
            let sum = 0;
            for (let i = 0; i < backgroundSampleCount; i++) {
              sum += sortedSamples[i];
            }
            this.backgroundNoiseLevel = sum / backgroundSampleCount;
            this.adaptiveThreshold = Math.max(this.threshold, this.backgroundNoiseLevel * 2.5);
             //widgetLog(`VAD Adaptive Threshold updated: ${this.adaptiveThreshold.toFixed(4)} (Noise: ${this.backgroundNoiseLevel.toFixed(4)})`, "debug");
          }
        }
      }

      const now = Date.now();
      const hasVoice = this.averageVolume > this.adaptiveThreshold;

      if (hasVoice) {
        this.activeFrameCount++;
        this.lastVoiceDetection = now;
        if (this.isSilent) {
          this.isSilent = false;
        }
      } else if (!this.isSilent) {
        const silenceDuration = now - this.lastVoiceDetection;
        if (silenceDuration > this.minSilenceDuration) {
          this.isSilent = true;
          this.silenceStartTime = this.lastVoiceDetection;
           //widgetLog(`VAD: Silence detected after ${this.minSilenceDuration}ms. Average Volume: ${this.averageVolume.toFixed(4)}`, "debug");
        }
      }

      const voiceRatio = this.activeFrameCount / Math.max(1, this.totalFrameCount);
      this.hasVoiceActivity = voiceRatio > 0.05 && this.activeFrameCount > 10;

      return {
        volume: this.averageVolume,
        threshold: this.adaptiveThreshold,
        hasVoice: hasVoice,
        isSilent: this.isSilent,
        silenceDuration: this.isSilent ? now - this.lastVoiceDetection : 0,
        hasVoiceActivity: this.hasVoiceActivity
      };
    }

    // Сброс детектора
    reset() {
      this.lastVoiceDetection = 0;
      this.silenceStartTime = 0;
      this.isSilent = true;
      this.averageVolume = 0;
      this.isFirstFrame = true;
      this.activeFrameCount = 0;
      this.totalFrameCount = 0;
      this.hasVoiceActivity = false;
      this.backgroundSamples = [];
      this.adaptiveThreshold = this.threshold;
      this.backgroundNoiseLevel = 0;
       widgetLog("VAD reset.", "debug");
    }
  }


  // Функция для разблокировки аудио на iOS (перемещена)
  function unlockAudioOnIOS() {
    if (!isIOS) return Promise.resolve(true);

    widgetLog('Попытка разблокировки аудио на iOS');

    return new Promise((resolve) => {
      const tempAudio = document.createElement('audio');
      tempAudio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
      tempAudio.volume = 0;
      tempAudio.muted = true; // Ensure muted
      tempAudio.play().then(() => {
        widgetLog('Успешно разблокировано аудио через элемент audio');
        // Try to resume AudioContext if it exists
         if (window.tempAudioContext && window.tempAudioContext.state === 'suspended') {
            window.tempAudioContext.resume().then(() => {
              window.audioContextInitialized = true;
              window.hasPlayedSilence = true;
              widgetLog('AudioContext успешно активирован (возобновлен)');
              resolve(true);
            }).catch(err => {
              widgetLog(`Не удалось активировать AudioContext (resume): ${err.message}`, 'error');
              window.audioContextInitialized = false;
              resolve(false);
            });
          } else if (window.tempAudioContext && window.tempAudioContext.state === 'running') {
             // Already running
             window.audioContextInitialized = true;
             window.hasPlayedSilence = true;
             widgetLog('AudioContext уже running.');
             resolve(true);
          } else {
             // No tempAudioContext or it was closed. Audio context init will create a new one later.
             widgetLog('No active tempAudioContext found after audio element play.', 'debug');
             window.audioContextInitialized = false; // We don't know if it's initialized yet
             window.hasPlayedSilence = true; // But the audio element play might count
             resolve(true); // Consider this attempt partially successful, proceed
          }
      }).catch(err => {
        widgetLog(`Ошибка при play() аудио для разблокировки: ${err.message}`, 'error');
        window.audioContextInitialized = false;
        window.hasPlayedSilence = false; // Play failed, didn't play silence
        resolve(false);
      });
    });
  }

    // Функция для форсированной разблокировки аудио на iOS (через тоны, перемещена)
  function forceIOSAudioUnlock() {
    if (!isIOS) return Promise.resolve(true);

    widgetLog('Попытка форсированной разблокировки аудио на iOS (через тоны)');

    return new Promise((resolve) => {
      const frequencies = [100, 200, 300];
      let index = 0;

      function playNextTone() {
        if (window.audioContextInitialized && window.hasPlayedSilence) {
          widgetLog('AudioContext уже активирован, остановка воспроизведения тонов.');
          resolve(true);
          return;
        }

        if (index >= frequencies.length) {
          widgetLog('Завершены попытки воспроизведения тонов.');
          resolve(window.audioContextInitialized);
          return;
        }

        try {
          if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
             try {
                window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                widgetLog('Создан новый AudioContext для форсированной разблокировки тонами');
             } catch (e) {
                  widgetLog(`Ошибка создания AudioContext при форсированной разблокировке: ${e.message}`, 'error');
                  window.audioContextInitialized = false;
                  resolve(false);
                  return;
             }
          }

          const ctx = window.tempAudioContext;

          if (ctx.state === 'suspended') {
            widgetLog(`AudioContext suspended, пытаемся возобновить для тона ${frequencies[index]}Hz`);
            ctx.resume().then(() => {
              window.audioContextInitialized = true;
              widgetLog('AudioContext успешно возобновлен для воспроизведения тонов.');
              scheduleTone(ctx, frequencies[index]);
              index++;
              setTimeout(playNextTone, 200);
            }).catch(err => {
              widgetLog(`Не удалось возобновить AudioContext для тона ${frequencies[index]}Hz: ${err.message}`, 'warn');
              window.audioContextInitialized = false;
              index++;
              setTimeout(playNextTone, 200);
            });
          } else {
            widgetLog(`AudioContext running, воспроизводим тон ${frequencies[index]}Hz`);
            window.audioContextInitialized = true;
            scheduleTone(ctx, frequencies[index]);
            index++;
            setTimeout(playNextTone, 200);
          }
        } catch (e) {
          widgetLog(`Ошибка при воспроизведении тонов: ${e.name}: ${e.message}`, 'warn');
          window.audioContextInitialized = false;
          index++;
          setTimeout(playNextTone, 200);
        }
      }

      function scheduleTone(ctx, frequency) {
           try {
               const oscillator = ctx.createOscillator();
               const gainNode = ctx.createGain();
               gainNode.gain.value = 0.01;
               oscillator.type = 'sine';
               oscillator.frequency.value = frequency;
               oscillator.connect(gainNode);
               gainNode.connect(ctx.destination);
               const startTime = ctx.currentTime;
               oscillator.start(startTime);
               oscillator.stop(startTime + 0.05);
           } catch (e) {
                widgetLog(`Ошибка при планировании тона ${frequency}Hz: ${e.name}: ${e.message}`, 'error');
           }
      }
      playNextTone();
    });
  }


  // Воспроизведение тишины (резервная функция для iOS, перемещена)
  function playSilence() {
    try {
       if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
         try {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            widgetLog('Создан новый AudioContext для playSilence');
         } catch (e) {
              widgetLog(`Ошибка создания AudioContext для playSilence: ${e.message}`, 'error');
              window.audioContextInitialized = false;
              return;
         }
       }

      const ctx = window.tempAudioContext;
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = silentBuffer;
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      source.start(0);
      source.stop(0.001);

      window.hasPlayedSilence = true;
      widgetLog("Played silence to unlock audio on iOS");

      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          window.audioContextInitialized = true;
          widgetLog("Audio context successfully resumed on iOS after playing silence");
        }).catch(err => {
          widgetLog(`Failed to resume audio context after playSilence: ${err.message}`, 'error');
          window.audioContextInitialized = false;
        });
      } else {
         window.audioContextInitialized = true;
         widgetLog(`Audio context state after playSilence: ${ctx.state}`);
      }
    } catch (e) {
      widgetLog(`Error playing silence: ${e.name}: ${e.message}`, 'error');
      window.audioContextInitialized = false;
    }
  }

  // Получение оптимизированных настроек для Android (перемещена)
  function getAndroidDeviceType() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.indexOf('samsung') > -1) return 'samsung';
    if (ua.indexOf('pixel') > -1) return 'pixel';
    if (ua.indexOf('xiaomi') > -1) return 'xiaomi';
    if (ua.indexOf('redmi') > -1) return 'redmi';
    if (ua.indexOf('poco') > -1) return 'poco';
    if (ua.indexOf('huawei') > -1) return 'huawei';
    if (ua.indexOf('gt') > -1) return 'realme_gt';
    return 'generic';
  }

  // Функция настройки специфичных параметров для разных Android устройств (перемещена)
  function getOptimizedConstraintsForAndroid() {
    const deviceType = getAndroidDeviceType();
    const baseConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
      channelCount: 1,
      deviceId: 'default'
    };

    // Специфичные настройки для некоторых производителей/моделей, если известны проблемы
    switch (deviceType) {
      case 'samsung':
        // baseConstraints.autoGainControl = false;
        break;
      case 'xiaomi':
      case 'redmi':
      case 'poco':
        // baseConstraints.sampleRate = 48000; // Если 16000 вызывает проблемы
        break;
       case 'realme_gt':
            // Дополнительные проверки
            break;
      default:
        break;
    }

    widgetLog(`Применены оптимизированные настройки для Android устройства типа: ${deviceType}`, 'info', baseConstraints);
    return baseConstraints;
  }


  // Улучшенное качество аудио и нормализация (перемещена)
  function processAudioForUpload(inputData) {
    if (!inputData || inputData.length === 0) return new Float32Array(0);

    const processedData = new Float32Array(inputData.length);
    let maxAmplitude = 0;

    for (let i = 0; i < inputData.length; i++) {
      const absValue = Math.abs(inputData[i]);
      maxAmplitude = Math.max(maxAmplitude, absValue);
      processedData[i] = inputData[i];
    }

     if (maxAmplitude > 0) {
       let gain = 1.0;
       if (maxAmplitude < 0.2) {
           gain = Math.min(3.0, 0.5 / maxAmplitude);
           //widgetLog(`Усиление аудио из-за низкой амплитуды (${maxAmplitude.toFixed(2)}): gain = ${gain.toFixed(2)}`, "debug");
       } else if (maxAmplitude > 0.95) {
            gain = 0.95 / maxAmplitude;
            //widgetLog(`Снижение усиления аудио из-за высокой амплитуды (${maxAmplitude.toFixed(2)}): gain = ${gain.toFixed(2)}`, "debug");
       }

       if (gain !== 1.0) {
           for (let i = 0; i < processedData.length; i++) {
               processedData[i] *= gain;
               processedData[i] = Math.max(-1, Math.min(1, processedData[i]));
           }
       }
    } else {
       return new Float32Array(0);
    }

    return processedData;
  }


  // Функция для остановки записи микрофона (перемещена)
  function stopMicrophoneCapture() {
    if (!mediaStream) {
      //widgetLog("stopMicrophoneCapture: No media stream to stop.", "debug");
      return;
    }

    widgetLog("Stopping microphone capture.");

    mediaStream.getTracks().forEach(track => {
      if (track.kind === 'audio') {
        track.stop();
        //widgetLog(`Stopped audio track: ${track.label}`, "debug");
      }
    });

    if (audioProcessor) {
      try {
        audioProcessor.disconnect();
        //widgetLog("Disconnected audio processor.", "debug");
      } catch (e) {
        widgetLog('Ошибка при отключении аудиопроцессора: ' + e.message, 'warn');
      }
    }

    isListening = false;
    mediaStream = null;
     // audioProcessor = null; // Не обнуляем здесь, может использоваться для re-init
  }

  // Восстановление микрофона после окончания воспроизведения (перемещена)
  function restoreMicrophoneIfNeeded() {
    if (isIOS && shouldRestoreMicrophoneAfterPlayback) {
      widgetLog("Restore microphone needed after playback on iOS.");
      shouldRestoreMicrophoneAfterPlayback = false;

      setTimeout(() => {
        if (isWidgetOpen && isConnected) {
           widgetLog("Attempting to restore microphone capture on iOS.");
           initAudio().then(success => {
             if (success) {
               startListening();
             } else {
                widgetLog("Failed to re-initialize audio after playback on iOS.", "error");
                showMessage("Ошибка восстановления микрофона после ответа.");
             }
           }).catch(e => {
                widgetLog(`Error during re-initialization of audio after playback: ${e.message}`, "error");
                showMessage("Критическая ошибка восстановления аудио.");
           });
        } else {
           widgetLog("Not restoring microphone on iOS because widget is closed or disconnected.", "info");
        }
      }, 300);
    }
  }

  // Улучшенная функция проверки и перезапуска микрофона для Android (перемещена)
  function checkAndroidMicrophoneStatus() {
    if (!isAndroid || !isListening || !mediaStream) return;

    let isAudioActive = false;
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length > 0) {
      audioTracks.forEach(track => {
        if (track.readyState === 'live' && track.enabled) {
          isAudioActive = true;
        } //else { widgetLog(`Mic track state: readyState=${track.readyState}, enabled=${track.enabled}`, "debug"); }
      });
    } //else { widgetLog("checkAndroidMicrophoneStatus: No audio tracks found.", "debug"); }

    if (!isAudioActive) {
      widgetLog('Обнаружен неактивный микрофон на Android, попытка перезапуска...', 'warn');
      stopMicrophoneCapture();

      if (isWidgetOpen && isConnected) {
           widgetLog("Attempting to re-initialize audio stream on Android.");
           initAudio().then(success => {
             if (success) {
                widgetLog("Audio re-initialization successful on Android.");
                startListening();
             } else {
                widgetLog("Failed to re-initialize audio on Android.", "error");
                showMessage("Проблема с доступом к микрофону. Пожалуйста, перезагрузите страницу.");
             }
           }).catch(err => {
                widgetLog(`Error during re-initialization of audio on Android: ${err.message}`, "error");
                showMessage("Критическая ошибка при перезапуске микрофона.");
           });
      } else {
         widgetLog("Not restarting microphone on Android because widget is closed or disconnected.", "info");
      }
    }
  }

  // Запускаем периодическую проверку микрофона для Android (перемещена)
  function startAndroidMicrophoneMonitoring() {
    if (!isAndroid || androidMicMonitorIntervalId) {
       //widgetLog("Android microphone monitoring not needed or already running.", "debug");
       return;
    }

    widgetLog('Запущен мониторинг микрофона для Android (интервал 5с)');
    androidMicMonitorIntervalId = setInterval(checkAndroidMicrophoneStatus, 5000);
  }

   // Остановка мониторинга микрофона для Android
   function stopAndroidMicrophoneMonitoring() {
       if (androidMicMonitorIntervalId) {
           widgetLog("Stopping Android microphone monitoring.");
           clearInterval(androidMicMonitorIntervalId);
           androidMicMonitorIntervalId = null;
       }
   }


  // Настройка процессора обработки аудио (перемещена)
  function configureAudioProcessor() {
    if (!audioProcessor) {
       widgetLog("configureAudioProcessor called but audioProcessor is null.", "error");
       return;
    }

    widgetLog("Configuring audio processor onaudioprocess handler.");

    audioProcessor.onaudioprocess = function(e) {
      if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting && !isPlayingAudio) {
        const inputBuffer = e.inputBuffer;
        const rawInputData = inputBuffer.getChannelData(0);

        if (rawInputData.length === 0) {
           resetAudioVisualization();
           return;
        }

        const processedData = processAudioForUpload(rawInputData);
        const vadResult = voiceDetector.process(processedData);
        updateAudioVisualization(processedData);

        const pcm16Data = new Int16Array(processedData.length);
        for (let i = 0; i < processedData.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(processedData[i] * 32767)));
        }

        try {
          if (websocket.readyState === WebSocket.OPEN) {
              const message = JSON.stringify({
                type: "input_audio_buffer.append",
                event_id: `audio_${Date.now()}`,
                audio: arrayBufferToBase64(pcm16Data.buffer)
              });
              websocket.send(message);
              //widgetLog(`Sent append message (${pcm16Data.length} samples).`, "debug");
          }
        } catch (error) {
          widgetLog(`Ошибка отправки аудио буфера через WebSocket: ${error.name}: ${error.message}`, "error");
        }

        const now = Date.now();
        if (vadResult.hasVoice) {
          // Сбрасываем время начала тишины
          voiceDetector.silenceStartTime = now; // Сброс таймера тишины в VAD

          // Активируем визуальное состояние прослушивания, если не воспроизводится аудио
          if (!isPlayingAudio && !mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking')) {
            mainCircle.classList.add('listening');
          }
           // Устанавливаем флаг, что голос был в текущем сегменте
           hasAudioData = true;
           if (audioDataStartTime === 0) { // Если это первое обнаружение голоса в сегменте
               audioDataStartTime = now;
               widgetLog("Начало обнаружения голосовых данных (hasAudioData = true, audioDataStartTime set)");
           }

        } else { // Тишина
           const silenceDuration = now - voiceDetector.lastVoiceDetection; // Используем lastVoiceDetection для отсчета тишины

           if (hasAudioData && silenceDuration > effectiveAudioConfig.silenceDuration) {
             // Если были голосовые данные, сейчас тишина, и тишина длится дольше порога
             // Также добавляем проверку, что с момента последнего commit прошло достаточно времени
             if (now - lastCommitTime > 500) {
               widgetLog(`Обнаружена тишина после голоса. Длительность тишины: ${silenceDuration}мс. Длительность сегмента с голосом: ${now - audioDataStartTime}мс. Отправка аудиобуфера.`);
               commitAudioBuffer(); // Отправляем буфер на сервер
               lastCommitTime = now;
               hasAudioData = false; // Сбрасываем флаг после отправки
               audioDataStartTime = 0; // Сбрасываем время
             } //else { widgetLog(`Обнаружена тишина, но слишком мало времени прошло с последнего коммита (${now - lastCommitTime}мс). Ожидаем...`, "debug"); }
           } //else { widgetLog(`Тишина, но нет голосовых данных в сегменте (${hasAudioData}) или тишина недостаточна (${silenceDuration}мс).`, "debug"); }
        }
      } else {
         // Если не слушаем, соединение закрыто, переподключаемся или воспроизводим
         if (!isListening && mainCircle && mainCircle.classList.contains('listening')) {
              // Если UI завис в состоянии listening, сбрасываем визуал
             resetAudioVisualization();
             mainCircle.classList.remove('listening');
             widgetLog("onaudioprocess: Resetting listening state visual.", "debug");
         }
      }
    };
  }

  // Подключение аудиографа с учетом особенностей платформ (перемещена)
  function connectAudioGraph() {
    if (!audioContext || !audioProcessor || !mediaStream) {
      widgetLog("connectAudioGraph: Missing required components.", "error");
      return;
    }

    try {
      // Отключаем предыдущие подключения процессора, если были
      audioProcessor.disconnect();
       // Отключаем SourceNode, если он был подключен ранее
       if (mediaStream._sourceNode) {
           mediaStream._sourceNode.disconnect();
           mediaStream._sourceNode = null;
       }


      const streamSource = audioContext.createMediaStreamSource(mediaStream);
      // Сохраняем ссылку на SourceNode для последующего отключения
      mediaStream._sourceNode = streamSource;

      streamSource.connect(audioProcessor);

      if (isIOS) {
        widgetLog('Подключение аудиографа для iOS: процессор -> GainNode (volume 0) -> destination');
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;
        audioProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);
         audioProcessor._outputNode = gainNode; // Для отладки

      } else {
        widgetLog('Подключение аудиографа для Desktop/Android: процессор -> destination');
        audioProcessor.connect(audioContext.destination);
         audioProcessor._outputNode = audioContext.destination; // Для отладки
      }

      widgetLog("Аудиограф успешно подключен");
    } catch (error) {
      widgetLog(`Ошибка при подключении аудиографа: ${error.name}: ${error.message}`, 'error');
      stopMicrophoneCapture();
    }
  }

  // Функция для последовательного запуска аудио на мобильных устройствах (перемещена)
  function safeStartListeningOnMobile() {
    if (!isAndroid || !isConnected || isPlayingAudio || isReconnecting || isListening || !isWidgetOpen) {
      //widgetLog(`safeStartListeningOnMobile skipped: isAndroid=${isAndroid}, isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, isWidgetOpen=${isWidgetOpen}`, "debug");
      return;
    }

    widgetLog('Безопасный запуск прослушивания на Android');

    if (websocket && websocket.readyState === WebSocket.OPEN) {
      try {
        websocket.send(JSON.stringify({
          type: "ping",
          event_id: `mobile_safe_start_${Date.now()}`
        }));
        //widgetLog("Ping sent for safe mobile start.", "debug");

        setTimeout(() => {
          if (isConnected && !isPlayingAudio && !isReconnecting && !isListening && isWidgetOpen) {
            widgetLog("Attempting startListening after safe mobile delay.");
            startListening();
          } //else { widgetLog(`startListening skipped after mobile delay: conditions not met.`, "debug"); }
        }, 700);
      } catch (e) {
        widgetLog(`Ошибка отправки ping при безопасном запуске на Android: ${e.message}`, 'error');
      }
    } //else { widgetLog("WebSocket not open for safe mobile start.", "warn"); }
  }

  // Обновление индикатора статуса соединения (перемещена)
  function updateConnectionStatus(status, message) {
    if (!statusIndicator || !statusDot || !statusText) return;

    statusText.textContent = message || status;

    statusDot.classList.remove('connected', 'disconnected', 'connecting');
    if (status === 'connected') {
      statusDot.classList.add('connected');
    } else if (status === 'disconnected') {
      statusDot.classList.add('disconnected');
    } else { // connecting or other
      statusDot.classList.add('connecting');
    }

    statusIndicator.classList.add('show');

    if (statusIndicator._hideTimeout) clearTimeout(statusIndicator._hideTimeout);

    // Скрываем через 3 секунды только для статуса 'connected'
    if (status === 'connected') {
       statusIndicator._hideTimeout = setTimeout(() => {
         statusIndicator.classList.remove('show');
         statusIndicator._hideTimeout = null;
       }, 3000);
    } // Для 'disconnected' и 'connecting' оставляем видимым
  }

  // Показать сообщение (перемещена)
  function showMessage(message, duration = 5000) {
    if (!messageDisplay) return;

    if (messageDisplay._hideTimeoutId) {
      clearTimeout(messageDisplay._hideTimeoutId);
    }

    messageDisplay.textContent = message;
    messageDisplay.classList.add('show');
    //widgetLog(`Показано сообщение: "${message}" (длительность ${duration}мс)`);

    if (duration > 0) {
      messageDisplay._hideTimeoutId = setTimeout(() => {
        messageDisplay.classList.remove('show');
        messageDisplay._hideTimeoutId = null;
        //widgetLog(`Сообщение скрыто: "${message}"`);
      }, duration);
    }
  }

  // Скрыть сообщение (перемещена)
  function hideMessage() {
    if (!messageDisplay) return;
    if (messageDisplay._hideTimeoutId) {
      clearTimeout(messageDisplay._hideTimeoutId);
      messageDisplay._hideTimeoutId = null;
      //widgetLog("Текущее сообщение скрыто.");
    }
    messageDisplay.classList.remove('show');
  }

  // Показать ошибку соединения (перемещена)
  function showConnectionError(message) {
    if (connectionError) {
      widgetLog(`Показана ошибка соединения: "${message}"`);
      const messageSpan = connectionError.querySelector('span');
       if(messageSpan) {
            messageSpan.textContent = message || 'Ошибка соединения с сервером';
       } else {
            // Fallback, если структура HTML изменилась
             connectionError.innerHTML = `
                <span>${message || 'Ошибка соединения с сервером'}</span>
                <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
                  Повторить подключение
                </button>
            `;
             const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
             if(newRetryButton) {
                 newRetryButton.addEventListener('click', resetConnection); // Добавляем обработчик к новой кнопке
             }
       }

      connectionError.classList.add('visible');
      // Индикатор статуса обновляется отдельно в updateConnectionStatus
      // updateConnectionStatus('disconnected', 'Отключено'); // Дублирование, updateConnectionStatus вызывается из логики переподключения
    }
  }

  // Скрыть ошибку соединения (перемещена)
  function hideConnectionError() {
    if (connectionError) {
      //widgetLog("Ошибка соединения скрыта.");
      connectionError.classList.remove('visible');
    }
  }

  // Сброс состояния соединения и повторная попытка (перемещена)
  function resetConnection() {
    widgetLog("Resetting connection state and attempting reconnect.");
    reconnectAttempts = 0;
    connectionFailedPermanently = false;
    isReconnecting = false; // Сбрасываем флаг, так как начинаем новую серию попыток

    hideConnectionError();
    hideMessage();

    showMessage("Попытка подключения...");
    updateConnectionStatus('connecting', 'Подключение...');

    connectWebSocket();
  }

    // Функция переподключения (вызывается из onclose при ошибке, перемещена)
  function reconnect() {
    if (isReconnecting) {
       //widgetLog("reconnect() called but isReconnecting is true. Aborting.", "debug");
       return;
    }

    widgetLog("Initiating reconnect process...");
    isReconnecting = true;

    if (websocket) {
      //widgetLog("Closing existing websocket before reconnect.");
      websocket.onopen = websocket.onerror = websocket.onclose = websocket.onmessage = null;
      try {
         if (websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
            websocket.close(1000, "Reconnecting");
         }
      } catch(e) { widgetLog("Error closing previous websocket upon reconnect:", e.message, "warn"); }
       websocket = null;
    }

    isConnected = false;
    stopAllAudioProcessing(); // Останавливает захват микрофона (isListening = false) и воспроизведение

    // Логика повторных попыток теперь в connectWebSocket и его обработчиках error/close
    connectWebSocket();
  }

  // Подключение WebSocket (перемещена)
  async function connectWebSocket() {
    if (websocket && (websocket.readyState === WebSocket.CONNECTING ||
                         websocket.readyState === WebSocket.OPEN)) {
        //widgetLog(`WebSocket already in state: ${websocket.readyState}. Skipping connectWebSocket call.`);
        if (!isReconnecting && websocket.readyState === WebSocket.CONNECTING) {
            updateConnectionStatus('connecting', 'Подключение...');
        } else if (!isConnected && websocket.readyState === WebSocket.OPEN) {
            updateConnectionStatus('connected', 'Подключено');
        }
        return; // Выходим, если уже есть активная или подключающаяся попытка
    }

     if (connectionFailedPermanently) {
         widgetLog("Cannot connect WebSocket: Permanent connection failure flag is set.", "warn");
         showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
         updateConnectionStatus('disconnected', 'Отключено');
         return; // Не пытаемся подключаться, если постоянная ошибка
     }

    widgetLog(`Попытка подключения WebSocket к ${WS_URL}. Попытка #${reconnectAttempts + 1}`);
    isReconnecting = true;
    if (loaderModal) loaderModal.classList.add('active');

    if (websocket) {
      //widgetLog("Cleaning up previous websocket object.");
      websocket.onopen = websocket.onerror = websocket.onclose = websocket.onmessage = null;
      try {
         if (websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
             websocket.close();
         }
      } catch(e) { widgetLog("Error cleaning up previous websocket object:", e.message, "warn"); }
       websocket = null;
    }
     if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; } // Очистка старого интервала
     if (window.connectionTimeoutId) { clearTimeout(window.connectionTimeoutId); } // Очистка старого таймаута

    try {
      websocket = new WebSocket(WS_URL);
      websocket.binaryType = 'arraybuffer'; // Установка двоичного типа

      window.connectionTimeoutId = setTimeout(() => { // Сохраняем ID таймаута в window для очистки
        widgetLog(`Таймаут соединения WebSocket (${CONNECTION_TIMEOUT}мс)`, "error");
        if (websocket && websocket.readyState !== WebSocket.OPEN &&
            websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
            widgetLog("Закрываем WebSocket из-за таймаута.");
            websocket.close();
        } else if (websocket) {
            //widgetLog(`WebSocket state is ${websocket.readyState} when timeout fired. No action needed.`, "debug");
        } else {
             // Если websocket стал null до срабатывания таймаута, возможно, была ранняя ошибка
             if (!isReconnecting && !connectionFailedPermanently) { // Проверяем флаги, чтобы не зациклиться
                  widgetLog("WebSocket object null on timeout. Manually triggering reconnect logic.", "warn");
                  reconnectAttempts++;
                  const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
                  if (reconnectAttempts <= maxAttempts) {
                       const delay = Math.min(reconnectAttempts, 5) * 1000 + Math.random() * 500;
                       widgetLog(`Manual reconnect attempt ${reconnectAttempts}/${maxAttempts} in ${delay.toFixed(0)}ms.`);
                       setTimeout(connectWebSocket, delay);
                       updateConnectionStatus('connecting', 'Переподключение...');
                       showMessage("Переподключение...");
                  } else {
                       widgetLog("Max reconnect attempts reached after WebSocket null on timeout.", "error");
                       connectionFailedPermanently = true;
                       isReconnecting = false;
                       if(loaderModal) loaderModal.classList.remove('active');
                       showConnectionError('Не удалось подключиться к серверу. Проверьте соединение с интернетом и попробуйте снова.');
                       showMessage("Ошибка соединения с сервером");
                       updateConnectionStatus('disconnected', 'Отключено');
                  }
             }
        }
      }, CONNECTION_TIMEOUT);

      websocket.onopen = function() {
        clearTimeout(window.connectionTimeoutId);
        widgetLog('WebSocket connection established');
        isConnected = true;
        isReconnecting = false;
        reconnectAttempts = 0;
        connectionFailedPermanently = false;
        if(loaderModal) loaderModal.classList.remove('active');
        hideConnectionError();
        hideMessage();

        lastPingTime = Date.now();
        lastPongTime = Date.now();

        if (pingIntervalId) { clearInterval(pingIntervalId); } // Очистка старого интервала на всякий случай
        const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
        pingIntervalId = setInterval(() => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            try {
              websocket.send(JSON.stringify({ type: "ping" }));
              lastPingTime = Date.now();
              //widgetLog("Ping sent.", "debug");

              if (Date.now() - lastPongTime > pingIntervalTime * 2 + 5000) {
                widgetLog(`Ping timeout, no pong received for ${Date.now() - lastPongTime}ms. Reconnecting...`, "warn");
                if (websocket.readyState === WebSocket.OPEN) { // Только если еще открыт
                    websocket.close(); // Это вызовет onclose и reconnect()
                }
              }
            } catch (e) {
              widgetLog(`Error sending ping: ${e.message}`, "error");
               if (websocket.readyState === WebSocket.OPEN) { // Только если еще открыт
                   websocket.close(); // Вызываем close при ошибке отправки
               }
            }
          } else {
            if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
            //widgetLog("WebSocket not open, stopped ping interval.", "debug");
          }
        }, pingIntervalTime);

        if (isWidgetOpen && !isListening && !isPlayingAudio) {
          if (isAndroid) {
            safeStartListeningOnMobile();
          } else {
             // Desktop and iOS (will check AudioContext state internally)
             widgetLog("WebSocket opened, widget open, attempting startListening.");
             startListening();
          }
        } //else { widgetLog(`Not starting listening on WS open: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}`, "debug"); }

        updateConnectionStatus('connected', 'Подключено');
      };

      websocket.onerror = function(error) {
        widgetLog(`WebSocket error: ${error.message || "Неизвестная ошибка"}`, "error");
        // onclose будет вызван после onerror, основная логика переподключения там
      };

      websocket.onclose = function(event) {
        widgetLog(`WebSocket соединение закрыто: код ${event.code}, причина: ${event.reason}`);
        clearTimeout(window.connectionTimeoutId);
        if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
        isConnected = false;
        stopAllAudioProcessing(); // Останавливает микрофон и воспроизведение (isListening = false)

        if (event.code === 1000 || event.code === 1001) {
          isReconnecting = false;
          widgetLog('Clean WebSocket close, not reconnecting');
          updateConnectionStatus('disconnected', 'Отключено');
           if (isWidgetOpen) showMessage("Соединение закрыто.");
        } else if (!connectionFailedPermanently) {
          reconnectAttempts++;
          const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
          if (reconnectAttempts <= maxAttempts) {
            widgetLog(`Соединение закрыто (${event.code}), попытка переподключения ${reconnectAttempts}/${maxAttempts}`);
            isReconnecting = true;
            const delay = Math.min(reconnectAttempts, 5) * 1000 + Math.random() * 500;
            widgetLog(`Задержка перед следующей попыткой: ${delay.toFixed(0)}мс`);
            setTimeout(connectWebSocket, delay);
            updateConnectionStatus('connecting', `Переподключение (${reconnectAttempts})...`);
            showMessage(`Переподключение...`);
          } else {
            widgetLog(`Достигнуто максимальное количество попыток (${maxAttempts}), соединение не установлено`, "error");
            connectionFailedPermanently = true;
            isReconnecting = false;
            if(loaderModal) loaderModal.classList.remove('active');
            showConnectionError('Не удалось подключиться к серверу. Проверьте соединение с интернетом и попробуйте снова.');
            showMessage("Ошибка соединения с сервером");
            updateConnectionStatus('disconnected', 'Отключено');
          }
        } else {
             widgetLog("Соединение закрыто после достижения лимита попыток переподключения.", "info");
             updateConnectionStatus('disconnected', 'Отключено');
             // Сообщение об ошибке уже показано
        }
        websocket = null;
      };

      websocket.onmessage = function(event) {
        try {
          if (event.data instanceof ArrayBuffer) {
              // Обработка бинарных данных (например, аудио)
              // В текущей логике аудио приходит в base64 в JSON, поэтому этот блок может быть не нужен
              widgetLog(`Получены бинарные данные (${event.data.byteLength} bytes).`, "debug");
              // Если бинарные данные - это аудио, декодируем и добавляем в очередь воспроизведения
              playNextAudioInQueue(event.data); // Предполагаем, что playNextAudioInQueue может принять ArrayBuffer
              return;
          }

          if (typeof event.data !== 'string' || event.data.length === 0) {
            widgetLog("Received non-string or empty message data.", "warn");
            return;
          }

          const data = JSON.parse(event.data);
          lastPongTime = Date.now(); // Любое сообщение от сервера сбрасывает таймаут пинга

          if (data.type !== 'input_audio_buffer.append') { // Не логируем частые сообщения аудио
            //widgetLog(`Получено сообщение типа: ${data.type || 'unknown'}`);
          }

          if (data.type === "pong") {
             //widgetLog("Получен pong.");
             if (!isConnected) { isConnected = true; updateConnectionStatus('connected', 'Подключено'); hideConnectionError(); hideMessage(); widgetLog("Connection status updated to 'connected' after receiving pong.", "info"); }
             if (isReconnecting) { isReconnecting = false; widgetLog("isReconnecting flag reset after receiving pong.", "debug"); }
             if (isWidgetOpen && !isListening && !isPlayingAudio) {
                  //widgetLog("Pong received, widget open, not listening/playing. Attempting startListening.");
                   if (isAndroid) { safeStartListeningOnMobile(); } else { startListening(); }
             }
             return;
          }

          if (data.type === 'session.created' || data.type === 'session.updated') {
            widgetLog(`Получена информация о сессии: ${data.type}`);
            // Можно сохранить ID сессии или другие данные
            return;
          }

          if (data.type === 'connection_status') {
            widgetLog(`Статус соединения: ${data.status} - ${data.message}`);
             // Логика обновления статуса уже есть в updateConnectionStatus
             if (data.status === 'connected') {
                 isConnected = true;
                 reconnectAttempts = 0;
                 connectionFailedPermanently = false;
                 hideConnectionError();
                 hideMessage();
                 // Если виджет открыт, пытаемся начать слушать
                 if (isWidgetOpen && !isListening && !isPlayingAudio && !isReconnecting) {
                     if (isAndroid) { safeStartListeningOnMobile(); } else { startListening(); }
                 }
             } else if (data.status === 'disconnected') {
                 isConnected = false;
                 // Логика переподключения сработает через onclose
             }
             updateConnectionStatus(data.status, data.message);
            return;
          }

          if (data.type === 'error') {
            if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
              widgetLog("Ошибка: пустой аудиобуфер", "warn");
              if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                setTimeout(() => {
                  widgetLog("Attempting restart listening after empty buffer error.");
                  startListening();
                }, 500);
              }
              return;
            }

            widgetLog(`Ошибка от сервера: ${data.error ? data.error.message : 'Неизвестная ошибка'}`, "error");
            showMessage(data.error ? data.error.message : 'Произошла ошибка на сервере', 5000);
            return;
          }

          if (data.type === 'response.text.delta') {
            if (data.delta) {
              // Обновляем сообщение, не скрываем автоматически пока не придет done
              showMessage(data.delta, 0);

              if (!isWidgetOpen) {
                if(widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
              }
            }
            return;
          }

          if (data.type === 'response.text.done') {
            // После завершения текста, установим таймер на скрытие сообщения
             widgetLog("response.text.done received.");
            setTimeout(() => {
              hideMessage();
            }, 5000); // Скрыть через 5 секунд
            return;
          }

           // Note: response.audio.delta is for older server versions.
           // The new server sends base64 audio directly in speech.data.
           // Keep the old logic for compatibility, but speech.data is preferred.
          if (data.type === 'response.audio.delta') {
              widgetLog("Received deprecated 'response.audio.delta'. Prefer 'speech.data'.", "warn");
            if (data.delta) {
              //audioChunksBuffer.push(data.delta); // This buffer is for the old flow
              // If using the old flow, audioChunksBuffer should be used here.
              // Assuming the new flow (speech.data) is used primarily.
            }
            return;
          }

           // Note: response.audio.done is for older server versions.
           // The new server sends base64 audio directly in speech.data.
           // Keep the old logic for compatibility.
          if (data.type === 'response.audio.done') {
               widgetLog("Received deprecated 'response.audio.done'. Prefer 'speech.data'.", "warn");
               /* // Old logic
                if (audioChunksBuffer.length > 0) {
                  const fullAudio = audioChunksBuffer.join('');
                  addAudioToPlaybackQueue(fullAudio); // Add base64 string to queue
                  audioChunksBuffer = []; // Clear old buffer
                }
               */
               // If speech.data is used, audio chunks are added to audioPlaybackQueue already.
               // This message just signifies the end of an audio *segment*.
               // Playback is managed by playNextAudioInQueue when new chunks arrive.
               // Maybe this message is just ignored or used for subtle timing adjustments.
               return;
          }


           // NEW AUDIO DATA TYPE
           if (data.type === "speech.data") {
               if (data.data && data.data.audio) {
                   // widgetLog(`Получен аудиофрагмент (${data.data.audio.length} bytes Base64)`, "debug"); // Too verbose
                   addAudioToPlaybackQueue(data.data.audio); // Add base64 string to queue
               } else {
                  widgetLog("Получен speech.data без аудио данных.", "warn");
               }
               return;
           }


          if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
             // Handle transcript updates if needed
             // widgetLog(`Transcript update: ${data.transcript || data.delta}`);
            return;
          }


          if (data.type === 'response.done') {
            widgetLog('Response done received');
            // The 'speaking' class is removed in the playNextAudioInQueue -> onended logic
            // when the playback queue is fully empty.
            // If there was no audio response, we need to ensure 'speaking' class is removed
            // and listening resumes.

            // Add a slight delay to allow potential last audio chunk to be added/processed
            setTimeout(() => {
                if (mainCircle && mainCircle.classList.contains('speaking')) {
                    widgetLog("response.done received, removing 'speaking' class.");
                    mainCircle.classList.remove('speaking');
                }

                 // If playback queue is empty (or becomes empty soon) AND we're not playing,
                 // AND widget is open, try to resume listening.
                if (audioPlaybackQueue.length === 0 && !isPlayingAudio) {
                     widgetLog("Response done, playback queue empty. Checking conditions to start listening.");
                     // Use a small delay to allow state to settle
                     setTimeout(() => {
                         if (isWidgetOpen && isConnected && !isListening && !isReconnecting) {
                             widgetLog("Conditions met after response.done and empty queue. Starting listening.");
                             startListening();
                         } else {
                            widgetLog(`Conditions not met for starting listening after response.done: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isReconnecting=${isReconnecting}`, "debug");
                         }
                     }, 100); // Small delay
                } else {
                     widgetLog(`Response done, but playback queue is not empty (${audioPlaybackQueue.length}) or isPlayingAudio=${isPlayingAudio}. Will start listening after playback finishes.`, "debug");
                }
            }, 200); // Delay to wait for potential last audio chunks/playback start
            return;
          }


          widgetLog(`Неизвестный тип сообщения: ${data.type}`, "warn");

        } catch (parseError) {
          widgetLog(`Ошибка парсинга JSON из сообщения от сервера: ${parseError.message}`, "warn");
          // Log the message content for debugging if parsing fails
          widgetLog(`Received message content (first 200 chars): ${typeof event.data === 'string' ? event.data.substring(0, 200) : 'Not a string'}`, "debug");
           showMessage("Получен некорректный ответ от сервера.");
        }
      };
    } catch (error) {
      widgetLog(`Ошибка создания WebSocket: ${error.name}: ${error.message}`, "error");

      isReconnecting = false;
      if(loaderModal) loaderModal.classList.remove('active');

      reconnectAttempts++;
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

      if (reconnectAttempts <= maxAttempts) {
           widgetLog(`Ошибка создания WebSocket, попытка переподключения ${reconnectAttempts}/${maxAttempts}`);
           const delay = Math.min(reconnectAttempts, 5) * 1000 + Math.random() * 500;
            widgetLog(`Задержка перед следующей попыткой: ${delay.toFixed(0)}мс`);
           setTimeout(connectWebSocket, delay);
           updateConnectionStatus('connecting', 'Подключение...');
           showMessage(`Переподключение...`);
      } else {
           widgetLog(`Достигнуто максимальное количество попыток (${maxAttempts}), не удалось создать WebSocket`, "error");
           connectionFailedPermanently = true;
           showConnectionError('Не удалось подключиться к серверу. Возможно, адрес сервера неверен или он недоступен.');
           showMessage("Ошибка соединения с сервером");
           updateConnectionStatus('disconnected', 'Отключено');
      }
    }
  }

  // Создаём простой WAV из PCM данных (перемещена)
    function createWavFromPcm(pcmBuffer, sampleRate = 16000) { // Устанавливаем sampleRate по умолчанию в 16000, т.к. ASR обычно использует его
      const numChannels = 1;
      const bytesPerSample = 2; // 16-bit PCM
      const blockAlign = numChannels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;
      const dataSize = pcmBuffer.byteLength;
      const fileSize = 36 + dataSize;

      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      // RIFF chunk
      writeString(view, 0, 'RIFF');
      view.setUint32(4, fileSize, true);
      writeString(view, 8, 'WAVE');

      // fmt sub-chunk
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true); // subchunk size
      view.setUint16(20, 1, true); // audio format (PCM = 1)
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bytesPerSample * 8, true); // bits per sample

      // data sub-chunk
      writeString(view, 36, 'data');
      view.setUint32(40, dataSize, true);

      // Write PCM data
      const pcmBytes = new Uint8Array(pcmBuffer);
      const dataBytes = new Uint8Array(buffer, 44);
      dataBytes.set(pcmBytes);

      return buffer;

      function writeString(view, offset, string) {
          for (let i = 0; i < string.length; i++) {
              view.setUint8(offset + i, string.charCodeAt(i));
          }
      }
  }

  // Воспроизведение следующего аудио в очереди (перемещена)
  function playNextAudioInQueue() {
    if (audioPlaybackQueue.length === 0) {
      widgetLog("Очередь воспроизведения пуста. Воспроизведение завершено.");
      isPlayingAudio = false;

      // Убираем класс speaking, если он остался
       if (mainCircle && mainCircle.classList.contains('speaking')) {
           mainCircle.classList.remove('speaking');
       }

      // Восстанавливаем микрофон если нужно после завершения всей очереди
      restoreMicrophoneIfNeeded();

      // Если виджет открыт, подключен, не слушаем, не в процессе переподключения,
      // пытаемся начать слушать.
      // Используем задержку, чтобы избежать конфликтов с окончанием воспроизведения
      setTimeout(() => {
        if (isWidgetOpen && isConnected && !isListening && !isReconnecting) {
          widgetLog("Очередь пуста, условия для начала прослушивания выполнены. Начинаем прослушивание.");
          startListening();
        } else {
          //widgetLog(`Очередь пуста, но условия для начала прослушивания не выполнены: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isReconnecting=${isReconnecting}`, "debug");
        }
      }, 100);

      return;
    }

    isPlayingAudio = true;
    if (mainCircle) { // Устанавливаем класс speaking в UI
        mainCircle.classList.remove('listening');
        mainCircle.classList.add('speaking');
    }

    const audioBase64 = audioPlaybackQueue.shift();
    //widgetLog(`Начало воспроизведения аудиофрагмента. В очереди осталось: ${audioPlaybackQueue.length}`, "debug");

    // Для iOS нужно сохранить состояние микрофона и остановить запись
    if (isIOS && isListening) {
      widgetLog("Пауза записи микрофона на iOS на время воспроизведения.");
      shouldRestoreMicrophoneAfterPlayback = true;
      stopMicrophoneCapture();
    }

    try {
      // Декодируем base64 в бинарные данные (предполагается 16-bit PCM, моно)
      const pcmAudioData = base64ToArrayBuffer(audioBase64);
       if (pcmAudioData.byteLength === 0) {
           widgetLog("Декодированные аудиоданные пусты, пропускаем этот фрагмент.", "warn");
           playNextAudioInQueue(); // Переходим к следующему
           return;
       }

       // Создаем аудиоконтекст если его нет или он закрыт
       if (!audioContext || audioContext.state === 'closed') {
         widgetLog("AudioContext не доступен для воспроизведения, пытаемся создать/возобновить.", "warn");
          // Пытаемся переинициализировать аудиосистему
          initAudio().then(success => {
              if (success) {
                  widgetLog("AudioContext успешно восстановлен, пытаемся снова воспроизвести.");
                  audioPlaybackQueue.unshift(audioBase64); // Возвращаем фрагмент в начало
                  setTimeout(playNextAudioInQueue, 200); // Короткая задержка
              } else {
                  widgetLog("Не удалось восстановить AudioContext для воспроизведения.", "error");
                  isPlayingAudio = false;
                  audioPlaybackQueue = [];
                  showMessage("Ошибка воспроизведения аудио.");
                   restoreMicrophoneIfNeeded();
              }
          }).catch(e => {
              widgetLog(`Ошибка при попытке восстановления аудиоконтекста для воспроизведения: ${e.message}`, "error");
              isPlayingAudio = false;
              audioPlaybackQueue = [];
              showMessage("Критическая ошибка воспроизведения аудио.");
               restoreMicrophoneIfNeeded();
          });
          return;
       }

       // Проверяем состояние AudioContext
       if (audioContext.state === 'suspended') {
           widgetLog("AudioContext suspended во время воспроизведения, пытаемся возобновить.");
           audioContext.resume().then(() => {
               widgetLog("AudioContext успешно возобновлен для воспроизведения.");
                audioPlaybackQueue.unshift(audioBase64); // Возвращаем фрагмент в начало
                setTimeout(playNextAudioInQueue, 100); // Короткая задержка
           }).catch(err => {
               widgetLog(`Не удалось возобновить AudioContext для воспроизведения: ${err.message}`, "error");
                isPlayingAudio = false;
                audioPlaybackQueue = [];
                showMessage("Ошибка активации аудио для воспроизведения.");
                restoreMicrophoneIfNeeded();
           });
           return;
       }


      // Декодируем PCM данные в AudioBuffer
      // sampleRate должен соответствовать AudioContext, если не ресемплируем
      const audioBuffer = audioContext.createBuffer(1, pcmAudioData.byteLength / 2, 16000); // Assuming 16kHz, 1 channel, 16-bit
      const channelData = audioBuffer.getChannelData(0);
      const int16Array = new Int16Array(pcmAudioData);

      for (let i = 0; i < int16Array.length; i++) {
          channelData[i] = int16Array[i] / 32768; // Convert Int16 to Float32 in range [-1, 1]
      }
      //widgetLog(`PCM data decoded to AudioBuffer (${audioBuffer.duration.toFixed(2)}s).`);


      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;

      if (!audioContext.destination) {
         widgetLog("AudioContext destination is not available!", "error");
         isPlayingAudio = false;
         audioPlaybackQueue = [];
         showMessage("Ошибка воспроизведения: AudioContext не готов.");
         restoreMicrophoneIfNeeded();
         return;
      }

      source.connect(audioContext.destination);

      source.onended = function() {
        //widgetLog("Воспроизведение текущего аудиофрагмента завершено.");
        if (audioPlaybackQueue.length > 0) {
          playNextAudioInQueue();
        } else {
          //widgetLog("Вся очередь воспроизведения завершена.");
          isPlayingAudio = false;
          // Логика возврата к прослушиванию находится в setTimeout после проверки пустой очереди
        }
      };

      source.start(0); // Начать немедленно
      //widgetLog("source.start(0) called for playback.");

    } catch (error) {
      widgetLog(`Ошибка воспроизведения аудио из очереди: ${error.name}: ${error.message}`, "error");
      playNextAudioInQueue(); // Пропускаем этот фрагмент и переходим к следующему
    }
  }


  // Обновление аудио визуализации (перемещена)
  function updateAudioVisualization(audioData) {
    if (!audioBars || !mainCircle || !isWidgetOpen || !isListening || isPlayingAudio) {
      //widgetLog(`updateAudioVisualization skipped: !audioBars || !mainCircle || !isWidgetOpen || !isListening || isPlayingAudio`, "debug");
      return;
    }

    const bars = audioBars.children;
    if (!bars || bars.length === 0) return;

    const numBars = bars.length;
    const samplesPerBar = Math.floor(audioData.length / numBars);
    const maxBarHeight = 50; // Максимальная высота в px

    for (let i = 0; i < numBars; i++) {
      const start = i * samplesPerBar;
      let barVolume = 0;
      let barSumSquares = 0;
      const end = Math.min(start + samplesPerBar, audioData.length);

      if (end > start) {
         for (let j = start; j < end; j++) {
             barSumSquares += audioData[j] * audioData[j];
         }
         // RMS для сегмента бара
         barVolume = Math.sqrt(barSumSquares / (end - start));

         // Масштабирование для визуализации
         // average (0-1) -> height (2-maxBarHeight)
         barVolume = Math.min(maxBarHeight, Math.max(2, Math.floor(barVolume * maxBarHeight * 1.5))); // Масштаб 1.5 для чувствительности

      } else {
          barVolume = 2; // Минимальная высота
      }

      bars[i].style.height = barVolume + 'px';
    }
     // widgetLog(`Viz update: first bar height = ${bars[0]?.style.height || 'N/A'}`, "debug"); // Too verbose
  }

  // Сброс визуализации (перемещена)
  function resetAudioVisualization() {
    if (!audioBars) return;
    //widgetLog("Resetting audio visualization.");
    const bars = audioBars.children;
     if (!bars) return;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.height = '2px';
    }
  }

  // Функция преобразования ArrayBuffer в Base64 (перемещена)
  function arrayBufferToBase64(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      widgetLog("Input is not an ArrayBuffer for base64 conversion.", "error");
      return "";
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    try {
      return window.btoa(binary);
    } catch (e) {
      widgetLog(`Ошибка btoa кодирования: ${e.message}`, "error");
      return "";
    }
  }

  // Функция конвертации Base64 в ArrayBuffer (перемещена)
  function base64ToArrayBuffer(base64) {
    if (typeof base64 !== 'string' || base64.length === 0) {
      widgetLog("Invalid input for base64ToArrayBuffer: not a non-empty string.", "warn");
      return new ArrayBuffer(0);
    }
    try {
      const binaryString = window.atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);

      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    } catch (e) {
      widgetLog(`Ошибка atob декодирования: ${e.message}`, "error");
      return new ArrayBuffer(0);
    }
  }


  // Инициализация микрофона и AudioContext (перемещена)
  async function initAudio() {
    // Проверяем, нужно ли вообще инициализировать аудио
    // Проверка state === 'running' или 'suspended' для активного контекста
    if (audioContext && audioContext.state !== 'closed' && mediaStream && mediaStream.active) { // Проверяем mediaStream.active
       //widgetLog("Аудио уже инициализировано и активно.", "info");
       // Проверяем состояние контекста, если suspended, пробуем возобновить
        if (audioContext.state === 'suspended') {
            widgetLog("AudioContext is suspended, attempting to resume.");
            try {
                await audioContext.resume();
                widgetLog("AudioContext resumed successfully.", "info");
                window.audioContextInitialized = true; // Флаг для iOS
                return true; // Успешно возобновлено
            } catch (e) {
                 widgetLog(`Failed to resume existing AudioContext: ${e.name}: ${e.message}`, "error");
                 // Если не удалось возобновить, возможно, нужно пересоздать
                 audioContext = null;
                 mediaStream = null;
                 audioProcessor = null;
                 // Продолжаем инициализацию для пересоздания
            }
        } else {
           // Context is running, stream is active, looks good.
           window.audioContextInitialized = true; // Флаг для iOS
           return true; // Уже инициализировано и активно
        }
    } else {
        //widgetLog(`Аудио нуждается в инициализации. Context: ${audioContext?.state || 'null'}, Stream: ${mediaStream?.active || 'null'}`, "debug");
         // Освобождаем старые ресурсы, если они есть, но неактивны
         if (mediaStream) { stopMicrophoneCapture(); }
         if (audioContext && audioContext.state !== 'closed') { try { audioContext.close(); } catch(e){}; audioContext = null; }
         audioProcessor = null;
         window.audioContextInitialized = false; // Сбрасываем флаг
    }


    try {
      widgetLog("Запрос разрешения на доступ к микрофону...");

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Ваш браузер не поддерживает доступ к микрофону (getUserMedia)");
      }

      // Подготовим оптимальные настройки для разных устройств
      let audioConstraints = {};

      if (isIOS) {
        audioConstraints = {
          echoCancellation: false, // На iOS лучше отключить
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000 // На iOS чаще всего лучшие результаты с частотой 16кГц
        };
         // На iOS сначала разблокируем аудио (если еще не разблокировано)
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
            widgetLog("Attempting unlockAudioOnIOS before getUserMedia.");
           await unlockAudioOnIOS().catch(e => widgetLog(`UnlockAudioOnIOS error during init: ${e.message}`, "warn"));
           // Если после попытки разблокировки контекст все еще не готов или не активен
            if (window.tempAudioContext?.state !== 'running' && window.tempAudioContext?.state !== 'suspended') {
                 widgetLog("AudioContext not ready after unlockAudioOnIOS.", "warn");
                 // Можно показать кнопку iOS здесь, если initAudio вызывается не по кнопке
                 if (isIOS && iosAudioButton && !isWidgetOpen) { // Показываем только если виджет еще не открыт
                     //iosAudioButton.classList.add('visible');
                     //showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                 }
                 // Не прерываем initAudio полностью, т.к. getUserMedia может сработать
            }
        }
      } else if (isAndroid) {
        audioConstraints = getOptimizedConstraintsForAndroid();
      } else {
        audioConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 24000 // Высокое качество для десктопа
        };
      }

      widgetLog(`Применяем настройки аудио для ${isIOS ? 'iOS' : (isAndroid ? 'Android' : 'десктопа')}`, 'info', audioConstraints);

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        widgetLog(`Доступ к микрофону получен.`);

        const audioTrack = mediaStream.getAudioTracks()[0];
        if (audioTrack) {
          const trackSettings = audioTrack.getSettings();
          widgetLog(`Параметры аудиотрека: sampleRate=${trackSettings.sampleRate || 'N/A'}, channelCount=${trackSettings.channelCount || 'N/A'}, echoCancellation=${trackSettings.echoCancellation || 'N/A'}, deviceId=${trackSettings.deviceId || 'N/A'}`);
        }

      } catch (micError) {
        widgetLog(`Ошибка доступа к микрофону: ${micError.name}: ${micError.message}`, 'error');
        // Пробуем резервный вариант с базовыми настройками только если ошибка не NotAllowedError (т.к. разрешение все равно не дано)
        if (micError.name !== 'NotAllowedError' && micError.name !== 'PermissionDeniedError') {
            try {
                widgetLog('Попытка получения микрофона с базовыми настройками...');
                mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                widgetLog('Доступ к микрофону получен с базовыми настройками');
                 const audioTrack = mediaStream.getAudioTracks()[0];
                 if (audioTrack) {
                   const trackSettings = audioTrack.getSettings();
                    widgetLog(`Параметры базового аудиотрека: sampleRate=${trackSettings.sampleRate || 'N/A'},
                              channelCount=${trackSettings.channelCount || 'N/A'},
                              echoCancellation=${trackSettings.echoCancellation || 'N/A'}, deviceId=${trackSettings.deviceId || 'N/A'}`);
                 }
            } catch (fallbackError) {
                widgetLog(`Критическая ошибка доступа к микрофону (fallback): ${fallbackError.name}: ${fallbackError.message}`, 'error');
                throw fallbackError; // Пробрасываем критическую ошибку дальше
            }
        } else {
             // Если ошибка связана с разрешением, нет смысла пробовать базовые настройки
             throw micError; // Пробрасываем ошибку
        }
      }

      // Инициализация AudioContext
      let contextOptions = {};
      // Настраиваем частоту дискретизации AudioContext.
      // Обычно лучше использовать sampleRate микрофона, если возможно,
      // или стандартные 16000/24000.
      const streamSampleRate = mediaStream.getAudioTracks()[0]?.getSettings()?.sampleRate;
      if (streamSampleRate && streamSampleRate > 0) {
           contextOptions.sampleRate = streamSampleRate;
           widgetLog(`Используем sampleRate из стрима для AudioContext: ${streamSampleRate} Гц`);
      } else if (isIOS || isMobile) {
        contextOptions.sampleRate = 16000; // Оптимальная для распознавания речи
         widgetLog(`Используем default sampleRate для мобильных: 16000 Гц`);
      } else {
        contextOptions.sampleRate = 24000; // Высокое качество для десктопа
         widgetLog(`Используем default sampleRate для десктопа: 24000 Гц`);
      }


      // Для iOS используем существующий контекст, если он уже был разблокирован
      if (isIOS && window.tempAudioContext && window.tempAudioContext.state !== 'closed') {
        audioContext = window.tempAudioContext;
        widgetLog('Используем существующий AudioContext на iOS');
         if (audioContext.state === 'suspended') {
             widgetLog("Existing AudioContext is suspended, attempting to resume.");
             await audioContext.resume().then(() => {
                 widgetLog("Existing AudioContext resumed successfully.");
                 window.audioContextInitialized = true; // Флаг установлен
             }).catch(err => {
                 widgetLog(`Failed to resume existing AudioContext: ${err.name}: ${err.message}`, "error");
                 window.audioContextInitialized = false;
                 // Не пробрасываем ошибку, чтобы попробовать создать новый контекст
             });
         } else {
            window.audioContextInitialized = true; // Флаг установлен
         }

      }

      // Если AudioContext до сих пор null или не удалось возобновить существующий на iOS
      if (!audioContext || audioContext.state === 'closed' || (isIOS && audioContext.state === 'suspended' && !window.audioContextInitialized)) {
          try {
              audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
              widgetLog(`AudioContext создан с частотой ${audioContext.sampleRate} Гц`);

              if (isIOS) {
                window.tempAudioContext = audioContext; // Сохраняем ссылку для iOS
                window.audioContextInitialized = true; // Флаг установлен
                // На iOS новый контекст часто сразу suspended, нужно возобновить
                 if (audioContext.state === 'suspended') {
                      widgetLog("Newly created AudioContext is suspended on iOS, attempting to resume...");
                      await audioContext.resume().then(() => {
                          widgetLog("Newly created AudioContext resumed successfully.");
                      }).catch(err => {
                          widgetLog(`Failed to resume newly created AudioContext on iOS: ${err.name}: ${err.message}`, 'error');
                           window.audioContextInitialized = false; // Возобновление не удалось
                           throw err; // Пробрасываем ошибку дальше
                      });
                 }
              } else if (isMobile && audioContext.state === 'suspended') {
                   // На Android также может быть suspended
                   widgetLog("Newly created AudioContext is suspended on Android, attempting to resume...");
                    await audioContext.resume().then(() => {
                      widgetLog("Newly created AudioContext resumed successfully on Android.");
                  }).catch(err => {
                       widgetLog(`Не удалось возобновить AudioContext на Android: ${err.name}: ${err.message}`, 'error');
                       // Не пробрасываем ошибку, т.к. она не критична для самого создания контекста
                       showMessage("Ошибка активации аудио. Нажмите на микрофон для повторной попытки.");
                  });
              }

          } catch (contextError) {
            widgetLog(`Ошибка создания AudioContext: ${contextError.name}: ${contextError.message}`, 'error');
            // Очищаем медиастрим, т.к. без контекста он бесполезен
             if (mediaStream) { stopMicrophoneCapture(); mediaStream = null; }
            throw contextError; // Критическая ошибка, пробрасываем дальше
          }
      }


      // Оптимизированные размеры буфера для ScriptProcessorNode
      const bufferSize = 1024; // Хороший баланс

      // Создаем процессор для обработки аудио
      try {
        // Используем createScriptProcessor, но с учетом его устаревания
        if (audioContext.createScriptProcessor) {
          audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
          widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
        } else if (audioContext.createJavaScriptNode) { // Для очень старых версий Safari
          audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
          widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${bufferSize}`);
        } else {
          throw new Error("Ваш браузер не поддерживает обработку аудио (ScriptProcessorNode/JavaScriptNode)");
        }
      } catch (processorError) {
        widgetLog(`Ошибка создания аудиопроцессора: ${processorError.name}: ${processorError.message}`, 'error');
         if (mediaStream) { stopMicrophoneCapture(); mediaStream = null; } // Очищаем стрим
         if (audioContext && audioContext.state !== 'closed') { try { audioContext.close(); } catch(e){} audioContext = null; } // Закрываем контекст
        throw processorError; // Критическая ошибка
      }

      // Настройка обработчика onaudioprocess и подключение аудиографа
      configureAudioProcessor();
      connectAudioGraph(); // Подключает streamSource к audioProcessor и audioProcessor к destination (или gainNode)


      // Для Android запускаем мониторинг состояния микрофона
      if (isAndroid) {
        startAndroidMicrophoneMonitoring();
      }

      widgetLog("Аудио инициализировано успешно");
      return true;
    } catch (error) {
      widgetLog(`Ошибка инициализации аудио: ${error.name}: ${error.message}`, "error");

      // Освобождаем ресурсы при ошибке
      if (mediaStream) { stopMicrophoneCapture(); mediaStream = null; }
      if (audioContext && audioContext.state !== 'closed') { try { audioContext.close(); } catch(e){}; audioContext = null; }
      audioProcessor = null;
       stopAndroidMicrophoneMonitoring(); // Останавливаем мониторинг при ошибке

      // Особая обработка для iOS (показываем кнопку активации)
      if (isIOS && iosAudioButton) {
         // Добавляем обработчик к кнопке iOS, если он еще не добавлен
         if (!iosAudioButton._listenerAdded) {
             // Находим кнопку снова, чтобы убедиться, что это актуальный элемент
             const currentIosButton = document.getElementById('wellcomeai-ios-audio-button');
             if (currentIosButton) {
                 currentIosButton.classList.add('visible');
                 showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                 currentIosButton.addEventListener('click', async function handler() {
                      widgetLog("iOS audio activation button clicked after init error.");
                      // Пытаемся разблокировать и инициализировать аудио
                      const success = await initAudio(); // Повторная попытка полной инициализации
                      if (success) {
                         widgetLog("iOS audio successfully initialized via button click after error.");
                         currentIosButton.classList.remove('visible');
                         hideMessage(); // Скрываем сообщение
                         // Если виджет открыт и подключен, начинаем слушать
                          if (isWidgetOpen && isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                             startListening();
                          } else {
                             widgetLog("Not starting listening after iOS init button click: conditions not met.", "debug");
                          }
                         currentIosButton.removeEventListener('click', handler); // Удаляем обработчик
                         currentIosButton._listenerAdded = false;
                      } else {
                         widgetLog("iOS audio initialization failed again after button click.", "error");
                         showMessage("Не удалось активировать микрофон. Попробуйте перезагрузить страницу.", 0);
                      }
                 }, { once: true }); // Используем once: true
                 iosAudioButton._listenerAdded = true; // Отмечаем, что обработчик добавлен
             }
         } else {
             widgetLog("iOS audio activation button listener already added after error.", "debug");
         }

      } else {
         // Для других платформ
         if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
             showMessage("Ошибка доступа к микрофону. Пожалуйста, разрешите доступ в настройках браузера или устройства.");
         } else if (error.name === 'NotFoundError') {
             showMessage("Микрофон не найден. Пожалуйста, подключите микрофон.");
         } else if (error.name === 'NotReadableError') {
              showMessage("Микрофон занят другим приложением. Пожалуйста, закройте его и попробуйте снова.");
         } else {
             showMessage("Ошибка инициализации микрофона: " + error.message);
         }
      }

      return false; // Инициализация завершилась с ошибкой
    }
  }

  // Начало записи голоса (перемещена)
  async function startListening() {
    if (!isConnected || isPlayingAudio || isReconnecting || isListening || !isWidgetOpen) {
      //widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, isWidgetOpen=${isWidgetOpen}`, "debug");
      return;
    }

     widgetLog('Начинаем прослушивание...');

    // Если аудио еще не инициализировано или закрыто, или стрим неактивен, инициализируем
    if (!audioContext || audioContext.state === 'closed' || !mediaStream || !mediaStream.active) {
      widgetLog("Аудио не инициализировано/активно, инициализируем перед стартом прослушивания...");
      const success = await initAudio(); // Эта функция сама разблокирует контекст если suspended
      if (!success) {
        widgetLog('Не удалось инициализировать аудио, не можем начать прослушивание.', 'error');
        isListening = false;
        return;
      }
    } else if (audioContext.state === 'suspended') {
         // Если контекст suspended, но initAudio не пересоздал его (т.е. resume в initAudio не сработал)
         // Это может случиться на iOS. Попытка resume еще раз.
         widgetLog("AudioContext suspended, attempting resume in startListening.");
         try {
              await audioContext.resume();
              widgetLog('AudioContext возобновлен в startListening.');
         } catch (error) {
              widgetLog(`Не удалось возобновить AudioContext в startListening: ${error.name}: ${error.message}`, 'error');
              isListening = false;
               if (isIOS && iosAudioButton) { iosAudioButton.classList.add('visible'); showMessage("Нажмите кнопку ниже для активации микрофона", 0); }
               else if (!isIOS) { showMessage("Ошибка активации аудио. Попробуйте снова."); }
              return;
         }
    }


    // Сбрасываем флаги аудио данных и VAD
    hasAudioData = false;
    audioDataStartTime = 0;
    if (voiceDetector) {
      voiceDetector.reset();
    }

    isListening = true; // Устанавливаем флаг прослушивания

    // Отправляем команду для очистки буфера ввода на сервере
    if (websocket && websocket.readyState === WebSocket.OPEN) {
       //widgetLog("Отправляем команду input_audio_buffer.clear перед стартом прослушивания.");
       websocket.send(JSON.stringify({
         type: "input_audio_buffer.clear",
         event_id: `clear_start_${Date.now()}`
       }));
    } else {
       widgetLog("WebSocket не открыт, не можем отправить команду очистки буфера.", "warn");
       // В этом случае, возможно, startListening не должна была быть вызвана
       // или нужно показать ошибку соединения.
    }


    // Активируем визуальное состояние прослушивания если не воспроизводится аудио
    if (!isPlayingAudio && mainCircle) {
      mainCircle.classList.add('listening');
      mainCircle.classList.remove('speaking');
       hideMessage(); // Скрываем предыдущие сообщения
    }

    // Запускаем мониторинг микрофона для Android, если еще не запущен
    if (isAndroid) {
        startAndroidMicrophoneMonitoring();
    }

    widgetLog("Прослушивание активно.");
  }

  // Функция для отправки аудиобуфера (перемещена)
  function commitAudioBuffer() {
    // Проверяем основные условия перед отправкой
    if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting || isPlayingAudio) {
       //widgetLog("Cannot commit audio buffer: conditions not met.", "debug");
       return;
    }

    if (!hasAudioData) {
      //widgetLog("Не отправляем пустой аудиобуфер (hasAudioData is false)", "debug");
      return;
    }

    const audioLength = Date.now() - audioDataStartTime;
    if (audioLength < minimumAudioLength) {
      //widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс < ${minimumAudioLength}мс). Skipping commit.`, "debug");
      // Не отправляем пока буфер слишком короткий
      return;
    }

    sendCommitBuffer();
  }

  // Функция для фактической отправки буфера (перемещена)
  function sendCommitBuffer() {
     if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting || isPlayingAudio) {
        //widgetLog("Cannot send commit buffer: conditions not met.", "warn");
        return;
     }

    widgetLog("Отправка аудиобуфера...");

    // Дополнительная проверка на минимальную длину аудио для сервера
    const audioLength = Date.now() - audioDataStartTime;
    if (audioLength < 100) {
      widgetLog(`Аудиобуфер слишком короткий для обработки на сервере (${audioLength}мс < 100мс), не отправляем commit. Сбрасываем флаги.`, "warn");
      hasAudioData = false;
      audioDataStartTime = 0;
      return;
    }

    // Для мобильных устройств добавляем краткую паузу перед снятием listening визуала
    if (isMobile && mainCircle) {
      setTimeout(() => {
        if (!isPlayingAudio && mainCircle.classList.contains('listening')) {
           mainCircle.classList.remove('listening');
           //widgetLog("Removed listening visual after commit timeout.", "debug");
        }
      }, 100);
    } else if (mainCircle && mainCircle.classList.contains('listening')) {
      mainCircle.classList.remove('listening');
      //widgetLog("Removed listening visual immediately after commit.", "debug");
    }


    try {
       websocket.send(JSON.stringify({
         type: "input_audio_buffer.commit",
         event_id: `commit_${Date.now()}`
       }));
       //widgetLog("input_audio_buffer.commit отправлен.");
    } catch (e) {
       widgetLog(`Ошибка при отправке commit: ${e.message}`, "error");
    }

    if (isMobile && loaderModal) {
      loaderModal.classList.add('active');
      setTimeout(() => {
        if (loaderModal) loaderModal.classList.remove('active');
      }, 1000);
    }

    // Сбрасываем флаги для следующего сегмента аудио
    hasAudioData = false;
    audioDataStartTime = 0;
     //widgetLog("Флаги hasAudioData и audioDataStartTime сброшены после commit.");
  }


  // Открыть виджет (перемещена)
  function openWidget() {
    if (isWidgetOpen) {
      //widgetLog("Widget is already open.", "debug");
      return;
    }
    widgetLog("Opening widget.");

     if (!widgetContainer || !widgetButton || !document.getElementById('wellcomeai-widget-expanded')) {
         widgetLog("Cannot open widget: UI elements not found.", "error");
         alert("Critical widget error: UI elements missing. Cannot open.");
         return;
     }

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
        widgetLog("Showing iOS audio activation button.");
        iosAudioButton.classList.add('visible');
        // Listener is added in initWidget for the initial button.
        // If button is recreated (e.g., in showConnectionError), listener is re-added there.
      }
      if (!window.hasPlayedSilence) {
        //widgetLog("Attempting passive iOS audio unlock on widget open.");
        unlockAudioOnIOS().catch(e => widgetLog(`Passive unlockAudioOnIOS error on open: ${e.message}`, "warn"));
      }
    }
    else if (isAndroid && !window.audioContextInitialized) {
      widgetLog("On Android, delayed audio context initialization.");
      // showMessage("Подключение..."); // Message is shown by connectWebSocket

      setTimeout(() => {
        if (isWidgetOpen && !window.audioContextInitialized) {
          widgetLog("Android audio context initialization after delay.");
          initAudio().then(success => {
            if (success) {
              widgetLog("Android audio context initialized successfully after delay.");
               if (isConnected && !isListening && !isPlayingAudio && !isReconnecting && isWidgetOpen) {
                 startListening();
               } //else { widgetLog("Not starting listening after delayed Android audio init: conditions not met.", "debug"); }
            } else {
              widgetLog("Android audio context initialization failed after delay.", "error");
            }
          }).catch(e => {
             widgetLog(`Error during delayed Android audio initialization: ${e.message}`, "error");
          });
        } //else { widgetLog("Delayed Android audio init skipped: widget closed or already initialized.", "debug"); }
      }, 2000);
    }

    if (connectionFailedPermanently) {
      showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
      updateConnectionStatus('disconnected', 'Отключено');
       //widgetLog("Widget opened, permanent connection failure.", "info");
       return;
    }

    if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
      if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
        showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
        updateConnectionStatus('connected', 'Подключено');
      } else {
         widgetLog("Attempting startListening on widget open (connected).");
        startListening();
        updateConnectionStatus('connected', 'Подключено');
      }
    } else if (!isConnected && !isReconnecting) {
      widgetLog("Widget opened, but not connected. Attempting to connect WebSocket.");
      connectWebSocket();
      updateConnectionStatus('connecting', 'Подключение...');
      showMessage("Подключение...");
    } else {
      //widgetLog(`Cannot start listening yet (widget open): isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
      if (isReconnecting) {
        updateConnectionStatus('connecting', 'Переподключение...');
        showMessage("Переподключение...");
      } else if (isPlayingAudio) {
        showMessage("Подождите, пока завершится ответ...");
        if(mainCircle) mainCircle.classList.add('speaking');
        if(mainCircle) mainCircle.classList.remove('listening');
      } else if (isListening) {
         // Already listening, good.
         //widgetLog("Widget opened, already listening.", "debug");
      } else {
          // Not connected, not reconnecting, not listening, not playing. Show error?
           //widgetLog("Widget opened, connection inactive.", "info");
           updateConnectionStatus('disconnected', 'Отключено');
           showConnectionError('Соединение не установлено. Нажмите "Повторить подключение".');
      }
    }

    if(widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
  }

  // Закрыть виджет (перемещена)
  function closeWidget() {
    if (!isWidgetOpen) {
      //widgetLog("Widget is already closed.", "debug");
      return;
    }
    widgetLog("Closing widget.");

    stopAllAudioProcessing();

    if(widgetContainer) widgetContainer.classList.remove('active');
    isWidgetOpen = false;

    hideMessage();
    hideConnectionError();

    if (statusIndicator) {
      statusIndicator.classList.remove('show');
       if (statusIndicator._hideTimeout) clearTimeout(statusIndicator._hideTimeout);
       statusIndicator._hideTimeout = null;
    }

    if (iosAudioButton) {
      iosAudioButton.classList.remove('visible');
       // No need to manually removeEventListener with { once: true }
       iosAudioButton._listenerAdded = false; // Reset our flag if used
    }

    const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
    if (expandedWidget) {
      expandedWidget.style.opacity = "0";
      expandedWidget.style.height = "0";
      expandedWidget.style.pointerEvents = "none";
    }

    setTimeout(() => {
      if (!isWidgetOpen && widgetContainer && widgetButton) { // Double check state and elements
        widgetContainer.style.zIndex = "";
        widgetButton.style.zIndex = "";
        //widgetLog("Widget z-indices reset after closing animation.", "debug");
      }
    }, 600);
  }


  // --- Основная логика инициализации виджета ---

  // Функция инициализации UI элементов и обработчиков
  function initWidget() {
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag.", 'error');
      alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
      connectionFailedPermanently = true;
      showConnectionError('Ошибка: Assistant ID не найден. Проверьте консоль.');
      if(loaderModal) loaderModal.classList.remove('active'); // Hide initial loader
      return; // Stop initialization
    }

    widgetContainer = document.getElementById('wellcomeai-widget-container');
    widgetButton = document.getElementById('wellcomeai-widget-button');
    widgetClose = document.getElementById('wellcomeai-widget-close');
    mainCircle = document.getElementById('wellcomeai-main-circle');
    audioBars = document.getElementById('wellcomeai-audio-bars');
    loaderModal = document.getElementById('wellcomeai-loader-modal');
    messageDisplay = document.getElementById('wellcomeai-message-display');
    connectionError = document.getElementById('wellcomeai-connection-error');
    retryButton = connectionError ? connectionError.querySelector('#wellcomeai-retry-button') : null;
    statusIndicator = document.getElementById('wellcomeai-status-indicator');
    statusDot = document.getElementById('wellcomeai-status-dot');
    statusText = document.getElementById('wellcomeai-status-text');
    iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');

    const requiredElements = {
       'widgetContainer': widgetContainer, 'widgetButton': widgetButton, 'widgetClose': widgetClose,
       'mainCircle': mainCircle, 'audioBars': audioBars, 'loaderModal': loaderModal,
       'messageDisplay': messageDisplay, 'connectionError': connectionError, 'statusIndicator': statusIndicator,
       'statusDot': statusDot, 'statusText': statusText, 'iosAudioButton': iosAudioButton
    };

    let missingElements = [];
    for (const id in requiredElements) {
       if (!requiredElements[id]) {
          missingElements.push(id); // Use variable name for log
       }
    }

    if (missingElements.length > 0) {
       const errorMessage = `WellcomeAI Widget Error: Missing required UI elements: ${missingElements.join(', ')}. Cannot initialize.`;
       widgetLog(errorMessage, 'error');
       alert(errorMessage);
       connectionFailedPermanently = true;
       if (connectionError) {
           showConnectionError("Критическая ошибка инициализации виджета. Не найдены все элементы.");
       }
       if(loaderModal) loaderModal.classList.remove('active');
       return;
    }


    voiceDetector = new VoiceActivityDetector({
      threshold: effectiveAudioConfig.soundDetectionThreshold,
      minSilenceDuration: effectiveAudioConfig.silenceDuration,
      minSpeechDuration: 300,
      smoothingFactor: 0.2
    });
    widgetLog("VoiceActivityDetector initialized.");
    createAudioBars(); // Создаем бары визуализации


    // Добавляем обработчики событий для UI элементов
    widgetButton.addEventListener('click', function(e) {
      //widgetLog('Widget button clicked');
      e.preventDefault();
      e.stopPropagation(); // Останавливаем всплытие, важно для совместимости с Tilda
      openWidget();
    });

    widgetClose.addEventListener('click', function(e) {
      //widgetLog('Close button clicked');
      e.preventDefault();
      e.stopPropagation(); // Останавливаем всплытие
      closeWidget();
    });

    // Обработчик для основного круга (для запуска распознавания голоса)
    mainCircle.addEventListener('click', function(e) {
       //widgetLog(`Main circle clicked. Current state: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
       e.preventDefault();
       e.stopPropagation(); // Останавливаем всплытие

       // Если виджет открыт, не слушаем, не говорим и не переподключаемся
       if (isWidgetOpen && !isListening && !isPlayingAudio && !isReconnecting) {
           // Если есть соединение, начинаем слушать
           if (isConnected) {
               // На iOS этот клик также поможет инициализировать/возобновить аудио
               if (isIOS) {
                   unlockAudioOnIOS().then(unlocked => {
                      if (unlocked) {
                         widgetLog('Audio context potentially unlocked via main circle click.');
                         if (iosAudioButton) iosAudioButton.classList.remove('visible');
                         startListening(); // Начинаем слушать после попытки разблокировки
                      } else {
                         widgetLog('iOS audio context not unlocked via main circle click. Showing button.', 'warn');
                         if (iosAudioButton) iosAudioButton.classList.add('visible');
                         showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                      }
                   });
               } else {
                   // Desktop & Android
                   startListening();
               }
           } else if (connectionFailedPermanently) {
               // Если соединение окончательно не установлено, показываем ошибку
               showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
           } else {
               // Если нет соединения и нет окончательной ошибки, пытаемся подключиться
               widgetLog("Main circle clicked, but not connected. Attempting connectWebSocket.");
               connectWebSocket();
           }
       } else {
          // Если условия для начала прослушивания не выполнены, возможно, даем обратную связь
           if (isPlayingAudio) showMessage("Подождите, пока завершится ответ.");
           else if (isReconnecting) showMessage("Переподключение...");
           else if (!isConnected && !connectionFailedPermanently) {
                // Нет соединения, не переподключаемся. Возможно, была ошибка.
                showConnectionError('Соединение не установлено. Нажмите "Повторить подключение".');
                updateConnectionStatus('disconnected', 'Отключено');
           } else if (!isWidgetOpen) {
               // Виджет закрыт, клик по кругу не должен происходить
           }
       }
    });


    // Обработчик для кнопки повторного подключения (находится внутри connectionError)
    if (retryButton) {
      //widgetLog('Retry button element found.');
      // Удаляем предыдущий обработчик, если он был, чтобы избежать дублирования
      // Это важно, если connectionError.innerHTML может быть перезаписан
      const oldRetryButton = retryButton.cloneNode(true);
      retryButton.parentNode.replaceChild(oldRetryButton, retryButton);
      retryButton = connectionError.querySelector('#wellcomeai-retry-button'); // Получаем ссылку на новую кнопку

      if (retryButton) {
          retryButton.addEventListener('click', function() {
            widgetLog('Retry button clicked');
            resetConnection();
          });
          //widgetLog("Retry button listener added.");
      } else {
           widgetLog("Retry button element not found after replacement!", "error");
      }

    } else {
        widgetLog("Retry button element not found during init. It might be created dynamically later.", "warn");
        // В этом случае обработчик должен добавляться в showConnectionError
    }


    // Обработчик для кнопки активации iOS (находится внутри виджета)
    if (isIOS && iosAudioButton) {
      //widgetLog('iOS audio button element found.');
       // Удаляем предыдущий обработчик на всякий случай
       const oldIosButton = iosAudioButton.cloneNode(true);
       iosAudioButton.parentNode.replaceChild(oldIosButton, iosAudioButton);
       iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');

       if (iosAudioButton) {
           iosAudioButton.addEventListener('click', async function handler() {
             widgetLog("iOS audio activation button clicked.");
             // Пытаемся разблокировать аудио и инициализировать аудиосистему
             const success = await initAudio(); // initAudio сам вызывает unlockAudioOnIOS
             if (success) {
               widgetLog("iOS audio successfully initialized via button click.");
               iosAudioButton.classList.remove('visible');
               hideMessage();

               // Если виджет открыт и подключен, начинаем слушать
                if (isWidgetOpen && isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                  startListening();
                } else {
                   widgetLog("Not starting listening after iOS button init success: conditions not met.", "debug");
                }
               // No need to manually removeEventListener with { once: true }
               iosAudioButton._listenerAdded = false; // Reset our internal flag
             } else {
               widgetLog("iOS audio initialization failed again after button click.", "error");
               // Сообщение об ошибке уже показано в initAudio
                // Кнопка остается видимой
             }
           }, { once: true }); // Обработчик сработает только один раз
           iosAudioButton._listenerAdded = true; // Отмечаем, что обработчик добавлен

       } else {
           widgetLog("iOS audio button element not found after replacement!", "error");
       }
    } else if (iosAudioButton) {
        // Если элемент кнопки iOS есть, но устройство не iOS, скрываем его
         iosAudioButton.style.display = 'none';
         widgetLog("iOS audio button hidden on non-iOS device.");
    }


    // Начальное состояние лоадера - показываем, пока не получим статус соединения
    if(loaderModal) loaderModal.classList.add('active');
    updateConnectionStatus('connecting', 'Загрузка...');

    widgetLog("initWidget completed. UI elements found, listeners added.");

  } // <--- ЭТА СКОБКА ЗАКРЫВАЕТ ФУНКЦИЮ initWidget


  // --- Запуск виджета после определения всех функций ---

  // Функция для выполнения после загрузки DOM или сразу, если DOM уже готов
  function initializeWidget() {
    widgetLog('Initializing widget...');

    // Логируем тип устройства
    widgetLog(`Device type: ${isIOS ? 'iOS' : (isAndroid ? 'Android' : 'Desktop')}, Mobile: ${isMobile}`);

    // Загружаем необходимые стили и Font Awesome
    loadFontAwesome();
    createStyles();

    // Создаем HTML структуру виджета
    createWidgetHTML();

    // Инициализируем основную логику виджета (находит элементы, добавляет слушателей)
    initWidget(); // Эта функция теперь только настраивает UI и слушателей

    // Проверяем, была ли критическая ошибка в initWidget (например, Assistant ID не найден)
     if (connectionFailedPermanently) {
         widgetLog("Initialization failed during initWidget. Skipping WebSocket connection.", "error");
         if(loaderModal) loaderModal.classList.remove('active');
         // Сообщение об ошибке уже показано в initWidget
         return;
     }

    // Устанавливает WebSocket соединение.
    // connectWebSocket() сам запустит логику инициализации аудио и startListening
    // после успешного подключения, если виджет открыт.
    connectWebSocket();

    widgetLog('Initialization process completed.');

    // Проверка DOM и состояния через некоторое время для отладки
    setTimeout(function() {
      widgetLog('DOM and state check 2 seconds after initialization:');
      const container = document.getElementById('wellcomeai-widget-container');
      const button = document.getElementById('wellcomeai-widget-button');
      const expanded = document.getElementById('wellcomeai-widget-expanded');

      widgetLog(`Container found: ${!!container}, Button found: ${!!button}, Expanded found: ${!!expanded}`);
      if (container) widgetLog(`Container z-index = ${getComputedStyle(container).zIndex}`);
      if (button) widgetLog(`Button is visible = ${button.offsetParent !== null}`); // Check actual visibility

      widgetLog(`Connection state = ${websocket ? websocket.readyState : 'No websocket object'}`);
      widgetLog(`Status flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}, connectionFailedPermanently: ${connectionFailedPermanently}`);

      if (isMobile && audioContext) {
        widgetLog(`AudioContext state=${audioContext.state}, sampleRate=${audioContext.sampleRate}`);
         if (mediaStream && mediaStream.getAudioTracks().length > 0) {
            const track = mediaStream.getAudioTracks()[0];
            widgetLog(`Mic track state: readyState=${track.readyState}, enabled=${track.enabled}`);
         } else {
             widgetLog("Media stream or audio tracks not available/active.", "debug");
         }
      }

      // Проверяем состояние лоадера
      if (loaderModal) {
          widgetLog(`Loader modal is active: ${loaderModal.classList.contains('active')}`);
      }


    }, 2000);
  }


  // Проверяем, есть ли уже виджет на странице перед началом инициализации
  if (!document.getElementById('wellcomeai-widget-container')) {
    widgetLog('Starting overall widget initialization process.');
    // Если DOM еще не загружен, ждем события DOMContentLoaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeWidget);
      widgetLog('Will trigger initializeWidget on DOMContentLoaded');
    } else {
      // Если DOM уже загружен, инициализируем сразу
      widgetLog('DOM already loaded, triggering initializeWidget immediately');
      initializeWidget();
    }
  } else {
    widgetLog('Widget container element already exists on the page, skipping full initialization process.');
     // Возможно, здесь нужно обновить или подключиться к существующему виджету,
     // но текущая логика просто пропускает инициализацию.
     // Добавьте логику, если нужно управлять уже существующим виджетом.
  }


})();
