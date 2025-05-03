(function() {
  // Настройки виджета
  const DEBUG_MODE = false; // Отключаем режим отладки в продакшене
  const MAX_RECONNECT_ATTEMPTS = 10; // Максимальное количество попыток переподключения (увеличено для надежности)
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 15; // Увеличенное количество попыток для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 25000; // Таймаут для установления соединения (в миллисекундах, немного увеличен)
  const MAX_DEBUG_ITEMS = 20; // Максимальное количество записей отладки

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
  // Эти флаги теперь будут более важны для отслеживания состояния аудио на iOS
  window.audioContextInitialized = false;
  window.tempAudioContext = null; // Используем один контекст для iOS, если возможно
  window.hasPlayedSilence = false; // Указывает, была ли попытка разблокировки аудио через воспроизведение

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
    updateDebugPanel(); // Обновляем панель при добавлении
  };

  // Получить отладочную информацию в виде строки
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  // Обновление отладочной панели (стабы для совместимости, можно расширить при необходимости)
  const updateDebugPanel = () => {
    // Функция отключена в производственном режиме
    if (!DEBUG_MODE) return;
    // Здесь может быть логика обновления UI-панели отладки, если она есть
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
      if (src && src.includes('widget.js')) { // Убедитесь, что 'widget.js' соответствует имени вашего файла
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
      // Если нет протокола, считаем, что это относительный путь или домен без протокола
      // Используем текущий протокол
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }
    
    // Если не нашли, используем fallback URL (хостинг Render)
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com'; // Замените на ваш актуальный fallback
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
    // Отображаем ошибку пользователю при отсутствии ID
    if (document.readyState !== 'loading') {
        alert('WellcomeAI Widget Error: Assistant ID not found. Please add data-assistantId attribute to the script tag or check console for details.');
    } else {
        // Откладываем alert, если DOM еще загружается
         document.addEventListener('DOMContentLoaded', () => {
             alert('WellcomeAI Widget Error: Assistant ID not found. Please add data-assistantId attribute to the script tag or check console for details.');
         });
    }
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
      // Добавляем обработку расстояния, если указано, например "bottom-right-30px"
      if (parts.length === 3) {
          position.distance = parts[2];
      }
      
      return position;
    }
  };

  // Определяем URL сервера и ID ассистента
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  
  // Формируем WebSocket URL с указанием ID ассистента
  const WS_URL = ASSISTANT_ID ? SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID : null;
  
  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID || 'Not Found'}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}-${WIDGET_POSITION.distance}`);
  widgetLog(`WebSocket URL: ${WS_URL || 'Not available'}`);
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
        -webkit-tap-highlight-color: transparent; /* Убираем подсветку при касании на мобильных */
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
        -webkit-backface-visibility: hidden; /* Потенциальное улучшение производительности на iOS */
        backface-visibility: hidden;
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
        position: absolute; /* Изменено с fixed на absolute для лучшей совместимости с Tilda */
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
        -webkit-tap-highlight-color: transparent;
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
        overflow: hidden; /* Важно для корректного отображения внутри */
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
        cursor: pointer; /* Добавляем курсор для кликабельности */
        -webkit-tap-highlight-color: transparent;
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
        background-color: rgba(255, 255, 255, 0.85); /* Увеличена непрозрачность */
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
        bottom: 20px; /* Изменено для пространства под iOS кнопку */
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
        max-height: 80px; /* Ограничение высоты */
        overflow-y: auto; /* Добавлен скролл */
        z-index: 10;
        pointer-events: none; /* Не мешает кликам по кругу */
      }
      
      .wellcomeai-message-display.show {
        opacity: 1;
        pointer-events: all; /* Снова активен при показе */
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
        z-index: 10; /* Поверх других элементов контента */
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
        -webkit-tap-highlight-color: transparent;
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
        background-color: rgba(255, 255, 255, 0.8);
        display: flex;
        align-items: center;
        gap: 5px;
        opacity: 0;
        transition: opacity 0.3s;
        z-index: 10; /* Поверх других элементов контента */
      }
      
      .wellcomeai-status-indicator.show {
        opacity: 0.9;
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
        bottom: 20px; /* Располагаем над индикатором статуса */
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
        display: none; /* Скрыта по умолчанию */
        z-index: 100;
        -webkit-tap-highlight-color: transparent;
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
    widgetContainer.style.zIndex = "2147483647"; // Убедимся, что виджет всегда поверх всего

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
          
          <!-- Специальная кнопка для активации аудио для iOS -->
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
            Нажмите для активации
          </button>
          
          <!-- Индикатор статуса -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Подключение...</span>
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

  // Функция для разблокировки аудио на iOS (или возобновления контекста)
  async function unlockAudioOnIOS() {
      if (!isIOS) {
          window.audioContextInitialized = true; // Считаем, что на не-iOS всегда инициализировано
          window.hasPlayedSilence = true; // И разблокировано
          return true;
      }

      // Если контекст уже инициализирован и активен, считаем разблокированным
      if (window.audioContextInitialized && window.tempAudioContext && window.tempAudioContext.state === 'running') {
          widgetLog('AudioContext уже активен на iOS, разблокировка не требуется');
          return true;
      }

      widgetLog('Попытка разблокировки/возобновления аудио на iOS');

      try {
          // Создаем контекст если его еще нет или он закрыт
          if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
              // Используем меньшую частоту дискретизации для iOS, если возможно
              const contextOptions = { sampleRate: 16000 };
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
              widgetLog(`Создан AudioContext на iOS с частотой ${window.tempAudioContext.sampleRate} Гц`);
          }

          const ctx = window.tempAudioContext;

          // Пробуем возобновить контекст, если он приостановлен
          if (ctx.state === 'suspended') {
              await ctx.resume();
              window.audioContextInitialized = true;
              widgetLog('AudioContext успешно возобновлен на iOS');
              // Проигрываем короткий тихий звук для полной гарантии разблокировки воспроизведения
              playSilence(ctx);
              return true;
          } else if (ctx.state === 'running') {
               window.audioContextInitialized = true;
               widgetLog('AudioContext уже в состоянии running на iOS');
               // Проигрываем короткий тихий звук для полной гарантии разблокировки воспроизведения
               playSilence(ctx);
               return true;
          } else {
              // Другие состояния (closed - обработано выше, starting - ждем)
              widgetLog(`AudioContext в состоянии: ${ctx.state}`);
               // Проигрываем короткий тихий звук для полной гарантии разблокировки воспроизведения
               playSilence(ctx);
               return true; // Надеемся, что воспроизведение тишины поможет
          }

      } catch (e) {
          widgetLog(`Ошибка при разблокировке/возобновлении AudioContext: ${e.message}`, 'error');
          window.audioContextInitialized = false; // Сброс флага при ошибке
          return false;
      }
  }

  // Воспроизведение тишины (для iOS разблокировки воспроизведения)
  function playSilence(ctx = window.tempAudioContext) {
      if (!ctx || ctx.state === 'closed' || window.hasPlayedSilence) return;

      try {
          const bufferSize = ctx.sampleRate * 0.01; // 10 мс тишины
          const silentBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
          const source = ctx.createBufferSource();
          source.buffer = silentBuffer;
          source.connect(ctx.destination);
          source.start();

          window.hasPlayedSilence = true; // Помечаем, что попытка была
          widgetLog("Проиграна тишина для разблокировки воспроизведения на iOS");

          // Очищаем флаг через некоторое время, чтобы можно было попробовать снова при необходимости
          setTimeout(() => { window.hasPlayedSilence = false; }, 5000);

      } catch (e) {
          widgetLog(`Ошибка при проигрывании тишины: ${e.message}`, 'warn');
      }
  }


  // Основная логика виджета
  function initWidget() {
    // Проверяем, что ID ассистента существует
    if (!ASSISTANT_ID || !WS_URL) {
      widgetLog("Assistant ID or WebSocket URL not found. Initialization aborted.", 'error');
      return; // Прекращаем инициализацию, если нет ID
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
    const retryButton = document.getElementById('wellcomeai-retry-button'); // Исходная кнопка в HTML
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');
    
    // Проверка элементов
    if (!widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !connectionError || !statusIndicator || !statusDot || !statusText || !iosAudioButton) {
      widgetLog("Some required UI elements were not found! Initialization aborted.", 'error');
      return;
    }
    
    // Переменные для обработки аудио
    let audioChunksBuffer = [];
    let audioPlaybackQueue = [];
    let isPlayingAudio = false;
    let hasAudioData = false; // Флаг, показывающий, что были записаны не-тихие аудиоданные
    let audioDataStartTime = 0; // Время начала записи не-тихих данных
    let minimumAudioLength = isMobile ? 500 : 300; // Минимальная длительность записанного звука для отправки
    let isListening = false;
    let websocket = null;
    let audioContext = null; // Ссылка на AudioContext (будет тем же, что и window.tempAudioContext на iOS)
    let mediaStream = null;
    let audioProcessor = null;
    let isConnected = false;
    let isWidgetOpen = false;
    let connectionFailedPermanently = false;
    let pingInterval = null;
    let lastPingTime = Date.now();
    let lastPongTime = Date.now();
    let connectionTimeout = null;
    
    // Конфигурация для оптимизации потока аудио - разные настройки для десктопа и мобильных
    // Эти значения могут потребовать тонкой настройки
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,      // Порог для определения тишины (от 0 до 1)
      silenceDuration: 400,        // Длительность тишины для отправки (мс)
      soundDetectionThreshold: 0.02 // Чувствительность к звуку для старта сегмента
    };
    
    // Специальные настройки для мобильных устройств (более терпимые к шуму и прерываниям)
    const MOBILE_AUDIO_CONFIG = {
      silenceThreshold: 0.015,      // Более высокий порог для мобильных
      silenceDuration: 600,         // Увеличенная длительность тишины
      soundDetectionThreshold: 0.015 // Менее чувствительное определение звука для старта
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
        statusDot.style.backgroundColor = '#10b981'; // green
      } else if (status === 'disconnected') {
        statusDot.classList.add('disconnected');
        statusDot.style.backgroundColor = '#ef4444'; // red
      } else { // connecting, idle, etc.
        statusDot.classList.add('connecting');
        statusDot.style.backgroundColor = '#f59e0b'; // yellow/orange
      }
      
      // Показываем индикатор только если виджет открыт ИЛИ есть ошибка
      if (isWidgetOpen || status === 'disconnected' || status === 'connecting') {
         statusIndicator.classList.add('show');
      } else {
         statusIndicator.classList.remove('show');
      }

      // Скрываем через некоторое время (кроме ошибок/подключения)
      if (status === 'connected') {
        setTimeout(() => {
          if (!isWidgetOpen) { // Скрываем только если виджет не открыт
             statusIndicator.classList.remove('show');
          }
        }, 3000);
      }
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
      widgetLog("Остановка всех аудио процессов");
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
        widgetLog("Отправка команд очистки буфера и отмены ответа на сервер");
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
      if (!messageDisplay) return;
      messageDisplay.textContent = message;
      messageDisplay.classList.add('show');
      
      // Если duration === 0, сообщение остается до явного скрытия
      if (duration > 0) {
        setTimeout(() => {
          hideMessage();
        }, duration);
      }
    }

    // Скрыть сообщение
    function hideMessage() {
      if (!messageDisplay) return;
      messageDisplay.classList.remove('show');
    }
    
    // Показать ошибку соединения
    function showConnectionError(message) {
      if (connectionError) {
        // Обновляем текст ошибки и добавляем кнопку
        connectionError.innerHTML = `
          ${message || 'Ошибка соединения с сервером'}
          <button class="wellcomeai-retry-button">
            Повторить подключение
          </button>
        `;
        connectionError.classList.add('visible');
        
        // Добавляем обработчик для новой кнопки повтора
        const newRetryButton = connectionError.querySelector('.wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', function() {
            widgetLog('Retry button clicked from error message');
            resetConnection();
          });
        }
        
        // Скрываем кнопку активации iOS, если она показана
        if (isIOS && iosAudioButton) {
            iosAudioButton.classList.remove('visible');
        }
      }
    }
    
    // Скрыть ошибку соединения
    function hideConnectionError() {
      if (connectionError) {
        connectionError.classList.remove('visible');
      }
    }
    
    // Сброс состояния соединения и попытка переподключения
    function resetConnection() {
      widgetLog("Сброс соединения и попытка переподключения...");
      // Закрываем существующее соединение принудительно
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
        websocket.close(1000, "Manual reset");
      }
      // Останавливаем все аудио процессы
      stopAllAudioProcessing();
      // Сбрасываем счетчик попыток и флаги
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      isReconnecting = false; // Устанавливается в true в connectWebSocket
      // Скрываем сообщение об ошибке
      hideConnectionError();
      // Показываем сообщение о повторном подключении
      showMessage("Попытка подключения...", 0); // Оставляем сообщение пока не подключится или не будет ошибки
      updateConnectionStatus('connecting', 'Подключение...');
      
      // Пытаемся подключиться заново
      connectWebSocket();
    }
    
    // Открыть виджет
    async function openWidget() {
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
      
      // Убираем пульсацию с кнопки
      widgetButton.classList.remove('wellcomeai-pulse-animation');
      
      // Скрываем сообщения и ошибки при открытии
      hideMessage();
      hideConnectionError();
      
      // Обновляем статус соединения
      updateConnectionStatus(isConnected ? 'connected' : (isReconnecting ? 'connecting' : 'disconnected'), isConnected ? 'Подключено' : (isReconnecting ? 'Переподключение...' : 'Отключено'));
      
      // Специальная обработка для iOS устройств - пытаемся разблокировать аудио
      if (isIOS) {
        widgetLog("Попытка разблокировки аудио на iOS при открытии виджета");
        await unlockAudioOnIOS(); // Ждем завершения попытки разблокировки
        
        // Если после попытки аудио не инициализировано, показываем кнопку
        if (!window.audioContextInitialized && iosAudioButton) {
            iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации", 0);
            widgetLog("iOS аудио не активировано, показываем кнопку активации");
            // Добавляем слушатель на кнопку активации iOS, если его еще нет
            if (!iosAudioButton.__hasClickListener) {
                iosAudioButton.addEventListener('click', handleIOSAudioButtonClick);
                iosAudioButton.__hasClickListener = true;
            }
        } else if (iosAudioButton) {
             iosAudioButton.classList.remove('visible'); // Скрываем кнопку, если аудио активировано
             hideMessage(); // Скрываем сообщение об активации, если оно было
             widgetLog("iOS аудио активировано или не требуется, скрываем кнопку");
        }
      }
      
      // Для других мобильных (Android) - инициализируем AudioContext если еще нет
      else if (isMobile && !window.audioContextInitialized) {
          try {
            if (!window.tempAudioContext) {
                window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                window.tempAudioContext.resume(); // На Android может потребовать resume после user interaction
            }
            window.audioContextInitialized = true;
            widgetLog("Mobile (Android) audio context initialized/resumed");
          } catch (e) {
            widgetLog(`Failed to initialize/resume mobile audio context: ${e.message}`, "error");
          }
      }

      // Запускаем прослушивание при открытии, если соединение активно и аудио готово
      // и мы не находимся в процессе воспроизведения или переподключения
      if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
          // На iOS проверяем, активировано ли аудио
          if (isIOS) {
              if (window.audioContextInitialized) {
                  widgetLog("iOS аудио активировано, запускаем прослушивание автоматически");
                  startListening();
              } else {
                  widgetLog("iOS аудио не активировано, не запускаем прослушивание автоматически");
                  // Сообщение об активации уже должно быть показано функцией unlockAudioOnIOS
              }
          } else {
               widgetLog("Не-iOS устройство, запускаем прослушивание автоматически");
               startListening();
          }
      } else {
        widgetLog(`Cannot auto-start listening: isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, audioInitialized=${window.audioContextInitialized} (if iOS)`);
        
        if (!isConnected && !isReconnecting && !connectionFailedPermanently) {
            // Если нет соединения и не идет переподключение, пробуем подключиться
            connectWebSocket();
        }
      }
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
      
      // Скрываем индикатор статуса, если нет ошибки соединения
      if (!connectionFailedPermanently) {
          if (statusIndicator) {
            statusIndicator.classList.remove('show');
          }
      } else {
          // Если ошибка соединения есть и виджет закрыт, показываем ошибку и пульсацию
          showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
          widgetButton.classList.add('wellcomeai-pulse-animation');
      }
      
      // Скрываем кнопку активации iOS
      if (iosAudioButton) {
        iosAudioButton.classList.remove('visible');
        iosAudioButton.removeEventListener('click', handleIOSAudioButtonClick);
        iosAudioButton.__hasClickListener = false;
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
        widgetLog("Инициализация аудио: Запрос разрешения на доступ к микрофону...");
        
        // Проверяем поддержку getUserMedia
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону");
        }
        
        // Проверяем, инициализирован ли AudioContext
        if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
             // Если на iOS, пробуем инициализировать через разблокировку
            if (isIOS) {
                await unlockAudioOnIOS();
            } else {
                // Для других устройств просто создаем новый
                const contextOptions = isMobile ? {} : { sampleRate: 24000 };
                window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
                window.audioContextInitialized = true;
                widgetLog(`Создан AudioContext (${isMobile ? 'Mobile' : 'Desktop'}) с частотой ${window.tempAudioContext.sampleRate} Гц`);
            }
        }

        // Устанавливаем audioContext как ссылку на tempAudioContext
        audioContext = window.tempAudioContext;

        // Если AudioContext не инициализирован после попытки (актуально для iOS), бросаем ошибку
        if (!audioContext || audioContext.state === 'closed') {
             throw new Error("Не удалось инициализировать AudioContext.");
        }

        // Возобновляем контекст, если он был приостановлен (может произойти на мобильных)
        if (audioContext.state === 'suspended') {
           widgetLog("Возобновление приостановленного AudioContext...");
           await audioContext.resume();
           window.audioContextInitialized = true;
           widgetLog("AudioContext успешно возобновлен.");
        }
        
        // Особые настройки для аудио в getUserMedia
        const audioConstraints = isIOS ? 
          { 
            echoCancellation: false, // На iOS лучше отключить
            noiseSuppression: true,
            autoGainControl: true
          } : 
          isMobile ? 
          { 
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          } :
          {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 24000 // Предпочитаемая частота
          };
        
        // Запрашиваем доступ к микрофону с оптимальными настройками
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Доступ к микрофону получен (${isIOS ? 'iOS настройки' : (isMobile ? 'Android настройки' : 'десктопные настройки')})`);
        } catch (micError) {
          widgetLog(`Ошибка доступа к микрофону с выбранными настройками: ${micError.message}`, 'warn');
          // Для iOS или других мобильных пробуем резервный вариант с базовыми настройками
           if (isMobile) {
             try {
               mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); // Простые настройки
               widgetLog('Доступ к микрофону получен с базовыми настройками для мобильных');
             } catch (baseMicError) {
                throw baseMicError; // Если и базовые не работают, бросаем ошибку
             }
           } else {
             throw micError; // Пробрасываем исходную ошибку для десктопов
           }
        }
        
        // Оптимизированные размеры буфера для разных устройств
        const bufferSize = isIOS ? 4096 : // Больше для iOS для стабильности
                          isMobile ? 2048 : // Немного больше для Android
                          2048;
        
        // Создаем AudioWorkletNode или ScriptProcessorNode
        // AudioWorklet предпочтительнее, но ScriptProcessor более совместим
        if (audioContext.audioWorklet) {
           try {
              await audioContext.audioWorklet.addModule(SERVER_URL + '/static/audio-processor.js'); // Путь к вашему AudioWorklet файлу
              audioProcessor = new AudioWorkletNode(audioContext, 'audio-processor', { bufferSize: bufferSize });
              widgetLog(`Создан AudioWorkletNode с размером буфера ${bufferSize}`);
              
              // Настраиваем обработчик в AudioWorklet
              audioProcessor.port.onmessage = (event) => {
                 if (event.data.type === 'audioData') {
                     handleAudioData(event.data.data);
                 } else if (event.data.type === 'volume') {
                     // Обработка уровня громкости для визуализации
                     updateAudioVisualizationFromVolume(event.data.volume);
                 }
              };
               // Отправляем параметры конфигурации в Worklet
               audioProcessor.port.postMessage({
                   type: 'config',
                   config: effectiveAudioConfig
               });

           } catch (e) {
              widgetLog(`Ошибка загрузки или создания AudioWorkletNode: ${e.message}. Возвращаемся к ScriptProcessorNode.`, 'warn');
              // Откат к ScriptProcessorNode
              audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
              widgetLog(`Создан устаревший ScriptProcessorNode с размером буфера ${bufferSize}`);
              audioProcessor.onaudioprocess = handleAudioProcess; // Назначаем обработчик
           }
        } else {
          // Используем ScriptProcessorNode как резервный вариант
          audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
          widgetLog(`Создан устаревший ScriptProcessorNode с размером буфера ${bufferSize}`);
          audioProcessor.onaudioprocess = handleAudioProcess; // Назначаем обработчик
        }
        
        // Подключаем обработчик
        const streamSource = audioContext.createMediaStreamSource(mediaStream);
        streamSource.connect(audioProcessor);
        
        // Для iOS и некоторых мобильных НЕ соединяем напрямую с выходом, чтобы избежать обратной связи
        // Вместо этого используем GainNode с нулевой громкостью
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0; // Установка громкости на ноль
        audioProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);
        widgetLog('Подключен GainNode с нулевой громкостью для предотвращения обратной связи');
        
        widgetLog("Аудио инициализировано успешно");
        return true;
      } catch (error) {
        widgetLog(`Ошибка инициализации аудио: ${error.message}`, "error");
        
        // Останавливаем медиа поток при ошибке
        if (mediaStream) {
          mediaStream.getTracks().forEach(track => track.stop());
          mediaStream = null;
        }

        // Закрываем аудио контекст при ошибке
        if (audioContext && audioContext.state !== 'closed') {
            try {
                audioContext.close();
            } catch (e) {
                 widgetLog(`Ошибка закрытия AudioContext после ошибки инициализации: ${e.message}`, "warn");
            }
            audioContext = null;
            window.tempAudioContext = null;
            window.audioContextInitialized = false;
        }
        
        // Особая обработка для iOS
        if (isIOS && iosAudioButton) {
           // Убеждаемся, что кнопка активации показана
           iosAudioButton.classList.add('visible');
           showMessage("Нажмите кнопку для активации микрофона", 0);
           if (!iosAudioButton.__hasClickListener) {
                iosAudioButton.addEventListener('click', handleIOSAudioButtonClick);
                iosAudioButton.__hasClickListener = true;
           }
        } else {
           // Для других устройств показываем общую ошибку микрофона
           showMessage("Ошибка доступа к микрофону. Проверьте настройки браузера и разрешения.");
        }
        
        return false;
      }
    }
    
    // Обработчик аудио для ScriptProcessorNode
    let silenceTimeoutId = null;
    let audioBuffer = [];
    let currentSegmentHasSound = false; // Флаг для текущего сегмента аудио

    function handleAudioProcess(e) {
        if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
            // Очищаем буфер, если не слушаем
            audioBuffer = [];
            currentSegmentHasSound = false;
            clearTimeout(silenceTimeoutId);
            silenceTimeoutId = null;
            return;
        }

        const inputBuffer = e.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);

        if (inputData.length === 0) {
            return;
        }

        // Вычисляем максимальную амплитуду
        let maxAmplitude = 0;
        for (let i = 0; i < inputData.length; i++) {
            maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
        }

        // Обновляем визуализацию
        updateAudioVisualizationFromVolume(maxAmplitude);

        // Определяем наличие звука
        const hasSound = maxAmplitude > effectiveAudioConfig.soundDetectionThreshold;

        if (hasSound) {
            // Если был звук, отменяем таймер тишины
            clearTimeout(silenceTimeoutId);
            silenceTimeoutId = null;
            currentSegmentHasSound = true; // Отмечаем, что в текущем сегменте есть звук
            
            // Активируем визуальное состояние прослушивания, если не воспроизводится аудио
            if (!mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking')) {
                mainCircle.classList.add('listening');
            }
        } else if (currentSegmentHasSound && silenceTimeoutId === null) {
             // Если тишина наступила после звука, запускаем таймер тишины
            silenceTimeoutId = setTimeout(commitAudioBuffer, effectiveAudioConfig.silenceDuration);
            widgetLog(`Тишина detected, committing buffer in ${effectiveAudioConfig.silenceDuration}ms`);
        }

        // Преобразуем float32 в int16 и добавляем в буфер
        const pcm16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            const sample = inputData[i];
            pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
        }
        audioBuffer.push(pcm16Data);

         // Отмечаем наличие аудиоданных (нужно для проверки минимальной длительности)
        if (!hasAudioData && hasSound) {
             hasAudioData = true;
             audioDataStartTime = Date.now();
             widgetLog("Начало записи не-тихих аудиоданных");
        } else if (!hasAudioData && Date.now() - audioDataStartTime > 5000 && !hasSound) {
            // Если долго нет звука, сбрасываем audioDataStartTime, чтобы не блокировать коммит коротким звуком потом
            audioDataStartTime = Date.now();
        }
    }
    
    // Обработчик данных из AudioWorklet (аналог handleAudioProcess)
    function handleAudioData(data) {
        if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
            audioBuffer = [];
            currentSegmentHasSound = false;
            clearTimeout(silenceTimeoutId);
            silenceTimeoutId = null;
            return;
        }

        // Применяем нормализацию для iOS, если нужно
        if (isIOS && data.maxAmplitude > 0 && data.maxAmplitude < 0.1) {
             const gain = Math.min(5, 0.3 / data.maxAmplitude);
             for (let i = 0; i < data.pcm16.length; i++) {
                 data.pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor((data.pcm16[i] / 32768) * gain * 32767)));
             }
        }

        // Определяем наличие звука из данных Worklet
        const hasSound = data.maxAmplitude > effectiveAudioConfig.soundDetectionThreshold;

        if (hasSound) {
            clearTimeout(silenceTimeoutId);
            silenceTimeoutId = null;
            currentSegmentHasSound = true;

             if (!mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking')) {
                mainCircle.classList.add('listening');
            }
        } else if (currentSegmentHasSound && silenceTimeoutId === null) {
             silenceTimeoutId = setTimeout(commitAudioBuffer, effectiveAudioConfig.silenceDuration);
              widgetLog(`Тишина detected (Worklet), committing buffer in ${effectiveAudioConfig.silenceDuration}ms`);
        }
        
        audioBuffer.push(data.pcm16);

        if (!hasAudioData && hasSound) {
            hasAudioData = true;
            audioDataStartTime = Date.now();
            widgetLog("Начало записи не-тихих аудиоданных (Worklet)");
        } else if (!hasAudioData && Date.now() - audioDataStartTime > 5000 && !hasSound) {
             audioDataStartTime = Date.now();
        }
    }

    // Обновление визуализации аудио из данных о громкости
    function updateAudioVisualizationFromVolume(volume) {
        const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
        const numBars = bars.length;
        // Используем текущий уровень громкости для всех баров или имитируем волну
        // Простая реализация: все бары имеют одинаковую высоту, пропорциональную громкости
        const baseHeight = 2; // Минимальная высота бара
        const maxDynamicHeight = 28; // Максимальное изменение высоты
        const volumeMultiplier = isMobile ? 150 : 100; // Множитель чувствительности
        const height = baseHeight + Math.min(maxDynamicHeight, Math.floor(volume * volumeMultiplier));

        bars.forEach((bar, index) => {
           // Можно добавить небольшие вариации для визуального эффекта
           const barHeight = height + Math.sin(index / (numBars - 1) * Math.PI) * (height * 0.2); // Небольшая волна
           bar.style.height = `${Math.max(baseHeight, barHeight)}px`;
        });
    }

    // Начало записи голоса
    async function startListening() {
      widgetLog(`Попытка начать прослушивание. State: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, audioInitialized=${window.audioContextInitialized} (iOS)`);
      
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
        widgetLog('Не удается начать прослушивание из-за текущего состояния.');
        // Обновляем UI, если необходимо
        if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
             if (mainCircle) {
                 mainCircle.classList.remove('listening');
                 mainCircle.classList.remove('speaking');
             }
             resetAudioVisualization();
             // Возможно, показать сообщение типа "Готов к прослушиванию" или что-то подобное
        }
        return;
      }
      
      isListening = true;
      widgetLog('Начинаем прослушивание...');
      
      // Если аудио еще не инициализировано, делаем это
      if (!audioContext) {
        const success = await initAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио', 'error');
          isListening = false; // Сбрасываем флаг, если инициализация не удалась
          return;
        }
      } else if (audioContext.state === 'suspended') {
        // Возобновляем AudioContext если он был приостановлен
        try {
          widgetLog('Попытка возобновить AudioContext...');
          await audioContext.resume();
          window.audioContextInitialized = true;
          widgetLog('AudioContext возобновлен успешно');
        } catch (error) {
          widgetLog(`Не удалось возобновить AudioContext: ${error}`, 'error');
          isListening = false; // Сбрасываем флаг
          
          // Для iOS показываем специальную кнопку, если виджет открыт
          if (isIOS && isWidgetOpen && iosAudioButton) {
            iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
             if (!iosAudioButton.__hasClickListener) {
                iosAudioButton.addEventListener('click', handleIOSAudioButtonClick);
                iosAudioButton.__hasClickListener = true;
             }
          } else if (isWidgetOpen) {
              // Для других устройств показываем общее сообщение
              showMessage("Ошибка микрофона. Попробуйте закрыть и открыть виджет.", 5000);
          }
          
          return; // Не можем начать слушать без активного контекста
        }
      } else if (audioContext.state === 'closed') {
          // Если контекст закрыт, нужна повторная инициализация
           widgetLog('AudioContext в состоянии "closed", требуется полная ре-инициализация.');
           audioContext = null; // Сбрасываем ссылку, чтобы initAudio создал новый
           window.tempAudioContext = null;
           window.audioContextInitialized = false;
           
           const success = await initAudio();
            if (!success) {
              widgetLog('Не удалось ре-инициализировать аудио', 'error');
              isListening = false;
              return;
            }
      }

       // Проверяем, что audioContext теперь активен и микрофон доступен
       if (!audioContext || audioContext.state !== 'running' || !mediaStream) {
           widgetLog('Аудио не готово к прослушиванию после инициализации/возобновления.', 'warn');
           isListening = false; // Не можем слушать, если аудио не готово
           // На iOS, если не готово, показываем кнопку активации
           if (isIOS && isWidgetOpen && iosAudioButton && !window.audioContextInitialized) {
               iosAudioButton.classList.add('visible');
               showMessage("Нажмите кнопку ниже для активации микрофона", 0);
                if (!iosAudioButton.__hasClickListener) {
                    iosAudioButton.addEventListener('click', handleIOSAudioButtonClick);
                    iosAudioButton.__hasClickListener = true;
                }
           } else if (isWidgetOpen) {
               // Общее сообщение об ошибке
                showMessage("Ошибка микрофона. Попробуйте закрыть и открыть виджет.", 5000);
           }
           return;
       }

      // Сбрасываем флаги аудио данных и буфер
      hasAudioData = false;
      audioDataStartTime = Date.now(); // Считаем время с момента начала попытки прослушивания
      audioBuffer = []; // Очищаем буфер
      currentSegmentHasSound = false; // Сбрасываем флаг сегмента
      clearTimeout(silenceTimeoutId); // Очищаем таймер тишины на всякий случай
      silenceTimeoutId = null;
      
      // Отправляем команду для очистки буфера ввода на сервере
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        widgetLog("Отправка команды clear input buffer");
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
      }
      
      // Активируем визуальное состояние прослушивания
      if (mainCircle && !isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
      
      // Скрываем кнопку активации iOS, если она была показана
      if (iosAudioButton) {
          iosAudioButton.classList.remove('visible');
          iosAudioButton.removeEventListener('click', handleIOSAudioButtonClick);
          iosAudioButton.__hasClickListener = false;
      }
      // Скрываем сообщение об активации
      hideMessage();

       widgetLog('Прослушивание активно');
    }
    
    // Функция для отправки аудиобуфера (вызывается по таймауту тишины)
    function commitAudioBuffer() {
      widgetLog("Попытка отправить аудиобуфер...");
      clearTimeout(silenceTimeoutId); // Очищаем таймер, чтобы избежать повторных вызовов
      silenceTimeoutId = null;

      if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
          widgetLog("Не отправляем буфер: не слушаем, нет WS или переподключение", "warn");
          audioBuffer = []; // Очищаем буфер, если не отправляем
          currentSegmentHasSound = false;
          hasAudioData = false;
          audioDataStartTime = 0;
          return;
      }
      
      // Проверяем, был ли звук в текущем сегменте
      if (!currentSegmentHasSound) {
           widgetLog("В текущем сегменте не было звука, не отправляем пустой буфер.", "warn");
            // Начинаем новый сегмент
           audioBuffer = [];
           currentSegmentHasSound = false;
           hasAudioData = false; // Сбрасываем флаг наличия данных
           audioDataStartTime = Date.now(); // Обновляем время начала сегмента
           // Возвращаемся в состояние прослушивания без ожидания
           if (mainCircle && !isPlayingAudio) {
               mainCircle.classList.add('listening');
               mainCircle.classList.remove('speaking');
           }
           return;
      }

      // Проверяем минимальную длительность аудио с момента *начала записи не-тихих данных*
      const recordedDuration = Date.now() - audioDataStartTime;
      if (recordedDuration < minimumAudioLength) {
        widgetLog(`Записанный сегмент слишком короткий (${recordedDuration}мс < ${minimumAudioLength}мс), не отправляем. Продолжаем слушать.`, "warn");
        // Буфер НЕ очищаем, продолжаем писать в него. Таймер тишины будет запущен снова, когда наступит тишина.
        // Флаг currentSegmentHasSound остается true, потому что звук был.
        // hasAudioData остается true.
        return; // НЕ отправляем
      }

      // Собираем буфер
      let totalLength = 0;
      audioBuffer.forEach(chunk => { totalLength += chunk.length; });
      const combinedBuffer = new Int16Array(totalLength);
      let offset = 0;
      audioBuffer.forEach(chunk => {
        combinedBuffer.set(chunk, offset);
        offset += chunk.length;
      });

      // Очищаем буфер после сборки
      audioBuffer = [];
      currentSegmentHasSound = false; // Сбрасываем флаг для нового сегмента
      hasAudioData = false; // Сбрасываем флаг наличия данных для нового сегмента
      audioDataStartTime = Date.now(); // Обновляем время начала записи для нового сегмента

      widgetLog(`Отправка аудиобуфера (${combinedBuffer.byteLength} байт, ${recordedDuration}мс recorded duration)`);

      // Сбрасываем эффект активности
      if (mainCircle) {
        mainCircle.classList.remove('listening');
      }

      // Отправляем команду для завершения буфера
      try {
          websocket.send(JSON.stringify({
            type: "input_audio_buffer.commit",
            event_id: `commit_${Date.now()}`,
            // Отправляем аудио отдельно бинарными данными
            // audio: arrayBufferToBase64(combinedBuffer.buffer) // Если отправляем через JSON
          }));

           // Отправляем бинарные данные следом, если это поддерживается сервером
           websocket.send(combinedBuffer.buffer);

      } catch (error) {
          widgetLog(`Ошибка отправки команды commit или аудио данных: ${error.message}`, "error");
          // При ошибке отправки WS, возможно, нужно переподключиться
          if (websocket.readyState === WebSocket.CLOSED || websocket.readyState === WebSocket.CLOSING) {
              widgetLog("WS закрыт при попытке отправки, запускаем переподключение");
              // Ручной запуск переподключения, если WS уже закрыт
              if (!isReconnecting) {
                  reconnectWithDelay(100); // Быстрое переподключение
              }
          }
          // В любом случае, останавливаем прослушивание, пока не восстановим соединение/состояние
          isListening = false;
          if (mainCircle) {
              mainCircle.classList.remove('listening');
              mainCircle.classList.remove('speaking');
          }
          resetAudioVisualization();
      }
    }
    
    // Преобразование ArrayBuffer в Base64 (может не использоваться, если отправляем бинарно)
    function arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
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
      const baseHeight = 2; // px
      const maxDynamicHeight = 28; // px
      const volumeMultiplier = isMobile ? 150 : 100; // Увеличенная чувствительность для мобильных
      
      for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          const index = i * step + j;
          if (index < audioData.length) {
            sum += Math.abs(audioData[index]);
          }
        }
        const average = sum / step;
        
        const height = baseHeight + Math.min(maxDynamicHeight, Math.floor(average * volumeMultiplier));
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
    
    // Создаём простой WAV из PCM данных (для воспроизведения в браузере)
    function createWavFromPcm(pcmBuffer, sampleRate) {
      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const blockAlign = numChannels * bitsPerSample / 8;
      
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      
      // RIFF chunk
      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + pcmBuffer.byteLength, true);
      writeString(view, 8, 'WAVE');
      
      // FMT chunk
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true); // Subchunk1Size
      view.setUint16(20, 1, true);  // AudioFormat (1 is PCM)
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitsPerSample, true);
      
      // DATA chunk
      writeString(view, 36, 'data');
      view.setUint32(40, pcmBuffer.byteLength, true);
      
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      
      return wavBuffer;

      function writeString(view, offset, string) {
          for (let i = 0; i < string.length; i++) {
              view.setUint8(offset + i, string.charCodeAt(i));
          }
      }
    }
    
    // Воспроизведение следующего аудио в очереди
    async function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        isPlayingAudio = false;
        if (mainCircle) {
          mainCircle.classList.remove('speaking');
        }
        
        // Если виджет открыт И соединение активно И не переподключаемся,
        // автоматически возвращаемся в режим прослушивания
        if (isWidgetOpen && isConnected && !isReconnecting) {
            widgetLog("Очередь воспроизведения пуста, виджет открыт, WS активен. Попытка вернуться в режим прослушивания.");
            // На iOS, перед стартом прослушивания, снова пробуем разблокировать/возобновить аудиоконтекст
            if (isIOS) {
                widgetLog("iOS: Повторная попытка разблокировки аудио перед startListening");
                 await unlockAudioOnIOS();
                 // Запускаем прослушивание, только если аудиоконтекст активен
                 if (window.audioContextInitialized) {
                    startListening();
                 } else if (isWidgetOpen && iosAudioButton) {
                     // Если не удалось, показываем кнопку активации iOS
                    iosAudioButton.classList.add('visible');
                    showMessage("Нажмите кнопку ниже для активации", 0);
                    if (!iosAudioButton.__hasClickListener) {
                        iosAudioButton.addEventListener('click', handleIOSAudioButtonClick);
                        iosAudioButton.__hasClickListener = true;
                    }
                 }
            } else {
                 // Для не-iOS устройств просто запускаем прослушивание
                 startListening();
            }
        } else {
             widgetLog("Очередь воспроизведения пуста. Не возвращаемся в режим прослушивания (widgetOpen=" + isWidgetOpen + ", isConnected=" + isConnected + ", isReconnecting=" + isReconnecting + ")");
              // Если виджет закрыт, возможно, хотим показать пульсацию на кнопке, что есть новый ответ
             if (!isWidgetOpen) {
                 widgetButton.classList.add('wellcomeai-pulse-animation');
             }
        }
        return;
      }
      
      isPlayingAudio = true;
      if (mainCircle) {
        mainCircle.classList.add('speaking');
        mainCircle.classList.remove('listening');
      }
      
      const audioBase64 = audioPlaybackQueue.shift();
      
      try {
        const audioDataBuffer = base64ToArrayBuffer(audioBase64);
        if (audioDataBuffer.byteLength === 0) {
          widgetLog("Получены пустые аудио данные для воспроизведения", "warn");
          playNextAudio(); // Переходим к следующему аудио
          return;
        }

        // Создаем AudioContext для воспроизведения, если он еще не создан или закрыт
        // На iOS используем тот же window.tempAudioContext
        if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
             await unlockAudioOnIOS(); // Попытка создать/возобновить контекст
             if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
                  widgetLog("Не удалось создать/возобновить AudioContext для воспроизведения.", "error");
                   playNextAudio(); // Не можем воспроизвести, переходим к следующему
                   return;
             }
        }
        const ctx = window.tempAudioContext; // Используем tempAudioContext
        
        // Возобновляем контекст перед декодированием и воспроизведением
        if (ctx.state === 'suspended') {
             widgetLog("Возобновление приостановленного AudioContext перед воспроизведением...");
             try {
                await ctx.resume();
                window.audioContextInitialized = true;
                widgetLog("AudioContext успешно возобновлен для воспроизведения.");
             } catch (e) {
                 widgetLog(`Не удалось возобновить AudioContext для воспроизведения: ${e.message}`, "error");
                 playNextAudio(); // Не можем воспроизвести, переходим к следующему
                 return;
             }
        }


        // Декодируем аудио данные
        ctx.decodeAudioData(audioDataBuffer, 
          function(audioBuffer) {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);

            source.onended = function() {
              widgetLog("Воспроизведение аудио завершено");
              playNextAudio(); // Воспроизводим следующее
            };

            // Начинаем воспроизведение
            source.start(0);
             widgetLog("Начато воспроизведение аудио");

          },
          function(e) {
            widgetLog(`Ошибка декодирования аудио данных: ${e}`, "error");
            playNextAudio(); // Ошибка декодирования, переходим к следующему
          }
        );

      } catch (error) {
        widgetLog(`Общая ошибка воспроизведения аудио: ${error.message}`, "error");
        playNextAudio(); // Ошибка, переходим к следующему
      }
    }
    
    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') {
          widgetLog("Попытка добавить некорректные аудио данные в очередь", "warn");
          return;
      }
      
      // Добавляем аудио в очередь
      audioPlaybackQueue.push(audioBase64);
      widgetLog(`Аудио добавлено в очередь. Очередь: ${audioPlaybackQueue.length} элементов.`);
      
      // Если не запущено воспроизведение, запускаем
      if (!isPlayingAudio) {
          widgetLog("Воспроизведение не активно, запускаем playNextAudio.");
          playNextAudio();
      } else {
          widgetLog("Воспроизведение уже активно, аудио будет добавлено в конец очереди.");
      }
    }
    
    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      // Проверяем, не превышено ли максимальное количество попыток
      // Используем разное значение для мобильных и десктопных устройств
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
      
      if (reconnectAttempts >= maxAttempts) {
        widgetLog('Maximum reconnection attempts reached. Connection failed permanently.', 'error');
        isReconnecting = false;
        connectionFailedPermanently = true;
        
        // Останавливаем все аудио процессы
        stopAllAudioProcessing();

        // Показываем сообщение пользователю об ошибке
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение с сервером. Пожалуйста, попробуйте перезагрузить страницу.");
          updateConnectionStatus('disconnected', 'Отключено');
        } else {
          // Если виджет закрыт, добавляем пульсацию на кнопку
          widgetButton.classList.add('wellcomeai-pulse-animation');
           updateConnectionStatus('disconnected', 'Отключено'); // Показываем статус возле кнопки
        }
        return;
      }
      
      if (isReconnecting) {
          widgetLog("Уже идет переподключение, игнорируем новый запрос.");
          return; // Избегаем множественных попыток переподключения
      }

      isReconnecting = true;
      
      // Показываем сообщение пользователю, если виджет открыт
      if (isWidgetOpen) {
        showMessage("Соединение прервано. Переподключение...", 0);
        updateConnectionStatus('connecting', 'Переподключение...');
        hideConnectionError(); // Скрываем предыдущую ошибку, если она была
      } else {
         // Если виджет закрыт, просто обновляем статус
         updateConnectionStatus('connecting', 'Переподключение...');
         // Оставляем или добавляем пульсацию, чтобы показать проблему
          widgetButton.classList.add('wellcomeai-pulse-animation');
      }

      // Если задана начальная задержка, используем ее, иначе экспоненциальная
      const delay = initialDelay > 0 ? 
                initialDelay : 
                isMobile ? 
                    Math.min(20000, Math.pow(1.5, reconnectAttempts) * 1000) : // более короткая экспоненциальная задержка
                    Math.min(45000, Math.pow(2, reconnectAttempts) * 1000);
      
      reconnectAttempts++;
      
      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);
      
      // Пытаемся переподключиться с увеличивающейся задержкой
      setTimeout(() => {
        if (isReconnecting) { // Проверяем флаг снова внутри таймаута
           widgetLog(`Выполняем попытку переподключения ${reconnectAttempts}/${maxAttempts}`);
           connectWebSocket().then(success => {
            // Логика успешного подключения перенесена в onopen
           }).catch(() => {
              // Ошибки при установлении соединения обрабатываются в onerror/ontimeout
              // isReconnecting сбрасывается в connectWebSocket или его таймауте/ошибке
           });
        } else {
            widgetLog("Переподключение было отменено до выполнения таймаута.");
        }
      }, delay);
    }
    
    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
          widgetLog("WebSocket уже открыт или подключается, игнорируем новый запрос.");
          return false; // Соединение уже активно или в процессе
      }
      
      if (!WS_URL) {
          widgetLog("WebSocket URL не определен, подключение невозможно.", "error");
          connectionFailedPermanently = true;
          if (isWidgetOpen) {
              showConnectionError("Ошибка конфигурации виджета: ID ассистента не найден.");
              updateConnectionStatus('disconnected', 'Отключено');
          } else {
               widgetButton.classList.add('wellcomeai-pulse-animation');
               updateConnectionStatus('disconnected', 'Отключено');
          }
          loaderModal.classList.remove('active');
          return false;
      }

      widgetLog("Инициирую подключение к WebSocket...");
      isReconnecting = true; // Устанавливаем флаг начала переподключения
      loaderModal.classList.add('active'); // Показываем лоадер
      hideConnectionError(); // Скрываем ошибку, если она была
      if (isWidgetOpen) {
         showMessage("Подключение...", 0); // Показываем сообщение пользователю, если виджет открыт
         updateConnectionStatus('connecting', 'Подключение...');
      } else {
          updateConnectionStatus('connecting', 'Подключение...'); // Показываем статус возле кнопки
      }

      // Очищаем предыдущее соединение, если оно существует
      if (websocket) {
        try {
          websocket.close(1000, "New connection attempt");
        } catch (e) {
          // Игнорируем ошибки при закрытии
        }
        websocket = null;
      }
      
      // Очищаем предыдущий таймер ping
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      
      // Очищаем таймаут соединения
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      
      // Создаем новое WebSocket соединение
      websocket = new WebSocket(WS_URL);
      
      // Устанавливаем двоичный тип для эффективной передачи аудио
      websocket.binaryType = 'arraybuffer';
      
      // Устанавливаем таймаут на открытие соединения
      connectionTimeout = setTimeout(() => {
          widgetLog(`Время ожидания соединения (${CONNECTION_TIMEOUT}ms) превышено`, "error");
          if (websocket && websocket.readyState === WebSocket.CONNECTING) {
              websocket.close(1000, "Connection timeout"); // Закрываем, чтобы вызвать onclose
          } else {
              // Если состояние не CONNECTING, возможно onclose уже был вызван
              // Просто вызываем логику переподключения
               isReconnecting = false; // Сбрасываем флаг перед запуском
               reconnectWithDelay();
          }
          loaderModal.classList.remove('active');
      }, CONNECTION_TIMEOUT);
      
      websocket.onopen = function() {
        clearTimeout(connectionTimeout); // Отменяем таймаут
        widgetLog('WebSocket connection established successfully.');
        isConnected = true;
        isReconnecting = false; // Подключение успешно - сбрасываем флаг переподключения
        reconnectAttempts = 0; // Сбрасываем счетчик попыток
        connectionFailedPermanently = false;
        loaderModal.classList.remove('active');
        
        // Инициализируем переменные для ping/pong
        lastPingTime = Date.now();
        lastPongTime = Date.now();
        
        // Настраиваем интервал ping с разной частотой для мобильных и десктопных устройств
        const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
        
        // Запускаем ping для поддержания соединения
        if (pingInterval) clearInterval(pingInterval); // Очищаем старый интервал на всякий случай
        pingInterval = setInterval(() => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            try {
              websocket.send(JSON.stringify({ type: "ping" }));
              lastPingTime = Date.now();
              
              // Проверяем, получили ли мы pong за последнее время
              if (Date.now() - lastPongTime > pingIntervalTime * 4) { // Увеличено время ожидания pong
                widgetLog("Ping timeout: No pong received for an extended period.", "warn");
                // Пробуем переподключиться
                clearInterval(pingInterval);
                pingInterval = null;
                 if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.close(1000, "Ping timeout"); // Закрываем, чтобы вызвать onclose
                 } else {
                    // Если уже закрывается, запускаем логику переподключения
                     if (!isReconnecting) {
                        reconnectWithDelay(100);
                     }
                 }
              }
            } catch (e) {
              widgetLog(`Error sending ping: ${e.message}`, "error");
            }
          } else {
             // Если WS не OPEN, останавливаем пинг
             clearInterval(pingInterval);
             pingInterval = null;
          }
        }, pingIntervalTime);
        
        // Скрываем ошибку соединения, если она была показана
        hideConnectionError();
        
        // Обновляем статус соединения
        updateConnectionStatus('connected', 'Подключено');
        if (isWidgetOpen) {
            hideMessage(); // Скрываем сообщение "Подключение..." или "Переподключение..."
        }
        
        // Автоматически начинаем слушать если виджет открыт И аудио готово
        if (isWidgetOpen && !isPlayingAudio) {
            // На iOS проверяем, активировано ли аудио контекстом
            if (isIOS) {
                 if (window.audioContextInitialized) {
                    widgetLog("iOS аудио активировано при onopen, запускаем прослушивание.");
                     startListening();
                 } else {
                      widgetLog("iOS аудио не активировано при onopen, ожидаем действия пользователя.");
                      // Сообщение и кнопка активации iOS должны быть показаны openWidget()
                 }
            } else {
                // Для не-iOS устройств
                widgetLog("Не-iOS устройство при onopen, запускаем прослушивание.");
                startListening();
            }
        }
      };
      
      websocket.onmessage = function(event) {
          // Обновляем время последнего pong при получении любого сообщения
          lastPongTime = Date.now();

          // Проверка на возможные пинг-понг сообщения до парсинга JSON
          if (typeof event.data === 'string') {
              if (event.data === 'pong') {
                widgetLog("Получен pong-ответ");
                return; // Обработано
              }
          }

          // Обработка возможных бинарных данных (аудио chunk)
          if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
              // Если это бинарные данные, считаем это аудио чанком
              // На сервере нужно убедиться, что аудио отправляется как бинарные сообщения
              if (event.data instanceof Blob) {
                // Если это Blob, конвертируем в ArrayBuffer
                 const reader = new FileReader();
                 reader.onload = () => {
                    try {
                        // Предполагаем, что бинарные данные - это raw PCM 16bit
                        // В зависимости от сервера, это может быть WAV или другой формат
                        // Для воспроизведения в браузере, возможно, потребуется декодирование или создание WAV
                        // Если сервер отправляет raw PCM 16bit, то нужно добавить WAV заголовок
                        // Декодирование ArrayBuffer как base64 для воспроизведения, как раньше
                        // Этот путь обработки бинарных данных как base64 строк кажется менее вероятным
                        // Ожидаем, что сервер отправляет base64 строки для аудио chunk, а бинарные для чего-то другого, или наоборот
                        // Текущая логика addAudioToPlaybackQueue ожидает base64 строку.
                        // Если сервер отправляет БИНАРНЫЙ raw PCM, его нужно декодировать или преобразовать
                        // Пример декодирования (требует AudioContext):
                        if (audioContext && audioContext.state !== 'closed') {
                             audioContext.decodeAudioData(reader.result,
                                (buffer) => {
                                   // Можно добавить буфер в очередь или проиграть сразу
                                   widgetLog("Декодированы бинарные аудио данные (Blob)");
                                   // Для простоты, если сервер отправляет raw PCM, нужно добавить WAV заголовок
                                   // Или попросить сервер отправлять base64 строки или готовые WAV chunks
                                   // Предполагаем, что delta audio - это base64 строка
                                },
                                (e) => {
                                    widgetLog(`Ошибка декодирования бинарных аудио данных (Blob): ${e}`, "error");
                                }
                             );
                        } else {
                             widgetLog("Получены бинарные аудио данные (Blob), но AudioContext не готов для декодирования.");
                        }

                    } catch (e) {
                       widgetLog(`Ошибка обработки бинарных данных (Blob): ${e.message}`, "error");
                    }
                 };
                 reader.readAsArrayBuffer(event.data);
              } else { // ArrayBuffer
                  try {
                     widgetLog(`Получены бинарные аудио данные (ArrayBuffer) ${event.data.byteLength} байт.`);
                     // Этот ArrayBuffer может быть raw PCM.
                     // Его нужно либо декодировать для воспроизведения, либо добавить в буфер для сохранения файла,
                     // либо предполагать, что это именно те бинарные чанки, которые отправляет сервер для response.audio.delta
                     // Если сервер отправляет response.audio.delta как бинарные ArrayBuffer,
                     // нужно собрать их и потом декодировать/воспроизвести как одно целое
                     // Или изменить логику воспроизведения для работы с ArrayBuffer частями.
                     // Текущая логика воспроизведения собирает base64 строки и декодирует их.
                     // Пока оставляем логику, что response.audio.delta - это base64.
                     // Если это бинарный chunk, его нужно конвертировать в base64, если логика addAudioToPlaybackQueue ожидает base64
                     // const audioBase64 = arrayBufferToBase64(event.data);
                     // addAudioToPlaybackQueue(audioBase64);
                      widgetLog("Обработка бинарных данных как аудио чанка временно отключена, ожидается Base64 строка для response.audio.delta", "warn");
                  } catch (e) {
                       widgetLog(`Ошибка обработки бинарных данных (ArrayBuffer): ${e.message}`, "error");
                  }
              }
              return; // Обработано как бинарные данные
          }
          
          // Проверка на пустое сообщение (после проверки бинарных)
          if (typeof event.data !== 'string' || !event.data) {
             widgetLog("Получено пустое или нестроковое сообщение от сервера после проверки бинарных", "warn");
             return;
          }

          // Обработка текстовых сообщений (JSON)
          try {
            const data = JSON.parse(event.data);
            
            // Логирование всех типов сообщений для отладки (кроме частых)
            if (data.type !== 'input_audio_buffer.append' && data.type !== 'response.audio.delta') { // Не логируем частые сообщения
              widgetLog(`Получено сообщение типа: ${data.type || 'unknown'}, event_id: ${data.event_id || 'none'}`);
            }
            
            // Проверка на сообщение session.created и session.updated
            if (data.type === 'session.created' || data.type === 'session.updated') {
              // widgetLog(`Получена информация о сессии: ${data.type}`); // Логируется выше
              // Просто принимаем это сообщение, не требуется особая обработка
              return;
            }
            
            // Проверка на сообщение connection_status
            if (data.type === 'connection_status') {
              widgetLog(`Статус соединения от сервера: ${data.status} - ${data.message}`);
              // UI статус уже обновляется в onopen/onclose/onerror
              // Можно добавить дополнительную логику при необходимости
              return;
            }
            
            // Обработка ошибок
            if (data.type === 'error') {
              widgetLog(`Ошибка от сервера: ${data.error ? data.error.message : 'Неизвестная ошибка'}`, "error");
              // Особая обработка для ошибки пустого аудиобуфера
              if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                widgetLog("Сервер сообщил: пустой аудиобуфер отправлен. Вероятно, не было распознано речи.", "warn");
                 // Возвращаемся в режим прослушивания автоматически, если виджет открыт
                 if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                    widgetLog("Возвращаемся в режим прослушивания после ошибки пустого буфера.");
                     // Небольшая задержка перед перезапуском прослушивания
                     setTimeout(() => { startListening(); }, isMobile ? 800 : 500);
                 }
                 // Можем показать краткое сообщение, если нужно
                 // showMessage("Не удалось распознать речь. Пожалуйста, повторите.", 3000);
                return;
              }

               // Другие ошибки
               if (isWidgetOpen) {
                 showMessage(data.error ? data.error.message : 'Произошла ошибка на сервере', 5000);
               }
              return;
            } 
            
            // Обработка текстового ответа
            if (data.type === 'response.text.delta') {
              if (data.delta) {
                // Обновляем сообщение. Если это первый чанк, очищаем предыдущее.
                 if (messageDisplay.textContent === '' || !messageDisplay.classList.contains('show')) {
                      messageDisplay.textContent = data.delta;
                 } else {
                     messageDisplay.textContent += data.delta;
                 }
                messageDisplay.classList.add('show'); // Убедимся, что сообщение видно
                
                // Если виджет закрыт, добавляем пульсацию на кнопку
                if (!isWidgetOpen) {
                  widgetButton.classList.add('wellcomeai-pulse-animation');
                }
              }
              return;
            }
            
            // Завершение текста
            if (data.type === 'response.text.done') {
              widgetLog('Получено сообщение response.text.done');
              // После завершения текста, установим таймер на скрытие сообщения
              // Таймер на 5 секунд, если следующее сообщение не обновит его
              setTimeout(() => {
                 // Проверяем, не изменилось ли сообщение за это время
                 // (например, если пришел новый текстовый чанк или аудио началось)
                 // Простая проверка: если текст сообщения совпадает с тем, что было на момент таймаута, или пустое
                 // Или можно использовать флаг. Но пока просто скрываем.
                if (messageDisplay.classList.contains('show')) { // Убеждаемся, что оно все еще показывается
                   hideMessage();
                }
              }, 5000);
              return;
            }
            
            // Обработка аудио (delta audio chunk)
            if (data.type === 'response.audio.delta') {
              if (data.delta && typeof data.delta === 'string') { // Ожидаем base64 строку
                audioChunksBuffer.push(data.delta);
                // widgetLog(`Добавлен аудио чанк в буфер. Текущий размер буфера: ${audioChunksBuffer.length}`); // Слишком много логов
              } else {
                 widgetLog("Получен некорректный response.audio.delta (не base64 строка)", "warn");
              }
              return;
            }
            
            // Обработка аудио транскрипции (если сервер ее отправляет)
            if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
              // Здесь можно сохранить или отобразить транскрипцию аудио в отдельном элементе
              // Например, в будущем можно добавить поле для текстовой транскрипции
              // widgetLog(`Транскрипция: ${data.text || ''}`);
              return;
            }
            
            // Аудио готово для воспроизведения
            if (data.type === 'response.audio.done') {
              widgetLog('Получено сообщение response.audio.done');
              if (audioChunksBuffer.length > 0) {
                const fullAudio = audioChunksBuffer.join('');
                audioChunksBuffer = []; // Очищаем буфер после сборки
                widgetLog(`Собрано полное аудио (${fullAudio.length} base64 символов), добавляем в очередь.`);
                addAudioToPlaybackQueue(fullAudio); // Добавляем собранное аудио в очередь
              } else {
                 widgetLog("Получено response.audio.done, но буфер аудио чанков пуст.", "warn");
              }
              return;
            }
            
            // Ответ завершен
            if (data.type === 'response.done') {
              widgetLog('Получено сообщение response.done. Ответ агента завершен.');
              // Начинаем снова слушать автоматически, если виджет открыт И не воспроизводится аудио И не переподключаемся
              // Прослушивание начнется после завершения воспроизведения аудио очереди (playNextAudio)
              // Если аудио очереди нет (isPlayingAudio === false), playNextAudio вызовет startListening сразу.
              // Если аудио очередь есть, playNextAudio вызовет startListening после последнего звука.
              // Важно: playNextAudio уже содержит логику авто-старта прослушивания после завершения
              if (!isPlayingAudio) {
                 // Если аудио не воспроизводится (т.е. ответа не было или он был только текстом)
                 widgetLog("Response done, но аудио не воспроизводится. Запускаем playNextAudio для проверки очереди (она пуста) и авто-старта прослушивания.");
                 playNextAudio(); // Вызов playNextAudio когда очередь пуста приведет к старту listening
              } else {
                 widgetLog("Response done, аудио воспроизводится. Авто-старт прослушивания произойдет после завершения воспроизведения.");
              }

              // Убираем пульсацию с кнопки, если виджет был закрыт (ее уже не нужно привлекать)
              widgetButton.classList.remove('wellcomeai-pulse-animation');

              return;
            }
            
            // Если мы дошли до этой точки, у нас неизвестный тип сообщения
            widgetLog(`Неизвестный тип сообщения от сервера: ${data.type}`, "warn");
            
          } catch (parseError) {
            // Если не удалось распарсить JSON, просто логируем ошибку
            widgetLog(`Ошибка парсинга JSON сообщения: ${parseError.message}`, "warn");
            widgetLog(`Содержимое сообщения (начало): ${typeof event.data === 'string' ? event.data.substring(0, 200) : 'не строка'}...`, "debug");
          }
      };
        
      websocket.onclose = function(event) {
          widgetLog(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason || 'N/A'}, Clean: ${event.wasClean}.`);
          isConnected = false;
          isListening = false; // Остановка прослушивания при закрытии соединения
          
          // Очищаем интервал ping
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          
          // Останавливаем все аудио процессы
          stopAllAudioProcessing();

          // Не пытаемся переподключиться, если соединение было закрыто нормально или вручную
          if (event.wasClean || event.code === 1000 || event.code === 1001 || event.code === 1005) {
            isReconnecting = false;
            widgetLog('Clean WebSocket close, not attempting reconnection.');
             updateConnectionStatus('disconnected', 'Отключено');
            return;
          }
          
          widgetLog("WebSocket connection closed unexpectedly. Attempting reconnection...");
          isReconnecting = false; // Сбрасываем флаг перед запуском переподключения
          // Вызываем функцию переподключения с экспоненциальной задержкой
          reconnectWithDelay(1000); // Начинаем переподключение через 1 секунду
      };
        
      websocket.onerror = function(error) {
          widgetLog(`WebSocket error: ${error.message || error}`, 'error');
          isConnected = false;
          isListening = false; // Остановка прослушивания при ошибке
          
          // Очищаем интервал ping
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          
          // Останавливаем все аудио процессы
          stopAllAudioProcessing();

          // Ошибки обычно предшествуют закрытию (onclose), где происходит логика переподключения.
          // Но на всякий случай убедимся, что переподключение запускается.
           if (!isReconnecting && (websocket && websocket.readyState === WebSocket.CLOSED || websocket.readyState === WebSocket.CLOSING)) {
                widgetLog("WS в состоянии CLOSING/CLOSED после ошибки, запускаем переподключение.");
                reconnectWithDelay(500); // Быстрое переподключение
           } else if (!isReconnecting) {
               // Если WS не закрылся после ошибки, возможно, нужно его закрыть?
               // Или просто ждем onclose.
                widgetLog("WS не закрылся после ошибки, ожидаем onclose или таймаут.");
           }

           // Показываем ошибку пользователю
           if (isWidgetOpen) {
                showConnectionError("Ошибка связи с сервером. Попробуйте повторить.");
                 updateConnectionStatus('disconnected', 'Ошибка связи');
           } else {
                 // Если виджет закрыт, показываем индикатор ошибки и пульсацию
                  updateConnectionStatus('disconnected', 'Ошибка связи');
                  widgetButton.classList.add('wellcomeai-pulse-animation');
           }
      };
      
      return true; // Успешно инициировали попытку подключения
    }

    // Обработчик клика по кнопке активации iOS
    async function handleIOSAudioButtonClick() {
         widgetLog("iOS activation button clicked.");
         // Скрываем кнопку сразу
         if (iosAudioButton) {
            iosAudioButton.classList.remove('visible');
            iosAudioButton.removeEventListener('click', handleIOSAudioButtonClick);
            iosAudioButton.__hasClickListener = false;
         }
         // Показываем лоадер
         loaderModal.classList.add('active');

         // Пытаемся разблокировать/возобновить аудио и инициализировать микрофон
         const audioSuccess = await initAudio(); // initAudio включает в себя unlockAudioOnIOS

         // Скрываем лоадер
         loaderModal.classList.remove('active');

         if (audioSuccess) {
             widgetLog("iOS аудио успешно активировано/инициализировано через кнопку активации.");
             hideMessage(); // Скрываем сообщение об активации
             // Если виджет открыт и соединение активно, начинаем прослушивание
             if (isWidgetOpen && isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                 startListening();
             } else if (isWidgetOpen) {
                 // Если аудио инициализировано, но не можем начать слушать (например, нет WS)
                  showMessage(isConnected ? "Готов к прослушиванию" : "Ожидание соединения...", 3000);
             }
         } else {
              widgetLog("Не удалось активировать iOS аудио.", "error");
              // initAudio уже показал сообщение об ошибке микрофона и/или снова показал iOS кнопку
              if (isWidgetOpen && !iosAudioButton.classList.contains('visible')) {
                   // Если кнопка не показалась сама (например, другая ошибка), показываем общую
                   showMessage("Ошибка инициализации микрофона.", 5000);
              }
         }
    }


    // Добавляем обработчики событий для интерфейса
    // Главная кнопка виджета - открывает/закрывает
    widgetButton.addEventListener('click', async function(e) {
      widgetLog('Main widget button clicked');
      e.preventDefault();
      e.stopPropagation();
      
      if (isWidgetOpen) {
          closeWidget();
      } else {
           // Перед открытием, на iOS пытаемся разблокировать аудио
           if (isIOS) {
                widgetLog("iOS: Клик по основной кнопке, попытка разблокировки аудио перед открытием.");
                // Показываем лоадер пока разблокируется
                loaderModal.classList.add('active');
                await unlockAudioOnIOS(); // Ждем завершения попытки
                loaderModal.classList.remove('active');
                 widgetLog("iOS: Разблокировка аудио завершена.");
           }
           // Открываем виджет
           openWidget();
      }
    });

    // Кнопка закрытия виджета
    widgetClose.addEventListener('click', function(e) {
      widgetLog('Close button clicked');
      e.preventDefault();
      e.stopPropagation();
      closeWidget();
    });
    
    // Обработчик для основного круга (для ручного запуска распознавания голоса)
    // Оставляем его как резервный способ запуска прослушивания,
    // если автоматический старт не сработал или был прерван.
    mainCircle.addEventListener('click', async function() {
      widgetLog(`Main circle clicked. State: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isConnected=${isConnected}, audioInitialized=${window.audioContextInitialized} (iOS)`);
      
      // Если виджет открыт, не в режиме прослушивания, не воспроизводит аудио и не переподключается
      if (isWidgetOpen && !isListening && !isPlayingAudio && !isReconnecting) {
           // Показываем лоадер
           loaderModal.classList.add('active');

            // На iOS этот клик также поможет инициализировать аудио-контекст
            if (isIOS) {
                widgetLog("iOS: Клик по кругу, попытка разблокировки/инициализации аудио.");
                await unlockAudioOnIOS(); // Попытка разблокировки
                widgetLog("iOS: Разблокировка/инициализация аудио завершена после клика по кругу.");
            }
             loaderModal.classList.remove('active'); // Скрываем лоадер

            if (isConnected) {
                 // Если соединение активно, пробуем начать прослушивание
                 widgetLog("WS активен, пытаемся начать прослушивание после клика по кругу.");
                 startListening();
            } else if (connectionFailedPermanently) {
                // Если соединение перманентно упало, показываем ошибку
                 showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
            } else if (!isReconnecting) {
                // Если нет соединения и не идет переподключение, пробуем подключиться
                 widgetLog("WS неактивен и не переподключается, пытаемся подключиться после клика по кругу.");
                 connectWebSocket();
            }

      } else {
           widgetLog("Клик по кругу не привел к старту прослушивания из-за текущего состояния.");
      }
    });
    
    // Обработчик для iOS кнопки активации аудио (если она появляется)
    // Слушатель добавляется и удаляется динамически в openWidget и handleIOSAudioButtonClick
    // при необходимости показать/скрыть кнопку.

    // Обработчик для кнопки повторного подключения в сообщении об ошибке
    // Слушатель добавляется динамически в showConnectionError

    // Инициализируем WebSocket соединение при загрузке скрипта
    // Проверяем ASSISTANT_ID перед попыткой подключения
    if (ASSISTANT_ID) {
        connectWebSocket();
    } else {
        widgetLog("Assistant ID is missing, skipping initial WebSocket connection attempt.", "warn");
         // UI уже должен показать ошибку при отсутствии ID
        if (loaderModal) loaderModal.classList.remove('active');
    }
    
    // Проверка DOM и состояния после инициализации
    setTimeout(function() {
      widgetLog('DOM check after initialization timeout');
      
      // Проверяем видимость и z-index элементов
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      const widgetExpanded = document.getElementById('wellcomeai-widget-expanded');
      
      if (!widgetContainer) {
        widgetLog('Widget container not found in DOM after timeout!', 'error');
      } else {
        widgetLog(`Container z-index = ${getComputedStyle(widgetContainer).zIndex}`);
      }
      
      if (!widgetButton) {
        widgetLog('Button not found in DOM after timeout!', 'error');
      } else {
        widgetLog(`Button is visible = ${getComputedStyle(widgetButton).display !== 'none'}, z-index = ${getComputedStyle(widgetButton).zIndex}`);
         // Если нет соединения и не открыт виджет, добавляем пульсацию
         if (!isConnected && !isWidgetOpen && !connectionFailedPermanently) {
             widgetButton.classList.add('wellcomeai-pulse-animation');
             widgetLog("Добавлена пульсация на кнопку из-за отсутствия соединения при старте.");
         } else if (connectionFailedPermanently && !isWidgetOpen) {
             widgetButton.classList.add('wellcomeai-pulse-animation');
             widgetLog("Добавлена пульсация на кнопку из-за перманентной ошибки соединения.");
         }
      }
      
      if (!widgetExpanded) {
        widgetLog('Expanded widget not found in DOM after timeout!', 'error');
      } else {
         widgetLog(`Expanded widget visibility: opacity=${getComputedStyle(widgetExpanded).opacity}, height=${getComputedStyle(widgetExpanded).height}, pointer-events=${getComputedStyle(widgetExpanded).pointerEvents}`);
      }
      
      // Проверка соединения
      widgetLog(`Connection state = ${websocket ? websocket.readyState : 'No websocket'}`);
      widgetLog(`Status flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}, connectionFailedPermanently: ${connectionFailedPermanently}`);
      
      // Для мобильных устройств добавляем проверку аудио состояния
      if (isMobile) {
        widgetLog(`Mobile audio state: initialized=${window.audioContextInitialized}, hasPlayedSilence=${window.hasPlayedSilence}`);
        if (audioContext) {
          widgetLog(`AudioContext state=${audioContext.state}, sampleRate=${audioContext.sampleRate || 'N/A'}`);
        }
         if (iosAudioButton) {
            widgetLog(`iOS activation button visible = ${iosAudioButton.classList.contains('visible')}`);
         }
      }

      // Если нет соединения после таймаута и не в процессе переподключения, возможно, что-то пошло не так
      if (!isConnected && !isReconnecting && !connectionFailedPermanently) {
           widgetLog("Нет соединения и не идет переподключение после таймаута инициализации.", "warn");
           // Если нет видимой ошибки или лоадера, можно что-то показать
           if (!loaderModal.classList.contains('active') && !connectionError.classList.contains('visible')) {
               // Возможно, сервер недоступен сразу
                widgetLog("Предполагаемая проблема с доступностью сервера при первом подключении.");
                connectionFailedPermanently = true; // Считаем, что это перманентная ошибка
                if (isWidgetOpen) {
                     showConnectionError("Не удалось подключиться к серверу. Проверьте URL.");
                     updateConnectionStatus('disconnected', 'Отключено');
                } else {
                     updateConnectionStatus('disconnected', 'Отключено');
                     widgetButton.classList.add('wellcomeai-pulse-animation');
                }
           }
      }


    }, 5000); // Проверка через 5 секунд после загрузки скрипта
  }

  // Инициализируем виджет
  function initializeWidget() {
    widgetLog('Starting WellcomeAI Widget initialization...');
    
    // Логируем тип устройства
    widgetLog(`Detected Device Type: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);
    
    // Загружаем необходимые стили и скрипты
    loadFontAwesome();
    createStyles();
    
    // Создаем HTML структуру виджета
    createWidgetHTML();
    
    // Инициализируем основную логику виджета
    initWidget();
    
    widgetLog('WellcomeAI Widget initialization process finished.');
  }
  
  // Проверяем, есть ли уже виджет на странице
  if (!document.getElementById('wellcomeai-widget-container')) {
    widgetLog('Widget container not found, proceeding with initialization.');
    // Если DOM уже загружен, инициализируем сразу
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeWidget);
      widgetLog('DOM not fully loaded, waiting for DOMContentLoaded.');
    } else {
      widgetLog('DOM already loaded, initializing immediately.');
      initializeWidget();
    }
  } else {
    widgetLog('Widget container already exists on the page, skipping initialization.');
  }
})();
