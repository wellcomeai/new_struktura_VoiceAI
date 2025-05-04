(function() {
  // Настройки виджета
  const DEBUG_MODE = false; // Отключаем режим отладки в продакшене
  const MAX_RECONNECT_ATTEMPTS = 5; // Максимальное количество попыток переподключения
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10; // Увеличенное количество попыток для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 20000; // Таймаут для установления соединения (в миллисекундах)
  const MAX_DEBUG_ITEMS = 10; // Максимальное количество записей отладки

  // Глобальное хранение состояния
  let reconnectAttempts = 0;
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  
  // Определяем тип устройства
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|Poco|mi|Redmi|GT|iPod/i.test(navigator.userAgent); // Добавлены Poco, mi, Redmi, GT для Android
  
  // Глобальные флаги для мобильных устройств
  window.audioContextInitialized = false;
  window.tempAudioContext = null;
  window.hasPlayedSilence = false;

  // Аудио переменные
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
  let lastCommitTime = 0;
  let voiceDetector = null;
  let shouldRestoreMicrophoneAfterPlayback = false;

  // Конфигурация для оптимизации потока аудио
  const AUDIO_CONFIG = {
    silenceThreshold: 0.01,      // Порог для определения тишины
    silenceDuration: 300,        // Длительность тишины для отправки (мс)
    bufferCheckInterval: 50,     // Частота проверки буфера (мс)
    soundDetectionThreshold: 0.02 // Чувствительность к звуку
  };
  
  // Специальные настройки для мобильных устройств
  const ANDROID_AUDIO_CONFIG = {
    silenceThreshold: 0.018,      // Специальный порог для Android
    silenceDuration: 600,         // Оптимизированная длительность тишины
    bufferCheckInterval: 80,      // Более частые проверки
    soundDetectionThreshold: 0.02 // Менее чувствительное определение для Android
  };
  
  // Отдельные настройки для iOS
  const IOS_AUDIO_CONFIG = {
    silenceThreshold: 0.012,      // Более низкий порог для iOS
    silenceDuration: 800,         // Увеличенная длительность тишины 
    bufferCheckInterval: 120,     // Увеличенный интервал проверки
    soundDetectionThreshold: 0.01 // Более чувствительное определение звука
  };
  
  // Выбираем нужную конфигурацию в зависимости от устройства
  const effectiveAudioConfig = isIOS ? 
                              IOS_AUDIO_CONFIG : 
                              (isMobile ? ANDROID_AUDIO_CONFIG : AUDIO_CONFIG);

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info') => {
    // На сервере Render будет доступен объект global
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      // Формируем сообщение для Render
      const logPrefix = '[WellcomeAI Widget]';
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
      
      // В среде Render это попадет в логи
      console.log(`${logPrefix} ${formattedMessage}`);
    } else if (DEBUG_MODE || type === 'error') {
      // Для локальной разработки при включенном DEBUG_MODE
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

  // Функция для отслеживания ошибок (упрощена без отладочной панели)
  const addToDebugQueue = (message, type = 'info') => {
    if (!DEBUG_MODE) return; // Пропускаем в рабочем режиме
    
    const timestamp = new Date().toISOString();
    debugQueue.push({ timestamp, message, type });
    
    // Ограничиваем размер очереди
    if (debugQueue.length > MAX_DEBUG_ITEMS) {
      debugQueue.shift();
    }
  };

  // Получить отладочную информацию в виде строки
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  // Обновление отладочной панели (стабы для совместимости)
  const updateDebugPanel = () => {
    // Функция отключена в производственном режиме
    if (!DEBUG_MODE) return;
  };

  // Функция для определения URL сервера
  const getServerUrl = () => {
    // Сначала проверяем, есть ли атрибут data-server на скрипте
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;
    
    // Ищем скрипт с data-server
    for (let i = 0; i < scriptTags.length; i++) {
      // Проверяем атрибут data-server
      if (scriptTags[i].hasAttribute('data-server')) {
        serverUrl = scriptTags[i].getAttribute('data-server');
        widgetLog(`Found server URL from data-server attribute: ${serverUrl}`);
        break;
      }
      
      // Проверяем dataset.server
      if (scriptTags[i].dataset && scriptTags[i].dataset.server) {
        serverUrl = scriptTags[i].dataset.server;
        widgetLog(`Found server URL from dataset.server: ${serverUrl}`);
        break;
      }
      
      // Если нет data-server, ищем скрипт виджета
      const src = scriptTags[i].getAttribute('src');
      if (src && src.includes('widget.js')) {
        try {
          // Используем URL API для корректного построения абсолютного URL
          const url = new URL(src, window.location.href);
          serverUrl = url.origin;
          widgetLog(`Extracted server URL from script src: ${serverUrl}`);
          break;
        } catch (e) {
          widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');
          
          // Если src относительный, используем текущий домен
          if (src.startsWith('/')) {
            serverUrl = window.location.origin;
            widgetLog(`Using current origin for relative path: ${serverUrl}`);
            break;
          }
        }
      }
    }
    
    // Проверяем, содержит ли URL протокол
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) {
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }
    
    // Если не нашли, используем fallback URL (хостинг Render)
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com';
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }
    
    return serverUrl.replace(/\/$/, ''); // Убираем конечный слеш, если есть
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    // 1. Проверяем наличие атрибута data-assistantId в скрипте
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      // Проверяем оба варианта написания - с большой и маленькой буквой I
      if (scriptTags[i].hasAttribute('data-assistantId') || scriptTags[i].hasAttribute('data-assistantid')) {
        const id = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid');
        widgetLog(`Found assistant ID from attribute: ${id}`);
        return id;
      }
      
      // Проверяем dataset атрибут
      if (scriptTags[i].dataset && (scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid)) {
        const id = scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid;
        widgetLog(`Found assistant ID from dataset: ${id}`);
        return id;
      }
    }
    
    // 2. Пробуем получить ID из URL-параметра
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) {
      widgetLog(`Found assistant ID in URL param: ${idFromUrl}`);
      return idFromUrl;
    }
    
    // 3. Проверяем наличие глобальной переменной
    if (window.wellcomeAIAssistantId) {
      widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`);
      return window.wellcomeAIAssistantId;
    }
    
    // Если используем страницу демонстрации, можно вернуть демо-идентификатор
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo';
    }
    
    widgetLog('No assistant ID found in script tags, URL params or global variables!', 'error');
    return null;
  };

  // Получение позиции виджета
  const getWidgetPosition = () => {
    // Позиции по умолчанию
    const defaultPosition = {
      horizontal: 'right',
      vertical: 'bottom',
      distance: '20px'
    };

    // Ищем скрипт с атрибутом position
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      // Проверяем атрибут
      if (scriptTags[i].hasAttribute('data-position')) {
        return parsePosition(scriptTags[i].getAttribute('data-position'));
      }
      
      // Проверяем dataset
      if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
        return parsePosition(scriptTags[i].dataset.position);
      }
    }

    // Возвращаем позицию по умолчанию
    return defaultPosition;

    // Вспомогательная функция для парсинга позиции
    function parsePosition(positionString) {
      const position = { ...defaultPosition };
      
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
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647";

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
            Ошибка соединения с сервером
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

  // Класс для определения голосовой активности
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
      // Вычисляем текущую громкость (RMS)
      let sumSquares = 0;
      for (let i = 0; i < audioData.length; i++) {
        sumSquares += audioData[i] * audioData[i];
      }
      const rms = Math.sqrt(sumSquares / audioData.length);
      
      // Сглаживаем значение громкости
      if (this.isFirstFrame) {
        this.averageVolume = rms;
        this.isFirstFrame = false;
      } else {
        this.averageVolume = this.averageVolume * (1 - this.smoothingFactor) + rms * this.smoothingFactor;
      }
      
      // Обновляем счетчик фреймов
      this.totalFrameCount++;
      
      // Адаптируем порог на основе фонового шума
      if (this.totalFrameCount < 50) {
        // В начале записи собираем данные для оценки фонового шума
        this.backgroundSamples.push(rms);
        if (this.backgroundSamples.length > 20) {
          // Сортируем и берем нижние 30% как фоновый шум
          const sortedSamples = [...this.backgroundSamples].sort((a, b) => a - b);
          const backgroundSampleCount = Math.floor(sortedSamples.length * 0.3);
          
          if (backgroundSampleCount > 0) {
            let sum = 0;
            for (let i = 0; i < backgroundSampleCount; i++) {
              sum += sortedSamples[i];
            }
            this.backgroundNoiseLevel = sum / backgroundSampleCount;
            
            // Устанавливаем адаптивный порог
            this.adaptiveThreshold = Math.max(this.threshold, this.backgroundNoiseLevel * 2.5);
          }
        }
      }
      
      // Определяем голосовую активность
      const now = Date.now();
      const hasVoice = this.averageVolume > this.adaptiveThreshold;
      
      if (hasVoice) {
        this.activeFrameCount++;
        this.lastVoiceDetection = now;
        
        if (this.isSilent) {
          // Переключаемся из тишины в голос
          this.isSilent = false;
        }
      } else if (!this.isSilent) {
        // Проверяем, достаточно ли долго была тишина
        const silenceDuration = now - this.lastVoiceDetection;
        
        if (silenceDuration > this.minSilenceDuration) {
          this.isSilent = true;
          this.silenceStartTime = this.lastVoiceDetection;
        }
      }
      
      // Определяем, была ли значимая голосовая активность
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
    }
  }

  // Функция для разблокировки аудио на iOS
  function unlockAudioOnIOS() {
    if (!isIOS) return Promise.resolve(true);
    
    widgetLog('Попытка разблокировки аудио на iOS');
    
    return new Promise((resolve) => {
      // Создаем временный аудио-элемент
      const tempAudio = document.createElement('audio');
      tempAudio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
      tempAudio.volume = 0;
      
      // Разблокировка через воспроизведение
      const playPromise = tempAudio.play();
      
      if (playPromise !== undefined) {
        playPromise.then(() => {
          // Воспроизведение успешно началось - аудио разблокировано
          widgetLog('Успешно разблокировано аудио через элемент audio');
          
          // Теперь инициализируем AudioContext
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
        // Для очень старых браузеров
        widgetLog('Используем метод разблокировки для устаревших устройств');
        setTimeout(() => {
          playSilence(); // Запасной вариант с воспроизведением тишины
          resolve(true);
        }, 100);
      }
    });
  }
  
  // Функция для форсированной разблокировки аудио на iOS
  function forceIOSAudioUnlock() {
    if (!isIOS) return Promise.resolve(true);
    
    return new Promise((resolve) => {
      // Воспроизводим короткие звуки с разными частотами
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
          // Создаем контекст если его еще нет
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          const ctx = window.tempAudioContext;
          
          if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
              const oscillator = ctx.createOscillator();
              const gainNode = ctx.createGain();
              
              gainNode.gain.value = 0.01; // Очень тихо
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
      
      // Начинаем воспроизведение тонов
      playNextTone();
    });
  }

  // Воспроизведение тишины (резервная функция для iOS)
  function playSilence() {
    try {
      if (!window.tempAudioContext) {
        window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      // Создаем и воспроизводим тишину для разблокировки аудио
      const silentBuffer = window.tempAudioContext.createBuffer(1, 1, 22050);
      const source = window.tempAudioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(window.tempAudioContext.destination);
      source.start(0);
      
      window.hasPlayedSilence = true;
      widgetLog("Played silence to unlock audio on iOS");
      
      // Разблокируем audioContext
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

  // Получение оптимизированных настроек для Android
  function getAndroidDeviceType() {
    const ua = navigator.userAgent.toLowerCase();
    
    if (ua.indexOf('samsung') > -1) return 'samsung';
    if (ua.indexOf('pixel') > -1) return 'pixel';
    if (ua.indexOf('xiaomi') > -1 || ua.indexOf('redmi') > -1) return 'xiaomi';
    if (ua.indexOf('huawei') > -1) return 'huawei';
    if (ua.indexOf('poco') > -1) return 'poco';
    if (ua.indexOf('gt') > -1) return 'gt';
    
    return 'generic';
  }
  
  // Функция настройки специфичных параметров для разных Android устройств
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
    
    switch(deviceType) {
      case 'samsung':
        // Samsung устройства часто требуют более высокую громкость
        baseConstraints.autoGainControl = true;
        break;
      case 'pixel':
        // Google Pixel имеет хорошее шумоподавление
        baseConstraints.noiseSuppression = true;
        break;
      case 'xiaomi':
      case 'redmi':
        // Xiaomi требует особых настроек для надежной работы
        baseConstraints.echoCancellation = true;
        baseConstraints.noiseSuppression = true;
        break;
      case 'huawei':
        // Huawei может иметь свои особенности
        baseConstraints.echoCancellation = true;
        baseConstraints.noiseSuppression = true;
        break;
      case 'poco':
        // Poco (дочерний бренд Xiaomi)
        baseConstraints.echoCancellation = true;
        baseConstraints.noiseSuppression = true;
        break;
      case 'gt':
        // RealMe GT (часто основаны на Android с надстройками)
        baseConstraints.echoCancellation = true;
        baseConstraints.noiseSuppression = true;
        break;
      default:
        // Для других устройств используем наиболее совместимые настройки
        baseConstraints.echoCancellation = true;
        baseConstraints.noiseSuppression = true;
        baseConstraints.autoGainControl = true;
    }
    
    widgetLog(`Применены оптимизированные настройки для Android устройства типа: ${deviceType}`);
    return baseConstraints;
  }

  // Улучшенное качество аудио и нормализация
  function processAudioForUpload(inputData) {
    // Если нет данных, возвращаем пустой массив
    if (!inputData || inputData.length === 0) return new Float32Array(0);
    
    // Создаем копию данных для обработки
    const processedData = new Float32Array(inputData.length);
    
    // Анализ данных для нормализации
    let maxAmplitude = 0;
    let sumAmplitude = 0;
    
    for (let i = 0; i < inputData.length; i++) {
      const absValue = Math.abs(inputData[i]);
      maxAmplitude = Math.max(maxAmplitude, absValue);
      sumAmplitude += absValue;
    }
    
    // Средняя амплитуда
    const avgAmplitude = sumAmplitude / inputData.length;
    
    // Применение обработки в зависимости от характеристик сигнала
    if (maxAmplitude > 0) {
      // Если сигнал слишком слабый, усиливаем его
      if (maxAmplitude < 0.1) {
        const gain = Math.min(4, 0.3 / maxAmplitude); // Усиление с ограничением
        
        for (let i = 0; i < inputData.length; i++) {
          processedData[i] = inputData[i] * gain;
        }
      } 
      // Если сигнал слишком сильный, немного снижаем
      else if (maxAmplitude > 0.9) {
        const reduction = 0.8 / maxAmplitude;
        
        for (let i = 0; i < inputData.length; i++) {
          processedData[i] = inputData[i] * reduction;
        }
      }
      // Если нормальный уровень, просто копируем
      else {
        for (let i = 0; i < inputData.length; i++) {
          processedData[i] = inputData[i];
        }
      }
      
      // Дополнительная обработка для улучшения разборчивости речи
      // Простой высокочастотный фильтр для улучшения четкости
      if (avgAmplitude < 0.05) { // Применяем только для тихой речи
        let prevSample = 0;
        for (let i = 0; i < processedData.length; i++) {
          // Простой фильтр высоких частот (приближенный)
          // Coefficient (0.5) controls the cutoff frequency. Lower means higher cutoff.
          // This is a very basic filter and might need tuning.
          const highpass = processedData[i] - prevSample * 0.5;
          processedData[i] = highpass; // Apply the filtered value
          prevSample = processedData[i]; // Update prevSample with the *filtered* value
        }
      }
    }
    
    return processedData;
  }

  // Функция для остановки записи микрофона
  function stopMicrophoneCapture() {
    if (!mediaStream) return;
    
    // Останавливаем все аудиотреки
    mediaStream.getTracks().forEach(track => {
      if (track.kind === 'audio') {
        track.stop();
      }
    });
    
    // Отключаем processor если он есть
    if (audioProcessor) {
      try {
        audioProcessor.disconnect();
      } catch (e) {
        widgetLog('Ошибка при отключении аудиопроцессора: ' + e.message, 'warn');
      }
    }
    
    isListening = false;
  }

  // Восстановление микрофона после окончания воспроизведения
  function restoreMicrophoneIfNeeded() {
    if (isIOS && shouldRestoreMicrophoneAfterPlayback) {
      shouldRestoreMicrophoneAfterPlayback = false;
      
      // Даем небольшую паузу перед повторной инициализацией микрофона
      setTimeout(() => {
        // Полностью переинициализируем аудио
        initAudio().then(success => {
          if (success && isWidgetOpen && isConnected) {
            startListening();
          }
        });
      }, 300);
    }
  }

  // Улучшенная функция проверки и перезапуска микрофона для Android
  function checkAndroidMicrophoneStatus() {
    if (!isMobile || isIOS || !mediaStream) return;
    
    let isAudioActive = false;
    
    // Проверяем активность треков
    if (mediaStream) {
      mediaStream.getAudioTracks().forEach(track => {
        if (track.readyState === 'live' && track.enabled) {
          isAudioActive = true;
        }
      });
    }
    
    // Если треки неактивны, пересоздаем микрофон
    if (!isAudioActive && isListening) {
      widgetLog('Обнаружен неактивный микрофон на Android, перезапуск...', 'warn');
      
      // Останавливаем текущий стрим
      stopMicrophoneCapture();
      
      // Пересоздаем микрофон с оптимизированными настройками
      navigator.mediaDevices.getUserMedia({ 
        audio: getOptimizedConstraintsForAndroid() 
      }).then(stream => {
        mediaStream = stream;
        
        // Подключаем микрофон к аудиопроцессору
        if (audioContext && audioProcessor) {
          const streamSource = audioContext.createMediaStreamSource(mediaStream);
          streamSource.connect(audioProcessor);
          audioProcessor.connect(audioContext.destination);
          
          widgetLog('Микрофон на Android успешно переинициализирован');
          
          // Восстанавливаем состояние прослушивания
          isListening = true;
        }
      }).catch(err => {
        widgetLog(`Ошибка при перезапуске микрофона: ${err.message}`, 'error');
        showMessage("Проблема с доступом к микрофону. Пожалуйста, перезагрузите страницу.");
      });
    }
  }

  // Запускаем периодическую проверку микрофона для Android
  function startAndroidMicrophoneMonitoring() {
    if (!isMobile || isIOS) return;
    
    // Проверяем микрофон каждые 5 секунд
    setInterval(checkAndroidMicrophoneStatus, 5000);
    widgetLog('Запущен мониторинг микрофона для Android');
  }

  // Настройка процессора обработки аудио
  function configureAudioProcessor() {
    if (!audioProcessor) return;
    
    audioProcessor.onaudioprocess = function(e) {
      if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
        // Получаем данные с микрофона
        const inputBuffer = e.inputBuffer;
        const rawInputData = inputBuffer.getChannelData(0);
        
        // Проверка на пустые данные
        if (rawInputData.length === 0) return;
        
        // Применяем улучшенную обработку аудио
        const processedData = processAudioForUpload(rawInputData);
        
        // Анализируем аудио с помощью детектора голосовой активности
        const vadResult = voiceDetector.process(processedData);
        
        // Обновляем визуализацию
        updateAudioVisualization(processedData);
        
        // Преобразуем float32 в int16 для отправки через WebSocket
        const pcm16Data = new Int16Array(processedData.length);
        for (let i = 0; i < processedData.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(processedData[i] * 32767)));
        }
        
        // Отправляем данные через WebSocket
        try {
          const message = JSON.stringify({
            type: "input_audio_buffer.append",
            event_id: `audio_${Date.now()}`,
            audio: arrayBufferToBase64(pcm16Data.buffer)
          });
          
          websocket.send(message);
          
          // Отмечаем наличие аудиоданных
          if (!hasAudioData && vadResult.hasVoice) {
            hasAudioData = true;
            audioDataStartTime = Date.now();
            widgetLog("Начало записи аудиоданных");
          }
        } catch (error) {
          widgetLog(`Ошибка отправки аудио: ${error.message}`, "error");
        }
        
        // Логика определения тишины и автоматической отправки
        const now = Date.now();
        
        if (vadResult.hasVoice) {
          // Активируем визуальное состояние прослушивания
          if (!mainCircle.classList.contains('listening') && 
              !mainCircle.classList.contains('speaking')) {
            mainCircle.classList.add('listening');
          }
        } else if (vadResult.isSilent && vadResult.silenceDuration > effectiveAudioConfig.silenceDuration) {
          // Если достаточная тишина после голоса, отправляем буфер
          if (hasAudioData && now - lastCommitTime > 1000) {
            commitAudioBuffer();
            lastCommitTime = now;
          }
        }
      }
    };
  }

  // Подключение аудиографа с учетом особенностей платформ
  function connectAudioGraph() {
    if (!audioContext || !audioProcessor || !mediaStream) return;
    
    try {
      const streamSource = audioContext.createMediaStreamSource(mediaStream);
      streamSource.connect(audioProcessor);
      
      // Для iOS НЕ соединяем напрямую с выходом, чтобы избежать обратной связи
      if (isIOS) {
        // Для iOS создаем "отключенный" узел чтобы избежать обратной связи
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0; // Установка громкости на ноль
        audioProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);
        widgetLog('Используем отключенный выход для iOS чтобы избежать обратной связи');
      } else {
        // Для других устройств подключаем к выходу
        audioProcessor.connect(audioContext.destination);
      }
      
      widgetLog("Аудиограф успешно подключен");
    } catch (error) {
      widgetLog(`Ошибка при подключении аудиографа: ${error.message}`, 'error');
    }
  }

  // Функция для последовательного запуска аудио на мобильных устройствах
  function safeStartListeningOnMobile() {
    if (!isMobile || !isConnected || isPlayingAudio || isReconnecting || isListening) {
      return;
    }
    
    widgetLog('Безопасный запуск прослушивания на мобильном устройстве');
    
    // Сначала просто проверяем состояние соединения
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      // Отправляем пинг для проверки соединения
      try {
        websocket.send(JSON.stringify({ 
          type: "ping",
          event_id: `mobile_${Date.now()}`
        }));
        
        // Если пинг прошел успешно, запускаем аудио с задержкой
        setTimeout(() => {
          if (isConnected && !isPlayingAudio && !isReconnecting && !isListening) {
            startListening();
          }
        }, 700);
      } catch (e) {
        widgetLog(`Ошибка проверки соединения: ${e.message}`, 'error');
      }
    }
  }

  // Основная логика виджета
  function initWidget() {
    // Проверяем, что ID ассистента существует
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
    const retryButton = connectionError ? connectionError.querySelector('#wellcomeai-retry-button') : null; // Находим кнопку внутри error контейнера при инициализации
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
    
    // Проверка элементов
    if (!widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !connectionError || !statusIndicator || !statusDot || !statusText || !iosAudioButton) {
       // Логируем отсутствующий элемент для более точной диагностики
       let missing = [];
       if (!widgetButton) missing.push('#wellcomeai-widget-button');
       if (!widgetClose) missing.push('#wellcomeai-widget-close');
       if (!mainCircle) missing.push('#wellcomeai-main-circle');
       if (!audioBars) missing.push('#wellcomeai-audio-bars');
       if (!loaderModal) missing.push('#wellcomeai-loader-modal');
       if (!messageDisplay) missing.push('#wellcomeai-message-display');
       if (!connectionError) missing.push('#wellcomeai-connection-error');
       if (!statusIndicator) missing.push('#wellcomeai-status-indicator');
       if (!statusDot) missing.push('#wellcomeai-status-dot');
       if (!statusText) missing.push('#wellcomeai-status-text');
       if (!iosAudioButton) missing.push('#wellcomeai-ios-audio-button');
       
       widgetLog(`Some required UI elements were not found! Missing: ${missing.join(', ')}`, 'error');
       // Возможно, стоит добавить визуальное оповещение пользователю
       alert(`Ошибка инициализации виджета: Не найдены необходимые элементы (${missing.join(', ')})`);
       return; // Прекращаем выполнение initWidget
    }
    
    // Инициализируем детектор голосовой активности
    voiceDetector = new VoiceActivityDetector({
      threshold: isIOS ? 0.01 : (isMobile ? 0.018 : 0.015),
      minSilenceDuration: isIOS ? 800 : (isMobile ? 600 : 600),
      minSpeechDuration: 300,
      smoothingFactor: 0.2
    });
    
    // Обновление индикатора статуса соединения
    function updateConnectionStatus(status, message) {
      if (!statusIndicator || !statusDot || !statusText) return;
      
      statusText.textContent = message || status;
      
      // Удаляем все классы состояния
      statusDot.classList.remove('connected', 'disconnected', 'connecting');
      
      // Добавляем нужный класс
      if (status === 'connected') {
        statusDot.classList.add('connected');
      } else if (status === 'disconnected') {
        statusDot.classList.add('disconnected');
      } else {
        statusDot.classList.add('connecting');
      }
      
      // Показываем индикатор
      statusIndicator.classList.add('show');
      
      // Скрываем через некоторое время (можно сделать умнее, например, скрывать при активности)
      setTimeout(() => {
        statusIndicator.classList.remove('show');
      }, 5000); // Увеличено время показа статуса
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
      widgetLog("Stopping all audio processing...");
      // Останавливаем прослушивание
      isListening = false;
      
      // Останавливаем воспроизведение (если активно)
      // Это только флаг, фактическое воспроизведение остановится само
      // когда очередь закончится или при ошибке декодирования/воспроизведения
      // isPlayingAudio = false; // Лучше не сбрасывать этот флаг здесь, т.к. он управляет playNextAudioInQueue

      // Очищаем буферы и очереди
      audioChunksBuffer = [];
      audioPlaybackQueue = []; // Очистка очереди воспроизведения
      
      // Сбрасываем флаги
      hasAudioData = false;
      audioDataStartTime = 0;
      
      // Если есть активное соединение WebSocket, отправляем команду остановки
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        widgetLog("Sending clear/cancel commands to WebSocket.");
        // Очищаем буфер ввода
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
        
        // Отменяем любой текущий ответ
        websocket.send(JSON.stringify({
          type: "response.cancel",
          event_id: `cancel_${Date.now()}`
        }));
      } else {
         widgetLog("WebSocket not open, cannot send clear/cancel commands.");
      }
      
      // Сбрасываем состояние UI
      mainCircle.classList.remove('listening');
      mainCircle.classList.remove('speaking');
      
      // Сбрасываем визуализацию
      resetAudioVisualization();
      widgetLog("All audio processing stopped.");
    }
    
    // Показать сообщение
    function showMessage(message, duration = 5000) {
      if (!messageDisplay) return;
      messageDisplay.textContent = message;
      messageDisplay.classList.add('show');
      
      // Скрываем предыдущие таймауты
      if (messageDisplay.hideTimeoutId) {
         clearTimeout(messageDisplay.hideTimeoutId);
      }

      if (duration > 0) {
        messageDisplay.hideTimeoutId = setTimeout(() => {
          messageDisplay.classList.remove('show');
        }, duration);
      }
    }

    // Скрыть сообщение
    function hideMessage() {
      if (!messageDisplay) return;
      messageDisplay.classList.remove('show');
      if (messageDisplay.hideTimeoutId) {
         clearTimeout(messageDisplay.hideTimeoutId);
      }
    }
    
    // Показать ошибку соединения
    function showConnectionError(message) {
      if (connectionError) {
        // Обновляем только текст сообщения, кнопка уже в HTML
        const msgEl = connectionError.querySelector('span') || document.createElement('span');
        if (!msgEl.parentElement) connectionError.prepend(msgEl); // Добавляем span если его нет
        msgEl.textContent = message || 'Ошибка соединения с сервером';
        
        connectionError.classList.add('visible');
        
        // Кнопка повторного подключения уже найдена в initWidget
        if (retryButton) {
          retryButton.addEventListener('click', resetConnection); // Добавляем обработчик
        } else {
           // Если кнопка не найдена при init, пробуем найти ее снова
           const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
           if(newRetryButton) {
              newRetryButton.addEventListener('click', resetConnection);
           }
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
      widgetLog("Resetting connection state and retrying...");
      // Сбрасываем счетчик попыток и флаги
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      
      // Скрываем сообщение об ошибке
      hideConnectionError();
      
      // Показываем сообщение о повторном подключении
      showMessage("Попытка подключения...");
      updateConnectionStatus('connecting', 'Подключение...');
      
      // Пытаемся подключиться заново
      connectWebSocket();
    }
    
    // Открыть виджет
    function openWidget() {
      if (isWidgetOpen) return; // Избегаем повторного открытия
      widgetLog("Opening widget");
      
      // Принудительно устанавливаем z-index для решения конфликтов
      widgetContainer.style.zIndex = "2147483647";
      widgetButton.style.zIndex = "2147483647";
      
      widgetContainer.classList.add('active');
      isWidgetOpen = true;
      
      // Принудительно устанавливаем видимость расширенного виджета
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "1";
        expandedWidget.style.height = "400px";
        expandedWidget.style.pointerEvents = "all";
        expandedWidget.style.zIndex = "2147483647";
      }
      
      // Специальная обработка для iOS устройств
      if (isIOS) {
        // Показываем специальную кнопку для iOS если нужно
        if (iosAudioButton && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
          iosAudioButton.classList.add('visible');
          
          // Удаляем предыдущий обработчик, если есть, чтобы избежать дублирования
          const oldButton = iosAudioButton.cloneNode(true);
          iosAudioButton.parentNode.replaceChild(oldButton, iosAudioButton);
          const newIosAudioButton = document.getElementById('wellcomeai-ios-audio-button'); // Находим новую кнопку
          
          newIosAudioButton.addEventListener('click', function() {
            unlockAudioOnIOS().then(success => {
              if (success) {
                newIosAudioButton.classList.remove('visible');
                // Пытаемся начать слушать после активации аудио
                setTimeout(() => {
                  if (isConnected && !isListening && !isPlayingAudio && isWidgetOpen) { // Проверяем, что виджет все еще открыт
                    startListening();
                  }
                }, 500);
              }
            });
          }, { once: true }); // Используем { once: true } для автоматического удаления после первого клика
        }
        
        // Пытаемся сразу разблокировать аудио (пассивный метод)
        if (!window.hasPlayedSilence) {
          unlockAudioOnIOS();
        }
      }
      // Для других мобильных (Android)
      else if (isMobile && !window.audioContextInitialized) {
        // На мобильных сначала даем WebSocket-соединению стабилизироваться
        // и только потом инициализируем аудиоконтекст
        widgetLog("На мобильном устройстве - отложенная инициализация аудио");
        
        // Показываем сообщение
        showMessage("Подключение...");
        
        // Отложенная инициализация аудиоконтекста для стабильности соединения
        setTimeout(() => {
          if (!window.audioContextInitialized) { // Проверяем еще раз, что не инициализировано за это время
              try {
                // Создаем временный аудио контекст для мобильных
                if (!window.tempAudioContext) {
                  window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                
                window.audioContextInitialized = true;
                widgetLog("Mobile audio context инициализирован с задержкой");
                
                if (isConnected && !isListening && !isPlayingAudio && !isReconnecting && isWidgetOpen) { // Проверяем, что виджет открыт
                  startListening();
                }
              } catch (e) {
                widgetLog(`Ошибка инициализации аудиоконтекста: ${e.message}`, "error");
                showMessage("Ошибка инициализации аудио. Пожалуйста, перезагрузите страницу.");
              }
          } else {
             widgetLog("Mobile audio context уже инициализирован.");
             if (isConnected && !isListening && !isPlayingAudio && !isReconnecting && isWidgetOpen) {
                startListening();
             }
          }
        }, 2000); // Задержка 2 секунды для стабилизации WebSocket-соединения
      }
      
      // Показываем сообщение о проблеме с подключением, если оно есть
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        return;
      }
      
      // Запускаем прослушивание при открытии, если соединение активно и виджет открыт
      if (isConnected && !isListening && !isPlayingAudio && !isReconnecting && isWidgetOpen) {
        // На iOS не запускаем прослушивание автоматически,
        // пока не активированы разрешения на аудио
        if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
          showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
        } else {
          startListening();
        }
        updateConnectionStatus('connected', 'Подключено');
      } else if (!isConnected && !isReconnecting) {
        // Если соединение не активно и не находимся в процессе переподключения,
        // пытаемся подключиться снова
        widgetLog("Widget opened, but not connected. Attempting to connect WebSocket.");
        connectWebSocket();
      } else {
        widgetLog(`Cannot start listening yet (widget open): isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
        
        if (isReconnecting) {
          updateConnectionStatus('connecting', 'Переподключение...');
          showMessage("Переподключение...");
        } else if (isPlayingAudio) {
          showMessage("Подождите, пока завершится ответ...");
        }
      }
      
      // Убираем пульсацию с кнопки
      widgetButton.classList.remove('wellcomeai-pulse-animation');
    }
    
    // Закрыть виджет
    function closeWidget() {
      if (!isWidgetOpen) return; // Избегаем повторного закрытия
      widgetLog("Closing widget");
      
      // Останавливаем все аудио процессы
      stopAllAudioProcessing();
      
      // Скрываем виджет
      widgetContainer.classList.remove('active');
      isWidgetOpen = false;
      
      // Скрываем сообщения и ошибки
      hideMessage();
      hideConnectionError();
      
      // Скрываем индикатор статуса
      if (statusIndicator) {
        statusIndicator.classList.remove('show');
      }
      
      // Скрываем кнопку активации iOS
      if (iosAudioButton) {
        iosAudioButton.classList.remove('visible');
         // Убираем обработчик, если он был добавлен
         const oldButton = iosAudioButton.cloneNode(true);
         iosAudioButton.parentNode.replaceChild(oldButton, iosAudioButton);
      }
      
      // Принудительно скрываем расширенный виджет
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "0";
        expandedWidget.style.height = "0";
        expandedWidget.style.pointerEvents = "none";
      }
       // Возможно, стоит сбросить z-index контейнера после анимации закрытия
       setTimeout(() => {
           if (!isWidgetOpen) { // Только если виджет действительно закрыт
               widgetContainer.style.zIndex = ""; 
               widgetButton.style.zIndex = "";
           }
       }, 600); // Немного дольше, чем transition в CSS
    }
    
    // Инициализация микрофона и AudioContext
    async function initAudio() {
      // Проверяем, нужно ли вообще инициализировать аудио
      if (audioContext && audioContext.state !== 'closed' && mediaStream) {
         widgetLog("Аудио уже инициализировано.", "info");
         return true;
      }

      try {
        widgetLog("Запрос разрешения на доступ к микрофону...");
        
        // Проверяем поддержку getUserMedia
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону");
        }
        
        // Подготовим оптимальные настройки для разных устройств
        let audioConstraints;
        
        if (isIOS) {
          // Оптимальные настройки для iOS
          audioConstraints = { 
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // На iOS чаще всего лучшие результаты с частотой 16кГц
            sampleRate: 16000
          };
          
          // Для iOS сначала разблокируем аудио (если еще не разблокировано)
          if (!window.audioContextInitialized || !window.hasPlayedSilence) {
             await unlockAudioOnIOS();
             // Если после попытки разблокировки контекст все еще не готов
             if (!window.audioContextInitialized) {
                 widgetLog("AudioContext не активирован после unlockAudioOnIOS", "warn");
                 // Возможно, здесь нужно показать кнопку iOS активации, если она скрыта
                 if (iosAudioButton) iosAudioButton.classList.add('visible');
                 throw new Error("AudioContext не удалось активировать на iOS");
             }
          }
        } else if (isMobile) {
          // Используем функцию оптимизации для Android
          audioConstraints = getOptimizedConstraintsForAndroid();
        } else {
          // Настройки для десктопа
          audioConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 24000
          };
        }
        
        widgetLog(`Применяем настройки аудио для ${isIOS ? 'iOS' : (isMobile ? 'Android' : 'десктопа')}`);
        
        // Пробуем получить доступ к микрофону с оптимальными настройками
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Доступ к микрофону получен с оптимизированными настройками`);
          
          // Логирование параметров аудиотрека для отладки
          const audioTrack = mediaStream.getAudioTracks()[0];
          if (audioTrack) {
            widgetLog(`Получен аудиотрек: ${audioTrack.label}`);
            
            // Получаем и логируем настройки трека
            const trackSettings = audioTrack.getSettings();
            widgetLog(`Параметры аудиотрека: sampleRate=${trackSettings.sampleRate || 'N/A'}, 
                      channelCount=${trackSettings.channelCount || 'N/A'}, 
                      echoCancellation=${trackSettings.echoCancellation || 'N/A'}`);
          }
        } catch (micError) {
          widgetLog(`Ошибка с оптимизированными настройками: ${micError.name}: ${micError.message}`, 'warn');
          
          // Пробуем резервный вариант с базовыми настройками
          try {
            widgetLog('Попытка получения микрофона с базовыми настройками...');
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            widgetLog('Доступ к микрофону получен с базовыми настройками');
             const audioTrack = mediaStream.getAudioTracks()[0];
             if (audioTrack) {
               const trackSettings = audioTrack.getSettings();
                widgetLog(`Параметры базового аудиотрека: sampleRate=${trackSettings.sampleRate || 'N/A'}, 
                          channelCount=${trackSettings.channelCount || 'N/A'}, 
                          echoCancellation=${trackSettings.echoCancellation || 'N/A'}`);
             }
          } catch (fallbackError) {
            widgetLog(`Критическая ошибка доступа к микрофону: ${fallbackError.name}: ${fallbackError.message}`, 'error');
            throw fallbackError; // Пробрасываем ошибку дальше
          }
        }
        
        // Инициализация AudioContext с правильными настройками
        let contextOptions = {};
        
        // Настраиваем частоту дискретизации в зависимости от устройства
        // Стараемся использовать sampleRate микрофона, если он известен и не 0
        const streamSampleRate = mediaStream.getAudioTracks()[0].getSettings().sampleRate;
        if (streamSampleRate && streamSampleRate > 0) {
             contextOptions.sampleRate = streamSampleRate;
             widgetLog(`Используем sampleRate из стрима: ${streamSampleRate} Гц`);
        } else if (isIOS || isMobile) {
          contextOptions.sampleRate = 16000; // Оптимальная для распознавания речи
           widgetLog(`Используем default sampleRate для мобильных: 16000 Гц`);
        } else {
          contextOptions.sampleRate = 24000; // Высокое качество для десктопа
           widgetLog(`Используем default sampleRate для десктопа: 24000 Гц`);
        }
        
        // Для iOS используем существующий контекст если он уже был разблокирован
        if (isIOS && window.tempAudioContext && window.tempAudioContext.state !== 'closed') {
          audioContext = window.tempAudioContext;
          widgetLog('Используем существующий AudioContext на iOS');
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
            window.audioContextInitialized = true;
            widgetLog('Существующий AudioContext активирован на iOS');
          } else {
             window.audioContextInitialized = true; // Убеждаемся, что флаг установлен
          }
        } else {
          // Создаем новый AudioContext
          try {
            // Если на iOS tempAudioContext был закрыт, создаем новый
            audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
            
            // На iOS сохраняем ссылку на контекст
            if (isIOS) {
              window.tempAudioContext = audioContext;
              window.audioContextInitialized = true; // Убеждаемся, что флаг установлен
            }
            
            widgetLog(`AudioContext создан с частотой ${audioContext.sampleRate} Гц`);
             // Проверяем состояние после создания
             if (audioContext.state === 'suspended' && isIOS) {
                 widgetLog("AudioContext создан в suspended состоянии на iOS, пытаемся возобновить...");
                 await audioContext.resume().then(() => {
                     widgetLog("AudioContext успешно возобновлен после создания.");
                 }).catch(err => {
                     widgetLog(`Не удалось возобновить AudioContext после создания: ${err.message}`, 'error');
                     // Возможно, нужно показать кнопку iOS здесь
                     if (isIOS && iosAudioButton) iosAudioButton.classList.add('visible');
                     throw new Error("AudioContext создан в suspended состоянии и не удалось возобновить");
                 });
             } else if (audioContext.state === 'suspended' && isMobile && !isIOS) {
                  // На Android также может быть suspended
                  widgetLog("AudioContext создан в suspended состоянии на Android, пытаемся возобновить...");
                   await audioContext.resume().then(() => {
                     widgetLog("AudioContext успешно возобновлен на Android.");
                 }).catch(err => {
                      widgetLog(`Не удалось возобновить AudioContext на Android: ${err.message}`, 'error');
                      // Возможно, нужно показать ошибку или инструкцию для Android
                      showMessage("Ошибка активации аудио. Нажмите на микрофон для повторной попытки.");
                 });
             }
          } catch (contextError) {
            widgetLog(`Ошибка создания AudioContext: ${contextError.name}: ${contextError.message}`, 'error');
            throw contextError;
          }
        }
        
        // Проверяем, что AudioContext теперь активен или running (кроме iOS, где он может быть suspended до первого звука)
        if (!isIOS && audioContext.state !== 'running') {
             widgetLog(`AudioContext state is unexpected: ${audioContext.state}`, 'warn');
             // Возможно, здесь нужно дополнительная обработка или показ ошибки
        }

        // Оптимизированные размеры буфера для разных устройств
        // Размер буфера node должен быть одним из: 256, 512, 1024, 2048, 4096, 8192, 16384
        // 1024 - хороший баланс для большинства устройств и распознавания
        const bufferSize = 1024; 
        widgetLog(`Используем размер буфера для ScriptProcessorNode: ${bufferSize}`);
        
        // Создаем процессор для обработки аудио
        try {
          if (audioContext.createScriptProcessor) {
            audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            widgetLog(`Создан ScriptProcessorNode`);
          } else if (audioContext.createJavaScriptNode) { // Для старых версий Safari
            audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
            widgetLog(`Создан устаревший JavaScriptNode`);
          } else {
            throw new Error("Ваш браузер не поддерживает обработку аудио (ScriptProcessorNode или JavaScriptNode)");
          }
        } catch (processorError) {
          widgetLog(`Ошибка создания аудиопроцессора: ${processorError.name}: ${processorError.message}`, 'error');
          throw processorError;
        }
        
        // Настройка обработчика аудио с улучшенной логикой
        configureAudioProcessor();
        
        // Подключаем обработчик аудио к источнику и выходу
        connectAudioGraph();
        
        // Для Android запускаем мониторинг состояния микрофона
        if (isMobile && !isIOS) {
          startAndroidMicrophoneMonitoring();
        }
        
        widgetLog("Аудио инициализировано успешно");
        return true; // Успешная инициализация
      } catch (error) {
        widgetLog(`Ошибка инициализации аудио: ${error.name}: ${error.message}`, "error");
        
        // Освобождаем медиастрим при ошибке
        if (mediaStream) {
           mediaStream.getTracks().forEach(track => track.stop());
           mediaStream = null;
        }
        // Закрываем аудиоконтекст при ошибке
        if (audioContext && audioContext.state !== 'closed') {
           try { audioContext.close(); } catch(e) {}
           audioContext = null;
        }
        // Отключаем процессор при ошибке
        if (audioProcessor) {
            try { audioProcessor.disconnect(); } catch(e) {}
            audioProcessor = null;
        }
        
        // Особая обработка для iOS
        if (isIOS && iosAudioButton) {
          iosAudioButton.classList.add('visible');
          showMessage("Нажмите кнопку ниже для активации микрофона", 0);
        } else {
           // Проверяем имя ошибки для более точного сообщения
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
    
    // Начало записи голоса
    async function startListening() {
      if (!isConnected || isPlayingAudio || isReconnecting || isListening || !isWidgetOpen) { // Добавлена проверка isWidgetOpen
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, isWidgetOpen=${isWidgetOpen}`);
        return;
      }
      
       widgetLog('Начинаем прослушивание...');

      // Если аудио еще не инициализировано, делаем это
      if (!audioContext || audioContext.state === 'closed' || !mediaStream) {
        widgetLog("Аудио не инициализировано или закрыто, инициализируем...");
        const success = await initAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио для начала прослушивания', 'error');
          isListening = false; // Убеждаемся, что флаг сброшен
          return;
        }
      } else if (audioContext.state === 'suspended') {
        // Возобновляем AudioContext если он был приостановлен
        widgetLog("AudioContext suspended, attempting to resume...");
        try {
          await audioContext.resume();
          widgetLog('AudioContext возобновлен');
        } catch (error) {
          widgetLog(`Не удалось возобновить AudioContext: ${error.name}: ${error.message}`, 'error');
          isListening = false;
          
          // Для iOS показываем специальную кнопку
          if (isIOS && iosAudioButton) {
            iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
          } else {
             showMessage("Ошибка активации аудио. Попробуйте снова.");
          }
          
          return; // Не можем начать слушать, если контекст не активен
        }
      }
      
      // Проверяем, что WebSocket открыт перед отправкой команды очистки
      if (websocket && websocket.readyState === WebSocket.OPEN) {
         widgetLog("Отправляем команду для очистки буфера ввода перед стартом прослушивания.");
         websocket.send(JSON.stringify({
           type: "input_audio_buffer.clear",
           event_id: `clear_start_${Date.now()}`
         }));
      } else {
         widgetLog("WebSocket не открыт, не можем отправить команду очистки буфера.", "warn");
         // Возможно, нужно прервать startListening здесь или показать ошибку
         // В текущей логике connectWebSocket вызовется позже если нужно
      }

      // Сбрасываем флаги аудио данных и VAD
      hasAudioData = false;
      audioDataStartTime = 0;
      if (voiceDetector) {
        voiceDetector.reset();
      }
      
      isListening = true; // Устанавливаем флаг прослушивания после всех проверок

      // Активируем визуальное состояние прослушивания если не воспроизводится аудио
      if (!isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
         hideMessage(); // Скрываем предыдущие сообщения при начале прослушивания
      }
      widgetLog("Прослушивание активно.");
    }
    
    // Функция для отправки аудиобуфера
    function commitAudioBuffer() {
      // Проверяем основные условия перед отправкой
      if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
         widgetLog("Cannot commit audio buffer: not listening, websocket not open, or reconnecting.", "debug");
         return;
      }
      
      // Проверяем, есть ли в буфере достаточно аудиоданных
      if (!hasAudioData) {
        widgetLog("Не отправляем пустой аудиобуфер (hasAudioData is false)", "debug");
        return;
      }
      
      // Проверяем минимальную длительность аудио
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс < ${minimumAudioLength}мс), ожидаем больше данных`, "debug");
        
        // Не отправляем пока буфер слишком короткий, просто ждем новых данных.
        // Логика commitAudioBuffer вызывается из onaudioprocess, поэтому она будет вызвана снова.
        // Добавление таймаута здесь может привести к задержкам или дублированию логики.
        return;
      }
      
      // Если все проверки пройдены, отправляем буфер
      sendCommitBuffer();
    }
    
    // Функция для фактической отправки буфера
    function sendCommitBuffer() {
      // Двойная проверка условий перед отправкой
       if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
          widgetLog("Cannot send commit buffer: conditions not met.", "warn");
          return;
       }

      widgetLog("Отправка аудиобуфера...");
      
      // Дополнительная проверка на минимальную длину аудио для отправки на сервер (например, для Whisper API требуется > 100мс)
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < 100) { // Убедимся, что буфер имеет хотя бы 100мс данных
        widgetLog(`Аудиобуфер слишком короткий для обработки на сервере (${audioLength}мс < 100мс), не отправляем commit. Сбрасываем флаги.`, "warn");
        
        // Начинаем следующий цикл прослушивания
        hasAudioData = false;
        audioDataStartTime = 0;
        // Возможно, стоит обновить UI, чтобы показать, что запись продолжается
        // updateAudioVisualization(new Float32Array(0)); // Сбросить визуал, но не статус listening
        return;
      }
      
      // Для мобильных устройств добавляем краткую паузу перед отправкой,
      // чтобы дать время UI обновиться или предотвратить мгновенный переход в speaking
      if (isMobile) {
        setTimeout(() => {
          if (!isPlayingAudio) { // Только если не начали говорить
             mainCircle.classList.remove('listening');
          }
        }, 100); // Короткая задержка
      } else {
        // Сбрасываем эффект активности сразу для десктопа
        if (!isPlayingAudio) {
           mainCircle.classList.remove('listening');
        }
      }
      
      // Отправляем команду для завершения буфера
      try {
         websocket.send(JSON.stringify({
           type: "input_audio_buffer.commit",
           event_id: `commit_${Date.now()}`
         }));
         widgetLog("input_audio_buffer.commit отправлен.");
      } catch (e) {
         widgetLog(`Ошибка при отправке commit: ${e.message}`, "error");
         // Обработка ошибки отправки
      }
      
      // Показываем индикатор загрузки для мобильных устройств
      if (isMobile && loaderModal) {
        // Кратковременно показываем загрузку
        loaderModal.classList.add('active');
        setTimeout(() => {
          loaderModal.classList.remove('active');
        }, 1000);
      }
      
      // Сбрасываем флаги для следующего сегмента аудио
      hasAudioData = false;
      audioDataStartTime = 0;
       widgetLog("Флаги hasAudioData и audioDataStartTime сброшены.");
    }
    
    // Обновление аудио визуализации
    function updateAudioVisualization(audioData) {
      if (!audioBars || !isListening || isPlayingAudio) { // Обновляем только во время прослушивания и не во время воспроизведения
         // Сбросить визуал если не слушаем или воспроизводим?
         // resetAudioVisualization(); // Лучше не сбрасывать здесь, может мерцать
         return;
      }
      
      const bars = audioBars.children;
      if (!bars.length) return;
      
      // Вычисляем громкость для визуализации
      let sum = 0;
      const sampleSize = Math.floor(audioData.length / bars.length);
      
      for (let i = 0; i < bars.length; i++) {
        const start = i * sampleSize;
        let volume = 0;
        
        // Суммируем квадрат амплитуды для громкости
        for (let j = 0; j < sampleSize; j++) {
          if (start + j < audioData.length) {
            volume += audioData[start + j] * audioData[start + j];
          }
        }
        
        // Среднеквадратичное значение и масштабирование
        // Увеличиваем масштаб для лучшей видимости низких уровней
        volume = Math.sqrt(volume / sampleSize) * 150; // Увеличен множитель
        
        // Ограничение значения для визуализации
        volume = Math.min(30, Math.max(2, volume)); // Максимальная высота бара 30px, минимальная 2px
        
        // Применяем высоту к бару с анимацией
        bars[i].style.height = volume + 'px';
        sum += volume;
      }
       // Можно добавить общий показатель громкости, если нужно
       // const averageVisualVolume = sum / bars.length;
    }
    
    // Сброс визуализации
    function resetAudioVisualization() {
      if (!audioBars) return;
       widgetLog("Resetting audio visualization.");
      const bars = audioBars.children;
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.height = '2px'; // Устанавливаем минимальную высоту
      }
    }
    
    // Функция преобразования ArrayBuffer в Base64
      function arrayBufferToBase64(buffer) {
        // Проверяем, что это действительно ArrayBuffer
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
        // Используем try-catch на случай ошибок base64 кодирования (редко)
        try {
           return window.btoa(binary);
        } catch (e) {
           widgetLog(`Ошибка btoa кодирования: ${e.message}`, "error");
           return "";
        }
      }
      
      // Подключение WebSocket
      function connectWebSocket() {
        if (websocket && (websocket.readyState === WebSocket.CONNECTING || 
                         websocket.readyState === WebSocket.OPEN)) {
          widgetLog("WebSocket уже подключен или в процессе подключения");
          updateConnectionStatus('connecting', 'Подключение...');
          return;
        }
        
        widgetLog(`Попытка подключения WebSocket к ${WS_URL}`);
        isReconnecting = true; // Устанавливаем флаг перед попыткой
        // loaderModal.classList.add('active'); // Лоадер может быть включен позже, после начала попытки

        // Очищаем предыдущий WebSocket объект, если он существовал и не был закрыт
        if (websocket) {
             websocket.onopen = websocket.onerror = websocket.onclose = websocket.onmessage = null; // Удаляем старые обработчики
             try { websocket.close(); } catch(e) { widgetLog("Error closing previous websocket:", e.message, "warn"); }
        }
        
        try {
          // Создаем новое WebSocket соединение
          websocket = new WebSocket(WS_URL);
          
          // Установка тайм-аута для подключения
          const connectionTimeoutId = setTimeout(() => {
            if (websocket && websocket.readyState !== WebSocket.OPEN) {
              widgetLog("Таймаут соединения WebSocket", "error");
              
              // Закрываем соединение, чтобы вызвать onclose и инициировать переподключение
              if (websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
                websocket.close();
              } else {
                 // Если уже в процессе закрытия, onclose сработает само
                 widgetLog("WebSocket уже в процессе закрытия, таймаут сработал.");
              }
            }
          }, CONNECTION_TIMEOUT);
          
          // Обработчик успешного подключения
          websocket.onopen = function() {
            widgetLog("WebSocket соединение установлено");
            
            // Очищаем таймаут
            clearTimeout(connectionTimeoutId);
            
            isConnected = true;
            isReconnecting = false;
            loaderModal.classList.remove('active');
            hideConnectionError();
            hideMessage(); // Скрываем сообщение "Подключение..."
            
            // Сбрасываем счетчик попыток
            reconnectAttempts = 0;
            
            // Устанавливаем интервал проверки соединения (ping/pong)
            if (pingIntervalId) {
              clearInterval(pingIntervalId);
            }
            
            pingIntervalId = setInterval(() => {
              if (websocket && websocket.readyState === WebSocket.OPEN) {
                try {
                  websocket.send(JSON.stringify({ 
                    type: "ping",
                    event_id: `ping_${Date.now()}`
                  }));
                  
                  lastPingTime = Date.now();
                  
                  // Проверяем, получили ли мы ответ на предыдущий ping
                  // Даем немного больше времени, чем интервал пинга
                  if (Date.now() - lastPongTime > (isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL) * 3 + 5000) { // +5 секунд запаса
                    widgetLog("Нет ответа на ping в течение длительного времени, переподключение...", "warn");
                    
                    // Сбрасываем соединение и переподключаемся
                    reconnect(); // Этот вызов вызовет websocket.close()
                  }
                } catch (e) {
                  widgetLog(`Ошибка отправки ping: ${e.message}`, "error");
                  reconnect(); // Ошибка отправки также может означать проблему с соединением
                }
              } else {
                 // Если WebSocket не открыт, очищаем интервал пинга
                 if (pingIntervalId) {
                    clearInterval(pingIntervalId);
                    pingIntervalId = null;
                 }
                 widgetLog("WebSocket не открыт, остановлен интервал пинга.", "debug");
              }
            }, isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL);
            
            // Запускаем прослушивание если виджет открыт
            if (isWidgetOpen && !isListening && !isPlayingAudio) {
              // На мобильных устройствах используем безопасный метод запуска
              if (isMobile) {
                safeStartListeningOnMobile();
              } else {
                startListening(); // На десктопе можно сразу
              }
            } else {
              widgetLog(`Widget is not open or already active. Not starting listening on open: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}`);
            }
            
            updateConnectionStatus('connected', 'Подключено');
          };
          
          // Обработчик ошибок WebSocket
          websocket.onerror = function(error) {
            // Ошибки часто сопровождаются событием onclose, поэтому основная логика переподключения в onclose
            widgetLog(`WebSocket ошибка: ${error.message || "Неизвестная ошибка"}`, "error");
            // Не вызываем reconnect() или close() здесь, чтобы избежать двойного срабатывания с onclose
          };
          
          // Обработчик закрытия соединения
          websocket.onclose = function(event) {
            widgetLog(`WebSocket соединение закрыто: код ${event.code}, причина: ${event.reason}`);
            
            // Очищаем таймаут подключения, если он еще активен
            clearTimeout(connectionTimeoutId);
            
            // Очищаем интервал пинга
            if (pingIntervalId) {
              clearInterval(pingIntervalId);
              pingIntervalId = null;
            }
            
            // Отмечаем как отключенный
            isConnected = false;
            
            // Останавливаем аудиопроцессы, так как отправлять данные некуда
            stopAllAudioProcessing();

            // Пробуем переподключиться, если это не было преднамеренное закрытие (код 1000 - нормальное закрытие)
            // и если мы не достигли максимального количества попыток
            if (event.code !== 1000 && !connectionFailedPermanently) {
              reconnectAttempts++;
              const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

              if (reconnectAttempts <= maxAttempts) {
                widgetLog(`Соединение закрыто (${event.code}), попытка переподключения ${reconnectAttempts}/${maxAttempts}`);
                
                isReconnecting = true; // Устанавливаем флаг переподключения

                // Экспоненциальная задержка с рандомным джиттером для предотвращения thundering herd
                const delay = Math.min(reconnectAttempts, 5) * 1000 + Math.random() * 1000; // От 1 до 5 секунд + джиттер
                
                setTimeout(() => {
                  connectWebSocket();
                }, delay);
                
                updateConnectionStatus('connecting', `Переподключение (${reconnectAttempts})...`);
                showMessage(`Переподключение...`);

              } else {
                widgetLog(`Достигнуто максимальное количество попыток (${maxAttempts}), соединение не установлено`, "error");
                
                connectionFailedPermanently = true;
                isReconnecting = false; // Сбрасываем флаг

                loaderModal.classList.remove('active'); // Убираем лоадер
                
                showConnectionError('Не удалось подключиться к серверу. Проверьте соединение с интернетом и попробуйте снова.');
                showMessage("Ошибка соединения с сервером"); // Показываем финальное сообщение об ошибке
                
                updateConnectionStatus('disconnected', 'Отключено');
                 // Возможно, стоит сбросить websocket = null; здесь
              }
            } else if (event.code === 1000) {
                widgetLog("Соединение закрыто штатно (код 1000).");
                isConnected = false;
                isReconnecting = false;
                updateConnectionStatus('disconnected', 'Отключено');
                // Если виджет открыт, возможно, нужно предложить переподключение или просто показать статус
                if (isWidgetOpen) {
                   showMessage("Соединение закрыто.");
                }
            } else {
                 // Соединение закрыто после достижения лимита попыток
                 widgetLog("Соединение закрыто после достижения лимита попыток переподключения.", "info");
                 isConnected = false;
                 isReconnecting = false;
                 updateConnectionStatus('disconnected', 'Отключено');
                 // Сообщение об ошибке уже должно быть показано функцией connectWebSocket
            }
             websocket = null; // Очищаем ссылку на объект WebSocket после закрытия
          };
          
          // Обработчик сообщений от сервера
          websocket.onmessage = function(event) {
            try {
              const message = JSON.parse(event.data);
              
              // Обработка pong-сообщений
              if (message.type === "pong") {
                lastPongTime = Date.now();
                widgetLog("Получен pong.", "debug");
                // Возможно, стоит обновлять статус на "Подключено" при получении pong,
                // если он был в другом состоянии
                 if (!isConnected) {
                     isConnected = true;
                     updateConnectionStatus('connected', 'Подключено');
                 }
                 if (isReconnecting) isReconnecting = false; // Если был в процессе переподключения, но получили pong
                return;
              }
              
              // Обработка сообщений с аудио
              if (message.type === "speech.data") {
                if (message.data && message.data.audio) {
                  widgetLog(`Получен аудиофрагмент (${message.data.audio.length} bytes Base64)`, "debug");
                  // Преобразуем base64 в бинарные данные
                  const audioData = base64ToArrayBuffer(message.data.audio);
                  
                  // Добавляем аудио в очередь воспроизведения
                  audioPlaybackQueue.push(audioData);
                  widgetLog(`Аудио добавлено в очередь воспроизведения. Очередь: ${audioPlaybackQueue.length}`, "debug");

                  // Запускаем воспроизведение если не активно
                  if (!isPlayingAudio) {
                    playNextAudioInQueue();
                  }
                } else {
                   widgetLog("Получен speech.data без аудио данных.", "warn");
                }
              }
              
              // Обработка текстовых сообщений
              if (message.type === "speech.transcript") {
                if (message.data && message.data.text) {
                  widgetLog(`Получен транскрипт: "${message.data.text}"`);
                  showMessage(message.data.text);
                } else {
                   widgetLog("Получен speech.transcript без текстовых данных.", "warn");
                }
              }
              
              // Обработка начала генерации речи
              if (message.type === "speech.started") {
                widgetLog("Генерация речи началась (speech.started).");
                // Добавляем класс для отображения состояния
                mainCircle.classList.remove('listening'); // Убираем состояние прослушивания
                mainCircle.classList.add('speaking'); // Добавляем состояние говорения
                 isListening = false; // Останавливаем запись микрофона на время говорения
                 // stopMicrophoneCapture(); // Можно остановить микрофон явно, но флаг isListening в onaudioprocess остановит отправку
              }
              
              // Обработка завершения генерации речи
              if (message.type === "speech.done") {
                widgetLog("Генерация речи завершена (speech.done).");
                // После завершения всего ответа и проигрывания аудио
                // возвращаемся к прослушиванию.
                // Подождем немного, чтобы воспроизведение успело начаться или завершиться
                setTimeout(() => {
                  widgetLog("Завершение состояния 'speaking' и потенциальный возврат к прослушиванию.");
                  mainCircle.classList.remove('speaking');
                  
                  // Восстанавливаем микрофон после воспроизведения если нужно
                  // Это происходит в playNextAudioInQueue когда очередь пуста
                  // restoreMicrophoneIfNeeded(); // Этот вызов уже есть в конце playNextAudioInQueue
                  
                  // Если виджет открыт и нет активного воспроизведения, снова начинаем слушать
                  // Проверка isPlayingAudio важна
                  if (isWidgetOpen && isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                    startListening();
                  } else {
                    widgetLog(`Не удается начать прослушивание после speech.done: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
                     if (isWidgetOpen && isConnected) {
                        // Если виджет открыт и подключено, но не слушаем и не говорим,
                        // и нет воспроизведения - возможно, что-то пошло не так
                        // или ждем следующего действия пользователя.
                     }
                  }
                }, 500); // Небольшая задержка
              }
            } catch (error) {
              widgetLog(`Ошибка обработки сообщения: ${error.message}`, "error");
            }
          };
        } catch (error) {
          widgetLog(`Ошибка создания WebSocket: ${error.message}`, "error");
          
          isReconnecting = false; // Сбрасываем флаг
          loaderModal.classList.remove('active'); // Убираем лоадер
          
          showConnectionError('Ошибка при подключении к серверу.');
          showMessage("Ошибка соединения с сервером");
           updateConnectionStatus('disconnected', 'Ошибка подключения');
        }
      }
      
      // Функция конвертации Base64 в ArrayBuffer
      function base64ToArrayBuffer(base64) {
        // Проверяем, что входные данные строка и не пустая
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
            // Возвращаем пустой буфер или null в случае ошибки
            return new ArrayBuffer(0);
        }
      }
      
      // Воспроизведение аудио из очереди
      function playNextAudioInQueue() {
        if (audioPlaybackQueue.length === 0) {
          widgetLog("Очередь воспроизведения пуста.");
          isPlayingAudio = false;
          
          // Восстанавливаем микрофон если нужно после завершения всей очереди
          restoreMicrophoneIfNeeded();
          
          // Если виджет открыт, подключен, не слушаем, не в процессе переподключения,
          // и только что закончили говорить (у UI снят класс speaking),
          // можно снова начать слушать. Но speech.done обработчик тоже делает это.
          // Добавим небольшую задержку, чтобы избежать конфликтов
           setTimeout(() => {
               if (isWidgetOpen && isConnected && !isListening && !isReconnecting && !mainCircle.classList.contains('speaking')) {
                  widgetLog("Очередь пуста, виджет открыт, подключен, не слушаем, не говорим. Начинаем прослушивание.");
                  startListening();
               } else {
                  widgetLog(`Очередь пуста, но условия для начала прослушивания не выполнены: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isReconnecting=${isReconnecting}, isSpeaking=${mainCircle.classList.contains('speaking')}`);
               }
           }, 100); // Короткая задержка

          return;
        }
        
        isPlayingAudio = true;
        widgetLog(`Начало воспроизведения аудиофрагмента. В очереди: ${audioPlaybackQueue.length}`);

        // Для iOS нужно сохранить состояние микрофона
        if (isIOS && isListening) {
          widgetLog("Пауза записи микрофона на iOS на время воспроизведения.");
          shouldRestoreMicrophoneAfterPlayback = true;
          stopMicrophoneCapture(); // Останавливаем микрофон
        }
        
        // Берем следующий фрагмент аудио из очереди
        const audioData = audioPlaybackQueue.shift();
        
        // Создаем аудиоконтекст если его нет или он закрыт
        if (!audioContext || audioContext.state === 'closed') {
          widgetLog("AudioContext не доступен для воспроизведения, пытаемся создать/возобновить.", "warn");
           // Пытаемся переинициализировать аудиосистему
           initAudio().then(success => {
               if (success) {
                   widgetLog("AudioContext успешно восстановлен, пытаемся снова воспроизвести.");
                   // Возвращаем текущий фрагмент в начало очереди и пытаемся снова
                   audioPlaybackQueue.unshift(audioData);
                   // Вызываем playNextAudioInQueue через короткую задержку,
                   // чтобы дать контексту время на возобновление
                   setTimeout(playNextAudioInQueue, 200);
               } else {
                   widgetLog("Не удалось восстановить AudioContext для воспроизведения.", "error");
                   isPlayingAudio = false; // Не можем воспроизвести
                   // Очищаем очередь, так как воспроизведение, вероятно, невозможно
                   audioPlaybackQueue = [];
                   showMessage("Ошибка воспроизведения аудио.");
                    // Восстанавливаем микрофон, если нужно
                    restoreMicrophoneIfNeeded();
               }
           }).catch(e => {
               widgetLog(`Ошибка при попытке восстановления аудиоконтекста для воспроизведения: ${e.message}`, "error");
               isPlayingAudio = false;
               audioPlaybackQueue = [];
               showMessage("Критическая ошибка воспроизведения аудио.");
                restoreMicrophoneIfNeeded();
           });
           return; // Прерываем текущую попытку воспроизведения
        }

        // Проверяем состояние AudioContext
        if (audioContext.state === 'suspended') {
            widgetLog("AudioContext suspended во время воспроизведения, пытаемся возобновить.");
            audioContext.resume().then(() => {
                widgetLog("AudioContext успешно возобновлен для воспроизведения.");
                 // Возвращаем текущий фрагмент в начало очереди и пытаемся снова
                 audioPlaybackQueue.unshift(audioData);
                 // Вызываем playNextAudioInQueue через короткую задержку
                 setTimeout(playNextAudioInQueue, 100);
            }).catch(err => {
                widgetLog(`Не удалось возобновить AudioContext для воспроизведения: ${err.message}`, "error");
                 isPlayingAudio = false; // Не можем воспроизвести
                 audioPlaybackQueue = [];
                 showMessage("Ошибка активации аудио для воспроизведения.");
                 restoreMicrophoneIfNeeded();
            });
            return; // Прерываем текущую попытку воспроизведения
        }
        
        // Декодируем аудиоданные
        audioContext.decodeAudioData(audioData, 
          // Успешное декодирование
          function(decodedData) {
            widgetLog(`Аудиофрагмент успешно декодирован (${decodedData.duration.toFixed(2)}s).`);
            // Создаем источник
            const source = audioContext.createBufferSource();
            source.buffer = decodedData;
            
            // Подключаем к выходу
            // Убедимся, что AudioContext destination доступен
            if (!audioContext.destination) {
               widgetLog("AudioContext destination is not available!", "error");
               isPlayingAudio = false;
               playNextAudioInQueue(); // Переходим к следующему или завершаем
               return;
            }
            source.connect(audioContext.destination);
            
            // По окончании воспроизведения текущего фрагмента
            source.onended = function() {
              widgetLog("Воспроизведение аудиофрагмента завершено.");
              // Воспроизводим следующий фрагмент если есть
              if (audioPlaybackQueue.length > 0) {
                playNextAudioInQueue();
              } else {
                widgetLog("Очередь воспроизведения полностью завершена.");
                isPlayingAudio = false;
                
                // Восстанавливаем микрофон если нужно после завершения всей очереди
                restoreMicrophoneIfNeeded();
                
                // Если виджет открыт, подключен, не слушаем, не говорим, и не в процессе переподключения
                // (mainCircle.classList.contains('speaking') убирается в speech.done)
                // то можно снова начать слушать.
                 // Этот блок частично дублирует логику speech.done и начала playNextAudioInQueue,
                 // но обеспечивает запуск прослушивания, если speech.done пришел раньше или позже.
                 // Возможно, стоит убрать этот блок и полностью положиться на speech.done и проверку playNextAudioInQueue.
                 /*
                if (isWidgetOpen && isConnected && !isListening && !isReconnecting && !mainCircle.classList.contains('speaking')) {
                     widgetLog("Play queue empty, starting listening...");
                    startListening();
                } else {
                     widgetLog(`Play queue empty, cannot start listening: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isReconnecting=${isReconnecting}, isSpeaking=${mainCircle.classList.contains('speaking')}`);
                }
                */
              }
            };
            
            // Запускаем воспроизведение
            source.start(0);
             widgetLog("source.start(0) called.");
          }, 
          // Ошибка декодирования
          function(error) {
            widgetLog(`Ошибка декодирования аудио: ${error.message}`, "error");
            
            // Переходим к следующему аудио в очереди
            playNextAudioInQueue(); // Пытаемся воспроизвести следующий
          }
        );
      }
      
      // Функция переподключения (вызывается из onclose при ошибке)
      function reconnect() {
        if (isReconnecting) {
           widgetLog("reconnect() called but isReconnecting is true. Aborting.", "debug");
           return;
        }
        
        widgetLog("Initiating reconnect process...");
        isReconnecting = true; // Устанавливаем флаг сразу
        
        // Очищаем существующие ресурсы WebSocket
        if (websocket) {
          widgetLog("Closing existing websocket before reconnect.");
          // Удаляем обработчики, чтобы они не срабатывали при закрытии
          websocket.onopen = websocket.onerror = websocket.onclose = websocket.onmessage = null;
          try {
             // Закрываем принудительно, если он не закрыт
             if (websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
                websocket.close(1000, "Reconnecting"); // Используем код 1000, чтобы onclose не вызывал reconnect снова
             }
          } catch (e) {
            widgetLog(`Ошибка закрытия websocket при reconnect: ${e.message}`, "warn");
          }
           websocket = null; // Очищаем ссылку
        }
        
        // Сбрасываем флаги состояния виджета
        isConnected = false;
        
        // Останавливаем аудиопроцессы, так как отправлять данные некуда
        stopAllAudioProcessing(); // Этот вызов сбросит isListening = false

        // Логика повторных попыток теперь в connectWebSocket и его обработчиках error/close
        // Просто вызываем connectWebSocket для начала новой попытки
        connectWebSocket();
      }
      
      // Добавляем обработчики событий для UI элементов (основные кнопки)
      // Находим кнопки здесь, а не в начале initWidget, чтобы гарантировать их наличие
      // после createWidgetHTML()
      const widgetButtonEl = document.getElementById('wellcomeai-widget-button');
      const widgetCloseEl = document.getElementById('wellcomeai-widget-close');
      
      if (widgetButtonEl) {
         widgetButtonEl.addEventListener('click', function() {
           widgetLog("Widget button clicked. isWidgetOpen = " + isWidgetOpen);
           if (!isWidgetOpen) {
             openWidget();
           } else {
             closeWidget();
           }
         });
      } else {
         widgetLog("Error: Widget button element not found!", "error");
      }

      if (widgetCloseEl) {
         widgetCloseEl.addEventListener('click', closeWidget);
      } else {
         widgetLog("Error: Widget close button element not found!", "error");
      }
      
      // Обработчик для кнопки повторного подключения (находится внутри connectionError)
      // retryButton уже найдена в начале initWidget
      if (retryButton) {
        // Удаляем предыдущий обработчик, если он был, чтобы избежать дублирования
        const oldRetryButton = retryButton.cloneNode(true);
        retryButton.parentNode.replaceChild(oldRetryButton, retryButton);
        const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button'); // Находим новую кнопку
        
        if (newRetryButton) {
           // Используем { once: true } для автоматического удаления после первого клика
           // или добавляем обработчик в showConnectionError при создании кнопки
           // Давайте добавим его в showConnectionError, т.к. кнопка может пересоздаваться
           // retryButton.addEventListener('click', resetConnection); // Эту строку можно убрать, она будет добавлена в showConnectionError
        } else {
             widgetLog("Error: Retry button element not found!", "error");
        }
      } else {
          widgetLog("Retry button element not found during init. It might be created dynamically later.", "warn");
          // Обработчик будет добавлен в showConnectionError при создании кнопки
      }

       widgetLog("UI Event listeners added.");

    } // <--- ЭТА СКОБКА ЗАКРЫВАЕТ ФУНКЦИЮ initWidget

  // --- Запуск виджета после определения всех функций ---

  // Проверяем готовность DOM и запускаем инициализацию и подключение
  if (document.readyState === 'loading') {
    widgetLog("DOM not ready yet, waiting for DOMContentLoaded.");
    document.addEventListener('DOMContentLoaded', function() {
      widgetLog("DOMContentLoaded fired. Starting widget setup.");
      createStyles();
      loadFontAwesome();
      createWidgetHTML();
      // Теперь, когда HTML создан и DOM готов, инициализируем логику виджета и WS
      initWidget();
      connectWebSocket();
    });
  } else {
    // DOM уже готов
    widgetLog("DOM is already ready. Starting widget setup immediately.");
    createStyles();
    loadFontAwesome();
    createWidgetHTML();
    // Инициализируем логику виджета и WS
    initWidget();
    connectWebSocket();
  }

})();
