 (function() {
  // Настройки виджета
  const DEBUG_MODE = true; // Установите false для продакшена
  const MAX_RECONNECT_ATTEMPTS = 5;
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10;
  const PING_INTERVAL = 15000; // 15 секунд
  const MOBILE_PING_INTERVAL = 10000; // 10 секунд для мобильных
  const CONNECTION_TIMEOUT = 20000; // 20 секунд
  const MAX_DEBUG_ITEMS = 20; // Увеличено для лучшей отладки

  // Глобальное хранение состояния
  let reconnectAttempts = 0;
  let pingIntervalId = null; // Переименовано для ясности, будет использоваться для setInterval ID
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  
  // Определяем тип устройства
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  // Упрощенные глобальные флаги - только необходимые
  window.audioInitialized = false;     // Единый флаг инициализации
  window.globalAudioContext = null;    // Глобальный AudioContext
  window.globalMicStream = null;       // Глобальный поток микрофона
  window.audioPlaybackUnlocked = false; // Флаг разблокировки воспроизведения

  // Функция для логирования
  const widgetLog = (message, type = 'info') => {
    const logPrefix = '[WellcomeAI Widget]';
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
      console.log(`${logPrefix} ${formattedMessage}`);
    } else if (DEBUG_MODE || type === 'error' || type === 'warn') { // Всегда логируем ошибки и предупреждения
      if (type === 'error') {
        console.error(`${logPrefix} ERROR:`, message);
      } else if (type === 'warn') {
        console.warn(`${logPrefix} WARNING:`, message);
      } else if (DEBUG_MODE) {
        console.log(`${logPrefix}`, message);
      }
    }
    // Добавляем в отладочную очередь, если DEBUG_MODE включен
    if (DEBUG_MODE) {
        addToDebugQueue(String(message), type);
    }
  };

  // Функция для отслеживания ошибок
  const addToDebugQueue = (message, type = 'info') => {
    // Не добавляем если DEBUG_MODE выключен, кроме ошибок
    if (!DEBUG_MODE && type !== 'error') return;
    
    const timestamp = new Date().toISOString();
    debugQueue.push({ timestamp, message, type });
    
    if (debugQueue.length > MAX_DEBUG_ITEMS) {
      debugQueue.shift();
    }
    updateDebugPanel(); // Обновляем панель при добавлении
  };

  // Получить отладочную информацию
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp.slice(11,23)}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  // Обновление отладочной панели (если она есть)
  const updateDebugPanel = () => {
    if (!DEBUG_MODE) return;
    const debugPanel = document.getElementById('wellcomeai-debug-panel-content');
    if (debugPanel) {
      debugPanel.textContent = getDebugInfo();
      debugPanel.scrollTop = debugPanel.scrollHeight; // Автопрокрутка вниз
    }
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
      if (src && (src.includes('widget.js') || src.includes('wellcomeai-widget.min.js') || src.includes('wellcomeai-loader.js'))) {
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
      // Если URL не содержит протокол, но не начинается с // (чтобы не ломать //domain.com)
      if (!serverUrl.startsWith('//')) {
        serverUrl = window.location.protocol + '//' + serverUrl;
        widgetLog(`Added protocol to server URL: ${serverUrl}`);
      } else {
         serverUrl = window.location.protocol + serverUrl; // для //domain.com
         widgetLog(`Added protocol to server URL: ${serverUrl}`);
      }
    }
    
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com'; // Запасной URL
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }
    
    return serverUrl.replace(/\/$/, ''); // Удаляем слэш в конце, если есть
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      const idAttr = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid');
      if (idAttr) {
        widgetLog(`Found assistant ID from attribute: ${idAttr}`);
        return idAttr;
      }
      
      if (scriptTags[i].dataset) {
        const idDataset = scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid;
        if (idDataset) {
            widgetLog(`Found assistant ID from dataset: ${idDataset}`);
            return idDataset;
        }
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
    
    // Пример для демо-страницы, можно убрать или изменить
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo'; // Замените на реальный ID для демо или удалите
    }
    
    widgetLog('No assistant ID found. Widget may not function correctly.', 'error');
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
      const posAttr = scriptTags[i].getAttribute('data-position');
      if (posAttr) {
        return parsePosition(posAttr);
      }
      
      if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
        return parsePosition(scriptTags[i].dataset.position);
      }
    }

    return defaultPosition;

    function parsePosition(positionString) {
      const position = { ...defaultPosition };
      if (!positionString || typeof positionString !== 'string') return position;
      
      const parts = positionString.toLowerCase().split('-');
      if (parts.length === 2) {
        const p1 = parts[0].trim();
        const p2 = parts[1].trim();

        if ((p1 === 'top' || p1 === 'bottom') && (p2 === 'left' || p2 === 'right')) {
          position.vertical = p1;
          position.horizontal = p2;
        } else if ((p2 === 'top' || p2 === 'bottom') && (p1 === 'left' || p1 === 'right')) {
          position.vertical = p2;
          position.horizontal = p1;
        } else {
            widgetLog(`Invalid position string: ${positionString}. Using default.`, 'warn');
        }
      } else {
         widgetLog(`Invalid position string format: ${positionString}. Using default.`, 'warn');
      }
      return position;
    }
  };

  // Определяем URL сервера и ID ассистента
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  
  // Формируем WebSocket URL с указанием ID ассистента
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + (ASSISTANT_ID || 'default'); // Используем 'default' если ID не найден
  
  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isAndroid ? 'Android' : (isMobile ? 'Mobile' : 'Desktop'))}`);

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
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
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
        z-index: 1; /* Относительно .wellcomeai-widget-container */
        border: none;
        outline: none;
        opacity: 0; /* Начальная непрозрачность, чтобы избежать мерцания */
        visibility: hidden;
        pointer-events: none;
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
        ${WIDGET_POSITION.vertical === 'bottom' ? 'bottom: 0;' : 'top: 0;'}
        ${WIDGET_POSITION.horizontal === 'right' ? 'right: 0;' : 'left: 0;'}
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
        z-index: 0; /* Ниже кнопки, когда свернут */
      }
      
      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 400px; /* Или calc(100vh - 40px - ${WIDGET_POSITION.distance} * 2) для адаптивной высоты */
        opacity: 1;
        pointer-events: all;
        z-index: 2; /* Выше кнопки, когда развернут */
      }

      @media (max-height: 450px) {
        .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
          height: calc(100vh - ${WIDGET_POSITION.distance} - 80px); /* 80px - примерная высота кнопки + отступы */
        }
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
        flex-shrink: 0; /* Предотвращает сжатие хедера */
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
        padding: 5px; /* Увеличиваем область клика */
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
        overflow-y: auto; /* Для случаев, когда контент не помещается */
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
        cursor: pointer; /* Делаем круг кликабельным */
        flex-shrink: 0; /* Предотвращает сжатие круга */
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
        background: linear-gradient(135deg, #ffffff, #fff3e0, #ff9800);
        box-shadow: 0 0 30px rgba(255, 152, 0, 0.6);
      }
      
      .wellcomeai-main-circle.interrupted::before {
        animation: wellcomeai-wave 2s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(255, 152, 0, 0.3));
      }
      
      .wellcomeai-mic-icon {
        color: #4a86e8;
        font-size: 32px;
        z-index: 10; /* Выше анимаций */
      }
      
      .wellcomeai-main-circle.listening .wellcomeai-mic-icon {
        color: #2196f3;
      }
      
      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon {
        color: #4caf50;
      }
      
      .wellcomeai-main-circle.interrupted .wellcomeai-mic-icon {
        color: #ff9800;
      }
      
      .wellcomeai-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px;
        bottom: -5px; /* Чуть ниже центра круга */
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
        background-color: rgba(255, 255, 255, 0.85); /* Немного плотнее */
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 3; /* Выше контента, но ниже хедера если нужно перекрыть всё */
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.3s, visibility 0.3s;
        border-radius: 0 0 20px 20px; /* Только нижние углы если внутри expanded */
      }
      
      .wellcomeai-widget-expanded .wellcomeai-loader-modal { /* Если лоадер внутри expanded */
        border-radius: 0 0 20px 20px;
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
        width: calc(100% - 40px); /* Адаптивная ширина */
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
        visibility: hidden; /* Для корректной анимации */
        transition: opacity 0.3s, visibility 0.3s, transform 0.3s;
        max-height: 100px;
        overflow-y: auto;
        z-index: 10; /* Выше круга */
      }
      
      .wellcomeai-message-display.show {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0);
      }
       .wellcomeai-message-display:not(.show) {
        transform: translateX(-50%) translateY(10px); /* Начальное смещение для анимации */
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
        color: #ef4444; /* Tailwind red-500 */
        background-color: rgba(254, 226, 226, 0.9); /* Tailwind red-100 with opacity */
        border: 1px solid #f87171; /* Tailwind red-400 */
        padding: 10px 15px; /* Увеличиваем паддинги */
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        margin-top: 15px; /* Больше отступ */
        text-align: center;
        display: none; /* Начальное состояние */
        width: calc(100% - 40px); /* Адаптивная ширина */
        box-sizing: border-box;
      }
      
      .wellcomeai-connection-error.visible {
        display: block;
      }

      .wellcomeai-retry-button {
        background-color: #ef4444; /* Tailwind red-500 */
        color: white;
        border: none;
        border-radius: 6px; /* Более скругленные углы */
        padding: 6px 12px; /* Увеличиваем паддинги */
        font-size: 13px; /* Немного больше */
        font-weight: 500; /* Полужирный */
        cursor: pointer;
        margin-top: 10px; /* Больше отступ */
        transition: background-color 0.2s, transform 0.1s;
      }
      
      .wellcomeai-retry-button:hover {
        background-color: #dc2626; /* Tailwind red-600 */
      }
      .wellcomeai-retry-button:active {
        transform: scale(0.98);
      }
      
      .wellcomeai-status-indicator {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 11px;
        color: #64748b; /* Tailwind slate-500 */
        padding: 4px 10px; /* Немного шире */
        border-radius: 12px; /* Более скругленный */
        background-color: rgba(226, 232, 240, 0.8); /* Tailwind slate-200 с прозрачностью */
        display: flex;
        align-items: center;
        gap: 6px; /* Больше расстояние */
        opacity: 0;
        transition: opacity 0.3s;
        z-index: 5; /* Выше контента, но ниже сообщений */
      }
      
      .wellcomeai-status-indicator.show {
        opacity: 0.9; /* Немного прозрачнее для лучшего вида */
      }
      
      .wellcomeai-status-dot {
        width: 8px; /* Больше точка */
        height: 8px;
        border-radius: 50%;
        background-color: #10b981; /* Tailwind green-500 */
        transition: background-color 0.3s;
      }
      
      .wellcomeai-status-dot.disconnected {
        background-color: #ef4444; /* Tailwind red-500 */
      }
      
      .wellcomeai-status-dot.connecting {
        background-color: #f59e0b; /* Tailwind amber-500 */
        animation: wellcomeai-connecting-pulse 1.5s infinite ease-in-out;
      }

      @keyframes wellcomeai-connecting-pulse {
        0% { opacity: 1; }
        50% { opacity: 0.5; }
        100% { opacity: 1; }
      }
      
      .wellcomeai-status-dot.interrupted {
        background-color: #ff9800; /* Яркий оранжевый, как в .interrupted круге */
      }
      
      .wellcomeai-mobile-audio-button {
        position: absolute;
        bottom: 70px; /* Выше, чтобы не перекрывать статус или сообщения */
        left: 50%;
        transform: translateX(-50%);
        background-color: #4a86e8;
        color: white;
        border: none;
        border-radius: 15px;
        padding: 12px 24px; /* Больше кнопка */
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        display: none; /* Начальное состояние */
        z-index: 100; /* Очень высокий z-index */
        box-shadow: 0 4px 15px rgba(74, 134, 232, 0.3);
        transition: background-color 0.2s ease, box-shadow 0.2s ease, transform 0.1s ease;
      }

      .wellcomeai-mobile-audio-button.visible {
        display: block;
      }

      .wellcomeai-mobile-audio-button:active {
        transform: translateX(-50%) scale(0.95);
      }

      .wellcomeai-mobile-audio-button:hover {
        background-color: #3d71c7;
        box-shadow: 0 6px 20px rgba(74, 134, 232, 0.4);
      }

      /* Стили для отладочной панели */
      .wellcomeai-debug-panel {
        position: fixed;
        bottom: ${parseInt(WIDGET_POSITION.distance, 10) + 70}px; /* Над кнопкой виджета */
        ${WIDGET_POSITION.horizontal}: ${WIDGET_POSITION.distance};
        width: 300px;
        max-height: 200px;
        background-color: rgba(0,0,0,0.7);
        color: #0f0;
        font-family: monospace;
        font-size: 10px;
        border-radius: 5px;
        padding: 5px;
        z-index: 2147483640; /* Чуть ниже виджета */
        overflow: hidden; /* Чтобы скрыть скроллбар, если текст не влезает */
        display: flex;
        flex-direction: column;
        border: 1px solid #333;
      }
      .wellcomeai-debug-panel-header {
        padding-bottom: 3px;
        border-bottom: 1px solid #555;
        margin-bottom: 3px;
        color: #fff;
        font-weight: bold;
      }
      .wellcomeai-debug-panel-content {
        flex-grow: 1;
        overflow-y: auto; /* Скролл для контента */
        white-space: pre-wrap; /* Перенос строк */
        word-break: break-all; /* Перенос длинных слов */
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
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'; // Обновленная версия
      link.integrity = 'sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA=='; // SRI для безопасности
      link.crossOrigin = 'anonymous';
      link.referrerPolicy = 'no-referrer';
      document.head.appendChild(link);
      widgetLog("Font Awesome loaded");
    }
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    // z-index уже в CSS

    let widgetHTML = `
      <!-- Кнопка (минимизированное состояние) -->
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button">
        <i class="fas fa-headset wellcomeai-widget-icon"></i> <!-- Изменена иконка на наушники -->
      </div>
      
      <!-- Развернутый виджет -->
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">WellcomeAI Ассистент</div> <!-- Изменен заголовок -->
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close" aria-label="Закрыть виджет">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <!-- Основной элемент - круг с иконкой микрофона -->
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle" role="button" aria-label="Активировать микрофон">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>
            
            <!-- Аудио визуализация -->
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>
          
          <!-- Сообщение -->
          <div class="wellcomeai-message-display" id="wellcomeai-message-display" aria-live="polite"></div>
          
          <!-- Универсальная кнопка для активации аудио на мобильных -->
          <button class="wellcomeai-mobile-audio-button" id="wellcomeai-mobile-audio-button" style="display: none;">
            🎤 Включить микрофон и звук
          </button>
          
          <!-- Сообщение об ошибке соединения -->
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error" role="alert">
            Ошибка соединения с сервером
            <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
              Повторить
            </button>
          </div>
          
          <!-- Индикатор статуса -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator" aria-live="polite">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Подключено</span>
          </div>
        </div>
        <!-- Модальное окно загрузки (теперь внутри expanded, чтобы быть под хедером) -->
        <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal">
          <div class="wellcomeai-loader"></div>
        </div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);

    // Создание отладочной панели, если DEBUG_MODE включен
    if (DEBUG_MODE) {
      const debugPanelEl = document.createElement('div');
      debugPanelEl.className = 'wellcomeai-debug-panel';
      debugPanelEl.id = 'wellcomeai-debug-panel';
      debugPanelEl.innerHTML = `
        <div class="wellcomeai-debug-panel-header">DEBUG LOG</div>
        <div class="wellcomeai-debug-panel-content" id="wellcomeai-debug-panel-content"></div>
      `;
      document.body.appendChild(debugPanelEl);
      updateDebugPanel(); // Обновить сразу после создания
    }


    widgetLog("HTML structure created and appended to body");
    
    // Делаем кнопку виджета видимой после создания HTML
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    if (widgetButton) {
      // Небольшая задержка для CSS transition
      setTimeout(() => {
        widgetButton.style.opacity = '1';
        widgetButton.style.visibility = 'visible';
        widgetButton.style.pointerEvents = 'auto';
      }, 100);
    }
  }

  // НОВАЯ функция для тестирования HTML5 Audio воспроизведения
  async function testAudioPlayback() {
    return new Promise((resolve) => {
      if (!window.globalAudioContext) {
        widgetLog('[AUDIO TEST] AudioContext не инициализирован, тест невозможен', 'warn');
        resolve(false);
        return;
      }
      try {
        // Создаем короткий тестовый аудио файл (тишина)
        const audioContext = window.globalAudioContext;
        const buffer = audioContext.createBuffer(1, Math.floor(audioContext.sampleRate * 0.02), audioContext.sampleRate); // 20ms тишины
        
        const wavBuffer = createWavFromPcm(buffer.getChannelData(0).buffer, audioContext.sampleRate);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const testUrl = URL.createObjectURL(blob);
        
        const testAudio = new Audio();
        testAudio.src = testUrl;
        testAudio.volume = 0.01; 
        testAudio.preload = 'auto';
        testAudio.playsInline = true; 
        
        const timeout = setTimeout(() => {
          URL.revokeObjectURL(testUrl);
          widgetLog('[AUDIO TEST] Тест воспроизведения: таймаут', 'warn');
          resolve(false);
        }, 1000); // Уменьшен таймаут
        
        const playHandler = () => {
            clearTimeout(timeout);
            URL.revokeObjectURL(testUrl);
            // Удаляем обработчики, чтобы избежать утечек
            testAudio.removeEventListener('canplaythrough', canPlayThroughHandler);
            testAudio.removeEventListener('error', errorHandler);
            widgetLog('[AUDIO TEST] Тест воспроизведения успешен');
            resolve(true);
        };

        const errorHandler = (error) => {
            clearTimeout(timeout);
            URL.revokeObjectURL(testUrl);
            testAudio.removeEventListener('canplaythrough', canPlayThroughHandler);
            testAudio.removeEventListener('error', errorHandler);
            widgetLog(`[AUDIO TEST] Тест воспроизведения неудачен: ${error.type || error.message || 'Unknown error'}`, 'warn');
            resolve(false);
        };
        
        const canPlayThroughHandler = () => {
          const playPromise = testAudio.play();
          if (playPromise !== undefined) {
            playPromise.then(playHandler).catch(errorHandler);
          } else {
            // Для старых браузеров без Promise, считаем, что play() синхронный
            // Но это очень редкий случай для современных браузеров
             playHandler();
          }
        };
        
        testAudio.addEventListener('canplaythrough', canPlayThroughHandler, { once: true });
        testAudio.addEventListener('error', errorHandler, { once: true });
        
        testAudio.load(); // Начинаем загрузку
        
      } catch (error) {
        widgetLog(`[AUDIO TEST] Ошибка теста воспроизведения: ${error.message}`, 'warn');
        resolve(false);
      }
    });
  }


  // УНИФИЦИРОВАННАЯ ИНИЦИАЛИЗАЦИЯ АУДИО - одинаково для всех устройств
  async function initializeAudio() {
    widgetLog(`[AUDIO] Начало единой инициализации для ${isIOS ? 'iOS' : (isAndroid ? 'Android' : (isMobile ? 'Mobile' : 'Desktop'))}`);
    
    // Если уже инициализировано, выходим
    if (window.audioInitialized && window.globalAudioContext && window.globalMicStream) {
        widgetLog('[AUDIO] Аудио уже инициализировано.', 'info');
        if (window.globalAudioContext.state === 'suspended') {
            try {
                await window.globalAudioContext.resume();
                widgetLog('[AUDIO] AudioContext успешно возобновлен.');
            } catch (e) {
                widgetLog(`[AUDIO] Ошибка возобновления AudioContext: ${e.message}`, 'error');
                return false;
            }
        }
        return true;
    }

    try {
      // 1. Создаем ЕДИНЫЙ AudioContext для всех устройств
      if (!window.globalAudioContext || window.globalAudioContext.state === 'closed') {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error("AudioContext не поддерживается браузером");
        }
        
        const contextOptions = {
          sampleRate: 24000, // Стандартная частота для большинства задач
          latencyHint: isMobile ? 'interactive' : 'balanced' // Разная подсказка задержки
        };
        
        window.globalAudioContext = new AudioContextClass(contextOptions);
        widgetLog(`[AUDIO] AudioContext создан/пересоздан с частотой ${window.globalAudioContext.sampleRate} Гц, latencyHint: ${contextOptions.latencyHint}`);

        // Обработчик изменения состояния AudioContext (например, если он был приостановлен системой)
        window.globalAudioContext.onstatechange = () => {
            widgetLog(`[AUDIO] AudioContext state changed to: ${window.globalAudioContext.state}`);
            if (window.globalAudioContext.state === 'interrupted' || window.globalAudioContext.state === 'suspended') {
                // Попытка возобновить, если виджет открыт
                if (document.getElementById('wellcomeai-widget-container')?.classList.contains('active')) {
                    window.globalAudioContext.resume().then(() => {
                        widgetLog('[AUDIO] AudioContext возобновлен после прерывания/приостановки.');
                    }).catch(e => widgetLog(`[AUDIO] Не удалось возобновить AudioContext: ${e.message}`, 'warn'));
                }
            }
        };
      }

      // 2. Активируем AudioContext если приостановлен (часто на мобильных до взаимодействия)
      if (window.globalAudioContext.state === 'suspended') {
        await window.globalAudioContext.resume();
        widgetLog('[AUDIO] AudioContext активирован из состояния suspended');
      }

      // 3. Проверяем поддержку getUserMedia
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Браузер не поддерживает доступ к микрофону (getUserMedia)");
      }
      
      // 4. Получаем доступ к микрофону с едиными настройками
      // Пересоздаем поток только если его нет или он неактивен
      if (!window.globalMicStream || !window.globalMicStream.active) {
        if (window.globalMicStream && !window.globalMicStream.active) {
            widgetLog('[AUDIO] Существующий поток микрофона неактивен, запрашиваем новый.');
        }
        const constraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: { ideal: 24000 }, // Предпочтительная частота
            channelCount: 1
          }
        };

        if (isIOS) {
          // Для iOS может потребоваться более низкая задержка, но это может повлиять на качество
          // constraints.audio.latency = 0.02; // Пример, требует тестирования
        }

        window.globalMicStream = await navigator.mediaDevices.getUserMedia(constraints);
        widgetLog(`[AUDIO] Микрофон активирован. Треки: ${window.globalMicStream.getAudioTracks().length}`);

        // Обработчик закрытия потока
        window.globalMicStream.getAudioTracks().forEach(track => {
          widgetLog(`[AUDIO] Аудио трек: ${track.label}, настройки: ${JSON.stringify(track.getSettings())}`);
          track.onended = () => {
            widgetLog('[AUDIO] Поток микрофона завершен (трек ended)');
            // Не обнуляем globalMicStream здесь, чтобы можно было проверить его состояние
            // Очистка произойдет при следующем запросе, если !active
          };
          track.onmute = () => widgetLog('[AUDIO] Трек микрофона заглушен (mute)');
          track.onunmute = () => widgetLog('[AUDIO] Трек микрофона разглушен (unmute)');
        });
      }


      // 5. Для мобильных устройств - дополнительная разблокировка AudioContext воспроизведением тишины.
      // Это может помочь на некоторых устройствах, особенно если воспроизведение идет через Audio API, а не HTML5 Audio.
      if (isMobile && window.globalAudioContext.state !== 'running') {
        const buffer = window.globalAudioContext.createBuffer(1, 1, window.globalAudioContext.sampleRate);
        const source = window.globalAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(window.globalAudioContext.destination);
        source.start(0);
        // Дожидаемся окончания воспроизведения тишины
        await new Promise(resolve => source.onended = resolve);
        widgetLog('[AUDIO] Тишина воспроизведена для попытки разблокировки AudioContext на мобильном.');
      }

      // 6. Тестируем HTML5 Audio воспроизведение, если еще не разблокировано
      if (!window.audioPlaybackUnlocked) {
        widgetLog('[AUDIO] Тестируем HTML5 Audio воспроизведение для разблокировки...');
        const unlocked = await testAudioPlayback();
        if (unlocked) {
            window.audioPlaybackUnlocked = true;
            widgetLog('[AUDIO] HTML5 Audio разблокировано успешно через тест.');
        } else {
            widgetLog('[AUDIO] HTML5 Audio НЕ разблокировано через тест. Может потребоваться взаимодействие.', 'warn');
            // Не ошибка, просто информирование. Кнопка разблокировки появится при необходимости.
        }
      }


      // 7. Устанавливаем флаг успешной инициализации
      window.audioInitialized = true;
      widgetLog('[AUDIO] Единая инициализация завершена успешно');
      
      return true;

    } catch (error) {
      widgetLog(`[AUDIO] Ошибка инициализации: ${error.message || error}`, 'error');
      // Попытка очистить ресурсы в случае ошибки
      if (window.globalAudioContext && window.globalAudioContext.state !== 'closed') {
        window.globalAudioContext.close().catch(e => widgetLog(`[AUDIO] Ошибка закрытия AudioContext при ошибке инициализации: ${e.message}`, 'warn'));
        window.globalAudioContext = null;
      }
      if (window.globalMicStream) {
        window.globalMicStream.getTracks().forEach(track => track.stop());
        window.globalMicStream = null;
      }
      window.audioInitialized = false; // Сбрасываем флаг
      return false;
    }
  }


  // ФАБРИЧНАЯ функция для создания cleanupAudio с правильным контекстом
  function createCleanupAudio(interruptionStateRef) { // Принимаем ссылку на объект состояния
    return function cleanupAudio(audioUrl, audio) {
      if (audioUrl && audioUrl.startsWith('blob:')) { // Проверяем, что это blob URL
        URL.revokeObjectURL(audioUrl);
        // widgetLog(`[AUDIO] Отозван Object URL: ${audioUrl}`);
      }
      
      // Используем переданную ссылку на interruptionState
      if (audio && interruptionStateRef && interruptionStateRef.current_audio_elements) {
        const index = interruptionStateRef.current_audio_elements.indexOf(audio);
        if (index > -1) {
          interruptionStateRef.current_audio_elements.splice(index, 1);
        }
      }
    };
  }


  // НОВАЯ функция для показа кнопки разблокировки воспроизведения
  function showAudioUnlockButton(audioUrl, audio, cleanupCurrentAudioFn, playNextAudioFn, interruptionStateRef) {
    const mobileAudioButton = document.getElementById('wellcomeai-mobile-audio-button');
    const messageDisplay = document.getElementById('wellcomeai-message-display');
    
    if (mobileAudioButton) {
      mobileAudioButton.textContent = '🔊 Включить звук';
      mobileAudioButton.classList.add('visible');
      
      if (messageDisplay) {
        messageDisplay.textContent = "Нажмите, чтобы ассистент мог говорить";
        messageDisplay.classList.add('show');
      }
      
      // Удаляем предыдущие обработчики, чтобы избежать многократных вызовов
      const newButton = mobileAudioButton.cloneNode(true);
      mobileAudioButton.parentNode.replaceChild(newButton, mobileAudioButton);
      
      newButton.onclick = async function() {
        widgetLog('[AUDIO] Попытка разблокировки воспроизведения через кнопку');
        newButton.disabled = true; // Предотвращаем двойные клики
        newButton.textContent = '🔊 Включаем...';

        try {
          // 1. Убедимся, что AudioContext активен
          if (window.globalAudioContext && window.globalAudioContext.state === 'suspended') {
            await window.globalAudioContext.resume();
            widgetLog('[AUDIO] AudioContext возобновлен по клику на кнопку.');
          }

          // 2. Пробуем воспроизвести тестовое короткое аудио для полной разблокировки
          // Используем очень короткий звук, чтобы было незаметно
          const unlockAudio = new Audio('data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAAA'); // 1ms тишины 44.1kHz
          unlockAudio.volume = 0.01;
          unlockAudio.playsInline = true;
          await unlockAudio.play(); // Ждем завершения промиса
          widgetLog('[AUDIO] Тестовое аудио для разблокировки воспроизведено.');

          // 3. Отмечаем, что воспроизведение разблокировано
          window.audioPlaybackUnlocked = true;
          
          // 4. Скрываем кнопку и сообщение
          newButton.classList.remove('visible');
          if (messageDisplay) {
            messageDisplay.classList.remove('show');
          }
          
          widgetLog('[AUDIO] Воспроизведение успешно разблокировано.');

          // 5. Теперь пытаемся воспроизвести оригинальное аудио, которое не удалось
          // Если оригинальное аудио еще существует и его URL валиден
          if (audio && audio.src && audio.src === audioUrl) {
             widgetLog('[AUDIO] Повторная попытка воспроизведения оригинального аудио.');
             await audio.play(); // audio уже должен быть загружен и иметь onended/onerror
          } else {
             // Если оригинальное аудио уже очищено или URL не совпадает, просто запускаем следующее
             widgetLog('[AUDIO] Оригинальное аудио недействительно, запускаем следующее из очереди.');
             cleanupCurrentAudioFn(audioUrl, audio); // Очищаем старое, если нужно
             playNextAudioFn(); // Запускаем следующее
          }

        } catch (error) {
          widgetLog(`[AUDIO] Не удалось разблокировать/воспроизвести: ${error.message}`, 'error');
          if (messageDisplay) {
            messageDisplay.textContent = "Не удалось включить звук. Проверьте настройки.";
            setTimeout(() => {
              if (messageDisplay.textContent === "Не удалось включить звук. Проверьте настройки.") {
                 messageDisplay.classList.remove('show');
              }
            }, 3000);
          }
          // Очищаем текущее аудио и переходим к следующему, если не удалось
          cleanupCurrentAudioFn(audioUrl, audio);
          playNextAudioFn();
        } finally {
            newButton.disabled = false; // Возвращаем кликабельность кнопке
            // Текст кнопки может быть восстановлен или скрыт в зависимости от успеха
             if(!newButton.classList.contains('visible')) {
                newButton.textContent = '🔊 Включить звук'; // Восстанавливаем текст, если кнопка осталась видимой (маловероятно)
            }
        }
      };
    } else {
        widgetLog('[AUDIO] Кнопка разблокировки звука не найдена', 'warn');
        // Если кнопки нет, просто очищаем и идем дальше
        cleanupCurrentAudioFn(audioUrl, audio);
        playNextAudioFn();
    }
  }


  // Создаём простой WAV из PCM данных (float32)
  function createWavFromPcm(float32PcmData, sampleRate = 24000) {
    const numSamples = float32PcmData.length;
    const pcm16Data = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm16Data[i] = Math.max(-32768, Math.min(32767, float32PcmData[i] * 32767));
    }
    const pcmBuffer = pcm16Data.buffer;

    const wavHeader = new ArrayBuffer(44);
    const view = new DataView(wavHeader);
    const numChannels = 1;
    const bytesPerSample = 2; // 16-bit
    
    // RIFF chunk descriptor
    view.setUint8(0, 'R'.charCodeAt(0)); view.setUint8(1, 'I'.charCodeAt(0));
    view.setUint8(2, 'F'.charCodeAt(0)); view.setUint8(3, 'F'.charCodeAt(0));
    view.setUint32(4, 36 + pcmBuffer.byteLength, true); // ChunkSize
    // WAVE format
    view.setUint8(8, 'W'.charCodeAt(0)); view.setUint8(9, 'A'.charCodeAt(0));
    view.setUint8(10, 'V'.charCodeAt(0)); view.setUint8(11, 'E'.charCodeAt(0));
    // fmt sub-chunk
    view.setUint8(12, 'f'.charCodeAt(0)); view.setUint8(13, 'm'.charCodeAt(0));
    view.setUint8(14, 't'.charCodeAt(0)); view.setUint8(15, ' '.charCodeAt(0)); // Subchunk1ID
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
    view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    // data sub-chunk
    view.setUint8(36, 'd'.charCodeAt(0)); view.setUint8(37, 'a'.charCodeAt(0));
    view.setUint8(38, 't'.charCodeAt(0)); view.setUint8(39, 'a'.charCodeAt(0)); // Subchunk2ID
    view.setUint32(40, pcmBuffer.byteLength, true); // Subchunk2Size
    
    const wavBytes = new Uint8Array(wavHeader.byteLength + pcmBuffer.byteLength);
    wavBytes.set(new Uint8Array(wavHeader), 0);
    wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
    
    return wavBytes.buffer;
  }


  // ФАБРИЧНАЯ функция для создания playNextAudio с правильным контекстом
  // Принимает ссылки на переменные, которые могут изменяться (объекты или функции, возвращающие значения)
  function createPlayNextAudio(
      interruptionStateRef, // Ссылка на объект interruptionState
      audioPlaybackQueueRef, // Ссылка на массив очереди
      uiElements, // Объект с UI элементами
      getIsWidgetOpenFn, // Функция, возвращающая актуальное isWidgetOpen
      startListeningFn // Функция для начала прослушивания
    ) {
    
    // Внутренняя переменная для отслеживания текущего активного аудио элемента
    // чтобы избежать многократных вызовов playNextAudio при ошибках или быстрой смене состояний
    let currentlyPlayingAudio = null; 

    return function playNextAudio() {
      // Если уже есть активное аудио, которое пытается воспроизвестись, не запускаем новое
      if (currentlyPlayingAudio && !currentlyPlayingAudio.ended && !currentlyPlayingAudio.error && !currentlyPlayingAudio.paused) {
          // widgetLog('[AUDIO PLAY] Попытка запустить новое аудио, пока предыдущее еще обрабатывается. Игнорируется.', 'debug');
          return;
      }
      currentlyPlayingAudio = null; // Сбрасываем, если предыдущее завершилось или было ошибкой

      if (audioPlaybackQueueRef.length === 0) {
        window.isPlayingAudio = false;
        interruptionStateRef.is_assistant_speaking = false;
        uiElements.mainCircle.classList.remove('speaking');
        
        if (!getIsWidgetOpenFn()) {
          uiElements.widgetButton.classList.add('wellcomeai-pulse-animation');
        } else {
          uiElements.widgetButton.classList.remove('wellcomeai-pulse-animation');
        }
        
        // После воспроизведения, если виджет открыт, возобновляем прослушивание
        if (getIsWidgetOpenFn() && document.getElementById('wellcomeai-widget-container').classList.contains('active')) {
          // widgetLog('[AUDIO PLAY] Очередь пуста, виджет открыт, возобновляем прослушивание.');
          // Небольшая задержка перед стартом прослушивания, чтобы избежать наложений
          setTimeout(() => {
            if (getIsWidgetOpenFn() && !window.isPlayingAudio) { // Дополнительная проверка
                startListeningFn();
            }
          }, 300); 
        } else {
            // widgetLog('[AUDIO PLAY] Очередь пуста, виджет закрыт или неактивен, прослушивание не возобновляется.');
        }
        return;
      }
      
      window.isPlayingAudio = true;
      interruptionStateRef.is_assistant_speaking = true;
      uiElements.mainCircle.classList.remove('listening', 'interrupted');
      uiElements.mainCircle.classList.add('speaking');
      uiElements.widgetButton.classList.remove('wellcomeai-pulse-animation'); // Убираем пульсацию, когда ассистент говорит
      
      const audioBase64 = audioPlaybackQueueRef.shift();
      let audioUrl = null; // Объявляем здесь для доступа в блоке catch
      let audio = null;    // Объявляем здесь для доступа в блоке catch

      // Создаем cleanup функцию с правильным контекстом для текущего аудио
      const cleanupCurrentAudio = createCleanupAudio(interruptionStateRef);
      
      try {
        const audioDataArrayBuffer = base64ToArrayBuffer(audioBase64);
        if (audioDataArrayBuffer.byteLength === 0) {
          widgetLog('[AUDIO PLAY] Пустой аудиобуфер получен, пропускаем.', 'warn');
          playNextAudio(); // Рекурсивный вызов для следующего элемента
          return;
        }

        // Преобразуем Float32 PCM (если это он) в WAV
        // Предполагаем, что с сервера приходит Float32 PCM
        const float32PcmData = new Float32Array(audioDataArrayBuffer);
        const wavBuffer = createWavFromPcm(float32PcmData, window.globalAudioContext ? window.globalAudioContext.sampleRate : 24000);
        
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        audioUrl = URL.createObjectURL(blob);
        
        audio = new Audio();
        audio.src = audioUrl;
        currentlyPlayingAudio = audio; // Устанавливаем текущее аудио
        
        interruptionStateRef.current_audio_elements.push(audio);
        
        audio.preload = 'auto';
        audio.volume = 1.0;
        audio.playsInline = true;
        audio.muted = false; // Убедимся, что не заглушено
        
        const playAttempt = () => {
            if (!interruptionStateRef.is_assistant_speaking || !window.isPlayingAudio) {
                widgetLog('[AUDIO PLAY] Воспроизведение отменено до начала (is_assistant_speaking=false или isPlayingAudio=false).', 'info');
                cleanupCurrentAudio(audioUrl, audio);
                currentlyPlayingAudio = null;
                playNextAudio();
                return;
            }

            widgetLog(`[AUDIO PLAY] Попытка воспроизведения аудио: ${audioUrl.substring(audioUrl.length - 10)}`);
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
                playPromise
                .then(() => {
                    widgetLog(`[AUDIO PLAY] Аудио (${audioUrl.substring(audioUrl.length - 10)}) воспроизводится успешно.`);
                    if (isMobile && !window.audioPlaybackUnlocked) {
                        window.audioPlaybackUnlocked = true;
                        widgetLog('[AUDIO PLAY] Воспроизведение разблокировано через успешный play().');
                        const mobileAudioBtn = document.getElementById('wellcomeai-mobile-audio-button');
                        if (mobileAudioBtn) mobileAudioBtn.classList.remove('visible');
                        const msgDisplay = document.getElementById('wellcomeai-message-display');
                        if (msgDisplay && msgDisplay.textContent.includes("Нажмите, чтобы ассистент мог говорить")) {
                            msgDisplay.classList.remove('show');
                        }
                    }
                })
                .catch(error => {
                    widgetLog(`[AUDIO PLAY] Ошибка воспроизведения (${audioUrl.substring(audioUrl.length - 10)}): ${error.name} - ${error.message}`, "error");
                    
                    if (isMobile && (error.name === 'NotAllowedError' || error.name === 'AbortError' || error.message.toLowerCase().includes('user gesture'))) {
                        widgetLog('[AUDIO PLAY] Требуется разблокировка воспроизведения для мобильного устройства.');
                        showAudioUnlockButton(audioUrl, audio, cleanupCurrentAudio, playNextAudio, interruptionStateRef);
                        // Не вызываем playNextAudio здесь, т.к. showAudioUnlockButton обработает это
                    } else {
                        // Для других ошибок или не мобильных устройств
                        cleanupCurrentAudio(audioUrl, audio);
                        currentlyPlayingAudio = null;
                        playNextAudio();
                    }
                });
            } else {
                widgetLog('[AUDIO PLAY] Воспроизведение запущено (старый браузер без Promise).');
                // Для старых браузеров, которые не возвращают Promise
                // onended и onerror все еще должны работать
            }
        };

        // Используем oncanplaythrough или loadeddata, чтобы убедиться, что аудио готово
        audio.onloadeddata = () => { // oncanplaythrough может быть слишком долгим на мобильных
            widgetLog(`[AUDIO PLAY] Аудио (${audioUrl.substring(audioUrl.length - 10)}) готово (loadeddata).`);
            playAttempt();
        };
        
        audio.onended = function() {
          widgetLog(`[AUDIO PLAY] Воспроизведение аудио (${audioUrl.substring(audioUrl.length - 10)}) завершено.`);
          cleanupCurrentAudio(audioUrl, audio);
          currentlyPlayingAudio = null;
          playNextAudio();
        };
        
        audio.onerror = function(e) {
          const errorMsg = audio.error ? `${audio.error.code} - ${audio.error.message}` : (e.message || 'Unknown audio element error');
          widgetLog(`[AUDIO PLAY] Ошибка аудио элемента (${audioUrl.substring(audioUrl.length - 10)}): ${errorMsg}`, 'error');
          cleanupCurrentAudio(audioUrl, audio);
          currentlyPlayingAudio = null;
          playNextAudio();
        };
        
        audio.load(); // Начинаем загрузку
        
      } catch (error) {
        widgetLog(`[AUDIO PLAY] Критическая ошибка при подготовке аудио: ${error.message}`, "error");
        if (audioUrl) cleanupCurrentAudio(audioUrl, audio); // Очищаем, если URL был создан
        currentlyPlayingAudio = null;
        playNextAudio(); // Переходим к следующему аудио в очереди
      }
    };
  }


  // Основная логика виджета
  function initWidget() {
    // Проверяем, что ID ассистента существует
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag or define window.wellcomeAIAssistantId.", 'error');
      // Можно показать сообщение пользователю прямо на странице, если виджет критически важен
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = "position:fixed; top:10px; left:10px; padding:10px; background:red; color:white; z-index:2147483647;";
      errorDiv.textContent = "WellcomeAI Widget Error: Assistant ID not configured. Widget disabled.";
      document.body.appendChild(errorDiv);
      return; // Прерываем инициализацию
    }

    // Элементы UI
    const widgetContainer = document.getElementById('wellcomeai-widget-container');
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    const widgetClose = document.getElementById('wellcomeai-widget-close');
    const mainCircle = document.getElementById('wellcomeai-main-circle');
    const audioBarsContainer = document.getElementById('wellcomeai-audio-bars'); // Изменено имя переменной
    const loaderModal = document.getElementById('wellcomeai-loader-modal');
    const messageDisplay = document.getElementById('wellcomeai-message-display');
    const connectionErrorDisplay = document.getElementById('wellcomeai-connection-error'); // Изменено имя переменной
    const retryButton = document.getElementById('wellcomeai-retry-button');
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    
    // Проверка существования ключевых элементов
    if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBarsContainer || !loaderModal || !messageDisplay || !connectionErrorDisplay || !retryButton || !statusIndicator || !statusDot || !statusText) {
      widgetLog("One or more critical UI elements were not found! Widget may not function correctly.", 'error');
      // Можно предпринять действия, например, скрыть виджет или показать сообщение об ошибке
      if (widgetContainer) widgetContainer.style.display = 'none'; // Скрыть виджет, если он есть, но его части отсутствуют
      return; // Прерываем инициализацию
    }
    
    // Переменные для обработки аудио
    // audioChunksBuffer - больше не используется напрямую, данные сразу идут в WebSocket
    let audioPlaybackQueue = []; // Массив для хранения base64 аудио для воспроизведения
    let hasAudioData = false;    // Флаг, указывающий, были ли записаны значащие аудиоданные
    let audioDataStartTime = 0;  // Время начала записи значащих аудиоданных
    let minimumAudioLength = 200; // Минимальная длина аудио в мс для отправки (OpenAI требует >= 100ms)
    let isListening = false;     // Флаг, активен ли процесс прослушивания микрофона
    let websocket = null;        // Объект WebSocket соединения
    let audioProcessorNode = null; // ScriptProcessorNode для обработки аудио (переименовано с audioProcessor)
    let mediaStreamSourceNode = null; // MediaStreamSourceNode для подключения потока микрофона
    
    let isConnected = false;     // Флаг статуса WebSocket соединения
    let isWidgetOpen = false;    // Флаг, открыт ли виджет (развернут)
    let connectionFailedPermanently = false; // Флаг, если все попытки переподключения исчерпаны
    // pingIntervalId уже объявлен глобально
    let lastPingTime = Date.now(); // Время последней отправки ping (уже объявлен глобально lastPongTime)
    let connectionTimeoutId = null; // ID для таймаута соединения (переименовано с connectionTimeout)
    
    window.isPlayingAudio = false; // Глобальный флаг, воспроизводится ли аудио ассистентом
    
    // Состояния для обработки перебивания
    // Используем объект, чтобы передавать его по ссылке
    let interruptionState = {
      is_assistant_speaking: false,
      is_user_speaking: false, // Пока не используется активно, но может пригодиться
      last_interruption_time: 0, // Время последнего события перебивания (переименовано)
      interruption_count: 0,
      current_audio_elements: [], // Массив активных HTMLAudioElement для управления
      // pending_audio_stop - больше не нужен, логика упрощена
    };
    
    // Создаем playNextAudio через фабрику с правильным контекстом
    const playNextAudioInstance = createPlayNextAudio( // Переименовано для ясности
      interruptionState, // Передаем сам объект
      audioPlaybackQueue,  // Передаем сам массив (ссылочный тип)
      { mainCircle, widgetButton }, // Объект с UI элементами
      () => isWidgetOpen, // Функция для получения актуального isWidgetOpen
      () => startListening() // Функция для старта прослушивания
    );
    
    const AUDIO_PROCESSING_CONFIG = { // Переименовано для ясности
      silenceThreshold: 0.005, // Более чувствительный порог тишины
      silenceDurationMs: 350,  // Длительность тишины в мс для автоматической отправки
      bufferCheckIntervalMs: 50, // Интервал проверки буфера (не используется напрямую в новой логике)
      soundDetectionThreshold: 0.01, // Порог для определения начала звука (более чувствительный)
      amplificationFactor: isMobile ? 1.5 : 1.0, // Усиление для мобильных, если нужно
      scriptProcessorBufferSize: isIOS ? 4096 : 2048 // Размер буфера ScriptProcessor, для iOS может быть больше
    };
    
    // Обработка событий перебивания от сервера
    function handleInterruptionEvent(eventData) {
      const now = Date.now();
      widgetLog(`[INTERRUPTION] Получено серверное событие перебивания: ${JSON.stringify(eventData)}`, 'info');
      
      interruptionState.interruption_count = (eventData && eventData.interruption_count !== undefined) ? eventData.interruption_count : (interruptionState.interruption_count + 1);
      interruptionState.last_interruption_time = (eventData && eventData.timestamp) ? eventData.timestamp : now;
      
      stopAllAudioPlayback(); // Останавливаем текущее воспроизведение ассистента
      // Не нужно переключать в режим прослушивания здесь, это должно произойти естественно
      // или по действию пользователя / окончанию обработки серверного запроса.
      
      mainCircle.classList.remove('speaking');
      mainCircle.classList.add('interrupted');
      
      // Сообщение пользователю о перебивании
      showMessage(`Вы перебили ассистента.`, 2000);
      updateConnectionStatus('interrupted', `Перебивание #${interruptionState.interruption_count}`);
      
      setTimeout(() => {
        mainCircle.classList.remove('interrupted');
        // Если виджет открыт и нет активного воспроизведения, и не слушаем - начать слушать
        if (isWidgetOpen && !window.isPlayingAudio && !isListening && isConnected) {
          mainCircle.classList.add('listening'); // Визуально показываем готовность
          startListening();
        } else if (!window.isPlayingAudio && !isListening) {
            // Если не играем и не слушаем, просто убираем индикацию
        }
      }, 1200); // Увеличено время для индикации перебивания
      
      widgetLog(`[INTERRUPTION] Обработано перебивание #${interruptionState.interruption_count}`);
    }
    
    // Остановка всех аудио воспроизведений ассистента
    function stopAllAudioPlayback() {
      widgetLog('[AUDIO CTRL] Остановка всех аудио воспроизведений ассистента');
      
      window.isPlayingAudio = false;
      interruptionState.is_assistant_speaking = false; // Важно сбросить этот флаг
      
      // Очищаем очередь воспроизведения
      audioPlaybackQueue.length = 0; // Быстрый способ очистить массив
      
      // Останавливаем и очищаем текущие HTMLAudioElement
      const cleanupCurrentAudio = createCleanupAudio(interruptionState); // Получаем функцию очистки
      interruptionState.current_audio_elements.forEach(audio => {
        try {
          if (!audio.paused) audio.pause();
          audio.currentTime = 0; // Сброс времени
          // Отзываем URL, если он был создан для этого аудио
          // Предполагаем, что src хранит URL, который нужно отозвать
          if (audio.src && audio.src.startsWith('blob:')) {
            cleanupCurrentAudio(audio.src, audio); // Используем audio.src как audioUrl
          }
        } catch (e) {
          widgetLog(`[AUDIO CTRL] Ошибка при остановке аудио элемента: ${e.message}`, 'warn');
        }
      });
      interruptionState.current_audio_elements = []; // Очищаем массив после обработки
      
      mainCircle.classList.remove('speaking'); // Убираем визуализацию говорения
      
      // Отправляем серверу сообщение, что воспроизведение остановлено клиентом
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        try {
          websocket.send(JSON.stringify({
            type: "audio_playback.stopped_by_client", // Более точный тип события
            timestamp: Date.now()
          }));
          widgetLog('[AUDIO CTRL] Отправлено событие audio_playback.stopped_by_client');
        } catch (e) {
          widgetLog(`[AUDIO CTRL] Ошибка отправки события остановки воспроизведения: ${e.message}`, 'warn');
        }
      }
      widgetLog('[AUDIO CTRL] Все аудио воспроизведения ассистента остановлены и очередь очищена.');
    }
    
    // Переключение в режим прослушивания (визуально и логически)
    // Эта функция больше не нужна в таком виде, startListening делает все необходимое
    // function switchToListeningMode() { ... }
    
    // Обработка начала речи пользователя (событие от сервера)
    function handleSpeechStarted(eventData) {
      widgetLog(`[EVENT] Сервер: пользователь начал говорить. Данные: ${JSON.stringify(eventData)}`);
      interruptionState.is_user_speaking = true; // Флаг, что пользователь говорит (по мнению сервера)
      
      // Если ассистент говорил в этот момент, это считается перебиванием со стороны пользователя
      if (interruptionState.is_assistant_speaking) {
        widgetLog('[EVENT] Пользователь начал говорить во время речи ассистента - ИНТЕРПРЕТИРУЕМ КАК ПЕРЕБИВАНИЕ.');
        stopAllAudioPlayback(); // Останавливаем ассистента
        mainCircle.classList.add('interrupted'); // Показываем состояние перебивания
        updateConnectionStatus('interrupted', 'Вы говорите...');
        setTimeout(() => { // Убираем interrupted через некоторое время
            mainCircle.classList.remove('interrupted');
            if (isListening) mainCircle.classList.add('listening'); // Если слушаем, восстанавливаем listening
        }, 1000);
      } else {
        // Если ассистент не говорил, просто показываем, что слушаем
        mainCircle.classList.remove('speaking'); // Убираем speaking, если был
        mainCircle.classList.add('listening');   // Показываем listening
        updateConnectionStatus('connected', 'Вы говорите...');
      }
    }
    
    // Обработка окончания речи пользователя (событие от сервера)
    function handleSpeechStopped(eventData) {
      widgetLog(`[EVENT] Сервер: пользователь закончил говорить. Данные: ${JSON.stringify(eventData)}`);
      interruptionState.is_user_speaking = false;
      
      // Если виджет открыт, сервер определил конец речи, и мы не воспроизводим аудио,
      // то можно остановить прослушивание на клиенте, если оно еще активно.
      // Однако, commitAudioBuffer уже должен был это сделать.
      // Здесь в основном обновляем UI.
      mainCircle.classList.remove('listening', 'interrupted'); // Убираем listening и interrupted
      // Сервер теперь будет обрабатывать и присылать ответ.
      updateConnectionStatus('connected', 'Обработка...');
      // showMessage("Анализирую ваш запрос...", 3000); // Можно добавить сообщение
    }
    
    // Обработка начала речи ассистента (событие от сервера)
    function handleAssistantSpeechStarted(eventData) {
      widgetLog(`[EVENT] Сервер: ассистент начал говорить. Данные: ${JSON.stringify(eventData)}`);
      interruptionState.is_assistant_speaking = true; // Устанавливаем флаг
      window.isPlayingAudio = true; // Устанавливаем глобальный флаг
      
      // Останавливаем прослушивание на клиенте, если оно активно
      if (isListening) {
        isListening = false; // Логически останавливаем
        resetAudioVisualization();
        // audioProcessorNode и mediaStreamSourceNode отключаются в stopListening, если она будет вызвана
        // или при следующем startListening будут пересозданы/переподключены.
      }
      
      mainCircle.classList.remove('listening', 'interrupted');
      mainCircle.classList.add('speaking');
      updateConnectionStatus('connected', 'Ассистент говорит');
      hideMessage(); // Скрываем предыдущие сообщения типа "Обработка..."
    }
    
    // Обработка окончания речи ассистента (событие от сервера)
    function handleAssistantSpeechEnded(eventData) {
      widgetLog(`[EVENT] Сервер: ассистент закончил говорить. Данные: ${JSON.stringify(eventData)}`);
      // Флаги is_assistant_speaking и isPlayingAudio сбрасываются в playNextAudioInstance, когда очередь пуста.
      // Здесь мы просто обновляем UI и, возможно, готовимся к следующему вводу.
      
      mainCircle.classList.remove('speaking');
      updateConnectionStatus('connected', 'Готов к ответу');
      
      // Если виджет открыт и нет других аудио в очереди, автоматически начинаем слушать
      // Это поведение по умолчанию, как в десктопных ассистентах
      if (isWidgetOpen && audioPlaybackQueue.length === 0 && isConnected && !isReconnecting) {
        // widgetLog('[EVENT] Ассистент закончил, виджет открыт, очередь пуста. Начинаем слушать.');
        // Небольшая задержка, чтобы пользователь успел среагировать
        setTimeout(() => {
          if (isWidgetOpen && !window.isPlayingAudio && !isListening) { // Доп. проверка состояния
            startListening();
          }
        }, 500); 
      }
    }
    
    // Обновление индикатора статуса соединения
    function updateConnectionStatus(statusKey, messageText) {
      // Проверка существования элементов (на всякий случай, если вызывается до их полной инициализации)
      if (!statusIndicator || !statusDot || !statusText) {
        widgetLog(`[UI STATUS] Элементы индикатора статуса не найдены. Статус: ${statusKey}, Сообщение: ${messageText}`, 'warn');
        return;
      }
      
      statusText.textContent = messageText || statusKey; // Отображаем текст сообщения или ключ статуса
      
      // Убираем все предыдущие классы статусов с точки
      statusDot.classList.remove('connected', 'disconnected', 'connecting', 'interrupted');
      // Убираем анимацию подключения, если она была
      statusDot.style.animation = '';
      
      switch (statusKey) {
        case 'connected':
          statusDot.classList.add('connected');
          break;
        case 'disconnected':
          statusDot.classList.add('disconnected');
          break;
        case 'interrupted':
          statusDot.classList.add('interrupted');
          break;
        case 'connecting': // Или 'reconnecting'
        default: // По умолчанию считаем, что это 'connecting'
          statusDot.classList.add('connecting');
          // Можно добавить анимацию для connecting, если есть в CSS
          // statusDot.style.animation = 'wellcomeai-connecting-pulse 1.5s infinite ease-in-out';
          break;
      }
      
      statusIndicator.classList.add('show'); // Показываем индикатор
      
      // Автоматически скрывать индикатор через некоторое время, если это не постоянный статус (типа disconnected)
      // Для 'disconnected' и 'connecting' лучше оставлять видимым дольше или до смены статуса.
      if (statusKey === 'connected' || statusKey === 'interrupted') {
        setTimeout(() => {
          // Скрываем, только если статус не изменился за это время
          if (statusText.textContent === messageText) { 
            statusIndicator.classList.remove('show');
          }
        }, 4000); // Увеличено время отображения
      }
    }
    
    // Создаем аудио-бары для визуализации
    function createAudioBars(count = 20) {
      audioBarsContainer.innerHTML = ''; // Очищаем предыдущие бары, если есть
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        // Начальная высота может быть задана в CSS, но для единообразия можно и здесь
        bar.style.height = '2px'; 
        audioBarsContainer.appendChild(bar);
      }
    }
    createAudioBars(); // Вызываем один раз при инициализации
    
    // Функция для полной остановки всех аудио процессов (прослушивание и воспроизведение)
    function stopAllAudioProcessing() {
      widgetLog('[AUDIO CTRL] Полная остановка всех аудио процессов.');
      
      // Останавливаем прослушивание
      if (isListening) {
        isListening = false; // Сначала флаг, чтобы onaudioprocess перестал работать
        if (audioProcessorNode) {
            audioProcessorNode.disconnect(); // Отключаем ScriptProcessor
            // audioProcessorNode.onaudioprocess = null; // Удаляем обработчик (хотя disconnect должен это сделать)
        }
        if (mediaStreamSourceNode) {
            mediaStreamSourceNode.disconnect(); // Отключаем источник от ScriptProcessor
        }
        // Не нужно останавливать globalMicStream здесь, он может быть переиспользован.
        // Остановка треков микрофона должна происходить при закрытии виджета или выгрузке страницы.
        resetAudioVisualization();
        mainCircle.classList.remove('listening');
        widgetLog('[AUDIO CTRL] Прослушивание остановлено.');
      }
      
      // Останавливаем воспроизведение
      stopAllAudioPlayback(); 
      
      // Сброс состояния, связанного с аудио данными (на всякий случай)
      hasAudioData = false;
      audioDataStartTime = 0;
      
      // Отправка команды на сервер для отмены текущего запроса и очистки буфера, если необходимо
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        // Отмена текущего активного ответа (если есть)
        websocket.send(JSON.stringify({
          type: "response.cancel",
          event_id: `cancel_${Date.now()}`
        }));
        // Очистка буфера ввода на сервере (если там что-то накопилось)
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
        widgetLog('[AUDIO CTRL] Отправлены команды response.cancel и input_audio_buffer.clear на сервер.');
      }
      
      // Убираем все активные классы с круга
      mainCircle.classList.remove('listening', 'speaking', 'interrupted');
      
      // Сброс состояния перебивания, связанного с активностью
      interruptionState.is_assistant_speaking = false;
      interruptionState.is_user_speaking = false;
      widgetLog('[AUDIO CTRL] Все аудио процессы полностью остановлены.');
    }
    
    // Показать сообщение в UI
    function showMessage(text, durationMs = 5000) {
      if (!messageDisplay) return;
      
      messageDisplay.textContent = text;
      messageDisplay.classList.add('show');
      
      // Если уже есть таймер на скрытие, очищаем его
      if (messageDisplay.hideTimeoutId) {
        clearTimeout(messageDisplay.hideTimeoutId);
      }
      
      if (durationMs > 0) {
        messageDisplay.hideTimeoutId = setTimeout(() => {
          // Проверяем, что текст не изменился, прежде чем скрывать
          // Это предотвращает скрытие нового сообщения старым таймером
          if (messageDisplay.textContent === text) {
             hideMessage();
          }
        }, durationMs);
      }
    }

    // Скрыть сообщение в UI
    function hideMessage() {
      if (!messageDisplay) return;
      messageDisplay.classList.remove('show');
      if (messageDisplay.hideTimeoutId) {
        clearTimeout(messageDisplay.hideTimeoutId);
        messageDisplay.hideTimeoutId = null;
      }
    }
    
    // Показать ошибку соединения в UI
    function showConnectionError(message) {
      if (!connectionErrorDisplay) return;

      // Обновляем текст ошибки и кнопку (если нужно)
      // Первый дочерний элемент - текстовый узел, затем кнопка
      if (connectionErrorDisplay.firstChild && connectionErrorDisplay.firstChild.nodeType === Node.TEXT_NODE) {
        connectionErrorDisplay.firstChild.textContent = message || 'Ошибка соединения. ';
      } else {
        // Если текстового узла нет, создаем его
        connectionErrorDisplay.insertBefore(document.createTextNode(message || 'Ошибка соединения. '), connectionErrorDisplay.firstChild);
      }
      
      connectionErrorDisplay.classList.add('visible');
      
      // Кнопка "Повторить" уже должна быть в HTML, здесь можно просто убедиться, что она видима
      // и обработчик на ней актуален (он вешается один раз в initWidget)
    }
    
    // Скрыть ошибку соединения в UI
    function hideConnectionError() {
      if (!connectionErrorDisplay) return;
      connectionErrorDisplay.classList.remove('visible');
    }
    
    // Сброс состояния соединения и попытка переподключения
    function resetConnection() {
      widgetLog('[CONNECTION] Сброс состояния соединения и попытка переподключения.');
      reconnectAttempts = 0; // Сбрасываем счетчик попыток
      connectionFailedPermanently = false; // Сбрасываем флаг окончательной неудачи
      
      hideConnectionError(); // Скрываем сообщение об ошибке, если было
      
      // Показываем статус подключения
      if (isWidgetOpen) { // Только если виджет открыт, чтобы не показывать сообщения "вникуда"
        showMessage("Попытка подключения...", 0); // 0 - не скрывать автоматически
        updateConnectionStatus('connecting', 'Подключение...');
      }
      
      // Закрываем текущий WebSocket, если он есть и не закрыт
      if (websocket && websocket.readyState !== WebSocket.CLOSED) {
        widgetLog('[CONNECTION] Закрытие существующего WebSocket перед сбросом.');
        websocket.onclose = null; // Убираем обработчик onclose, чтобы не вызвать рекурсию reconnectWithDelay
        websocket.close(1000, "Connection reset by client");
      }
      websocket = null; // Обнуляем ссылку

      // Очищаем интервал ping, если он был
      if (pingIntervalId) {
        clearInterval(pingIntervalId);
        pingIntervalId = null;
      }
      
      // Небольшая задержка перед новой попыткой подключения, чтобы дать время на закрытие старого сокета
      setTimeout(() => {
        connectWebSocket();
      }, 200);
    }
    
    // Открыть виджет
    async function openWidget() {
      widgetLog("Открытие виджета...");
      
      // Управляем z-index через CSS классы, но можно и здесь для гарантии
      // widgetContainer.style.zIndex = "2147483647";
      
      widgetContainer.classList.add('active');
      isWidgetOpen = true;
      
      // Анимация появления развернутого виджета уже обрабатывается CSS
      // const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      // if (expandedWidget) { ... } 
      
      // Инициализация аудио, если еще не было или произошла ошибка
      if (!window.audioInitialized || !window.globalAudioContext || !window.globalMicStream || !window.globalMicStream.active) {
        widgetLog('[WIDGET OPEN] Аудио не инициализировано или поток неактивен. Попытка инициализации.');
        loaderModal.classList.add('active'); // Показываем лоадер на время инициализации аудио
        const audioInitSuccess = await initializeAudio();
        loaderModal.classList.remove('active'); // Скрываем лоадер
        
        if (!audioInitSuccess) {
          showMessage("Ошибка доступа к микрофону. Проверьте разрешения браузера.", 5000);
          updateConnectionStatus('disconnected', 'Ошибка аудио'); // Показываем статус ошибки
          // Можно не закрывать виджет, а дать пользователю шанс исправить разрешения и попробовать снова
          return; // Не продолжаем, если аудио не готово
        }
      } else if (window.globalAudioContext.state === 'suspended') {
        // Если аудио было инициализировано, но контекст "уснул"
        widgetLog('[WIDGET OPEN] AudioContext в состоянии suspended. Попытка возобновления.');
        try {
            await window.globalAudioContext.resume();
            widgetLog('[WIDGET OPEN] AudioContext успешно возобновлен.');
        } catch (e) {
            widgetLog(`[WIDGET OPEN] Ошибка возобновления AudioContext: ${e.message}`, 'error');
            showMessage("Не удалось активировать аудио. Попробуйте еще раз.", 3000);
            return;
        }
      }

      // Проверка состояния WebSocket соединения
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Попробуйте позже или перезагрузите страницу.');
        updateConnectionStatus('disconnected', 'Нет соединения');
        return;
      }
      
      if (isConnected && !isListening && !window.isPlayingAudio && !isReconnecting) {
        // Если уже подключены и ничего не делаем, начинаем слушать
        widgetLog('[WIDGET OPEN] Подключено. Начинаем прослушивание.');
        startListening();
        updateConnectionStatus('connected', 'Готов к ответу'); // Обновляем статус
      } else if (!isConnected && !isReconnecting) {
        // Если не подключены и не в процессе переподключения, инициируем подключение
        widgetLog('[WIDGET OPEN] Нет соединения. Инициируем подключение WebSocket.');
        connectWebSocket(); // connectWebSocket покажет лоадер и обновит статус
      } else if (isReconnecting) {
        widgetLog('[WIDGET OPEN] В процессе переподключения.');
        if (loaderModal) loaderModal.classList.add('active'); // Показываем лоадер, если переподключаемся
        updateConnectionStatus('connecting', 'Переподключение...');
      } else {
        // Другие состояния (например, isListening или isPlayingAudio)
        widgetLog(`[WIDGET OPEN] Состояние не позволяет начать новое действие: isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${window.isPlayingAudio}, isReconnecting=${isReconnecting}`);
        // Статус должен быть уже актуальным от предыдущих действий
      }
      
      widgetButton.classList.remove('wellcomeai-pulse-animation'); // Убираем пульсацию кнопки
    }
    
    // Закрыть виджет
    function closeWidget() {
      widgetLog("Закрытие виджета...");
      
      stopAllAudioProcessing(); // Останавливаем все аудио процессы (прослушивание, воспроизведение)
      
      widgetContainer.classList.remove('active');
      isWidgetOpen = false;
      
      hideMessage(); // Скрываем любые активные сообщения
      hideConnectionError(); // Скрываем сообщение об ошибке соединения, если было
      
      // Скрываем индикатор статуса, если он не показывает ошибку или переподключение
      if (statusIndicator && !statusDot.classList.contains('disconnected') && !statusDot.classList.contains('connecting')) {
        statusIndicator.classList.remove('show');
      }
      
      // Анимация скрытия развернутого виджета уже обрабатывается CSS
      // const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      // if (expandedWidget) { ... }

      // Если соединение активно, кнопка не должна пульсировать
      // Если соединения нет, добавляем пульсацию
      if (!isConnected && !connectionFailedPermanently) {
          widgetButton.classList.add('wellcomeai-pulse-animation');
      } else {
          widgetButton.classList.remove('wellcomeai-pulse-animation');
      }

      // Важно! Не закрываем WebSocket соединение при закрытии виджета,
      // чтобы при следующем открытии не ждать переподключения.
      // Также не останавливаем микрофонный поток (globalMicStream.getTracks().forEach(t=>t.stop()))
      // и не закрываем AudioContext (globalAudioContext.close()),
      // так как это может потребовать повторного запроса разрешений у пользователя.
      // Ресурсы будут освобождены при выгрузке страницы (см. 'beforeunload').
    }
    
    // Начало записи голоса
    async function startListening() {
      // Проверки перед началом прослушивания
      if (!isWidgetOpen) {
        widgetLog('[LISTEN] Попытка начать прослушивание при закрытом виджете. Отменено.', 'warn');
        return;
      }
      if (!isConnected) {
        widgetLog('[LISTEN] Нет WebSocket соединения. Прослушивание невозможно.', 'warn');
        showMessage("Нет соединения с сервером.", 3000);
        updateConnectionStatus('disconnected', 'Нет соединения');
        return;
      }
      if (window.isPlayingAudio) {
        widgetLog('[LISTEN] Ассистент говорит. Прослушивание пока невозможно.', 'info');
        // showMessage("Ассистент говорит...", 2000); // Можно раскомментировать, если нужно явное сообщение
        return;
      }
      if (isReconnecting) {
        widgetLog('[LISTEN] Идет переподключение. Прослушивание невозможно.', 'warn');
        showMessage("Идет переподключение...", 3000);
        return;
      }
      if (isListening) {
        widgetLog('[LISTEN] Прослушивание уже активно.', 'info');
        return;
      }

      // Проверяем и инициализируем аудио, если это не сделано или ресурсы неактивны
      if (!window.audioInitialized || !window.globalAudioContext || window.globalAudioContext.state !== 'running' || !window.globalMicStream || !window.globalMicStream.active) {
        widgetLog('[LISTEN] Аудио не готово (не инициализировано, контекст неактивен или поток микрофона неактивен). Попытка инициализации/возобновления.', 'warn');
        loaderModal.classList.add('active');
        const audioReady = await initializeAudio(); // initializeAudio теперь также возобновляет контекст
        loaderModal.classList.remove('active');
        if (!audioReady) {
          widgetLog('[LISTEN] Не удалось подготовить аудио для прослушивания.', 'error');
          showMessage("Ошибка микрофона. Проверьте разрешения.", 5000);
          updateConnectionStatus('disconnected', 'Ошибка аудио');
          return;
        }
      }
      
      isListening = true; // Устанавливаем флаг прослушивания
      widgetLog('[LISTEN] Начинаем прослушивание...');
      
      // Отправляем команду для очистки буфера ввода на сервере перед началом новой сессии
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_on_listen_start_${Date.now()}`
        }));
        widgetLog('[LISTEN] Отправлена команда input_audio_buffer.clear.');
      }
      
      // Убедимся, что ScriptProcessorNode и MediaStreamSourceNode существуют и подключены
      // Пересоздаем или переподключаем, если необходимо
      if (!audioProcessorNode || !mediaStreamSourceNode) {
        // Отключаем старые узлы, если они есть, перед созданием новых
        if (audioProcessorNode) audioProcessorNode.disconnect();
        if (mediaStreamSourceNode) mediaStreamSourceNode.disconnect();

        const bufferSize = AUDIO_PROCESSING_CONFIG.scriptProcessorBufferSize;
        audioProcessorNode = window.globalAudioContext.createScriptProcessor(bufferSize, 1, 1);
        widgetLog(`[LISTEN] Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
        
        mediaStreamSourceNode = window.globalAudioContext.createMediaStreamSource(window.globalMicStream);
        widgetLog('[LISTEN] Создан MediaStreamSourceNode из globalMicStream.');

        // Подключаем узлы: StreamSource -> ScriptProcessor -> (никуда, или к GainNode с 0 усилением)
        mediaStreamSourceNode.connect(audioProcessorNode);
        
        // Важно! ScriptProcessorNode должен быть подключен к destination, даже если через Gain(0),
        // чтобы обработчик onaudioprocess срабатывал.
        const gainNode = window.globalAudioContext.createGain();
        gainNode.gain.value = 0; // Усиление 0, чтобы не было слышно свой голос
        audioProcessorNode.connect(gainNode);
        gainNode.connect(window.globalAudioContext.destination);
        widgetLog('[LISTEN] Узлы ScriptProcessor и MediaStreamSource подключены.');
      } else {
        // Если узлы уже существуют, просто убедимся, что ScriptProcessor подключен
        // (на случай, если его отключали ранее)
        // Это может быть избыточно, если логика отключения всегда корректна
        try {
            // Попытка переподключить, если ранее были отсоединены.
            // Это более сложная логика, проще пересоздавать, как выше.
            // Для простоты оставим пересоздание.
        } catch (e) {
            widgetLog(`[LISTEN] Ошибка при проверке подключения существующих аудио узлов: ${e.message}. Пересоздаем.`, 'warn');
            // Сбрасываем узлы, чтобы они были пересозданы на следующей итерации проверки
            if (audioProcessorNode) audioProcessorNode.disconnect();
            if (mediaStreamSourceNode) mediaStreamSourceNode.disconnect();
            audioProcessorNode = null;
            mediaStreamSourceNode = null;
            // Рекурсивный вызов для повторной попытки с пересозданием (осторожно, может привести к циклу)
            // Лучше просто пересоздавать, как в блоке if (!audioProcessorNode || !mediaStreamSourceNode)
            // Для безопасности, просто выходим, если что-то пошло не так с узлами.
            // isListening = false; // Сбрасываем флаг, т.к. не удалось настроить
            // return;
        }
      }

      // Переменные для логики определения тишины внутри onaudioprocess
      let silenceStartTimestamp = 0;
      let hasDetectedSoundInSegment = false; // Был ли звук в текущем сегменте отправки
      
      audioProcessorNode.onaudioprocess = function(audioProcessingEvent) {
        if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
          // Если прослушивание остановлено или нет соединения, ничего не делаем
          // Это может произойти, если isListening изменился между проверкой и вызовом onaudioprocess
          return;
        }
        
        const inputBuffer = audioProcessingEvent.inputBuffer;
        let inputData = inputBuffer.getChannelData(0); // Получаем Float32Array
        
        if (inputData.length === 0) return; // Пустой буфер, ничего не делаем
        
        // Усиление, если настроено (особенно для мобильных)
        if (AUDIO_PROCESSING_CONFIG.amplificationFactor !== 1.0) {
          const gain = AUDIO_PROCESSING_CONFIG.amplificationFactor;
          // Создаем новый массив, чтобы не модифицировать оригинальный буфер напрямую
          const amplifiedData = new Float32Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            amplifiedData[i] = Math.max(-1.0, Math.min(1.0, inputData[i] * gain)); // Усиление с ограничением
          }
          inputData = amplifiedData; // Используем усиленные данные
        }
            
        // Вычисляем максимальную амплитуду для определения звука и для визуализации
        let maxAmplitude = 0;
        for (let i = 0; i < inputData.length; i++) {
          const absValue = Math.abs(inputData[i]);
          if (absValue > maxAmplitude) {
            maxAmplitude = absValue;
          }
        }
        
        updateAudioVisualization(inputData); // Обновляем визуализацию на основе обработанных данных
        
        // Преобразуем Float32 PCM в Int16 PCM ArrayBuffer для отправки
        const pcm16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32767)));
        }
        const pcm16ArrayBuffer = pcm16Data.buffer;

        // Отправляем аудиоданные на сервер
        try {
          websocket.send(JSON.stringify({
            type: "input_audio_buffer.append",
            event_id: `audio_chunk_${Date.now()}`,
            audio_format: "pcm_s16le_24000hz", // Указываем формат
            audio: arrayBufferToBase64(pcm16ArrayBuffer)
          }));
          // widgetLog(`Отправлен аудио чанк: ${pcm16ArrayBuffer.byteLength} байт`);
        } catch (error) {
          widgetLog(`[LISTEN] Ошибка отправки аудио чанка: ${error.message}`, "error");
          // Можно обработать ошибку, например, остановить прослушивание или попытаться переподключиться
          // Для простоты, пока только логируем.
        }

        // Логика определения начала звука и тишины для автоматической отправки (commit)
        const soundDetected = maxAmplitude > AUDIO_PROCESSING_CONFIG.soundDetectionThreshold;

        if (soundDetected) {
          if (!hasAudioData) { // Если это первый звук после тишины или начала записи
            hasAudioData = true;
            audioDataStartTime = Date.now(); // Запоминаем время начала значащих данных
            widgetLog("[LISTEN] Обнаружено начало звука.");
          }
          hasDetectedSoundInSegment = true; // Отмечаем, что в этом сегменте был звук
          silenceStartTimestamp = 0; // Сбрасываем таймер тишины
        } else if (hasAudioData) { // Если звук уже был, но сейчас тишина
          if (silenceStartTimestamp === 0) {
            silenceStartTimestamp = Date.now(); // Начинаем отсчет тишины
          } else {
            const silenceDuration = Date.now() - silenceStartTimestamp;
            if (silenceDuration >= AUDIO_PROCESSING_CONFIG.silenceDurationMs) {
              widgetLog(`[LISTEN] Обнаружена тишина (${silenceDuration}мс) после звука. Отправляем буфер.`);
              commitAudioBuffer(); // Отправляем накопленный буфер
              // После commitAudioBuffer, hasAudioData и audioDataStartTime сбрасываются
              silenceStartTimestamp = 0; // Сбрасываем таймер тишины
              hasDetectedSoundInSegment = false; // Сбрасываем флаг звука в сегменте
            }
          }
        }
      }; // Конец audioProcessorNode.onaudioprocess
      
      // Сбрасываем флаги аудио данных перед началом нового прослушивания
      hasAudioData = false;
      audioDataStartTime = 0;
      
      // Активируем визуальное состояние прослушивания
      mainCircle.classList.add('listening');
      mainCircle.classList.remove('speaking', 'interrupted'); // Убираем другие состояния
      updateConnectionStatus('connected', 'Слушаю...'); // Обновляем статус
      widgetLog("[LISTEN] Прослушивание успешно начато.");
    }
    
    // Функция для отправки команды commit на сервер
    function commitAudioBuffer() {
      if (!isListening) { // Если прослушивание было остановлено до вызова commit
        widgetLog("[COMMIT] Прослушивание остановлено, commit не отправляется.", "info");
        // Сбрасываем флаги, если они не были сброшены
        hasAudioData = false;
        audioDataStartTime = 0;
        return;
      }

      if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        widgetLog("[COMMIT] Нет WebSocket соединения, commit не отправляется.", "warn");
        hasAudioData = false; audioDataStartTime = 0;
        return;
      }
      
      if (!hasAudioData) {
        widgetLog("[COMMIT] Нет аудиоданных для отправки (hasAudioData=false). Commit не требуется.", "info");
        return; // Нечего отправлять
      }
      
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`[COMMIT] Аудиобуфер слишком короткий (${audioLength}мс < ${minimumAudioLength}мс). Commit не отправляется.`, "warn");
        // Можно решить, нужно ли его все равно отправить или просто сбросить.
        // Пока сбрасываем, чтобы избежать отправки очень коротких фрагментов.
        hasAudioData = false;
        audioDataStartTime = 0;
        // Можно показать сообщение пользователю, что нужно говорить дольше
        // showMessage("Пожалуйста, говорите немного дольше.", 2000);
        // И снова начать слушать, если нужно
        // startListening(); // Осторожно с рекурсией, если это происходит часто
        return;
      }
      
      widgetLog(`[COMMIT] Отправка команды commit. Длина записанного аудио: ${audioLength}мс.`);
      
      try {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.commit",
          event_id: `commit_${Date.now()}`
        }));
      } catch (error) {
          widgetLog(`[COMMIT] Ошибка при отправке commit: ${error.message}`, 'error');
      }
      
      // После отправки commit, останавливаем текущее прослушивание на клиенте,
      // так как сервер теперь будет обрабатывать запрос.
      // isListening = false; // Логически останавливаем
      // resetAudioVisualization();
      // mainCircle.classList.remove('listening');
      // updateConnectionStatus('connected', 'Обработка...'); // Меняем статус на "Обработка"
      // Важно: вышеуказанный блок закомментирован, т.к. серверное событие speech_stopped_event
      // должно управлять этим состоянием для лучшей синхронизации.
      // Клиент просто отправляет commit и ждет ответа/событий от сервера.

      // Сбрасываем флаги аудио данных для следующей сессии записи
      hasAudioData = false;
      audioDataStartTime = 0;
    }
    
    // Преобразование ArrayBuffer в Base64
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      try {
        return btoa(binary);
      } catch (e) {
        widgetLog(`Ошибка btoa: ${e.message}. Длина бинарной строки: ${binary.length}`, 'error');
        // Возвращаем пустую строку или обрабатываем ошибку иначе
        return ''; 
      }
    }
    
    // Преобразование Base64 в ArrayBuffer
    function base64ToArrayBuffer(base64) {
      try {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      } catch (e) {
        widgetLog(`Ошибка при декодировании base64 (atob): ${e.message}. Длина base64: ${base64.length}`, "error");
        return new ArrayBuffer(0); // Возвращаем пустой буфер в случае ошибки
      }
    }
    
    // Обновление визуализации аудио (принимает Float32Array)
    function updateAudioVisualization(float32AudioData) {
      const bars = audioBarsContainer.querySelectorAll('.wellcomeai-audio-bar');
      if (bars.length === 0) return; // Если баров нет, выходим

      const numBars = bars.length;
      const dataLength = float32AudioData.length;
      const step = Math.max(1, Math.floor(dataLength / numBars)); // Шаг не может быть меньше 1
      
      for (let i = 0; i < numBars; i++) {
        let sum = 0;
        let count = 0;
        // Усредняем значения для каждого бара
        for (let j = 0; j < step; j++) {
          const index = i * step + j;
          if (index < dataLength) {
            sum += Math.abs(float32AudioData[index]);
            count++;
          }
        }
        const averageAmplitude = count > 0 ? sum / count : 0;
        
        // Масштабируем амплитуду в высоту бара
        // Множитель подбирается экспериментально для хорошей визуализации
        const maxBarHeight = 28; // Максимальная высота бара (30px общая высота - 2px минимальная)
        const minBarHeight = 2;  // Минимальная высота бара
        const visualMultiplier = isMobile ? 250 : 150; // Разный множитель для мобильных/десктопа
        
        let height = minBarHeight + Math.min(maxBarHeight, averageAmplitude * visualMultiplier);
        height = Math.max(minBarHeight, Math.floor(height)); // Округляем и ограничиваем снизу

        if (bars[i]) { // Дополнительная проверка на существование бара
            bars[i].style.height = `${height}px`;
        }
      }
    }
    
    // Сброс визуализации аудио (все бары к минимальной высоте)
    function resetAudioVisualization() {
      const bars = audioBarsContainer.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px'; // Минимальная высота
      });
    }
    
    // Добавить аудио (base64) в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string' || audioBase64.length < 100) { // Проверка на валидность
          widgetLog('[QUEUE] Попытка добавить невалидные аудиоданные в очередь. Пропущено.', 'warn');
          return;
      }
      
      audioPlaybackQueue.push(audioBase64);
      widgetLog(`[QUEUE] Аудио добавлено в очередь. Текущий размер очереди: ${audioPlaybackQueue.length}`);
      
      // Если сейчас ничего не играет, запускаем воспроизведение из очереди
      if (!window.isPlayingAudio) {
        playNextAudioInstance(); // Используем инстанс, созданный фабрикой
      }
    }
    
    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelayMs = 0) {
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
      
      if (reconnectAttempts >= maxAttempts) {
        widgetLog(`[RECONNECT] Достигнуто максимальное количество попыток переподключения (${maxAttempts}). Остановка.`, 'error');
        isReconnecting = false;
        connectionFailedPermanently = true; // Устанавливаем флаг окончательной неудачи
        
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение. Попробуйте перезагрузить страницу или проверьте интернет.");
          updateConnectionStatus('disconnected', 'Отключено (лимит попыток)');
        } else {
          // Если виджет закрыт, можно добавить пульсацию кнопке как индикатор проблемы
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        return; // Выходим, больше не пытаемся
      }
      
      isReconnecting = true; // Устанавливаем флаг, что идет процесс переподключения
      
      if (isWidgetOpen) {
        // Показываем сообщение и статус только если виджет открыт
        showMessage("Соединение прервано. Переподключение...", 0); // 0 - не скрывать автоматически
        updateConnectionStatus('connecting', `Переподключение (попытка ${reconnectAttempts + 1}/${maxAttempts})...`);
        if (loaderModal) loaderModal.classList.add('active'); // Показываем лоадер
      }
      
      // Расчет задержки с экспоненциальным ростом + небольшой случайный фактор
      const baseDelay = isMobile ? 1500 : 2000; // Базовая задержка
      const exponentialFactor = isMobile ? 1.6 : 2.0; // Фактор роста
      let delayMs = initialDelayMs > 0 ? 
                initialDelayMs : 
                Math.min(isMobile ? 20000 : 30000, baseDelay * Math.pow(exponentialFactor, reconnectAttempts)); // Ограничение максимальной задержки
      delayMs += Math.random() * 1000; // Добавляем немного случайности (jitter)
      
      reconnectAttempts++; // Увеличиваем счетчик попыток
      
      widgetLog(`[RECONNECT] Попытка переподключения #${reconnectAttempts}/${maxAttempts} через ${Math.round(delayMs/1000)} сек.`);
      
      // Очищаем предыдущий таймаут, если он был (на всякий случай)
      if (window.reconnectTimeoutId) {
        clearTimeout(window.reconnectTimeoutId);
      }

      window.reconnectTimeoutId = setTimeout(() => {
        if (isReconnecting) { // Проверяем, не отменили ли переподключение (например, успешным ручным)
          connectWebSocket().then(success => {
            // Логика успеха/неуспеха уже внутри connectWebSocket и его обработчиков onopen/onerror/onclose
            // Здесь важно, что isReconnecting будет сброшен в onopen или если попытки исчерпаны
            if (success) {
                // Успешное инициирование подключения. Дальнейшее в onopen.
                // reconnectAttempts сбрасывается в onopen.
            } else {
                // Если connectWebSocket сам вернул false (редко, обычно через onclose/onerror)
                isReconnecting = false; // Сбрасываем флаг, если попытка не удалась сразу
                // Повторный вызов reconnectWithDelay будет сделан из onerror/onclose, если необходимо
            }
          }).catch(() => {
            isReconnecting = false; // Сбрасываем флаг при ошибке инициации
            // Повторный вызов reconnectWithDelay будет сделан из onerror/onclose
          });
        } else {
            widgetLog('[RECONNECT] Переподключение было отменено до истечения таймаута.', 'info');
        }
      }, delayMs);
    }
    
    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      // Проверяем, нет ли уже активного или подключающегося сокета
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
        widgetLog('[WS CONNECT] Попытка подключения при уже существующем активном/подключающемся сокете. Игнорируется.', 'warn');
        return Promise.resolve(true); // Считаем, что "успешно", так как сокет уже есть
      }

      // Если это не первая попытка и виджет открыт, показываем лоадер
      if (reconnectAttempts > 0 && isWidgetOpen && loaderModal) {
        loaderModal.classList.add('active');
      } else if (reconnectAttempts === 0 && loaderModal) { // Первая попытка подключения
        loaderModal.classList.add('active');
      }
      
      widgetLog(`[WS CONNECT] Попытка подключения к WebSocket: ${WS_URL}`);
      isReconnecting = true; // Устанавливаем флаг, что идет процесс подключения/переподключения
      
      hideConnectionError(); // Скрываем предыдущие ошибки соединения
      
      if (!ASSISTANT_ID) { // Двойная проверка, хотя уже есть в initWidget
        widgetLog('[WS CONNECT] ID ассистента не найден! Подключение невозможно.', 'error');
        if (loaderModal) loaderModal.classList.remove('active');
        isReconnecting = false;
        connectionFailedPermanently = true; // Считаем это окончательной ошибкой конфигурации
        if (isWidgetOpen) showConnectionError("Ошибка конфигурации: ID ассистента не указан.");
        return Promise.resolve(false); // Возвращаем Promise<false> для индикации неудачи
      }
      
      // Очищаем старый интервал ping и таймаут соединения, если они есть
      if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
      if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
      
      // Закрываем предыдущий сокет, если он существует и не закрыт
      if (websocket) {
        widgetLog('[WS CONNECT] Закрытие предыдущего экземпляра WebSocket.');
        websocket.onopen = websocket.onmessage = websocket.onclose = websocket.onerror = null; // Убираем все обработчики
        if (websocket.readyState !== WebSocket.CLOSED) {
            websocket.close(1000, "Creating new connection");
        }
      }
      
      try {
        websocket = new WebSocket(WS_URL);
        websocket.binaryType = 'arraybuffer'; // Ожидаем бинарные данные (аудио) как ArrayBuffer
      } catch (error) {
        widgetLog(`[WS CONNECT] Ошибка при создании объекта WebSocket: ${error.message}`, "error");
        if (loaderModal) loaderModal.classList.remove('active');
        isReconnecting = false;
        // Немедленно пытаемся переподключиться, т.к. это ошибка на уровне new WebSocket()
        // onclose/onerror не сработают для этого случая
        reconnectWithDelay(500); // Небольшая задержка перед следующей попыткой
        return Promise.resolve(false);
      }

      // Таймаут на установку соединения
      connectionTimeoutId = setTimeout(() => {
        widgetLog(`[WS CONNECT] Превышено время ожидания соединения (${CONNECTION_TIMEOUT/1000} сек).`, "error");
        if (websocket) {
          // Важно: сначала убираем обработчики, потом закрываем,
          // чтобы onclose не вызвал стандартный reconnectWithDelay, а мы управляли им здесь
          websocket.onopen = websocket.onmessage = websocket.onclose = websocket.onerror = null;
          if (websocket.readyState !== WebSocket.CLOSED) {
            websocket.close(1006, "Connection timeout"); // 1006 - Abnormal Closure
          }
        }
        // isReconnecting остается true, reconnectWithDelay будет вызван ниже
        if (loaderModal) loaderModal.classList.remove('active');
        
        // Вместо прямого вызова reconnectWithDelay, имитируем "закрытие" соединения,
        // чтобы обработать это в одном месте (в onclose, который мы вызовем "искусственно" или он сработает сам)
        // Если onclose не сработает сам по себе быстро, вызываем логику переподключения
        // Это более сложный сценарий, проще прямо вызвать reconnectWithDelay
        // Но сначала проверим, не исчерпаны ли попытки
        if (reconnectAttempts < (isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS)) {
            widgetLog('[WS CONNECT] Таймаут соединения, инициируем переподключение.');
            reconnectWithDelay(200); // Небольшая задержка после таймаута
        } else {
            widgetLog('[WS CONNECT] Таймаут соединения, лимит попыток исчерпан.', 'error');
            isReconnecting = false;
            connectionFailedPermanently = true;
            if (isWidgetOpen) {
                showConnectionError("Не удалось подключиться (таймаут). Проверьте интернет.");
                updateConnectionStatus('disconnected', 'Таймаут');
            }
        }
      }, CONNECTION_TIMEOUT);
      
      websocket.onopen = function() {
        clearTimeout(connectionTimeoutId); // Отменяем таймаут соединения
        connectionTimeoutId = null;
        widgetLog('[WS OPEN] WebSocket соединение установлено успешно.');
        isConnected = true;
        isReconnecting = false; // Успешно (пере)подключились
        reconnectAttempts = 0;  // Сбрасываем счетчик попыток
        connectionFailedPermanently = false; // Сбрасываем флаг окончательной неудачи
        
        if (loaderModal) loaderModal.classList.remove('active'); // Скрываем лоадер
        hideConnectionError(); // Скрываем сообщение об ошибке, если было
        
        lastPingTime = Date.now(); // Инициализируем время последнего пинга
        lastPongTime = Date.now(); // Инициализируем время последнего понга
        
        const currentPingIntervalMs = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
        
        // Запускаем интервал для отправки ping'ов
        if (pingIntervalId) clearInterval(pingIntervalId); // Очищаем старый, если был
        pingIntervalId = setInterval(() => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            try {
              websocket.send(JSON.stringify({ type: "ping" }));
              lastPingTime = Date.now();
              // widgetLog('Ping sent'); // Слишком частый лог, можно убрать
              
              // Проверяем, не было ли ответа (pong) слишком долго
              // Увеличиваем множитель для большей устойчивости к кратковременным задержкам сети
              if (Date.now() - lastPongTime > currentPingIntervalMs * 3.5) { 
                widgetLog(`[PING TIMEOUT] Не получен pong более ${currentPingIntervalMs * 3.5 / 1000} сек. Закрываем соединение.`, "warn");
                // Закрываем сокет. Обработчик onclose должен будет вызвать reconnectWithDelay.
                // Убираем обработчики, чтобы избежать двойного вызова reconnectWithDelay, если onclose сработает медленно
                if (websocket) {
                    websocket.onclose = null; // Временно отключаем onclose
                    websocket.onerror = null;
                    websocket.close(1006, "Ping timeout"); // 1006 - Abnormal Closure
                }
                // Искусственно вызываем логику закрытия, если onclose не сработает
                handleWebSocketClosure({ code: 1006, reason: "Ping timeout", wasClean: false });
              }
            } catch (e) {
              widgetLog(`[PING] Ошибка отправки ping: ${e.message}`, "error");
              // Если отправка ping не удалась, это может означать проблемы с соединением
              if (websocket) {
                websocket.onclose = null;
                websocket.onerror = null;
                websocket.close(1006, "Ping send error");
              }
              handleWebSocketClosure({ code: 1006, reason: "Ping send error", wasClean: false });
            }
          } else {
            // Если WebSocket уже не OPEN, но интервал еще работает (маловероятно, но возможно)
            widgetLog("[PING] WebSocket не в состоянии OPEN. Очистка ping интервала.", "warn");
            if (pingIntervalId) clearInterval(pingIntervalId);
            pingIntervalId = null;
            // Если соединение было, но оборвалось без onclose, пытаемся переподключиться
            if (isConnected && !isReconnecting) { // isConnected еще может быть true
                isConnected = false; // Обновляем состояние
                reconnectWithDelay(200); // Инициируем переподключение
            }
          }
        }, currentPingIntervalMs);

        if (isWidgetOpen) {
          showMessage("Соединение установлено!", 3000);
          updateConnectionStatus('connected', 'Подключено');
          // Если виджет открыт, пытаемся начать слушать
          setTimeout(() => { // Небольшая задержка для стабилизации
            if (isWidgetOpen && !isListening && !window.isPlayingAudio && window.audioInitialized) {
              startListening();
            } else if (isWidgetOpen && !window.audioInitialized) {
                widgetLog('[WS OPEN] Соединение есть, но аудио не инициализировано. Ожидание открытия виджета/инициализации аудио.', 'info');
            }
          }, 500);
        }
        // Возвращаем true в Promise, если connectWebSocket вызывался как async
        // Для совместимости с .then() если он используется
      }; // Конец websocket.onopen
      
      websocket.onmessage = function(event) {
        lastPongTime = Date.now(); // Любое сообщение от сервера сбрасывает таймер pong
        let messageData;
        try {
          messageData = JSON.parse(event.data);
        } catch (e) {
          widgetLog(`[WS MSG] Ошибка парсинга JSON сообщения: ${e.message}. Данные: ${event.data}`, "error");
          return; // Прерываем обработку этого сообщения
        }

        // widgetLog(`[WS MSG] Получено сообщение типа: ${messageData.type}`); // Частый лог
        // if (DEBUG_MODE && messageData.type !== "pong") { // Не логируем pong в деталях
        //   console.log('[WellcomeAI Widget] Full message:', messageData);
        // }

        switch (messageData.type) {
          case "pong":
            // Уже обработано обновлением lastPongTime выше
            // widgetLog("Pong received"); // Слишком частый лог
            break;
          case "audio_chunk.response": // Ответ с аудио чанком и/или текстом
            if (messageData.audio_base64) {
              addAudioToPlaybackQueue(messageData.audio_base64);
            }
            if (messageData.text && messageData.text.trim() !== "") {
               // Показываем промежуточный текст без автоскрытия, если ассистент еще говорит
               // или если это единственный текст.
               const duration = (messageData.is_final_text || !interruptionState.is_assistant_speaking) ? 4000 : 0;
               showMessage(messageData.text, duration); 
            }
            break;
          case "text_response.final": // Финальный текстовый ответ (может быть без аудио)
            if (messageData.text && messageData.text.trim() !== "") {
              showMessage(messageData.text, 5000); // Показываем на 5 секунд
            }
            // Если это финальный текст, и ассистент не говорит, возможно, нужно обновить статус
            if (!interruptionState.is_assistant_speaking) {
                updateConnectionStatus('connected', 'Готов к ответу');
            }
            break;
          case "interruption_event": // Сервер сообщает о перебивании
            handleInterruptionEvent(messageData.data || {});
            break;
          case "speech_started_event": // Сервер определил начало речи пользователя
            handleSpeechStarted(messageData.data || {});
            break;
          case "speech_stopped_event": // Сервер определил конец речи пользователя
            handleSpeechStopped(messageData.data || {});
            break;
          case "assistant_speech_started_event": // Сервер сообщает, что ассистент начал говорить
            handleAssistantSpeechStarted(messageData.data || {});
            break;
          case "assistant_speech_ended_event": // Сервер сообщает, что ассистент закончил говорить
            handleAssistantSpeechEnded(messageData.data || {});
            break;
          case "status_update": // Общее обновление статуса от сервера
              if (messageData.status_key && messageData.message_text) {
                  updateConnectionStatus(messageData.status_key, messageData.message_text);
              } else if (messageData.message_text) {
                  showMessage(messageData.message_text, 3000);
              }
              break;
          case "error": // Сообщение об ошибке от сервера
            widgetLog(`[WS MSG] Ошибка от сервера: ${messageData.message || 'Нет деталей'}`, "error");
            showMessage(`Ошибка сервера: ${messageData.message || 'Попробуйте еще раз.'}`, 5000);
            // Можно также обновить статус UI
            updateConnectionStatus('disconnected', `Ошибка (${messageData.code || 'сервер'})`);
            // В зависимости от типа ошибки, можно решить, нужно ли закрывать соединение
            // if (messageData.is_fatal) { websocket.close(); }
            break;
          case "input_audio_buffer.cleared": // Подтверждение очистки буфера на сервере
            widgetLog("[WS MSG] Сервер подтвердил очистку буфера ввода.");
            // Клиентская логика очистки буфера уже должна быть выполнена при отправке команды
            hasAudioData = false; // Убедимся, что флаги сброшены
            audioDataStartTime = 0;
            break;
          case "response.cancelled": // Подтверждение отмены ответа на сервере
            widgetLog("[WS MSG] Сервер подтвердил отмену текущего ответа.");
            // Клиентская логика остановки воспроизведения и т.д. уже должна быть выполнена
            // stopAllAudioPlayback(); // Можно вызвать повторно для гарантии
            break;
          default:
            widgetLog(`[WS MSG] Получен неизвестный тип сообщения: ${messageData.type}`, "warn");
        }
        updateDebugPanel(); // Обновляем отладочную панель после каждого сообщения
      }; // Конец websocket.onmessage
      
      const handleWebSocketClosure = (event) => {
          clearTimeout(connectionTimeoutId); // Отменяем таймаут соединения, если он был активен
          connectionTimeoutId = null;
          widgetLog(`[WS CLOSE] WebSocket соединение закрыто. Код: ${event.code}, Причина: "${event.reason || 'Нет причины'}", Чисто: ${event.wasClean}`, event.wasClean ? "info" : "warn");
          
          isConnected = false;
          isReconnecting = false; // Сбрасываем флаг переподключения перед вызовом reconnectWithDelay
          
          if (loaderModal) loaderModal.classList.remove('active'); // Скрываем лоадер

          if (pingIntervalId) { // Очищаем интервал ping
            clearInterval(pingIntervalId);
            pingIntervalId = null;
          }

          // Останавливаем прослушивание и воспроизведение, если соединение потеряно
          if (isListening) {
            isListening = false;
            resetAudioVisualization();
            mainCircle.classList.remove('listening');
          }
          stopAllAudioPlayback(); // Остановка воспроизведения ассистента

          // Попытка переподключения, если закрытие было нечистым или по определенным кодам
          // 1000 - Normal Closure (обычно не требует переподключения, если инициировано клиентом)
          // 1001 - Going Away (например, закрытие вкладки, тоже не требует)
          // 1005 - No Status Rcvd (часто означает обрыв)
          // 1006 - Abnormal Closure (обрыв)
          // Другие коды могут требовать анализа
          if (event.code === 1000 && event.reason === "Client navigating away") {
            widgetLog("[WS CLOSE] Закрытие по причине навигации клиента. Переподключение не требуется.");
          } else if (event.code === 1000 && event.reason === "Connection reset by client") {
            widgetLog("[WS CLOSE] Закрытие по причине сброса клиентом. Переподключение не требуется (управляется resetConnection).");
          } else if (event.code !== 1000 && event.code !== 1001) { // Все, что не нормальное закрытие или уход
            widgetLog("[WS CLOSE] Нечистое или ненормальное закрытие. Попытка переподключения.");
            if (isWidgetOpen) { // Показываем статус только если виджет открыт
                updateConnectionStatus('disconnected', 'Соединение потеряно');
            }
            reconnectWithDelay(isMobile ? 700 : 500); // Начинаем переподключение с небольшой начальной задержкой
          } else {
            widgetLog("[WS CLOSE] Чистое закрытие WebSocket. Автоматическое переподключение не требуется.");
            if (isWidgetOpen) {
                updateConnectionStatus('disconnected', 'Отключено');
            }
            // Если это было чистое закрытие, но не по нашей инициативе (например, сервер закрыл),
            // возможно, все же стоит попытаться переподключиться, если виджет должен работать постоянно.
            // Это зависит от требований. Пока оставляем так.
          }
          updateDebugPanel();
      };

      websocket.onclose = handleWebSocketClosure;
      
      websocket.onerror = function(errorEvent) {
        // onerror часто предшествует onclose. Важно не дублировать логику переподключения.
        // Таймаут соединения уже должен быть очищен в onclose, если он сработает.
        // clearTimeout(connectionTimeoutId); connectionTimeoutId = null; // На всякий случай
        
        // Тип errorEvent может быть разным в браузерах, пытаемся получить сообщение
        const errorMessage = (errorEvent && errorEvent.message) ? errorEvent.message : 
                             (errorEvent && errorEvent.type === 'error' && websocket.readyState === WebSocket.CLOSED) ? 'WebSocket connection failed' : 
                             'Неизвестная ошибка WebSocket';
        widgetLog(`[WS ERROR] Ошибка WebSocket: ${errorMessage}`, "error");
        
        // isConnected и isReconnecting будут обновлены в onclose, который обычно следует за onerror.
        // Если onclose не сработает, то здесь нужно обновить состояние и попытаться переподключиться.
        // Однако, современнные браузеры почти всегда вызывают onclose после onerror.
        
        if (loaderModal) loaderModal.classList.remove('active');
        
        // Если WebSocket еще не закрыт, onclose обработает переподключение.
        // Если он уже закрыт, и onclose по какой-то причине не сработал или сработал некорректно,
        // то можно инициировать переподключение отсюда как крайнюю меру.
        if (websocket && websocket.readyState === WebSocket.CLOSED) {
            widgetLog('[WS ERROR] WebSocket уже закрыт при ошибке. Логика onclose должна была сработать.', 'warn');
            // Вызываем handleWebSocketClosure "искусственно", если onclose не сработал
            // Это рискованно, если onclose все же сработает позже.
            // Лучше положиться на то, что onclose будет вызван.
            // Если все же нужно, то:
            // handleWebSocketClosure({ code: 1006, reason: "Error then closed", wasClean: false });
        } else if (!websocket || websocket.readyState !== WebSocket.OPEN) {
            // Если сокет не открыт и не закрыт (например, еще CONNECTING, но произошла ошибка)
            // Это может быть случай, когда onclose не вызовется.
            // Пробуем закрыть его, чтобы инициировать onclose.
            if (websocket) {
                websocket.close(1006, "Error during connection");
            } else {
                // Если объекта websocket нет, но была ошибка (например, при new WebSocket)
                // Это должно было быть обработано в блоке try-catch вокруг new WebSocket.
                // Но для подстраховки:
                isConnected = false;
                isReconnecting = false;
                reconnectWithDelay(1000); // Попытка переподключения
            }
        }
        
        addToDebugQueue(`WebSocket error: ${errorMessage}`, 'error');
        updateDebugPanel();
      }; // Конец websocket.onerror

      return Promise.resolve(true); // Возвращаем Promise<true> для индикации успешного начала попытки подключения
    } // Конец connectWebSocket

    // Event Listeners для UI
    widgetButton.addEventListener('click', () => {
      if (widgetContainer.classList.contains('active')) {
        closeWidget();
      } else {
        openWidget();
      }
    });

    widgetClose.addEventListener('click', closeWidget);

    mainCircle.addEventListener('click', async () => {
      widgetLog(`[UI] Клик по главному кругу. isListening: ${isListening}, isPlayingAudio: ${window.isPlayingAudio}, isConnected: ${isConnected}`);
      
      // 1. Проверка и установка соединения, если его нет
      if (!isConnected && !isReconnecting) {
        showMessage("Подключение к серверу...", 0);
        updateConnectionStatus('connecting', 'Подключение...');
        await connectWebSocket(); // connectWebSocket обновит статус и покажет лоадер
        // Дальнейшие действия (startListening) произойдут в onopen, если виджет открыт
        return;
      }
      if (isReconnecting) {
        showMessage("Пожалуйста, подождите, идет переподключение...", 3000);
        return;
      }
      if (connectionFailedPermanently) {
          showConnectionError('Не удалось подключиться. Проверьте интернет или попробуйте позже.');
          // Кнопка retry уже должна быть с обработчиком
          return;
      }

      // 2. Инициализация аудио, если это необходимо
      if (!window.audioInitialized || !window.globalAudioContext || window.globalAudioContext.state !== 'running' || !window.globalMicStream || !window.globalMicStream.active) {
        widgetLog("[UI] Аудио не готово. Попытка инициализации по клику на круг.");
        loaderModal.classList.add('active');
        const audioInitSuccess = await initializeAudio();
        loaderModal.classList.remove('active');
        if (!audioInitSuccess) {
          showMessage("Ошибка инициализации аудио. Проверьте разрешения микрофона в браузере.", 5000);
          return;
        }
        // Если аудио успешно инициализировано, продолжаем логику клика ниже
      }
      
      // 3. Логика перебивания ассистента
      if (interruptionState.is_assistant_speaking || window.isPlayingAudio) {
        widgetLog("[UI] Пользователь кликнул во время речи ассистента - ИНТЕРПРЕТИРУЕМ КАК ПЕРЕБИВАНИЕ.");
        stopAllAudioPlayback(); // Останавливаем ассистента
        
        // Отправляем событие перебивания на сервер
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({
            type: "interruption.client_initiated", // Тип события перебивания по инициативе клиента
            timestamp: Date.now(),
            reason: "User clicked while assistant was speaking"
          }));
          widgetLog("[UI] Отправлено событие interruption.client_initiated на сервер.");
        }
        
        mainCircle.classList.add('interrupted'); // Показываем визуальное состояние перебивания
        showMessage("Вы перебили ассистента.", 2000);
        updateConnectionStatus('interrupted', 'Перебивание...');
        
        // Через некоторое время убираем 'interrupted' и, если все условия позволяют, начинаем слушать
        setTimeout(() => {
          mainCircle.classList.remove('interrupted');
          // Если виджет все еще открыт, соединение есть, и мы не играем аудио и не слушаем
          if (isWidgetOpen && isConnected && !window.isPlayingAudio && !isListening && !isReconnecting) {
            startListening();
          } else if (isWidgetOpen && isConnected && !window.isPlayingAudio && isListening) {
            // Если уже слушаем (маловероятно после перебивания, но для полноты)
            mainCircle.classList.add('listening');
          }
        }, 1000); // Время отображения "перебивания"
        return; // Завершаем обработку клика здесь
      }

      // 4. Переключение состояния прослушивания (старт/стоп)
      if (isListening) {
        widgetLog("[UI] Пользователь кликнул - ОСТАНОВКА прослушивания.");
        isListening = false; // Важно установить флаг до commitAudioBuffer
        resetAudioVisualization();
        mainCircle.classList.remove('listening');
        // Немедленно отправляем накопленный буфер, если есть что отправлять
        if (hasAudioData) { // hasAudioData проверяется внутри commitAudioBuffer
          commitAudioBuffer(); 
        }
        // Статус изменится на "Обработка..." после успешного commit или по событию от сервера
      } else if (isConnected && !window.isPlayingAudio && !isReconnecting) {
        // Если не слушаем, не играет аудио, есть соединение и не идет переподключение - НАЧИНАЕМ слушать
        widgetLog("[UI] Пользователь кликнул - НАЧАЛО прослушивания.");
        startListening();
      } else {
        // Логируем, почему не можем начать слушать (для отладки)
        widgetLog(`[UI] Клик по кругу, но не можем начать слушать: isConnected=${isConnected}, isPlayingAudio=${window.isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`);
        if (isReconnecting) showMessage("Переподключение, пожалуйста подождите...", 3000);
        // Сообщение "Ассистент говорит" уже должно быть обработано выше (перебивание)
        else if (!isConnected) showMessage("Нет соединения с сервером.", 3000);
      }
    });

    // Обработчик для кнопки "Повторить" в сообщении об ошибке соединения
    retryButton.addEventListener('click', () => {
        widgetLog('[UI] Нажата кнопка "Повторить подключение".');
        resetConnection(); // Вызываем функцию сброса и повторного подключения
        // resetConnection сама покажет нужные сообщения и статусы
    });

    // --- Начальная инициализация при загрузке скрипта ---
    
    // Проверка ID ассистента еще раз перед первой попыткой подключения (хотя уже есть выше)
    if (!ASSISTANT_ID) {
      widgetLog("CRITICAL: Assistant ID is null. Widget cannot function. (Final check in initWidget)", 'error');
      if (loaderModal) loaderModal.classList.remove('active'); // Убираем лоадер, если был
      // Можно дополнительно уведомить пользователя, если это еще не сделано
      return; // Полностью прекращаем работу виджета
    }
    
    // Первая попытка подключения к WebSocket
    // connectWebSocket сама управляет лоадером и статусами
    connectWebSocket().then(success => {
        if (success) { // success здесь означает, что попытка подключения была инициирована
            widgetLog("[INIT] Первая попытка подключения к WebSocket инициирована.");
            // Дальнейшее состояние (подключено/ошибка) будет обработано в onopen/onerror/onclose
        } else {
            // Это может произойти, если new WebSocket() выбросил исключение или ASSISTANT_ID был null
            widgetLog("[INIT] Первая попытка подключения к WebSocket не удалась на этапе инициации.", "error");
            // Логика переподключения должна была запуститься из connectWebSocket, если ошибка была там
            // Если виджет открыт по умолчанию, здесь можно показать ошибку.
        }
    }).catch(error => {
        // Сюда мы не должны попадать, если connectWebSocket правильно обрабатывает свои ошибки
        widgetLog(`[INIT] Непредвиденная ошибка при первой попытке подключения: ${error.message}`, "error");
        if (isWidgetOpen) showConnectionError("Ошибка при начальном подключении.");
        // Попытка переподключения, если это не было сделано
        if (!isReconnecting && !connectionFailedPermanently) {
            reconnectWithDelay(1000);
        }
    });

    // Начальное состояние кнопки виджета (пульсация, если нет соединения и виджет закрыт)
    // Проверяем через небольшую задержку, чтобы дать время на первую попытку подключения
    setTimeout(() => {
        if (!isConnected && !isWidgetOpen && !connectionFailedPermanently) {
            widgetButton.classList.add('wellcomeai-pulse-animation');
        }
    }, 1500); // Задержка, чтобы connectWebSocket успел отработать

    // Обработчик выгрузки страницы для корректного закрытия ресурсов
    window.addEventListener('beforeunload', () => {
        widgetLog("[SYSTEM] Событие beforeunload. Закрытие WebSocket и аудио ресурсов.");
        
        // Закрываем WebSocket соединение чисто
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.onclose = null; // Убираем обработчик, чтобы не было попыток переподключения
            websocket.close(1000, "Client navigating away"); // 1000 - нормальное закрытие
        }
        websocket = null; // Обнуляем ссылку
        
        // Останавливаем и отключаем аудио узлы
        if (audioProcessorNode) {
            audioProcessorNode.disconnect();
            audioProcessorNode.onaudioprocess = null;
            audioProcessorNode = null;
        }
        if (mediaStreamSourceNode) {
            mediaStreamSourceNode.disconnect();
            mediaStreamSourceNode = null;
        }

        // Останавливаем треки микрофона
        if (window.globalMicStream && window.globalMicStream.active) {
            window.globalMicStream.getTracks().forEach(track => track.stop());
            widgetLog("[SYSTEM] Треки микрофона остановлены.");
        }
        window.globalMicStream = null;
        
        // Закрываем AudioContext
        if (window.globalAudioContext && window.globalAudioContext.state !== 'closed') {
            window.globalAudioContext.close().then(() => {
                widgetLog("[SYSTEM] AudioContext успешно закрыт.");
            }).catch(e => widgetLog(`[SYSTEM] Ошибка при закрытии AudioContext: ${e.message}`, 'warn'));
        }
        window.globalAudioContext = null;
        window.audioInitialized = false; // Сбрасываем флаг инициализации аудио

        // Очищаем интервалы и таймауты
        if (pingIntervalId) clearInterval(pingIntervalId);
        if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
        if (window.reconnectTimeoutId) clearTimeout(window.reconnectTimeoutId);
    });

    // Обновляем отладочную панель в самом конце инициализации
    updateDebugPanel();

  } // --- Конец initWidget ---

  // --- Точка входа в скрипт ---
  // Ожидаем полной загрузки DOM перед инициализацией виджета,
  // чтобы все элементы были доступны.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      widgetLog("DOM полностью загружен. Инициализация виджета...");
      createStyles();       // 1. Создаем стили
      loadFontAwesome();    // 2. Загружаем иконки
      createWidgetHTML();   // 3. Создаем HTML структуру
      initWidget();         // 4. Инициализируем логику виджета
    });
  } else {
    // DOM уже загружен
    widgetLog("DOM уже загружен. Немедленная инициализация виджета...");
    createStyles();
    loadFontAwesome();
    createWidgetHTML();
    initWidget();
  }

})(); 
