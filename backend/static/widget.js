/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.2.2 (с улучшенной мобильной поддержкой)
 * 
 * Этот скрипт динамически создает и встраивает виджет голосового ассистента
 * на любой сайт, в том числе на Tilda и другие конструкторы сайтов.
 * Улучшена поддержка мобильных устройств и iOS.
 */

(function() {
  // Настройки виджета
  const DEBUG_MODE = true; // Включаем режим отладки чтобы видеть ошибки
  const MAX_RECONNECT_ATTEMPTS = 5; // Максимальное количество попыток переподключения
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10; // Увеличенное количество попыток для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 20000; // Таймаут для установления соединения (в миллисекундах)
  const MAX_DEBUG_ITEMS = 10; // Максимальное количество записей отладки

  // Глобальное хранение состояния
  let reconnectAttempts = 0;
  let pingIntervalId = null; // MOB-INTEGRATION: Renamed from pingInterval to avoid conflict with PING_INTERVAL const
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  
  // MOB-INTEGRATION: Определяем тип устройства (уже было, просто подтверждаем)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  
  // MOB-INTEGRATION: Глобальные флаги для мобильных устройств (уже были, подтверждаем)
  window.audioContextInitialized = false; // Флаг, что AudioContext был успешно инициализирован хотя бы раз
  window.tempAudioContext = null; // Хранение временного/глобального AudioContext для iOS
  window.hasPlayedSilence = false; // Флаг, что "тишина" была воспроизведена для разблокировки

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
      if (src && (src.includes('widget.js') || src.includes('wellcomeai-widget.min.js'))) {
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
        cursor: pointer; /* MOB-INTEGRATION: Ensure cursor pointer */
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
      
      /* MOB-INTEGRATION: Стили для кнопки активации аудио iOS (уже были, подтверждаем) */
      .wellcomeai-ios-audio-button {
        position: absolute;
        bottom: 60px; /* MOB-INTEGRATION: Adjusted position slightly if needed */
        left: 50%;
        transform: translateX(-50%);
        background-color: #4a86e8;
        color: white;
        border: none;
        border-radius: 15px; /* MOB-INTEGRATION: Rounded corners */
        padding: 8px 15px; /* MOB-INTEGRATION: Slightly larger padding */
        font-size: 13px; /* MOB-INTEGRATION: Slightly larger font */
        font-weight: 500;
        cursor: pointer;
        display: none; /* Скрыта по умолчанию */
        z-index: 100;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2); /* MOB-INTEGRATION: Added shadow */
      }
      
      .wellcomeai-ios-audio-button.visible {
        display: block;
      }

      /* MOB-INTEGRATION: Media queries for better mobile experience */
      @media (max-width: 768px) {
        .wellcomeai-widget-expanded {
          width: calc(100vw - 40px); /* Full width minus padding */
          max-width: 350px; /* Max width on mobile */
          height: 0; /* Start hidden */
        }
        .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
           height: 60vh; /* Adjust height for mobile */
           max-height: 450px;
        }
        .wellcomeai-main-circle {
          width: 150px;
          height: 150px;
        }
      }
      @media (max-height: 500px) and (orientation: landscape) {
         .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
           height: calc(100vh - 40px); /* Full height in landscape */
         }
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

    // MOB-INTEGRATION: HTML для iOS кнопки уже есть в коде ниже.
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
          
          <!-- MOB-INTEGRATION: Специальная кнопка для активации аудио на iOS (уже была) -->
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
    
    // Важно: явно делаем кнопку виджета видимой
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    if (widgetButton) {
      widgetButton.style.opacity = '1';
      widgetButton.style.visibility = 'visible';
      widgetButton.style.pointerEvents = 'auto';
    }
  }

  // MOB-INTEGRATION: Функция для разблокировки аудио на iOS (была, улучшена)
  // Эта функция пытается создать и воспроизвести тихий звук + возобновить AudioContext.
  async function unlockAudioOnIOS() {
    if (!isIOS) return Promise.resolve(true);
    if (window.audioContextInitialized && window.hasPlayedSilence && window.tempAudioContext && window.tempAudioContext.state === 'running') {
        widgetLog('Аудио на iOS уже разблокировано и AudioContext активен.');
        return Promise.resolve(true);
    }
    
    widgetLog('Попытка разблокировки аудио на iOS...');
    
    return new Promise((resolve) => {
      // 1. Создаем или получаем AudioContext
      if (!window.tempAudioContext) {
        try {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            widgetLog('Новый AudioContext создан для iOS.');
        } catch (e) {
            widgetLog(`Не удалось создать AudioContext на iOS: ${e.message}`, 'error');
            resolve(false);
            return;
        }
      }

      const audioCtx = window.tempAudioContext;

      // 2. Пытаемся воспроизвести тишину через <audio> элемент (первый этап)
      if (!window.hasPlayedSilence) {
        const tempAudio = document.createElement('audio');
        tempAudio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
        tempAudio.volume = 0.00001; // Очень тихо
        tempAudio.preload = 'auto';

        const playPromise = tempAudio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            widgetLog('Тишина через <audio> успешно воспроизведена на iOS.');
            window.hasPlayedSilence = true;
            // После успешного play(), пробуем resume AudioContext
            if (audioCtx.state === 'suspended') {
              audioCtx.resume().then(() => {
                widgetLog('AudioContext успешно возобновлен после <audio> play.');
                window.audioContextInitialized = true;
                resolve(true);
              }).catch(err => {
                widgetLog(`Не удалось возобновить AudioContext после <audio> play: ${err.message}`, 'warn');
                resolve(false); // Может потребоваться forceIOSAudioUnlock
              });
            } else {
              widgetLog('AudioContext уже был активен после <audio> play.');
              window.audioContextInitialized = true;
              resolve(true);
            }
          }).catch(err => {
            widgetLog(`Ошибка воспроизведения тишины через <audio>: ${err.message}`, 'warn');
            // Если <audio> не сработало, пробуем resume AudioContext напрямую
            if (audioCtx.state === 'suspended') {
              audioCtx.resume().then(() => {
                widgetLog('AudioContext успешно возобновлен (несмотря на ошибку <audio> play).');
                window.audioContextInitialized = true;
                resolve(true); // Может сработать и без play, если пользователь уже взаимодействовал
              }).catch(resumeErr => {
                widgetLog(`Не удалось возобновить AudioContext (после ошибки <audio> play): ${resumeErr.message}`, 'error');
                resolve(false);
              });
            } else {
                resolve(false); // Не удалось ни <audio> play, ни resume
            }
          });
        } else {
            widgetLog('<audio>.play() не вернул Promise, старый браузер?');
            // Fallback для старых браузеров, если playPromise undefined
             if (audioCtx.state === 'suspended') {
                audioCtx.resume().then(() => {
                  widgetLog('AudioContext успешно возобновлен (старый браузер).');
                  window.audioContextInitialized = true;
                  resolve(true);
                }).catch(err => {
                  widgetLog(`Не удалось возобновить AudioContext (старый браузер): ${err.message}`, 'error');
                  resolve(false);
                });
            } else {
                window.audioContextInitialized = true; // Уже был активен
                resolve(true);
            }
        }
      } else {
         // Если hasPlayedSilence уже true, просто проверяем AudioContext
         if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                widgetLog('AudioContext успешно возобновлен (hasPlayedSilence=true).');
                window.audioContextInitialized = true;
                resolve(true);
            }).catch(err => {
                widgetLog(`Не удалось возобновить AudioContext (hasPlayedSilence=true): ${err.message}`, 'error');
                resolve(false);
            });
         } else {
            widgetLog('AudioContext уже активен (hasPlayedSilence=true).');
            window.audioContextInitialized = true;
            resolve(true);
         }
      }
    });
  }
  
  // MOB-INTEGRATION: Функция для форсированной разблокировки аудио на iOS (была, улучшена)
  // Эта функция создает осциллятор и пытается воспроизвести короткие тоны.
  function forceIOSAudioUnlock() {
    if (!isIOS) return Promise.resolve(true);
    if (window.audioContextInitialized && window.tempAudioContext && window.tempAudioContext.state === 'running') {
        widgetLog('Аудио на iOS уже активно (forceIOSAudioUnlock).');
        return Promise.resolve(true);
    }

    widgetLog('Попытка форсированной разблокировки аудио на iOS (осциллятор)...');

    return new Promise((resolve) => {
      if (!window.tempAudioContext) {
        try {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            widgetLog('Новый AudioContext создан для forceIOSAudioUnlock.');
        } catch (e) {
            widgetLog(`Не удалось создать AudioContext для forceIOSAudioUnlock: ${e.message}`, 'error');
            resolve(false);
            return;
        }
      }
      const audioCtx = window.tempAudioContext;

      const unlock = () => {
        try {
          const oscillator = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();
          
          gainNode.gain.setValueAtTime(0.00001, audioCtx.currentTime); // Очень тихо
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(20, audioCtx.currentTime); // Низкая частота
          
          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          
          oscillator.start(audioCtx.currentTime);
          oscillator.stop(audioCtx.currentTime + 0.01); // Очень короткий звук
          
          oscillator.onended = () => {
             // Это событие может не сработать если контекст был suspended, поэтому resume важен
          };
          widgetLog('Форсированная разблокировка (осциллятор) выполнена.');
          window.hasPlayedSilence = true; // Считаем, что попытка была
          window.audioContextInitialized = true;
          resolve(true);

        } catch (e) {
          widgetLog(`Ошибка при форсированной разблокировке (осциллятор): ${e.message}`, 'error');
          resolve(false);
        }
      };

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
          widgetLog('AudioContext возобновлен перед осциллятором.');
          unlock();
        }).catch(err => {
          widgetLog(`Не удалось возобновить AudioContext перед осциллятором: ${err.message}`, 'error');
          resolve(false);
        });
      } else {
        unlock();
      }
    });
  }

  // MOB-INTEGRATION: Воспроизведение тишины (резервная функция для iOS, была)
  // Эта функция используется как часть `unlockAudioOnIOS` и `forceIOSAudioUnlock` через глобальные флаги.
  // Отдельно вызывать обычно не требуется.
  function playSilence() { // Эта функция была, но её логика теперь встроена в unlockAudioOnIOS и forceIOSAudioUnlock
    widgetLog("playSilence() вызвана, но основная логика в unlockAudioOnIOS/forceIOSAudioUnlock.");
    // Для обратной совместимости, если где-то вызывается, можно просто вернуть Promise
    return unlockAudioOnIOS(); 
  }

  // Основная логика виджета
  function initWidget() {
    // Проверяем, что ID ассистента существует
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag.", 'error');
      // alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.'); // Закомментировано, чтобы не раздражать
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
    
    // Важно: сделать виджет видимым
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
    let audioContext = null; // Локальный audioContext для виджета
    let mediaStream = null;
    let audioProcessor = null;
    let isConnected = false;
    let isWidgetOpen = false;
    let connectionFailedPermanently = false;
    // let pingInterval = null; // MOB-INTEGRATION: переименован в pingIntervalId
    let lastPingTime = Date.now();
    // let lastPongTime = Date.now(); // Уже есть глобальный
    let connectionTimeoutTimer = null; // MOB-INTEGRATION: переименован из connectionTimeout
    
    // Конфигурация для оптимизации потока аудио - разные настройки для десктопа и мобильных
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,      // Порог для определения тишины
      silenceDuration: 300,        // Длительность тишины для отправки (мс)
      bufferCheckInterval: 50,     // Частота проверки буфера (мс)
      soundDetectionThreshold: 0.02 // Чувствительность к звуку
    };
    
    // MOB-INTEGRATION: Специальные настройки для мобильных устройств (уже были)
    const MOBILE_AUDIO_CONFIG = {
      silenceThreshold: 0.015,      // Более низкий порог для мобильных
      silenceDuration: 500,         // Увеличенная длительность тишины 
      bufferCheckInterval: 100,     // Увеличенный интервал проверки
      soundDetectionThreshold: 0.015 // Более чувствительное определение звука
    };
    
    // Выбираем нужную конфигурацию в зависимости от устройства
    const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;
    
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
      if (audioContext && typeof audioContext.close === 'function' && audioContext.state !== 'closed') {
          // For Web Audio API playback, if a source node is playing, it should be stopped.
          // This is tricky as we don't have a direct reference here.
          // For <audio> elements, removing src or pausing is handled elsewhere.
      }
      
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
    async function openWidget() { // MOB-INTEGRATION: made async
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
        expandedWidget.style.height = "auto"; // Was 400px, let CSS handle from media queries
        expandedWidget.style.pointerEvents = "all";
        expandedWidget.style.zIndex = "2147483647"; // Was 2147483646
      }
      
      // MOB-INTEGRATION: Улучшенная логика активации аудио для iOS
      if (isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence || (window.tempAudioContext && window.tempAudioContext.state !== 'running') ) {
            widgetLog("iOS: Аудио не инициализировано или контекст не активен. Показываем кнопку.");
            if (iosAudioButton) iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации аудио", 0);

            // Попытка разблокировки в фоне, если пользователь уже нажимал кнопку
            if (window.hasPlayedSilence) { // если тишина уже играла, но контекст мог уснуть
                 await unlockAudioOnIOS(); // эта функция теперь сама проверит состояние и попытается resume
            }
        } else {
            widgetLog("iOS: Аудио уже инициализировано и контекст активен.");
            if (iosAudioButton) iosAudioButton.classList.remove('visible');
        }
      } else if (isMobile && !window.audioContextInitialized) {
        // Для Android и других мобильных, попытка инициализации AudioContext при взаимодействии
        try {
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          if (window.tempAudioContext.state === 'suspended') {
            await window.tempAudioContext.resume();
          }
          window.audioContextInitialized = true;
          widgetLog("Mobile (non-iOS) audio context initialized/resumed");
        } catch (e) {
          widgetLog(`Failed to initialize/resume audio context on mobile (non-iOS): ${e.message}`, "error");
        }
      }
      
      // Показываем сообщение о проблеме с подключением, если оно есть
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        return;
      }
      
      // Запускаем прослушивание при открытии, если соединение активно
      if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
        // MOB-INTEGRATION: Уточнена проверка для iOS
        if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence || (window.tempAudioContext && window.tempAudioContext.state !== 'running'))) {
          showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
           if (iosAudioButton) iosAudioButton.classList.add('visible');
        } else {
          if (iosAudioButton) iosAudioButton.classList.remove('visible');
          startListening(); // startListening теперь async
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
      if (statusIndicator) statusIndicator.classList.remove('show');
      if (iosAudioButton) iosAudioButton.classList.remove('visible');
      
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "0";
        expandedWidget.style.height = "0";
        expandedWidget.style.pointerEvents = "none";
      }
    }
    
    // MOB-INTEGRATION: Инициализация микрофона и AudioContext (существенно переработано)
    async function initAudio() {
      widgetLog("Запрос разрешения на доступ к микрофону...");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showMessage("Ваш браузер не поддерживает доступ к микрофону.");
        widgetLog("getUserMedia не поддерживается", "error");
        return false;
      }

      // 1. Получение/создание AudioContext
      // Используем глобальный window.tempAudioContext для iOS, чтобы он был доступен для playback
      // Для других устройств можно создавать локальный audioContext или также использовать window.tempAudioContext
      if (!window.tempAudioContext) {
          try {
              const contextOptions = isMobile && !isIOS ? {} : { sampleRate: (isIOS ? 16000 : 24000) };
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
              widgetLog(`Создан новый AudioContext (sampleRate: ${window.tempAudioContext.sampleRate}Hz)`);
          } catch (e) {
              widgetLog(`Ошибка создания AudioContext: ${e.message}`, "error");
              showMessage("Ошибка инициализации аудиосистемы.");
              return false;
          }
      }
      audioContext = window.tempAudioContext; // Используем глобальный контекст

      // 2. Проверка и возобновление AudioContext
      if (audioContext.state === 'suspended') {
          widgetLog('AudioContext приостановлен, попытка возобновления...');
          try {
              await audioContext.resume();
              widgetLog('AudioContext успешно возобновлен.');
              window.audioContextInitialized = true;
          } catch (err) {
              widgetLog(`Не удалось возобновить AudioContext: ${err.message}`, 'error');
              if (isIOS && iosAudioButton) iosAudioButton.classList.add('visible');
              showMessage(isIOS ? "Нажмите кнопку активации аудио" : "Не удалось активировать аудио");
              return false;
          }
      } else {
          widgetLog('AudioContext уже активен.');
          window.audioContextInitialized = true;
      }
      
      // 3. Запрос доступа к микрофону
      try {
        const audioConstraints = { 
            echoCancellation: !isIOS, // На iOS лучше отключить или оставить true если нет эха
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: isIOS ? { ideal: 16000 } : { ideal: 24000 } // Запрашиваем нужную частоту
        };
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        widgetLog(`Доступ к микрофону получен (constraints: ${JSON.stringify(audioConstraints)})`);
      } catch (micError) {
        widgetLog(`Ошибка доступа к микрофону: ${micError.message} (name: ${micError.name})`, 'error');
        if (micError.name === 'NotAllowedError' || micError.name === 'PermissionDeniedError') {
            showMessage("Доступ к микрофону запрещен. Проверьте настройки.");
        } else if (micError.name === 'NotFoundError' || micError.name === 'DevicesNotFoundError'){
            showMessage("Микрофон не найден.");
        } else {
            showMessage("Ошибка доступа к микрофону.");
        }
        if (isIOS && iosAudioButton) iosAudioButton.classList.add('visible');
        return false;
      }

      // 4. Создание ScriptProcessorNode
      const bufferSize = isIOS ? 4096 : (isMobile ? 2048 : 2048); // Увеличен буфер для iOS
      try {
          if (audioContext.createScriptProcessor) {
            audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
          } else if (audioContext.createJavaScriptNode) { // Для старых Safari
            audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
          } else {
            throw new Error("ScriptProcessorNode/createJavaScriptNode не поддерживается");
          }
          widgetLog(`Создан ScriptProcessorNode (bufferSize: ${bufferSize})`);
      } catch (e) {
          widgetLog(`Ошибка создания ScriptProcessor: ${e.message}`, "error");
          showMessage("Ошибка обработки аудио.");
          return false;
      }

      // 5. Настройка onaudioprocess
      audioProcessor.onaudioprocess = function(e) {
        if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) return;
        
        const inputBuffer = e.inputBuffer;
        let inputData = inputBuffer.getChannelData(0);
        if (inputData.length === 0) return;

        let maxAmplitude = 0;
        for (let i = 0; i < inputData.length; i++) {
            maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
        }

        // MOB-INTEGRATION: Нормализация и усиление для iOS (опционально)
        if (isIOS && maxAmplitude > 0 && maxAmplitude < 0.05) { // Если сигнал очень тихий
            const gain = 0.1 / maxAmplitude; // Усиление до 0.1
            const normalizedData = new Float32Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                normalizedData[i] = inputData[i] * Math.min(gain, 5); // Ограничиваем усиление
            }
            inputData = normalizedData;
        }

        updateAudioVisualization(inputData);

        const pcm16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32767)));
        }
        
        try {
          websocket.send(JSON.stringify({
            type: "input_audio_buffer.append",
            event_id: `audio_${Date.now()}`,
            audio: arrayBufferToBase64(pcm16Data.buffer)
          }));
          if (!hasAudioData && maxAmplitude > effectiveAudioConfig.soundDetectionThreshold) {
            hasAudioData = true;
            audioDataStartTime = Date.now();
            widgetLog("Начало записи аудиоданных (звук обнаружен)");
          }
        } catch (error) {
          widgetLog(`Ошибка отправки аудио: ${error.message}`, "error");
        }
        // Логика тишины (остается прежней, но может быть менее актуальна с VAD на сервере)
      };
      
      const streamSource = audioContext.createMediaStreamSource(mediaStream);
      streamSource.connect(audioProcessor);
      // Важно: НЕ подключать audioProcessor к audioContext.destination, если не нужно слышать свой голос.
      // Для iOS это может вызывать проблемы с эхом на некоторых устройствах.
      // Если нужно, то только через GainNode с gain.value = 0
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0;
      audioProcessor.connect(gainNode);
      gainNode.connect(audioContext.destination); // Тишина на выход

      widgetLog("Аудио инициализировано успешно");
      return true;
    }
    
    // MOB-INTEGRATION: Начало записи голоса (обновлено)
    async function startListening() {
      widgetLog(`Попытка начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`);
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
        return;
      }
      
      // MOB-INTEGRATION: Проверка и активация аудио для iOS
      if (isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence || (window.tempAudioContext && window.tempAudioContext.state !== 'running')) {
          widgetLog("iOS: Аудио требует активации перед прослушиванием.");
          const unlocked = await unlockAudioOnIOS(); // Пытаемся разблокировать
          if (!unlocked) {
            widgetLog("iOS: Не удалось активировать аудио, показываем кнопку.");
            if (iosAudioButton) iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
            return; // Не начинаем слушать, если не разблокировано
          } else {
             if (iosAudioButton) iosAudioButton.classList.remove('visible');
          }
        }
      }
      
      isListening = true;
      widgetLog('Начинаем прослушивание');
      
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
      }
      
      if (!audioContext || (audioContext && audioContext.state !== 'running') || !mediaStream || !mediaStream.active) {
        widgetLog('Аудио не инициализировано или AudioContext/MediaStream не активен. Вызов initAudio.');
        const success = await initAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио для прослушивания.', 'error');
          isListening = false;
          return;
        }
      } else {
         widgetLog('Аудио уже инициализировано и AudioContext активен.');
      }
      
      hasAudioData = false;
      audioDataStartTime = 0;
      
      if (!isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
    }
    
    // Функция для отправки аудиобуфера (без изменений, но убедимся, что вызывается корректно)
    function commitAudioBuffer() {
      if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) return;
      if (!hasAudioData) {
        widgetLog("Не отправляем пустой аудиобуфер", "warn");
        return;
      }
      
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс), ожидаем больше данных`, "warn");
        const extraDelay = isMobile ? 200 : 50;
        setTimeout(() => {
          if (isListening && hasAudioData && !isReconnecting) {
            widgetLog(`Отправка аудиобуфера после доп. записи (${Date.now() - audioDataStartTime}мс)`);
            sendCommitBuffer();
          }
        }, minimumAudioLength - audioLength + extraDelay);
        return;
      }
      sendCommitBuffer();
    }
    
    // Функция для фактической отправки буфера (без изменений)
    function sendCommitBuffer() {
      widgetLog("Отправка аудиобуфера");
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < 100) { // OpenAI Whisper требует минимум 0.1с
        widgetLog(`Аудиобуфер слишком короткий для OpenAI (${audioLength}мс < 100мс), не отправляем`, "warn");
        hasAudioData = false;
        audioDataStartTime = 0;
        return;
      }
      
      if (isMobile) {
        setTimeout(() => { mainCircle.classList.remove('listening'); }, 100);
      } else {
        mainCircle.classList.remove('listening');
      }
      
      websocket.send(JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}`
      }));
      
      if (isMobile && loaderModal) {
        loaderModal.classList.add('active');
        setTimeout(() => { loaderModal.classList.remove('active'); }, 1000);
      }
      hasAudioData = false;
      audioDataStartTime = 0;
    }
    
    // Преобразование ArrayBuffer в Base64 (без изменений)
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }
    
    // Преобразование Base64 в ArrayBuffer (без изменений)
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
    
    // Обновление визуализации аудио (без изменений)
    function updateAudioVisualization(audioData) {
      const barsList = audioBars.querySelectorAll('.wellcomeai-audio-bar'); // Renamed to avoid conflict
      if (!barsList || barsList.length === 0) return;
      const step = Math.floor(audioData.length / barsList.length);
      
      for (let i = 0; i < barsList.length; i++) {
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
        barsList[i].style.height = `${height}px`;
      }
    }
    
    // Сброс визуализации аудио (без изменений)
    function resetAudioVisualization() {
      const barsList = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      barsList.forEach(bar => {
        bar.style.height = '2px';
      });
    }
    
    // Создаём простой WAV из PCM данных (без изменений)
    function createWavFromPcm(pcmBuffer, sampleRate = 24000) {
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      view.setUint8(0, 'R'.charCodeAt(0)); view.setUint8(1, 'I'.charCodeAt(0)); view.setUint8(2, 'F'.charCodeAt(0)); view.setUint8(3, 'F'.charCodeAt(0));
      view.setUint32(4, 36 + pcmBuffer.byteLength, true);
      view.setUint8(8, 'W'.charCodeAt(0)); view.setUint8(9, 'A'.charCodeAt(0)); view.setUint8(10, 'V'.charCodeAt(0)); view.setUint8(11, 'E'.charCodeAt(0));
      view.setUint8(12, 'f'.charCodeAt(0)); view.setUint8(13, 'm'.charCodeAt(0)); view.setUint8(14, 't'.charCodeAt(0)); view.setUint8(15, ' '.charCodeAt(0));
      view.setUint32(16, 16, true); view.setUint16(20, 1, true);  view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); 
      view.setUint16(32, 2, true);  view.setUint16(34, 16, true);
      view.setUint8(36, 'd'.charCodeAt(0)); view.setUint8(37, 'a'.charCodeAt(0)); view.setUint8(38, 't'.charCodeAt(0)); view.setUint8(39, 'a'.charCodeAt(0));
      view.setUint32(40, pcmBuffer.byteLength, true);
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      return wavBuffer;
    }
    
    // MOB-INTEGRATION: Воспроизведение следующего аудио в очереди (существенно переработано для iOS)
    async function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        isPlayingAudio = false;
        mainCircle.classList.remove('speaking');
        if (!isWidgetOpen) widgetButton.classList.add('wellcomeai-pulse-animation');
        
        if (isWidgetOpen) {
          setTimeout(async () => { // MOB-INTEGRATION: async for startListening
            if (isIOS) {
              const unlocked = await unlockAudioOnIOS();
              if (unlocked) {
                if (iosAudioButton) iosAudioButton.classList.remove('visible');
                startListening();
              } else if (iosAudioButton) {
                iosAudioButton.classList.add('visible');
                showMessage("Нажмите кнопку для активации микрофона", 0);
              }
            } else {
              startListening();
            }
          }, 800);
        }
        return;
      }
      
      isPlayingAudio = true;
      mainCircle.classList.add('speaking');
      mainCircle.classList.remove('listening');
      
      const audioBase64 = audioPlaybackQueue.shift();
      
      // MOB-INTEGRATION: Web Audio API path for iOS primarily
      if (isIOS) {
          widgetLog("iOS: Пытаемся воспроизвести аудио через Web Audio API.");
          try {
              if (!window.tempAudioContext || window.tempAudioContext.state !== 'running') {
                  widgetLog("iOS: AudioContext не готов для Web Audio API playback, пытаемся разблокировать.");
                  const unlocked = await unlockAudioOnIOS(); // Эта функция также вызовет resume
                  if (!unlocked || !window.tempAudioContext || window.tempAudioContext.state !== 'running') {
                      widgetLog("iOS: Не удалось активировать AudioContext для Web Audio API playback.", "error");
                      throw new Error("AudioContext not active for Web Audio API playback");
                  }
                  widgetLog("iOS: AudioContext активирован для Web Audio API playback.");
              }
              
              const currentAudioContext = window.tempAudioContext; // Используем глобальный контекст
              const audioData = base64ToArrayBuffer(audioBase64);
              if (audioData.byteLength === 0) {
                  widgetLog("Пустой аудио чанк для Web Audio API, пропускаем.", "warn");
                  playNextAudio(); // await не нужен, т.к. это рекурсивный вызов в той же функции
                  return;
              }

              // Используем sampleRate контекста, если он есть, или дефолтный
              const sampleRate = currentAudioContext.sampleRate || 24000;
              const wavBuffer = createWavFromPcm(audioData, sampleRate);

              // Оборачиваем decodeAudioData в Promise для лучшей обработки
              const decodedBuffer = await new Promise((resolve, reject) => {
                  currentAudioContext.decodeAudioData(wavBuffer, resolve, (err) => {
                      widgetLog(`Ошибка декодирования аудио для Web Audio API: ${err}`, "error");
                      reject(err);
                  });
              });

              const source = currentAudioContext.createBufferSource();
              source.buffer = decodedBuffer;
              source.connect(currentAudioContext.destination);
              source.onended = () => {
                  widgetLog("iOS: Воспроизведение через Web Audio API завершено.");
                  playNextAudio();
              };
              source.start(0);
              widgetLog("iOS: Воспроизведение через Web Audio API начато.");
              return; // Успешно запущено через Web Audio API

          } catch (error) {
              widgetLog(`iOS: Ошибка Web Audio API playback: ${error.message}. Переходим к fallback (<audio> элемент).`, "warn");
              // Fallback на <audio> элемент ниже, если Web Audio API не сработало
          }
      }

      // Fallback: <audio> element playback (для non-iOS или если Web Audio API на iOS не сработал)
      widgetLog("Используем <audio> элемент для воспроизведения.");
      try {
        const audioData = base64ToArrayBuffer(audioBase64);
        if (audioData.byteLength === 0) {
            widgetLog("Пустой аудио чанк для <audio> элемента, пропускаем.", "warn");
            playNextAudio();
            return;
        }
        
        const wavBuffer = createWavFromPcm(audioData); // sampleRate по умолчанию
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);
        
        const audio = new Audio();
        audio.src = audioUrl;
        audio.preload = 'auto';
        // audio.load(); // Не всегда нужно, play() обычно триггерит load

        const playHandler = () => {
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    widgetLog(`Ошибка <audio>.play(): ${error.message} (name: ${error.name})`, "error");
                    if (error.name === 'NotAllowedError' && isIOS && iosAudioButton) {
                        iosAudioButton.classList.add('visible');
                        showMessage("Нажмите кнопку для активации звука", 0);
                        // Не вызываем playNextAudio, ждем действия пользователя
                    } else {
                        URL.revokeObjectURL(audioUrl); // Освобождаем ресурс перед следующим вызовом
                        playNextAudio();
                    }
                });
            }
        };

        // Для iOS может потребоваться событие canplaythrough
        if (isIOS) {
            audio.oncanplaythrough = () => { 
                widgetLog("<audio> oncanplaythrough, пытаемся play()");
                playHandler(); 
                audio.oncanplaythrough = null; // Вызываем только один раз
            };
        } else {
            playHandler(); // Для других устройств можно сразу
        }
        
        audio.onended = () => {
            widgetLog("<audio> onended.");
            URL.revokeObjectURL(audioUrl);
            playNextAudio();
        };
        audio.onerror = (e) => {
            widgetLog(`Ошибка <audio> элемента: ${e.message || 'неизвестная ошибка'}`, 'error');
            URL.revokeObjectURL(audioUrl);
            playNextAudio();
        };
      } catch (error) {
        widgetLog(`Критическая ошибка при подготовке <audio> элемента: ${error.message}`, "error");
        playNextAudio();
      }
    }
    
    // Добавить аудио в очередь воспроизведения (без изменений)
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') return;
      audioPlaybackQueue.push(audioBase64);
      if (!isPlayingAudio) {
        playNextAudio(); // playNextAudio теперь async
      }
    }
    
    // Функция для переподключения с задержкой (без существенных изменений, использует мобильные константы)
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
      
      const delay = initialDelay > 0 ? initialDelay : 
                isMobile ? 
                    Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) :
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
      reconnectAttempts++;
      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);
      
      setTimeout(() => {
        if (isReconnecting) {
          connectWebSocket().then(success => { // connectWebSocket теперь async
            if (success) {
              reconnectAttempts = 0; 
              isReconnecting = false;
              if (isWidgetOpen) {
                showMessage("Соединение восстановлено", 3000);
                updateConnectionStatus('connected', 'Подключено');
                setTimeout(async () => { // MOB-INTEGRATION: async
                  if (isWidgetOpen && !isListening && !isPlayingAudio) {
                    if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence || (window.tempAudioContext && window.tempAudioContext.state !== 'running'))) {
                      if (iosAudioButton) iosAudioButton.classList.add('visible');
                      showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                    } else {
                      if (iosAudioButton) iosAudioButton.classList.remove('visible');
                      startListening();
                    }
                  }
                }, 1000);
              }
            } else {
              // connectWebSocket сама обработает неудачу и запустит новую попытку если нужно
              isReconnecting = false; // Сбросить здесь, т.к. connectWebSocket завершилась
            }
          }).catch(() => {
            isReconnecting = false; // Сбросить и при reject
          });
        }
      }, delay);
    }
    
    // Подключение к WebSocket серверу (без существенных изменений, использует мобильные константы)
    async function connectWebSocket() { // MOB-INTEGRATION: сделана async для удобства .then()
      return new Promise((resolve, reject) => { // MOB-INTEGRATION: обернута в Promise
        try {
          loaderModal.classList.add('active');
          widgetLog("Подключение...");
          isReconnecting = true;
          hideConnectionError();

          if (!ASSISTANT_ID) {
            widgetLog('Assistant ID not found!', 'error');
            showMessage("Ошибка: ID ассистента не указан.");
            loaderModal.classList.remove('active');
            isReconnecting = false;
            reject(new Error("Assistant ID not found")); // MOB-INTEGRATION
            return;
          }
          widgetLog(`Connecting to WebSocket at: ${WS_URL}`);
          
          if (websocket) { try { websocket.close(); } catch (e) {} }
          if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
          if (connectionTimeoutTimer) { clearTimeout(connectionTimeoutTimer); }
          
          websocket = new WebSocket(WS_URL);
          websocket.binaryType = 'arraybuffer'; // Уже было
          
          connectionTimeoutTimer = setTimeout(() => {
            widgetLog("Превышено время ожидания соединения", "error");
            if (websocket) websocket.close(); // Это вызовет onclose, который обработает переподключение
            // isReconnecting = false; // onclose установит
            loaderModal.classList.remove('active');
            // reconnectAttempts++; // onclose обработает
            // ... остальная логика таймаута теперь в onclose
            reject(new Error("Connection timeout")); // MOB-INTEGRATION
          }, CONNECTION_TIMEOUT);
          
          websocket.onopen = function() {
            clearTimeout(connectionTimeoutTimer);
            widgetLog('WebSocket connection established');
            isConnected = true;
            isReconnecting = false;
            reconnectAttempts = 0;
            connectionFailedPermanently = false;
            loaderModal.classList.remove('active');
            
            lastPingTime = Date.now();
            lastPongTime = Date.now();
            const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
            
            pingIntervalId = setInterval(() => {
              if (websocket && websocket.readyState === WebSocket.OPEN) {
                try {
                  websocket.send(JSON.stringify({ type: "ping" }));
                  lastPingTime = Date.now();
                  if (Date.now() - lastPongTime > pingIntervalTime * 3) {
                    widgetLog("Ping timeout, no pong received", "warn");
                    clearInterval(pingIntervalId);
                    pingIntervalId = null;
                    websocket.close(); // Это вызовет onclose для переподключения
                  }
                } catch (e) {
                  widgetLog(`Error sending ping: ${e.message}`, "error");
                }
              }
            }, pingIntervalTime);
            
            hideConnectionError();
            if (isWidgetOpen) updateConnectionStatus('connected', 'Подключено');
            
            if (isWidgetOpen) {
              if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence || (window.tempAudioContext && window.tempAudioContext.state !== 'running'))) {
                if (iosAudioButton) iosAudioButton.classList.add('visible');
                showMessage("Нажмите кнопку ниже для активации микрофона", 0);
              } else {
                if (iosAudioButton) iosAudioButton.classList.remove('visible');
                startListening();
              }
            }
            resolve(true); // MOB-INTEGRATION
          };
          
          websocket.onmessage = function(event) {
            try {
              if (event.data instanceof Blob) {
                widgetLog("Получены бинарные данные от сервера"); return;
              }
              if (!event.data) {
                widgetLog("Получено пустое сообщение от сервера", "warn"); return;
              }
              const data = JSON.parse(event.data);
              lastPongTime = Date.now();
              if (data.type !== 'input_audio_buffer.append') {
                 widgetLog(`Получено сообщение типа: ${data.type || 'unknown'}`);
              }
              
              if (data.type === 'session.created' || data.type === 'session.updated') {
                return;
              }
              if (data.type === 'connection_status') {
                if (data.status === 'connected') {
                  isConnected = true; reconnectAttempts = 0; connectionFailedPermanently = false;
                  hideConnectionError();
                  if (isWidgetOpen) startListening();
                }
                return;
              }
              if (data.type === 'error') {
                if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                  widgetLog("Ошибка: пустой аудиобуфер", "warn");
                  if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                    setTimeout(() => { startListening(); }, 500);
                  }
                  return;
                }
                widgetLog(`Ошибка от сервера: ${data.error ? data.error.message : 'Неизвестная ошибка'}`, "error");
                showMessage(data.error ? data.error.message : 'Произошла ошибка на сервере', 5000);
                return;
              } 
              if (data.type === 'response.text.delta') {
                if (data.delta) {
                  showMessage(data.delta, 0);
                  if (!isWidgetOpen) widgetButton.classList.add('wellcomeai-pulse-animation');
                }
                return;
              }
              if (data.type === 'response.text.done') {
                setTimeout(() => { hideMessage(); }, 5000);
                return;
              }
              if (data.type === 'response.audio.delta') {
                if (data.delta) audioChunksBuffer.push(data.delta);
                return;
              }
              if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
                return;
              }
              if (data.type === 'response.audio.done') {
                if (audioChunksBuffer.length > 0) {
                  const fullAudio = audioChunksBuffer.join('');
                  addAudioToPlaybackQueue(fullAudio);
                  audioChunksBuffer = [];
                }
                return;
              }
              if (data.type === 'response.done') {
                widgetLog('Response done received');
                if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                  if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence || (window.tempAudioContext && window.tempAudioContext.state !== 'running'))) {
                    if (iosAudioButton) iosAudioButton.classList.add('visible');
                    showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                  } else {
                    if (iosAudioButton) iosAudioButton.classList.remove('visible');
                    setTimeout(() => { startListening(); }, 800);
                  }
                }
                return;
              }
              widgetLog(`Неизвестный тип сообщения: ${data.type}`, "warn");
            } catch (parseError) {
              widgetLog(`Ошибка парсинга JSON: ${parseError.message}`, "warn");
              if (event.data === 'pong') {
                lastPongTime = Date.now();
                widgetLog("Получен pong-ответ");
                return;
              }
              widgetLog(`Содержимое сообщения: ${typeof event.data === 'string' ? event.data.substring(0, 100) : 'не строка'}...`, "debug");
            }
          } catch (generalError) {
            widgetLog(`Общая ошибка обработки сообщения: ${generalError.message}`, "error");
          }
        };
        
        websocket.onclose = function(event) {
          widgetLog(`WebSocket connection closed: ${event.code}, ${event.reason}`);
          isConnected = false;
          isListening = false;
          clearTimeout(connectionTimeoutTimer); // MOB-INTEGRATION: Clear timeout on close
          if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
          
          if (event.code === 1000 || event.code === 1001) { // Normal closure
            isReconnecting = false;
            widgetLog('Clean WebSocket close, not reconnecting');
            resolve(false); // MOB-INTEGRATION: Resolve false for clean close if connectWebSocket was called
            return;
          }
          // MOB-INTEGRATION: Call reconnectWithDelay which will handle attempts
          reconnectWithDelay(); 
          resolve(false); // MOB-INTEGRATION: Indicate connection attempt failed
        };
        
        websocket.onerror = function(error) { // error is an Event, not an Error object
          widgetLog(`WebSocket error event`, 'error'); // Log the event object
          if (isWidgetOpen) {
            showMessage("Ошибка соединения с сервером");
            updateConnectionStatus('disconnected', 'Ошибка соединения');
          }
          // onclose будет вызван после onerror, так что переподключение будет обработано там
          // resolve(false); // MOB-INTEGRATION: Indicate connection attempt failed
        };
      } catch (error) { // Catches errors in WebSocket constructor or initial setup
        widgetLog(`Error setting up WebSocket: ${error.message}`, 'error');
        isReconnecting = false;
        loaderModal.classList.remove('active');
        reconnectWithDelay(); // Попытка переподключения
        reject(error); // MOB-INTEGRATION
      }
      });
    }

    // Добавляем обработчики событий для интерфейса
    widgetButton.addEventListener('click', function(e) {
      widgetLog('Button clicked');
      e.preventDefault(); e.stopPropagation();
      openWidget();
    });

    widgetClose.addEventListener('click', function(e) {
      widgetLog('Close button clicked');
      e.preventDefault(); e.stopPropagation();
      closeWidget();
    });
    
    // MOB-INTEGRATION: Обработчик для основного круга (обновлен)
    mainCircle.addEventListener('click', async function() {
      widgetLog(`Circle clicked: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
      
      if (isIOS) {
        const unlocked = await unlockAudioOnIOS(); // Эта функция теперь async
        if (unlocked) {
          widgetLog('iOS: Audio context successfully unlocked/resumed via circle click');
          if (iosAudioButton) iosAudioButton.classList.remove('visible');
          // Продолжаем с логикой клика ниже
        } else {
            widgetLog('iOS: Audio context unlock failed via circle click. Showing button.');
            if (iosAudioButton) iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации аудио",0);
            return; // Прерываем, если не удалось разблокировать
        }
      } else if (isMobile && window.tempAudioContext && window.tempAudioContext.state === 'suspended') {
          try {
              await window.tempAudioContext.resume();
              widgetLog('Mobile (non-iOS): AudioContext resumed on circle click.');
          } catch (e) {
              widgetLog(`Mobile (non-iOS): Failed to resume AudioContext: ${e.message}`, 'error');
          }
      }

      if (isWidgetOpen && !isListening && !isPlayingAudio && !isReconnecting) {
        if (isConnected) {
          startListening();
        } else if (connectionFailedPermanently) {
          showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
        } else {
          connectWebSocket();
        }
      } else if (isListening) {
          widgetLog("Circle clicked while listening: committing audio buffer.");
          commitAudioBuffer(); // Если слушаем и нажали - завершить запись
      }
    });
    
    // MOB-INTEGRATION: Обработчик для iOS кнопки активации аудио (обновлен)
    if (isIOS && iosAudioButton) {
      iosAudioButton.addEventListener('click', async function() {
        widgetLog("iOS audio activation button clicked.");
        // Сначала пробуем стандартную разблокировку
        let success = await unlockAudioOnIOS();
        
        if (success && window.tempAudioContext && window.tempAudioContext.state === 'running') {
          widgetLog("iOS: Аудио успешно активировано через кнопку (unlockAudioOnIOS).");
          iosAudioButton.classList.remove('visible');
          hideMessage(); // Скрываем "Нажмите кнопку..."
          // Пытаемся начать слушать через небольшую задержку
          setTimeout(() => {
            if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
              startListening();
            }
          }, 300);
        } else {
          // Если стандартная не помогла, пробуем форсированную
          widgetLog("iOS: unlockAudioOnIOS не сработал или контекст не активен, пробуем forceIOSAudioUnlock.");
          success = await forceIOSAudioUnlock();
          if (success && window.tempAudioContext && window.tempAudioContext.state === 'running') {
            widgetLog("iOS: Аудио успешно активировано через кнопку (forceIOSAudioUnlock).");
            iosAudioButton.classList.remove('visible');
            hideMessage();
            setTimeout(() => {
              if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                startListening();
              }
            }, 300);
          } else {
            widgetLog("iOS: Не удалось активировать аудио даже с forceIOSAudioUnlock.", "error");
            showMessage("Не удалось активировать аудио. Попробуйте обновить страницу.", 5000);
          }
        }
      });
    }
    
    if (retryButton) {
      retryButton.addEventListener('click', function() {
        widgetLog('Retry button clicked');
        resetConnection();
      });
    }
    
    connectWebSocket();
    
    // DOM check after initialization
    setTimeout(function() { /* ... (остается как есть) ... */ }, 2000);
  }

  // Инициализируем виджет
  function initializeWidget() {
    widgetLog('Initializing...');
    widgetLog(`Device type: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);
    loadFontAwesome();
    createStyles();
    createWidgetHTML();
    initWidget(); // initWidget теперь содержит async вызовы, но сама initializeWidget не обязательно должна быть async
    widgetLog('Initialization complete');
  }
  
  if (!document.getElementById('wellcomeai-widget-container')) {
    widgetLog('Starting initialization process');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeWidget);
    } else {
      initializeWidget();
    }
  } else {
    widgetLog('Widget already exists on the page, skipping initialization');
  }
})();
