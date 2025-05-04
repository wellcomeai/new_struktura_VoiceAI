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
  const isMobile = /iPhone|iPad|iPod|Android|Poco|mi|Redmi|GT/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Глобальные флаги для мобильных устройств (особенно iOS)
  window.audioContextInitialized = false;
  window.tempAudioContext = null; // Используется для iOS разблокировки
  window.hasPlayedSilence = false; // Флаг, что тишина была воспроизведена для iOS

  // Аудио переменные
  let audioChunksBuffer = []; // Не используется в текущей логике отправки по тишине, можно убрать
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

  // --- Вспомогательные функции (перемещены из initWidget) ---

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info') => {
    // На сервере Render будет доступен объект global (для серверной части виджета)
    // Этот код выполняется в браузере, поэтому проверяем window
    if (typeof window !== 'undefined' && window.location) {
      // Формируем сообщение для Render
      const logPrefix = '[WellcomeAI Widget]';
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;

      // В среде Render это попадет в логи через console.log
      // Для локальной разработки при включенном DEBUG_MODE
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

  // Обновление отладочной панели (стабы для совместимости) - перемещена
  const updateDebugPanel = () => {
    // Функция отключена в производственном режиме
    if (!DEBUG_MODE) return;
    // TODO: Здесь должна быть логика обновления UI отладочной панели
    // Для текущей версии просто логируем в консоль через widgetLog
    widgetLog("Debug panel update called (stub).");
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

      // Если нет data-server, ищем скрипт виджета по src
      const src = scriptTags[i].getAttribute('src');
      if (src && src.includes('widget.js')) { // Ищем именно ваш файл скрипта
        try {
          // Используем URL API для корректного построения абсолютного URL
          const url = new URL(src, window.location.href);
          serverUrl = url.origin; // Получаем origin (протокол + домен + порт)
          widgetLog(`Extracted server URL from script src: ${serverUrl}`);
          break;
        } catch (e) {
          widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');

          // Если src относительный, используем текущий домен
          if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) {
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
            this.adaptiveThreshold = Math.max(this.threshold, this.backgroundNoiseLevel * 2.5); // Порог в 2.5 раза выше фонового шума
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
      this.hasVoiceActivity = voiceRatio > 0.05 && this.activeFrameCount > 10; // Требуется хотя бы 5% активных фреймов и минимум 10 фреймов активности

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
      this.backgroundSamples = []; // Сброс фоновых образцов
      this.adaptiveThreshold = this.threshold; // Сброс адаптивного порога
      this.backgroundNoiseLevel = 0;
    }
  }

  // Функция для разблокировки аудио на iOS (перемещена)
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

          // Теперь инициализируем AudioContext, если его еще нет
          if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
            try {
               window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                widgetLog('Создан новый AudioContext для iOS разблокировки');
            } catch (e) {
                 widgetLog(`Ошибка создания AudioContext при разблокировке: ${e.message}`, 'error');
                 window.audioContextInitialized = false;
                 resolve(false);
                 return;
            }
          }

          if (window.tempAudioContext.state === 'suspended') {
            window.tempAudioContext.resume().then(() => {
              window.audioContextInitialized = true;
              window.hasPlayedSilence = true; // Считаем, что если контекст возобновлен, тишина воспроизведена
              widgetLog('AudioContext успешно активирован (возобновлен)');
              resolve(true);
            }).catch(err => {
              widgetLog(`Не удалось активировать AudioContext (resume): ${err.message}`, 'error');
              window.audioContextInitialized = false;
              resolve(false);
            });
          } else {
            // Контекст уже running, или был создан активным (редко)
            window.audioContextInitialized = true;
            window.hasPlayedSilence = true; // Считаем, что если контекст активен, тишина воспроизведена
            widgetLog(`AudioContext уже в состоянии: ${window.tempAudioContext.state}`);
            resolve(true);
          }
        }).catch(err => {
          // Ошибка воспроизведения (например, пользователь не взаимодействовал со страницей)
          widgetLog(`Ошибка при play() аудио для разблокировки: ${err.message}`, 'error');
          window.audioContextInitialized = false; // Сбрасываем флаг, т.к. активация не удалась
          resolve(false);
        });
      } else {
        // Для очень старых браузеров или специфических сценариев
        widgetLog('Используем fallback метод разблокировки для устаревших устройств/сценариев');
        setTimeout(() => {
          playSilence(); // Запасной вариант с воспроизведением тишины
          resolve(true); // Предполагаем успех, хотя активация может быть неполной
        }, 100);
      }
    });
  }

  // Функция для форсированной разблокировки аудио на iOS (через тоны, перемещена)
  function forceIOSAudioUnlock() {
    if (!isIOS) return Promise.resolve(true);

    widgetLog('Попытка форсированной разблокировки аудио на iOS (через тоны)');

    return new Promise((resolve) => {
      // Воспроизводим короткие звуки с разными частотами
      const frequencies = [100, 200, 300]; // Несколько тонов достаточно для активации
      let index = 0;

      function playNextTone() {
        // Если AudioContext уже активирован, останавливаем тоны
        if (window.audioContextInitialized && window.hasPlayedSilence) {
          widgetLog('AudioContext уже активирован, остановка воспроизведения тонов.');
          resolve(true);
          return;
        }

        if (index >= frequencies.length) {
          widgetLog('Завершены попытки воспроизведения тонов для разблокировки аудио на iOS.');
          // Разблокировка может быть неполной, но сделали все возможное
          resolve(window.audioContextInitialized); // Резолвим true, только если контекст стал активен
          return;
        }

        try {
          // Создаем контекст если его еще нет или он закрыт
          if (!window.tempAudioContext || window.tempAudioContext.state === 'closed') {
             try {
                window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                 widgetLog('Создан новый AudioContext для форсированной разблокировки тонами');
             } catch (e) {
                  widgetLog(`Ошибка создания AudioContext при форсированной разблокировке: ${e.message}`, 'error');
                  window.audioContextInitialized = false;
                  resolve(false); // Критическая ошибка, не можем создать контекст
                  return;
             }
          }

          const ctx = window.tempAudioContext;

          if (ctx.state === 'suspended') {
            widgetLog(`AudioContext suspended, пытаемся возобновить для тона ${frequencies[index]}Hz`);
            ctx.resume().then(() => {
              window.audioContextInitialized = true; // Контекст возобновлен, считаем инициализированным
              widgetLog('AudioContext успешно возобновлен для воспроизведения тонов.');
              // Если возобновлено, воспроизводим текущий тон
              scheduleTone(ctx, frequencies[index]);
              // Сразу планируем следующий, не дожидаясь завершения текущего
              index++;
              setTimeout(playNextTone, 200); // Небольшая задержка между тонами
            }).catch(err => {
              widgetLog(`Не удалось возобновить AudioContext для тона ${frequencies[index]}Hz: ${err.message}`, 'warn');
              window.audioContextInitialized = false; // Возобновление не удалось
              // Переходим к следующему тону
              index++;
              setTimeout(playNextTone, 200);
            });
          } else {
            // Контекст уже running, просто воспроизводим тон
            widgetLog(`AudioContext running, воспроизводим тон ${frequencies[index]}Hz`);
            window.audioContextInitialized = true; // Контекст running, считаем инициализированным
            scheduleTone(ctx, frequencies[index]);
            // Сразу планируем следующий
            index++;
            setTimeout(playNextTone, 200);
          }
        } catch (e) {
          widgetLog(`Ошибка при воспроизведении тонов: ${e.name}: ${e.message}`, 'warn');
          window.audioContextInitialized = false; // Ошибка воспроизведения
          index++;
          setTimeout(playNextTone, 200);
        }
      }

      // Вспомогательная функция для планирования тона
      function scheduleTone(ctx, frequency) {
           try {
               const oscillator = ctx.createOscillator();
               const gainNode = ctx.createGain();

               gainNode.gain.value = 0.01; // Очень тихо
               oscillator.type = 'sine';
               oscillator.frequency.value = frequency;
               oscillator.connect(gainNode);
               gainNode.connect(ctx.destination);

               // Воспроизводим очень короткий тон
               const startTime = ctx.currentTime;
               oscillator.start(startTime);
               oscillator.stop(startTime + 0.05); // Длительность 50мс
           } catch (e) {
                widgetLog(`Ошибка при планировании тона ${frequency}Hz: ${e.name}: ${e.message}`, 'error');
           }
      }

      // Начинаем воспроизведение тонов
      playNextTone();
    });
  }


  // Воспроизведение тишины (резервная функция для iOS, перемещена)
  function playSilence() {
    try {
      // Создаем контекст если его еще нет или он закрыт
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

      // Создаем и воспроизводим тишину для разблокировки аудио
      const silentBuffer = ctx.createBuffer(1, 1, 22050); // Буфер 1 канал, 1 семпл, 22050 Гц
      const source = ctx.createBufferSource();
      source.buffer = silentBuffer;

      // Нужен GainNode для контроля громкости (ставить в 0)
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0; // Полная тишина

      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      // Воспроизводим очень короткий звук (тишину)
      source.start(0);
      source.stop(0.001); // Длительность 1мс

      window.hasPlayedSilence = true; // Флаг установлен после попытки воспроизведения
      widgetLog("Played silence to unlock audio on iOS");

      // Разблокируем audioContext если он suspended
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          window.audioContextInitialized = true;
          widgetLog("Audio context successfully resumed on iOS after playing silence");
        }).catch(err => {
          widgetLog(`Failed to resume audio context after playSilence: ${err.message}`, 'error');
          window.audioContextInitialized = false;
        });
      } else {
         window.audioContextInitialized = true; // Контекст уже running
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
    if (ua.indexOf('gt') > -1) return 'realme_gt'; // Realme GT

    return 'generic';
  }

  // Функция настройки специфичных параметров для разных Android устройств (перемещена)
  function getOptimizedConstraintsForAndroid() {
    const deviceType = getAndroidDeviceType();
    const baseConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true, // Включаем по умолчанию, может быть скорректировано
      sampleRate: 16000, // Оптимальная частота для ASR
      channelCount: 1, // Моно
      deviceId: 'default' // Использовать микрофон по умолчанию
    };

    // Специфичные настройки для некоторых производителей/моделей, если известны проблемы
    switch (deviceType) {
      case 'samsung':
        // На некоторых Samsung AutoGainControl может быть агрессивным
        // baseConstraints.autoGainControl = false; // Возможно, стоит отключить или настроить
        break;
      case 'pixel':
        // Pixel обычно хорошо справляется с обработкой аудио
        // baseConstraints.noiseSuppression = true; // Уже включено по умолчанию
        break;
      case 'xiaomi':
      case 'redmi':
      case 'poco':
        // Устройства Xiaomi/Redmi/Poco иногда требуют более тонкой настройки
        // baseConstraints.echoCancellation = true; // Уже включено
        // baseConstraints.noiseSuppression = true; // Уже включено
        // baseConstraints.autoGainControl = true; // Уже включено
        // Возможно, требуется sampleRate 48000, а затем ресемплинг
        // baseConstraints.sampleRate = 48000; // Если 16000 вызывает проблемы
        break;
       case 'huawei':
           // Дополнительные проверки для Huawei
           break;
       case 'realme_gt':
            // Дополнительные проверки для Realme GT
            break;
      default:
        // Для других устройств используем наиболее совместимые настройки по умолчанию
        break;
    }

    widgetLog(`Применены оптимизированные настройки для Android устройства типа: ${deviceType}`, 'info', baseConstraints);
    return baseConstraints;
  }


  // Улучшенное качество аудио и нормализация (перемещена)
  function processAudioForUpload(inputData) {
    // Если нет данных, возвращаем пустой массив
    if (!inputData || inputData.length === 0) return new Float32Array(0);

    // Создаем копию данных для обработки
    const processedData = new Float32Array(inputData.length);

    // Анализ данных для нормализации
    let maxAmplitude = 0;
    // let sumAmplitude = 0; // Эта переменная не используется после вычисления avgAmplitude

    for (let i = 0; i < inputData.length; i++) {
      const absValue = Math.abs(inputData[i]);
      maxAmplitude = Math.max(maxAmplitude, absValue);
      // sumAmplitude += absValue;
       processedData[i] = inputData[i]; // Копируем исходные данные
    }

    // Средняя амплитуда не используется для логики нормализации, только maxAmplitude
    // const avgAmplitude = sumAmplitude / inputData.length;

    // Простая нормализация/усиление на основе максимальной амплитуды
    if (maxAmplitude > 0) {
       let gain = 1.0;
       if (maxAmplitude < 0.2) { // Если сигнал слабый (ниже 20% от максимума)
           gain = Math.min(3.0, 0.5 / maxAmplitude); // Усиливаем, но не более чем в 3 раза
           widgetLog(`Усиление аудио из-за низкой амплитуды (${maxAmplitude.toFixed(2)}): gain = ${gain.toFixed(2)}`, 'debug');
       } else if (maxAmplitude > 0.95) { // Если сигнал слишком сильный
            gain = 0.95 / maxAmplitude; // Немного снижаем
             widgetLog(`Снижение усиления аудио из-за высокой амплитуды (${maxAmplitude.toFixed(2)}): gain = ${gain.toFixed(2)}`, 'debug');
       }

       // Применяем усиление
       if (gain !== 1.0) {
           for (let i = 0; i < processedData.length; i++) {
               processedData[i] *= gain;
               // Ограничиваем значение после усиления
               processedData[i] = Math.max(-1, Math.min(1, processedData[i]));
           }
       }
    } else {
       // Если maxAmplitude = 0 (полная тишина), просто возвращаем пустой массив
       widgetLog("processAudioForUpload: Received silent audio data.", "debug");
       return new Float32Array(0);
    }

     // TODO: Реализация высокочастотного фильтра здесь может быть сложной и требовать более продвинутых DSP знаний.
     // Текущий простой фильтр может ухудшить качество. Оставим его закомментированным пока.
     /*
     // Дополнительная обработка для улучшения разборчивости речи (экспериментально)
     // Простой высокочастотный фильтр (требует настройки и может быть неэффективен)
     let prevSample = 0; // Инициализируем здесь для каждого вызова функции
     const alpha = 0.9; // Коэффициент фильтра (близко к 1 для high-pass)
     for (let i = 0; i < processedData.length; i++) {
       const currentSample = processedData[i];
       // High-pass filter formula: y[i] = alpha * y[i-1] + alpha * (x[i] - x[i-1])
       // Simplified for a single pass
       const highpass = alpha * prevSample + currentSample - (i > 0 ? processedData[i-1] : currentSample);
       processedData[i] = highpass;
       prevSample = highpass; // Update prevSample with the *filtered* value
     }
     widgetLog("Applied experimental high-pass filter.", "debug");
     */


    return processedData;
  }


  // Функция для остановки записи микрофона (перемещена)
  function stopMicrophoneCapture() {
    if (!mediaStream) {
      widgetLog("stopMicrophoneCapture: No media stream to stop.", "debug");
      return;
    }

    widgetLog("Stopping microphone capture.");

    // Останавливаем все аудиотреки
    mediaStream.getTracks().forEach(track => {
      if (track.kind === 'audio') {
        track.stop();
        widgetLog(`Stopped audio track: ${track.label}`, "debug");
      }
    });

    // Отключаем processor если он есть
    if (audioProcessor) {
      try {
        audioProcessor.disconnect();
        widgetLog("Disconnected audio processor.", "debug");
      } catch (e) {
        widgetLog('Ошибка при отключении аудиопроцессора: ' + e.message, 'warn');
      }
    }
     // Отключаем источник стрима от контекста, если он был подключен
     if (audioContext && mediaStream) {
        const streamSource = audioContext.createMediaStreamSource(mediaStream); // Пересоздаем источник для отключения
        // Нет прямого способа получить SourceNode по стриму после создания,
        // поэтому надежнее отключить все узлы от источника или просто остановить стрим.
        // Остановка стрима выше обычно достаточно.
     }


    isListening = false;
     mediaStream = null; // Обнуляем ссылку на стрим
     // audioProcessor = null; // Возможно, стоит обнулять, но может потребоваться для переинициализации
  }

  // Восстановление микрофона после окончания воспроизведения (перемещена)
  function restoreMicrophoneIfNeeded() {
    if (isIOS && shouldRestoreMicrophoneAfterPlayback) {
      widgetLog("Restore microphone needed after playback on iOS.");
      shouldRestoreMicrophoneAfterPlayback = false;

      // Даем небольшую паузу перед повторной инициализацией микрофона
      setTimeout(() => {
        // Проверяем, что виджет все еще открыт и подключен, прежде чем восстанавливать
        if (isWidgetOpen && isConnected) {
           widgetLog("Attempting to restore microphone capture on iOS.");
           // Полностью переинициализируем аудио и начнем слушать
           initAudio().then(success => {
             if (success) {
               startListening(); // Запускаем прослушивание, если аудио инициализировано
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
      }, 300); // Пауза 300 мс
    }
  }

  // Улучшенная функция проверки и перезапуска микрофона для Android (перемещена)
  function checkAndroidMicrophoneStatus() {
    // Проверяем только на Android и только если мы активно "слушаем"
    if (!isMobile || isIOS || !isListening) return;
    // Нет смысла проверять, если стрима нет
    if (!mediaStream) {
       widgetLog("checkAndroidMicrophoneStatus: No media stream to check.", "debug");
       return;
    }


    let isAudioActive = false;

    // Проверяем активность треков
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length > 0) {
      audioTracks.forEach(track => {
        if (track.readyState === 'live' && track.enabled) {
          isAudioActive = true;
        } else {
           widgetLog(`checkAndroidMicrophoneStatus: Audio track state: readyState=${track.readyState}, enabled=${track.enabled}`, "debug");
        }
      });
    } else {
       widgetLog("checkAndroidMicrophoneStatus: No audio tracks found in stream.", "warn");
       isAudioActive = false; // Нет треков = неактивен
    }


    // Если треки неактивны, пересоздаем микрофон
    if (!isAudioActive) {
      widgetLog('Обнаружен неактивный микрофон на Android, попытка перезапуска...', 'warn');

      // Останавливаем текущий стрим (это должно быть безопасно даже если он уже неактивен)
      stopMicrophoneCapture(); // stopMicrophoneCapture обнулит mediaStream и отключит processor

      // Проверяем, что виджет все еще открыт и подключен перед попыткой перезапуска
      if (isWidgetOpen && isConnected) {
           widgetLog("Attempting to re-initialize audio stream on Android.");
           // Пересоздаем микрофон и весь аудиограф
           initAudio().then(success => {
             if (success) {
                // Если аудио инициализировано успешно, пытаемся снова начать слушать
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
    // Убедимся, что мониторинг запускается только один раз
    if (window.androidMicMonitorIntervalId) {
        //widgetLog("Android microphone monitoring is already running.", "debug");
        return; // Уже запущен
    }
    if (!isMobile || isIOS) {
       widgetLog("Android microphone monitoring not needed.", "debug");
       return;
    }

    widgetLog('Запущен мониторинг микрофона для Android (интервал 5с)');
    window.androidMicMonitorIntervalId = setInterval(checkAndroidMicrophoneStatus, 5000); // Проверяем микрофон каждые 5 секунд
  }

   // Остановка мониторинга микрофона для Android
   function stopAndroidMicrophoneMonitoring() {
       if (window.androidMicMonitorIntervalId) {
           widgetLog("Stopping Android microphone monitoring.");
           clearInterval(window.androidMicMonitorIntervalId);
           window.androidMicMonitorIntervalId = null;
       }
   }


  // Настройка процессора обработки аудио (перемещена)
  function configureAudioProcessor() {
    // Эта функция должна вызываться только после успешного создания audioProcessor
    if (!audioProcessor) {
       widgetLog("configureAudioProcessor called but audioProcessor is null.", "error");
       return;
    }

    widgetLog("Configuring audio processor onaudioprocess handler.");

    audioProcessor.onaudioprocess = function(e) {
      // Проверяем все флаги перед обработкой и отправкой
      if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting && !isPlayingAudio) { // Добавлена проверка !isPlayingAudio
        // Получаем данные с микрофона
        const inputBuffer = e.inputBuffer;
        const rawInputData = inputBuffer.getChannelData(0);

        // Проверка на пустые данные (может произойти если микрофон остановлен или ошибка)
        if (rawInputData.length === 0) {
           //widgetLog("Received empty audio buffer in onaudioprocess.", "debug");
           resetAudioVisualization(); // Сбрасываем визуал при пустых данных
           // Если мы должны слушать, но получаем пустые данные, возможно, микрофон отвалился (на Android)
           if (isListening && isMobile && !isIOS && mediaStream && mediaStream.active) {
                // checkAndroidMicrophoneStatus(); // Мониторинг сделает это
           }
           return;
        }

        // Применяем улучшенную обработку аудио (нормализация, возможно фильтрация)
        const processedData = processAudioForUpload(rawInputData);

        // Анализируем аудио с помощью детектора голосовой активности
        const vadResult = voiceDetector.process(processedData);

        // Обновляем визуализацию только если активно слушаем
        updateAudioVisualization(processedData);

        // Преобразуем float32 в int16 для отправки через WebSocket
        // TODO: Ресемплинг, если audioContext.sampleRate отличается от требуемого сервером (16000)
        const pcm16Data = new Int16Array(processedData.length);
        for (let i = 0; i < processedData.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(processedData[i] * 32767)));
        }

        // Отправляем данные через WebSocket
        try {
          // TODO: Отправлять данные не сразу, а буферизовать и отправлять по порогу тишины/размеру буфера
          // Текущая логика VAD уже управляет флагом hasAudioData и вызывает commitAudioBuffer
          // Отправка append на каждый аудиопроцесс может быть неоптимальной, лучше буферизовать
          // Для текущей логики, кажется, вы отправляете append постоянно пока слушаете,
          // а commit отправляется по тишине.
          // Убедимся, что send не блокирует и не вызывает ошибок при быстром вызове
          if (websocket.readyState === WebSocket.OPEN) { // Двойная проверка
              const message = JSON.stringify({
                type: "input_audio_buffer.append",
                event_id: `audio_${Date.now()}`,
                audio: arrayBufferToBase64(pcm16Data.buffer)
              });
              websocket.send(message);
              // widgetLog(`Sent append message (${pcm16Data.length} samples).`, "debug"); // Слишком много логов
          }


          // Отмечаем наличие аудиоданных, если обнаружен голос
          // Это нужно для логики commitAudioBuffer
          if (!hasAudioData && vadResult.hasVoice) {
            hasAudioData = true;
            audioDataStartTime = Date.now();
            widgetLog("Начало обнаружения голосовых данных (hasAudioData = true)");
          }
        } catch (error) {
          widgetLog(`Ошибка отправки аудио буфера через WebSocket: ${error.name}: ${error.message}`, "error");
          // Обработка ошибки отправки (возможно, соединение нестабильно)
          // reconnect(); // Автоматический реконнект при каждой ошибке отправки может быть агрессивным
        }

        // Логика определения тишины и автоматической отправки
        const now = Date.now();

        if (vadResult.hasVoice) {
          // Если голос обнаружен, сбрасываем счетчик тишины и убеждаемся, что UI в режиме прослушивания
          voiceDetector.silenceStartTime = now; // Сброс таймера тишины в VAD
          // Активируем визуальное состояние прослушивания, если не воспроизводится аудио
          if (!isPlayingAudio && !mainCircle.classList.contains('listening') && !mainCircle.classList.contains('speaking')) {
            mainCircle.classList.add('listening');
          }
        } else if (hasAudioData && vadResult.isSilent && vadResult.silenceDuration > effectiveAudioConfig.silenceDuration) {
          // Если были голосовые данные (hasAudioData), сейчас тишина, и тишина длится дольше порога
          // Также добавляем проверку, что с момента последнего commit прошло достаточно времени,
          // чтобы избежать слишком частых коммитов при прерывистой речи
          if (now - lastCommitTime > 500) { // Минимум 500мс между коммитами
            widgetLog(`Обнаружена тишина после голоса. Длительность тишины: ${vadResult.silenceDuration}мс. Длительность аудио с голосом: ${now - audioDataStartTime}мс. Отправка аудиобуфера.`);
            commitAudioBuffer(); // Отправляем буфер на сервер
            lastCommitTime = now; // Обновляем время последнего коммита
          } else {
             widgetLog(`Обнаружена тишина, но слишком мало времени прошло с последнего коммита (${now - lastCommitTime}мс). Ожидаем...`, "debug");
          }
        }
      } else {
         // Если не слушаем, соединение закрыто, переподключаемся или воспроизводим - не обрабатываем аудио с микрофона
         //widgetLog("onaudioprocess skipped: !isListening || !websocket || wsState !== OPEN || isReconnecting || isPlayingAudio", "debug");
         // Сбрасываем визуал, если не слушаем
         if (!isListening) {
            resetAudioVisualization();
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
      // Отключаем предыдущие подключения, если были
      if (mediaStream._sourceNode) { // Если мы сохранили ссылку на источник
           mediaStream._sourceNode.disconnect();
           mediaStream._sourceNode = null;
      }
      audioProcessor.disconnect(); // Отключаем процессор ото всего

      const streamSource = audioContext.createMediaStreamSource(mediaStream);
      // Сохраняем ссылку на SourceNode, чтобы можно было его отключить при остановке
      mediaStream._sourceNode = streamSource; // Добавляем свойство к стриму

      streamSource.connect(audioProcessor); // Подключаем источник к процессору

      // Для iOS НЕ соединяем напрямую с выходом (destination), чтобы избежать обратной связи
      // Вместо этого подключаем к GainNode с нулевой громкостью
      if (isIOS) {
        widgetLog('Подключение аудиографа для iOS: процессор -> GainNode (volume 0) -> destination');
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0; // Установка громкости на ноль
        audioProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);
         // Сохраняем ссылку на GainNode для отладки
         audioProcessor._outputNode = gainNode;

      } else {
        // Для других устройств подключаем процессор напрямую к выходу
        widgetLog('Подключение аудиографа для Desktop/Android: процессор -> destination');
        audioProcessor.connect(audioContext.destination);
         audioProcessor._outputNode = audioContext.destination;
      }

      widgetLog("Аудиограф успешно подключен");
    } catch (error) {
      widgetLog(`Ошибка при подключении аудиографа: ${error.name}: ${error.message}`, 'error');
      // Возможно, нужно сбросить аудиосистему при такой ошибке
      stopMicrophoneCapture(); // Останавливаем захват микрофона
      // initAudio(); // Попытка переинициализации может быть нужна
    }
  }

  // Функция для последовательного запуска аудио на мобильных устройствах (перемещена)
  function safeStartListeningOnMobile() {
    // Проверяем все условия перед запуском
    if (!isMobile || isIOS || !isConnected || isPlayingAudio || isReconnecting || isListening || !isWidgetOpen) {
      widgetLog(`safeStartListeningOnMobile skipped: isMobile=${isMobile}, isIOS=${isIOS}, isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, isWidgetOpen=${isWidgetOpen}`, "debug");
      return;
    }

    widgetLog('Безопасный запуск прослушивания на Android');

    // На Android иногда помогает сначала убедиться, что соединение активно, отправив пинг
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      try {
        websocket.send(JSON.stringify({
          type: "ping",
          event_id: `mobile_safe_start_${Date.now()}`
        }));
        widgetLog("Ping sent for safe mobile start.", "debug");

        // Если пинг прошел успешно (без немедленной ошибки), запускаем аудио с задержкой
        // Это дает устройству время "проснуться" или стабилизировать соединение
        setTimeout(() => {
          // Повторно проверяем условия перед запуском
          if (isConnected && !isPlayingAudio && !isReconnecting && !isListening && isWidgetOpen) {
            widgetLog("Attempting startListening after safe mobile delay.");
            startListening(); // Вызываем основную функцию запуска прослушивания
          } else {
             widgetLog(`startListening skipped after mobile delay: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}, isWidgetOpen=${isWidgetOpen}`, "debug");
          }
        }, 700); // Задержка 700 мс
      } catch (e) {
        widgetLog(`Ошибка отправки ping при безопасном запуске на Android: ${e.message}`, 'error');
        // Ошибка отправки может означать, что соединение уже неактивно,
        // оно будет обработано в onError или onClose WebSocket
      }
    } else {
       widgetLog("WebSocket not open for safe mobile start.", "warn");
    }
  }


  // Обновление индикатора статуса соединения (перемещена)
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

    // Скрываем через некоторое время, если это не состояние "Подключение..." или "Отключено"
    if (status === 'connected') {
      // Скрываем через 3 секунды после успешного подключения
       if (statusIndicator._hideTimeout) clearTimeout(statusIndicator._hideTimeout);
       statusIndicator._hideTimeout = setTimeout(() => {
         statusIndicator.classList.remove('show');
         statusIndicator._hideTimeout = null;
       }, 3000);
    } else if (status === 'disconnected') {
        // Показываем ошибку соединения, индикатор может оставаться видимым
        // Оставляем индикатор видимым вместе с сообщением об ошибке
    } else if (status === 'connecting') {
        // Показываем индикатор подключения и не скрываем автоматически
    }
  }

  // Показать сообщение (перемещена)
  function showMessage(message, duration = 5000) {
    if (!messageDisplay) return;

    // Скрываем предыдущие таймауты
    if (messageDisplay._hideTimeoutId) {
      clearTimeout(messageDisplay._hideTimeoutId);
    }

    messageDisplay.textContent = message;
    messageDisplay.classList.add('show');
    widgetLog(`Показано сообщение: "${message}" (длительность ${duration}мс)`);

    if (duration > 0) {
      messageDisplay._hideTimeoutId = setTimeout(() => {
        messageDisplay.classList.remove('show');
        messageDisplay._hideTimeoutId = null;
        widgetLog(`Сообщение скрыто: "${message}"`);
      }, duration);
    }
  }

  // Скрыть сообщение (перемещена)
  function hideMessage() {
    if (!messageDisplay) return;
    if (messageDisplay._hideTimeoutId) {
      clearTimeout(messageDisplay._hideTimeoutId);
      messageDisplay._hideTimeoutId = null;
      widgetLog("Текущее сообщение скрыто.");
    }
    messageDisplay.classList.remove('show');
  }

  // Показать ошибку соединения (перемещена)
  function showConnectionError(message) {
    if (connectionError) {
      widgetLog(`Показана ошибка соединения: "${message}"`);
      // Находим элемент для текста сообщения внутри connectionError
      const messageSpan = connectionError.querySelector('span');
       if(messageSpan) {
            messageSpan.textContent = message || 'Ошибка соединения с сервером';
       } else {
            // Если span нет (структура изменилась?), просто обновляем весь innerHTML
             connectionError.innerHTML = `
                <span>${message || 'Ошибка соединения с сервером'}</span>
                <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
                  Повторить подключение
                </button>
            `;
             // Добавляем обработчик к только что созданной кнопке
             const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
             if(newRetryButton) {
                 newRetryButton.addEventListener('click', resetConnection);
             }
       }


      connectionError.classList.add('visible');
       updateConnectionStatus('disconnected', 'Отключено'); // Обновляем индикатор статуса
    }
  }

  // Скрыть ошибку соединения (перемещена)
  function hideConnectionError() {
    if (connectionError) {
      widgetLog("Ошибка соединения скрыта.");
      connectionError.classList.remove('visible');
    }
  }

  // Сброс состояния соединения и повторная попытка (перемещена)
  function resetConnection() {
    widgetLog("Resetting connection state and attempting reconnect.");
    // Сбрасываем счетчик попыток и флаги
    reconnectAttempts = 0;
    connectionFailedPermanently = false;
    isReconnecting = false; // Сбрасываем флаг, так как начинаем новую серию попыток

    // Скрываем сообщения и ошибки
    hideConnectionError();
    hideMessage();

    // Показываем сообщение о повторном подключении и обновляем статус
    showMessage("Попытка подключения...");
    updateConnectionStatus('connecting', 'Подключение...');

    // Пытаемся подключиться заново
    connectWebSocket();
  }

  // Открыть виджет (перемещена)
  function openWidget() {
    if (isWidgetOpen) {
      widgetLog("Widget is already open.", "debug");
      return;
    }
    widgetLog("Opening widget.");

    // Проверяем, что элементы UI найдены
     if (!widgetContainer || !widgetButton || !document.getElementById('wellcomeai-widget-expanded')) {
         widgetLog("Cannot open widget: UI elements not found.", "error");
         // Возможно, нужно вызвать initWidget() снова или показать ошибку
         if (!widgetContainer || !widgetButton) {
            widgetLog("Critical UI elements missing.", "error");
            alert("Critical widget error: UI elements missing."); // Критическая ошибка
            return;
         }
          // Если expanded widget не найден, но контейнер и кнопка есть, возможно, HTML неполный
           widgetLog("Expanded widget element not found. Cannot open.", "error");
           return;
     }


    // Принудительно устанавливаем z-index для решения конфликтов
    widgetContainer.style.zIndex = "2147483647";
    widgetButton.style.zIndex = "2147483647";

    widgetContainer.classList.add('active');
    isWidgetOpen = true;

    // Принудительно устанавливаем видимость расширенного виджета (на случай, если transition не сработает)
    const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
    if (expandedWidget) {
      expandedWidget.style.opacity = "1";
      expandedWidget.style.height = "400px"; // Устанавливаем конечную высоту
      expandedWidget.style.pointerEvents = "all";
      expandedWidget.style.zIndex = "2147483647";
    }

    // Специальная обработка для iOS устройств
    if (isIOS) {
      // Показываем специальную кнопку для iOS если нужно
      if (iosAudioButton && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
        widgetLog("Showing iOS audio activation button.");
        iosAudioButton.classList.add('visible');

        // Добавляем обработчик к iOS кнопке, если его еще нет
         if (!iosAudioButton._listenerAdded) {
             iosAudioButton.addEventListener('click', function() {
               widgetLog("iOS audio activation button clicked.");
               unlockAudioOnIOS().then(success => {
                 if (success) {
                   widgetLog("iOS audio unlock successful after button click.");
                   iosAudioButton.classList.remove('visible');
                   hideMessage(); // Скрываем сообщение, связанное с iOS активацией

                   // Пытаемся начать слушать после активации аудио, если виджет открыт
                   setTimeout(() => {
                     if (isConnected && !isListening && !isPlayingAudio && isWidgetOpen) {
                       startListening();
                     } else {
                        widgetLog("Not starting listening after iOS unlock button click: conditions not met.", "debug");
                     }
                   }, 500);
                 } else {
                    widgetLog("iOS audio unlock failed after button click.", "error");
                    showMessage("Не удалось активировать аудио на iOS. Попробуйте снова.");
                 }
               });
             }, { once: true }); // Обработчик сработает только один раз
             iosAudioButton._listenerAdded = true; // Отмечаем, что обработчик добавлен
         } else {
             widgetLog("iOS audio activation button listener already added.", "debug");
         }
      }

      // Пытаемся сразу разблокировать аудио пассивным методом (может сработать после жеста пользователя)
      if (!window.hasPlayedSilence) {
        widgetLog("Attempting passive iOS audio unlock on widget open.");
        unlockAudioOnIOS(); // Нет await здесь, чтобы не блокировать открытие виджета
      }
    }
    // Для других мобильных (Android)
    else if (isMobile && !window.audioContextInitialized) {
      // На мобильных сначала даем WebSocket-соединению стабилизироваться
      // и только потом инициализируем аудиоконтекст
      widgetLog("На мобильном устройстве (не iOS) - отложенная инициализация аудио.");

      // Показываем сообщение о подключении/инициализации
      // showMessage("Подключение..."); // Это сообщение показывается при соединении

      // Отложенная инициализация аудиоконтекста для стабильности соединения
      setTimeout(() => {
        // Проверяем, что виджет все еще открыт и аудио еще не инициализировано
        if (isWidgetOpen && !window.audioContextInitialized) {
          widgetLog("Mobile audio context инициализируется с задержкой.");
          initAudio().then(success => {
            if (success) {
              widgetLog("Mobile audio context инициализирован успешно.");
              // Пытаемся начать слушать после инициализации аудио
               if (isConnected && !isListening && !isPlayingAudio && !isReconnecting && isWidgetOpen) {
                 startListening();
               } else {
                 widgetLog("Not starting listening after mobile audio init: conditions not met.", "debug");
               }
            } else {
              widgetLog("Mobile audio context инициализация не удалась.", "error");
              // Сообщение об ошибке уже будет показано в initAudio
            }
          }).catch(e => {
             widgetLog(`Error during mobile audio initialization: ${e.message}`, "error");
             // Сообщение об ошибке уже будет показано в initAudio
          });
        } else {
           widgetLog("Mobile audio init skipped after delay: widget closed or already initialized.", "debug");
        }
      }, 2000); // Задержка 2 секунды
    }

    // Показываем сообщение о проблеме с подключением, если оно есть
    if (connectionFailedPermanently) {
      showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
      // Не пытаемся начать слушать автоматически
      updateConnectionStatus('disconnected', 'Отключено');
       return; // Прекращаем дальнейшую логику открытия
    }

    // Запускаем прослушивание при открытии, если соединение активно и виджет открыт, и не в процессе переподключения/воспроизведения
    // На iOS не запускаем прослушивание автоматически, пока не активированы разрешения на аудио
    if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
      if (isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
        // На iOS ждем клика по кнопке или пассивной разблокировки
        showMessage("Нажмите кнопку ниже для активации голосового помощника", 0); // Показываем сообщение без автоматического скрытия
        updateConnectionStatus('connected', 'Подключено'); // Соединение есть
      } else {
        // Для Desktop и Android (после отложенной инициализации)
        widgetLog("Attempting startListening on widget open.");
        startListening(); // Запускаем прослушивание
        updateConnectionStatus('connected', 'Подключено'); // Обновляем статус на случай, если он был неактивен
      }
    } else if (!isConnected && !isReconnecting) {
      // Если соединение не активно и не находимся в процессе переподключения,
      // пытаемся подключиться снова. Лоадер и статус будут обновлены в connectWebSocket.
      widgetLog("Widget opened, but not connected. Attempting to connect WebSocket.");
      connectWebSocket();
      updateConnectionStatus('connecting', 'Подключение...');
      showMessage("Подключение...");
    } else {
      widgetLog(`Cannot start listening yet (widget open): isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
      if (isReconnecting) {
        updateConnectionStatus('connecting', 'Переподключение...');
        showMessage("Переподключение...");
      } else if (isPlayingAudio) {
        showMessage("Подождите, пока завершится ответ...");
        mainCircle.classList.remove('listening'); // Убедимся, что нет визуализации прослушивания
        mainCircle.classList.add('speaking'); // Убедимся, что визуал в режиме говорения
      } else if (isListening) {
         // Уже слушаем, ничего делать не нужно
         widgetLog("Widget opened, already listening.", "debug");
      } else {
          // Состояние "не подключен, не переподключается, не слушаю, не говорю"
          // Это может произойти после ошибки или закрытия соединения без автоматического переподключения
           widgetLog("Widget opened, connection is inactive.", "info");
           updateConnectionStatus('disconnected', 'Отключено');
           showConnectionError('Соединение не установлено. Нажмите "Повторить подключение".');
      }
    }

    // Убираем пульсацию с кнопки
    widgetButton.classList.remove('wellcomeai-pulse-animation');
  }

  // Закрыть виджет (перемещена)
  function closeWidget() {
    if (!isWidgetOpen) {
      widgetLog("Widget is already closed.", "debug");
      return;
    }
    widgetLog("Closing widget.");

    // Останавливаем все аудио процессы (захват микрофона и воспроизведение)
    stopAllAudioProcessing();

    // Скрываем виджет (запускается CSS transition)
    widgetContainer.classList.remove('active');
    isWidgetOpen = false; // Сбрасываем флаг сразу

    // Скрываем сообщения и ошибки
    hideMessage();
    hideConnectionError();

    // Скрываем индикатор статуса
    if (statusIndicator) {
      statusIndicator.classList.remove('show');
       if (statusIndicator._hideTimeout) clearTimeout(statusIndicator._hideTimeout);
       statusIndicator._hideTimeout = null;
    }

    // Скрываем кнопку активации iOS
    if (iosAudioButton) {
      iosAudioButton.classList.remove('visible');
       // Удаляем одноразовый обработчик, если он еще висит
       if (iosAudioButton._listenerAdded) {
           // Удаление одноразового обработчика с { once: true } не требуется вручную
           iosAudioButton._listenerAdded = false; // Сбрасываем наш флаг
       }
    }

    // Принудительно скрываем расширенный виджет (на случай, если transition не сработает)
    const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
    if (expandedWidget) {
      expandedWidget.style.opacity = "0";
      expandedWidget.style.height = "0"; // Устанавливаем нулевую высоту
      expandedWidget.style.pointerEvents = "none"; // Делаем некликабельным
       // Сбрасываем z-index расширенного виджета после анимации, если нужно
       // (уже установлен в 2147483647 в стилях, но может быть нужно управлять динамически)
    }

    // Сбрасываем z-index контейнера и кнопки после анимации закрытия
    setTimeout(() => {
      if (!isWidgetOpen) { // Проверяем, что виджет действительно остался закрытым
        widgetContainer.style.zIndex = ""; // Возвращаем к стандартному (или null)
        widgetButton.style.zIndex = "";
        widgetLog("Widget z-indices reset.");
      }
    }, 600); // Немного дольше, чем CSS transition (0.5s)
  }


  // Создаем аудио-бары для визуализации (перемещена)
  function createAudioBars(count = 20) {
    if (!audioBars) {
       widgetLog("createAudioBars called but audioBars element not found.", "error");
       return;
    }
    audioBars.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const bar = document.createElement('div');
      bar.className = 'wellcomeai-audio-bar';
      audioBars.appendChild(bar);
    }
     widgetLog(`Created ${count} audio bars.`);
  }

  // Обновление аудио визуализации (перемещена)
  function updateAudioVisualization(audioData) {
    // Обновляем визуал только если элементы существуют, виджет открыт, слушаем и НЕ воспроизводим аудио
    if (!audioBars || !mainCircle || !isWidgetOpen || !isListening || isPlayingAudio) {
      //widgetLog(`updateAudioVisualization skipped: !audioBars || !mainCircle || !isWidgetOpen || !isListening || isPlayingAudio`, "debug");
      // Если мы не слушаем, но визуал показывается, нужно его сбросить
      // Но лучше делать это при явной остановке или смене состояния
      // resetAudioVisualization(); // Не здесь
      return;
    }

    const bars = audioBars.children;
    if (!bars.length) return;

    // Вычисляем RMS громкость для всего буфера
    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
      sumSquares += audioData[i] * audioData[i];
    }
    const rms = Math.sqrt(sumSquares / audioData.length);

    // Масштабируем RMS для визуализации (примерные коэффициенты)
    // rms находится в диапазоне [0, 1] для Float32Array
    let visualizationVolume = rms * 200; // Увеличиваем масштаб
    visualizationVolume = Math.min(50, Math.max(2, visualizationVolume)); // Ограничение от 2px до 50px

    // Применяем высоту к каждому бару.
    // Можно сделать более сложную визуалку, где бары имеют разную высоту,
    // но для простоты пока все бары показывают один и тот же уровень.
    // Или можно поделить буфер на части и вычислять RMS для каждой части.
    const numBars = bars.length;
    const samplesPerBar = Math.floor(audioData.length / numBars);

    for (let i = 0; i < numBars; i++) {
      const start = i * samplesPerBar;
      let barVolume = 0;
      let barSumSquares = 0;
      const end = Math.min(start + samplesPerBar, audioData.length);

      if (end > start) {
         for (let j = start; j < end; j++) {
             barSumSquares += audioData[j] * audioData[j];
         }
         barVolume = Math.sqrt(barSumSquares / (end - start));
         barVolume = barVolume * 200; // Масштабируем так же, как общий объем
         barVolume = Math.min(50, Math.max(2, barVolume));
      } else {
          barVolume = 2; // Минимальная высота
      }

      // Применяем высоту к бару
      bars[i].style.height = barVolume + 'px';
    }
     // widgetLog(`Viz update: RMS = ${rms.toFixed(4)}, VizVolume = ${visualizationVolume.toFixed(2)}px`, "debug");
  }

  // Сброс визуализации (перемещена)
  function resetAudioVisualization() {
    if (!audioBars) return;
    //widgetLog("Resetting audio visualization.");
    const bars = audioBars.children;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.height = '2px'; // Устанавливаем минимальную высоту
    }
  }

  // Функция преобразования ArrayBuffer в Base64 (перемещена)
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

  // Функция конвертации Base64 в ArrayBuffer (перемещена)
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


  // Воспроизведение аудио из очереди (перемещена)
  function playNextAudioInQueue() {
    if (audioPlaybackQueue.length === 0) {
      widgetLog("Очередь воспроизведения пуста.");
      isPlayingAudio = false; // Воспроизведение завершено

      // Восстанавливаем микрофон если нужно после завершения всей очереди
      restoreMicrophoneIfNeeded();

      // Если виджет открыт, подключен, не слушаем, не в процессе переподключения,
      // и класс speaking уже снят (это делает обработчик speech.done),
      // то можно снова начать слушать.
      // Даем небольшую задержку, чтобы UI успел обновиться после снятия speaking
      setTimeout(() => {
        if (isWidgetOpen && isConnected && !isListening && !isReconnecting && mainCircle && !mainCircle.classList.contains('speaking')) {
          widgetLog("Очередь пуста, условия для начала прослушивания выполнены. Начинаем прослушивание.");
          startListening();
        } else {
          widgetLog(`Очередь пуста, но условия для начала прослушивания не выполнены: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isReconnecting=${isReconnecting}, isSpeaking=${mainCircle ? mainCircle.classList.contains('speaking') : 'N/A'}`, "debug");
        }
      }, 100); // Короткая задержка

      return; // Выход из рекурсии
    }

    isPlayingAudio = true;
    widgetLog(`Начало воспроизведения аудиофрагмента. В очереди: ${audioPlaybackQueue.length}`);

    // Для iOS нужно сохранить состояние микрофона и остановить запись
    if (isIOS && isListening) {
      widgetLog("Пауза записи микрофона на iOS на время воспроизведения.");
      shouldRestoreMicrophoneAfterPlayback = true;
      stopMicrophoneCapture(); // Останавливаем микрофон (устанавливает isListening = false)
    }

    // Берем следующий фрагмент аудио из очереди
    const audioData = audioPlaybackQueue.shift();

    // Проверяем наличие и состояние AudioContext
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
          // Восстанавливаем микрофон, если нужно (даже если воспроизведение не удалось)
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

        // Подключаем к выходу (destination)
        // Убедимся, что AudioContext destination доступен
        if (!audioContext.destination) {
          widgetLog("AudioContext destination is not available!", "error");
          // Обработка ошибки - возможно, нужно закрыть и переинициализировать контекст
          isPlayingAudio = false;
          audioPlaybackQueue = []; // Очищаем очередь
          showMessage("Ошибка воспроизведения: AudioContext не готов.");
          restoreMicrophoneIfNeeded();
          return;
        }

        // Подключаем источник к выходу напрямую для воспроизведения
        // TODO: Возможно, стоит добавить GainNode для контроля громкости воспроизведения
        source.connect(audioContext.destination);
        widgetLog("Source node connected to destination.");


        // По окончании воспроизведения текущего фрагмента
        source.onended = function() {
          widgetLog("Воспроизведение текущего аудиофрагмента завершено.");
          // Воспроизводим следующий фрагмент если есть
          if (audioPlaybackQueue.length > 0) {
            playNextAudioInQueue(); // Рекурсивный вызов для следующего в очереди
          } else {
            // Очередь полностью завершена, isPlayingAudio = false уже будет установлено в playNextAudioInQueue
            widgetLog("Вся очередь воспроизведения завершена.");
            // Дальнейшая логика (восстановление микрофона, начало прослушивания) происходит в playNextAudioInQueue, когда очередь пуста
          }
        };

        // Запускаем воспроизведение
        source.start(0); // Начать немедленно
        widgetLog("source.start(0) called.");

        // Обновляем визуал, если он должен показывать состояние говорения
        if (mainCircle) {
           mainCircle.classList.remove('listening');
           mainCircle.classList.add('speaking');
        }

      },
      // Ошибка декодирования
      function(error) {
        widgetLog(`Ошибка декодирования аудио: ${error.message}`, "error");
        // Пропускаем этот фрагмент и переходим к следующему в очереди
        playNextAudioInQueue();
      }
    );
  }

  // Функция переподключения (вызывается из onclose при ошибке, перемещена)
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
      // Удаляем обработчики, чтобы они не срабатывали при закрытии, вызванном вручную
      websocket.onopen = websocket.onerror = websocket.onclose = websocket.onmessage = null;
      try {
        // Закрываем принудительно, если он не закрыт
        if (websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
          websocket.close(1000, "Reconnecting"); // Используем код 1000, чтобы onclose не вызывал reconnect снова при штатном закрытии
        }
      } catch (e) {
        widgetLog(`Ошибка закрытия websocket при reconnect: ${e.message}`, "warn");
      }
      websocket = null; // Очищаем ссылку после попытки закрытия
    }

    // Сбрасываем флаги состояния виджета
    isConnected = false;

    // Останавливаем аудиопроцессы, так как отправлять данные некуда
    stopAllAudioProcessing(); // Этот вызов сбросит isListening = false

    // Логика повторных попыток теперь в connectWebSocket и его обработчиках error/close
    // Просто вызываем connectWebSocket для начала новой попытки
    connectWebSocket();
  }

  // Подключение WebSocket (перемещена)
  function connectWebSocket() {
    if (websocket && (websocket.readyState === WebSocket.CONNECTING ||
        websocket.readyState === WebSocket.OPEN)) {
      widgetLog("WebSocket уже подключен или в процессе подключения");
      // Возможно, обновить статус, если он некорректен
       if (!isReconnecting && websocket.readyState === WebSocket.CONNECTING) {
           updateConnectionStatus('connecting', 'Подключение...');
       } else if (!isConnected && websocket.readyState === WebSocket.OPEN) {
            updateConnectionStatus('connected', 'Подключено');
       }
      return;
    }

     // Если достигнут лимит попыток, не пытаемся подключиться снова, пока пользователь не нажмет кнопку
     if (connectionFailedPermanently) {
         widgetLog("Cannot connect WebSocket: Permanent connection failure flag is set.", "warn");
         showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
         updateConnectionStatus('disconnected', 'Отключено');
         return;
     }


    widgetLog(`Попытка подключения WebSocket к ${WS_URL}. Попытка #${reconnectAttempts + 1}`);
    isReconnecting = true; // Устанавливаем флаг перед попыткой
    loaderModal.classList.add('active'); // Показываем лоадер

    // Очищаем предыдущий WebSocket объект, если он существовал и не был закрыт корректно
    if (websocket) {
      widgetLog("Cleaning up previous websocket object.");
      websocket.onopen = websocket.onerror = websocket.onclose = websocket.onmessage = null; // Удаляем старые обработчики
      try {
         // Попытка закрыть, если не закрыт (может выбросить ошибку, если уже закрыт)
         if (websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
             websocket.close(); // Просто close, без кода, чтобы onclose обработал как ошибку
         }
      } catch(e) { widgetLog("Error cleaning up previous websocket:", e.message, "warn"); }
       websocket = null; // Обнуляем ссылку
    }

    try {
      // Создаем новое WebSocket соединение
      websocket = new WebSocket(WS_URL);

      // Установка тайм-аута для подключения
      const connectionTimeoutId = setTimeout(() => {
        widgetLog(`Таймаут соединения WebSocket (${CONNECTION_TIMEOUT}мс)`, "error");
        // Если WebSocket еще не в состоянии OPEN или CLOSING/CLOSED
        if (websocket && websocket.readyState !== WebSocket.OPEN &&
            websocket.readyState !== WebSocket.CLOSING && websocket.readyState !== WebSocket.CLOSED) {
            widgetLog("Закрываем WebSocket из-за таймаута.");
            websocket.close(); // Закрываем соединение, что вызовет onclose
        } else if (websocket) {
            widgetLog(`WebSocket state is ${websocket.readyState} when timeout fired. No action needed.`, "debug");
        } else {
             widgetLog("WebSocket object is null when timeout fired.", "warn");
             // Если websocket стал null (например, из-за очень ранней ошибки), нужно вручную инициировать переподключение
             if (!isReconnecting && !connectionFailedPermanently) {
                 reconnectAttempts++;
                 const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
                  if (reconnectAttempts <= maxAttempts) {
                       widgetLog(`WebSocket object null on timeout, attempting manual reconnect ${reconnectAttempts}/${maxAttempts}`);
                       setTimeout(connectWebSocket, 1000 * Math.min(reconnectAttempts, 5));
                       updateConnectionStatus('connecting', 'Переподключение...');
                       showMessage("Переподключение...");
                  } else {
                       widgetLog("Max reconnect attempts reached after WebSocket null on timeout.", "error");
                       connectionFailedPermanently = true;
                       isReconnecting = false;
                       loaderModal.classList.remove('active');
                       showConnectionError('Не удалось подключиться к серверу. Проверьте соединение с интернетом и попробуйте снова.');
                       showMessage("Ошибка соединения с сервером");
                       updateConnectionStatus('disconnected', 'Отключено');
                  }
             }
        }
      }, CONNECTION_TIMEOUT);

      // Обработчик успешного подключения
      websocket.onopen = function() {
        widgetLog("WebSocket соединение установлено");

        // Очищаем таймаут подключения
        clearTimeout(connectionTimeoutId);

        isConnected = true; // Устанавливаем флаг подключено
        isReconnecting = false; // Сбрасываем флаг переподключения
        loaderModal.classList.remove('active'); // Скрываем лоадер
        hideConnectionError(); // Скрываем сообщение об ошибке, если было
        hideMessage(); // Скрываем сообщения типа "Подключение..."

        // Сбрасываем счетчик попыток после успешного подключения
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
              widgetLog("Ping sent.", "debug");

              // Проверяем, получили ли мы ответ на предыдущий ping в течение разумного времени
              // Если lastPongTime значительно отстает от lastPingTime
              if (Date.now() - lastPongTime > (isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL) * 2 + 5000) { // Если pong не приходил в течение 2х интервалов + 5с
                widgetLog(`Нет ответа на ping в течение ${Date.now() - lastPongTime}мс, переподключение...`, "warn");
                reconnect(); // Инициируем переподключение
              }
            } catch (e) {
              widgetLog(`Ошибка отправки ping: ${e.message}`, "error");
              reconnect(); // Ошибка отправки также указывает на проблему
            }
          } else {
            // Если WebSocket не открыт, очищаем интервал пинга
            if (pingIntervalId) {
              clearInterval(pingIntervalId);
              pingIntervalId = null;
               widgetLog("WebSocket не открыт, остановлен интервал пинга.", "debug");
            }
          }
        }, isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL); // Интервал пинга зависит от устройства

        // Запускаем прослушивание если виджет открыт и условия позволяют
        if (isWidgetOpen && !isListening && !isPlayingAudio) {
          // На мобильных устройствах (не iOS) используем безопасный метод запуска с задержкой
          if (isMobile && !isIOS) {
            safeStartListeningOnMobile();
          } else {
            // На Desktop и iOS (после активации)
             // Проверим, что аудио инициализировано перед стартом прослушивания
             if (audioContext && audioContext.state !== 'closed') { // AudioContext должен быть доступен
                 widgetLog("WebSocket opened, widget open, starting listening.");
                 startListening(); // Запускаем прослушивание
             } else {
                 widgetLog("WebSocket opened, widget open, but audio not initialized. Will start listening after audio init.", "info");
                 // Прослушивание будет запущено после инициализации аудио в initAudio
             }
          }
        } else {
          widgetLog(`Not starting listening on WS open: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}`, "debug");
        }

        updateConnectionStatus('connected', 'Подключено'); // Обновляем индикатор

      };

      // Обработчик ошибок WebSocket
      websocket.onerror = function(error) {
        // Ошибки часто сопровождаются событием onclose, поэтому основная логика переподключения в onclose
        // Логируем ошибку, но не предпринимаем действия, чтобы onclose обработал закрытие
        widgetLog(`WebSocket ошибка: ${error.message || "Неизвестная ошибка"}`, "error", error);
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
        stopAllAudioProcessing(); // Устанавливает isListening = false, очищает очереди

        // Пробуем переподключиться, если это не было преднамеренное закрытие (код 1000)
        // и если мы не достигли максимального количества попыток
        if (event.code !== 1000 && !connectionFailedPermanently) {
          reconnectAttempts++;
          const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

          if (reconnectAttempts <= maxAttempts) {
            widgetLog(`Соединение закрыто (${event.code}), попытка переподключения ${reconnectAttempts}/${maxAttempts}`);

            isReconnecting = true; // Устанавливаем флаг переподключения

            // Экспоненциальная задержка с рандомным джиттером для предотвращения thundering herd
            const delay = Math.min(reconnectAttempts, 5) * 1000 + Math.random() * 500; // От 1 до 5 секунд + джиттер до 0.5с
            widgetLog(`Задержка перед следующей попыткой: ${delay.toFixed(0)}мс`);

            setTimeout(() => {
              connectWebSocket(); // Запускаем следующую попытку подключения
            }, delay);

            updateConnectionStatus('connecting', `Переподключение (${reconnectAttempts})...`);
            showMessage(`Переподключение...`);

          } else {
            widgetLog(`Достигнуто максимальное количество попыток (${maxAttempts}), соединение не установлено`, "error");

            connectionFailedPermanently = true; // Устанавливаем флаг окончательной ошибки
            isReconnecting = false; // Сбрасываем флаг переподключения

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
            showMessage("Соединение закрыто."); // Показываем сообщение о штатном закрытии
          }
        } else {
          // Соединение закрыто после достижения лимита попыток (connectionFailedPermanently = true)
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
            // если он был в другом состоянии (например, после временной потери связи)
            if (!isConnected) {
              isConnected = true;
              updateConnectionStatus('connected', 'Подключено');
              hideConnectionError(); // Скрываем ошибку, если она была показана
              hideMessage(); // Скрываем сообщения о переподключении
              widgetLog("Connection status updated to 'connected' after receiving pong.", "info");
            }
            if (isReconnecting) {
              isReconnecting = false; // Если был в процессе переподключения, но получили pong
              widgetLog("isReconnecting flag reset after receiving pong.", "debug");
            }
            // Если виджет открыт и не слушаем, но подключение восстановлено, пытаемся начать слушать
            if (isWidgetOpen && !isListening && !isPlayingAudio) {
               widgetLog("Pong received, widget open, not listening/playing. Attempting startListening.");
               // На мобильных используем безопасный старт
               if (isMobile && !isIOS) {
                   safeStartListeningOnMobile();
               } else {
                   startListening();
               }
            }

            return; // Обработка pong завершена
          }

          // Обработка сообщений с аудио
          if (message.type === "speech.data") {
            if (message.data && message.data.audio) {
              //widgetLog(`Получен аудиофрагмент (${message.data.audio.length} bytes Base64)`, "debug"); // Слишком много логов
              // Преобразуем base64 в бинарные данные
              const audioData = base64ToArrayBuffer(message.data.audio);

              // Добавляем аудио в очередь воспроизведения
              audioPlaybackQueue.push(audioData);
              //widgetLog(`Аудио добавлено в очередь воспроизведения. Очередь: ${audioPlaybackQueue.length}`, "debug");

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
            if (mainCircle) {
                mainCircle.classList.remove('listening'); // Убираем состояние прослушивания
                mainCircle.classList.add('speaking'); // Добавляем состояние говорения
            }
            // Останавливаем запись микрофона на время говорения, если она была активна
            if (isListening) {
                widgetLog("Stopping microphone capture due to speech.started.");
                stopMicrophoneCapture(); // isListening будет false после этого
            }
          }

          // Обработка завершения генерации речи
          if (message.type === "speech.done") {
            widgetLog("Генерация речи завершена (speech.done).");
            // После завершения всего ответа и проигрывания аудио
            // возвращаемся к прослушиванию.
            // Подождем немного, чтобы воспроизведение успело завершиться.
            setTimeout(() => {
              widgetLog("Завершение состояния 'speaking'.");
              if (mainCircle) {
                 mainCircle.classList.remove('speaking');
              }

              // Восстановление микрофона и начало прослушивания произойдет в playNextAudioInQueue
              // после того, как очередь воспроизведения полностью опустеет и isPlayingAudio станет false.
              // Поэтому явный вызов startListening здесь может быть избыточен или преждевременен.
              // Если playNextAudioInQueue корректно вызывает restoreMicrophoneIfNeeded и затем startListening
              // при опустошении очереди, то этот setTimeout не нужен для запуска прослушивания,
              // а только для снятия класса 'speaking'.

              // Проверяем, если очередь воспроизведения уже пуста (может быть, ответ был только текстовым)
              if (audioPlaybackQueue.length === 0 && !isPlayingAudio) {
                  widgetLog("Speech done, playback queue is empty. Checking if listening can start.");
                  if (isWidgetOpen && isConnected && !isListening && !isReconnecting) {
                     widgetLog("Conditions met after speech.done and empty queue. Starting listening.");
                      startListening(); // Начинаем слушать, если все условия выполнены
                  } else {
                     widgetLog(`Conditions not met for starting listening after speech.done and empty queue: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isReconnecting=${isReconnecting}`, "debug");
                  }
              } else {
                  widgetLog(`Speech done, but playback queue is not empty (${audioPlaybackQueue.length}) or isPlayingAudio=${isPlayingAudio}. Will start listening after playback finishes.`, "debug");
              }


            }, 500); // Небольшая задержка для UI/воспроизведения
          }

        } catch (error) {
          widgetLog(`Ошибка обработки сообщения от сервера: ${error.name}: ${error.message}`, "error");
          // Возможно, сообщение от сервера было некорректным JSON
          showMessage("Ошибка обработки ответа от сервера.");
        }
      };
    } catch (error) {
      widgetLog(`Ошибка создания WebSocket: ${error.name}: ${error.message}`, "error");

      isReconnecting = false; // Сбрасываем флаг
      loaderModal.classList.remove('active'); // Убираем лоадер

      // Увеличиваем счетчик попыток, так как создание объекта WebSocket не удалось
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


  // --- Основная логика инициализации виджета ---

  // Функция инициализации UI элементов и обработчиков
  function initWidget() {
    // Проверяем, что ID ассистента существует
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag.", 'error');
      alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
      connectionFailedPermanently = true; // Помечаем как постоянную ошибку, чтобы не пытаться бесконечно
      showConnectionError('Ошибка: Assistant ID не найден. Проверьте консоль.');
      return; // Прерываем инициализацию
    }

    // Получаем ссылки на элементы UI
    widgetContainer = document.getElementById('wellcomeai-widget-container');
    widgetButton = document.getElementById('wellcomeai-widget-button');
    widgetClose = document.getElementById('wellcomeai-widget-close');
    mainCircle = document.getElementById('wellcomeai-main-circle');
    audioBars = document.getElementById('wellcomeai-audio-bars');
    loaderModal = document.getElementById('wellcomeai-loader-modal');
    messageDisplay = document.getElementById('wellcomeai-message-display');
    connectionError = document.getElementById('wellcomeai-connection-error');
    // Кнопка повтора находится внутри connectionError
    retryButton = connectionError ? connectionError.querySelector('#wellcomeai-retry-button') : null;
    statusIndicator = document.getElementById('wellcomeai-status-indicator');
    statusDot = document.getElementById('wellcomeai-status-dot');
    statusText = document.getElementById('wellcomeai-status-text');
    iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');


    // Проверка всех необходимых элементов
    const requiredElements = {
       'widgetContainer': widgetContainer,
       'widgetButton': widgetButton,
       'widgetClose': widgetClose,
       'mainCircle': mainCircle,
       'audioBars': audioBars,
       'loaderModal': loaderModal,
       'messageDisplay': messageDisplay,
       'connectionError': connectionError,
       'statusIndicator': statusIndicator,
       'statusDot': statusDot,
       'statusText': statusText,
       'iosAudioButton': iosAudioButton // iOS кнопка тоже считается обязательной, т.к. на iOS без нее никак
    };

    let missingElements = [];
    for (const id in requiredElements) {
       if (!requiredElements[id]) {
          missingElements.push(`#${id}`);
       }
    }

    if (missingElements.length > 0) {
       const errorMessage = `WellcomeAI Widget Error: Missing required UI elements: ${missingElements.join(', ')}. Cannot initialize.`;
       widgetLog(errorMessage, 'error');
       alert(errorMessage);
       connectionFailedPermanently = true; // Критическая ошибка, не можем работать
       // Пытаемся показать ошибку соединения, если хотя бы connectionError найден
       if (connectionError) {
           showConnectionError("Критическая ошибка инициализации виджета. Не найдены все элементы.");
       }
       return; // Прекращаем инициализацию
    }


    // Инициализируем детектор голосовой активности (перемещен)
    voiceDetector = new VoiceActivityDetector({
      threshold: effectiveAudioConfig.soundDetectionThreshold, // Используем выбранный порог из конфига
      minSilenceDuration: effectiveAudioConfig.silenceDuration, // Используем выбранную длительность тишины
      minSpeechDuration: 300, // Можно оставить константой
      smoothingFactor: 0.2 // Можно оставить константой
    });
    widgetLog("VoiceActivityDetector initialized.");
    createAudioBars(); // Создаем бары визуализации при инициализации виджета UI


    // Добавляем обработчики событий для UI элементов (основные кнопки)
    widgetButton.addEventListener('click', function() {
      widgetLog("Widget button clicked.");
      if (!isWidgetOpen) {
        openWidget();
      } else {
        closeWidget();
      }
    });

    widgetClose.addEventListener('click', closeWidget);
     widgetLog("Widget button and close button listeners added.");


    // Обработчик для кнопки повторного подключения (находится внутри connectionError)
    // Кнопка уже найдена выше в requiredElements
    if (retryButton) {
       // Проверяем, не добавлен ли уже обработчик (например, при предыдущих ошибках)
       // Простой флаг или удаление предыдущего обработчика, если возможно
       // В данном случае, так как кнопка не пересоздается при вызове showConnectionError,
       // достаточно добавить обработчик один раз здесь.
       // Если вы изменяли innerHTML connectionError, то кнопку нужно искать и добавлять обработчик там.
        retryButton.addEventListener('click', resetConnection);
       widgetLog("Retry button listener added.");
    } else {
        widgetLog("Retry button element not found during init.", "warn");
        // Если кнопка не найдена здесь, она, возможно, создается динамически в showConnectionError.
        // В этом случае обработчик должен добавляться именно там после создания элемента.
        // В текущей версии HTML кнопка есть изначально, поэтому этот else не должен выполняться,
        // если connectionError найден.
    }

    // Виджет инициализирован, теперь можно пытаться подключиться к WebSocket
    widgetLog("initWidget completed. UI elements found, listeners added.");

    // Начальное состояние лоадера - показываем, пока не получим статус соединения
    loaderModal.classList.add('active');
    updateConnectionStatus('connecting', 'Загрузка...');

  } // <--- ЭТА СКОБКА ЗАКРЫВАЕТ ФУНКЦИЮ initWidget


  // --- Запуск виджета после определения всех функций ---

  // Проверяем готовность DOM и запускаем инициализацию и подключение
  // Это IIFE, код внутри выполняется сразу. Проверка document.readyState гарантирует,
  // что мы работаем с готовым DOM, прежде чем искать элементы и добавлять их.
  if (document.readyState === 'loading') {
    widgetLog("DOM not ready yet, waiting for DOMContentLoaded.");
    document.addEventListener('DOMContentLoaded', function() {
      widgetLog("DOMContentLoaded fired. Starting widget setup.");
      createStyles(); // Создаем стили
      loadFontAwesome(); // Загружаем Font Awesome
      createWidgetHTML(); // Создаем HTML виджета
      // Теперь, когда HTML создан и DOM готов, инициализируем логику виджета и WS
      initWidget(); // Находит элементы, добавляет слушателей
      connectWebSocket(); // Устанавливает WebSocket соединение
    });
  } else {
    // DOM уже готов
    widgetLog("DOM is already ready. Starting widget setup immediately.");
    createStyles(); // Создаем стили
    loadFontAwesome(); // Загружаем Font Awesome
    createWidgetHTML(); // Создаем HTML виджета
    // Инициализируем логику виджета и WS
    initWidget(); // Находит элементы, добавляет слушателей
    connectWebSocket(); // Устанавливает WebSocket соединение
  }

  // TODO: Добавить обработчики для ошибок микрофона, например, при потере разрешения
  // navigator.mediaDevices.addEventListener('statechange', ...); // Возможно, требуется более глубокая обработка

})();
