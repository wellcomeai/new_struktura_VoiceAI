/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.3.1 - с улучшенным эхо-подавлением и исправлением самопрослушивания
 * 
 * Этот скрипт динамически создает и встраивает виджет голосового ассистента
 * на любой сайт, в том числе на Tilda и другие конструкторы сайтов.
 * Улучшена поддержка мобильных устройств и iOS.
 * Добавлена возможность перебивания ассистента голосом с эхо-подавлением.
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
      
      /* НОВЫЙ СТИЛЬ ДЛЯ ПЕРЕБИВАНИЯ */
      .wellcomeai-main-circle.interrupted {
        background: linear-gradient(135deg, #ffffff, #ffebee, #f44336);
        box-shadow: 0 0 30px rgba(244, 67, 54, 0.6);
        animation: wellcomeai-interrupt-flash 0.3s ease;
      }
      
      @keyframes wellcomeai-interrupt-flash {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.05); }
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
    
    // Важно: явно делаем кнопку виджета видимой
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
    
    // ПЕРЕМЕННЫЕ ДЛЯ ПЕРЕБИВАНИЯ с улучшенной конфигурацией
    let currentResponseId = null;
    let samplesPlayedSoFar = 0;
    let audioSamplesExpected = 0;
    let soundDetectionCounter = 0;
    let lastInterruptionTime = 0;
    
    // ПЕРЕМЕННЫЕ ДЛЯ ЭХО-ПОДАВЛЕНИЯ
    let lastPlaybackStartTime = 0;
    let isInEchoSuppressionPeriod = false;
    let gainNode = null; // Для управления усилением микрофона
    
    // Конфигурация для оптимизации потока аудио - разные настройки для десктопа и мобильных
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,      // Порог для определения тишины
      silenceDuration: 300,        // Длительность тишины для отправки (мс)
      bufferCheckInterval: 50,     // Частота проверки буфера (мс)
      soundDetectionThreshold: 0.02 // Чувствительность к звуку
    };
    
    // Специальные настройки для мобильных устройств
    const MOBILE_AUDIO_CONFIG = {
      silenceThreshold: 0.015,      // Более низкий порог для мобильных
      silenceDuration: 500,         // Увеличенная длительность тишины 
      bufferCheckInterval: 100,     // Увеличенный интервал проверки
      soundDetectionThreshold: 0.015 // Более чувствительное определение звука
    };
    
    // УЛУЧШЕННАЯ КОНФИГУРАЦИЯ ДЛЯ ПЕРЕБИВАНИЯ
    const INTERRUPTION_CONFIG = {
      soundDetectionThreshold: isIOS ? 0.03 : (isMobile ? 0.035 : 0.04), // УВЕЛИЧЕНЫ пороги
      consecutiveDetections: isIOS ? 12 : (isMobile ? 10 : 8), // УВЕЛИЧЕНО количество циклов
      minimumInterruptionGap: 1000, // УВЕЛИЧЕНА минимальная пауза до 1 секунды
      gainReductionDuringPlayback: 0.1, // СИЛЬНОЕ снижение чувствительности во время воспроизведения
      echoSuppressionTime: 2000 // Время подавления эхо после начала воспроизведения
    };
    
    // Выбираем нужную конфигурацию в зависимости от устройства
    const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;
    
    // Отправка команды отмены
    function sendCancel(itemId = null, sampleCount = 0) {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        const payload = {
          type: "response.cancel",
          event_id: `cancel_${Date.now()}`
        };
        
        if (itemId) payload.item_id = itemId;
        if (sampleCount > 0) payload.sample_count = sampleCount;
        
        websocket.send(JSON.stringify(payload));
        widgetLog(`[INTERRUPTION] Sent response.cancel: itemId=${itemId}, sampleCount=${sampleCount}`);
      }
    }
    
    // Остановка воспроизведения локально
    function flushPlaybackQueue() {
      // Локально прерываем воспроизведение
      audioPlaybackQueue = [];
      isPlayingAudio = false;
      mainCircle.classList.remove('speaking');
      
      // Останавливаем все активные аудио элементы
      document.querySelectorAll('audio').forEach(audio => {
        if (!audio.paused) {
          audio.pause();
          audio.currentTime = 0;
        }
      });
      
      widgetLog('[INTERRUPTION] Playback queue flushed');
    }
    
    // Показать визуальную обратную связь о перебивании
    function showInterruptionFeedback() {
      mainCircle.classList.add('interrupted');
      setTimeout(() => {
        mainCircle.classList.remove('interrupted');
      }, 300);
    }
    
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
      
      // Сбрасываем переменные для перебивания
      currentResponseId = null;
      samplesPlayedSoFar = 0;
      audioSamplesExpected = 0;
      soundDetectionCounter = 0;
      
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
      mainCircle.classList.remove('interrupted');
      
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
        try {
          // Создаем временный аудио контекст для мобильных
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          // На Android достаточно создать контекст после взаимодействия с пользователем
          window.audioContextInitialized = true;
          widgetLog("Mobile audio context initialized");
        } catch (e) {
          widgetLog(`Failed to initialize audio context: ${e.message}`, "error");
        }
      }
      
      // Показываем сообщение о проблеме с подключением, если оно есть
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        return;
      }
      
      // Запускаем прослушивание при открытии, если соединение активно
      if (isConnected && !isListening && !isReconnecting) {
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
    
    // ИСПРАВЛЕННАЯ ФУНКЦИЯ ИНИЦИАЛИЗАЦИИ АУДИО с улучшенным эхо-подавлением
    async function initAudio() {
      try {
        widgetLog("Запрос разрешения на доступ к микрофону...");
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону");
        }
        
        // УЛУЧШЕННЫЕ настройки для эхо-подавления
        const audioConstraints = isIOS ? 
          { 
            echoCancellation: true,  // ВКЛЮЧАЕМ эхо-подавление для iOS
            noiseSuppression: true,
            autoGainControl: false   // ОТКЛЮЧАЕМ автоматическое усиление
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
        
        // ИСПРАВЛЕННЫЙ ОБРАБОТЧИК АУДИО с улучшенным эхо-подавлением
        audioProcessor.onaudioprocess = function(e) {
          if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
            const inputBuffer = e.inputBuffer;
            let inputData = inputBuffer.getChannelData(0);
            
            if (inputData.length === 0) return;
            
            // Вычисляем амплитуду
            let maxAmplitude = 0;
            for (let i = 0; i < inputData.length; i++) {
              maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
            }
            
            // УЛУЧШЕННАЯ ЛОГИКА ЭХО-ПОДАВЛЕНИЯ
            const now = Date.now();
            
            // Проверяем, находимся ли мы в периоде подавления эхо
            isInEchoSuppressionPeriod = (now - lastPlaybackStartTime) < INTERRUPTION_CONFIG.echoSuppressionTime;
            
            // Динамически изменяем чувствительность в зависимости от состояния воспроизведения
            let effectiveThreshold = INTERRUPTION_CONFIG.soundDetectionThreshold;
            
            if (isPlayingAudio || isInEchoSuppressionPeriod) {
              // ЗНАЧИТЕЛЬНО повышаем порог во время воспроизведения и после него
              effectiveThreshold = INTERRUPTION_CONFIG.soundDetectionThreshold * 4; // В 4 раза выше
              
              // Дополнительно снижаем усиление микрофона программно
              if (gainNode) {
                gainNode.gain.value = INTERRUPTION_CONFIG.gainReductionDuringPlayback;
              }
            } else {
              // Восстанавливаем нормальное усиление
              if (gainNode) {
                gainNode.gain.value = 1.0;
              }
            }
            
            const hasSound = maxAmplitude > effectiveThreshold;
            
            // УЛУЧШЕННАЯ ЛОГИКА ДЕТЕКЦИИ РЕЧИ ВО ВРЕМЯ ВОСПРОИЗВЕДЕНИЯ
            if (isPlayingAudio && hasSound && !isInEchoSuppressionPeriod) {
              // Проверяем минимальный интервал между отменами
              if (now - lastInterruptionTime > INTERRUPTION_CONFIG.minimumInterruptionGap) {
                soundDetectionCounter++;
                
                // УВЕЛИЧЕНО количество необходимых детекций подряд
                if (soundDetectionCounter >= INTERRUPTION_CONFIG.consecutiveDetections) {
                  // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: убеждаемся что это действительно речь пользователя
                  // Проверяем что амплитуда значительно превышает порог
                  if (maxAmplitude > effectiveThreshold * 1.5) {
                    widgetLog(`[INTERRUPTION] Детектирована речь пользователя (амплитуда: ${maxAmplitude.toFixed(4)}, порог: ${effectiveThreshold.toFixed(4)})`);
                    
                    showInterruptionFeedback();
                    
                    // Отменяем только если есть активный ответ
                    if (currentResponseId) {
                      sendCancel(currentResponseId, samplesPlayedSoFar);
                      flushPlaybackQueue();
                      lastInterruptionTime = now;
                      
                      // Запускаем период подавления эхо
                      lastPlaybackStartTime = now;
                    }
                    
                    soundDetectionCounter = 0;
                    
                    // Очищаем буфер и начинаем новую запись
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
              }
            } else {
              // Сбрасываем счетчик если нет звука или идет подавление эхо
              soundDetectionCounter = 0;
            }
            
            // Обновляем визуализацию ТОЛЬКО если не подавляем эхо
            if (!isInEchoSuppressionPeriod) {
              updateAudioVisualization(inputData);
            }
            
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
            
            // Логика определения тишины (НЕ изменена)
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
        
        // Для всех устройств НЕ подключаем к выходу для избежания обратной связи
        const dummyGain = audioContext.createGain();
        dummyGain.gain.value = 0;
        audioProcessor.connect(dummyGain);
        dummyGain.connect(audioContext.destination);
        
        widgetLog("Аудио инициализировано с улучшенным эхо-подавлением");
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
    
    // Начало записи голоса БЕЗ БЛОКИРОВКИ isPlayingAudio
    async function startListening() {
      // УБРАНА ПРОВЕРКА isPlayingAudio - теперь микрофон может работать параллельно
      if (!isConnected || isReconnecting || isListening) {
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isReconnecting=${isReconnecting}, isListening=${isListening}`);
        return;
      }
      
      // Для iOS применяем глубокую разблокировку аудио перед стартом записи
      if (isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          await forceIOSAudioUnlock();
        }
      }
      
      isListening = true;
      widgetLog('[INTERRUPTION] Начинаем прослушивание (микрофон может работать параллельно с воспроизведением)');
      
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
        // Вычисляем среднее значение амплитуды для этого "отрезка" аудиоданных
        let sum = 0;
        for (let j = 0; j < step; j++) {
          const index = i * step + j;
          if (index < audioData.length) {
            sum += Math.abs(audioData[index]);
          }
        }
        const average = sum / step;
        
        // Для мобильных устройств увеличиваем чувствительность
        const multiplier = isMobile ? 150 : 100;
        
        // Нормализуем значение для высоты полосы (от 2px до 30px)
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
      // Создаём заголовок WAV
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      
      // "RIFF" chunk descriptor
      view.setUint8(0, 'R'.charCodeAt(0));
      view.setUint8(1, 'I'.charCodeAt(0));
      view.setUint8(2, 'F'.charCodeAt(0));
      view.setUint8(3, 'F'.charCodeAt(0));
      
      view.setUint32(4, 36 + pcmBuffer.byteLength, true); // Размер всего файла - 8
      
      // "WAVE" формат
      view.setUint8(8, 'W'.charCodeAt(0));
      view.setUint8(9, 'A'.charCodeAt(0));
      view.setUint8(10, 'V'.charCodeAt(0));
      view.setUint8(11, 'E'.charCodeAt(0));
      
      // "fmt " субчанк
      view.setUint8(12, 'f'.charCodeAt(0));
      view.setUint8(13, 'm'.charCodeAt(0));
      view.setUint8(14, 't'.charCodeAt(0));
      view.setUint8(15, ' '.charCodeAt(0));
      
      view.setUint32(16, 16, true); // Размер fmt субчанка
      view.setUint16(20, 1, true);  // Формат аудио (1 = PCM)
      view.setUint16(22, 1, true);  // Число каналов (1 = моно)
      view.setUint32(24, sampleRate, true); // Частота дискретизации
      view.setUint32(28, sampleRate * 2, true); // Байт в секунду (SampleRate * NumChannels * BitsPerSample/8)
      view.setUint16(32, 2, true);  // Байт на сэмпл (NumChannels * BitsPerSample/8)
      view.setUint16(34, 16, true); // Бит на сэмпл
      
      // "data" субчанк
      view.setUint8(36, 'd'.charCodeAt(0));
      view.setUint8(37, 'a'.charCodeAt(0));
      view.setUint8(38, 't'.charCodeAt(0));
      view.setUint8(39, 'a'.charCodeAt(0));
      
      view.setUint32(40, pcmBuffer.byteLength, true); // Размер данных
      
      // Объединяем заголовок и PCM данные
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      
      return wavBuffer;
    }
    
    // УЛУЧШЕННАЯ ФУНКЦИЯ ВОСПРОИЗВЕДЕНИЯ
    function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        isPlayingAudio = false;
        mainCircle.classList.remove('speaking');
        
        // Сбрасываем переменные отслеживания
        currentResponseId = null;
        samplesPlayedSoFar = 0;
        audioSamplesExpected = 0;
        
        if (!isWidgetOpen) {
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        
        if (isWidgetOpen) {
          setTimeout(() => {
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
          }, 800);
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
        const playAudio = () => {
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
          
          // СНИЖАЕМ ГРОМКОСТЬ для уменьшения эхо
          audio.volume = 0.8;
          
          audio.preload = 'auto';
          audio.load();
          
          audio.oncanplaythrough = function() {
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
          
          audio.onended = function() {
            const audioDataLength = audioData.byteLength / 2;
            samplesPlayedSoFar += audioDataLength;
            
            URL.revokeObjectURL(audioUrl);
            playNextAudio();
          };
          
          audio.onerror = function() {
            widgetLog('Ошибка воспроизведения аудио', 'error');
            URL.revokeObjectURL(audioUrl);
            playNextAudio();
          };
        };
        
        if (isIOS) {
          unlockAudioOnIOS().then(() => {
            playAudio();
          });
        } else {
          playAudio();
        }
      } catch (error) {
        widgetLog(`Ошибка воспроизведения аудио: ${error.message}`, "error");
        playNextAudio();
      }
    }
    
    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') return;
      
      // Добавляем аудио в очередь
      audioPlaybackQueue.push(audioBase64);
      
      // Если не запущено воспроизведение, запускаем
      if (!isPlayingAudio) {
        playNextAudio();
      }
    }
    
    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      // Проверяем, не превышено ли максимальное количество попыток
      // Используем разное значение для мобильных и десктопных устройств
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
      
      if (reconnectAttempts >= maxAttempts) {
        widgetLog('Maximum reconnection attempts reached');
        isReconnecting = false;
        connectionFailedPermanently = true;
        
        // Показываем сообщение пользователю
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение. Попробуйте перезагрузить страницу.");
          updateConnectionStatus('disconnected', 'Отключено');
        } else {
          // Если виджет закрыт, добавляем пульсацию на кнопку
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        return;
      }
      
      isReconnecting = true;
      
      // Показываем сообщение пользователю, если виджет открыт
      if (isWidgetOpen) {
        showMessage("Соединение прервано. Переподключение...", 0);
        updateConnectionStatus('connecting', 'Переподключение...');
      }
      
      // Если задана начальная задержка, используем ее, иначе экспоненциальная
      // Для мобильных устройств используем более короткую задержку
      const delay = initialDelay > 0 ? 
                initialDelay : 
                isMobile ? 
                    Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) : // более короткая экспоненциальная задержка
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
      
      reconnectAttempts++;
      
      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);
      
      // Пытаемся переподключиться с увеличивающейся задержкой
      setTimeout(() => {
        if (isReconnecting) {
          connectWebSocket().then(success => {
            if (success) {
              reconnectAttempts = 0; // Сбрасываем счетчик при успешном подключении
              isReconnecting = false;
              
              if (isWidgetOpen) {
                showMessage("Соединение восстановлено", 3000);
                updateConnectionStatus('connected', 'Подключено');
                
                // Если виджет открыт, автоматически начинаем слушать
                setTimeout(() => {
                  if (isWidgetOpen && !isListening) {
                    if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
                      // Для iOS показываем кнопку активации
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
              // Если не удалось подключиться, функция connectWebSocket
              // сама запустит следующую попытку через экспоненциальную задержку
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
        
        // Сбрасываем флаг переподключения
        isReconnecting = true;
        
        // Скрываем ошибку соединения, если она была показана
        hideConnectionError();
        
        // Проверяем наличие ID ассистента
        if (!ASSISTANT_ID) {
          widgetLog('Assistant ID not found!', 'error');
          showMessage("Ошибка: ID ассистента не указан. Проверьте код встраивания.");
          loaderModal.classList.remove('active');
          return false;
        }
        
        // Используем настроенный WebSocket URL с ID ассистента
        widgetLog(`Connecting to WebSocket at: ${WS_URL}`);
        
        // Очищаем предыдущее соединение, если оно существует
        if (websocket) {
          try {
            websocket.close();
          } catch (e) {
            // Игнорируем ошибки при закрытии
          }
        }
        
        // Очищаем предыдущий таймер ping
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        
        // Очищаем таймаут соединения, если он есть
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }
        
        // Создаем новое WebSocket соединение
        websocket = new WebSocket(WS_URL);
        
        // Устанавливаем двоичный тип для эффективной передачи аудио
        websocket.binaryType = 'arraybuffer';
        
        // Устанавливаем таймаут на открытие соединения
        connectionTimeout = setTimeout(() => {
          widgetLog("Превышено время ожидания соединения", "error");
          
          if (websocket) {
            websocket.close();
          }
          
          isReconnecting = false;
          loaderModal.classList.remove('active');
          
          // Увеличиваем счетчик попыток и проверяем максимальное количество
          reconnectAttempts++;
          
          const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
          
          if (reconnectAttempts >= maxAttempts) {
            connectionFailedPermanently = true;
            
            if (isWidgetOpen) {
              showConnectionError("Не удалось подключиться к серверу. Пожалуйста, попробуйте позже.");
              updateConnectionStatus('disconnected', 'Отключено');
            } else {
              // Если виджет закрыт, добавляем пульсацию на кнопку
              widgetButton.classList.add('wellcomeai-pulse-animation');
            }
          } else {
            // Экспоненциальная задержка перед повторной попыткой
            // Для мобильных устройств используем более короткую задержку
            const delay = isMobile ?
                    Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) :
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
                    
            widgetLog(`Попытка переподключения через ${delay/1000} секунд (${reconnectAttempts}/${maxAttempts})`);
            
            if (isWidgetOpen) {
              showMessage(`Превышено время ожидания. Повторная попытка через ${Math.round(delay/1000)} сек...`);
              updateConnectionStatus('connecting', 'Переподключение...');
            }
            
            setTimeout(() => {
              connectWebSocket();
            }, delay);
          }
        }, CONNECTION_TIMEOUT);
        
        websocket.onopen = function() {
          clearTimeout(connectionTimeout);
          widgetLog('WebSocket connection established');
          isConnected = true;
          isReconnecting = false;
          reconnectAttempts = 0;
          connectionFailedPermanently = false;
          loaderModal.classList.remove('active');
          
          // Инициализируем переменные для ping/pong
          lastPingTime = Date.now();
          lastPongTime = Date.now();
          
          // Настраиваем интервал ping с разной частотой для мобильных и десктопных устройств
          const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
          
          // Запускаем ping для поддержания соединения
          pingInterval = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
              try {
                websocket.send(JSON.stringify({ type: "ping" }));
                lastPingTime = Date.now();
                
                // Проверяем, получили ли мы pong
                if (Date.now() - lastPongTime > pingIntervalTime * 3) {
                  widgetLog("Ping timeout, no pong received", "warn");
                  
                  // Пробуем переподключиться
                  clearInterval(pingInterval);
                  websocket.close();
                  reconnectWithDelay(1000); // Быстрое переподключение
                }
              } catch (e) {
                widgetLog(`Error sending ping: ${e.message}`, "error");
              }
            }
          }, pingIntervalTime);
          
          // Скрываем ошибку соединения, если она была показана
          hideConnectionError();
          
          // Обновляем статус соединения
          if (isWidgetOpen) {
            updateConnectionStatus('connected', 'Подключено');
          }
          
          // Автоматически начинаем слушать если виджет открыт
          if (isWidgetOpen) {
            // Проверяем состояние аудио для iOS
            if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
              // Показываем кнопку активации для iOS
              if (iosAudioButton) {
                iosAudioButton.classList.add('visible');
              }
              showMessage("Нажмите кнопку ниже для активации микрофона", 0);
            } else {
              startListening();
            }
          }
        };
        
        // УЛУЧШЕННАЯ ОБРАБОТКА СООБЩЕНИЙ WebSocket
        websocket.onmessage = function(event) {
          try {
            if (event.data instanceof Blob) {
              return;
            }
            
            if (!event.data) {
              return;
            }

            try {
              const data = JSON.parse(event.data);
              
              lastPongTime = Date.now();
              
              // ДОБАВЛЯЕМ ОБРАБОТКУ ВСЕХ ТИПОВ СООБЩЕНИЙ ИЗ ЛОГОВ
              const msg_type = data.type;
              
              // НЕ логируем частые сообщения
              const frequentMessages = [
                'input_audio_buffer.append.ack',
                'input_audio_buffer.clear.ack', 
                'input_audio_buffer.cleared',
                'input_audio_buffer.commit.ack',
                'input_audio_buffer.committed',
                'input_audio_buffer.speech_started',
                'input_audio_buffer.speech_stopped',
                'conversation.item.created',
                'conversation.item.input_audio_transcription.delta',
                'conversation.item.input_audio_transcription.completed',
                'response.created',
                'response.output_item.added',
                'response.output_item.done',
                'response.content_part.added',
                'response.content_part.done',
                'rate_limits.updated',
                'pong'
              ];
              
              if (!frequentMessages.includes(msg_type)) {
                widgetLog(`Получено сообщение типа: ${msg_type}`);
              }
              
              // УЛУЧШЕННАЯ ОБРАБОТКА ОТСЛЕЖИВАНИЯ ID
              if (data.type === 'response.audio.delta') {
                if (!currentResponseId && data.item_id) {
                  currentResponseId = data.item_id;
                  samplesPlayedSoFar = 0;
                  audioSamplesExpected = 0;
                  widgetLog(`[INTERRUPTION] Начало нового ответа: ${currentResponseId}`);
                }
                
                if (data.delta) {
                  const audioData = base64ToArrayBuffer(data.delta);
                  audioSamplesExpected += audioData.byteLength / 2;
                }
              }
              
              // Сбрасываем ID при завершении ответа
              if (data.type === 'response.done') {
                widgetLog(`[INTERRUPTION] Завершение ответа: ${currentResponseId}`);
                currentResponseId = null;
                samplesPlayedSoFar = 0;
                audioSamplesExpected = 0;
              }
              
              // ОБРАБОТКА ПОДТВЕРЖДЕНИЯ ОТМЕНЫ
              if (data.type === 'response.cancel.ack') {
                widgetLog(`[INTERRUPTION] Получено подтверждение отмены: success=${data.success}`);
                if (data.success) {
                  showMessage("Ответ прерван", 1000);
                }
                return; // НЕ показываем как неизвестное сообщение
              }
              
              // Проверка на сессию
              if (data.type === 'session.created' || data.type === 'session.updated') {
                return;
              }
              
              // Проверка на статус соединения
              if (data.type === 'connection_status') {
                if (data.status === 'connected') {
                  isConnected = true;
                  reconnectAttempts = 0;
                  connectionFailedPermanently = false;
                  hideConnectionError();
                  
                  if (isWidgetOpen) {
                    startListening();
                  }
                }
                return;
              }
              
              // Обработка ошибок
              if (data.type === 'error') {
                if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                  // Перезапускаем прослушивание без сообщения пользователю
                  if (isWidgetOpen && !isReconnecting) {
                    setTimeout(() => { 
                      startListening(); 
                    }, 500);
                  }
                  return;
                }
                
                // ИГНОРИРУЕМ ошибки отмены если нет активного ответа  
                if (data.error && data.error.message && data.error.message.includes('Cancellation failed')) {
                  widgetLog(`[INTERRUPTION] Ошибка отмены (нет активного ответа) - игнорируем`, 'warn');
                  return;
                }
                
                widgetLog(`Ошибка от сервера: ${data.error ? data.error.message : 'Неизвестная ошибка'}`, "error");
                showMessage(data.error ? data.error.message : 'Произошла ошибка на сервере', 5000);
                return;
              } 
              
              // Обработка текстового ответа
              if (data.type === 'response.text.delta') {
                if (data.delta) {
                  showMessage(data.delta, 0);
                  
                  if (!isWidgetOpen) {
                    widgetButton.classList.add('wellcomeai-pulse-animation');
                  }
                }
                return;
              }
              
              // Завершение текста
              if (data.type === 'response.text.done') {
                setTimeout(() => {
                  hideMessage();
                }, 5000);
                return;
              }
              
              // Обработка аудио
              if (data.type === 'response.audio.delta') {
                if (data.delta) {
                  audioChunksBuffer.push(data.delta);
                }
                return;
              }
              
              // Транскрипция аудио
              if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
                return;
              }
              
              // Аудио готово для воспроизведения
              if (data.type === 'response.audio.done') {
                if (audioChunksBuffer.length > 0) {
                  const fullAudio = audioChunksBuffer.join('');
                  addAudioToPlaybackQueue(fullAudio);
                  audioChunksBuffer = [];
                }
                return;
              }
              
              // Ответ завершен
              if (data.type === 'response.done') {
                widgetLog('Response done received');
                
                if (isWidgetOpen && !isReconnecting) {
                  if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
                    if (iosAudioButton) {
                      iosAudioButton.classList.add('visible');
                    }
                    showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                  } else {
                    setTimeout(() => {
                      startListening();
                    }, 800);
                  }
                }
                return;
              }
              
              // ВСЕ ЧАСТЫЕ СООБЩЕНИЯ ОБРАБАТЫВАЕМ БЕЗ ПРЕДУПРЕЖДЕНИЙ
              if (frequentMessages.includes(msg_type)) {
                return;
              }
              
              // Только для действительно неизвестных типов
              widgetLog(`Неизвестный тип сообщения: ${data.type}`, "warn");
              
            } catch (parseError) {
              if (event.data === 'pong') {
                lastPongTime = Date.now();
                return;
              }
              
              widgetLog(`Ошибка парсинга JSON: ${parseError.message}`, "warn");
            }
          } catch (generalError) {
            widgetLog(`Общая ошибка обработки сообщения: ${generalError.message}`, "error");
          }
        };
        
        websocket.onclose = function(event) {
          widgetLog(`WebSocket connection closed: ${event.code}, ${event.reason}`);
          isConnected = false;
          isListening = false;
          
          // Очищаем интервал ping
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          
          // Не пытаемся переподключаться, если соединение было закрыто нормально
          if (event.code === 1000 || event.code === 1001) {
            isReconnecting = false;
            widgetLog('Clean WebSocket close, not reconnecting');
            return;
          }
          
          // Вызываем функцию переподключения с экспоненциальной задержкой
          reconnectWithDelay();
        };
        
        websocket.onerror = function(error) {
          widgetLog(`WebSocket error: ${error}`, 'error');
          
          if (isWidgetOpen) {
            showMessage("Ошибка соединения с сервером");
            updateConnectionStatus('disconnected', 'Ошибка соединения');
          }
        };
        
        return true;
      } catch (error) {
        widgetLog(`Error connecting to WebSocket: ${error}`, 'error');
        isReconnecting = false;
        loaderModal.classList.remove('active');
        
        // Увеличиваем счетчик попыток и проверяем максимальное количество
        reconnectAttempts++;
        
        const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
        
        if (reconnectAttempts >= maxAttempts) {
          connectionFailedPermanently = true;
          if (isWidgetOpen) {
            showConnectionError("Не удалось подключиться к серверу. Пожалуйста, попробуйте позже.");
            updateConnectionStatus('disconnected', 'Отключено');
          }
        } else {
          // Экспоненциальная задержка перед повторной попыткой
          reconnectWithDelay();
        }
        
        return false;
      }
    }

    // Добавляем обработчики событий для интерфейса
    widgetButton.addEventListener('click', function(e) {
      widgetLog('Button clicked');
      e.preventDefault();
      e.stopPropagation();
      openWidget();
    });

    widgetClose.addEventListener('click', function(e) {
      widgetLog('Close button clicked');
      e.preventDefault();
      e.stopPropagation();
      closeWidget();
    });
    
    // Обработчик для основного круга (для запуска распознавания голоса)
    mainCircle.addEventListener('click', function() {
      widgetLog(`Circle clicked: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
      
      // На iOS этот клик также поможет инициализировать аудио-контекст
      if (isIOS) {
        unlockAudioOnIOS().then(unlocked => {
          if (unlocked) {
            widgetLog('Audio context successfully unlocked via circle click');
            
            if (iosAudioButton) {
              iosAudioButton.classList.remove('visible');
            }
            
            if (isWidgetOpen && !isListening && !isReconnecting) {
              if (isConnected) {
                startListening();
              } else if (connectionFailedPermanently) {
                showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
              } else {
                // Пытаемся переподключиться
                connectWebSocket();
              }
            }
          }
        });
      } else {
        if (isWidgetOpen && !isListening && !isReconnecting) {
          if (isConnected) {
            startListening();
          } else if (connectionFailedPermanently) {
            showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
          } else {
            // Пытаемся переподключиться
            connectWebSocket();
          }
        }
      }
    });
    
    // Обработчик для iOS кнопки активации аудио
    if (isIOS && iosAudioButton) {
      iosAudioButton.addEventListener('click', function() {
        unlockAudioOnIOS().then(success => {
          if (success) {
            iosAudioButton.classList.remove('visible');
            
            // Пытаемся начать слушать через небольшую задержку
            setTimeout(() => {
              if (isConnected && !isListening && !isReconnecting) {
                startListening();
              }
            }, 500);
          } else {
            // Если не удалось разблокировать, пробуем более агрессивную разблокировку
            forceIOSAudioUnlock().then(() => {
              iosAudioButton.classList.remove('visible');
              
              setTimeout(() => {
                if (isConnected && !isListening && !isReconnecting) {
                  startListening();
                }
              }, 500);
            });
          }
        });
      });
    }
    
    // Обработчик для кнопки повторного подключения
    if (retryButton) {
      retryButton.addEventListener('click', function() {
        widgetLog('Retry button clicked');
        resetConnection();
      });
    }
    
    // Создаем WebSocket соединение
    connectWebSocket();
    
    // Проверка DOM и состояния после инициализации
    setTimeout(function() {
      widgetLog('DOM check after initialization');
      
      // Проверяем видимость и z-index элементов
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      const widgetExpanded = document.getElementById('wellcomeai-widget-expanded');
      
      if (!widgetContainer) {
        widgetLog('Widget container not found in DOM!', 'error');
      } else {
        widgetLog(`Container z-index = ${getComputedStyle(widgetContainer).zIndex}`);
      }
      
      if (!widgetButton) {
        widgetLog('Button not found in DOM!', 'error');
      } else {
        widgetLog(`Button is visible = ${getComputedStyle(widgetButton).display !== 'none'}`);
      }
      
      if (!widgetExpanded) {
        widgetLog('Expanded widget not found in DOM!', 'error');
      }
      
      // Проверка соединения
      widgetLog(`Connection state = ${websocket ? websocket.readyState : 'No websocket'}`);
      widgetLog(`Status flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}`);
      
      // Для мобильных устройств добавляем проверку аудио состояния
      if (isMobile) {
        widgetLog(`Mobile audio state: initialized=${window.audioContextInitialized}, hasPlayedSilence=${window.hasPlayedSilence}`);
        if (audioContext) {
          widgetLog(`AudioContext state=${audioContext.state}, sampleRate=${audioContext.sampleRate}`);
        }
      }
      
      // Проверка переменных для перебивания
      widgetLog(`[INTERRUPTION] Variables: currentResponseId=${currentResponseId}, samplesPlayedSoFar=${samplesPlayedSoFar}, soundDetectionCounter=${soundDetectionCounter}`);
    }, 2000);
  }

  // Инициализируем виджет
  function initializeWidget() {
    widgetLog('Initializing...');
    
    // Логируем тип устройства
    widgetLog(`Device type: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);
    
    // Загружаем необходимые стили и скрипты
    loadFontAwesome();
    createStyles();
    
    // Создаем HTML структуру виджета
    createWidgetHTML();
    
    // Инициализируем основную логику виджета
    initWidget();
    
    widgetLog('Initialization complete - улучшенное эхо-подавление активировано');
  }
  
  // Проверяем, есть ли уже виджет на странице
  if (!document.getElementById('wellcomeai-widget-container')) {
    widgetLog('Starting initialization process');
    // Если DOM уже загружен, инициализируем сразу
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeWidget);
      widgetLog('Will initialize on DOMContentLoaded');
    } else {
      widgetLog('DOM already loaded, initializing immediately');
      initializeWidget();
    }
  } else {
    widgetLog('Widget already exists on the page, skipping initialization');
  }
})();
