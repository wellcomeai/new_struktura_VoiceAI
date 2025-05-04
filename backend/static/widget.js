(function() {
  // Настройки виджета
  const DEBUG_MODE = false; // Отключаем режим отладки в продакшене
  const MAX_RECONNECT_ATTEMPTS = 5; // Максимальное количество попыток переподключения
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10; // Увеличенное количество попыток для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 20000; // Таймаут для установления соединения (в миллисекундах)
  const MAX_DEBUG_ITEMS = 10; // Максимальное количество записей отладки
  const MIN_AUDIO_LENGTH = 300; // Минимальная длительность сегмента для отправки (мс)

  // Глобальное хранение состояния виджета (внутри IIFE)
  let reconnectAttempts = 0;
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  let connectionTimeout = null; // <--- ИСПРАВЛЕНИЕ: Объявляем переменную connectionTimeout здесь

  // Флаги и переменные для мобильных устройств и аудио (перенесены из window для инкапсуляции)
  let audioContextInitialized = false;
  let tempAudioContext = null; // Храним временный или основной AudioContext
  let hasPlayedSilence = false; // Флаг для iOS, указывающий на попытку разблокировки аудио

  // Определяем тип устройства
  const isMobile = /iPhone|iPad|IEMobile|iPod|Android/i.test(navigator.userAgent); // Добавлено IEMobile
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info', payload = null) => {
    // Логика для Render (предполагается отправка куда-то, console.log в браузере не попадает напрямую на сервер Render)
    // Оставляем стандартный console.log/error/warn для браузера в DEBUG_MODE или для ошибок.

    const prefix = '[WellcomeAI Widget]';
    const timestamp = new Date().toISOString().slice(11, 23);

    // Проверяем, что type является строкой перед вызовом toUpperCase()
    const formattedType = typeof type === 'string' ? type.toUpperCase() : 'UNKNOWN_TYPE';
    const formattedMessage = `${timestamp} | ${formattedType} | ${message}`;


    if (type === 'error') {
      console.error(`${prefix} ERROR:`, formattedMessage, payload || '');
    } else if (type === 'warn') {
      console.warn(`${prefix} WARNING:`, formattedMessage, payload || '');
    } else if (DEBUG_MODE || type === 'info') { // Логируем info/debug в DEBUG_MODE
       // В production без DEBUG_MODE логируются только error и warn.
       // Включаем логирование info в production, если type - 'info' (было в старом коде).
       if (DEBUG_MODE || type === 'info') {
           console.log(`${prefix} ${formattedType}:`, formattedMessage, payload || '');
       }
    }
     // Логируем debug только в DEBUG_MODE
     if (type === 'debug' && DEBUG_MODE) {
        console.log(`${prefix} DEBUG:`, formattedMessage, payload || '');
     }


    // Добавляем в отладочную очередь только в DEBUG_MODE
    if (DEBUG_MODE) {
        addToDebugQueue(message, typeof type === 'string' ? type : 'unknown'); // Сохраняем исходный тип или помечаем как unknown
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
     // updateDebugPanel(); // Эта функция отключена в production, но может быть здесь вызвана в DEBUG_MODE
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
    // Здесь могла бы быть логика обновления DOM элемента с логами
  };

  // Получаем элемент скрипта виджета (предполагая, что он содержит "widget.js" в src)
  const widgetScript = document.querySelector('script[src*="widget.js"]');

  // Функция для определения URL сервера
  const getServerUrl = () => {
    // 1. Проверяем атрибут data-server на скрипте виджета
    if (widgetScript) {
       if (widgetScript.hasAttribute('data-server')) {
         const url = widgetScript.getAttribute('data-server');
         widgetLog(`Found server URL from data-server attribute: ${url}`, 'info');
         return formatServerUrl(url);
       }
        if (widgetScript.dataset && widgetScript.dataset.server) {
           const url = widgetScript.dataset.server;
           widgetLog(`Found server URL from dataset.server: ${url}`, 'info');
           return formatServerUrl(url);
        }

       // 2. Извлекаем из src скрипта виджета
       const src = widgetScript.getAttribute('src');
       if (src) {
         try {
           const url = new URL(src, window.location.href);
           const serverUrl = url.origin;
           widgetLog(`Extracted server URL from script src: ${serverUrl}`, 'info');
           return formatServerUrl(serverUrl);
         } catch (e) {
           widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');
           // Если src относительный, используем текущий origin
           if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) {
              const serverUrl = window.location.origin;
              widgetLog(`Using current origin for relative path: ${serverUrl}`, 'info');
              return formatServerUrl(serverUrl);
           }
         }
       }
    }


    // 3. Fallback URL
    const fallbackUrl = 'https://realtime-saas.onrender.com';
    widgetLog(`Using fallback server URL: ${fallbackUrl}`, 'info');
    return formatServerUrl(fallbackUrl);

    function formatServerUrl(url) {
       // Убираем конечный слеш, если есть, и добавляем протокол, если отсутствует
       if (url && !url.match(/^https?:\/\//)) {
           url = window.location.protocol + '//' + url;
           widgetLog(`Added protocol to server URL: ${url}`, 'info');
       }
       return url ? url.replace(/\/$/, '') : null;
    }
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    // 1. Проверяем атрибут data-assistantId в скрипте виджета
    if (widgetScript) {
       // Проверяем оба варианта написания - с большой и маленькой буквой I
       if (widgetScript.hasAttribute('data-assistantId') || widgetScript.hasAttribute('data-assistantid')) {
         const id = widgetScript.getAttribute('data-assistantId') || widgetScript.getAttribute('data-assistantid');
         widgetLog(`Found assistant ID from attribute: ${id}`, 'info');
         return id;
       }
        if (widgetScript.dataset && (widgetScript.dataset.assistantId || widgetScript.dataset.assistantid)) {
           const id = widgetScript.dataset.assistantId || widgetScript.dataset.assistantid;
           widgetLog(`Found assistant ID from dataset: ${id}`, 'info');
           return id;
        }
    }


    // 2. Пробуем получить ID из URL-параметра
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) {
      widgetLog(`Found assistant ID in URL param: ${idFromUrl}`, 'info');
      return idFromUrl;
    }

    // 3. Проверяем наличие глобальной переменной (менее предпочтительный способ)
    // Проверяем наличие переменной только если она объявлена в window
     if (typeof window.wellcomeAIAssistantId !== 'undefined' && window.wellcomeAIAssistantId !== null) {
        widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`, 'info');
        return window.wellcomeAIAssistantId;
     }


    // 4. Демо-ID для локальной или демо-страницы
    if (window.location.hostname.includes('localhost') || window.location.hostname.includes('127.0.0.1') || window.location.hostname.includes('demo')) {
       widgetLog(`Using demo ID for development/demo environment`, 'info');
       return 'demo'; // Или другой известный демо-ID
    }


    widgetLog('No assistant ID found! Please add data-assistantId to your script tag.', 'error');
    //alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.'); // Можно добавить алерт для критической ошибки
    return null; // Возвращаем null, если ID не найден
  };

  // Получение позиции виджета
  const getWidgetPosition = () => {
    // Позиции по умолчанию
    const defaultPosition = {
      horizontal: 'right',
      vertical: 'bottom',
      distance: '20px'
    };

    // Ищем атрибут data-position на скрипте виджета
     if (widgetScript) {
        if (widgetScript.hasAttribute('data-position')) {
          return parsePosition(widgetScript.getAttribute('data-position'));
        }
         if (widgetScript.dataset && widgetScript.dataset.position) {
           return parsePosition(widgetScript.dataset.position);
         }
     }


    // Возвращаем позицию по умолчанию
    return defaultPosition;

    // Вспомогательная функция для парсинга позиции
    function parsePosition(positionString) {
      const position = { ...defaultPosition };

      if (!positionString) return position;

      // Пример: "bottom-right" или "top-left-30px"
      const parts = positionString.toLowerCase().split('-');

      if (parts.length >= 2) {
          const [p1, p2, ...rest] = parts; // Используем деструктуризацию

          if ((p1 === 'top' || p1 === 'bottom') && (p2 === 'left' || p2 === 'right')) {
              position.vertical = p1;
              position.horizontal = p2;
          } else if ((p2 === 'top' || p2 === 'bottom') && (p1 === 'left' || p1 === 'right')) {
               // Возможно, порядок указан наоборот "right-bottom"
               position.vertical = p2;
               position.horizontal = p1;
          }

          // Проверяем, есть ли расстояние
          if (rest.length > 0) {
              const distancePart = rest.join('-'); // Собираем оставшиеся части (например "30px")
              if (distancePart.endsWith('px') || distancePart.endsWith('%') || distancePart === '0') {
                  position.distance = distancePart;
              } else {
                  widgetLog(`Invalid distance format in data-position: "${distancePart}". Using default distance.`, 'warn');
              }
          }

      } else {
         widgetLog(`Invalid data-position format: "${positionString}". Using default position.`, 'warn');
      }

      widgetLog(`Parsed widget position: ${JSON.stringify(position)} from "${positionString}"`, 'info');
      return position;
    }
  };


  // Определяем URL сервера и ID ассистента
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();

  // Формируем WebSocket URL с указанием ID ассистента только если SERVER_URL и ASSISTANT_ID доступны
  const WS_URL = (SERVER_URL && ASSISTANT_ID) ? SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID : null;

  widgetLog(`Configuration: Server URL: ${SERVER_URL ? SERVER_URL : 'NOT SET'}, Assistant ID: ${ASSISTANT_ID ? ASSISTANT_ID : 'NOT SET'}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}-${WIDGET_POSITION.distance}`, 'info');
  widgetLog(`WebSocket URL: ${WS_URL ? WS_URL : 'NOT SET'}`, 'info');
  widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`, 'info');

  // Проверяем, можно ли вообще продолжить (если ID ассистента не найден, нет смысла грузить стили/html)
  if (!ASSISTANT_ID || !WS_URL) {
       widgetLog("Assistant ID or WebSocket URL is missing. Widget will not function.", 'error');
       // alert('WellcomeAI Widget Error: Configuration missing.'); // Дополнительный алерт, если критично
       // Ранний выход из IIFE
       return;
  }


  // Создаем стили для виджета
  function createStyles() {
    // Проверяем, не были ли стили уже добавлены
    if (document.getElementById('wellcomeai-widget-styles')) {
        widgetLog("Widget styles already exist, skipping creation.", 'info');
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
        /* Ensure it's block or flex/grid for proper positioning */
        display: block;
      }

      .wellcomeai-widget-button {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #4a86e8, #2b59c3); /* Синий градиент */
        box-shadow: 0 4px 15px rgba(74, 134, 232, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
        z-index: 2147483647; /* Выше контейнера */
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
        z-index: 2; /* Выше псевдоэлемента */
        transition: all 0.3s ease;
      }

      .wellcomeai-widget-expanded {
        position: absolute;
        /* Располагаем относительно родительского контейнера */
        ${WIDGET_POSITION.vertical}: 0;
        ${WIDGET_POSITION.horizontal}: 0;
        width: 320px; /* Фиксированная ширина */
        height: 0; /* Изначально скрыт */
        opacity: 0;
        pointer-events: none;
        background: white;
        border-radius: 20px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
        overflow: hidden; /* Скрывает контент, когда высота 0 */
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        display: flex;
        flex-direction: column;
        z-index: 2147483647; /* Выше кнопки и контейнера */
      }

      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 400px; /* Высота в активном состоянии */
        opacity: 1;
        pointer-events: all;
      }

      .wellcomeai-widget-container.active .wellcomeai-widget-button {
        /* Скрываем кнопку или уменьшаем/смещаем ее при открытии */
        /* В текущем CSS кнопка остается на месте под развернутым окном */
        /* Если нужно скрыть, можно добавить display: none; или visibility: hidden; */
         transform: scale(0.9); /* Визуально уменьшаем */
         box-shadow: 0 2px 10px rgba(74, 134, 232, 0.3);
      }

      .wellcomeai-widget-header {
        flex-shrink: 0; /* Запрещает сжиматься */
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
        padding: 0; /* Убираем внутренние отступы кнопки */
      }

      .wellcomeai-widget-close:hover {
        opacity: 1;
        transform: scale(1.1);
      }

      .wellcomeai-widget-content {
        flex-grow: 1; /* Занимает все доступное пространство */
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center; /* Выравнивание по центру по вертикали */
        background: #f9fafc;
        position: relative;
        padding: 20px;
        overflow-y: auto; /* Если контент превысит размер, появится скролл */
      }

      .wellcomeai-main-circle {
        width: 180px;
        height: 180px;
        border-radius: 50%;
        background: linear-gradient(135deg, #ffffff, #e1f5fe, #4a86e8); /* Градиент по умолчанию */
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
        position: relative;
        overflow: hidden;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0; /* Запрещает сжиматься */
        cursor: pointer; /* Указывает, что кликабельный */
      }

      .wellcomeai-main-circle::before {
        content: '';
        position: absolute;
        width: 140%;
        height: 140%;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.3), rgba(74, 134, 232, 0.2)); /* Волна/Блик */
        animation: wellcomeai-wave 8s linear infinite;
        border-radius: 40%;
        top: -20%; left: -20%; /* Центрируем или позиционируем */
      }

      @keyframes wellcomeai-wave {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .wellcomeai-main-circle.listening {
        background: linear-gradient(135deg, #ffffff, #e3f2fd, #2196f3); /* Синий для прослушивания */
        box-shadow: 0 0 30px rgba(33, 150, 243, 0.6);
      }

      .wellcomeai-main-circle.listening::before {
        animation: wellcomeai-wave 4s linear infinite; /* Быстрее анимация волны */
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(33, 150, 243, 0.3));
      }

      .wellcomeai-main-circle.listening::after {
        content: '';
        position: absolute;
        width: calc(100% - 6px); /* С учетом border */
        height: calc(100% - 6px); /* С учетом border */
        top: 3px; left: 3px; /* Позиционирование с учетом border */
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
        background: linear-gradient(135deg, #ffffff, #e8f5e9, #4caf50); /* Зеленый для разговора */
        box-shadow: 0 0 30px rgba(76, 175, 80, 0.6);
      }

      .wellcomeai-main-circle.speaking::before {
        animation: wellcomeai-wave 3s linear infinite; /* Еще быстрее анимация волны */
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(76, 175, 80, 0.3));
      }

      .wellcomeai-main-circle.speaking::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle, transparent 50%, rgba(76, 175, 80, 0.1) 100%); /* Пульсация/Рябь */
        border-radius: 50%;
        animation: wellcomeai-ripple 2s ease-out infinite;
        top: 0; left: 0; /* Позиционирование */
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
        color: #4a86e8; /* Цвет по умолчанию */
        font-size: 32px;
        z-index: 10; /* Выше псевдоэлементов */
      }

      .wellcomeai-main-circle.listening .wellcomeai-mic-icon {
        color: #2196f3; /* Синий */
      }

      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon {
        color: #4caf50; /* Зеленый */
      }

      .wellcomeai-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px; /* Высота контейнера визуализации */
        bottom: 10px; /* Позиция снизу круга */
        left: 50%;
        transform: translateX(-50%);
        opacity: 0; /* Скрыт по умолчанию */
        visibility: hidden;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }
       /* Визуализация активна только при прослушивании или говорении */
      .wellcomeai-main-circle.listening + .wellcomeai-audio-visualization,
      .wellcomeai-main-circle.speaking + .wellcomeai-audio-visualization {
        opacity: 0.8;
        visibility: visible;
      }


      .wellcomeai-audio-bars {
        display: flex;
        align-items: flex-end; /* Бары растут снизу вверх */
        height: 100%;
        gap: 3px; /* Расстояние между барами */
        width: 100%;
        justify-content: center;
      }

      .wellcomeai-audio-bar {
        flex-grow: 0; /* Не растягивается */
        flex-shrink: 0; /* Не сжимается */
        width: 4px; /* Ширина одного бара */
        height: 2px; /* Минимальная высота */
        background-color: #4a86e8; /* Цвет баров */
        border-radius: 2px; /* Скругленные углы */
        transition: height 0.1s ease; /* Плавное изменение высоты */
      }

       /* Цвет баров меняется в зависимости от состояния круга */
      .wellcomeai-main-circle.listening + .wellcomeai-audio-visualization .wellcomeai-audio-bar {
         background-color: #2196f3; /* Синий */
      }
      .wellcomeai-main-circle.speaking + .wellcomeai-audio-visualization .wellcomeai-audio-bar {
         background-color: #4caf50; /* Зеленый */
      }


      .wellcomeai-loader-modal {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.7);
        backdrop-filter: blur(3px); /* Эффект размытия */
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
        width: calc(100% - 40px); /* Ширина с учетом паддинга контента */
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
        visibility: hidden; /* Скрываем полностью */
        transition: opacity 0.3s, visibility 0.3s;
        max-height: 100px;
        overflow-y: auto;
        z-index: 10;
        pointer-events: none; /* Не блокирует клики под собой */
      }

      .wellcomeai-message-display.show {
        opacity: 1;
        visibility: visible;
         pointer-events: auto; /* Активируем клики, если нужно (например, для выделения текста) */
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
        background-color: rgba(254, 226, 226, 0.9); /* Менее прозрачный фон */
        border: 1px solid #ef4444;
        padding: 10px 15px; /* Увеличил паддинг */
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        margin-top: 15px; /* Увеличил отступ */
        text-align: center;
        display: none; /* Скрыт по умолчанию */
        position: relative; /* Для z-index */
        z-index: 15; /* Выше сообщения */
        width: calc(100% - 40px);
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
        margin-top: 10px; /* Увеличил отступ */
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
        visibility: hidden; /* Скрываем полностью */
        transition: opacity 0.3s, visibility 0.3s;
        z-index: 10; /* Выше круга */
      }

      .wellcomeai-status-indicator.show {
        opacity: 0.8;
        visibility: visible;
      }

      .wellcomeai-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #10b981; /* Зеленый */
      }

      .wellcomeai-status-dot.disconnected {
        background-color: #ef4444; /* Красный */
      }

      .wellcomeai-status-dot.connecting {
        background-color: #f59e0b; /* Желтый/Оранжевый */
      }

      /* Кнопка принудительной активации аудио для iOS */
      .wellcomeai-ios-audio-button {
        position: absolute;
        bottom: 60px; /* Позиционируем выше стандартного сообщения */
        left: 50%;
        transform: translateX(-50%);
        background-color: #4a86e8;
        color: white;
        border: none;
        border-radius: 15px;
        padding: 8px 15px; /* Увеличил паддинг */
        font-size: 13px; /* Увеличил шрифт */
        font-weight: 500;
        cursor: pointer;
        display: none;
        z-index: 100; /* Высокий z-index */
        text-align: center;
        white-space: nowrap; /* Запрет переноса текста */
      }

      .wellcomeai-ios-audio-button.visible {
        display: block;
      }
    `;
    document.head.appendChild(styleEl);
    widgetLog("Styles created and added to head", 'info');
  }

  // Загрузка Font Awesome для иконок
  function loadFontAwesome() {
    if (!document.getElementById('font-awesome-css')) {
      const link = document.createElement('link');
      link.id = 'font-awesome-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
      link.onload = () => widgetLog("Font Awesome loaded", 'info');
      link.onerror = () => widgetLog("Failed to load Font Awesome CSS", "error");
      document.head.appendChild(link);
      widgetLog("Attempting to load Font Awesome", 'info');
    } else {
       widgetLog("Font Awesome already present", 'info');
    }
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
     // Проверяем, не была ли структура уже добавлена
     if (document.getElementById('wellcomeai-widget-container')) {
         widgetLog("Widget HTML structure already exists, skipping creation.", 'info');
         return;
     }

    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647"; // Установлен в CSS, но можно продублировать

    let widgetHTML = `
      <!-- Кнопка (минимизированное состояние) -->
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button" role="button" aria-label="Открыть голосовой ассистент">
        <i class="fas fa-robot wellcomeai-widget-icon"></i>
      </div>

      <!-- Развернутый виджет -->
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">WellcomeAI</div>
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close" aria-label="Закрыть виджет">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <!-- Основной элемент - круг с иконкой микрофона -->
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle" role="button" aria-label="Включить/выключить голосовой ввод">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>

            <!-- Аудио визуализация -->
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>

          <!-- Сообщение -->
          <div class="wellcomeai-message-display" id="wellcomeai-message-display" aria-live="polite"></div>

          <!-- Сообщение об ошибке соединения -->
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error" role="alert">
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
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active" role="dialog" aria-label="Загрузка">
        <div class="wellcomeai-loader"></div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);
    widgetLog("HTML structure created and appended to body", 'info');
  }

  // Функция для разблокировки аудио на iOS (через AudioContext resume и краткое воспроизведение)
  async function unlockAudioContextOnIOS() {
      if (!isIOS) return true;

      if (tempAudioContext && tempAudioContext.state === 'running' && audioContextInitialized) {
          widgetLog('AudioContext уже активен на iOS.', 'debug');
          return true;
      }

      widgetLog('Попытка активации AudioContext на iOS...', 'info');

      try {
          // Создаем контекст если его еще нет, или используем существующий
          if (!tempAudioContext || tempAudioContext.state === 'closed') {
               tempAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                 sampleRate: 16000 // Использовать 16k для уменьшения нагрузки и совместимости
               });
               widgetLog(`Создан новый AudioContext на iOS с частотой ${tempAudioContext.sampleRate}`, 'debug');
          }

          const ctx = tempAudioContext;

          // Возобновляем контекст принудительно
          if (ctx.state === 'suspended') {
              widgetLog('Возобновление AudioContext...', 'debug');
              await ctx.resume();
              audioContextInitialized = true;
              widgetLog('AudioContext успешно возобновлен на iOS.', 'info');
          } else if (ctx.state === 'running') {
               audioContextInitialized = true;
               widgetLog('AudioContext уже в состоянии running на iOS.', 'debug');
          } else {
               widgetLog(`AudioContext в неожиданном состоянии: ${ctx.state}`, 'warn');
               // Попробуем все равно считать его инициализированным, но это может быть проблемно
               audioContextInitialized = true;
          }

          // Воспроизводим короткую тишину после успешного resume, если еще не играли
          if (audioContextInitialized && ctx.state === 'running' && !hasPlayedSilence) {
               try {
                    const silentBuffer = ctx.createBuffer(1, 1, 44100); // Стандартная частота для буфера
                    const source = ctx.createBufferSource();
                    source.buffer = silentBuffer;
                    source.connect(ctx.destination);
                    source.start(0);
                    source.stop(ctx.currentTime + 0.001); // Очень короткое воспроизведение
                     source.onended = () => { try { source.disconnect(); } catch(e){}}; // Очистка ресурса

                    hasPlayedSilence = true;
                    widgetLog("Played silence to help unlock audio on iOS", 'debug');
               } catch(e) {
                    widgetLog(`Error playing silence on iOS: ${e.message}`, 'warn');
               }
          }


          return audioContextInitialized; // Возвращаем статус инициализации

      } catch (err) {
          widgetLog(`Ошибка активации AudioContext на iOS: ${err.message}`, 'error');
          audioContextInitialized = false; // Сбросить флаг при ошибке
          tempAudioContext = null; // Сбросить ссылку
          return false;
      }
  }


  // Основная логика виджета
  function initWidget() {
    // Проверяем, что ID ассистента и WS_URL существуют (проверка была выше, но повторим на всякий случай)
    if (!ASSISTANT_ID || !WS_URL) {
        widgetLog("Widget initialization stopped: Assistant ID or WS URL missing.", 'error');
        //alert('WellcomeAI Widget Error: Configuration missing.');
        return; // Выход, если конфигурация неполная
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
    // const retryButton = document.getElementById('wellcomeai-retry-button'); // Кнопка создается динамически
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    const iosAudioButton = document.getElementById('wellcomeai-ios-audio-button');

    // Проверка наличия критически важных элементов
    if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !connectionError || !statusIndicator || !statusDot || !statusText || (isIOS && !iosAudioButton)) {
      widgetLog("Some critical UI elements were not found! Widget cannot start.", 'error');
      // Добавляем fallback на alert, если элементы не найдены, чтобы пользователь увидел ошибку
      alert("WellcomeAI Widget Error: UI elements missing. Please check console for details.");
      return;
    }

    // Переменные для обработки аудио
    let audioChunksBuffer = []; // Буфер для входящих аудиофрагментов от сервера
    let audioPlaybackQueue = []; // Очередь аудио для воспроизведения
    let isPlayingAudio = false; // Флаг: идет ли воспроизведение аудио
    let hasAudioData = false; // Флаг: был ли обнаружен звук в текущем сегменте записи
    let audioDataStartTime = 0; // Время начала записи текущего сегмента
    //let minimumAudioLength = 300; // Перенесено в константу MIN_AUDIO_LENGTH
    let isListening = false; // Флаг: активен ли захват микрофона и отправка данных

    // WebSocket и Audio API переменные, вынесенные на уровень initWidget
    let websocket = null;
    let audioContext = null; // Локальная ссылка на AudioContext для удобства
    let mediaStream = null; // Поток с микрофона
    let audioProcessor = null; // Узел для обработки аудио
    let streamSource = null; // Источник аудио из mediaStream
    let iosGainNode = null; // Отдельный GainNode для iOS, чтобы отключить вывод (для ScriptProcessorNode)


    let isConnected = false; // Флаг: активно ли WebSocket соединение
    let isWidgetOpen = false; // Флаг: открыт ли виджет
    let connectionFailedPermanently = false; // Флаг: достигнуто ли максимальное количество попыток переподключения
    // let pingInterval = null; // Удалена, т.к. уже есть pingIntervalId
    let lastPingTime = Date.now(); // Возможно, не нужна, достаточно lastPongTime
    // let lastPongTime = Date.now(); // Уже объявлена выше

    // Конфигурация для оптимизации потока аудио - разные настройки для десктопа и мобильных
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,      // Порог для определения тишины (амплитуда)
      silenceDuration: 300,        // Длительность тишины для отправки (мс)
      bufferCheckInterval: 50,     // Частота проверки буфера (мс) - Не используется в онаудиопроцесс
      soundDetectionThreshold: 0.02, // Чувствительность к звуку
      audioBarsCount: 25 // Количество баров визуализации
    };

    // Специальные настройки для мобильных устройств
    const MOBILE_AUDIO_CONFIG = {
      silenceThreshold: 0.015,      // Более низкий порог для мобильных
      silenceDuration: 500,         // Увеличенная длительность тишины
      bufferCheckInterval: 100,     // Увеличенный интервал проверки - Не используется
      soundDetectionThreshold: 0.015, // Более чувствительное определение звука
       audioBarsCount: 20 // Меньше баров для мобильных
    };

    // Выбираем нужную конфигурацию в зависимости от устройства
    const effectiveAudioConfig = isMobile ? MOBILE_AUDIO_CONFIG : AUDIO_CONFIG;
    // ИСПРАВЛЕНИЕ: Передаем 'info' как тип лога, а effectiveAudioConfig как payload
    widgetLog(`Effective Audio Config: ${isMobile ? 'Mobile' : 'Desktop'}`, 'info', effectiveAudioConfig);


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
      // Скрываем, если статус "Подключено" и виджет закрыт
      if (isWidgetOpen || status !== 'connected') {
         statusIndicator.classList.add('show');
         // Скрываем через некоторое время, только если статус "Подключено" и виджет открыт
         if (status === 'connected' && isWidgetOpen) {
            // Очищаем предыдущий таймер, если был
             if (statusIndicator.hideTimer) clearTimeout(statusIndicator.hideTimer);
            statusIndicator.hideTimer = setTimeout(() => {
              statusIndicator.classList.remove('show');
              statusIndicator.hideTimer = null;
            }, 3000);
         }
      } else {
         statusIndicator.classList.remove('show');
          // Очищаем таймер скрытия, если был
         if (statusIndicator.hideTimer) clearTimeout(statusIndicator.hideTimer);
         statusIndicator.hideTimer = null;
      }
    }

    // Создаем аудио-бары для визуализации
    function createAudioBars(count = effectiveAudioConfig.audioBarsCount) {
      if (!audioBars) return;
      audioBars.innerHTML = '';
      // Убеждаемся, что количество баров четное для симметрии (опционально, убрано для простоты)
      // count = count % 2 === 0 ? count : count + 1;
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        audioBars.appendChild(bar);
      }
       widgetLog(`Created ${count} audio visualization bars.`, 'info');
    }
    createAudioBars(); // Создаем бары при инициализации

    // Функция для полной остановки всех аудио процессов (микрофон и воспроизведение)
    function stopAllAudioProcessing() {
      widgetLog("Stopping all audio processing", 'info');

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

      // Сбрасываем флаги аудио данных
      hasAudioData = false;
      audioDataStartTime = 0;
      isSilent = true; // Сбрасываем состояние тишины
      silenceStartTime = Date.now(); // Обновляем время начала тишины
      hasSentAudioInCurrentSegment = false; // Сбрасываем флаг отправки


      // Останавливаем микрофонный поток
      if (mediaStream) {
        widgetLog("Stopping media stream tracks", 'debug');
        mediaStream.getTracks().forEach(track => {
            try { track.stop(); } catch(e) { widgetLog(`Error stopping media stream track: ${e.message}`, 'warn');}
        });
        mediaStream = null;
      }

       // Отключаем узлы AudioContext И сбрасываем ссылки
       if (streamSource) { try { streamSource.disconnect(); } catch(e) {} streamSource = null; }
       if (audioProcessor) { try { audioProcessor.onaudioprocess = null; audioProcessor.disconnect(); } catch(e) {} audioProcessor = null; }
       if (iosGainNode) { try { iosGainNode.disconnect(); } catch(e) {} iosGainNode = null; }

       // Приостанавливаем AudioContext, если он существует, running, нет очереди и не на iOS
       if (tempAudioContext && tempAudioContext.state === 'running' && audioPlaybackQueue.length === 0 && !isIOS) {
            tempAudioContext.suspend().then(() => {
               widgetLog('AudioContext приостановлен (не iOS, нет очереди).', 'debug');
            }).catch(e => widgetLog(`Ошибка при приостановке AudioContext: ${e.message}`, 'error'));
       } else if (tempAudioContext && tempAudioContext.state === 'running' && isIOS) {
           widgetLog('AudioContext оставлен в состоянии running на iOS.', 'debug');
       } else if (tempAudioContext && tempAudioContext.state === 'suspended') {
            widgetLog('AudioContext уже приостановлен.', 'debug');
       } else if (!tempAudioContext) {
            widgetLog('AudioContext не инициализирован.', 'debug');
       }


      // Сбрасываем визуализацию
      resetAudioVisualization();

      // Если есть активное соединение WebSocket, отправляем команду остановки
      // Отправляем clear и cancel принудительно при полной остановке аудио
      if (websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
        widgetLog("Sending clear and cancel commands to server (stopAllAudioProcessing)", 'debug');
        try {
            websocket.send(JSON.stringify({
              type: "input_audio_buffer.clear",
              event_id: `clear_stop_all_${Date.now()}`
            }));
             websocket.send(JSON.stringify({
               type: "response.cancel",
               event_id: `cancel_stop_all_${Date.now()}`
             }));
        } catch(e) {
            widgetLog(`Error sending clear/cancel on stopAllAudioProcessing: ${e.message}`, 'warn');
        }
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
         messageDisplay.hideTimer = null; // Убедимся, что таймера нет
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

        // Удаляем старый слушатель и добавляем новый на новую кнопку
        const oldRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
        if (oldRetryButton) {
           // Клонирование элемента - надежный способ удалить все слушатели
           const newRetryButton = oldRetryButton.cloneNode(true);
           connectionError.replaceChild(newRetryButton, oldRetryButton);
           newRetryButton.addEventListener('click', resetConnection);
           widgetLog('Added retry button click listener via cloneNode', 'debug');
        } else {
             // Если кнопки почему-то не оказалось после innerHTML, добавляем слушатель к текущей
             const currentRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
             if(currentRetryButton) {
                 currentRetryButton.addEventListener('click', resetConnection);
                 widgetLog('Added retry button click listener directly', 'debug');
             } else {
                  widgetLog('Retry button element not found after showConnectionError render', 'error');
             }
        }
      }
    }

    // Скрыть ошибку соединения
    function hideConnectionError() {
      if (connectionError) {
        connectionError.classList.remove('visible');
         // Удаляем слушатель с кнопки повтора, чтобы избежать дублирования при следующем show
        const retryBtn = connectionError.querySelector('#wellcomeai-retry-button');
        if (retryBtn) {
            // Удаляем слушатель, если он был добавлен
            retryBtn.removeEventListener('click', resetConnection);
            widgetLog('Removed retry button click listener', 'debug');
        }
      }
    }

    // Сброс состояния соединения
    function resetConnection() {
      widgetLog('Resetting connection state and attempting reconnect (Manual Retry)', 'info');
      // Сбрасываем счетчик попыток и флаги
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      isReconnecting = true; // Устанавливаем флаг

      // Скрываем сообщение об ошибке
      hideConnectionError();

      // Сбрасываем состояние аудио
      stopAllAudioProcessing();

      // Показываем сообщение о повторном подключении
      showMessage("Попытка подключения...", 0);
      updateConnectionStatus('connecting', 'Подключение...');

      // Пытаемся подключиться заново немедленно
      connectWebSocket();
    }

    // Открыть виджет
    async function openWidget() {
      if (isWidgetOpen) {
          widgetLog("Widget already open", 'debug');
          return;
      }
      widgetLog("Opening widget", 'info');

      // Принудительно устанавливаем z-index для решения конфликтов
      widgetContainer.style.zIndex = "2147483647"; // CSS уже устанавливает, но дублирование может помочь
      widgetButton.style.zIndex = "2147483647"; // CSS уже устанавливает

      widgetContainer.classList.add('active');
      isWidgetOpen = true;

      // Убираем пульсацию с кнопки, если она есть
      if (widgetButton) {
         widgetButton.classList.remove('wellcomeai-pulse-animation');
      }

      // Показываем модальное окно загрузки при открытии, только если нет соединения
      if (!isConnected && !isReconnecting && loaderModal) {
         loaderModal.classList.add('active');
      } else if (loaderModal) {
          loaderModal.classList.remove('active'); // Убираем загрузку, если уже подключены
      }


      // Проверяем состояние соединения и пытаемся подключиться/начать слушать
      if (connectionFailedPermanently) {
        widgetLog("Widget opened, connection failed permanently.", 'info');
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        updateConnectionStatus('disconnected', 'Отключено');
        // if (loaderModal) loaderModal.classList.remove('active'); // Already handled above
        return;
      }

      // Если соединение не активно и не находимся в процессе переподключения,
      // пытаемся подключиться снова
      if (!isConnected && !isReconnecting) {
        widgetLog("Widget opened, but not connected. Attempting connection.", 'info');
        // connectWebSocket сам покажет загрузку и статус
        connectWebSocket();
        // Остальная логика (старт прослушивания) начнется в onopen после успешного подключения
        return;
      }

      // Если соединение активно, пытаемся инициализировать аудио и начать слушать
      if (isConnected && !isReconnecting) {
         widgetLog("Widget opened, connection active. Attempting to start listening.", 'info');
         // connectWebSocket уже скрыл загрузку и установил статус connected
         updateConnectionStatus('connected', 'Подключено');
         // if (loaderModal) loaderModal.classList.remove('active'); // Already handled above

         // Специальная обработка для iOS: показать кнопку активации аудио, если еще не активировано
         if (isIOS) {
             const audioReady = await unlockAudioContextOnIOS();
             if (!audioReady) {
                if (iosAudioButton) iosAudioButton.classList.add('visible');
                showMessage("Нажмите кнопку ниже для активации голосового помощника", 0);
             } else {
                // Если аудио уже активировано, пытаемся начать слушать сразу
                startListening();
             }
         } else {
             // Для других мобильных и десктопа
             startListening(); // startListening сам вызовет initAudio если нужно
         }

      } else if (isReconnecting) {
          widgetLog("Widget opened, currently reconnecting.", 'info');
          // connectWebSocket уже показал загрузку и статус connecting
          updateConnectionStatus('connecting', 'Переподключение...');
           if (loaderModal) loaderModal.classList.add('active'); // Показываем загрузку пока переподключаемся
          // Прослушивание начнется автоматически после успешного переподключения в onopen
      } else {
           // Неизвестное состояние, возможно, ошибка?
           widgetLog(`Widget opened in unexpected state: isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'warn');
           if (loaderModal) loaderModal.classList.remove('active'); // Скрываем загрузку на всякий случай
           // Возможно, здесь стоит показать сообщение об ошибке или статус
           updateConnectionStatus(isConnected ? 'connected' : 'disconnected', isReconnecting ? 'Переподключение...' : (isConnected ? 'Подключено' : 'Ошибка'));
      }
    }

    // Закрыть виджет
    function closeWidget() {
      widgetLog("Closing widget", 'info');

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
        // statusIndicator.classList.remove('show'); // Делаем это в updateConnectionStatus
         updateConnectionStatus(isConnected ? 'connected' : 'disconnected', isConnected ? 'Подключено' : 'Отключено'); // Обновляем статус, который скроется
      }

      // Скрываем кнопку активации iOS
      if (iosAudioButton) {
        iosAudioButton.classList.remove('visible');
      }

      // Скрываем модальное окно загрузки, если оно активно
      if (loaderModal) {
         loaderModal.classList.remove('active');
      }

      // Добавляем пульсацию на кнопку, если не было ошибки соединения
      if (!connectionFailedPermanently && widgetButton) {
         widgetButton.classList.add('wellcomeai-pulse-animation');
      } else if (widgetButton) {
           // Убираем пульсацию, если была постоянная ошибка, чтобы не вводить в заблуждение
           widgetButton.classList.remove('wellcomeai-pulse-animation');
      }
    }

    // Инициализация микрофона и AudioContext
    async function initAudio() {
      widgetLog("Attempting to initialize audio (Microphone & AudioContext)", 'info');

      // Убеждаемся, что AudioContext существует и активен/возобновляем его
      // Для iOS это делается через unlockAudioContextOnIOS
      // Для других устройств создаем/используем AudioContext напрямую
       if (!isIOS) {
            try {
               // Создаем контекст если его еще нет или закрыт
                if (!tempAudioContext || tempAudioContext.state === 'closed') {
                   const contextOptions = isMobile ? {} : { sampleRate: 24000 };
                   tempAudioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
                   widgetLog(`Создан новый AudioContext (${isMobile ? 'Mobile' : 'Desktop'}) с частотой ${tempAudioContext.sampleRate} Гц.`, 'debug');
                }

                // Возобновляем контекст, если он приостановлен (может случиться на Android)
                if (tempAudioContext.state === 'suspended') {
                   widgetLog('Возобновление AudioContext...', 'debug');
                   await tempAudioContext.resume();
                   widgetLog('AudioContext успешно возобновлен.', 'debug');
                }
                audioContextInitialized = true; // Контекст готов или активен

            } catch (e) {
               widgetLog(`Ошибка создания/возобновления AudioContext (Non-iOS): ${e.message}`, 'error');
               tempAudioContext = null;
               audioContextInitialized = false;
               showMessage("Ошибка инициализации аудио. Проверьте настройки браузера.", 5000);
               return false;
            }
       } else {
            // Для iOS AudioContext инициализируется и возобновляется в unlockAudioContextOnIOS
            const audioReady = await unlockAudioContextOnIOS();
            if (!audioReady || !tempAudioContext) {
                 widgetLog('AudioContext не готов после unlockAudioContextOnIOS.', 'error');
                 // Сообщение об ошибке и кнопка iOS уже показаны в unlockAudioContextOnIOS
                 return false;
            }
       }

      // Присваиваем локальной переменной для удобства
      audioContext = tempAudioContext;

      // Теперь запрашиваем медиапоток, если его нет или он неактивен
      if (!mediaStream || !mediaStream.active) {
          // Останавливаем старый неактивный поток на всякий случай
          if (mediaStream) {
               widgetLog("Stopping inactive media stream tracks.", 'debug');
               mediaStream.getTracks().forEach(track => { try { track.stop(); } catch(e) {}} );
               mediaStream = null;
          }
          try {
              widgetLog("Запрос разрешения на доступ к микрофону...", 'info');

              // Проверяем поддержку getUserMedia
              if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Ваш браузер не поддерживает доступ к микрофону");
              }

              // Настройки микрофона
              const audioConstraints = isIOS ?
                { // iOS: отключаем эхо, включаем шумодав/АРУ.
                  echoCancellation: false, // Важно для iOS, чтобы избежать обратной связи через динамик
                  noiseSuppression: true,
                  autoGainControl: true
                } :
                isMobile ?
                { // Android: включаем эхо, шумодав, АРУ.
                  echoCancellation: true, // Может помочь на Android
                  noiseSuppression: true,
                  autoGainControl: true,
                   // sampleRate здесь не указываем, используем AudioContext.sampleRate
                } :
                { // Desktop
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                   // sampleRate здесь не указываем
                };

              // Запрашиваем доступ к микрофону с оптимальными настройками
              mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
              widgetLog(`Доступ к микрофону получен (${isIOS ? 'iOS' : (isMobile ? 'Android' : 'Desktop')} настройки)`, 'info');

          } catch (micError) {
              widgetLog(`Ошибка доступа к микрофону: ${micError.name || 'Unknown Error'}: ${micError.message}`, 'error');
              mediaStream = null; // Сбрасываем ссылку
              showMessage("Ошибка доступа к микрофону. Проверьте настройки браузера.", 5000); // Показываем ошибку

              // Особая обработка для iOS: показать кнопку активации, если не удалось получить поток
              if (isIOS && iosAudioButton && isWidgetOpen) { // Показываем кнопку только если виджет открыт
                 iosAudioButton.classList.add('visible');
                 showMessage("Нажмите кнопку ниже для активации микрофона", 0); // Показываем кнопку и сообщение
              }

              return false; // Не удалось получить медиапоток
          }
      } else {
           widgetLog("Медиапоток с микрофона уже активен.", 'debug');
      }

      // Если контекст (audioContext/tempAudioContext) и поток (mediaStream) готовы, создаем/пересоздаем узлы AudioContext
      // Пересоздаем узлы всегда, если они не существуют, или если AudioContext сменился/возобновился.
      // Проще всегда отключать старые и создавать новые, если они не null.
      if (audioContext && mediaStream) {
          // Очищаем старые узлы перед созданием новых
          if (streamSource) { try { streamSource.disconnect(); } catch(e) {} streamSource = null; }
          if (audioProcessor) { try { audioProcessor.onaudioprocess = null; audioProcessor.disconnect(); } catch(e) {} audioProcessor = null; }
          if (iosGainNode) { try { iosGainNode.disconnect(); } catch(e) {} iosGainNode = null; }

          try {
              // Создаем source из потока
              streamSource = audioContext.createMediaStreamSource(mediaStream);

              // Оптимизированные размеры буфера для разных устройств
              const bufferSize = isIOS ? 4096 : // iOS: Больше для стабильности (вернем к 4096)
                                 isMobile ? 2048 : // Android
                                 2048; // Desktop

              // Проверка на поддержку ScriptProcessorNode (устаревший, но совместимый)
               if (audioContext.createScriptProcessor) {
                 audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
                 widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`, 'debug');
               } else if (audioContext.createJavaScriptNode) { // Для старых версий Safari
                 audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
                 widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${bufferSize}`, 'debug');
               } else {
                 throw new Error("Ваш браузер не поддерживает обработку аудио ScriptProcessorNode/JavaScriptNode");
               }


              // Переменные для отслеживания звука (сброс при реинициализации)
              let isSilent = true;
              let silenceStartTime = Date.now();
              let hasSentAudioInCurrentSegment = false;
              // let audioSampleCounter = 0; // Счетчик для отладки


              // Обработчик аудио
              audioProcessor.onaudioprocess = function(e) {
                // Отправляем данные только если прослушивание активно, соединение открыто и нет переподключения
                if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
                  const inputBuffer = e.inputBuffer;
                  let inputData = inputBuffer.getChannelData(0); // Получаем данные из первого канала (моно)

                  if (inputData.length === 0) return;

                  // audioSampleCounter++; // Не используется активно

                  // Вычисляем амплитуду
                  let maxAmplitude = 0;
                  // let sumAmplitude = 0; // Не используется
                  for (let i = 0; i < inputData.length; i++) {
                    const absValue = Math.abs(inputData[i]);
                    maxAmplitude = Math.max(maxAmplitude, absValue);
                    // sumAmplitude += absValue; // Не используется
                  }

                  // // Средняя амплитуда (полезна для iOS) - Не используется
                  // const avgAmplitude = sumAmplitude / inputData.length;


                  // **************** iOS Normalization/Gain (оптимизация из рабочего кода) ****************
                  // Применяем усиление для тихого сигнала на iOS
                   if (isIOS && maxAmplitude > 0 && maxAmplitude < 0.1) {
                       // Усиление: чем тише сигнал, тем больше усиление, максимум в 5 раз
                       const gain = Math.min(5, 0.3 / maxAmplitude);
                       const normalizedData = new Float32Array(inputData.length);
                       for (let i = 0; i < inputData.length; i++) {
                           normalizedData[i] = inputData[i] * gain;
                       }
                       // Обновляем входные данные нормализованными для визуализации и отправки
                       inputData = normalizedData;
                   }
                  // ***************************************************************************************


                  // Используем настройки в зависимости от устройства
                  const soundThreshold = isIOS ?
                                      0.005 : // Более низкий порог для iOS (из старого кода)
                                      effectiveAudioConfig.soundDetectionThreshold;

                  const hasSound = maxAmplitude > soundThreshold;

                  // Обновляем визуализацию
                  updateAudioVisualization(inputData);

                  // Преобразуем float32 в int16
                  const pcm16Data = new Int16Array(inputData.length);
                  for (let i = 0; i < inputData.length; i++) {
                    // Используем potentially normalized data
                    const sample = inputData[i]; // sample уже содержит нормализованные данные, если isIOS
                    pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767))); // Макс 32767
                  }

                  // Отправляем данные через WebSocket
                  try {
                    // Отправляем как ArrayBuffer
                    websocket.send(pcm16Data.buffer);
                    hasSentAudioInCurrentSegment = true;

                    // Отмечаем наличие аудиоданных (звука) только если порог превышен
                    if (!hasAudioData && hasSound) {
                      hasAudioData = true;
                      // audioDataStartTime установлен при старте прослушивания
                      widgetLog(`Начало обнаружения значимых аудиоданных. Amplitude: ${maxAmplitude.toFixed(4)}`, 'debug');
                    } else if (hasAudioData && hasSound) {
                        // Если звук продолжается, обновляем время активности (не обязательно, т.к. используем silenceStartTime)
                        // widgetLog(`Звук продолжается. Amplitude: ${maxAmplitude.toFixed(4)}`, 'debug');
                         isSilent = false; // Если есть звук, мы не в состоянии тишины
                    } else if (hasAudioData && !hasSound) {
                         // Если звук был, а теперь тишина - обновляем время начала тишины
                         if (isSilent === false) { // Переход из состояния звука в тишину
                            silenceStartTime = Date.now();
                            isSilent = true;
                             widgetLog(`Обнаружена тишина после звука. Начало тишины: ${silenceStartTime}`, 'debug');
                         }
                    } else if (!hasAudioData && !hasSound) {
                        // Если звука еще не было и сейчас тишина, ничего не делаем, isSilent=true по умолчанию.
                    }


                  } catch (error) {
                    widgetLog(`Ошибка отправки аудио по WS: ${error.message}`, "error");
                    // При ошибке отправки, возможно, соединение нерабочее
                     if (!isReconnecting) {
                        widgetLog("WS Send Error, attempting reconnect...", 'warn');
                        // Останавливаем только прослушивание, полная остановка придет из onclose
                        stopListening(); // StopListening отправит commit или clear
                        // Переподключение обработается в WS.onerror или WS.onclose
                     }
                  }

                  // Логика определения длительной тишины и автоматической отправки (commit)
                  const now = Date.now();

                  // Проверяем тишину только если мы в режиме прослушивания (isListening) И уже был обнаружен звук (hasAudioData)
                  if (isListening && hasAudioData && isSilent) { // isSilent должен быть true для начала отсчета тишины
                       const currentSilenceDuration = now - silenceStartTime;

                       const commitSilenceDuration = isIOS ?
                                                   800 : // iOS: Увеличено (было 800)
                                                   effectiveAudioConfig.silenceDuration; // Android/Desktop: из конфига

                       // Проверяем, достаточно ли долго длится тишина ПОСЛЕ обнаружения звука (hasAudioData)
                       if (currentSilenceDuration > commitSilenceDuration) {
                           // Если прошло достаточно времени с последней отправки коммита (опционально)
                           // и были аудиоданные в текущем сегменте (hasAudioData)
                           // и не идет воспроизведение (чтобы не прерывать ответ)
                           // Добавляем проверку, что сегмент не слишком короткий (от начала звука до текущего момента)
                            const totalSegmentDuration = now - audioDataStartTime;

                           // Проверяем, что есть отправленные аудиоданные И сегмент достаточно длинный И не воспроизводим аудио
                           if (hasSentAudioInCurrentSegment && !isPlayingAudio && totalSegmentDuration >= MIN_AUDIO_LENGTH) { // Используем константу MIN_AUDIO_LENGTH
                             widgetLog(`Обнаружена тишина (${currentSilenceDuration}ms) > ${commitSilenceDuration}ms после звука. Отправляем commit. Сегмент: ${totalSegmentDuration}ms`, 'info');
                             sendCommitBuffer(); // Эта функция сбрасывает флаги hasAudioData/audioDataStartTime/isSilent/hasSentAudioInCurrentSegment
                             lastCommitTime = Date.now(); // Обновляем время последнего коммита

                           } else if (totalSegmentDuration < MIN_AUDIO_LENGTH) { // Используем константу
                                widgetLog(`Тишина обнаружена, но сегмент (${totalSegmentDuration}ms) слишком короткий для коммита (${MIN_AUDIO_LENGTH}ms).`, 'debug');
                                 // Сбрасываем флаги, готовимся к новому сегменту
                                hasAudioData = false;
                                audioDataStartTime = 0;
                                hasSentAudioInCurrentSegment = false;
                                isSilent = true; // Остаемся в состоянии тишины
                                silenceStartTime = now; // Обновляем время начала тишины
                           } else if (!hasSentAudioInCurrentSegment) {
                              widgetLog("Тишина обнаружена, но в сегменте не было отправленных аудиоданных. Commit не отправляется.", 'debug');
                               // Сбрасываем флаги, т.к. сегмент не будет отправлен
                               hasAudioData = false;
                               audioDataStartTime = 0;
                               hasSentAudioInCurrentSegment = false;
                               isSilent = true; // Остаемся в состоянии тишины
                               silenceStartTime = now; // Обновляем время начала тишины
                           }
                       }
                  } else if (!isListening) {
                      // Если прослушивание остановлено вручную
                       if (hasAudioData && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
                            // Если были данные (обнаружен звук) и соединение активно, отправляем commit принудительно
                            // Добавляем проверку на минимальную длину сегмента даже при ручной остановке
                            const totalSegmentDuration = now - audioDataStartTime;
                            if (totalSegmentDuration >= MIN_AUDIO_LENGTH) {
                                widgetLog("Прослушивание остановлено вручную, отправляем commit для detected audio segment.", 'info');
                                sendCommitBuffer(); // Отправляет commit и сбрасывает флаги hasAudioData/audioDataStartTime/isSilent/hasSentAudioInCurrentSegment
                            } else {
                                widgetLog(`Прослушивание остановлено вручную, но сегмент (${totalSegmentDuration}ms) слишком короткий для коммита (${MIN_AUDIO_LENGTH}ms).`, 'warn');
                                 // Сбрасываем флаги, не отправляем commit
                                 hasAudioData = false; audioDataStartTime = 0; isSilent = true; silenceStartTime = now; hasSentAudioInCurrentSegment = false;
                                 // Отправляем clear buffer, если нет данных
                                 widgetLog("Sending clear buffer command on manual stop due to short segment.", 'debug');
                                 try {
                                    websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_manual_short_${Date.now()}` }));
                                 } catch(e) { widgetLog(`Error sending clear on manual stop short: ${e.message}`, 'warn'); }
                            }

                       } else if (websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
                            // Если прослушивание остановлено, но звука не было (hasAudioData=false),
                            // очищаем буфер на сервере, если соединение активно.
                             widgetLog("Прослушивание остановлено вручную, но аудиоданных не было, отправляем clear buffer.", 'debug');
                            try {
                               websocket.send(JSON.stringify({
                                    type: "input_audio_buffer.clear",
                                    event_id: `clear_on_manual_stop_${Date.now()}`
                                }));
                            } catch(e) {
                                widgetLog(`Error sending clear on manual stop: ${e.message}`, 'warn');
                            }
                       }
                       // Флаги hasAudioData/audioDataStartTime/isSilent/hasSentAudioInCurrentSegment
                       // сбрасываются либо в sendCommitBuffer, либо уже должны быть сброшены.
                  } else if (hasSound) {
                      // Если есть звук, но прослушивание неактивно - это странно, но сбрасываем флаги тишины
                       isSilent = false;
                  }
                } else {
                   // Если прослушивание неактивно (isListening === false), просто сбрасываем визуализацию и флаги
                   resetAudioVisualization();
                   // Сбрасываем флаги аудио данных, если прослушивание остановилось
                    hasAudioData = false;
                    audioDataStartTime = 0;
                    hasSentAudioInCurrentSegment = false;
                    isSilent = true;
                    silenceStartTime = Date.now(); // Сбрасываем время начала тишины
                }
              };

              // Подключаем source к processor
              streamSource.connect(audioProcessor);

              // **************** Подключение processor к выходу ****************
              // Для iOS НЕ соединяем напрямую с выходом AudioContext, чтобы избежать обратной связи (echo)
              if (isIOS) {
                // Создаем "пустой" узел с нулевой громкостью, если его нет
                if (!iosGainNode) {
                    iosGainNode = audioContext.createGain(); // Используем локальную ссылку
                    iosGainNode.gain.value = 0; // Установка громкости на ноль
                    widgetLog('Создан и установлен нулевой gainNode для iOS', 'debug');
                }
                 // Отключаем от всего, затем подключаем к gainNode
                 try { audioProcessor.disconnect(); } catch(e) {}
                audioProcessor.connect(iosGainNode);
                iosGainNode.connect(audioContext.destination); // Используем локальную ссылку AudioContext
                widgetLog('Аудио процессор подключен к нулевому gainNode для iOS.', 'debug');
              } else {
                // Для других устройств соединяем напрямую с выходом
                 // Проверяем, не подключен ли уже processor
                 // Нельзя подключать один узел к одному и тому же другому узлу дважды
                 // Простой способ избежать этого: отключить все, а потом подключить
                 try { audioProcessor.disconnect(); } catch(e) {} // Отключаем от всего
                audioProcessor.connect(audioContext.destination); // Используем локальную ссылку AudioContext
                 widgetLog('Аудио процессор подключен к выходу.', 'debug');
              }
              // ******************************************************************************


              widgetLog("Аудио узлы AudioContext подключены.", 'info');
              return true; // Успешная инициализация узлов

          } catch (error) {
            widgetLog(`Ошибка настройки AudioContext узлов: ${error.message}`, "error");

            // Очищаем ссылки на узлы при ошибке
            // Не трогаем tempAudioContext/audioContextInitialized/hasPlayedSilence здесь
            if (streamSource) { try { streamSource.disconnect(); } catch(e) {} streamSource = null; }
            if (audioProcessor) { try { audioProcessor.onaudioprocess = null; audioProcessor.disconnect(); } catch(e) {} audioProcessor = null; }
            if (iosGainNode) { try { iosGainNode.disconnect(); } catch(e) {} iosGainNode = null; }
            // streamSource = null; // Уже сброшены
            // audioProcessor = null; // Уже сброшены
            // iosGainNode = null; // Уже сброшены

            showMessage("Ошибка настройки аудио. Проверьте настройки браузера.", 5000);

            // Если это случилось на iOS и не была показана кнопка активации, возможно, стоит ее показать
             if (isIOS && iosAudioButton && !iosAudioButton.classList.contains('visible') && isWidgetOpen) { // Показываем кнопку только если виджет открыт
                iosAudioButton.classList.add('visible');
                showMessage("Не удалось настроить микрофон. Нажмите кнопку ниже для активации.", 0);
             }
            return false; // Не удалось настроить узлы
          }
      } else {
          // Если нет AudioContext или MediaStream (что уже должно быть обработано unlockAudioContextOnIOS или getUserMedia catch)
          widgetLog("AudioContext or MediaStream not available after initAudio calls.", 'error');
          // Сообщение об ошибке уже показано либо unlockAudioContextOnIOS, либо getUserMedia catch
          return false;
      }
    }

    // Начало записи голоса
    async function startListening() {
      // Проверяем предварительные условия
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
        // Добавляем более детальное логирование причин, по которым прослушивание не может быть начато
        const reason = !isConnected ? 'Not Connected' :
                       isPlayingAudio ? 'Playing Audio' :
                       isReconnecting ? 'Reconnecting' :
                       isListening ? 'Already Listening' : 'Unknown/Idle';
        widgetLog(`Не удается начать прослушивание. Причина: ${reason}. State: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`, 'debug');

        // Если виджет открыт и есть permanent error, показать ошибку
        if (isWidgetOpen && connectionFailedPermanently) {
             showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
             updateConnectionStatus('disconnected', 'Отключено');
        } else if (isWidgetOpen && !isConnected && !isReconnecting && !isPlayingAudio) {
            // Если виджет открыт, но нет соединения (и не переподключаемся, и не говорим), попробовать переподключиться
            widgetLog("Widget opened, but not connected, and idle. Attempting reconnect from startListening.", 'info');
            connectWebSocket(); // connectWebSocket сам запустит прослушивание в onopen при успехе
        } else if (isWidgetOpen && !isConnected && isReconnecting) {
             // Если виджет открыт и идет переподключение, просто показываем статус
             updateConnectionStatus('connecting', 'Переподключение...');
             showMessage("Переподключение...", 0);
        }


        return; // Выходим, если условия не соблюдены
      }

      widgetLog('Попытка начать прослушивание...', 'info');

      // Инициализация или реинициализация аудиозахвата (микрофон + узлы AudioContext)
      // initAudio теперь сам проверяет, нужно ли пересоздавать контекст/поток и обрабатывает iOS активацию
      const audioReady = await initAudio();
      if (!audioReady) {
        widgetLog('Не удалось подготовить аудио для прослушивания. startListening отменено.', 'error');
        // initAudio сам покажет сообщения об ошибках и кнопку iOS при необходимости
        // Важно: если не удалось получить доступ к микрофону, isListening останется false
        return;
      }

      // Если все готово, устанавливаем флаг и обновляем UI
      isListening = true;
      widgetLog('Прослушивание начато', 'info');

      // Отправляем команду для очистки буфера ввода на сервере
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        try {
            websocket.send(JSON.stringify({
              type: "input_audio_buffer.clear",
              event_id: `clear_start_${Date.now()}`
            }));
            websocket.send(JSON.stringify({ // Отменяем предыдущий ответ, если он был
               type: "response.cancel",
               event_id: `cancel_start_${Date.now()}`
            }));
             widgetLog("Sent clear and cancel commands on startListening", 'debug');
        } catch(e) {
            widgetLog(`Error sending clear/cancel on startListening: ${e.message}`, 'warn');
            // Ошибка отправки - возможно, соединение уже нерабочее, останавливаем прослушивание
            stopListening(); // StopListening отправит commit или clear
            // onclose/onerror обработает переподключение
            return; // Выходим, чтобы не продолжать отправлять аудио
        }
      } else {
          widgetLog("Cannot send clear/cancel commands on startListening: WS not open.", 'warn');
           // Если WS не открыт, прослушивание не должно было начаться, но на всякий случай
           stopListening();
           return;
      }


      // Сбрасываем флаги аудио данных для нового сегмента
      hasAudioData = false; // Начинаем новый сегмент без обнаруженного звука
      audioDataStartTime = Date.now(); // Время начала нового сегмента
      isSilent = true; // Изначально считаем, что в новом сегменте тишина
      silenceStartTime = Date.now(); // Время начала тишины (текущий момент)
      hasSentAudioInCurrentSegment = false; // В новом сегменте еще ничего не отправлено

      // Активируем визуальное состояние прослушивания если не воспроизводится аудио
      if (!isPlayingAudio && mainCircle) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
      // Скрываем любое сообщение об ошибке, если прослушивание успешно начато
      hideConnectionError();
      hideMessage(); // Скрываем также общее сообщение
      // Скрываем кнопку активации iOS, если она видна
      if (iosAudioButton) {
         iosAudioButton.classList.remove('visible');
      }
    }

    // Остановка записи голоса (например, по завершению диалога или при ошибке)
    function stopListening() {
      if (!isListening) {
        widgetLog("stopListening called, but not currently listening.", 'debug');
        // Сбросим состояние UI на всякий случай, если флаг был неверным
         if (mainCircle) mainCircle.classList.remove('listening');
         resetAudioVisualization();
        return;
      }
      widgetLog("Stopping listening", 'info');

      isListening = false;
      if (mainCircle) mainCircle.classList.remove('listening');
      resetAudioVisualization();

      // Не закрываем mediaStream здесь, чтобы можно было быстро переключиться на воспроизведение.
      // Полная остановка потока происходит в stopAllAudioProcessing или при старте воспроизведения.

      // Если был активный сегмент записи (обнаружен звук), отправляем commit
      // Проверка hasAudioData гарантирует, что мы не отправляем пустой сегмент, если пользователь просто открыл/закрыл виджет без звука.
      if (hasAudioData && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
           // Добавляем проверку на минимальную длину сегмента даже при ручной остановке
           const totalSegmentDuration = Date.now() - audioDataStartTime;
           if (totalSegmentDuration >= MIN_AUDIO_LENGTH) {
                widgetLog("Прослушивание остановлено, отправляем commit для detected audio segment.", 'info');
                sendCommitBuffer(); // Отправляет commit и сбрасывает флаги hasAudioData/audioDataStartTime/isSilent/hasSentAudioInCurrentSegment
           } else {
                widgetLog(`Прослушивание остановлено, но сегмент (${totalSegmentDuration}ms) слишком короткий для коммита (${MIN_AUDIO_LENGTH}ms).`, 'warn');
                 // Сбрасываем флаги, не отправляем commit
                hasAudioData = false; audioDataStartTime = 0; isSilent = true; silenceStartTime = Date.now(); hasSentAudioInCurrentSegment = false;
                 // Отправляем clear buffer, если нет данных
                 widgetLog("Sending clear buffer command on stop due to short segment.", 'debug');
                 if (websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
                     try {
                        websocket.send(JSON.stringify({ type: "input_audio_buffer.clear", event_id: `clear_stop_short_${Date.now()}` }));
                     } catch(e) { widgetLog(`Error sending clear on stop short: ${e.message}`, 'warn'); }
                 }
           }
      } else if (websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
           // Если звука не было (hasAudioData=false), очищаем буфер на сервере, если соединение активно.
            widgetLog("Прослушивание остановлено, но аудиоданных не было, отправляем clear buffer.", 'debug');
           try {
              websocket.send(JSON.stringify({
                   type: "input_audio_buffer.clear",
                   event_id: `clear_on_stop_${Date.now()}`
               }));
           } catch(e) {
               widgetLog(`Error sending clear on stopListening: ${e.message}`, 'warn');
           }
      }

      // Сбрасываем флаги аудио данных (дублирование, но безопасно)
      hasAudioData = false;
      audioDataStartTime = 0;
      isSilent = true; // Сбрасываем состояние тишины
      silenceStartTime = Date.now(); // Обновляем время начала тишины
      hasSentAudioInCurrentSegment = false; // Сбрасываем флаг отправки
    }


    // Функция для фактической отправки буфера (commit)
    function sendCommitBuffer() {
      if (!websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
         widgetLog("Cannot send commit: WS not open or reconnecting", 'warn');
         // Сбрасываем флаги, так как commit не отправлен
         hasAudioData = false;
         audioDataStartTime = 0;
         isSilent = true;
         silenceStartTime = Date.now();
         hasSentAudioInCurrentSegment = false;
         return;
      }

      // Проверяем, есть ли в буфере достаточно аудиоданных, которые мы считали "значащими"
      // Эта проверка должна быть уже пройдена до вызова sendCommitBuffer, но повторим.
      const totalSegmentDuration = Date.now() - audioDataStartTime;

      if (!hasAudioData || totalSegmentDuration < MIN_AUDIO_LENGTH) { // Используем константу
        const reason = !hasAudioData ? "no audio data detected" : `segment too short (${totalSegmentDuration}ms < ${MIN_AUDIO_LENGTH}ms)`;
        widgetLog(`Не отправляем commit из sendCommitBuffer, причина: ${reason}.`, "warn");
        // Сбрасываем флаги, готовимся к следующему сегменту
        hasAudioData = false;
        audioDataStartTime = 0;
        isSilent = true;
        silenceStartTime = Date.now();
        hasSentAudioInCurrentSegment = false;
        return;
      }

      widgetLog(`Отправка commit для сегмента длиной ~${totalSegmentDuration}мс`, 'info');

      // Сбрасываем эффект активности с небольшой задержкой для плавности
      if (mainCircle) {
          // Для мобильных устройств добавляем краткую паузу перед отправкой (визуальный эффект)
          if (isMobile) {
            setTimeout(() => { mainCircle.classList.remove('listening'); }, 100);
          } else {
            mainCircle.classList.remove('listening');
          }
      }


      // Отправляем команду для завершения буфера
      try {
         websocket.send(JSON.stringify({
           type: "input_audio_buffer.commit",
           event_id: `commit_${Date.now()}`
         }));
          widgetLog("Sent input_audio_buffer.commit command.", 'debug');

          // Показываем индикатор загрузки (кратковременно)
          if (loaderModal && isWidgetOpen) { // Показываем загрузку только если виджет открыт
            loaderModal.classList.add('active');
            // Скрываем загрузку через некоторое время, независимо от ответа сервера
            // Это для визуальной обратной связи после отправки коммита
            setTimeout(() => {
              if (loaderModal) loaderModal.classList.remove('active');
            }, 1000); // Таймаут на показ лоадера
          } else if (!isWidgetOpen) {
             widgetLog("Loader modal not shown because widget is closed.", 'debug');
          }


      } catch(e) {
          widgetLog(`Error sending commit command: ${e.message}`, 'error');
           // При ошибке отправки коммита, возможно, соединение прервано
          // onclose/onerror обработает переподключение
           if (loaderModal) loaderModal.classList.remove('active');
      }


      // Сбрасываем флаги аудио данных для следующего сегмента
      hasAudioData = false;
      audioDataStartTime = 0;
      isSilent = true; // Сбрасываем состояние тишины
      silenceStartTime = Date.now(); // Обновляем время начала тишины
      hasSentAudioInCurrentSegment = false; // Сбрасываем флаг отправки
    }


    // Преобразование ArrayBuffer в Base64 (уже не используется для отправки, но оставлено)
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

      // Уменьшаем чувствительность, чтобы бары не зашкаливали от небольшого шума
      const sensitivity = isMobile ? 80 : 50; // Скорректировал чувствительность

      // Вычисляем общую среднюю амплитуду для всего буфера
      let sum = 0;
      for (let i = 0; i < audioData.length; i++) {
         sum += Math.abs(audioData[i]);
      }
      const overallAverage = sum / audioData.length;

       // Простая визуализация: все бары имеют одинаковую высоту, основанную на средней амплитуде
       const height = 2 + Math.min(28, Math.floor(overallAverage * sensitivity)); // Высота от 2px до 30px
       bars.forEach(bar => {
            bar.style.height = `${height}px`;
       });
    }

    // Сброс визуализации аудио
    function resetAudioVisualization() {
       if (!audioBars) return;
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px'; // Возвращаем минимальную высоту
      });
    }

    // Создаём простой WAV из PCM данных (для воспроизведения)
    function createWavFromPcm(pcmBuffer, sampleRate = 16000) { // Используем 16k как стандарт для STT/TTS
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
        widgetLog("Audio playback queue is empty. Playback finished.", 'info');
        isPlayingAudio = false;
        if (mainCircle) mainCircle.classList.remove('speaking');
        // Скрываем модальное окно загрузки, если оно активно
         if (loaderModal) loaderModal.classList.remove('active');


        // После завершения воспроизведения, пытаемся снова начать слушать, если виджет открыт
        // и не идет переподключение, и соединение активно
        if (isWidgetOpen && isConnected && !isReconnecting) {
           widgetLog("Playback finished, attempting to restart listening if state allows.", 'info');
           // Добавляем задержку перед стартом прослушивания для стабильности, особенно на мобильных
           const restartDelay = isMobile ? 1200 : 800; // Увеличил задержку для мобильных

           setTimeout(() => {
             // Проверяем, что виджет все еще открыт и не идет переподключение, и не начали говорить снова вручную
             if (isWidgetOpen && !isPlayingAudio && !isReconnecting && isConnected && !isListening) {
                  widgetLog("Attempting to auto-start listening after playback delay.", 'info');
                 startListening(); // Эта функция сама проверит состояние аудио и iOS активацию
             } else {
                 widgetLog(`Skipping auto-restart listening after playback: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isConnected=${isConnected}, isListening=${isListening}`, 'debug');
             }
           }, restartDelay);
        } else {
             widgetLog(`Playback finished, not restarting listening: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
             // Если виджет закрыт или нет соединения/ошибка, добавляем пульсацию на кнопку (если нет permanent error)
             if (!isWidgetOpen && widgetButton && !connectionFailedPermanently) {
                widgetButton.classList.add('wellcomeai-pulse-animation');
             }
        }
        return;
      }

      // Останавливаем прослушивание перед воспроизведением
       if (isListening) {
            widgetLog("Stopping listening before starting playback.", 'debug');
            stopListening(); // Останавливает логику записи и отправку коммита
       }


      isPlayingAudio = true;
      if (mainCircle) {
         mainCircle.classList.add('speaking');
         mainCircle.classList.remove('listening'); // Убедимся, что listening снят
      }
      hideMessage(); // Sкрываем текстовое сообщение перед воспроизведением аудио

      const audioBase64 = audioPlaybackQueue.shift();
      widgetLog(`Playing next audio chunk (queue size: ${audioPlaybackQueue.length})`, 'debug');

      try {
         const audioData = base64ToArrayBuffer(audioBase64);
         if (audioData.byteLength === 0) {
           widgetLog("Skipping empty audio chunk.", 'warn');
           playNextAudio(); // Играем следующий сразу
           return;
         }

         // Используем HTMLAudioElement для воспроизведения (как в старом коде)
         const wavBuffer = createWavFromPcm(audioData, 16000); // Создаем WAV с 16k
         const blob = new Blob([wavBuffer], { type: 'audio/wav' });
         const audioUrl = URL.createObjectURL(blob);

         const audio = new Audio();
         audio.src = audioUrl;
         audio.preload = 'auto'; // Предзагрузка
         // audio.volume = 1; // Громкость по умолчанию 1


         audio.oncanplaythrough = function() {
             widgetLog("Audio can play, attempting playback.", 'debug');
             const playPromise = audio.play();
             if (playPromise !== undefined) {
                 playPromise.then(() => {
                     widgetLog("Playback started successfully.", 'debug');
                 }).catch(error => {
                     widgetLog(`Error during audio.play(): ${error.name || 'Unknown Error'}: ${error.message}`, 'error');
                      // Если ошибка NotAllowedError, возможно, нужно еще раз разблокировать
                     if (error.name === 'NotAllowedError' && isIOS && iosAudioButton && isWidgetOpen) {
                        widgetLog('iOS Playback NotAllowedError - showing activation button.', 'info');
                        iosAudioButton.classList.add('visible');
                        showMessage("Нажмите кнопку ниже для активации звука", 0);
                        // При клике на эту кнопку, unlockAudioContextOnIOS() попытается возобновить контекст.
                        // Затем playNextAudio() вызовется снова (т.к. isPlayingAudio=true и очередь не пуста),
                        // и попробует воспроизвести этот же фрагмент.
                     } else {
                          // Для других ошибок, или если не iOS, переходим к следующему
                          playNextAudio(); // Переходим к следующему в очереди
                     }
                 });
             } else {
                 // Случай без промиса (старые браузеры?)
                 widgetLog("Audio.play() did not return a promise.", 'debug');
             }
         };

         audio.onended = function() {
           widgetLog("Audio playback ended.", 'debug');
           URL.revokeObjectURL(audioUrl); // Очищаем URL Blob
           playNextAudio(); // Играем следующий фрагмент
         };

         audio.onerror = function(e) {
           widgetLog(`Audio element error: ${e.message || 'Unknown error'}`, 'error', e);
           URL.revokeObjectURL(audioUrl);
           playNextAudio(); // Переходим к следующему, несмотря на ошибку текущего
         };

         audio.load(); // Запускаем загрузку и подготовку

      } catch (error) {
        widgetLog(`Общая ошибка воспроизведения аудио: ${error.message}`, "error");
        showMessage("Произошла ошибка воспроизведения.", 5000);
        playNextAudio(); // Переходим к следующему, несмотря на ошибку текущего
      }
    }


    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') {
          widgetLog("Attempted to add empty or invalid audio chunk to queue.", 'warn');
          return;
      }

      widgetLog(`Adding audio chunk to playback queue (current size: ${audioPlaybackQueue.length})`, 'debug');
      // Добавляем аудио в очередь
      audioPlaybackQueue.push(audioBase64);

      // Если не запущено воспроизведение, запускаем
      if (!isPlayingAudio) {
        widgetLog("Playback not active, starting playback.", 'debug');
        playNextAudio();
      } else {
          widgetLog("Playback already active, queueing audio.", 'debug');
      }
    }

    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      // Проверяем, не превышено ли максимальное количество попыток
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

      if (reconnectAttempts >= maxAttempts) {
        widgetLog(`Maximum reconnection attempts (${maxAttempts}) reached. Stopping.`, 'error');
        isReconnecting = false;
        connectionFailedPermanently = true;

        // Скрываем индикатор загрузки, если он активен
         if (loaderModal) loaderModal.classList.remove('active');

        // Показываем сообщение пользователю, если виджет открыт
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение. Попробуйте перезагрузить страницу.");
          updateConnectionStatus('disconnected', 'Отключено');
          hideMessage(); // Скрываем сообщение "Переподключение..."
        } else {
          // Если виджет закрыт, добавляем пульсацию на кнопку
          if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
           updateConnectionStatus('disconnected', 'Отключено'); // Обновляем внутренний статус
        }
        // Останавливаем любые аудио процессы
        stopAllAudioProcessing();
        return;
      }

      // Устанавливаем флаг переподключения
      if (!isReconnecting) {
          isReconnecting = true;
          widgetLog("Setting isReconnecting = true for reconnectWithDelay", 'debug');
      }


      // Показываем сообщение пользователю, если виджет открыт
      if (isWidgetOpen) {
        showMessage("Соединение прервано. Переподключение...", 0);
        updateConnectionStatus('connecting', 'Переподключение...');
         if (loaderModal) loaderModal.classList.add('active'); // Показываем загрузку при переподключении
      } else {
          // Если виджет закрыт, просто обновляем статус внутренне и убираем пульсацию
          updateConnectionStatus('connecting', 'Переподключение...');
           if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
           //if (loaderModal) loaderModal.classList.add('active'); // Показываем загрузку даже если виджет закрыт? Возможно, лучше не показывать. Убираем.
           if (loaderModal) loaderModal.classList.remove('active'); // Решено: не показывать загрузку, если виджет закрыт
      }


      // Если задана начальная задержка, используем ее, иначе экспоненциальная
      const delay = initialDelay > 0 ?
                initialDelay :
                isMobile ?
                    Math.min(15000, Math.pow(1.8, reconnectAttempts) * 500) : // Немного скорректировал экспоненту для моб.
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);

      // reconnectAttempts++ уже увеличивается в connectWebSocket при каждой попытке

      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`, 'info');

      // Пытаемся переподключиться с увеличивающейся задержкой
      setTimeout(() => {
        // Проверяем флаг isReconnecting перед попыткой, чтобы избежать дублирования,
        // если reconnectWithDelay был вызван несколько раз подряд (например, из onclose и onerror).
        // connectWebSocket сам проверит состояние и сбросит флаг при успехе.
        if (isReconnecting) {
           widgetLog("Executing planned reconnect attempt.", 'debug');
           connectWebSocket(); // connectWebSocket сам сбросит isReconnecting при onopen
        } else {
           widgetLog("Skipping planned reconnect attempt because isReconnecting flag is false.", 'debug');
        }
      }, delay);
    }

    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      // Если соединение уже открыто или находится в процессе открытия, ничего не делаем
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
           widgetLog("WebSocket connection is already OPEN or CONNECTING. Skipping connection attempt.", 'debug');
           // Если мы были в состоянии переподключения, но соединение уже открыто (возможно, из другой вкладки или вручную), сбрасываем флаг
           if (isReconnecting) {
               widgetLog("Detected already open connection while in reconnect state. Resetting reconnect state.", 'info');
               isReconnecting = false;
               reconnectAttempts = 0;
               connectionFailedPermanently = false;

               if (loaderModal) loaderModal.classList.remove('active');
               hideConnectionError();
               hideMessage();
               updateConnectionStatus('connected', 'Подключено');

                if (isWidgetOpen) {
                    // Если виджет открыт, пытаемся начать слушать (с небольшой задержкой)
                    setTimeout(() => {
                        if (isWidgetOpen && !isPlayingAudio && !isListening) {
                             widgetLog("Widget is open, connection restored, attempting to start listening.", 'info');
                             startListening(); // Эта функция сама проверит iOS активацию
                        } else {
                            widgetLog(`Skipping auto-start listening after connection restored: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isReconnecting=${isReconnecting}`, 'debug');
                        }
                    }, isMobile ? 1000 : 500);
                } else {
                    // Если виджет закрыт, добавляем пульсацию на кнопку
                    if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                }
           }
           return; // Выходим, т.к. соединение уже есть/в процессе
      }

      // Если было permanent error, не пытаемся автоматически переподключаться
      if (connectionFailedPermanently) {
          widgetLog("Connection failed permanently, not attempting connectWebSocket automatically.", 'info');
          if (isWidgetOpen) {
             showConnectionError("Не удалось подключиться к серверу. Нажмите кнопку 'Повторить подключение'.");
             updateConnectionStatus('disconnected', 'Отключено');
          } else {
             if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
             updateConnectionStatus('disconnected', 'Отключено');
          }
           if (loaderModal) loaderModal.classList.remove('active');
          return false;
      }

       // Проверяем наличие ASSISTANT_ID и WS_URL перед созданием сокета
      if (!ASSISTANT_ID || !WS_URL) {
         widgetLog('Cannot connect: Assistant ID or WS URL is null.', 'error');
         loaderModal.classList.remove('active');
         isReconnecting = false;
         connectionFailedPermanently = true;
         if (isWidgetOpen) {
           showConnectionError("Не удалось определить адрес сервера или ID ассистента.");
           updateConnectionStatus('disconnected', 'Ошибка конфигурации');
         } else {
            updateConnectionStatus('disconnected', 'Ошибка конфигурации');
             if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
         }
         return false;
      }


      widgetLog("Starting new WebSocket connection attempt...", 'info');
      // Показываем загрузку только если виджет открыт или если это первая попытка/ручной ретрай
      if (isWidgetOpen || reconnectAttempts === 0) {
         if (loaderModal) loaderModal.classList.add('active');
      }


      // Устанавливаем флаг переподключения и увеличиваем счетчик попыток
      // Делаем это здесь, чтобы счетчик увеличивался при каждой попытке
      if (!isReconnecting) {
          isReconnecting = true; // Флаг устанавливается при первой необходимости переподключения
      }
      reconnectAttempts++; // Увеличиваем счетчик при каждой попытке connectWebSocket
      widgetLog(`Attempt ${reconnectAttempts}/${isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS} to connect.`, 'debug');


      // Скрываем ошибку соединения, если она была показана
      hideConnectionError();

      // Очищаем предыдущее соединение, если оно существует и не закрыто
      if (websocket && websocket.readyState !== WebSocket.CLOSED && websocket.readyState !== WebSocket.CLOSING) {
        widgetLog(`Closing previous WebSocket connection (state: ${websocket.readyState}) before creating new one.`, 'debug');
        try {
          // Добавляем временный обработчик onclose, чтобы избежать вызова reconnectWithDelay
          // когда мы сами закрываем соединение перед пересозданием
          let tempOnClose = websocket.onclose;
          websocket.onclose = null; // Временно отключаем основной обработчик
          websocket.close(1000, 'Client initiating new connection');
           // Восстанавливаем обработчик после небольшой задержки, если он был
           // (Убеждаемся, что он не null перед присваиванием)
           setTimeout(() => { if (typeof tempOnClose === 'function') websocket.onclose = tempOnClose; }, 50);

        } catch (e) {
          widgetLog(`Error closing previous WS: ${e.message}`, 'warn');
        }
        websocket = null; // Очищаем ссылку
      } else if (websocket) {
           widgetLog(`Previous WebSocket is already closed or closing (state: ${websocket.readyState}). Clearing reference.`, 'debug');
           websocket = null; // Убеждаемся, что ссылка очищена
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
        websocket.binaryType = 'arraybuffer'; // Устанавливаем двоичный тип для отправки/приема ArrayBuffer
        widgetLog(`WebSocket instance created for URL: ${WS_URL}. Binary type: ${websocket.binaryType}`, 'debug');

        // Устанавливаем таймаут на открытие соединения
        connectionTimeout = setTimeout(() => {
          widgetLog(`WebSocket connection timeout (${CONNECTION_TIMEOUT}ms) exceeded. State: ${websocket ? websocket.readyState : 'null'}`, "error");

          if (websocket && (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN)) {
             // Если состояние все еще CONNECTING или OPEN (хотя по таймауту не должно быть OPEN), закрываем его
             widgetLog("Timeout: Closing unresponsive WebSocket connection.", 'warn');
             try { websocket.close(1000, 'Connection Timeout'); } catch(e) { widgetLog(`Error closing WS on timeout: ${e.message}`, 'warn');}
          } else {
             // Если состояние уже CLOSED или CLOSING, просто обрабатываем как неудачу
             widgetLog("Timeout: WebSocket was already closing or closed.", 'warn');
          }
           // onclose будет вызван после websocket.close() и запустит reconnectWithDelay,
           // если isReconnecting = true.
           // Если websocket был null или уже закрыт, onclose не будет вызван,
           // но reconnectWithDelay мог быть уже вызван из onerror/onclose ранее.
           // Логика reconnectWithDelay проверяет флаг isReconnecting перед запуском connectWebSocket.
        }, CONNECTION_TIMEOUT);

        websocket.onopen = function() {
          clearTimeout(connectionTimeout); // Отменяем таймаут
          connectionTimeout = null; // Очищаем ссылку
          widgetLog('WebSocket connection established successfully.', 'info');
          isConnected = true;
          isReconnecting = false; // Сбрасываем флаг переподключения при успехе
          reconnectAttempts = 0; // Сбрасываем счетчик попыток
          connectionFailedPermanently = false; // Сбрасываем флаг фатальной ошибки

          if (loaderModal) loaderModal.classList.remove('active'); // Скрываем загрузку
          hideConnectionError(); // Скрываем ошибку соединения, если она была показана
          hideMessage(); // Скрываем сообщение о подключении/переподключении

          // Обновляем статус соединения в UI
          updateConnectionStatus('connected', 'Подключено');

          // Инициализируем переменные для ping/pong
          // lastPingTime не используется, достаточно lastPongTime
          lastPongTime = Date.now();

          // Настраиваем интервал ping с разной частотой для мобильных и десктопных устройств
          const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
          const pongTimeoutTime = pingIntervalTime * (isMobile ? 4 : 3); // Таймаут для pong

          // Запускаем ping для поддержания соединения
          if (pingIntervalId) clearInterval(pingIntervalId); // Очищаем старый интервал на всякий случай
          pingIntervalId = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
              try {
                websocket.send(JSON.stringify({ type: "ping" }));
                // widgetLog("Sent ping.", 'debug'); // Слишком частое логирование

                // Проверяем, получили ли мы pong за разумное время
                if (Date.now() - lastPongTime > pongTimeoutTime) {
                  widgetLog(`Ping timeout (${pongTimeoutTime}ms), no pong received. Closing connection.`, "warn");
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
            } else {
                 // Если WS не открыт, очищаем интервал пинга
                 if (pingIntervalId) {
                     clearInterval(pingIntervalId);
                     pingIntervalId = null;
                     widgetLog("Cleared ping interval because WebSocket is not open.", 'debug');
                 }
            }
          }, pingIntervalTime);

          // Автоматически начинаем слушать, если виджет открыт
          if (isWidgetOpen) {
             widgetLog("Widget is open, attempting to start listening after successful connection.", 'info');
             // Небольшая задержка перед стартом прослушивания после onopen
             setTimeout(() => {
                 // Проверяем состояние снова, чтобы избежать старта, если виджет закрылся,
                 // пользователь начал говорить сам, или соединение снова прервалось.
                 if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                      widgetLog("Auto-starting listening after connection and delay.", 'info');
                      startListening(); // Эта функция сама проверит iOS активацию
                 } else {
                    widgetLog(`Skipping auto-start listening after connect and delay: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
                 }
             }, isMobile ? 1000 : 500); // Задержка перед стартом прослушивания после onopen
          } else {
             // Если виджет закрыт, добавляем пульсацию на кнопку
             if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
             widgetLog("Widget is closed, not auto-starting listening after connection.", 'info');
          }
        };

        websocket.onmessage = function(event) {
          // Обновляем время последнего pong при получении любого сообщения
          lastPongTime = Date.now();
          //widgetLog("Received message, updated lastPongTime.", 'debug'); // Слишком частое логирование

          try {
             // Сервер отправляет JSON, бинарные данные не ожидаются как корневой тип
             // Если сервер все же отправляет бинарные данные (например, аудио), здесь нужно их обработать
            if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
              widgetLog("Received binary data (unhandled).", "warn"); // Пока просто предупреждаем
              // Если сервер должен отправлять аудио напрямую, логика обработки должна быть здесь
              return;
            }

            // Проверка на пустое сообщение или ping/pong (raw string)
            if (!event.data || typeof event.data !== 'string') {
               widgetLog(`Received empty or non-string message (Type: ${typeof event.data}).`, "warn");
               return;
            }

            // Проверим на ping/pong сообщения (которые могут быть не JSON)
             if (event.data.trim() === 'pong') {
               lastPongTime = Date.now();
               //widgetLog("Получен pong-ответ.", 'debug'); // Слишком частое логирование
               return;
             }
             if (event.data.trim() === 'ping') {
                 //widgetLog("Получен ping-запрос от сервера (неожиданно, т.к. клиент отправляет пинг).", 'debug');
                 // Можно ответить pong, если сервер ожидает
                 // try { websocket.send('pong'); } catch(e) {}
                 return;
             }


            // Обработка текстовых сообщений (должны быть JSON)
            try {
              const data = JSON.parse(event.data);

              // Обработка известных ACK сообщений, чтобы они не попадали в "Неизвестный тип"
              if (data.type === 'input_audio_buffer.clear.ack' ||
                  data.type === 'response.cancel.ack' ||
                  data.type === 'input_audio_buffer.cleared' ||
                  data.type === 'binary.ack')
             {
                // Log these as debug if DEBUG_MODE is on, otherwise ignore
                 widgetLog(`Received acknowledged message type: ${data.type}`, 'debug', data);
                return; // Не обрабатываем дальше
              }


              // Не логируем частые сообщения append/delta в обычном режиме
              const isChattyMessage = data.type === 'input_audio_buffer.append' || data.type === 'response.text.delta' || data.type === 'response.audio.delta' || data.type === 'response.audio_transcript.delta';
              if (!isChattyMessage || DEBUG_MODE) {
                 // Log the message type, payload only in DEBUG_MODE
                 widgetLog(`Received message type: ${data.type || 'unknown'}`, 'info', DEBUG_MODE ? data : null);
              }


              // Проверка на сообщение session.created и session.updated
              if (data.type === 'session.created' || data.type === 'session.updated') {
                // widgetLog(`Получена информация о сессии: ${data.type}`, 'debug'); // Логируем, но не требуется спец. обработки
                return;
              }

              // Проверка на сообщение connection_status
              if (data.type === 'connection_status') {
                widgetLog(`Статус соединения от сервера: ${data.status} - ${data.message}`, 'info');
                 if (data.status === 'connected') {
                     // Соединение установлено, можно начинать слушать
                     isConnected = true;
                     isReconnecting = false;
                     reconnectAttempts = 0;
                     connectionFailedPermanently = false;

                     if (loaderModal) loaderModal.classList.remove('active');
                      hideConnectionError();
                      hideMessage();
                     updateConnectionStatus('connected', 'Подключено');

                     // Автоматически начинаем слушать если виджет открыт и не идет воспроизведение/переподключение
                     if (isWidgetOpen && !isPlayingAudio && !isListening) {
                         widgetLog("Server status connected, widget open and idle. Attempting to start listening.", 'info');
                         setTimeout(() => {
                             if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                                 widgetLog("Auto-starting listening after server status.", 'info');
                                 startListening(); // Эта функция сама проверит iOS активацию
                             } else {
                                 widgetLog(`Skipping auto-start listening after server status: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
                             }
                         }, isMobile ? 1000 : 500); // Задержка
                     } else {
                          widgetLog(`Server status connected, but not auto-starting listening: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isReconnecting=${isReconnecting}`, 'debug');
                     }
                 } else {
                      // Сервер сообщил о другом статусе (e.g., disconnected, error, busy)
                      widgetLog(`Server reports status: ${data.status}. Reason: ${data.message}`, 'warn');
                      // Если сервер явно говорит об ошибке или отключении, обрабатываем как отключение
                      if (data.status === 'disconnected' || data.status === 'error') {
                           isConnected = false; // Обновляем флаг
                           // onclose или onerror должны будут обработать переподключение
                           // Если соединение еще не закрыто, можно принудительно закрыть
                           if (websocket && websocket.readyState === WebSocket.OPEN) {
                                widgetLog(`Server reported ${data.status}, closing client WS.`, 'debug');
                                try { websocket.close(1000, `Server: ${data.status}`); } catch(e) {}
                           }
                      }
                      // Если статус другой (e.g., busy, processing), можно просто показать сообщение
                      if (data.message && isWidgetOpen) { // Показываем сообщение только если виджет открыт
                           showMessage(data.message, 3000); // Показываем сообщение от сервера
                      }
                 }
                return;
              }

              // Обработка ошибок от сервера
              if (data.type === 'error') {
                 const errorMessage = data.error && data.error.message ? data.error.message : 'Неизвестная ошибка сервера';
                 const errorCode = data.error && data.error.code ? data.error.code : 'unknown';
                 widgetLog(`Получена ошибка от сервера: [${errorCode}] ${errorMessage}`, "error", data.error);

                 // **************** ИСПРАВЛЕНИЕ: Игнорируем ошибку response_cancel_not_active ****************
                 if (errorCode === 'response_cancel_not_active') {
                     widgetLog("Ignoring server error 'response_cancel_not_active' as non-critical.", 'debug');
                     // Не останавливаем прослушивание и не показываем сообщение пользователю
                     return;
                 }
                 // ***************************************************************************************

                // Особая обработка для ошибки пустого аудиобуфера
                if (errorCode === 'input_audio_buffer_commit_empty') {
                  widgetLog("Ошибка: сервер получил пустой аудиобуфер при коммите. Перезапускаем прослушивание (если idle).", "warn");
                  // Перезапускаем прослушивание без сообщения пользователю, если виджет открыт, idle и подключен
                  // Добавляем небольшую задержку перед перезапуском
                  if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                    setTimeout(() => {
                       if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                           widgetLog("Auto-restarting listening after empty commit error.", 'info');
                           startListening();
                       } else {
                            widgetLog(`Skipping auto-restart listening after empty buffer error: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
                       }
                    }, 500); // Небольшая задержка
                  }
                  // Не показываем это как обычную ошибку пользователю
                  return;
                }

                 // При других ошибках, остановить прослушивание и показать сообщение
                 if (isListening) {
                    widgetLog("Stopping listening due to server error.", 'info');
                    stopListening(); // Останавливаем прослушивание
                 }
                 if (isWidgetOpen) { // Показываем ошибку пользователю только если виджет открыт
                   showMessage(`Ошибка: ${errorMessage}`, 5000);
                 }
                return;
              }

              // Обработка текстового ответа (части)
              if (data.type === 'response.text.delta') {
                 // Убедимся, что мы не в процессе переподключения и виджет открыт (чтобы не показывать текст в закрытом виде)
                 if (isReconnecting || !isWidgetOpen) return;

                if (data.delta) {
                  // Очищаем сообщение, если это первый фрагмент нового ответа
                  // Простой способ: если последний тип сообщения был не text.delta или сообщение было пустым
                  if (messageDisplay.textContent === '' || messageDisplay.lastEventType !== 'response.text.delta' || messageDisplay.isNewResponse) {
                       messageDisplay.textContent = data.delta;
                       messageDisplay.isNewResponse = false; // Сбросить флаг
                  } else {
                       messageDisplay.textContent += data.delta;
                  }
                   messageDisplay.lastEventType = 'response.text.delta';
                   showMessage(messageDisplay.textContent, 0); // Обновляем текст и показываем, не скрываем
                }
                return;
              }

              // Завершение текстового ответа
              if (data.type === 'response.text.done') {
                 if (isReconnecting || !isWidgetOpen) return;

                widgetLog('Text response done.', 'info');
                 messageDisplay.lastEventType = 'response.text.done';
                 messageDisplay.isNewResponse = true; // Следующий text.delta будет новым ответом

                // После завершения текста, установим таймер на скрытие сообщения,
                // если не идет воспроизведение аудио. Если аудио идет, сообщение скроется после него.
                 if (!isPlayingAudio) {
                   setTimeout(() => {
                     hideMessage();
                   }, 5000);
                 }
                return;
              }

              // Обработка аудио ответа (части)
              if (data.type === 'response.audio.delta') {
                 if (isReconnecting) return; // Игнорируем во время переподключения
                if (data.delta) {
                  audioChunksBuffer.push(data.delta);
                }
                return;
              }

              // Обработка аудио транскрипции (если сервер ее отправляет)
              // Можно добавить логику для отображения в отдельном блоке UI, если нужно.
              if (data.type === 'response.audio_transcript.delta') {
                 // widgetLog(`Транскрипция (дельта): ${data.delta}`, 'debug');
                 // Пример: добавить в отдельный DOM элемент
                 // if (transcriptElement) transcriptElement.textContent += data.delta;
                return;
              }

              if (data.type === 'response.audio_transcript.done') {
                // widgetLog(`Транскрипция (полностью): ${data.transcript}`, 'debug');
                 // Пример: обновить отдельный DOM элемент
                 // if (transcriptElement) transcriptElement.textContent = data.transcript;
                return;
              }


              // Аудио готово для воспроизведения
              if (data.type === 'response.audio.done') {
                 if (isReconnecting) return;

                widgetLog(`Audio response done. Buffer size: ${audioChunksBuffer.length}`, 'info');
                if (audioChunksBuffer.length > 0) {
                  const fullAudioBase64 = audioChunksBuffer.join('');
                  addAudioToPlaybackQueue(fullAudioBase64); // Добавляем в очередь
                  audioChunksBuffer = []; // Очищаем буфер после добавления в очередь
                } else {
                    widgetLog("Received audio.done but audioChunksBuffer is empty.", 'warn');
                    // Если аудио буфер пуст, и мы не играем ничего, и виджет открыт,
                    // и не слушаем, и подключены - попробовать начать слушать снова
                    if (!isPlayingAudio && isWidgetOpen && isConnected && !isListening && !isReconnecting) {
                         widgetLog("Audio buffer empty on audio.done, attempting to restart listening.", 'info');
                         // Добавляем задержку перед стартом прослушивания
                         const restartDelay = isMobile ? 1200 : 800;
                         setTimeout(() => {
                           if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                                widgetLog("Auto-starting listening after empty audio.done.", 'info');
                              startListening(); // Эта функция сама проверит iOS активацию
                           } else {
                               widgetLog(`Skipping auto-start listening after empty audio.done: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
                           }
                         }, restartDelay);
                    }
                }
                return;
              }

              // Ответ завершен (текст и аудио)
              if (data.type === 'response.done') {
                 if (isReconnecting) return;

                widgetLog('Response done received', 'info');
                 messageDisplay.lastEventType = 'response.done';

                 // Скрываем модальное окно загрузки, если оно еще активно
                 if (loaderModal) loaderModal.classList.remove('active');


                 // После завершения ответа, пытаемся снова начать слушать, если виджет открыт
                 // и не идет переподключение, и соединение активно
                 // Логика возобновления прослушивания теперь также находится в playNextAudio,
                 // которая вызывается после завершения последнего аудиофрагмента.
                 // Если аудиофрагментов не было, playNextAudio вызовется сразу после добавления
                 // пустого буфера (если received audio.done был пустым) или не вызовется вообще.
                 // Если аудио не играется, но response.done пришел, запускаем логику старта прослушивания здесь.
                if (!isPlayingAudio && isWidgetOpen && isConnected && !isListening) {
                     widgetLog("Response done, no audio playing. Attempting to restart listening directly if idle.", 'info');
                      // Добавляем задержку перед стартом прослушивания
                     const restartDelay = isMobile ? 1200 : 800; // Увеличил задержку для мобильных
                     setTimeout(() => {
                        if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                           widgetLog("Auto-starting listening after response.done and delay.", 'info');
                           startListening(); // Эта функция сама проверит iOS активацию
                        } else {
                           widgetLog(`Skipping auto-start listening after response.done: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
                        }
                     }, restartDelay);
                } else {
                    widgetLog(`Response done, but not starting listening immediately: isPlayingAudio=${isPlayingAudio}, isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}`, 'debug');
                }

                // Если не идет воспроизведение аудио, устанавливаем таймер на скрытие сообщения
                 if (!isPlayingAudio) {
                     setTimeout(() => {
                         hideMessage();
                     }, 5000); // Скрываем через 5 секунд после response.done, если нет аудио
                 } else {
                      // Если аудио играется, сообщение скрывается после завершения аудио (в playNextAudio)
                 }


                return;
              }

              // Если мы дошли до этой точки, у нас неизвестный тип сообщения
              widgetLog(`Неизвестный тип сообщения от сервера: ${data.type}`, "warn", data); // Логируем неизвестные сообщения для отладки

            } catch (parseError) {
              // Если не удалось распарсить JSON
              widgetLog(`Ошибка парсинга JSON сообщения: ${parseError.message}. Содержимое: ${event.data ? event.data.substring(0, 200) : 'Empty'}...`, "warn");
              // Не показываем пользователю ошибку парсинга, это техническая деталь
            }
          } catch (generalError) {
            widgetLog(`Общая ошибка обработки сообщения: ${generalError.message}`, "error", generalError);
             // Не показываем пользователю общую ошибку обработки сообщения
          }
        };

        websocket.onclose = function(event) {
          widgetLog(`WebSocket connection closed. Code=${event.code}, Reason=${event.reason}, Clean=${event.wasClean}`, 'info');
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

          // Скрываем модальное окно загрузки, если оно активно
          if (loaderModal) loaderModal.classList.remove('active');


          // Не пытаемся переподключаться, если:
          // 1. Соединение было закрыто нормально (wasClean=true, обычно с кодом 1000)
          // 2. Мы сами его закрыли (код 1000, 1001 - инициировано клиентом)
          // 3. Флаг isReconnecting сброшен вручную (например, при permanent error или ручном reset)
          // 4. Код 1006 без wasClean (ошибка сети/сервера, but browser may report wasClean=false) - в этом случае *нужно* переподключаться.
          // 5. Коды авторизации/протокола (1002, 1003, 1007, 1008, 1009, 1011) - обычно фатальные ошибки, не переподключаемся автоматически.

          const fatalCloseCodes = [1002, 1003, 1007, 1008, 1009, 1011]; // Коды ошибок, которые считаем фатальными

          if (event.wasClean && event.code === 1000) {
             widgetLog(`Clean WebSocket close (${event.code}), not attempting reconnect.`, 'info');
             // Обновляем статус UI
             if (isWidgetOpen) {
                updateConnectionStatus('disconnected', 'Соединение завершено');
                showMessage("Соединение завершено.", 5000);
             } else {
                 // Если виджет закрыт, добавляем пульсацию на кнопку (если не было постоянной ошибки)
                 if (widgetButton && !connectionFailedPermanently) {
                     widgetButton.classList.add('wellcomeai-pulse-animation');
                 }
                 updateConnectionStatus('disconnected', 'Отключено'); // Внутреннее обновление статуса
             }
             // Если это было чистое закрытие и мы не в процессе переподключения, сбрасываем флаг
             if (!isReconnecting) {
                reconnectAttempts = 0; // Сброс попыток после успешного завершения диалога? Или только при успешном подключении?
                connectionFailedPermanently = false;
             }
             return;
          }

           // Проверяем фатальные коды ошибок, независимо от wasClean
           if (fatalCloseCodes.includes(event.code)) {
               widgetLog(`WebSocket closed with fatal error code ${event.code}. Not attempting reconnect.`, 'error');
               isReconnecting = false;
               connectionFailedPermanently = true; // Считаем это невосстановимой ошибкой

               if (isWidgetOpen) {
                  showConnectionError(`Ошибка соединения: ${event.reason || 'Неизвестная ошибка'}. Пожалуйста, попробуйте позже.`);
                  updateConnectionStatus('disconnected', 'Ошибка');
                  hideMessage();
               } else {
                   if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                   updateConnectionStatus('disconnected', 'Ошибка');
               }
               return; // Выходим, не запуская reconnectWithDelay
           }


          // Если закрытие не чистое (wasClean=false) и код не фатальный, или код 1006 (без wasClean), пытаемся переподключиться
          // Также проверяем, что мы еще не достигли лимита попыток.
          // isReconnecting уже должен быть true, если reconnectWithDelay был вызван ранее.
          // Если onclose вызывается первым, устанавливаем isReconnecting.
          if (!connectionFailedPermanently) { // Если не было постоянной ошибки
             if (!isReconnecting) { // Если еще не начали процесс переподключения
                 isReconnecting = true;
                 widgetLog("Unclean WebSocket close, starting reconnect process.", 'info');
                 reconnectWithDelay(); // Запустит первую попытку немедленно или с initialDelay
             } else {
                 widgetLog("Unclean WebSocket close, already in reconnect process. Awaiting next attempt.", 'debug');
                 // reconnectWithDelay уже запущен, ничего не делаем
             }
          } else {
             widgetLog("Unclean WebSocket close, but connectionFailedPermanently is true. Not attempting reconnect.", 'debug');
              // Обновляем статус UI, если открыт
             if (isWidgetOpen) {
                updateConnectionStatus('disconnected', 'Отключено');
                // Ошибка уже показана в случае permanent error
                // showConnectionError("Не удалось подключиться к серверу. Попробуйте перезагрузить страницу.");
             } else {
                 if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                  updateConnectionStatus('disconnected', 'Отключено');
             }
          }
        };

        websocket.onerror = function(error) {
          widgetLog(`WebSocket error occurred:`, "error", error);
          // Ошибка обычно предшествует onclose, который и обработает переподключение и UI.
          // Обновляем состояние на всякий случай.
          isConnected = false;
          // Останавливаем все аудио процессы
          stopAllAudioProcessing();

          // Если ошибка произошла до onopen (в состоянии CONNECTING), отменяем таймаут
          if (connectionTimeout) {
             clearTimeout(connectionTimeout);
             connectionTimeout = null;
          }

          // Скрываем модальное окно загрузки
           if (loaderModal) loaderModal.classList.remove('active');


          // onerror не всегда предоставляет детальную информацию о причине (коде).
          // Полагаемся на onclose для определения, нужна ли попытка переподключения.
          // Если onerror происходит, onclose будет вызван вскоре после этого.
          // Поэтому явный вызов reconnectWithDelay здесь может привести к дублированию.
          // Просто обновляем UI статус.

          if (isWidgetOpen) {
            // onclose, вызванный после ошибки, покажет showConnectionError при необходимости
            updateConnectionStatus('disconnected', 'Ошибка соединения');
            // showMessage("Ошибка соединения с сервером", 5000); // onclose покажет более подробное сообщение об ошибке
          } else {
             updateConnectionStatus('disconnected', 'Ошибка соединения'); // Внутреннее обновление статуса
          }

        };

        return true; // Успешно создан объект WebSocket, ожидаем onopen
      } catch (error) {
        widgetLog(`Fatal error creating WebSocket instance: ${error.message}`, 'error', error);
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
    }

    // Добавляем обработчики событий для интерфейса
    widgetButton.addEventListener('click', function(e) {
      widgetLog('Widget button clicked', 'info');
      e.preventDefault();
      e.stopPropagation(); // Останавливаем всплытие события, чтобы не влиять на другие элементы страницы
      openWidget(); // Асинхронная функция
    });

    widgetClose.addEventListener('click', function(e) {
      widgetLog('Widget close button clicked', 'info');
      e.preventDefault();
      e.stopPropagation(); // Останавливаем всплытие
      closeWidget(); // Остановит аудио и закроет UI
    });

    // Обработчик для основного круга (для запуска/остановки прослушивания вручную)
    mainCircle.addEventListener('click', function() {
      widgetLog(`Main circle clicked. State: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isConnected=${isConnected}, permanentError=${connectionFailedPermanently}`, 'info');

      // Если виджет не открыт, клик по кругу ничего не делает (клик должен быть по кнопке)
      if (!isWidgetOpen) {
          widgetLog("Circle clicked, but widget is closed. Ignoring.", 'debug');
          return;
      }

      // **************** Внесение изменений для iOS активации по клику на круг ****************
      // На iOS, клик на круг может помочь активировать AudioContext и микрофон
      // Пытаемся активировать контекст при каждом клике на круг на iOS, если он еще не running
      if (isIOS && (!tempAudioContext || tempAudioContext.state !== 'running' || !audioContextInitialized)) {
           widgetLog("iOS device, attempting AudioContext unlock via circle click.", 'info');
           unlockAudioContextOnIOS().then(contextUnlocked => {
               if (contextUnlocked) {
                   widgetLog('AudioContext activated via circle click on iOS.', 'info');
                   if (iosAudioButton) iosAudioButton.classList.remove('visible'); // Скрываем кнопку
                   hideMessage(); // Скрываем сообщение "Нажмите кнопку..."
                   // После успешной активации контекста, продолжаем логику запуска/остановки прослушивания
                   handleCircleClickLogic();
               } else {
                   widgetLog('Failed to activate AudioContext via circle click on iOS.', 'error');
                    // Если не удалось активировать, убедимся, что кнопка iOS видна
                   if (iosAudioButton && isWidgetOpen) iosAudioButton.classList.add('visible'); // Показываем только если виджет открыт
                   showMessage("Нажмите кнопку ниже для активации микрофона", 0);
               }
           }).catch(err => {
                widgetLog(`Error during unlockAudioContextOnIOS on circle click: ${err.message}`, 'error');
                 if (isIOS && iosAudioButton && isWidgetOpen) iosAudioButton.classList.add('visible');
                 showMessage("Нажмите кнопку ниже для активации микрофона", 0);
           });
      } else {
           // Для Android, Desktop, или если AudioContext уже активен на iOS - стандартная логика
           widgetLog("Non-iOS device or AudioContext already active. Proceeding with circle click logic.", 'debug');
           handleCircleClickLogic();
      }
    });

    // Вспомогательная функция для логики клика по кругу (после потенциальной активации на iOS)
    function handleCircleClickLogic() {
         // Проверяем наличие постоянной ошибки соединения
         if (connectionFailedPermanently) {
              widgetLog("Circle clicked, but connection failed permanently. Showing error.", 'info');
              showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
              updateConnectionStatus('disconnected', 'Отключено');
              return; // Выходим
         }

          // Если идет воспроизведение, клик по кругу останавливает воспроизведение и запись
          if (isPlayingAudio) {
              widgetLog("Circle clicked while playing audio. Stopping audio and listening.", 'info');
               // Очищаем очередь воспроизведения
              audioPlaybackQueue = []; // Это остановит playNextAudio после текущего фрагмента
              // isPlayingAudio = false; // Флаг сбросится в playNextAudio когда очередь опустеет
              if (mainCircle) mainCircle.classList.remove('speaking');
              stopListening(); // Останавливаем логику записи и отправку коммита
              hideMessage(); // Скрываем сообщение

               // Теперь пытаемся начать слушать, если соединение активно
               if (isConnected && !isReconnecting) {
                    widgetLog("Audio stopped manually, attempting to restart listening after circle click.", 'info');
                     // Небольшая задержка перед стартом
                    setTimeout(() => {
                      // Проверяем состояние снова перед стартом
                      if (isWidgetOpen && !isPlayingAudio && !isListening && isConnected && !isReconnecting) {
                           widgetLog("Attempting auto-start listening after manual stop.", 'info');
                           startListening(); // Эта функция сама проверит состояние аудио
                      } else {
                         widgetLog(`Skipping auto-start listening after manual stop: isWidgetOpen=${isWidgetOpen}, isPlayingAudio=${isPlayingAudio}, isListening=${isListening}, isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
                      }
                    }, isMobile ? 800 : 500);
               } else if (!isConnected && !isReconnecting) {
                   widgetLog("Audio stopped manually, attempting to connect/reconnect.", 'info');
                   connectWebSocket(); // connectWebSocket сам запустит прослушивание в onopen
               } else {
                   widgetLog(`Audio stopped manually, but connection state prevents restart: isConnected=${isConnected}, isReconnecting=${isReconnecting}`, 'debug');
               }


          } else if (isListening) {
             // Если идет прослушивание, клик по кругу останавливает прослушивание
             widgetLog("Circle clicked while listening. Stopping listening.", 'info');
             stopListening(); // Останавливает запись и отправляет commit
              // Состояние UI уже обновлено в stopListening
          } else {
             // Если не слушаем и не говорим (idle state), клик по кругу запускает прослушивание
             widgetLog("Circle clicked while idle. Attempting to start listening.", 'info');
             // Проверяем соединение и статус переподключения
             if (isConnected && !isReconnecting) {
                 startListening(); // Эта функция сама проверит состояние аудио и iOS активацию
             } else if (!isConnected && !isReconnecting) {
                 // Если нет соединения и нет permanent error, пытаемся подключиться
                 widgetLog("Circle clicked while not connected, attempting connection.", 'info');
                 connectWebSocket(); // connectWebSocket сам запустит прослушивание в onopen
             } else if (isReconnecting) {
                  widgetLog("Circle clicked while reconnecting. Waiting for connection...", 'info');
                  updateConnectionStatus('connecting', 'Переподключение...');
                  showMessage("Переподключение...", 0); // Показать/обновить сообщение
             }
          }
    }


    // Обработчик для iOS кнопки активации аудио
    if (isIOS && iosAudioButton) {
      iosAudioButton.addEventListener('click', function() {
        widgetLog('iOS Audio Activation button clicked', 'info');
        // При клике на эту кнопку пытаемся активировать AudioContext
        unlockAudioContextOnIOS().then(success => {
          if (success) {
            widgetLog('Audio context successfully activated via iOS button click.', 'info');
            iosAudioButton.classList.remove('visible'); // Скрываем кнопку
            hideMessage(); // Скрываем сообщение "Нажмите кнопку..."
            // Теперь, когда аудио активировано, пытаемся начать слушать (если виджет открыт и idle)
            setTimeout(() => {
              if (isWidgetOpen && isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
                widgetLog("iOS button clicked, audio activated, attempting to start listening.", 'info');
                startListening(); // Эта функция сама проверит готовность аудио
              } else {
                   widgetLog(`Skipping auto-start listening after iOS button activation: isWidgetOpen=${isWidgetOpen}, isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`, 'debug');
              }
            }, 500); // Небольшая задержка перед стартом прослушивания
          } else {
            widgetLog('Failed to activate AudioContext via iOS button click.', 'error');
            // Если не удалось активировать, возможно, нужно показать ошибку или оставить кнопку видимой
             showMessage("Не удалось активировать микрофон/звук. Пожалуйста, попробуйте снова.", 5000);
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
    // Эта функция будет вызвана сразу при загрузке скрипта
    widgetLog('Initial WebSocket connection attempt.', 'info');
    // Проверяем конфигурацию перед попыткой подключения
     if (ASSISTANT_ID && WS_URL) {
        connectWebSocket();
     } else {
        widgetLog('WebSocket connection skipped due to missing configuration.', 'error');
         if (loaderModal) loaderModal.classList.remove('active');
          connectionFailedPermanently = true; // Считаем это фатальной ошибкой на старте
         if (isWidgetOpen) { // Показываем ошибку, если виджет открыт (что маловероятно на этом этапе)
            showConnectionError("Виджет сконфигурирован неправильно. Отсутствует ID ассистента или адрес сервера.");
            updateConnectionStatus('disconnected', 'Ошибка конфигурации');
         } else {
             updateConnectionStatus('disconnected', 'Ошибка конфигурации'); // Внутреннее обновление статуса
         }
     }


    // Проверка DOM и состояния после инициализации (для отладки)
    setTimeout(function() {
      widgetLog('--- Initial DOM & State Check ---', 'debug');

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


      widgetLog(`Container found: ${!!container}, z-index: ${container ? getComputedStyle(container).zIndex : 'N/A'}`, 'debug');
      widgetLog(`Button found: ${!!btn}, display: ${btn ? getComputedStyle(btn).display : 'N/A'}, pulse: ${btn ? btn.classList.contains('wellcomeai-pulse-animation') : 'N/A'}`, 'debug');
      widgetLog(`Expanded found: ${!!expanded}, visible (CSS): ${expanded ? (getComputedStyle(expanded).opacity > 0 && getComputedStyle(expanded).height !== '0px' && getComputedStyle(expanded).visibility !== 'hidden') : 'N/A'}`, 'debug');
      widgetLog(`Loader Modal found: ${!!modal}, active: ${modal ? modal.classList.contains('active') : 'N/A'}`, 'debug');
      widgetLog(`Message Display found: ${!!msg}, show: ${msg ? msg.classList.contains('show') : 'N/A'}`, 'debug');
      widgetLog(`Connection Error found: ${!!err}, visible: ${err ? err.classList.contains('visible') : 'N/A'}`, 'debug');
      widgetLog(`Status Indicator found: ${!!stat}, show: ${stat ? stat.classList.contains('show') : 'N/A'}`, 'debug');
      if (isIOS && iosBtn) { // Проверяем existence iosBtn
         widgetLog(`iOS Button found: ${!!iosBtn}, visible: ${iosBtn.classList.contains('visible')}`, 'debug');
      } else if (isIOS && !iosBtn) {
          widgetLog('iOS device but iOS button element not found!', 'error');
      } else {
           widgetLog('Not iOS device.', 'debug');
      }

       widgetLog(`Main Circle found: ${!!circle}, listening: ${circle ? circle.classList.contains('listening') : 'N/A'}, speaking: ${circle ? circle.classList.contains('speaking') : 'N/A'}`, 'debug');
       widgetLog(`Audio Bars found: ${!!bars}`, 'debug');

      widgetLog(`Widget Configuration: ASSISTANT_ID=${ASSISTANT_ID}, WS_URL=${WS_URL}`, 'debug');
      widgetLog(`Connection state: WS = ${websocket ? websocket.readyState : 'null'}, isConnected = ${isConnected}, isReconnecting = ${isReconnecting}, permanentError = ${connectionFailedPermanently}`, 'debug');
      widgetLog(`Widget state: isWidgetOpen = ${isWidgetOpen}, isListening = ${isListening}, isPlayingAudio = ${isPlayingAudio}`, 'debug');
      widgetLog(`Audio state: audioContextInitialized = ${audioContextInitialized}, tempAudioContext = ${tempAudioContext ? tempAudioContext.state : 'null'}, hasPlayedSilence = ${hasPlayedSilence}`, 'debug');
       if (mediaStream) {
          widgetLog(`MediaStream: active = ${mediaStream.active}, tracks = ${mediaStream.getTracks().length}`, 'debug');
       } else {
          widgetLog("MediaStream is null.", 'debug');
       }
       widgetLog(`Audio Queue size: ${audioPlaybackQueue.length}, Audio Buffer size: ${audioChunksBuffer.length}`, 'debug');

      widgetLog('--- End of initial check ---', 'debug');

    }, 2000); // Задержка, чтобы DOM полностью отрисовался
  }

  // Инициализируем виджет при загрузке DOM
  function initializeWidget() {
    widgetLog('Initializing WellcomeAI Widget lifecycle...', 'info');

    // Проверяем, есть ли уже виджет на странице
    if (!document.getElementById('wellcomeai-widget-container')) {
        widgetLog('Widget container not found, proceeding with full initialization.', 'info');
        // Загружаем необходимые стили и скрипты
        loadFontAwesome();
        createStyles(); // Создает стилы
        createWidgetHTML(); // Создает HTML
        // Инициализируем основную логику виджета только после создания DOM
        // Используем setTimeout с 0 задержкой, чтобы убедиться, что все DOM элементы действительно добавлены браузером
        // и доступны по getElementById.
        setTimeout(initWidget, 0);
        widgetLog('WellcomeAI Widget initialization triggered.', 'info');
    } else {
        widgetLog('Widget container already exists on the page (#wellcomeai-widget-container), skipping initialization.', 'info');
    }
  }


  // Запускаем инициализацию, когда DOM полностью загружен
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWidget);
    widgetLog('Waiting for DOMContentLoaded before initializing widget.', 'info');
  } else {
    widgetLog('DOM already loaded, initializing widget immediately.', 'info');
    initializeWidget();
  }

})();
