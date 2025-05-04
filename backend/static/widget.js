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

  // Глобальные флаги для мобильных устройств (используются для отслеживания активации аудио)
  window.audioContextInitialized = false;
  window.tempAudioContext = null; // Храним временный или основной AudioContext
  window.hasPlayedSilence = false; // Флаг для iOS, указывающий на попытку разблокировки аудио

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

  // Получить отладочную информацию в виде строки (стаб)
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  // Обновление отладочной панели (стаб)
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
        text-align: center;
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

          <!-- Специальная кнопка для активации аудио для iOS -->
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
            Нажмите для активации микрофона и звука
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

  // Функция для разблокировки аудио на iOS (через AudioContext resume)
  async function unlockAudioContextOnIOS() {
      if (!isIOS) return true;

      if (window.audioContextInitialized && window.tempAudioContext && window.tempAudioContext.state === 'running') {
          widgetLog('AudioContext уже активен на iOS');
          return true;
      }

      widgetLog('Попытка активации AudioContext на iOS...');

      try {
          // Создаем контекст если его еще нет, или используем существующий
          if (!window.tempAudioContext) {
               window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                 sampleRate: 16000 // Использовать 16k для уменьшения нагрузки и совместимости
               });
               widgetLog(`Создан новый AudioContext на iOS с частотой ${window.tempAudioContext.sampleRate}`);
          }

          const ctx = window.tempAudioContext;

          if (ctx.state === 'suspended') {
              widgetLog('Возобновление AudioContext...');
              await ctx.resume();
              window.audioContextInitialized = true;
              widgetLog('AudioContext успешно возобновлен на iOS.');
              return true;
          } else if (ctx.state === 'running') {
               window.audioContextInitialized = true;
               widgetLog('AudioContext уже в состоянии running на iOS.');
               return true;
          } else {
               widgetLog(`AudioContext в неожиданном состоянии: ${ctx.state}`, 'warn');
               // Попробуем все равно считать его инициализированным, но это может быть проблемно
               window.audioContextInitialized = true;
               return true;
          }
      } catch (err) {
          widgetLog(`Ошибка активации AudioContext на iOS: ${err.message}`, 'error');
          window.audioContextInitialized = false; // Сбросить флаг при ошибке
          return false;
      }
  }

  // Воспроизведение короткой тишины (резервная функция для iOS разблокировки)
  // Это нужно для активации механизма воспроизведения AudioContext
  function playSilenceForUnlock() {
      if (!isIOS || window.hasPlayedSilence) return; // Играем только один раз на iOS

      try {
          if (!window.tempAudioContext) {
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                  sampleRate: 16000
              });
               widgetLog(`Создан AudioContext для playSilenceForUnlock с частотой ${window.tempAudioContext.sampleRate}`);
          }
          const ctx = window.tempAudioContext;

          // Создаем и воспроизводим тишину для разблокировки аудио
          const silentBuffer = ctx.createBuffer(1, 1, 22050); // Использовать стандартную частоту для буфера тишины
          const source = ctx.createBufferSource();
          source.buffer = silentBuffer;
          source.connect(ctx.destination);
          source.start(0);
          source.stop(0.01); // Очень короткое воспроизведение

          window.hasPlayedSilence = true;
          widgetLog("Played silence to help unlock audio on iOS");

          // Попытка возобновления контекста после воспроизведения тишины
          if (ctx.state === 'suspended') {
             ctx.resume().then(() => {
               window.audioContextInitialized = true;
               widgetLog("Audio context successfully resumed via playSilenceForUnlock.");
             }).catch(err => {
               widgetLog(`Failed to resume audio context after playSilence: ${err.message}`, 'error');
             });
          } else {
             window.audioContextInitialized = true;
          }

      } catch (e) {
          widgetLog(`Error playing silence for unlock: ${e.message}`, 'error');
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
    if (!widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !connectionError || !retryButton || !statusIndicator || !statusDot || !statusText || (isIOS && !iosAudioButton)) {
      widgetLog("Some UI elements were not found!", 'error');
      // Добавляем fallback на alert, если элементы не найдены, чтобы пользователь увидел ошибку
      alert("WellcomeAI Widget Error: UI elements missing. Please check console.");
      return;
    }

    // Переменные для обработки аудио
    let audioChunksBuffer = []; // Буфер для входящих аудиофрагментов от сервера
    let audioPlaybackQueue = []; // Очередь аудио для воспроизведения
    let isPlayingAudio = false; // Флаг: идет ли воспроизведение аудио
    let hasAudioData = false; // Флаг: был ли обнаружен звук в текущем сегменте записи
    let audioDataStartTime = 0; // Время начала записи текущего сегмента
    let minimumAudioLength = 300; // Минимальная длительность сегмента для отправки
    let isListening = false; // Флаг: активен ли захват микрофона и отправка данных

    // WebSocket и Audio API переменные, вынесенные на уровень initWidget
    let websocket = null;
    let audioContext = null;
    let mediaStream = null; // Поток с микрофона
    let audioProcessor = null; // Узел для обработки аудио
    let streamSource = null; // Источник аудио из mediaStream
    let iosGainNode = null; // Отдельный GainNode для iOS, чтобы отключить вывод

    let isConnected = false; // Флаг: активно ли WebSocket соединение
    let isWidgetOpen = false; // Флаг: открыт ли виджет
    let connectionFailedPermanently = false; // Флаг: достигнуто ли максимальное количество попыток переподключения

    // Конфигурация для оптимизации потока аудио - разные настройки для десктопа и мобильных
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01, // Порог для определения тишины (амплитуда)
      silenceDuration: 300, // Длительность тишины для отправки (мс)
      soundDetectionThreshold: 0.02 // Чувствительность к звуку (макс. амплитуда)
    };

    // Специальные настройки для мобильных устройств
    const MOBILE_AUDIO_CONFIG = {
      //silenceThreshold: 0.015, // Более низкий порог для мобильных - оставляем как у десктопа или понижаем, если нужно
      silenceThreshold: 0.01, // Оставим пока как у десктопа, возможно, проблема не в этом пороге
      silenceDuration: 600, // Увеличиваем длительность тишины для мобильных (было 500)
      soundDetectionThreshold: 0.01 // Понижаем чувствительность к звуку для лучшего захвата тихой речи на Android (было 0.015)
    };

    // Выбираем нужную конфигурацию в зависимости от устройства
    const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;
     widgetLog(`Effective Audio Config: ${isMobile ? 'Mobile' : 'Desktop'}`, effectiveAudioConfig);


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
      } else { // connecting or other state
        statusDot.classList.add('connecting');
      }

      // Показываем индикатор, если виджет открыт или есть ошибка
      if (isWidgetOpen || status !== 'connected') {
         statusIndicator.classList.add('show');
         // Скрываем через некоторое время, только если статус "Подключено"
         if (status === 'connected') {
            setTimeout(() => {
              statusIndicator.classList.remove('show');
            }, 3000);
         }
      } else {
         statusIndicator.classList.remove('show');
      }
    }

    // Создаем аудио-бары для визуализации
    function createAudioBars(count = 20) {
      if (!audioBars) return;
      audioBars.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        audioBars.appendChild(bar);
      }
    }
    createAudioBars(); // Создаем бары при инициализации

    // Функция для полной остановки всех аудио процессов (микрофон и воспроизведение)
    function stopAllAudioProcessing() {
      widgetLog("Stopping all audio processing");

      // Останавливаем прослушивание
      isListening = false;
      if (mainCircle) {
        mainCircle.classList.remove('listening');
      }

      // Останавливаем воспроизведение
      isPlayingAudio = false;
      if (mainCircle) {
         mainCircle.classList.remove('speaking');
      }

      // Очищаем буферы и очереди
      audioChunksBuffer = [];
      audioPlaybackQueue = [];

      // Сбрасываем флаги
      hasAudioData = false;
      audioDataStartTime = 0;

      // Останавливаем микрофонный поток
      if (mediaStream) {
        widgetLog("Stopping media stream tracks");
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }

      // Отключаем узлы AudioContext
      if (streamSource) {
         try { streamSource.disconnect(); } catch(e) {}
         streamSource = null;
      }
      if (audioProcessor) {
          try { audioProcessor.disconnect(); } catch(e) {}
          audioProcessor = null;
      }
      if (iosGainNode) { // Отключаем GainNode для iOS
          try { iosGainNode.disconnect(); } catch(e) {}
          iosGainNode = null;
      }

      // Приостанавливаем AudioContext, если он не используется для воспроизведения
      // Оставляем его активным, если есть очередь воспроизведения (хотя мы ее очистили)
      // На iOS стараемся держать его активным после первого взаимодействия
      if (audioContext && audioContext.state === 'running' && audioPlaybackQueue.length === 0 && !isIOS) {
           // На десктопе/Android можно приостановить
           audioContext.suspend().then(() => {
              widgetLog('AudioContext приостановлен');
           }).catch(e => widgetLog(`Ошибка при приостановке AudioContext: ${e.message}`, 'error'));
      }


      // Сбрасываем визуализацию
      resetAudioVisualization();

      // Если есть активное соединение WebSocket, отправляем команду остановки
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        widgetLog("Sending clear and cancel commands to server");
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
    }

    // Показать сообщение
    function showMessage(message, duration = 5000) {
      if (!messageDisplay) return;
      messageDisplay.textContent = message;
      messageDisplay.classList.add('show');

      // Очищаем предыдущий таймер скрытия, если он был
      if (messageDisplay.hideTimer) {
          clearTimeout(messageDisplay.hideTimer);
      }

      if (duration > 0) {
        messageDisplay.hideTimer = setTimeout(() => {
          messageDisplay.classList.remove('show');
          messageDisplay.hideTimer = null;
        }, duration);
      } else {
         // Если duration 0, сообщение не скрывается автоматически
      }
    }

    // Скрыть сообщение
    function hideMessage() {
       if (!messageDisplay) return;
       messageDisplay.classList.remove('show');
       if (messageDisplay.hideTimer) {
           clearTimeout(messageDisplay.hideTimer);
           messageDisplay.hideTimer = null;
       }
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

        // Добавляем обработчик для новой кнопки, удаляя старый если был
        const oldRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
        if (oldRetryButton) {
           oldRetryButton.removeEventListener('click', resetConnection); // Удаляем старый слушатель
        }
        const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', resetConnection); // Добавляем новый слушатель
        }
      }
    }

    // Скрыть ошибку соединения
    function hideConnectionError() {
      if (connectionError) {
        connectionError.classList.remove('visible');
         // Удаляем слушатель с кнопки повтора, чтобы избежать дублирования
        const retryBtn = connectionError.querySelector('#wellcomeai-retry-button');
        if (retryBtn) {
           retryBtn.removeEventListener('click', resetConnection);
        }
      }
    }

    // Сброс состояния соединения
    function resetConnection() {
      widgetLog('Resetting connection state and attempting reconnect');
      // Сбрасываем счетчик попыток и флаги
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      isReconnecting = true; // Устанавливаем флаг, чтобы предотвратить повторный запуск reconnectWithDelay

      // Скрываем сообщение об ошибке
      hideConnectionError();

      // Сбрасываем состояние аудио
      stopAllAudioProcessing();

      // Показываем сообщение о повторном подключении
      showMessage("Попытка подключения...", 0);
      updateConnectionStatus('connecting', 'Подключение...');

      // Пытаемся подключиться заново немедленно (initialDelay = 0)
      connectWebSocket();
    }

    // Открыть виджет
    async function openWidget() {
      if (isWidgetOpen) {
          widgetLog("Widget already open");
          return;
      }
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

      // Показываем сообщение о проблеме с подключением, если оно есть
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        updateConnectionStatus('disconnected', 'Отключено');
        return;
      }

      // Если соединение не активно и не находимся в процессе переподключения,
      // пытаемся подключиться снова
      if (!isConnected && !isReconnecting) {
        widgetLog("Widget opened, but not connected. Attempting connection.");
        connectWebSocket();
        // Остальная логика начнется в onopen
        return;
      }

      // Если соединение активно, пытаемся инициализировать аудио и начать слушать
      if (isConnected && !isReconnecting) {
         widgetLog("Widget opened, connection active. Attempting to start listening.");
         updateConnectionStatus('connected', 'Подключено');

         // Специальная обработка для iOS и других мобильных устройств
         if (isIOS) {
            // Для iOS показываем кнопку активации аудио, если еще не активировано
            if (iosAudioButton && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
              iosAudioButton.classList.add('visible');
              showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
              playSilenceForUnlock(); // Попытка разблокировки на старте виджета
              // Прослушивание начнется по клику на эту кнопку или круг после активации
            } else {
              // Если аудио уже активировано, пытаемся начать слушать сразу
              startListening();
            }
         } else if (isMobile) {
             // Для других мобильных, просто пытаемся начать слушать
             // initAudio будет вызван внутри startListening, если необходимо
             startListening();
         } else {
             // Для десктопа
             startListening();
         }

      } else if (isReconnecting) {
          widgetLog("Widget opened, currently reconnecting.");
          updateConnectionStatus('connecting', 'Переподключение...');
          // Прослушивание начнется автоматически после успешного переподключения
      } else {
           // Неизвестное состояние, возможно, ошибка?
           widgetLog(`Widget opened in unexpected state: isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'warn');
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

      // Добавляем пульсацию на кнопку, если не было ошибки соединения
      if (!connectionFailedPermanently && widgetButton) {
         widgetButton.classList.add('wellcomeai-pulse-animation');
      }
    }

    // Инициализация микрофона и AudioContext
    async function initAudio() {
      widgetLog("Attempting to initialize audio (Microphone & AudioContext)");

      // Проверяем, нужен ли AudioContext и создаем/возобновляем его первым делом
      if (!audioContext || audioContext.state === 'closed') {
          try {
               const contextOptions = isIOS ?
                 { sampleRate: 16000 } // iOS: 16k для совместимости и меньшей нагрузки
                 : isMobile ?
                 { sampleRate: 16000 } // Android/Mobile: 16k для STT оптимизации
                 : { sampleRate: 24000 }; // Desktop: 24k, стандартно

               audioContext = window.tempAudioContext || new (window.AudioContext || window.webkitAudioContext)(contextOptions);
               window.tempAudioContext = audioContext; // Сохраняем ссылку на контекст

               widgetLog(`AudioContext создан/используется с частотой ${audioContext.sampleRate} Гц. State: ${audioContext.state}`);

               // На iOS обязательно пытаемся возобновить контекст после пользовательского действия
               if (audioContext.state === 'suspended') {
                  await audioContext.resume();
                  widgetLog('AudioContext успешно возобновлен.');
               }
                window.audioContextInitialized = true; // Контекст готов или ожидает первого user gesture (на iOS)

          } catch (e) {
             widgetLog(`Ошибка создания/возобновления AudioContext: ${e.message}`, 'error');
             audioContext = null;
             window.audioContextInitialized = false;
             showMessage("Ошибка инициализации аудио. Проверьте настройки браузера.");
             return false; // Не удалось инициализировать AudioContext
          }
      } else if (audioContext.state === 'suspended') {
           // Если контекст уже есть, но приостановлен, пытаемся возобновить
           try {
              await audioContext.resume();
              widgetLog('Существующий AudioContext успешно возобновлен.');
               window.audioContextInitialized = true;
           } catch (e) {
               widgetLog(`Ошибка возобновления существующего AudioContext: ${e.message}`, 'error');
               // Возможно, нужно пересоздать или показать кнопку активации
               audioContext = null;
               window.tempAudioContext = null;
               window.audioContextInitialized = false;
               return initAudio(); // Попробуем пересоздать
           }
      } else {
           // Контекст уже активен
           widgetLog(`AudioContext уже активен. State: ${audioContext.state}`);
            window.audioContextInitialized = true;
      }

      // Теперь запрашиваем медиапоток, если его нет
      if (!mediaStream) {
          try {
              widgetLog("Запрос разрешения на доступ к микрофону...");

              // Проверяем поддержку getUserMedia
              if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Ваш браузер не поддерживает доступ к микрофону");
              }

              // Настройки микрофона
              const audioConstraints = isIOS ?
                { // iOS: отключаем эхо, включаем шумодав/АРУ. sampleRate в AudioContext важнее
                  echoCancellation: false,
                  noiseSuppression: true,
                  autoGainControl: true
                } :
                isMobile ?
                { // Android: включаем эхо, шумодав, АРУ. Явно указываем sampleRate.
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                  sampleRate: 16000 // <-- Установлено 16000 Гц для Android
                } :
                { // Desktop
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                  sampleRate: 24000
                };

              // Запрашиваем доступ к микрофону
              mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
              widgetLog(`Доступ к микрофону получен (${isIOS ? 'iOS' : (isMobile ? 'Android' : 'Desktop')} настройки)`);

          } catch (micError) {
              widgetLog(`Ошибка доступа к микрофону: ${micError.message}`, 'error');
              mediaStream = null;
              showMessage("Ошибка доступа к микрофону. Проверьте настройки браузера.");

              // Особая обработка для iOS: показать кнопку активации, если не удалось получить поток
              if (isIOS && iosAudioButton) {
                 iosAudioButton.classList.add('visible');
                 showMessage("Нажмите кнопку ниже для активации микрофона", 0);
              }

              return false; // Не удалось получить медиапоток
          }
      } else {
           widgetLog("Медиапоток с микрофона уже активен.");
      }

      // Если контекст и поток готовы, создаем/пересоздаем узлы AudioContext
      if (audioContext && mediaStream) {
          try {
              // Очищаем старые узлы перед созданием новых
              if (streamSource) { try { streamSource.disconnect(); } catch(e) {} }
              if (audioProcessor) { try { audioProcessor.disconnect(); } catch(e) {} }
              if (iosGainNode) { try { iosGainNode.disconnect(); } catch(e) {} }

              // Создаем источник из потока
              streamSource = audioContext.createMediaStreamSource(mediaStream);

              // Оптимизированные размеры буфера для разных устройств (было 2048 для десктопа, 1024 для моб, 2048 для iOS)
              // Попробуем унифицировать или уточнить
              const bufferSize = isIOS ? 4096 : // iOS: Больше для стабильности (было 2048)
                                 isMobile ? 2048 : // Android: Увеличим для стабильности (было 1024)
                                 2048; // Desktop: Оставим как было

              // Проверка на поддержку ScriptProcessorNode (устаревший, но совместимый)
              if (audioContext.createScriptProcessor) {
                audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
                widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
              } else if (audioContext.createJavaScriptNode) { // Для старых версий Safari
                audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
                widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${bufferSize}`);
              } else {
                throw new Error("Ваш браузер не поддерживает обработку аудио");
              }

              // Переменные для отслеживания звука (сброс при реинициализации)
              let isSilent = true;
              let silenceStartTime = Date.now();
              let lastCommitTime = 0;
              let hasSentAudioInCurrentSegment = false;
              let audioSampleCounter = 0;

              // Обработчик аудио
              audioProcessor.onaudioprocess = function(e) {
                // Отправляем данные только если прослушивание активно, соединение открыто и нет переподключения
                if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
                  const inputBuffer = e.inputBuffer;
                  let inputData = inputBuffer.getChannelData(0);

                  if (inputData.length === 0) return;

                  audioSampleCounter++;

                  // Вычисляем амплитуду
                  let maxAmplitude = 0;
                  let sumAmplitude = 0;
                  for (let i = 0; i < inputData.length; i++) {
                    const absValue = Math.abs(inputData[i]);
                    maxAmplitude = Math.max(maxAmplitude, absValue);
                    sumAmplitude += absValue;
                  }
                  const avgAmplitude = sumAmplitude / inputData.length; // Для визуализации/доп. анализа

                  // **************** Внесение изменений для улучшения захвата на мобильных ****************
                  // iOS Normalization/Gain (оставлено из старой версии, возможно, требует настройки)
                   if (isIOS && maxAmplitude > 0 && maxAmplitude < 0.1) {
                     const gain = Math.min(5, 0.3 / maxAmplitude); // Усиление тихого сигнала
                     const normalizedData = new Float32Array(inputData.length);
                     for (let i = 0; i < inputData.length; i++) {
                       normalizedData[i] = inputData[i] * gain;
                     }
                     inputData = normalizedData; // Используем нормализованные данные для дальнейшей обработки
                   }
                  // ***************************************************************************************


                  const soundThreshold = isIOS ?
                                      0.005 : // iOS: Меньший порог звука
                                      effectiveAudioConfig.soundDetectionThreshold; // Android/Desktop: из конфига

                  const hasSound = maxAmplitude > soundThreshold;

                  // Обновляем визуализацию
                  updateAudioVisualization(inputData);

                  // Преобразуем float32 в int16
                  const pcm16Data = new Int16Array(inputData.length);
                  for (let i = 0; i < inputData.length; i++) {
                    // Используем нормализованные данные, если применялось усиление
                    const sample = inputData[i];
                    pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
                  }

                  // Отправляем данные через WebSocket
                  try {
                    const message = JSON.stringify({
                      type: "input_audio_buffer.append",
                      event_id: `audio_${Date.now()}_${audioSampleCounter}`,
                      audio: arrayBufferToBase64(pcm16Data.buffer)
                    });

                    websocket.send(message);
                    hasSentAudioInCurrentSegment = true;

                    // Отмечаем наличие аудиоданных (звука)
                    if (!hasAudioData && hasSound) {
                      hasAudioData = true;
                      audioDataStartTime = Date.now();
                      widgetLog("Начало обнаружения значимых аудиоданных");
                    }

                  } catch (error) {
                    widgetLog(`Ошибка отправки аудио по WS: ${error.message}`, "error");
                    // При ошибке отправки, возможно, нужно остановить прослушивание и попробовать переподключиться
                     if (!isReconnecting) {
                        widgetLog("WS Send Error, stopping listening and reconnecting...", 'warn');
                        stopListening(); // Останавливаем прослушивание
                        // Переподключение обработается в WS.onerror или WS.onclose
                     }
                  }

                  // Логика определения тишины и автоматической отправки (commit)
                  const now = Date.now();

                  if (hasSound) {
                    // Сбрасываем время начала тишины
                    isSilent = false;
                    silenceStartTime = now;

                    // Активируем визуальное состояние прослушивания, если не говорим и не уже слушаем
                    if (!mainCircle.classList.contains('listening') &&
                        !mainCircle.classList.contains('speaking')) {
                      mainCircle.classList.add('listening');
                    }
                  } else { // isSilent === true (текущий пакет - тишина)
                     // Если до этого был звук, а теперь тишина
                     if (!isSilent) {
                         const silenceDuration = now - silenceStartTime;

                         // **************** Настройка длительности тишины для мобильных ****************
                         // Длительность тишины для коммита
                         const commitSilenceDuration = isIOS ?
                                                     800 : // iOS: Увеличено (было 800)
                                                     effectiveAudioConfig.silenceDuration; // Android/Desktop: из конфига

                         if (silenceDuration > commitSilenceDuration) {
                           isSilent = true; // Переход в состояние "длительная тишина"

                           // Если прошло достаточно времени с последней отправки и были данные в текущем сегменте
                           // Добавим также проверку, что сейчас не идет воспроизведение
                           if (now - lastCommitTime > 500 && hasSentAudioInCurrentSegment && !isPlayingAudio) { // Уменьшил минимальный интервал коммита до 500ms
                             widgetLog(`Обнаружена тишина > ${commitSilenceDuration}ms. Отправляем commit.`);
                             sendCommitBuffer();
                             lastCommitTime = Date.now(); // Обновляем время последнего коммита
                             hasSentAudioInCurrentSegment = false; // Сбрасываем флаг
                             // Аудиоданные сбрасываются в sendCommitBuffer
                           } else if (!hasSentAudioInCurrentSegment) {
                             widgetLog("Тишина обнаружена, но в сегменте не было звука. Commit не отправляется.", 'debug');
                             // Сбрасываем флаги, готовимся к новому сегменту сразу
                             hasAudioData = false;
                             audioDataStartTime = 0;
                           }
                         }
                     }
                  }
                } else {
                   // Если прослушивание неактивно, просто сбрасываем визуализацию
                   resetAudioVisualization();
                }
              };

              // Подключаем source к processor
              streamSource.connect(audioProcessor);

              // **************** Внесение изменений для предотвращения эха на iOS ****************
              // Для iOS НЕ соединяем напрямую с выходом, чтобы избежать обратной связи (echo)
              if (isIOS) {
                // Создаем "пустой" узел с нулевой громкостью
                iosGainNode = audioContext.createGain();
                iosGainNode.gain.value = 0; // Установка громкости на ноль
                audioProcessor.connect(iosGainNode);
                iosGainNode.connect(audioContext.destination); // Подключаем к выходу с нулевой громкостью
                widgetLog('Используем нулевой gainNode для iOS чтобы избежать обратной связи');
              } else {
                // Для других устройств соединяем напрямую с выходом
                audioProcessor.connect(audioContext.destination);
              }
              // ******************************************************************************


              widgetLog("Аудио узлы AudioContext подключены.");
              return true; // Успешная инициализация узлов

          } catch (error) {
            widgetLog(`Ошибка настройки AudioContext узлов: ${error.message}`, "error");

            // Очищаем ссылки при ошибке
            streamSource = null;
            audioProcessor = null;
            iosGainNode = null;

            showMessage("Ошибка настройки аудио. Проверьте настройки браузера.");
            return false; // Не удалось настроить узлы
          }
      } else {
          // Если нет AudioContext или MediaStream
          widgetLog("AudioContext или MediaStream недоступны для создания узлов.", 'error');
          showMessage("Ошибка аудио: Не удалось получить доступ.", 5000);
          return false;
      }
    }

    // Начало записи голоса
    async function startListening() {
      // Проверяем предварительные условия
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`);

        // Если открыт виджет и есть permanent error, показать ошибку
        if (isWidgetOpen && connectionFailedPermanently) {
             showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
        } else if (isWidgetOpen && !isConnected && !isReconnecting) {
            // Если виджет открыт, но нет соединения, попробовать переподключиться
            widgetLog("startListening called but not connected, attempting reconnect.");
            connectWebSocket();
        }

        return;
      }

      widgetLog('Попытка начать прослушивание...');

      // **************** Внесение изменений для iOS активации ****************
      if (isIOS) {
         // На iOS, обязательно убеждаемся, что AudioContext активен
         const contextUnlocked = await unlockAudioContextOnIOS();
         if (!contextUnlocked) {
            widgetLog('Не удалось активировать AudioContext на iOS перед стартом прослушивания.', 'error');
            // Показываем кнопку активации и останавливаем процесс
            if (iosAudioButton) iosAudioButton.classList.add('visible');
            showMessage("Нажмите кнопку ниже для активации микрофона", 0);
            return;
         }
         // Также выполняем playSilence, если еще не было (используется unlockAudioContextOnIOS или playSilenceForUnlock)
         playSilenceForUnlock(); // Попытка воспроизвести тишину, если нужно
         // Если кнопка активации была видна, скрываем ее, так как контекст теперь должен быть активен
         if (iosAudioButton) iosAudioButton.classList.remove('visible');
      } else if (isMobile && !window.audioContextInitialized) {
          // Для Android пытаемся просто инициализировать контекст при первом пользовательском действии (openWidget или click)
          await initAudio(); // initAudio сам создаст/возобновит контекст
           if (!window.audioContextInitialized) {
              widgetLog('Не удалось инициализировать AudioContext на Android.', 'error');
              showMessage("Ошибка инициализации микрофона.", 5000);
              return;
           }
      }
      // *********************************************************************


      // Инициализация или реинициализация аудиозахвата (микрофон + узлы AudioContext)
      // initAudio теперь сам проверяет, нужно ли пересоздавать контекст/поток
      const audioReady = await initAudio();
      if (!audioReady) {
        widgetLog('Не удалось подготовить аудио для прослушивания.', 'error');
        // initAudio сам покажет сообщения об ошибках и кнопку iOS при необходимости
        return;
      }

      // Если все готово, устанавливаем флаг и обновляем UI
      isListening = true;
      widgetLog('Прослушивание начато');

      // Отправляем команду для очистки буфера ввода на сервере
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
        websocket.send(JSON.stringify({ // Отменяем предыдущий ответ, если он был
           type: "response.cancel",
           event_id: `cancel_${Date.now()}`
        }));
      }

      // Сбрасываем флаги аудио данных для нового сегмента
      hasAudioData = false;
      audioDataStartTime = 0;

      // Активируем визуальное состояние прослушивания (если не говорим)
      if (!isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
      // Скрываем любое сообщение об ошибке, если прослушивание успешно начато
      hideConnectionError();
      hideMessage(); // Скрываем также общее сообщение
    }

    // Остановка записи голоса (например, по завершению диалога или при ошибке)
    function stopListening() {
      if (!isListening) {
        widgetLog("stopListening called, but not currently listening.");
        return;
      }
      widgetLog("Stopping listening");

      isListening = false;
      mainCircle.classList.remove('listening');
      resetAudioVisualization();

      // Не закрываем mediaStream здесь, чтобы можно было быстро переключиться на воспроизведение.
      // Полная остановка потока происходит в stopAllAudioProcessing или при старте воспроизведения.

      // Если был активный сегмент записи, но он еще не был отправлен коммитом,
      // отправляем коммит сейчас
      if (hasAudioData && websocket && websocket.readyState === WebSocket.OPEN) {
           widgetLog("Stopping listening, sending commit for potentially incomplete segment.");
           sendCommitBuffer(); // Отправить текущий накопленный буфер
      } else if (websocket && websocket.readyState === WebSocket.OPEN) {
           // Если звука не было, но буфер на сервере мог что-то накопить, очистим его.
           widgetLog("Stopping listening, no sound detected, sending clear buffer command.");
           websocket.send(JSON.stringify({
                type: "input_audio_buffer.clear",
                event_id: `clear_on_stop_${Date.now()}`
            }));
      }


      // Сбрасываем флаги аудио данных
      hasAudioData = false;
      audioDataStartTime = 0;
    }


    // Функция для отправки аудиобуфера (commit)
    function sendCommitBuffer() {
      if (!websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
         widgetLog("Cannot send commit: WS not open or reconnecting", 'warn');
         return;
      }

      // Проверяем, есть ли в буфере достаточно аудиоданных, которые мы считали "значащими"
      // Эта проверка должна быть уже пройдена до вызова sendCommitBuffer из onaudioprocess,
      // но повторим на всякий случай. hasAudioData устанавливается при обнаружении звука.
      if (!hasAudioData) {
        widgetLog("Не отправляем commit, так как значимые аудиоданные не были обнаружены.", "warn");
        // Сбрасываем флаги, готовимся к следующему сегменту
        hasAudioData = false;
        audioDataStartTime = 0;
        return;
      }

      // Проверяем минимальную длительность аудио сегмента.
      // Это важно, чтобы не отправлять слишком короткие "пшики" или одиночные слова, если STT их не обработает.
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий для отправки (${audioLength}мс < ${minimumAudioLength}мс). Commit не отправляется.`, "warn");
         // Сбрасываем флаги, готовимся к следующему сегменту
        hasAudioData = false;
        audioDataStartTime = 0;
        return;
      }

      widgetLog(`Отправка commit для сегмента длиной ~${audioLength}мс`);

      // Сбрасываем эффект активности с небольшим таймаутом для плавности
      // Удаляем класс 'listening'
      mainCircle.classList.remove('listening');

      // Отправляем команду для завершения буфера
      websocket.send(JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}`
      }));

      // Показываем индикатор загрузки (кратковременно)
      if (loaderModal) {
        loaderModal.classList.add('active');
        setTimeout(() => {
          loaderModal.classList.remove('active');
        }, 800); // Короткий таймаут для отображения активности
      }

      // Начинаем обработку и сбрасываем флаги для следующего сегмента
      hasAudioData = false; // Сбрасываем флаг наличия звука в новом сегменте
      audioDataStartTime = 0; // Сбрасываем время начала нового сегмента
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
        widgetLog(`Ошибка при декодировании base64 аудио: ${e.message}`, "error");
        return new ArrayBuffer(0);
      }
    }

    // Обновление визуализации аудио
    function updateAudioVisualization(audioData) {
      if (!audioBars) return;
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      if (bars.length === 0) return;

      const step = Math.floor(audioData.length / bars.length);
      const multiplier = isMobile ? 150 : 100; // Увеличенная чувствительность для мобильных

      for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        const start = i * step;
        const end = start + step; // Не inclusive

        for (let j = start; j < end && j < audioData.length; j++) {
          sum += Math.abs(audioData[j]);
        }
        const average = sum / step;

        // Нормализуем значение для высоты полосы (от 2px до 30px)
        const height = 2 + Math.min(28, Math.floor(average * multiplier));
        bars[i].style.height = `${height}px`;
      }
    }

    // Сброс визуализации аудио
    function resetAudioVisualization() {
       if (!audioBars) return;
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px';
      });
    }

    // Создаём простой WAV из PCM данных (для воспроизведения)
    function createWavFromPcm(pcmBuffer, sampleRate = 16000) { // Используем 16k как стандарт для STT/TTS
      // Заголовок WAV для 16-bit PCM, Mono
      const buffer = new ArrayBuffer(44 + pcmBuffer.byteLength);
      const view = new DataView(buffer);
      const bytesPerSample = 2; // 16 bits / 8
      const numChannels = 1; // Mono

      // RIFF chunk descriptor
      writeString(view, 0, 'RIFF'); // ChunkID
      view.setUint32(4, 36 + pcmBuffer.byteLength, true); // ChunkSize
      writeString(view, 8, 'WAVE'); // Format

      // fmt sub-chunk
      writeString(view, 12, 'fmt '); // Subchunk1ID
      view.setUint32(16, 16, true); // Subchunk1Size
      view.setUint16(20, 1, true); // AudioFormat (1=Linear quantization)
      view.setUint16(22, numChannels, true); // NumChannels
      view.setUint32(24, sampleRate, true); // SampleRate
      view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
      view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
      view.setUint16(34, bytesPerSample * 8, true); // BitsPerSample

      // data sub-chunk
      writeString(view, 36, 'data'); // Subchunk2ID
      view.setUint32(40, pcmBuffer.byteLength, true); // Subchunk2Size

      // Write PCM data
      const audioBytes = new Uint8Array(buffer, 44);
      audioBytes.set(new Uint8Array(pcmBuffer));

      return buffer;

      function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i));
        }
      }
    }

    // Воспроизведение следующего аудио в очереди
    function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        widgetLog("Audio playback queue is empty.");
        isPlayingAudio = false;
        mainCircle.classList.remove('speaking');

        // **************** Внесение изменений для возобновления прослушивания ****************
        // После завершения воспроизведения, пытаемся снова начать слушать, если виджет открыт
        if (isWidgetOpen && isConnected && !isReconnecting) {
           widgetLog("Playback finished, attempting to restart listening.");
           // Добавляем задержку перед стартом прослушивания для стабильности, особенно на мобильных
           const restartDelay = isMobile ? 1200 : 800; // Увеличил задержку для мобильных

           setTimeout(() => {
             // Проверяем, что виджет все еще открыт и не идет переподключение
             if (isWidgetOpen && !isPlayingAudio && !isReconnecting && isConnected) {
                 startListening(); // Эта функция сама проверит состояние аудио и iOS активацию
             } else {
                 widgetLog(`Не удалось автоматически возобновить прослушивание: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isConnected=${isConnected}`);
             }
           }, restartDelay);
        } else {
            // Если виджет закрыт или нет соединения, добавляем пульсацию на кнопку
            if (!isWidgetOpen && widgetButton && !connectionFailedPermanently) {
               widgetButton.classList.add('wellcomeai-pulse-animation');
            }
             widgetLog(`Playback finished, not restarting listening: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`);
        }
        // **********************************************************************************
        return;
      }

      // **************** Внесение изменений: Останавливаем прослушивание перед воспроизведением ****************
       if (isListening) {
            widgetLog("Stopping listening before starting playback.");
            stopListening(); // Останавливаем логику записи
            // Полная остановка mediaStream произойдет в stopListening
       }
      // *******************************************************************************************************


      isPlayingAudio = true;
      mainCircle.classList.add('speaking');
      mainCircle.classList.remove('listening');
      hideMessage(); // Скрываем текстовое сообщение перед воспроизведением аудио

      const audioBase64 = audioPlaybackQueue.shift();
      widgetLog(`Playing next audio chunk (queue size: ${audioPlaybackQueue.length})`);

      try {
         const audioData = base64ToArrayBuffer(audioBase64);
         if (audioData.byteLength === 0) {
           widgetLog("Skipping empty audio chunk.");
           playNextAudio(); // Играем следующий сразу
           return;
         }

         // Используем AudioContext для создания AudioBufferSourceNode для лучшего контроля
         // Убеждаемся, что audioContext доступен и активен
         if (!audioContext || audioContext.state === 'closed') {
             widgetLog("AudioContext not available for playback, attempting to re-initialize...", 'error');
             // Попытаемся инициализировать AudioContext перед воспроизведением
             unlockAudioContextOnIOS().then(success => { // Эта функция работает и для Android/Desktop
                 if (success && audioContext) {
                      playAudioBuffer(audioContext, audioData).then(() => playNextAudio()).catch(() => playNextAudio());
                 } else {
                      widgetLog("Failed to re-initialize AudioContext for playback.", 'error');
                      showMessage("Ошибка воспроизведения аудио.", 5000);
                      playNextAudio(); // Переходим к следующему в очереди
                 }
             }).catch(() => playNextAudio()); // При ошибке разблокировки тоже переходим
             return;
         }

         // Убеждаемся, что AudioContext не suspended (особенно актуально для iOS/мобильных)
         if (audioContext.state === 'suspended') {
             audioContext.resume().then(() => {
                 widgetLog("AudioContext resumed for playback.");
                 playAudioBuffer(audioContext, audioData).then(() => playNextAudio()).catch(() => playNextAudio());
             }).catch(error => {
                 widgetLog(`Ошибка возобновления AudioContext для воспроизведения: ${error.message}`, 'error');
                 // Показываем кнопку активации iOS, если применимо
                 if (isIOS && iosAudioButton) {
                   iosAudioButton.classList.add('visible');
                   showMessage("Нажмите кнопку ниже для активации звука", 0);
                   // Можно добавить обработчик на кнопку, который попробует playAudioBuffer снова
                   iosAudioButton.onclick = () => {
                       unlockAudioContextOnIOS().then(() => {
                           iosAudioButton.classList.remove('visible');
                           playAudioBuffer(window.tempAudioContext, audioData).then(() => playNextAudio()).catch(() => playNextAudio());
                       });
                   };
                 } else {
                     showMessage("Ошибка воспроизведения аудио.", 5000);
                     playNextAudio();
                 }
             });
         } else {
             // Контекст уже активен, воспроизводим
             playAudioBuffer(audioContext, audioData).then(() => playNextAudio()).catch(() => playNextAudio());
         }


      } catch (error) {
        widgetLog(`Общая ошибка воспроизведения аудио: ${error.message}`, "error");
        showMessage("Произошла ошибка воспроизведения.", 5000);
        playNextAudio(); // Переходим к следующему, несмотря на ошибку текущего
      }
    }

    // Вспомогательная функция для воспроизведения AudioBuffer через AudioContext
    async function playAudioBuffer(ctx, audioData) {
        return new Promise((resolve, reject) => {
            try {
                // Декодируем PCM данные в AudioBuffer
                // Нам нужно декодировать PCM, а не стандартные форматы типа MP3/AAC
                // Ваш формат - 16-битный PCM, его нужно вручную преобразовать в AudioBuffer
                // Или, как сделано сейчас, создать WAV-файл и декодировать его.
                // Создание WAV-заголовка и декодирование Blob - это более надежный способ
                // работы с AudioContext.decodeAudioData, который обычно ожидает стандартный формат.

                const wavBuffer = createWavFromPcm(audioData, 16000); // Используем sampleRate 16k для WAV
                const blob = new Blob([wavBuffer], { type: 'audio/wav' });
                const audioUrl = URL.createObjectURL(blob);

                // Используем элемент Audio для воспроизведения Blob URL (более надежно на мобильных)
                 const audio = new Audio();
                 audio.src = audioUrl;
                 audio.preload = 'auto'; // Предзагрузка
                 //audio.volume = 1; // Убедиться, что звук не нулевой

                 audio.oncanplaythrough = function() {
                     widgetLog("Audio can play, attempting playback.");
                     const playPromise = audio.play();
                     if (playPromise !== undefined) {
                         playPromise.then(() => {
                             widgetLog("Playback started successfully.");
                         }).catch(error => {
                             widgetLog(`Error during audio.play(): ${error.message}`, 'error');
                              // Если ошибка NotAllowedError, возможно, нужно еще раз разблокировать
                             if (error.name === 'NotAllowedError' && isIOS && iosAudioButton) {
                                widgetLog('iOS Playback NotAllowedError - showing activation button.');
                                iosAudioButton.classList.add('visible');
                                showMessage("Нажмите кнопку ниже для активации звука", 0);
                                // Нужно будет добавить логику в обработчик кнопки для повторного воспроизведения этого фрагмента
                                // В данном случае, при клике на кнопку, playNextAudio() будет вызвана заново через resolve/reject
                             }
                             reject(error); // Отклоняем промис при ошибке воспроизведения
                         });
                     }
                 };

                 audio.onended = function() {
                   widgetLog("Audio playback ended.");
                   URL.revokeObjectURL(audioUrl); // Очищаем URL Blob
                   resolve(); // Решаем промис при завершении
                 };

                 audio.onerror = function(e) {
                   widgetLog(`Audio element error: ${e.message || 'Unknown error'}`, 'error');
                   URL.revokeObjectURL(audioUrl);
                   reject(new Error('Audio playback error')); // Отклоняем промис при ошибке
                 };

                 audio.load(); // Запускаем загрузку

            } catch (e) {
                widgetLog(`Ошибка в playAudioBuffer: ${e.message}`, 'error');
                reject(e); // Отклоняем при ошибке
            }
        });
    }


    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') return;

      widgetLog(`Adding audio chunk to playback queue (current size: ${audioPlaybackQueue.length})`);
      // Добавляем аудио в очередь
      audioPlaybackQueue.push(audioBase64);

      // Если не запущено воспроизведение, запускаем
      if (!isPlayingAudio) {
        widgetLog("Playback not active, starting playback.");
        playNextAudio();
      } else {
          widgetLog("Playback already active, queueing audio.");
      }
    }

    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      // Проверяем, не превышено ли максимальное количество попыток
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

      if (reconnectAttempts >= maxAttempts) {
        widgetLog(`Maximum reconnection attempts (${maxAttempts}) reached. Stopping.`);
        isReconnecting = false;
        connectionFailedPermanently = true;

        // Показываем сообщение пользователю, если виджет открыт
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение. Попробуйте перезагрузить страницу.");
          updateConnectionStatus('disconnected', 'Отключено');
          hideMessage(); // Скрываем сообщение "Переподключение..."
        } else {
          // Если виджет закрыт, добавляем пульсацию на кнопку
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        // Останавливаем любые аудио процессы
        stopAllAudioProcessing();
        return;
      }

      // Устанавливаем флаг переподключения
      if (!isReconnecting) {
          isReconnecting = true;
          widgetLog("Setting isReconnecting = true");
      }


      // Показываем сообщение пользователю, если виджет открыт
      if (isWidgetOpen) {
        showMessage("Соединение прервано. Переподключение...", 0);
        updateConnectionStatus('connecting', 'Переподключение...');
      } else {
          // Если виджет закрыт, убираем пульсацию перед переподключением, добавим ее снова при ошибке
          widgetButton.classList.remove('wellcomeai-pulse-animation');
      }


      // Если задана начальная задержка, используем ее, иначе экспоненциальная
      const delay = initialDelay > 0 ?
                initialDelay :
                isMobile ?
                    Math.min(15000, Math.pow(1.8, reconnectAttempts) * 500) : // Немного скорректировал экспоненту для моб.
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);

      reconnectAttempts++;

      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);

      // Пытаемся переподключиться с увеличивающейся задержкой
      setTimeout(() => {
        if (isReconnecting) { // Проверяем флаг, чтобы избежать двойного переподключения
           connectWebSocket(); // connectWebSocket сбросит флаг isReconnecting при успехе/неудаче
        } else {
           widgetLog("Skipping planned reconnect attempt because isReconnecting flag is false.");
        }
      }, delay);
    }

    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      // Если соединение уже открыто или находится в процессе открытия, ничего не делаем
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
           widgetLog("WebSocket connection is already OPEN or CONNECTING.");
           // Если мы были в состоянии переподключения, но соединение уже открыто (возможно, из другой вкладки или вручную), сбрасываем флаг
           if (isReconnecting) {
               isReconnecting = false;
               reconnectAttempts = 0;
               connectionFailedPermanently = false;
               loaderModal.classList.remove('active');
               widgetLog("Detected already open connection, resetting reconnect state.");
                if (isWidgetOpen) {
                    showMessage("Соединение восстановлено", 3000);
                    updateConnectionStatus('connected', 'Подключено');
                     // Пытаемся начать слушать, если виджет открыт
                    setTimeout(() => {
                        if (isWidgetOpen && !isPlayingAudio && !isListening) {
                             startListening();
                        }
                    }, isMobile ? 1000 : 500); // Задержка перед стартом прослушивания после переподключения
                } else {
                    // Если виджет закрыт, добавляем пульсацию
                    if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                }
           }
           return;
      }

      // Если было permanent error, не пытаемся автоматически переподключиться
      if (connectionFailedPermanently) {
          widgetLog("Connection failed permanently, not attempting connectWebSocket automatically.");
          if (isWidgetOpen) {
             showConnectionError("Не удалось подключиться к серверу. Нажмите кнопку 'Повторить подключение'.");
             updateConnectionStatus('disconnected', 'Отключено');
          } else {
             if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
          }
          return false;
      }


      widgetLog("Starting new WebSocket connection attempt...");
      loaderModal.classList.add('active');

      // Устанавливаем флаг переподключения, если он не установлен (при первом вызове или при ручном запуске)
      if (!isReconnecting) {
         isReconnecting = true; // Важно установить этот флаг до таймаута
         reconnectAttempts++; // Увеличиваем счетчик попыток
         widgetLog(`Attempt ${reconnectAttempts} to connect.`);
      }

      // Скрываем ошибку соединения, если она была показана
      hideConnectionError();

      // Проверяем наличие ID ассистента
      if (!ASSISTANT_ID) {
        widgetLog('Assistant ID not found!', 'error');
        showMessage("Ошибка: ID ассистента не указан. Проверьте код встраивания.");
        loaderModal.classList.remove('active');
        isReconnecting = false; // Сбрасываем флаг, так как это фатальная ошибка
        connectionFailedPermanently = true;
        return false;
      }

      // Очищаем предыдущее соединение, если оно существует и не закрыто
      if (websocket) {
        widgetLog(`Closing previous WebSocket connection (state: ${websocket.readyState})...`);
        try {
          // Добавляем временный обработчик onclose, чтобы избежать вызова reconnectWithDelay
          // когда мы сами закрываем соединение перед пересозданием
          let tempOnClose = websocket.onclose;
          websocket.onclose = null; // Временно отключаем основной обработчик
          websocket.close(1000, 'Client initiating new connection');
           // Восстанавливаем обработчик после небольшой задержки, если он был
           setTimeout(() => { if (tempOnClose) websocket.onclose = tempOnClose; }, 100);

        } catch (e) {
          widgetLog(`Error closing previous WS: ${e.message}`, 'warn');
        }
        websocket = null;
      }

       // Очищаем предыдущий таймер ping
      if (pingIntervalId) {
        clearInterval(pingIntervalId);
        pingIntervalId = null;
      }

      // Очищаем таймаут соединения, если он есть
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      // Обновляем статус UI
      if (isWidgetOpen) {
         updateConnectionStatus('connecting', 'Подключение...');
         showMessage("Подключение...", 0);
      } else {
          // Если виджет закрыт, просто обновляем статус внутренне
          updateConnectionStatus('connecting', 'Подключение...');
      }


      // Создаем новое WebSocket соединение
      try {
        websocket = new WebSocket(WS_URL);
        websocket.binaryType = 'arraybuffer'; // Устанавливаем двоичный тип для аудио
        widgetLog(`WebSocket instance created for URL: ${WS_URL}`);

        // Устанавливаем таймаут на открытие соединения
        connectionTimeout = setTimeout(() => {
          widgetLog(`WebSocket connection timeout (${CONNECTION_TIMEOUT}ms) exceeded. State: ${websocket ? websocket.readyState : 'null'}`, "error");

          if (websocket && (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN)) {
             // Если состояние все еще CONNECTING или OPEN, закрываем его
             widgetLog("Timeout: Closing unresponsive WebSocket connection.");
             try { websocket.close(1000, 'Connection Timeout'); } catch(e) { widgetLog(`Error closing WS on timeout: ${e.message}`, 'warn');}
          } else {
             // Если состояние уже CLOSED или CLOSING, просто обрабатываем как неудачу
             widgetLog("Timeout: WebSocket was already closing or closed.");
          }
           // Таймаут должен вызвать onclose, который запустит reconnectWithDelay,
           // если isReconnecting = true.
           // Убедимся, что isReconnecting останется true после таймаута.

        }, CONNECTION_TIMEOUT);

        websocket.onopen = function() {
          clearTimeout(connectionTimeout); // Отменяем таймаут
          connectionTimeout = null;
          widgetLog('WebSocket connection established successfully.');
          isConnected = true;
          isReconnecting = false; // Сбрасываем флаг переподключения при успехе
          reconnectAttempts = 0; // Сбрасываем счетчик попыток
          connectionFailedPermanently = false; // Сбрасываем флаг фатальной ошибки
          loaderModal.classList.remove('active'); // Скрываем загрузку

          // Инициализируем переменные для ping/pong
          lastPingTime = Date.now();
          lastPongTime = Date.now();

          // Настраиваем интервал ping с разной частотой для мобильных и десктопных устройств
          const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;

          // Запускаем ping для поддержания соединения
          pingIntervalId = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
              try {
                websocket.send(JSON.stringify({ type: "ping" }));
                lastPingTime = Date.now();
                widgetLog("Sent ping.");

                // Проверяем, получили ли мы pong за разумное время
                const PONG_TIMEOUT_MULTIPLIER = isMobile ? 4 : 3; // Множитель для таймаута понг
                if (Date.now() - lastPongTime > pingIntervalTime * PONG_TIMEOUT_MULTIPLIER) {
                  widgetLog(`Ping timeout (${pingIntervalTime * PONG_TIMEOUT_MULTIPLIER}ms), no pong received. Closing connection.`, "warn");
                  // Принудительное закрытие соединения, чтобы вызвать onclose
                  websocket.close(1000, 'Ping Timeout');
                }
              } catch (e) {
                widgetLog(`Error sending ping: ${e.message}`, "error");
                // Ошибка отправки пинга, возможно, соединение уже нерабочее, закрываем
                 if (websocket && websocket.readyState === WebSocket.OPEN) {
                     websocket.close(1000, 'Ping Send Error');
                 }
              }
            }
          }, pingIntervalTime);

          // Скрываем ошибку соединения, если она была показана
          hideConnectionError();
           // Скрываем сообщение о подключении/переподключении
           hideMessage();

          // Обновляем статус соединения в UI
          updateConnectionStatus('connected', 'Подключено');


          // Автоматически начинаем слушать, если виджет открыт
          if (isWidgetOpen) {
             widgetLog("Widget is open, attempting to start listening after connection.");
             // Небольшая задержка перед стартом прослушивания после onopen
             setTimeout(() => {
                 if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected) {
                      startListening(); // Эта функция сама проверит iOS активацию
                 } else {
                    widgetLog(`Cannot auto-start listening after connect: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}`);
                 }
             }, isMobile ? 1000 : 500); // Задержка перед стартом прослушивания после onopen
          } else {
             // Если виджет закрыт, добавляем пульсацию на кнопку
             if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
             widgetLog("Widget is closed, not auto-starting listening after connection.");
          }
           return true; // Соединение установлено
        };

        websocket.onmessage = function(event) {
          // Обновляем время последнего pong при получении любого сообщения
          lastPongTime = Date.now();
          //widgetLog("Received message, updated lastPongTime."); // Слишком частое логирование

          try {
            // Обработка возможных бинарных данных (аудио от сервера приходит как base64 в JSON)
            if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
              //widgetLog("Received binary data (unexpected or unused)."); // У нас аудио в base64, это не должно происходить
              return;
            }

            // Проверка на пустое сообщение
            if (!event.data) {
              widgetLog("Получено пустое сообщение от сервера.", "warn");
              return;
            }

            // Обработка текстовых сообщений
            try {
              const data = JSON.parse(event.data);

              // Не логируем частые сообщения append
              if (data.type !== 'input_audio_buffer.append') {
                 //widgetLog(`Получено сообщение типа: ${data.type || 'unknown'}`, DEBUG_MODE ? data : null); // Логируем payload только в DEBUG
              }


              // Проверка на сообщение session.created и session.updated
              if (data.type === 'session.created' || data.type === 'session.updated') {
                //widgetLog(`Получена информация о сессии: ${data.type}`); // Логируем, но не требуется спец. обработки
                return;
              }

              // Проверка на сообщение connection_status
              if (data.type === 'connection_status') {
                widgetLog(`Статус соединения от сервера: ${data.status} - ${data.message}`);
                 if (data.status === 'connected') {
                     // Соединение установлено, можно начинать слушать
                     isConnected = true;
                     isReconnecting = false;
                     reconnectAttempts = 0;
                     connectionFailedPermanently = false;
                     loaderModal.classList.remove('active');
                      hideConnectionError();
                      hideMessage();
                     updateConnectionStatus('connected', 'Подключено');

                     // Автоматически начинаем слушать если виджет открыт и не идет воспроизведение
                     if (isWidgetOpen && !isPlayingAudio && !isListening) {
                         widgetLog("Server status connected, attempting to start listening.");
                         setTimeout(() => {
                             if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected) {
                                 startListening(); // Эта функция сама проверит iOS активацию
                             } else {
                                 widgetLog(`Cannot auto-start listening after server status: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}`);
                             }
                         }, isMobile ? 1000 : 500); // Задержка
                     } else {
                          widgetLog(`Server status connected, but not starting listening: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}`);
                     }
                 } else {
                      // Сервер сообщил о другом статусе (e.g., disconnected, error)
                      widgetLog(`Server reports status: ${data.status}. Reason: ${data.message}`, 'warn');
                      isConnected = false;
                      // Дальнейшая обработка отключения/ошибки произойдет в onclose/onerror
                 }
                return;
              }

              // Обработка ошибок от сервера
              if (data.type === 'error') {
                 widgetLog(`Получена ошибка от сервера: ${data.error ? data.error.message : 'Неизвестная ошибка'}`, "error");
                // Особая обработка для ошибки пустого аудиобуфера
                if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                  widgetLog("Ошибка: сервер получил пустой аудиобуфер. Перезапускаем прослушивание.", "warn");
                  // Перезапускаем прослушивание без сообщения пользователю, если виджет открыт
                  if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                    setTimeout(() => {
                       if (isWidgetOpen && !isPlayingAudio && !isReconnecting && isConnected) {
                           startListening();
                       }
                    }, 500);
                  } else {
                      widgetLog(`Skipping auto-restart listening after empty buffer error: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
                  }
                  return;
                }

                // Прочие ошибки, показать пользователю
                showMessage(data.error ? data.error.message : 'Произошла ошибка на сервере', 5000);
                // При фатальной ошибке, возможно, нужно остановить прослушивание
                 if (isListening) {
                    widgetLog("Stopping listening due to server error.");
                    stopListening(); // Останавливаем прослушивание
                 }
                return;
              }

              // Обработка текстового ответа (части)
              if (data.type === 'response.text.delta') {
                 // Убедимся, что мы не в процессе переподключения
                 if (isReconnecting) return; // Игнорируем дельты во время переподключения

                if (data.delta) {
                  // Очищаем сообщение, если это первый фрагмент
                  if (messageDisplay.textContent === '' || messageDisplay.lastEventType !== 'response.text.delta') {
                       messageDisplay.textContent = data.delta;
                  } else {
                       messageDisplay.textContent += data.delta;
                  }
                   messageDisplay.lastEventType = 'response.text.delta';
                   showMessage(messageDisplay.textContent, 0); // Обновляем текст и показываем, не скрываем

                  // Если виджет закрыт, добавляем пульсацию на кнопку
                  if (!isWidgetOpen && widgetButton && !widgetButton.classList.contains('wellcomeai-pulse-animation')) {
                    widgetButton.classList.add('wellcomeai-pulse-animation');
                  }
                }
                return;
              }

              // Завершение текстового ответа
              if (data.type === 'response.text.done') {
                 if (isReconnecting) return;

                widgetLog('Text response done.');
                 messageDisplay.lastEventType = 'response.text.done';
                // После завершения текста, установим таймер на скрытие сообщения,
                // если не идет воспроизведение аудио
                 if (!isPlayingAudio) {
                   setTimeout(() => {
                     hideMessage();
                   }, 5000);
                 }
                return;
              }

              // Обработка аудио ответа (части)
              if (data.type === 'response.audio.delta') {
                 if (isReconnecting) return;
                if (data.delta) {
                  audioChunksBuffer.push(data.delta);
                }
                return;
              }

              // Обработка аудио транскрипции (если сервер ее отправляет)
              if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
                // Можно добавить логику для отображения транскрипции пользователю
                // (например, в отдельном блоке UI)
                // widgetLog(`Транскрипция аудио: ${data.transcript || data.delta}`);
                return;
              }

              // Аудио готово для воспроизведения
              if (data.type === 'response.audio.done') {
                 if (isReconnecting) return;

                widgetLog(`Audio response done. Buffer size: ${audioChunksBuffer.length}`);
                if (audioChunksBuffer.length > 0) {
                  const fullAudioBase64 = audioChunksBuffer.join('');
                  addAudioToPlaybackQueue(fullAudioBase64); // Добавляем в очередь
                  audioChunksBuffer = []; // Очищаем буфер после добавления в очередь
                } else {
                    widgetLog("Received audio.done but audioChunksBuffer is empty.", 'warn');
                }
                return;
              }

              // Ответ завершен (текст и аудио)
              if (data.type === 'response.done') {
                 if (isReconnecting) return;

                widgetLog('Response done received');
                 messageDisplay.lastEventType = 'response.done';

                 // Если не идет воспроизведение аудио, скрываем сообщение
                 if (!isPlayingAudio) {
                     setTimeout(() => {
                         hideMessage();
                     }, 5000);
                 }
                // После завершения ответа, пытаемся снова начать слушать, если виджет открыт
                // Логика возобновления прослушивания теперь находится в playNextAudio,
                // которая вызывается после завершения последнего аудиофрагмента.
                // Если аудиофрагментов не было, playNextAudio вызовется сразу после добавления
                // пустого буфера или не вызовется вообще, тогда нужно запустить прослушивание здесь.
                if (!isPlayingAudio && isWidgetOpen && isConnected && !isListening) {
                     widgetLog("Response done, no audio playing. Attempting to restart listening directly.");
                      // Добавляем задержку перед стартом прослушивания
                     const restartDelay = isMobile ? 1200 : 800; // Увеличил задержку для мобильных
                     setTimeout(() => {
                        if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected) {
                           startListening(); // Эта функция сама проверит iOS активацию
                        } else {
                           widgetLog(`Cannot auto-start listening after response.done: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}`);
                        }
                     }, restartDelay);
                } else {
                    widgetLog(`Response done, but not starting listening immediately: isPlayingAudio=${isPlayingAudio}, isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}`);
                }

                return;
              }

              // Если мы дошли до этой точки, у нас неизвестный тип сообщения
              widgetLog(`Неизвестный тип сообщения от сервера: ${data.type}`, "warn");
              // widgetLog(`Payload: `, data); // Логируем неизвестные сообщения для отладки

            } catch (parseError) {
              // Если не удалось распарсить JSON, это может быть ping/pong или что-то другое
              // widgetLog(`Ошибка парсинга JSON: ${parseError.message}`, "warn");

              // Проверим на пинг-понг сообщения
              if (typeof event.data === 'string' && event.data.trim() === 'pong') {
                lastPongTime = Date.now();
                //widgetLog("Получен pong-ответ."); // Слишком частое логирование
                return;
              }

              widgetLog(`Не удалось распарсить сообщение как JSON. Содержимое: ${typeof event.data === 'string' ? event.data.substring(0, 100) : typeof event.data}...`, "warn");
            }
          } catch (generalError) {
            widgetLog(`Общая ошибка обработки сообщения: ${generalError.message}`, "error");
          }
        };

        websocket.onclose = function(event) {
          widgetLog(`WebSocket connection closed: Code=${event.code}, Reason=${event.reason}, Clean=${event.wasClean}`);
          isConnected = false;
          // Останавливаем все аудио процессы клиента при закрытии соединения
          stopAllAudioProcessing();

          // Очищаем интервал ping
          if (pingIntervalId) {
            clearInterval(pingIntervalId);
            pingIntervalId = null;
          }

          // Отменяем таймаут соединения, если он еще висел
          if (connectionTimeout) {
             clearTimeout(connectionTimeout);
             connectionTimeout = null;
          }

          // Не пытаемся переподключаться, если соединение было закрыто нормально или мы сами его закрыли (code 1000, 1001)
          // или если флаг isReconnecting сброшен вручную (например, при permanent error)
          if (event.wasClean || event.code === 1000 || event.code === 1001 || !isReconnecting) {
             widgetLog(`Clean or manual WebSocket close (${event.code}), not attempting reconnect.`);
             // Обновляем статус UI, если виджет открыт
             if (isWidgetOpen) {
                updateConnectionStatus('disconnected', 'Отключено');
                showMessage("Соединение завершено.", 5000);
             } else {
                 // Если виджет закрыт, добавляем пульсацию на кнопку
                 if (widgetButton && !connectionFailedPermanently) {
                     widgetButton.classList.add('wellcomeai-pulse-animation');
                 }
                 updateConnectionStatus('disconnected', 'Отключено'); // Внутреннее обновление статуса
             }
             return;
          }

          // Если закрытие нечистое и виджет не в состоянии permanent error, пытаемся переподключиться
          if (!connectionFailedPermanently) {
             widgetLog('Unclean WebSocket close, attempting reconnect.');
             reconnectWithDelay(); // isReconnecting уже должен быть true
          } else {
             widgetLog("Unclean WebSocket close, but connectionFailedPermanently is true. Not attempting reconnect.");
              // Обновляем статус UI
             if (isWidgetOpen) {
                updateConnectionStatus('disconnected', 'Отключено');
                showConnectionError("Не удалось подключиться к серверу. Попробуйте перезагрузить страницу.");
             } else {
                 if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                  updateConnectionStatus('disconnected', 'Отключено');
             }
          }
        };

        websocket.onerror = function(error) {
          widgetLog(`WebSocket error:`, error);
          // Ошибка обычно предшествует onclose, который и обработает переподключение.
          // Но на всякий случай убедимся, что статус UI обновлен.
          isConnected = false;
          // Останавливаем все аудио процессы
          stopAllAudioProcessing();

          if (isWidgetOpen) {
            updateConnectionStatus('disconnected', 'Ошибка соединения');
            // onclose, вызванный после ошибки, покажет showConnectionError при необходимости
            // showMessage("Ошибка соединения с сервером", 5000); // onclose покажет более подробное сообщение
          } else {
             updateConnectionStatus('disconnected', 'Ошибка соединения'); // Внутреннее обновление статуса
          }

          // Если ошибка произошла до onopen (т.е. в состоянии CONNECTING), таймаут или onclose
          // должны будут вызвать reconnectWithDelay.
          // Если ошибка произошла после onopen (т.е. в состоянии OPEN), onclose также будет вызван.
          // Поэтому явный вызов reconnectWithDelay здесь, вероятно, не требуется
          // и может привести к дублированию попыток.
        };

      } catch (error) {
        widgetLog(`Fatal error creating WebSocket instance: ${error}`, 'error');
        loaderModal.classList.remove('active');
         // Явная ошибка при создании инстанса WebSocket (не путать с ошибкой подключения)
        isConnected = false;
        isReconnecting = false; // Это не ошибка подключения, а ошибка создания объекта WS
        connectionFailedPermanently = true; // Считаем это невосстановимой ошибкой
        if (isWidgetOpen) {
          showConnectionError("Не удалось инициализировать WebSocket. Возможно, браузер не поддерживается.");
          updateConnectionStatus('disconnected', 'Ошибка инициализации');
           hideMessage();
        } else {
            if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
             updateConnectionStatus('disconnected', 'Ошибка инициализации');
        }
         stopAllAudioProcessing();
        return false; // Не удалось даже создать объект WebSocket
      }

       return true; // Успешно создан объект WebSocket, ожидаем onopen
    }


    // Добавляем обработчики событий для интерфейса

    // Открытие виджета по клику на кнопку
    widgetButton.addEventListener('click', function(e) {
      widgetLog('Widget button clicked');
      e.preventDefault();
      e.stopPropagation();
      openWidget(); // Асинхронная функция
    });

    // Закрытие виджета по клику на кнопку Закрыть
    widgetClose.addEventListener('click', function(e) {
      widgetLog('Widget close button clicked');
      e.preventDefault();
      e.stopPropagation();
      closeWidget(); // Остановит аудио и закроет UI
    });

    // Обработчик для основного круга (для запуска/остановки прослушивания вручную)
    mainCircle.addEventListener('click', function() {
      widgetLog(`Main circle clicked. State: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isConnected=${isConnected}, permanentError=${connectionFailedPermanently}`);

      // Если виджет не открыт, клик по кругу ничего не делает (клик должен быть по кнопке)
      if (!isWidgetOpen) {
          widgetLog("Circle clicked, but widget is closed.");
          return;
      }

      // **************** Внесение изменений для iOS активации по клику на круг ****************
      if (isIOS) {
          // На iOS, клик на круг может помочь активировать AudioContext и микрофон
          unlockAudioContextOnIOS().then(contextUnlocked => {
              if (contextUnlocked) {
                  widgetLog('AudioContext activated via circle click on iOS.');
                  if (iosAudioButton) iosAudioButton.classList.remove('visible'); // Скрываем кнопку, если была видна
                  // После успешной активации контекста, продолжаем логику запуска/остановки прослушивания
                  handleCircleClickLogic();
              } else {
                  widgetLog('Failed to activate AudioContext via circle click on iOS.', 'error');
                   // Если не удалось активировать, убедимся, что кнопка iOS видна
                  if (iosAudioButton) iosAudioButton.classList.add('visible');
                  showMessage("Нажмите кнопку ниже для активации микрофона", 0);
              }
          }).catch(err => {
               widgetLog(`Error during unlockAudioContextOnIOS on circle click: ${err.message}`, 'error');
                if (isIOS && iosAudioButton) iosAudioButton.classList.add('visible');
                showMessage("Нажмите кнопку ниже для активации микрофона", 0);
          });
      } else {
           // Для Android и Desktop - стандартная логика
           handleCircleClickLogic();
      }
    });

    // Вспомогательная функция для логики клика по кругу (после потенциальной активации на iOS)
    function handleCircleClickLogic() {
         // Если идет воспроизведение, клик по кругу останавливает воспроизведение и запись
         if (isPlayingAudio) {
             widgetLog("Circle clicked while playing audio. Stopping audio.");
              // Очищаем очередь воспроизведения
             audioPlaybackQueue = [];
             isPlayingAudio = false;
             mainCircle.classList.remove('speaking');
             // stopAllAudioProcessing(); // Можно вызвать полную остановку, но stopListening достаточно
             stopListening(); // Останавливаем логику записи и отправку коммита
             hideMessage(); // Скрываем сообщение

              // Теперь пытаемся начать слушать, если соединение активно
              if (isConnected && !isReconnecting) {
                   widgetLog("Audio stopped, attempting to restart listening after circle click.");
                    // Небольшая задержка перед стартом
                   setTimeout(() => {
                     if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected) {
                          startListening(); // Эта функция сама проверит состояние аудио
                     }
                   }, isMobile ? 800 : 500);
              } else if (connectionFailedPermanently) {
                 showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
              } else if (!isConnected && !isReconnecting) {
                  widgetLog("Audio stopped, attempting to connect/reconnect.");
                  connectWebSocket();
              }


         } else if (isListening) {
            // Если идет прослушивание, клик по кругу останавливает прослушивание
            widgetLog("Circle clicked while listening. Stopping listening.");
            stopListening(); // Останавливает запись и отправляет commit
             // Состояние UI уже обновлено в stopListening
         } else {
            // Если не слушаем и не говорим, клик по кругу запускает прослушивание
            widgetLog("Circle clicked while idle. Starting listening.");
            // Проверяем соединение
            if (isConnected && !isReconnecting) {
                startListening(); // Эта функция сама проверит состояние аудио и iOS активацию
            } else if (connectionFailedPermanently) {
                 showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
            } else {
                // Если нет соединения и нет permanent error, пытаемся подключиться
                widgetLog("Circle clicked while not connected, attempting connection.");
                connectWebSocket();
                // Прослушивание начнется в onopen
            }
         }
    }


    // Обработчик для iOS кнопки активации аудио
    if (isIOS && iosAudioButton) {
      iosAudioButton.addEventListener('click', function() {
        widgetLog('iOS Audio Activation button clicked');
        // При клике на эту кнопку пытаемся активировать AudioContext
        unlockAudioContextOnIOS().then(success => {
          if (success) {
            widgetLog('Audio context successfully activated via iOS button click.');
            iosAudioButton.classList.remove('visible'); // Скрываем кнопку
            hideMessage(); // Скрываем сообщение "Нажмите кнопку..."
            // Теперь, когда аудио активировано, пытаемся начать слушать
            setTimeout(() => {
              if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                startListening(); // Эта функция сама проверит готовность аудио
              } else {
                   widgetLog(`Cannot auto-start listening after iOS button: isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
              }
            }, 500); // Небольшая задержка перед стартом прослушивания
          } else {
            widgetLog('Failed to activate AudioContext via iOS button click.', 'error');
            // Если не удалось активировать, возможно, нужно показать ошибку или оставить кнопку видимой
             showMessage("Не удалось активировать микрофон/звук.", 5000);
            // Кнопка остается видимой
          }
        }).catch(err => {
            widgetLog(`Error during unlockAudioContextOnIOS on button click: ${err.message}`, 'error');
            showMessage("Произошла ошибка при активации аудио.", 5000);
        });
      });
    }

    // Обработчик для кнопки повторного подключения (находится в showConnectionError)
    // Добавляется динамически при вызове showConnectionError


    // Создаем WebSocket соединение при старте виджета
    widgetLog('Initial WebSocket connection attempt.');
    connectWebSocket();

    // Проверка DOM и состояния после инициализации
    // Добавлено для отладки в браузере
    setTimeout(function() {
      widgetLog('--- Initial DOM & State Check ---');

      const container = document.getElementById('wellcomeai-widget-container');
      const btn = document.getElementById('wellcomeai-widget-button');
      const expanded = document.getElementById('wellcomeai-widget-expanded');
      const modal = document.getElementById('wellcomeai-loader-modal');
      const msg = document.getElementById('wellcomeai-message-display');
      const err = document.getElementById('wellcomeai-connection-error');
      const stat = document.getElementById('wellcomeai-status-indicator');
      const iosBtn = document.getElementById('wellcomeai-ios-audio-button');
      const circle = document.getElementById('wellcomeai-main-circle');
      const bars = document.getElementById('wellcomeai-audio-bars');


      widgetLog(`Container found: ${!!container}, z-index: ${container ? getComputedStyle(container).zIndex : 'N/A'}`);
      widgetLog(`Button found: ${!!btn}, display: ${btn ? getComputedStyle(btn).display : 'N/A'}, pulse: ${btn ? btn.classList.contains('wellcomeai-pulse-animation') : 'N/A'}`);
      widgetLog(`Expanded found: ${!!expanded}, visible (CSS): ${expanded ? (getComputedStyle(expanded).opacity > 0 && getComputedStyle(expanded).height !== '0px') : 'N/A'}`);
      widgetLog(`Loader Modal found: ${!!modal}, active: ${modal ? modal.classList.contains('active') : 'N/A'}`);
      widgetLog(`Message Display found: ${!!msg}, show: ${msg ? msg.classList.contains('show') : 'N/A'}`);
      widgetLog(`Connection Error found: ${!!err}, visible: ${err ? err.classList.contains('visible') : 'N/A'}`);
      widgetLog(`Status Indicator found: ${!!stat}, show: ${stat ? stat.classList.contains('show') : 'N/A'}`);
      if (isIOS) {
         widgetLog(`iOS Button found: ${!!iosBtn}, visible: ${iosBtn ? iosBtn.classList.contains('visible') : 'N/A'}`);
      }
       widgetLog(`Main Circle found: ${!!circle}, listening: ${circle ? circle.classList.contains('listening') : 'N/A'}, speaking: ${circle ? circle.classList.contains('speaking') : 'N/A'}`);
       widgetLog(`Audio Bars found: ${!!bars}`);


      widgetLog(`Connection state: WS = ${websocket ? websocket.readyState : 'null'}, isConnected = ${isConnected}, isReconnecting = ${isReconnecting}, permanentError = ${connectionFailedPermanently}`);
      widgetLog(`Widget state: isWidgetOpen = ${isWidgetOpen}, isListening = ${isListening}, isPlayingAudio = ${isPlayingAudio}`);
      if (isMobile) {
         widgetLog(`Mobile Audio state: audioContextInitialized = ${window.audioContextInitialized}, hasPlayedSilence = ${window.hasPlayedSilence}`);
         if (audioContext) {
           widgetLog(`AudioContext: state = ${audioContext.state}, sampleRate = ${audioContext.sampleRate}`);
         } else {
            widgetLog("AudioContext is null.");
         }
          if (mediaStream) {
             widgetLog(`MediaStream: active = ${mediaStream.active}, tracks = ${mediaStream.getTracks().length}`);
          } else {
             widgetLog("MediaStream is null.");
          }
      }
      widgetLog('--- End of initial check ---');

    }, 2000); // Задержка, чтобы DOM полностью отрисовался
  }

  // Инициализируем виджет при загрузке DOM
  function initializeWidget() {
    widgetLog('Initializing WellcomeAI Widget...');

    // Проверяем, есть ли уже виджет на странице
    if (!document.getElementById('wellcomeai-widget-container')) {
        widgetLog('Widget container not found, proceeding with initialization.');
        // Загружаем необходимые стили и скрипты
        loadFontAwesome();
        createStyles();
        // Создаем HTML структуру виджета
        createWidgetHTML();
        // Инициализируем основную логику виджета
        initWidget();
        widgetLog('WellcomeAI Widget initialization complete.');
    } else {
        widgetLog('Widget container already exists on the page, skipping initialization.');
    }
  }


  // Запускаем инициализацию, когда DOM полностью загружен
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWidget);
    widgetLog('Waiting for DOMContentLoaded...');
  } else {
    widgetLog('DOM already loaded, initializing immediately.');
    initializeWidget();
  }

})();
