/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.3.0
 * 
 * Этот скрипт динамически создает и встраивает виджет голосового ассистента
 * на любой сайт, в том числе на Tilda и другие конструкторы сайтов.
 * Улучшена поддержка мобильных устройств и iOS.
 */

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
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  
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
        // Xiaomi требует особых настроек для надежной работы
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
          // Простой фильтр высоких частот
          const highpass = processedData[i] - prevSample * 0.5;
          processedData[i] = highpass;
          prevSample = processedData[i];
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
    const retryButton = document.getElementById('wellcomeai-retry-button');
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
    
    // Проверка элементов
    if (!widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay) {
      widgetLog("Some UI elements were not found!", 'error');
      return;
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
      
      // Скрываем через некоторое время
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
      // Останавливаем прослушивание
      isListening = false;
      
      // Останавливаем воспроизведение
      isPlayingAudio = false;
      
      // Очищаем буферы и очереди
      audioChunksBuffer = [];
      audioPlaybackQueue = [];
      
      // Сбрасываем флаги
      hasAudioData = false;
      audioDataStartTime = 0;
      
      // Если есть активное соединение WebSocket, отправляем команду остановки
      if (websocket && websocket.readyState === WebSocket.OPEN) {
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
      }
      
      // Сбрасываем состояние UI
      mainCircle.classList.remove('listening');
      mainCircle.classList.remove('speaking');
      
      // Сбрасываем визуализацию
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
        
        // Добавляем обработчик для новой кнопки
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
          iosAudioButton.addEventListener('click', function() {
            unlockAudioOnIOS().then(success => {
              if (success) {
                iosAudioButton.classList.remove('visible');
                // Пытаемся начать слушать после активации аудио
                setTimeout(() => {
                  if (isConnected && !isListening && !isPlayingAudio) {
                    startListening();
                  }
                }, 500);
              }
            });
          });
        }
        
        // Пытаемся сразу разблокировать аудио
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
          try {
            // Создаем временный аудио контекст для мобильных
            if (!window.tempAudioContext) {
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            window.audioContextInitialized = true;
            widgetLog("Mobile audio context инициализирован с задержкой");
            
            if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
              startListening();
            }
          } catch (e) {
            widgetLog(`Ошибка инициализации аудиоконтекста: ${e.message}`, "error");
          }
        }, 2000); // Задержка 2 секунды для стабилизации WebSocket-соединения
      }
      
      // Показываем сообщение о проблеме с подключением, если оно есть
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        return;
      }
      
      // Запускаем прослушивание при открытии, если соединение активно
      if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
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
        connectWebSocket();
      } else {
        widgetLog(`Cannot start listening yet: isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
        
        if (isReconnecting) {
          updateConnectionStatus('connecting', 'Переподключение...');
        }
      }
      
      // Убираем пульсацию с кнопки
      widgetButton.classList.remove('wellcomeai-pulse-animation');
    }
    
    // Закрыть виджет
    function closeWidget() {
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
      }
      
      // Принудительно скрываем расширенный виджет
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "0";
        expandedWidget.style.height = "0";
        expandedWidget.style.pointerEvents = "none";
      }
    }
    
    // Инициализация микрофона и AudioContext
    async function initAudio() {
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
          
          // Для iOS сначала разблокируем аудио
          await unlockAudioOnIOS();
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
          widgetLog(`Ошибка с оптимизированными настройками: ${micError.message}`, 'warn');
          
          // Пробуем резервный вариант с базовыми настройками
          try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            widgetLog('Доступ к микрофону получен с базовыми настройками');
          } catch (fallbackError) {
            widgetLog(`Критическая ошибка доступа к микрофону: ${fallbackError.message}`, 'error');
            throw fallbackError;
          }
        }
        
        // Инициализация AudioContext с правильными настройками
        let contextOptions = {};
        
        // Настраиваем частоту дискретизации в зависимости от устройства
        if (isIOS) {
          contextOptions.sampleRate = 16000; // Меньше нагрузка для iOS
        } else if (isMobile) {
          contextOptions.sampleRate = 16000; // Оптимальная для распознавания речи
        } else {
          contextOptions.sampleRate = 24000; // Высокое качество для десктопа
        }
        
        // Для iOS используем существующий контекст
        if (isIOS && window.tempAudioContext) {
          audioContext = window.tempAudioContext;
          
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
            window.audioContextInitialized = true;
            widgetLog('Существующий AudioContext активирован на iOS');
          }
        } else {
          // Создаем новый AudioContext
          try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
            
            if (isIOS) {
              window.tempAudioContext = audioContext;
              window.audioContextInitialized = true;
            }
            
            widgetLog(`AudioContext создан с частотой ${audioContext.sampleRate} Гц`);
          } catch (contextError) {
            widgetLog(`Ошибка создания AudioContext: ${contextError.message}`, 'error');
            throw contextError;
          }
        }
        
        // Оптимизированные размеры буфера для разных устройств
        const bufferSize = isIOS ? 2048 : // Больше для iOS для стабильности
                         isMobile ? 1024 : 
                         2048;
        
        // Создаем процессор для обработки аудио
        try {
          if (audioContext.createScriptProcessor) {
            audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
          } else if (audioContext.createJavaScriptNode) { // Для старых версий Safari
            audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
            widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${bufferSize}`);
          } else {
            throw new Error("Ваш браузер не поддерживает обработку аудио");
          }
        } catch (processorError) {
          widgetLog(`Ошибка создания аудиопроцессора: ${processorError.message}`, 'error');
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
        return true;
      } catch (error) {
        widgetLog(`Ошибка инициализации аудио: ${error.message}`, "error");
        
        // Особая обработка для iOS
        if (isIOS && iosAudioButton) {
          iosAudioButton.classList.add('visible');
          showMessage("Нажмите кнопку ниже для активации микрофона", 0);
        } else {
          showMessage("Ошибка доступа к микрофону. Проверьте настройки браузера.");
        }
        
        return false;
      }
    }
    
    // Начало записи голоса
    async function startListening() {
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`);
        return;
      }
      
      // Для iOS применяем глубокую разблокировку аудио перед стартом записи
      if (isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          await forceIOSAudioUnlock();
        }
      }
      
      isListening = true;
      widgetLog('Начинаем прослушивание');
      
      // Отправляем команду для очистки буфера ввода
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
      }
      
      // Особая обработка для iOS устройств
      if (isIOS) {
        // Если аудио еще не инициализировано, активируем
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          // Пытаемся принудительно активировать
          await unlockAudioOnIOS();
          
          // Если все еще не активировано, показываем кнопку
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
      
      // Если аудио еще не инициализировано, делаем это
      if (!audioContext) {
        const success = await initAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио', 'error');
          isListening = false;
          return;
        }
      } else if (audioContext.state === 'suspended') {
        // Возобновляем AudioContext если он был приостановлен
        try {
          await audioContext.resume();
          widgetLog('AudioContext возобновлен');
        } catch (error) {
          widgetLog(`Не удалось возобновить AudioContext: ${error}`, 'error');
          isListening = false;
          
          // Для iOS показываем специальную кнопку
          if (isIOS && iosAudioButton) {
            iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
          }
          
          return;
        }
      }
      
      // Сбрасываем флаги аудио данных
      hasAudioData = false;
      audioDataStartTime = 0;
      
      // Сбрасываем VAD детектор
      if (voiceDetector) {
        voiceDetector.reset();
      }
      
      // Активируем визуальное состояние прослушивания если не воспроизводится аудио
      if (!isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
    }
    
    // Функция для отправки аудиобуфера
    function commitAudioBuffer() {
      if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) return;
      
      // Проверяем, есть ли в буфере достаточно аудиоданных
      if (!hasAudioData) {
        widgetLog("Не отправляем пустой аудиобуфер", "warn");
        return;
      }
      
      // Проверяем минимальную длительность аудио
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс), ожидаем больше данных`, "warn");
        
        // Используем более длинную задержку для мобильных устройств
        const extraDelay = isMobile ? 200 : 50;
        
        // Продолжаем запись еще немного времени
        setTimeout(() => {
          // Повторно пытаемся отправить буфер
          if (isListening && hasAudioData && !isReconnecting) {
            widgetLog(`Отправка аудиобуфера после дополнительной записи (${Date.now() - audioDataStartTime}мс)`);
            sendCommitBuffer();
          }
        }, minimumAudioLength - audioLength + extraDelay);
        
        return;
      }
      
      // Если все проверки пройдены, отправляем буфер
      sendCommitBuffer();
    }
    
    // Функция для фактической отправки буфера
    function sendCommitBuffer() {
      widgetLog("Отправка аудиобуфера");
      
      // Дополнительная проверка на минимальную длину аудио
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < 100) {
        widgetLog(`Аудиобуфер слишком короткий для OpenAI (${audioLength}мс < 100мс), не отправляем`, "warn");
        
        // Начинаем следующий цикл прослушивания
        hasAudioData = false;
        audioDataStartTime = 0;
        
        return;
      }
      
      // Для мобильных устройств добавляем краткую паузу перед отправкой
      if (isMobile) {
        // Сбрасываем эффект активности с небольшой задержкой
        setTimeout(() => {
          mainCircle.classList.remove('listening');
        }, 100);
      } else {
        // Сбрасываем эффект активности сразу
        mainCircle.classList.remove('listening');
      }
      
      // Отправляем команду для завершения буфера
      websocket.send(JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}`
      }));
      
      // Показываем индикатор загрузки для мобильных устройств
      if (isMobile && loaderModal) {
        // Кратковременно показываем загрузку
        loaderModal.classList.add('active');
        setTimeout(() => {
          loaderModal.classList.remove('active');
        }, 1000);
      }
      
      // Начинаем обработку и сбрасываем флаги
      hasAudioData = false;
      audioDataStartTime = 0;
    }
