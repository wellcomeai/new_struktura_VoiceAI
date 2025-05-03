/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.2.1
 * 
 * Этот скрипт динамически создает и встраивает виджет голосового ассистента
 * на любой сайт, в том числе на Tilda и другие конструкторы сайтов.
 * Улучшена поддержка мобильных устройств и iOS.
 */

(function() {
  // =======================================================================
  // --- Настройки виджета ---
  // =======================================================================
  const DEBUG_MODE = false; // Установите в true для вывода отладочных сообщений в консоль
  const MAX_RECONNECT_ATTEMPTS = 5; // Максимальное количество попыток переподключения для десктопа
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10; // Увеличенное количество попыток для мобильных устройств
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 20000; // Таймаут для установления соединения (в миллисекундах)
  const RECONNECT_DELAY_MS = 2000; // Базовая задержка перед переподключением (экспоненциальный рост)
  const MAX_DEBUG_ITEMS = 10; // Максимальное количество записей отладки (для потенциальной панели)

  // =======================================================================
  // --- Глобальное состояние и утилиты ---
  // =======================================================================
  let reconnectAttempts = 0;
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = []; // Очередь отладочных сообщений (для потенциальной панели)
  
  // Определяем тип устройства
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  
  // Глобальные флаги для мобильных устройств и iOS аудио (используются в window для сохранения состояния между функциями)
  window.wellcomeAIAudioContextInitialized = false;
  window.wellcomeAITempAudioContext = null;
  window.wellcomeAIHasPlayedSilence = false;

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info') => {
    // Формируем сообщение с префиксом и меткой времени
    const logPrefix = '[WellcomeAI Widget]';
    const timestamp = new Date().toISOString().slice(11, 23);
    const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
    
    // Логируем в консоль в зависимости от типа и режима отладки
    if (type === 'error') {
      console.error(`${logPrefix} ERROR:`, formattedMessage);
    } else if (type === 'warn') {
      console.warn(`${logPrefix} WARNING:`, formattedMessage);
    } else if (DEBUG_MODE) {
      console.log(`${logPrefix}`, formattedMessage);
    }
  };

  // Функция для добавления сообщения в очередь отладки (не используется в этой версии UI)
  const addToDebugQueue = (message, type = 'info') => {
    if (!DEBUG_MODE) return;
    const timestamp = new Date().toISOString();
    debugQueue.push({ timestamp, message, type });
    if (debugQueue.length > MAX_DEBUG_ITEMS) {
      debugQueue.shift();
    }
    updateDebugPanel(); // Обновляем панель (если она есть)
  };

  // Получить отладочную информацию в виде строки (не используется в этой версии UI)
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  // Обновление отладочной панели (стаб, не реализовано в этой версии UI)
  const updateDebugPanel = () => {
    if (!DEBUG_MODE) return;
    // Здесь могла бы быть логика обновления DOM для отладочной панели
  };

  // Утилита для кодирования ArrayBuffer в Base64
  function arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
      }
      return window.btoa(binary);
  }

  // Утилита для декодирования Base64 в ArrayBuffer
  function base64ToArrayBuffer(base64) {
      const binary_string = window.atob(base64);
      const len = binary_string.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
          bytes[i] = binary_string.charCodeAt(i);
      }
      return bytes.buffer;
  }

  // =======================================================================
  // --- Определение конфигурации виджета (сервер, ID, позиция) ---
  // =======================================================================

  // Функция для определения URL сервера
  const getServerUrl = () => {
    // 1. Ищем атрибут data-server на скрипте виджета
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
      
      // 2. Ищем скрипт виджета по src и определяем origin
      const src = scriptTags[i].getAttribute('src');
      if (src && (src.includes('widget.js') || src.includes('loader.js'))) { // Ищем widget.js или loader.js
        try {
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
    
    // Убеждаемся, что URL содержит протокол
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) {
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }
    
    // 3. Fallback URL если ничего не найдено
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com'; // Пример fallback URL
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }
    
    return serverUrl.replace(/\/$/, ''); // Убираем конечный слеш
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    // 1. Ищем атрибут data-assistantId на скрипте
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
    
    // 4. Демо-ID для специфичных хостов/путей
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo'; // Замените на актуальный демо ID, если есть
    }
    
    widgetLog('No assistant ID found!', 'error');
    return null;
  };

  // Получение позиции виджета из data-position атрибута
  const getWidgetPosition = () => {
    const defaultPosition = { horizontal: 'right', vertical: 'bottom', distance: '20px' };
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      const positionString = scriptTags[i].getAttribute('data-position') || (scriptTags[i].dataset ? scriptTags[i].dataset.position : null);
      if (positionString) {
        const position = { ...defaultPosition };
        const parts = positionString.split('-');
        if (parts.length === 2) {
          const part1 = parts[0].toLowerCase();
          const part2 = parts[1].toLowerCase();
          if ((part1 === 'top' || part1 === 'bottom') && (part2 === 'left' || part2 === 'right')) {
             position.vertical = part1;
             position.horizontal = part2;
          } else if ((part2 === 'top' || part2 === 'bottom') && (part1 === 'left' || part1 === 'right')) {
             position.vertical = part2;
             position.horizontal = part1;
          }
        }
        widgetLog(`Found widget position from attribute: ${positionString}`);
        return position;
      }
    }
    widgetLog(`Using default widget position: ${defaultPosition.vertical}-${defaultPosition.horizontal}`);
    return defaultPosition;
  };

  // Определяем URL сервера, ID ассистента и позицию виджета
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  
  // Формируем WebSocket URL
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID;
  
  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID || 'N/A'}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);

  // =======================================================================
  // --- Создание и встраивание UI ---
  // =======================================================================

  // Создаем стили для виджета
  function createStyles() {
    if (document.getElementById('wellcomeai-widget-styles')) {
      widgetLog("Styles already exist. Skipping style creation.");
      return;
    }
    const styleEl = document.createElement('style');
    styleEl.id = 'wellcomeai-widget-styles';
    styleEl.textContent = `
      .wellcomeai-widget-container {
        position: fixed;
        ${WIDGET_POSITION.vertical}: ${WIDGET_POSITION.distance};
        ${WIDGET_POSITION.horizontal}: ${WIDGET_POSITION.distance};
        z-index: 2147483647; /* Максимальный z-index */
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: 'Segoe UI', 'Roboto', sans-serif;
        -webkit-tap-highlight-color: transparent; /* Убираем синий фон при нажатии на мобильных */
        line-height: 1.2; /* Улучшаем читаемость текста в сообщениях */
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
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation; /* Предотвращает двойной клик на мобильных */
      }
      
      .wellcomeai-widget-button:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 20px rgba(74, 134, 232, 0.5);
      }
       .wellcomeai-widget-button:active {
        transform: scale(0.95);
        box-shadow: 0 2px 8px rgba(74, 134, 232, 0.5);
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
        max-width: calc(100vw - ${parseFloat(WIDGET_POSITION.distance) * 2}px);
        max-height: calc(100vh - ${parseFloat(WIDGET_POSITION.distance) * 2}px);
         transform-origin: ${WIDGET_POSITION.horizontal} ${WIDGET_POSITION.vertical}; /* Точка трансформации для анимации */
      }
       /* Анимация открытия */
      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 400px; /* Фиксированная высота для анимации */
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
        flex-shrink: 0;
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
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      
      .wellcomeai-widget-close:hover {
        opacity: 1;
        transform: scale(1.1);
      }
       .wellcomeai-widget-close:active {
         opacity: 0.9;
         transform: scale(0.95);
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
        overflow-y: auto; /* Позволяет прокручивать контент, если он не помещается */
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
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
       .wellcomeai-main-circle:active {
        transform: scale(0.95);
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
      
      .wellcomeai-main-circle.idle .wellcomeai-mic-icon {
         color: #4a86e8; /* Синий */
      }
      .wellcomeai-main-circle.listening .wellcomeai-mic-icon {
        color: #2196f3; /* Голубой */
      }
      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon {
        color: #4caf50; /* Зеленый */
      }
       .wellcomeai-main-circle.disabled .wellcomeai-mic-icon {
        color: #b0b0b0; /* Серый */
      }
      .wellcomeai-main-circle.disabled {
         cursor: default;
         opacity: 0.8;
      }
       .wellcomeai-main-circle.disabled:active {
        transform: scale(1); /* Отключаем сжимание при клике в disabled */
      }
      
      .wellcomeai-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px;
        bottom: -5px;
        opacity: 0; /* Скрыта по умолчанию */
        transition: opacity 0.3s ease;
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
        height: 2px; /* Минимальная высота */
        background-color: #4a86e8;
        border-radius: 1px;
        transition: height 0.1s ease;
      }
       .wellcomeai-main-circle.listening .wellcomeai-audio-bar {
         background-color: #2196f3;
       }
        .wellcomeai-main-circle.speaking .wellcomeai-audio-bar {
         background-color: #4caf50;
       }
      
      .wellcomeai-loader-modal {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.9);
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
        pointer-events: none; /* Чтобы не блокировал клики под собой */
      }
      
      .wellcomeai-message-display.show {
        opacity: 1;
        pointer-events: all; /* Возвращаем клики, если сообщение активно */
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
        background-color: rgba(254, 226, 226, 0.9); /* Чуть плотнее фон */
        border: 1px solid #ef4444;
        padding: 12px 15px; /* Увеличил отступы */
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        margin-top: 15px; /* Увеличил отступ */
        text-align: center;
        display: none;
        flex-direction: column;
        align-items: center;
        z-index: 10;
      }
      
      .wellcomeai-connection-error.visible {
        display: flex;
      }

      .wellcomeai-retry-button {
        background-color: #ef4444;
        color: white;
        border: none;
        border-radius: 4px;
        padding: 8px 12px; /* Увеличил размер кнопки */
        font-size: 13px; /* Увеличил шрифт */
        cursor: pointer;
        margin-top: 10px; /* Увеличил отступ */
        transition: all 0.2s;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      
      .wellcomeai-retry-button:hover {
        background-color: #dc2626;
      }
       .wellcomeai-retry-button:active {
        background-color: #b91c1c;
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
        z-index: 10;
         white-space: nowrap; /* Предотвращает перенос строки */
      }
      
      .wellcomeai-status-indicator.show {
        opacity: 0.8;
      }
      
      .wellcomeai-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #10b981; /* Connected */
      }
      
      .wellcomeai-status-dot.disconnected {
        background-color: #ef4444; /* Red */
      }
      
      .wellcomeai-status-dot.connecting {
        background-color: #f59e0b; /* Yellow */
      }

       .wellcomeai-ios-audio-button {
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background-color: #4a86e8;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 10px 15px;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
        display: none; /* Скрыта по умолчанию */
        z-index: 11; /* Выше, чем сообщение */
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }

      .wellcomeai-ios-audio-button.visible {
        display: block; /* Показываем, когда нужно */
      }
       .wellcomeai-ios-audio-button:hover {
         background-color: #2b59c3;
       }
        .wellcomeai-ios-audio-button:active {
         background-color: #1a3e9b;
       }
    `;
    document.head.appendChild(styleEl);
    widgetLog("Styles created and added to head");
  }

  // Загрузка Font Awesome для иконок
  function loadFontAwesome() {
    if (document.getElementById('font-awesome-css')) {
       widgetLog("Font Awesome already loaded. Skipping.");
       return;
    }
    const link = document.createElement('link');
    link.id = 'font-awesome-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
    link.integrity = 'sha512-iecdLmaskl7CVkqkXNQ/ZH/XLlvWZOJyj7Yy7tcenmpD1ypASozpmT/E0iPtmFIB46ZmdtAc9eNBvH0H/ZpiBw==';
    link.crossOrigin = 'anonymous';
    link.referrerPolicy = 'no-referrer';
    document.head.appendChild(link);
    widgetLog("Font Awesome loaded");
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
    if (document.getElementById('wellcomeai-widget-container')) {
      widgetLog("Widget container already exists. Skipping HTML creation.");
      return;
    }
    
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647"; // Устанавливаем высокий z-index

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
          <div class="wellcomeai-main-circle idle" id="wellcomeai-main-circle">
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
            <!-- Кнопка повторить будет добавлена динамически -->
          </div>
          
          <!-- Специальная кнопка для активации аудио на iOS -->
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
            Нажмите для активации микрофона
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

  // =======================================================================
  // --- Управление аудио ---
  // =======================================================================

  // Конфигурация для оптимизации потока аудио
  const AUDIO_CONFIG = {
    silenceThreshold: 0.01,      // Порог для определения тишины (float 0.0 - 1.0)
    silenceDuration: 800,        // Длительность тишины для отправки commit (мс)
    bufferSize: 2048,            // Размер буфера ScriptProcessorNode
    soundDetectionThreshold: 0.005 // Чувствительность к звуку (float 0.0 - 1.0)
  };
  
  // Специальные настройки для мобильных устройств
  const MOBILE_AUDIO_CONFIG = {
    silenceThreshold: 0.015,
    silenceDuration: 1000,
    bufferSize: isIOS ? 4096 : 2048,
    soundDetectionThreshold: 0.01
  };
  
  // Выбираем нужную конфигурацию
  const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;

  // Инициализация AudioContext при пользовательском жесте (для обхода ограничений браузеров)
  function initAudioContextOnUserGesture() {
    if (!window.wellcomeAIAudioContextInitialized && (isIOS || isMobile)) {
        try {
            if (!window.wellcomeAITempAudioContext) {
                 const contextOptions = isIOS ? { sampleRate: 16000 } : {}; // Низкая частота для iOS
                 window.wellcomeAITempAudioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
                 widgetLog(`Создан AudioContext с частотой ${window.wellcomeAITempAudioContext.sampleRate} Гц`);
            }

            const context = window.wellcomeAITempAudioContext;

            if (context.state === 'suspended') {
                context.resume().then(() => {
                    window.wellcomeAIAudioContextInitialized = true;
                    widgetLog('AudioContext успешно возобновлен/активирован пользовательским жестом.');
                    // Скрываем кнопку активации iOS
                    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
                    if (iosAudioButton) {
                      iosAudioButton.classList.remove('visible');
                    }
                    // Если виджет открыт и готов, пытаемся начать слушать
                     if (isWidgetOpen && isConnected && !isReconnecting && !isListening && !isPlayingAudio && !connectionFailedPermanently) {
                         startListening(); // Попытка начать слушать после активации
                     }

                }).catch(err => {
                    widgetLog(`Ошибка при возобновлении AudioContext: ${err.message}`, 'error');
                    showMessage("Ошибка активации аудио. Попробуйте снова.", 5000);
                });
            } else if (context.state === 'running') {
                 window.wellcomeAIAudioContextInitialized = true;
                 widgetLog('AudioContext уже активен.');
                 const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
                 if (iosAudioButton) {
                   iosAudioButton.classList.remove('visible');
                 }
                  if (isWidgetOpen && isConnected && !isReconnecting && !isListening && !isPlayingAudio && !connectionFailedPermanently) {
                     startListening();
                 }
            }

            // Воспроизводим тишину на iOS для разблокировки аудиовыхода
            if (isIOS && !window.wellcomeAIHasPlayedSilence && context.state !== 'suspended') {
                try {
                  const silentBuffer = context.createBuffer(1, 1, 22050);
                  const source = context.createBufferSource();
                  source.buffer = silentBuffer;
                  source.connect(context.destination);
                  source.start(0);
                  source.stop(0.01); // Очень короткий звук
                  source.onended = () => {
                     widgetLog("Проиграна тишина для разблокировки аудиовыхода на iOS.");
                     window.wellcomeAIHasPlayedSilence = true;
                  };
                } catch (e) {
                   widgetLog(`Ошибка при попытке воспроизведения тишины: ${e.message}`, 'warn');
                }
            }

        } catch (e) {
             widgetLog(`Ошибка при инициализации AudioContext: ${e.message}`, 'error');
             showMessage("Ошибка инициализации аудио. Попробуйте обновить страницу.", 5000);
        }
    } else if (window.wellcomeAIAudioContextInitialized) {
         widgetLog("AudioContext уже инициализирован.");
          if (isWidgetOpen && isConnected && !isReconnecting && !isListening && !isPlayingAudio && !connectionFailedPermanently) {
             startListening();
         }
    } else {
        widgetLog("Инициализация AudioContext по жесту не требуется или уже сделана.");
         if (isWidgetOpen && isConnected && !isReconnecting && !isListening && !isPlayingAudio && !connectionFailedPermanently) {
             startListening();
         }
    }
  }


  // Инициализация микрофона и AudioContext для захвата
  async function initAudioCapture() {
      widgetLog("Попытка инициализации аудио захвата...");
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону");
        }
        
        // На iOS сначала убеждаемся, что AudioContext инициализирован пользовательским жестом
        if (isIOS && !window.wellcomeAIAudioContextInitialized) {
             widgetLog("Инициализация аудио захвата: AudioContext еще не активирован на iOS.");
             const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
             if (iosAudioButton) {
                iosAudioButton.classList.add('visible');
             }
             showMessage("Нажмите кнопку ниже для активации микрофона", 0);
             setMainCircleState('disabled');
             return false;
        }

        // Запрашиваем доступ к микрофону
        const audioConstraints = {
          echoCancellation: !isIOS,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: isMobile ? 16000 : 24000 // Оптимальная частота
        };
        
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Доступ к микрофону получен. Sample rate: ${audioConstraints.sampleRate}`);
        } catch (micError) {
          widgetLog(`Ошибка доступа к микрофону с настройками (${audioConstraints.sampleRate}Hz): ${micError.message}`, 'warn');
          // Пробуем с более простыми настройками при ошибке
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          widgetLog('Доступ к микрофону получен с базовыми настройками.');
        }
        
        // Используем существующий или создаем AudioContext.
        if (!window.wellcomeAITempAudioContext) {
             const contextOptions = isIOS ? { sampleRate: 16000 } : {};
             audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
             window.wellcomeAITempAudioContext = audioContext;
             window.wellcomeAIAudioContextInitialized = true;
             widgetLog(`Создан новый AudioContext во время initAudioCapture с частотой ${audioContext.sampleRate} Гц`);
        } else {
             audioContext = window.wellcomeAITempAudioContext;
             widgetLog(`Используем существующий AudioContext с частотой ${audioContext.sampleRate} Гц`);
             if (audioContext.state === 'suspended') {
                 await audioContext.resume();
                 widgetLog('Существующий AudioContext активирован.');
             }
        }
        
        // Используем ScriptProcessorNode для обработки аудио
        if (audioContext.createScriptProcessor) {
          audioProcessor = audioContext.createScriptProcessor(effectiveAudioConfig.bufferSize, 1, 1);
          widgetLog(`Создан ScriptProcessorNode с размером буфера ${effectiveAudioConfig.bufferSize}`);
        } else if (audioContext.createJavaScriptNode) {
          audioProcessor = audioContext.createJavaScriptNode(effectiveAudioConfig.bufferSize, 1, 1);
          widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${effectiveAudioConfig.bufferSize}`);
        } else {
          throw new Error("Ваш браузер не поддерживает обработку аудио ScriptProcessorNode/JavaScriptNode");
        }
        
        // Обработчик аудиоданных с микрофона
        audioProcessor.onaudioprocess = function(e) {
          if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
            const inputBuffer = e.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);

            if (inputData.length === 0) { return; }

            let maxAmplitude = 0;
            for (let i = 0; i < inputData.length; i++) {
              maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
            }

            updateAudioVisualization(inputData); // Обновляем визуализацию

            const hasSound = maxAmplitude > effectiveAudioConfig.soundDetectionThreshold;
            const now = Date.now();

            if (hasSound) {
                if (isSilent) { widgetLog("Обнаружен звук."); }
                isSilent = false;
                silenceStartTime = now;
                if (!mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking')) {
                   setMainCircleState('listening');
                }
            } else {
                if (!isSilent) {
                     isSilent = true;
                     silenceStartTime = now;
                     widgetLog(`Наступила тишина. Время начала: ${silenceStartTime}`);
                } else {
                    const silenceDuration = now - silenceStartTime;
                    if (silenceDuration > effectiveAudioConfig.silenceDuration) {
                        if (hasSentAudioInCurrentSegment) {
                            widgetLog(`Длительная тишина (${silenceDuration} мс). Отправка input_audio_buffer.commit`);
                            commitAudioBuffer();
                        } else {
                             widgetLog("Тишина продолжается, но аудиоданных не было отправлено.");
                             if (!mainCircle.classList.contains('speaking')) {
                                 setMainCircleState('idle'); // Если не говорили, возвращаемся в idle
                             }
                        }
                        hasSentAudioInCurrentSegment = false;
                    }
                }
            }

            // Преобразуем Float32Array в Int16Array
            const pcm16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              const sample = Math.max(-1, Math.min(1, inputData[i]));
              pcm16Data[i] = Math.floor(sample * 32767);
            }
            
            // Отправляем данные через WebSocket
            try {
              if (websocket && websocket.readyState === WebSocket.OPEN) {
                 websocket.send(JSON.stringify({
                   type: "input_audio_buffer.append",
                   event_id: `audio_${Date.now()}`,
                   audio: arrayBufferToBase64(pcm16Data.buffer)
                 }));
                 hasSentAudioInCurrentSegment = true;
              }
            } catch (error) {
              widgetLog(`Ошибка отправки аудио: ${error.message}`, "error");
              websocket.close(1011, 'Error sending audio'); // Инициируем переподключение
            }
          }
        };
        
        // Подключаем источник (микрофон) к обработчику
        const streamSource = audioContext.createMediaStreamSource(mediaStream);
        streamSource.connect(audioProcessor);
        
        // Подключаем обработчик к выходу (кроме iOS, чтобы избежать обратной связи)
        if (!isIOS) {
          audioProcessor.connect(audioContext.destination);
          widgetLog('Аудиопроцессор подключен к audioContext.destination');
        } else {
           const zeroGain = audioContext.createGain();
           zeroGain.gain.value = 0;
           audioProcessor.connect(zeroGain);
           zeroGain.connect(audioContext.destination); // Должен быть подключен куда-то
           widgetLog('Аудиопроцессор подключен к нулевому GainNode для iOS');
        }
        
        widgetLog("Аудио захват инициализирован успешно");
        return true;
      } catch (error) {
        widgetLog(`Ошибка инициализации аудио захвата: ${error.message}`, "error");
        
        // Обработка специфических ошибок доступа к микрофону
        const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
        if (isIOS && error.name === 'NotAllowedError' && iosAudioButton) {
            iosAudioButton.classList.add('visible');
            showMessage("Разрешите доступ к микрофону в настройках Safari для голосовой активации.", 0);
            setMainCircleState('disabled');
        } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            showMessage("Ошибка доступа к микрофону. Разрешите его в настройках браузера.", 0);
            setMainCircleState('disabled');
        } else if (error.name === 'NotFoundError') {
            showMessage("Микрофон не найден. Проверьте подключение.", 0);
            setMainCircleState('disabled');
        } else {
             showMessage(`Ошибка микрофона: ${error.message}`, 0);
             setMainCircleState('disabled');
        }
        
        if (loaderModal) { loaderModal.classList.remove('active'); }
        
        return false;
      }
    }

     // Начало записи голоса
    async function startListening() {
      if (!isConnected || isPlayingAudio || isReconnecting || isListening || connectionFailedPermanently) {
        widgetLog(`Не удается начать прослушивание. Состояние: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, connectionFailedPermanently=${connectionFailedPermanently}`);
        // Показываем соответствующий статус или подсказку
        if (isWidgetOpen && !connectionFailedPermanently) {
            if (isReconnecting) { showMessage("Ожидание подключения...", 3000); setMainCircleState('disabled'); }
            else if (isPlayingAudio) { showMessage("Дождитесь ответа ассистента.", 3000); setMainCircleState('speaking'); }
            else if (!isConnected) { showMessage("Соединение потеряно. Попытка переподключения...", 3000); setMainCircleState('disabled'); }
             else { widgetLog("startListening в непонятном состоянии.", 'warn'); }
        }
        return;
      }
      
      widgetLog('Начинаем прослушивание');
      isListening = true;
      
      const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
      if (iosAudioButton) { iosAudioButton.classList.remove('visible'); }
      hideMessage();

      // Инициализируем захват аудио
      if (!mediaStream || !audioContext || !audioProcessor) {
         const success = await initAudioCapture();
         if (!success) {
            widgetLog("Не удалось инциализировать аудио захват.");
            isListening = false;
            return;
         }
      } else {
         // Возобновляем контекст, если suspended
         if (audioContext.state === 'suspended') {
            try { await audioContext.resume(); window.wellcomeAIAudioContextInitialized = true; widgetLog('AudioContext возобновлен.'); }
            catch (e) { widgetLog(`Ошибка возобновления AudioContext: ${e.message}`, 'error'); showMessage("Ошибка активации аудио.", 5000); isListening = false; setMainCircleState('disabled'); return; }
         }
         // Включаем треки микрофона
         if (mediaStream) {
            mediaStream.getTracks().forEach(track => { if (track.kind === 'audio' && !track.enabled) { track.enabled = true; widgetLog("Аудиотрек микрофона включен."); } });
         }
      }

      // Отправляем команду очистки буфера на сервере
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_${Date.now()}_start` }));
        widgetLog("Отправлена команда очистки буфера на сервере.");
      }
      
      isSilent = true;
      silenceStartTime = Date.now();
      hasSentAudioInCurrentSegment = false;
      
      setMainCircleState('listening'); // Визуальное состояние - слушаем
    }
    
    // Остановка записи голоса
    function stopListening() {
      if (!isListening) { widgetLog("stopListening вызван, но мы уже не слушаем."); return; }
      widgetLog('Останавливаем прослушивание');
      isListening = false;
      
      if (hasSentAudioInCurrentSegment) {
         commitAudioBuffer();
      } else {
          widgetLog("Остановка прослушивания: аудиоданные не были отправлены.");
          if (!isPlayingAudio) { setMainCircleState('idle'); }
      }
      
      // Отключаем треки микрофона (не останавливаем полностью AudioContext)
      if (mediaStream) {
          mediaStream.getTracks().forEach(track => { if (track.kind === 'audio' && track.enabled) { track.enabled = false; widgetLog("Аудиотрек микрофона отключен."); } });
      }

      hasSentAudioInCurrentSegment = false;
      isSilent = true;
      silenceStartTime = Date.now();
    }
    
    // Отправка команды завершения аудио ввода на сервер
    function commitAudioBuffer() {
      if (websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
         websocket.send(JSON.stringify({ type: "input_audio_buffer.commit", event_id: `commit_${Date.now()}` }));
         widgetLog("Отправлена команда input_audio_buffer.commit");
         setMainCircleState('speaking'); // Переключаем на ожидание ответа
         hideMessage();
      } else {
          widgetLog("Не удалось отправить commit: WebSocket не открыт или переподключение.", 'warn');
           if (!connectionFailedPermanently) {
               showMessage("Ошибка связи с сервером. Повторите попытку.", 5000);
               setMainCircleState('idle');
           }
      }
    }

    // Воспроизведение следующего аудио фрагмента из очереди
    async function playNextAudioChunk() {
       if (!isPlayingAudio && audioPlaybackQueue.length > 0 && audioContext && audioContext.state === 'running') {
            isPlayingAudio = true;
            setMainCircleState('speaking');
            
            const audioBuffer = audioPlaybackQueue.shift();
            widgetLog(`Начинаем воспроизведение фрагмента (${audioBuffer.duration.toFixed(2)}с). Осталось: ${audioPlaybackQueue.length}`);

            currentAudioSource = audioContext.createBufferSource();
            currentAudioSource.buffer = audioBuffer;
            currentAudioSource.connect(audioContext.destination);

            currentAudioSource.onended = () => {
                widgetLog("Фрагмент воспроизведен. Проверяем очередь...");
                currentAudioSource = null;
                if (audioPlaybackQueue.length > 0) {
                    playNextAudioChunk();
                } else {
                    isPlayingAudio = false;
                    widgetLog("Воспроизведение завершено.");
                    if (isWidgetOpen && !isListening && !isReconnecting && !connectionFailedPermanently) {
                         setMainCircleState('idle');
                         if (!(isIOS && !window.wellcomeAIAudioContextInitialized)) {
                            showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
                         }
                    } else if (isWidgetOpen && isListening) {
                         setMainCircleState('listening'); // Если продолжали слушать
                    }
                }
            };

            try {
               currentAudioSource.start(0);
               hideMessage();
            } catch (e) {
               widgetLog(`Ошибка при начале воспроизведения: ${e.message}`, 'error');
               isPlayingAudio = false;
               currentAudioSource = null;
               audioPlaybackQueue = [];
               if (isWidgetOpen && !isReconnecting && !connectionFailedPermanently) { setMainCircleState('idle'); showMessage("Ошибка воспроизведения аудио.", 5000); }
               else if (connectionFailedPermanently) { setMainCircleState('disabled'); }
            }

       } else if (audioPlaybackQueue.length > 0 && (!audioContext || audioContext.state !== 'running')) {
           widgetLog("AudioContext недоступен или неактивен для воспроизведения.", 'warn');
           if (isIOS && !window.wellcomeAIAudioContextInitialized) {
               const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
               if (iosAudioButton) { iosAudioButton.classList.add('visible'); }
               showMessage("Нажмите кнопку ниже для активации аудио", 0);
               setMainCircleState('disabled');
           } else {
               widgetLog(`AudioContext state: ${audioContext ? audioContext.state : 'null'}`, 'error');
               showMessage("Ошибка аудиосистемы.", 0);
               setMainCircleState('disabled');
           }
           audioPlaybackQueue = [];
           isPlayingAudio = false;

       } else if (isPlayingAudio && audioPlaybackQueue.length > 0) {
            // Уже играет
       } else {
           // Очередь пуста, или уже не играем
           isPlayingAudio = false;
            if (isWidgetOpen && !isListening && !isReconnecting && !connectionFailedPermanently) {
                 setMainCircleState('idle');
                 if (!(isIOS && !window.wellcomeAIAudioContextInitialized)) {
                    showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
                 }
            } else if (isWidgetOpen && isListening) {
                 setMainCircleState('listening');
            }
       }
    }

    // Остановка воспроизведения аудио
    function stopAudioPlayback() {
       if (currentAudioSource) {
            try { currentAudioSource.stop(); widgetLog("Остановлено текущее воспроизведение аудио."); }
            catch (e) { widgetLog(`Ошибка при остановке AudioBufferSourceNode: ${e.message}`, 'warn'); }
            currentAudioSource.onended = null;
            currentAudioSource = null;
       }
       audioPlaybackQueue = [];
       isPlayingAudio = false;
       widgetLog("Очередь воспроизведения аудио очищена.");
       
       if (isListening) { setMainCircleState('listening'); }
       else if (isWidgetOpen && !isReconnecting && !connectionFailedPermanently) {
           setMainCircleState('idle');
            if (!(isIOS && !window.wellcomeAIAudioContextInitialized)) {
               showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
            }
       } else if (connectionFailedPermanently) { setMainCircleState('disabled'); }
    }

    // Устанавливаем состояние главного круга
    function setMainCircleState(state) {
       const mainCircle = document.getElementById('wellcomeai-main-circle');
       const audioVisualization = document.getElementById('wellcomeai-audio-visualization');
       if (!mainCircle) return;

       mainCircle.classList.remove('idle', 'listening', 'speaking', 'disabled');
       if (state) {
         mainCircle.classList.add(state);
       }
       
       // Визуализация видна только при "listening" или "speaking"
       if (audioVisualization) {
          audioVisualization.style.opacity = (state === 'listening' || state === 'speaking') ? '0.8' : '0';
       }
    }
    
     // Создаем аудио-бары для визуализации
    function createAudioBars(count = 20) {
      const audioBars = document.getElementById('wellcomeai-audio-bars');
      if (!audioBars) return;
      audioBars.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        bar.style.width = `${100 / count - (count > 1 ? 2 : 0)}%`; // Равное распределение
        audioBars.appendChild(bar);
      }
    }
    
     // Обновление визуализации аудио (амплитуда)
    function updateAudioVisualization(audioData) {
      const audioBars = document.getElementById('wellcomeai-audio-bars');
      const mainCircle = document.getElementById('wellcomeai-main-circle');
      if (!audioBars || !audioBars.children.length || (!mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking'))) {
          resetAudioVisualization(); // Сбрасываем если не в нужных состояниях
          return;
      }

      let sumAmplitude = 0;
      for (let i = 0; i < audioData.length; i++) {
        sumAmplitude += Math.abs(audioData[i]);
      }
      const avgAmplitude = sumAmplitude / audioData.length;

      const bars = audioBars.children;
      for (let i = 0; i < bars.length; i++) {
          // Нелинейное масштабирование для чувствительности к тихим звукам
          const baseHeight = 2; // Минимальная высота
          const maxVisualHeight = 100; // Максимальная высота в %
          // Используем power scale для усиления слабых сигналов
          const scaledAmplitude = Math.pow(avgAmplitude, 0.5); // Корень квадратный для усиления слабых
          let heightPercent = baseHeight + scaledAmplitude * (maxVisualHeight - baseHeight) * 2; // Множитель для увеличения диапазона

          // Добавляем небольшую случайность для эффекта
          const dynamicHeight = Math.max(baseHeight, Math.min(maxVisualHeight, Math.floor(heightPercent + Math.sin(i * 0.3 + Date.now() * 0.005) * 10)));

          bars[i].style.height = `${dynamicHeight}%`;

          // Плавный спад высоты при отсутствии новых данных
          // Это реализуется в CSS transition, но можно добавить и тут с таймаутом, если нужно
      }
    }

    // Сброс визуализации аудио
    function resetAudioVisualization() {
        const audioBars = document.getElementById('wellcomeai-audio-bars');
        const audioVisualization = document.getElementById('wellcomeai-audio-visualization');
        if (!audioBars) return;
        const bars = audioBars.children;
         for (let i = 0; i < bars.length; i++) {
            bars[i].style.height = '2px'; // Сброс до минимальной высоты
        }
         if (audioVisualization) {
            audioVisualization.style.opacity = '0'; // Скрываем контейнер
         }
    }

    // =======================================================================
    // --- Управление соединением WebSocket ---
    // =======================================================================

    let websocket = null;
    let connectionTimeout = null;

    // Инициализация и управление WebSocket соединением
    function connectWebSocket() {
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
        widgetLog("WebSocket уже подключен или подключается. Пропускаем.");
        return;
      }
      
      if (!ASSISTANT_ID) {
          widgetLog("Нет Assistant ID, подключение невозможно.", 'error');
           const loaderModal = document.getElementById('wellcomeai-loader-modal');
           if (loaderModal) { loaderModal.classList.remove('active'); }
           showConnectionError('Assistant ID не найден. Виджет не может работать.');
           setMainCircleState('disabled');
          return;
      }

      if (connectionFailedPermanently) {
          widgetLog("Соединение помечено как перманентно разорванное. Не пытаемся подключиться автоматически.");
          setMainCircleState('disabled');
          return;
      }

      isReconnecting = true;
      reconnectAttempts++;
      widgetLog(`Попытка подключения к WebSocket: ${WS_URL}. Попытка #${reconnectAttempts}`);
      
      const loaderModal = document.getElementById('wellcomeai-loader-modal');
      if (reconnectAttempts <= 1 && loaderModal) { // Показываем лоадер только при первой попытке или после сброса
           loaderModal.classList.add('active');
      }
      
      updateConnectionStatus('connecting', `Подключение... Попытка ${reconnectAttempts}`);
      setMainCircleState('disabled'); // Отключаем круг микрофона во время подключения

      try {
        websocket = new WebSocket(WS_URL);
        
        // Таймаут для установления соединения
        connectionTimeout = setTimeout(() => {
           if (websocket && websocket.readyState !== WebSocket.OPEN) {
               widgetLog(`Таймаут подключения WebSocket (${CONNECTION_TIMEOUT} мс). Закрытие...`, 'warn');
               websocket.close(1000, 'Connection timeout');
           }
        }, CONNECTION_TIMEOUT);

        websocket.onopen = function(event) {
          widgetLog("WebSocket соединение установлено.");
          isConnected = true;
          isReconnecting = false;
          reconnectAttempts = 0;
          clearTimeout(connectionTimeout);

          const loaderModal = document.getElementById('wellcomeai-loader-modal');
          if (loaderModal) { loaderModal.classList.remove('active'); }
          hideConnectionError();
          
          updateConnectionStatus('connected', 'Подключено');
          startPing(); // Запуск пингования

          if (isWidgetOpen) {
               widgetLog("Виджет открыт. Подготовка к прослушиванию.");
               setMainCircleState('idle');
                const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
               // Если iOS и аудио еще не готово, показываем кнопку активации
               if (isIOS && !window.wellcomeAIAudioContextInitialized && iosAudioButton) {
                 iosAudioButton.classList.add('visible');
                 showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
               } else if (!isPlayingAudio && !isListening) {
                 showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
               } else if (isListening) {
                  setMainCircleState('listening'); // Продолжаем слушать, если сессия была активна
               } else if (isPlayingAudio) {
                  setMainCircleState('speaking'); // Продолжаем говорить, если сессия была активна
               }
          } else {
             updateConnectionStatus('connected', 'Подключено'); // Кратковременное сообщение
             // Добавляем пульсацию на кнопку, если виджет закрыт
             const widgetButton = document.getElementById('wellcomeai-widget-button');
             if (widgetButton) {
                  widgetButton.classList.add('wellcomeai-pulse-animation');
             }
          }
        };

        websocket.onmessage = async function(event) {
          lastPongTime = Date.now(); // Любое сообщение с сервера сбрасывает таймер неактивности

          try {
            const message = JSON.parse(event.data);

            switch (message.type) {
              case 'response.audio':
                if (message.audio) {
                  try {
                    const audioBuffer = await audioContext.decodeAudioData(base64ToArrayBuffer(message.audio));
                    audioPlaybackQueue.push(audioBuffer);
                    if (!isPlayingAudio) { playNextAudioChunk(); }
                    setMainCircleState('speaking');
                    hideMessage();
                  } catch (e) {
                    widgetLog(`Ошибка декодирования аудио: ${e.message}`, 'error');
                     audioPlaybackQueue = []; stopAudioPlayback();
                     if (isWidgetOpen && !isReconnecting && !connectionFailedPermanently) { setMainCircleState('idle'); showMessage("Ошибка воспроизведения аудио.", 5000); }
                     else if (connectionFailedPermanently) { setMainCircleState('disabled'); }
                  }
                }
                break;
              case 'response.text':
                 if (message.text) {
                    widgetLog(`Получен текст: ${message.text}`);
                    if (!isPlayingAudio) { showMessage(message.text, 5000); }
                 }
                 break;
              case 'response.start':
                 widgetLog("Получена команда response.start");
                 setMainCircleState('speaking');
                 hideMessage();
                 break;
              case 'response.end':
                 widgetLog("Получена команда response.end");
                 // Ожидаем завершения очереди воспроизведения
                 if (audioPlaybackQueue.length === 0 && !isPlayingAudio) {
                    if (isListening) { setMainCircleState('listening'); }
                    else if (isWidgetOpen && !isReconnecting && !connectionFailedPermanently) {
                       setMainCircleState('idle');
                        if (!(isIOS && !window.wellcomeAIAudioContextInitialized)) {
                           showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
                        }
                    } else if (connectionFailedPermanently) { setMainCircleState('disabled'); }
                 }
                 break;
              case 'response.error':
                 widgetLog(`Получена ошибка от сервера: ${message.error || 'Неизвестная ошибка'}`, 'error');
                 stopAllAudioProcessing();
                 if (isWidgetOpen) { showMessage(`Ошибка: ${message.error || 'Произошла ошибка на сервере'}`, 10000); setMainCircleState('idle'); }
                 break;
              case 'pong':
                 widgetLog("Получен PONG");
                 lastPongTime = Date.now();
                 break;
               case 'system.idle':
                 widgetLog("Сервер перешел в состояние idle.");
                 if (isWidgetOpen && !isListening && !isPlayingAudio && !isReconnecting && !connectionFailedPermanently) {
                    setMainCircleState('idle');
                     if (!(isIOS && !window.wellcomeAIAudioContextInitialized)) {
                        showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
                     }
                 }
                 break;
              default:
                widgetLog(`Получено неизвестное сообщение типа: ${message.type}`, 'warn');
            }
          } catch (e) {
            widgetLog(`Ошибка парсинга или обработки WebSocket сообщения: ${e.message}`, 'error');
          }
        };

        websocket.onerror = function(event) {
          widgetLog(`WebSocket Ошибка: ${event.message || 'Неизвестная ошибка'}`, 'error');
        };

        websocket.onclose = function(event) {
          isConnected = false;
          clearTimeout(connectionTimeout);
          stopPing();
          stopAllAudioProcessing();

          let reason = `Код: ${event.code}, Причина: ${event.reason || 'Неизвестно'}`;
          widgetLog(`WebSocket соединение закрыто. ${reason}`);

          const loaderModal = document.getElementById('wellcomeai-loader-modal');
          if (loaderModal) { loaderModal.classList.remove('active'); }
           const widgetButton = document.getElementById('wellcomeai-widget-button');
           if (widgetButton) { widgetButton.classList.remove('wellcomeai-pulse-animation'); }
          
          const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
          
          if (reconnectAttempts < maxAttempts && !connectionFailedPermanently) {
            isReconnecting = true;
            const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1) + Math.random() * 1000;
            widgetLog(`Попытка переподключения через ${delay} мс. Попытка #${reconnectAttempts} из ${maxAttempts}`);
            updateConnectionStatus('connecting', `Переподключение... Попытка ${reconnectAttempts}`);
            setMainCircleState('disabled');

            setTimeout(() => {
              if (!isConnected) {
                 connectWebSocket();
              }
            }, delay);

          } else {
            widgetLog(`Достигнут лимит попыток переподключения (${maxAttempts}).`, 'error');
            isReconnecting = false;
            reconnectAttempts = 0; // Сброс для кнопки "Повторить"
            showConnectionError('Не удалось подключиться к серверу.');
            updateConnectionStatus('disconnected', 'Отключено');
            setMainCircleState('disabled');
          }
        };

      } catch (e) {
         widgetLog(`Критическая ошибка при создании WebSocket: ${e.message}`, 'error');
          clearTimeout(connectionTimeout);
          isReconnecting = false;
          reconnectAttempts = 0;
          const loaderModal = document.getElementById('wellcomeai-loader-modal');
           if (loaderModal) { loaderModal.classList.remove('active'); }
          showConnectionError('Не удалось инициализировать WebSocket.');
          updateConnectionStatus('disconnected', 'Ошибка инициализации');
          setMainCircleState('disabled');
      }
    }
    
    // Запуск пингования сервера
    function startPing() {
      if (pingIntervalId) { stopPing(); }
      const interval = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
      widgetLog(`Запуск PING интервала (${interval} мс)`);
      pingIntervalId = setInterval(() => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          const now = Date.now();
          // Если pong не получен в течение 2.5 интервалов, считаем соединение неактивным
          if (now - lastPongTime > interval * 2.5) {
             widgetLog("Не получен PONG в течение долгого времени. Разрыв соединения.", 'warn');
             websocket.close(1001, 'No Pong Received');
          } else {
             try {
               websocket.send(JSON.stringify({ type: "ping", timestamp: now }));
               widgetLog("Отправлен PING");
             } catch (e) {
               widgetLog(`Ошибка отправки PING: ${e.message}`, 'warn');
               websocket.close(1011, 'Ping Send Error');
             }
          }
        }
      }, interval);
    }

    // Остановка пингования сервера
    function stopPing() {
      if (pingIntervalId) {
        widgetLog("Остановка PING интервала");
        clearInterval(pingIntervalId);
        pingIntervalId = null;
      }
    }

    // =======================================================================
    // --- Основная логика виджета ---
    // =======================================================================

    let audioChunksBuffer = []; // Буфер для необработанных аудио данных (если понадобится буферизация перед отправкой)
    let audioPlaybackQueue = []; // Очередь для фрагментов аудио ответа
    let isPlayingAudio = false;
    let currentAudioSource = null; // Текущий воспроизводимый узел
    let audioContext = null; // Контекст для микрофона И воспроизведения
    let mediaStream = null; // Поток с микрофона
    let audioProcessor = null; // Обработчик аудио с микрофона
    let isConnected = false; // Статус WebSocket соединения
    let isWidgetOpen = false; // Статус открытости виджета
    let connectionFailedPermanently = false; // Флаг необратимой ошибки соединения
    let isListening = false; // Статус записи с микрофона

    // Показать сообщение
    function showMessage(message, duration = 5000) {
      const messageDisplay = document.getElementById('wellcomeai-message-display');
      if (!messageDisplay) return;
      // Не показываем обычные сообщения, если есть перманентная ошибка соединения
      if (connectionFailedPermanently && message !== "Не удалось подключиться к серверу. Нажмите кнопку \"Повторить подключение\".") {
          return;
      }
      messageDisplay.textContent = message;
      messageDisplay.classList.add('show');
      
      if (messageDisplay.hideTimeout) {
        clearTimeout(messageDisplay.hideTimeout);
      }

      if (duration > 0) {
        messageDisplay.hideTimeout = setTimeout(() => {
          hideMessage();
        }, duration);
      } else {
         // Оставляем сообщение видимым до явного вызова hideMessage
      }
    }

    // Скрыть сообщение
    function hideMessage() {
      const messageDisplay = document.getElementById('wellcomeai-message-display');
      if (!messageDisplay) return;
      messageDisplay.classList.remove('show');
       if (messageDisplay.hideTimeout) {
          clearTimeout(messageDisplay.hideTimeout);
          messageDisplay.hideTimeout = null;
        }
    }
    
    // Показать ошибку соединения
    function showConnectionError(message) {
      const connectionError = document.getElementById('wellcomeai-connection-error');
      if (connectionError) {
        connectionError.innerHTML = `
          ${message || 'Ошибка соединения с сервером'}
          <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
            Повторить подключение
          </button>
        `;
        connectionError.classList.add('visible');
        connectionFailedPermanently = true;
        
        const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', function() {
            widgetLog("Нажата кнопка повторного подключения.");
            resetConnection();
          });
        }
      }
    }
    
    // Скрыть ошибку соединения
    function hideConnectionError() {
      const connectionError = document.getElementById('wellcomeai-connection-error');
      if (connectionError) {
        connectionError.classList.remove('visible');
        connectionFailedPermanently = false;
      }
    }
    
    // Сброс состояния соединения
    function resetConnection() {
      widgetLog("Сброс состояния соединения и попытка подключения...");
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
         try { websocket.close(1000, 'Manual reset'); } catch (e) { widgetLog(`Ошибка при закрытии WS перед сбросом: ${e.message}`, 'warn'); }
      }
      
      stopAllAudioProcessing();

      reconnectAttempts = 0;
      isReconnecting = false;
      connectionFailedPermanently = false;
      
      hideConnectionError();
      
      const loaderModal = document.getElementById('wellcomeai-loader-modal');
      if (loaderModal) { loaderModal.classList.add('active'); }
      
      showMessage("Попытка подключения...");
      updateConnectionStatus('connecting', 'Подключение...');
      
      connectWebSocket();
    }
    
    // Открыть виджет
    function openWidget() {
      if (isWidgetOpen) { widgetLog("Widget already open."); return; }
      widgetLog("Opening widget");
      
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');

      if (!widgetContainer || !widgetButton || !expandedWidget || !iosAudioButton) {
          widgetLog("UI elements not found for openWidget.", 'error');
          return;
      }

      widgetContainer.style.zIndex = "2147483647";
      widgetButton.style.zIndex = "2147483647";
      
      widgetContainer.classList.add('active');
      isWidgetOpen = true;
      
      expandedWidget.style.opacity = "1";
      expandedWidget.style.height = "400px";
      expandedWidget.style.pointerEvents = "all";
      expandedWidget.style.zIndex = "2147483647";
      // Предотвращаем прокрутку фона на iOS
      expandedWidget.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });

      // Инициализируем AudioContext на пользовательский жест (если еще не)
      // Эта функция также попытается начать прослушивание, если условия подходят
      initAudioContextOnUserGesture();
      
      // Показываем сообщение об ошибке соединения, если оно есть
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        setMainCircleState('disabled');
        return;
      }
       
      // Если соединение активно
      if (isConnected && !isReconnecting) {
           // Если не слушаем и не говорим, устанавливаем idle
           if (!isListening && !isPlayingAudio) {
                setMainCircleState('idle');
                 // Если iOS и аудио не готово, показываем кнопку активации
                if (isIOS && !window.wellcomeAIAudioContextInitialized) {
                     iosAudioButton.classList.add('visible');
                     showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
                } else {
                     showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
                }
           } else if (isListening) {
                setMainCircleState('listening'); // Если слушали до закрытия
           } else if (isPlayingAudio) {
                 setMainCircleState('speaking'); // Если говорили до закрытия
           }

      } else if (!isConnected && !isReconnecting) {
        // Если соединение не активно, пытаемся подключиться
        widgetLog('Widget opened, but not connected. Attempting connection.');
        connectWebSocket(); // connectWebSocket покажет лоадер и статус
        setMainCircleState('disabled'); // Отключаем круг микрофона до подключения
      } else if (isReconnecting) {
         // Если в процессе переподключения
         widgetLog('Widget opened while reconnecting.');
         setMainCircleState('disabled');
         updateConnectionStatus('connecting', `Переподключение... Попытка ${reconnectAttempts}`);
      }
      
      // Убираем пульсацию с кнопки
      widgetButton.classList.remove('wellcomeai-pulse-animation');
    }
    
    // Закрыть виджет
    function closeWidget() {
      if (!isWidgetOpen) { widgetLog("Widget already closed."); return; }
      widgetLog("Closing widget");
      
      stopAllAudioProcessing();
      
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      const statusIndicator = document.getElementById('wellcomeai-status-indicator');
      const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');

      if (!widgetContainer || !expandedWidget || !statusIndicator || !iosAudioButton) {
         widgetLog("UI elements not found for closeWidget.", 'error');
         return;
      }

      widgetContainer.classList.remove('active');
      isWidgetOpen = false;
      
      if (!connectionFailedPermanently) { hideMessage(); }

       if (!connectionFailedPermanately) { statusIndicator.classList.remove('show'); }
      
      iosAudioButton.classList.remove('visible');
      
      expandedWidget.style.opacity = "0";
      expandedWidget.style.height = "0";
      expandedWidget.style.pointerEvents = "none";
      // Удаляем обработчик прокрутки фона
      expandedWidget.removeEventListener('touchmove', (e) => e.stopPropagation());

      // Добавляем пульсацию на кнопку, если соединение активно
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      if (widgetButton && isConnected && !connectionFailedPermanently) {
           widgetButton.classList.add('wellcomeai-pulse-animation');
      }
    }

    // Полная остановка всех аудио процессов (захват и воспроизведение)
    function stopAllAudioProcessing() {
      widgetLog("Остановка всех аудио процессов");
      
      stopListening(); // Останавливаем прослушивание
      stopAudioPlayback(); // Останавливаем воспроизведение
      
      audioChunksBuffer = [];
      audioPlaybackQueue = [];
      
      hasSentAudioInCurrentSegment = false;
      isSilent = true;
      silenceStartTime = Date.now();
      
      // Отправляем команды на сервер для очистки и отмены
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        widgetLog("Отправка команд очистки буфера ввода и отмены ответа на сервер.");
        websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_${Date.now()}` }));
        websocket.send(JSON.stringify({ type: "response.cancel", event_id: `cancel_${Date.now()}` }));
      }
      
      // UI в состояние idle, если нет других проблем
       if (!isReconnecting && !connectionFailedPermanently && isWidgetOpen) {
            setMainCircleState('idle');
       } else if (!isWidgetOpen) {
            setMainCircleState(''); // Сбрасываем классы, если виджет закрыт
       } else {
            setMainCircleState('disabled'); // Отключаем, если есть проблемы
       }

      resetAudioVisualization();
    }

    // Обработчик клика по главному кругу (микрофону)
    function mainCircleClickHandler() {
        if (!isWidgetOpen) {
             widgetLog("Клик по микрофону, но виджет закрыт.");
             return;
        }
        
        widgetLog("Клик по главному кругу (микрофон)");

        initAudioContextOnUserGesture();

        if (!isConnected || isReconnecting || connectionFailedPermanently) {
            widgetLog("Не удается обработать клик по микрофону: нет соединения, переподключение или ошибка.");
            if (connectionFailedPermanently) { showConnectionError('Не удалось подключиться к серверу.'); }
            else if (!isConnected) { showMessage("Соединение потеряно. Попытка переподключения...", 3000); updateConnectionStatus('connecting', 'Переподключение...'); }
            else if (isReconnecting) { showMessage("Ожидание подключения...", 3000); }
            setMainCircleState('disabled');
            return;
        }
        
        // Если AudioContext еще не готов на iOS, показываем кнопку активации
        if (isIOS && !window.wellcomeAIAudioContextInitialized) {
            widgetLog("Клик по микрофону: AudioContext еще не готов на iOS.");
             const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
            if (iosAudioButton) { iosAudioButton.classList.add('visible'); }
            showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
            setMainCircleState('disabled');
            return;
        }
        
        if (isListening) {
            stopListening();
            if (!isPlayingAudio) {
                setMainCircleState('idle');
                 if (!(isIOS && !window.wellcomeAIAudioContextInitialized)) { // Не показываем подсказку, если кнопка активации iOS видна
                     showMessage("Нажмите на микрофон, чтобы начать разговор", 5000);
                 }
            }
        } else if (!isPlayingAudio) {
            startListening();
        } else {
             widgetLog("Клик по микрофону во время воспроизведения.");
            showMessage("Дождитесь ответа ассистента.", 3000);
        }
    }

    // Обработчик клика по специальной кнопке активации на iOS
    function iosAudioButtonClickHandler() {
       widgetLog("Клик по кнопке активации аудио на iOS");
       initAudioContextOnUserGesture();
       hideMessage(); // Скрываем любое текущее сообщение (например, "Нажмите кнопку...")
    }

    // Функция для инициализации элементов UI и привязки событий после загрузки DOM
    function initWidgetElementsAndConnect() {
        // Получаем ссылки на элементы UI
        const widgetContainer = document.getElementById('wellcomeai-widget-container');
        const widgetButton = document.getElementById('wellcomeai-widget-button');
        const widgetClose = document.getElementById('wellcomeai-widget-close');
        const mainCircle = document.getElementById('wellcomeai-main-circle');
        const audioBars = document.getElementById('wellcomeai-audio-bars');
        const loaderModal = document.getElementById('wellcomeai-loader-modal');
        const messageDisplay = document.getElementById('wellcomeai-message-display');
        const connectionError = document.getElementById('wellcomeai-connection-error');
        const statusIndicator = document.getElementById('wellcomeai-status-indicator');
        const statusDot = document.getElementById('wellcomeai-status-dot');
        const statusText = document.getElementById('wellcomeai-status-text');
        const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');

         // Проверка наличия всех элементов перед привязкой событий и подключением
         if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !connectionError || !statusIndicator || !statusDot || !statusText || !iosAudioButton) {
            widgetLog("Критические элементы UI не найдены после создания DOM. Виджет не может функционировать.", 'error');
             if (loaderModal) { loaderModal.classList.remove('active'); }
            return; // Прекращаем инициализацию
         }

         // Привязка обработчиков событий
         widgetButton.addEventListener('click', () => {
           if (isWidgetOpen) { closeWidget(); } else { openWidget(); }
         });
         widgetClose.addEventListener('click', closeWidget);
         mainCircle.addEventListener('click', mainCircleClickHandler);
         iosAudioButton.addEventListener('click', iosAudioButtonClickHandler);

         // Дополнительные инициализации
         createAudioBars(); // Убедимся, что бары созданы
         hideConnectionError(); // Убедимся, что ошибка скрыта по умолчанию

         // Начинаем процесс подключения к WebSocket
         connectWebSocket();
    }

    // =======================================================================
    // --- Точка входа: Ожидание загрузки DOM и запуск инициализации ---
    // =======================================================================
    
    // Проверяем, что Assistant ID доступен до попытки загрузки стилей и HTML
     if (!ASSISTANT_ID) {
         widgetLog("Assistant ID отсутствует. Виджет не будет инициализирован.", 'error');
         // Можно показать какое-то сообщение пользователю, если требуется
         alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
         return; // Прерываем выполнение скрипта, если ID нет
     }


    // Ждем полной загрузки DOM перед созданием UI элементов
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            widgetLog("DOMContentLoaded event fired. Creating widget UI.");
            loadFontAwesome();
            createStyles();
            createWidgetHTML();
            initWidgetElementsAndConnect(); // Инициализация после создания DOM
        });
    } else {
        widgetLog("DOM already loaded. Creating widget UI immediately.");
        loadFontAwesome();
        createStyles();
        createWidgetHTML();
        initWidgetElementsAndConnect(); // Инициализация сразу
    }

})(); // Конец самовыполняющейся функции
