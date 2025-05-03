```javascript
/**
 * WellcomeAI Widget Loader Script
 * Версия: 1.3.0 (Modified for One-Click Open & Listen)
 *
 * Этот скрипт динамически создает и встраивает виджет голосового ассистента
 * на любой сайт, в том числе на Tilda и другие конструкторы сайтов.
 * Улучшена поддержка мобильных устройств и iOS.
 *
 * В этой версии клик по кнопке виджета (для открытия) также инициирует
 * активацию микрофона и начало прослушивания для максимально бесшовного UX.
 */

(function() {
  // Настройки виджета
  const DEBUG_MODE = false; // Отключаем режим отладки в продакшене
  const MAX_RECONNECT_ATTEMPTS = 7; // Максимальное количество попыток переподключения
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 15; // Увеличенное количество попыток для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (в миллисекундах)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 25000; // Таймаут для установления соединения (в миллисекундах)
  const MAX_DEBUG_ITEMS = 20; // Максимальное количество записей отладки (для отладочной панели, если есть)

  // Глобальное хранение состояния
  let reconnectAttempts = 0;
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = []; // Используется только при DEBUG_MODE
  
  // Определяем тип устройства
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|Pod/i.test(navigator.userAgent); // Уточнено для iPod

  // Глобальные флаги для мобильных устройств (менее критичны теперь, но оставлены для совместимости)
  // window.audioContextInitialized = false; // Больше не используем глобально
  // window.tempAudioContext = null; // Больше не используем глобально
  // window.hasPlayedSilence = false; // Больше не используем глобально

  // Состояние аудио и соединения
  let websocket = null;
  let audioContext = null;
  let mediaStream = null;
  let audioProcessor = null; // Используем устаревший ScriptProcessorNode для широкой совместимости
  let isConnected = false;
  let isWidgetOpen = false;
  let connectionFailedPermanently = false;
  let isListening = false; // Флаг для управления записью с микрофона
  let isPlayingAudio = false; // Флаг для управления воспроизведением ответа
  let audioChunksBuffer = []; // Буфер для сборки аудио ответа от сервера
  let audioPlaybackQueue = []; // Очередь аудиофрагментов для воспроизведения
  
  // Переменные для логики детектирования тишины
  let isSilent = true;
  let silenceStartTime = Date.now();
  let lastCommitTime = 0;
  let hasSentAudioInCurrentSegment = false;
  let audioDataStartTime = 0;
  let minimumAudioLength = isMobile ? 400 : 300; // Минимальная длительность аудио для отправки (мс)
    
  // Конфигурация для оптимизации потока аудио - разные настройки для десктопа и мобильных
  const AUDIO_PROCESSING_CONFIG = {
    silenceThreshold: isMobile ? 0.015 : 0.01,      // Порог для определения тишины (амплитуда)
    silenceDuration: isMobile ? 600 : 400,         // Длительность тишины для "финализации" речи (мс)
    bufferCheckInterval: isMobile ? 100 : 50,     // Частота проверки буфера в onaudioprocess (виртуально)
    soundDetectionThreshold: isMobile ? 0.015 : 0.02 // Чувствительность к звуку для активации прослушивания
  };

  // Функция для логирования состояния виджета
  const widgetLog = (message, type = 'info') => {
    const logPrefix = '[WellcomeAI Widget]';
    const timestamp = new Date().toISOString().slice(11, 23);
    const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
    
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      // Специальное форматирование для логов Render
      console.log(`${logPrefix} ${formattedMessage}`);
    } else if (DEBUG_MODE || type === 'error' || type === 'warn') {
      // Логирование в браузере при DEBUG_MODE или для ошибок/предупреждений
      if (type === 'error') {
        console.error(`${logPrefix} ERROR: ${message}`);
      } else if (type === 'warn') {
        console.warn(`${logPrefix} WARNING: ${message}`);
      } else if (DEBUG_MODE) {
        console.log(`${logPrefix} INFO: ${message}`);
      }
    }
    // Опционально: добавить в отладочную очередь, если DEBUG_MODE включен
    if (DEBUG_MODE) {
       addToDebugQueue(message, type);
    }
  };

  // Функция для отслеживания ошибок (упрощена без отладочной панели UI)
  const addToDebugQueue = (message, type = 'info') => {
    if (!DEBUG_MODE) return;
    
    const timestamp = new Date().toISOString();
    debugQueue.push({ timestamp, message, type });
    
    if (debugQueue.length > MAX_DEBUG_ITEMS) {
      debugQueue.shift(); // Удаляем старые записи
    }
    // В реальной отладочной панели здесь бы вызывалась updateDebugPanel();
  };

  // Получить отладочную информацию в виде строки (для консоли при необходимости)
  const getDebugInfo = () => {
    if (!DEBUG_MODE) return "Debug mode is not enabled.";
    return debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

   // Обновление отладочной панели (стабы, т.к. UI панели нет в этом коде)
  const updateDebugPanel = () => { /* Logic for updating a debug UI panel */ };


  // Функция для определения URL сервера
  const getServerUrl = () => {
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;
    const widgetScriptName = 'widget.js'; // Или другое уникальное имя файла скрипта

    for (let i = 0; i < scriptTags.length; i++) {
        // Проверяем data-server атрибут
        if (scriptTags[i].hasAttribute('data-server') && scriptTags[i].getAttribute('data-server')) {
            serverUrl = scriptTags[i].getAttribute('data-server');
            widgetLog(`Found server URL from data-server attribute: ${serverUrl}`);
            break;
        }
        if (scriptTags[i].dataset && scriptTags[i].dataset.server) {
             serverUrl = scriptTags[i].dataset.server;
             widgetLog(`Found server URL from dataset.server: ${serverUrl}`);
             break;
        }

        // Если не нашли data-server, ищем скрипт виджета по имени файла
        const src = scriptTags[i].getAttribute('src');
        if (src && src.includes(widgetScriptName)) {
            try {
                // Используем URL API для корректного построения абсолютного URL из src
                const url = new URL(src, window.location.href);
                serverUrl = url.origin; // Получаем origin (протокол + домен + порт)
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

    // Проверяем, содержит ли URL протокол. Если нет, добавляем протокол текущей страницы.
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) {
        serverUrl = window.location.protocol + '//' + serverUrl;
        widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }

    // Если не нашли URL нигде, используем запасной
    if (!serverUrl) {
        serverUrl = 'https://realtime-saas.onrender.com'; // Замените на ваш актуальный запасной URL
        widgetLog(`Using fallback server URL: ${serverUrl}`);
    }

    // Убираем конечный слеш, если есть, для стандартизации
    return serverUrl.replace(/\/$/, '');
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    // 1. Проверяем наличие атрибута data-assistantId в скрипте
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      // Проверяем оба варианта написания - с большой и маленькой буквой I
      if (scriptTags[i].hasAttribute('data-assistantId')) {
        const id = scriptTags[i].getAttribute('data-assistantId');
        widgetLog(`Found assistant ID from data-assistantId attribute: ${id}`);
        return id;
      }
       if (scriptTags[i].dataset && scriptTags[i].dataset.assistantId) {
        const id = scriptTags[i].dataset.assistantId;
        widgetLog(`Found assistant ID from dataset.assistantId: ${id}`);
        return id;
      }
       // Для обратной совместимости с lowercase assistantid (менее предпочтительно)
       if (scriptTags[i].hasAttribute('data-assistantid')) {
        const id = scriptTags[i].getAttribute('data-assistantid');
        widgetLog(`Found assistant ID from data-assistantid attribute (lowercase): ${id}`);
        return id;
       }
       if (scriptTags[i].dataset && scriptTags[i].dataset.assistantid) {
        const id = scriptTags[i].dataset.assistantid;
        widgetLog(`Found assistant ID from dataset.assistantid (lowercase): ${id}`);
        return id;
       }
    }
    
    // 2. Пробуем получить ID из URL-параметра (для целей тестирования/демо)
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) {
      widgetLog(`Found assistant ID in URL param: ${idFromUrl}`);
      return idFromUrl;
    }
    
    // 3. Проверяем наличие глобальной переменной (менее предпочтительно для продакшена)
    if (typeof window.wellcomeAIAssistantId !== 'undefined') {
      widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`);
      return window.wellcomeAIAssistantId;
    }
    
    // 4. Если используем страницу демонстрации, можно вернуть демо-идентификатор
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo'; // Замените на ваш актуальный демо-ID
    }

    widgetLog('No assistant ID found! Please add data-assistantId attribute to the script tag.', 'error');
    return null; // Возвращаем null, если ID не найден
  };

  // Получение позиции виджета
  const getWidgetPosition = () => {
    const defaultPosition = {
      vertical: 'bottom',
      horizontal: 'right',
      distance: '20px'
    };

    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      let positionString = null;
      if (scriptTags[i].hasAttribute('data-position')) {
        positionString = scriptTags[i].getAttribute('data-position');
      } else if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
        positionString = scriptTags[i].dataset.position;
      }

      if (positionString) {
        widgetLog(`Found widget position from attribute: ${positionString}`);
        const position = { ...defaultPosition };
        const parts = positionString.toLowerCase().split('-'); // Приводим к нижнему регистру для парсинга
        
        if (parts.length === 2) {
            if (parts[0] === 'top' || parts[0] === 'bottom') {
                position.vertical = parts[0];
                position.horizontal = parts[1];
            } else if (parts[1] === 'top' || parts[1] === 'bottom') {
                 position.vertical = parts[1];
                 position.horizontal = parts[0];
            }
             // Проверяем наличие третьего элемента, который может быть расстоянием
            if (parts[2]) {
                 // Простая проверка на PX или %
                 if (parts[2].endsWith('px') || parts[2].endsWith('%')) {
                     position.distance = parts[2];
                 } else {
                     widgetLog(`Invalid distance format in data-position: ${parts[2]}. Using default distance.`, 'warn');
                 }
            }
            widgetLog(`Parsed position: ${position.vertical}-${position.horizontal} at ${position.distance}`);
            return position;
        } else if (parts.length === 3) {
             if ((parts[0] === 'top' || parts[0] === 'bottom') && (parts[1] === 'left' || parts[1] === 'right')) {
                position.vertical = parts[0];
                position.horizontal = parts[1];
                if (parts[2].endsWith('px') || parts[2].endsWith('%')) {
                    position.distance = parts[2];
                } else {
                    widgetLog(`Invalid distance format in data-position: ${parts[2]}. Using default distance.`, 'warn');
                }
                widgetLog(`Parsed position: ${position.vertical}-${position.horizontal} at ${position.distance}`);
                return position;
             }
        }
         widgetLog(`Invalid data-position format: ${positionString}. Using default position.`, 'warn');
         return defaultPosition;
      }
    }

    widgetLog(`No data-position attribute found. Using default position: ${defaultPosition.vertical}-${defaultPosition.horizontal} at ${defaultPosition.distance}`);
    return defaultPosition;
  };


  // Определяем URL сервера и ID ассистента при загрузке скрипта
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  
  // Формируем WebSocket URL с указанием ID ассистента
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + (ASSISTANT_ID ? '/ws/' + ASSISTANT_ID : '/ws'); // Добавляем ID только если он есть
  
  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID || 'Not Found'}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal} distance ${WIDGET_POSITION.distance}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);
  if (!ASSISTANT_ID) {
       widgetLog("Widget will not function without Assistant ID.", 'error');
  }


  // Создаем стили для виджета
  function createStyles() {
    if (document.getElementById('wellcomeai-widget-styles')) {
        widgetLog("Styles already exist, skipping creation.", 'warn');
        return; // Избегаем дублирования стилей
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
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
        box-sizing: border-box; /* Учитываем padding и border в размерах */
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
        padding: 0; /* Убираем внутренние отступы кнопки */
      }
       /* Уменьшаем размер кнопки на мобильных */
      ${isMobile ? `
        .wellcomeai-widget-button {
            width: 50px;
            height: 50px;
        }
         .wellcomeai-widget-icon {
             font-size: 20px !important; /* Уменьшаем размер иконки */
         }
      ` : ''}
      
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
        max-width: calc(100vw - ${WIDGET_POSITION.distance} * 2); /* Ограничение по ширине на мобильных */
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
       /* Уменьшаем размер развернутого виджета на мобильных */
      ${isMobile ? `
         .wellcomeai-widget-expanded {
            width: calc(100vw - ${WIDGET_POSITION.distance} * 2); /* Ширина почти на весь экран */
            height: 350px; /* Немного меньше высота */
         }
          .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
            height: 350px;
          }
           .wellcomeai-main-circle {
                width: 150px !important;
                height: 150px !important;
           }
            .wellcomeai-mic-icon {
                font-size: 28px !important;
            }
             .wellcomeai-audio-visualization {
                max-width: 130px !important;
             }
      ` : ''}

      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 400px; /* Стандартная высота для десктопа */
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
         padding: 0; /* Убираем внутренние отступы кнопки */
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
        box-sizing: border-box;
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
         cursor: pointer; /* Добавляем курсор */
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

      .wellcomeai-main-circle.inactive .wellcomeai-mic-icon {
         color: #64748b; /* Серый цвет для неактивного состояния */
      }
      
      .wellcomeai-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px;
        bottom: -5px;
        opacity: 0.8;
        pointer-events: none;
        display: flex; /* Добавляем flexbox */
        align-items: flex-end; /* Выравниваем полосы по низу */
        justify-content: center; /* Центрируем полосы */
      }
      
      .wellcomeai-audio-bars {
        display: flex;
        align-items: flex-end;
        height: 30px;
        gap: 2px;
        width: 100%; /* Растягиваем на всю ширину контейнера */
        justify-content: center;
      }
      
      .wellcomeai-audio-bar {
        width: 3px;
        height: 2px;
        background-color: #4a86e8;
        border-radius: 1px;
        transition: height 0.1s ease;
      }
       /* Цвет баров меняется в зависимости от состояния круга */
       .wellcomeai-main-circle.listening .wellcomeai-audio-bar {
           background-color: #2196f3;
       }
       .wellcomeai-main-circle.speaking .wellcomeai-audio-bar {
           background-color: #4caf50;
       }
       .wellcomeai-main-circle.inactive .wellcomeai-audio-bar {
           background-color: #64748b;
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
        z-index: 2147483646; /* Z-index ниже виджета, но выше контента */
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s;
        border-radius: 20px;
         pointer-events: none; /* Не блокируем события по умолчанию */
      }
       .wellcomeai-loader-modal.active {
         opacity: 1;
         visibility: visible;
         pointer-events: all; /* Блокируем события, когда активен */
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
         pointer-events: none; /* Не блокируем события по умолчанию */
      }
      
      .wellcomeai-message-display.show {
        opacity: 1;
         pointer-events: all; /* Блокируем события, когда показано */
      }

      .wellcomeai-error-message {
        color: #ef4444;
        background-color: rgba(254, 226, 226, 0.8);
        border: 1px solid #ef4444;
        padding: 10px 15px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        margin-top: 15px;
        text-align: center;
        display: none;
        max-width: 90%;
        box-sizing: border-box;
      }
      
      .wellcomeai-error-message.visible {
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
        bottom: 10px; /* Отступ от низа */
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
        visibility: hidden;
        transition: opacity 0.3s, visibility 0.3s;
        pointer-events: none;
        z-index: 15; /* Выше сообщения, но ниже лоадера */
      }
      
      .wellcomeai-status-indicator.show {
        opacity: 0.8;
        visibility: visible;
      }
      
      .wellcomeai-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #10b981; /* Connected */
      }
      
      .wellcomeai-status-dot.disconnected {
        background-color: #ef4444;
      }
      
      .wellcomeai-status-dot.connecting {
        background-color: #f59e0b;
      }
      
      /* Пульсация кнопки при неактивном соединении, когда виджет закрыт */
      @keyframes wellcomeai-button-pulse {
        0% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0.7); }
        70% { box-shadow: 0 0 0 15px rgba(74, 134, 232, 0); } /* Увеличен радиус пульсации */
        100% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0); }
      }
      
      .wellcomeai-pulse-animation {
        animation: wellcomeai-button-pulse 2s infinite;
      }
      
      /* Скрываем кнопку принудительной активации аудио для iOS, она больше не нужна */
      .wellcomeai-ios-audio-button {
          display: none !important;
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
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'; // Используем v6.4.0
      link.integrity = 'sha512-iecdLmaskl7CVkqkXNQ/ZH/XLlvWZOJyj7t7avw veinteBwSfjf+HniYPcbOQNA/oEydLTJop0K9Nvyn+6y9+I2msFZtf+o'; // Добавляем integrity
      link.crossOrigin = 'anonymous'; // Добавляем crossorigin
      document.head.appendChild(link);
      widgetLog("Font Awesome loaded");
    }
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
    if (document.getElementById('wellcomeai-widget-container')) {
         widgetLog("Widget HTML already exists, skipping creation.", 'warn');
         return; // Избегаем дублирования HTML
    }
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647"; // Убедимся, что z-index установлен

    let widgetHTML = `
      <!-- Кнопка (минимизированное состояние) -->
      <button class="wellcomeai-widget-button" id="wellcomeai-widget-button" aria-label="Open WellcomeAI Widget">
        <i class="fas fa-robot wellcomeai-widget-icon"></i>
      </button>
      
      <!-- Развернутый виджет -->
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">WellcomeAI</div>
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close" aria-label="Close WellcomeAI Widget">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <!-- Основной элемент - круг с иконкой микрофона -->
          <div class="wellcomeai-main-circle inactive" id="wellcomeai-main-circle">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>
            
            <!-- Аудио визуализация -->
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>
          
           <!-- Сообщение (статус, инструкции, ошибки) -->
          <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>

           <!-- Сообщение об ошибке микрофона/аудио или соединения -->
          <div class="wellcomeai-error-message" id="wellcomeai-error-message">
            Произошла ошибка.
            <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
              Повторить
            </button>
          </div>
          
          <!-- Индикатор статуса соединения -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text"></span>
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

    // Инициализация микрофона и AudioContext (создание графа)
    async function setupAudioGraph() {
      try {
        if (audioContext && audioProcessor && mediaStream) {
           widgetLog("Audio graph already setup.");
           return true; // Уже инициализировано
        }

        widgetLog("Setting up audio graph...");

        // Проверяем поддержку getUserMedia
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону (getUserMedia)");
        }
        // Проверяем поддержку AudioContext
         if (!window.AudioContext && !window.webkitAudioContext) {
             throw new Error("Ваш браузер не поддерживает Web Audio API (AudioContext)");
         }

        // Получаем поток с микрофона. Разрешение на использование будет запрошено позже,
        // при первом вызове getUserMedia внутри обработчика пользовательского жеста.
         // На этом этапе мы только проверяем наличие API и пытаемся получить ссылку на поток.
         // Активация и запрос разрешения произойдет при первом вызове в ensureAudio...
        mediaStream = await navigator.mediaDevices.getUserMedia({
             audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                 // Устанавливаем оптимальную частоту дискретизации, если поддерживается
                sampleRate: isMobile ? 16000 : 24000 // 16kHz для мобильных, 24kHz для десктопа
             }
        });
        widgetLog(`Media stream obtained from microphone.`);

        // Создаем AudioContext. Для iOS используем временный, если он уже был создан кликом
        // иначе создаем новый с подходящей частотой.
        const contextOptions = {
             sampleRate: isMobile ? 16000 : 24000
        };

        audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);

        widgetLog(`AudioContext created with sample rate: ${audioContext.sampleRate} Hz`);

        // Используем устаревший ScriptProcessorNode для широкой совместимости
        const bufferSize = isMobile ? 1024 : 2048; // Оптимальные размеры буфера
         if (audioContext.createScriptProcessor) {
             audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
             widgetLog(`Created ScriptProcessorNode with buffer size ${bufferSize}`);
         } else if (audioContext.createJavaScriptNode) { // Для старых версий Safari
             audioProcessor = audioContext.createJavaScriptNode(bufferSize, 1, 1);
             widgetLog(`Created deprecated JavaScriptNode with buffer size ${bufferSize}`);
         } else {
             throw new Error("Ваш браузер не поддерживает обработку аудио через ScriptProcessorNode/JavaScriptNode.");
         }


        // Подключаем обработчик onaudioprocess
        audioProcessor.onaudioprocess = function(e) {
            // Этот обработчик вызывается постоянно, но отправляем данные только если isListening = true
            if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
                resetAudioVisualization(); // Сбрасываем визуализацию, если не слушаем
                return;
            }

            const inputBuffer = e.inputBuffer;
            let inputData = inputBuffer.getChannelData(0);

            if (inputData.length === 0) return;

            // Вычисляем амплитуду для визуализации и детектирования тишины
            let maxAmplitude = 0;
            let sumAmplitude = 0;
            for (let i = 0; i < inputData.length; i++) {
                const absValue = Math.abs(inputData[i]);
                maxAmplitude = Math.max(maxAmplitude, absValue);
                sumAmplitude += absValue;
            }
             const avgAmplitude = sumAmplitude / inputData.length; // Средняя амплитуда (полезно для iOS)

            // Обновляем визуализацию
            updateAudioVisualization(inputData);

            // Преобразуем Float32Array в Int16Array
            const pcm16Data = new Int16Array(inputData.length);
             const multiplier = 32767; // Максимальное значение для Int16
             // Опциональная нормализация/усиление для тихого сигнала (экспериментально для iOS)
            const effectiveMultiplier = isIOS && maxAmplitude > 0 && maxAmplitude < 0.1 ? multiplier * Math.min(5, 0.3 / maxAmplitude) : multiplier;

            for (let i = 0; i < inputData.length; i++) {
                pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * effectiveMultiplier)));
            }

            // Отправляем данные через WebSocket
            try {
                const message = JSON.stringify({
                    type: "input_audio_buffer.append",
                    // event_id: `audio_${Date.now()}`, // Убрано, т.к. не используется сервером для этих сообщений
                    audio: arrayBufferToBase64(pcm16Data.buffer)
                });
                websocket.send(message);
                hasSentAudioInCurrentSegment = true;

                // Отмечаем наличие аудиоданных, если был звук
                if (!hasAudioData && maxAmplitude > AUDIO_PROCESSING_CONFIG.soundDetectionThreshold) {
                    hasAudioData = true;
                    audioDataStartTime = Date.now();
                    widgetLog("Начало записи аудиоданных (первый звук)");
                }

            } catch (error) {
                widgetLog(`Ошибка отправки аудио: ${error.message}`, "error");
                 // При ошибке отправки аудио можно попытаться остановить прослушивание
                 // stopListening(); // Или просто проигнорировать, зависит от желаемого поведения
            }

            // Логика определения тишины и автоматической отправки commit
            const now = Date.now();
            const currentAmplitude = isMobile ? avgAmplitude : maxAmplitude; // Используем среднюю для мобильных, макс для десктопа
            const silenceThreshold = isMobile ? AUDIO_PROCESSING_CONFIG.silenceThreshold * 0.8 : AUDIO_PROCESSING_CONFIG.silenceThreshold; // Чуть более строгий порог для детекции тишины

            if (currentAmplitude > silenceThreshold) {
                 // Есть звук, сбрасываем таймер тишины
                isSilent = false;
                silenceStartTime = now;
            } else {
                 // Тишина
                 if (!isSilent) { // Только что наступила тишина
                     const silenceDuration = now - silenceStartTime;

                     if (silenceDuration > AUDIO_PROCESSING_CONFIG.silenceDuration) {
                         isSilent = true;
                         widgetLog(`Тишина детектирована (${AUDIO_PROCESSING_CONFIG.silenceDuration} мс), отправляем commit, если есть данные.`);

                          // Если были отправлены аудиоданные в текущем сегменте
                         if (hasSentAudioInCurrentSegment) {
                             // Добавляем небольшую задержку перед отправкой commit для стабильности
                             const commitDelay = isMobile ? 200 : 100;
                             setTimeout(() => {
                                 // Проверяем снова, что все еще тихо и слушаем
                                 if (isSilent && isListening && !isReconnecting) {
                                     commitAudioBuffer();
                                     hasSentAudioInCurrentSegment = false; // Сбрасываем флаг после отправки
                                 }
                             }, commitDelay);
                         } else {
                              // Если тишина, но данные не отправлялись, просто сбрасываем состояние
                             hasAudioData = false;
                             audioDataStartTime = 0;
                         }
                     }
                 }
            }
        };

        // Подключаем поток с микрофона к процессору
        const streamSource = audioContext.createMediaStreamSource(mediaStream);
        streamSource.connect(audioProcessor);

        // Подключаем процессор к выходу аудиоконтекста (но с нулевой громкостью для предотвращения обратной связи)
         // Для iOS это особенно важно, но делаем так для всех платформ для унификации.
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0; // Установка громкости на ноль
        audioProcessor.connect(gainNode);
        gainNode.connect(audioContext.destination);

        widgetLog("Аудио граф инициализирован успешно.");
        return true;

      } catch (error) {
        widgetLog(`Ошибка настройки аудио графа: ${error.message}`, "error");
        // Здесь мы не показываем ошибку пользователю, т.к. это только setup.
        // Ошибки доступа к микрофону будут обработаны в ensureAudioInitializedAndReady.
        return false;
      }
    }

    // Функция для активации AudioContext и запроса микрофона
    // Должна быть вызвана в ответ на явный жест пользователя (например, клик по кнопке виджета).
    async function ensureAudioInitializedAndReady() {
        if (audioContext && audioContext.state === 'running' && mediaStream) {
            widgetLog("AudioContext и MediaStream уже активны.");
            return true; // Аудио уже готово
        }

        widgetLog("Ensuring AudioContext and MediaStream are ready (triggered by user gesture)...");

        try {
             // Если AudioContext еще не создан, создаем его.
             // Это важно сделать здесь, в обработчике жеста, чтобы обойти ограничения iOS.
            if (!audioContext) {
                const contextOptions = { sampleRate: isMobile ? 16000 : 24000 };
                audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
                widgetLog(`AudioContext created by user gesture with sample rate: ${audioContext.sampleRate} Hz`);
            }

            // Возобновляем AudioContext, если он приостановлен (часто бывает на мобильных)
            if (audioContext.state === 'suspended') {
                widgetLog("Attempting to resume AudioContext...");
                await audioContext.resume();
                widgetLog("AudioContext resumed successfully.");
            }

            // Запрашиваем доступ к микрофону, если еще не получили поток.
            // Этот вызов getUserMedia внутри обработчика жеста должен получить разрешение.
            if (!mediaStream) {
                 widgetLog("Requesting MediaStream from microphone...");
                 const audioConstraints = {
                     echoCancellation: true,
                     noiseSuppression: true,
                     autoGainControl: true,
                     sampleRate: isMobile ? 16000 : 24000
                 };
                 mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
                 widgetLog(`MediaStream obtained successfully.`);

                 // Если получили новый поток, настраиваем аудио граф
                 if (!audioProcessor) {
                     const success = await setupAudioGraph(); // setupAudioGraph теперь создает processor и подключает
                     if (!success) {
                         throw new Error("Failed to setup audio graph after getting stream.");
                     }
                 } else {
                      // Если процессор уже был, но поток новый, нужно переподключить источник
                     const streamSource = audioContext.createMediaStreamSource(mediaStream);
                     streamSource.connect(audioProcessor);
                     // Убедимся, что процессор подключен к выходу с нулевым гейном
                     const existingGainNode = audioContext.destination.__connected_gain_node; // Условное название, нужно найти узел
                     if (!existingGainNode || existingGainNode.gain.value !== 0) {
                         // Если нет или гейн не нулевой, создаем новый и переподключаем
                         const gainNode = audioContext.createGain();
                         gainNode.gain.value = 0;
                         audioProcessor.disconnect(); // Отключаем старое соединение, если было
                         audioProcessor.connect(gainNode);
                         gainNode.connect(audioContext.destination);
                         audioContext.destination.__connected_gain_node = gainNode; // Сохраняем ссылку
                         widgetLog("Reconnected audio processor to zero-gain node.");
                     } else {
                          audioProcessor.disconnect(); // Отключаем старое соединение с processor
                          streamSource.connect(audioProcessor); // Подключаем новый streamSource к processor
                          audioProcessor.connect(existingGainNode); // Подключаем processor к существующему нулевому gainNode
                          widgetLog("Reconnected new stream source to existing audio graph.");
                     }
                 }

            }

            widgetLog("Audio is ready (Context running and MediaStream obtained).");
            return true;

        } catch (error) {
            widgetLog(`Error ensuring audio is ready: ${error.name} - ${error.message}`, "error");
            // Ошибки getUserMedia (NotAllowedError, NotReadableError, AbortError, SecurityError)
            let userFacingMessage = "Ошибка микрофона: Не удалось получить доступ к микрофону.";
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                userFacingMessage = "Доступ к микрофону запрещен. Пожалуйста, разрешите использование микрофона в настройках браузера.";
                showError(userFacingMessage); // Показываем ошибку пользователю
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                 userFacingMessage = "Ошибка микрофона: Устройство микрофона не найдено.";
                 showError(userFacingMessage);
            } else if (error.name === 'NotReadableError' || error.name === 'OverconstrainedError') {
                 userFacingMessage = "Ошибка микрофона: Микрофон используется другим приложением или недоступен.";
                 showError(userFacingMessage);
            } else if (error.name === 'AbortError') {
                 userFacingMessage = "Ошибка микрофона: Доступ к микрофону прерван.";
                 showError(userFacingMessage);
            } else {
                showError(userFacingMessage + " " + error.message); // Показываем общую ошибку
            }

            // Сбрасываем флаги и ресурсы при ошибке
            if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
            }
             // Оставляем audioContext, он может быть переиспользован
            // if (audioContext) {
            //    audioContext.close().catch(() => {});
            //    audioContext = null;
            // }
            // audioProcessor = null; // processor связан с context и stream

            return false; // Сигнализируем об ошибке
        }
    }


    // Начало записи голоса
    async function startListening() {
      if (isListening || isPlayingAudio || isReconnecting || !isConnected) {
        widgetLog(`Cannot start listening yet: isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isConnected=${isConnected}`);

         // Если не подключено и не переподключается, пытаемся подключиться
         if (!isConnected && !isReconnecting && isWidgetOpen && !connectionFailedPermanently) {
             widgetLog("Connection not ready, trying to connect...");
             connectWebSocket(); // Попытка подключения
         } else if (connectionFailedPermanently && isWidgetOpen) {
             // Если соединение не удалось восстановить, показываем ошибку
             showError("Не удалось восстановить соединение. Нажмите кнопку 'Повторить'.");
             updateConnectionStatus('disconnected', 'Отключено');
         }


        // Если аудио не готово, пытаемся его активировать (это произойдет при клике открытия)
         if (!audioContext || audioContext.state !== 'running' || !mediaStream || !audioProcessor) {
              widgetLog("Audio not ready, cannot start listening.");
             // showMessage("Микрофон недоступен. Пожалуйста, откройте виджет снова."); // Это сообщение не нужно, т.к. активация на открытии
              // Показываем общее сообщение "Готов к разговору" в неактивном состоянии
              showMessage("Нажмите на микрофон, чтобы начать разговор"); // Текст для неактивного состояния
             mainCircle.classList.add('inactive');
              mainCircle.classList.remove('listening', 'speaking');
         } else {
              // Если соединение и аудио готовы, но мы не слушаем и не говорим,
              // это может быть состояние после завершения ответа или ошибки.
              // Нужно проверить, почему не начали слушать.
             widgetLog("Connection and audio seem ready, but not listening/speaking. Check state flags.");
              // Возможно, нужно просто вызвать ensureAudioInitializedAndReady еще раз?
         }

        return; // Выходим, если не можем начать
      }

       // Если мы дошли сюда, значит, соединение установлено, аудио готово, и мы не слушаем/говорим.
       widgetLog('Начинаем прослушивание...');
       isListening = true;
       isPlayingAudio = false; // Убедимся, что флаг воспроизведения выключен

       // Отправляем команду для очистки буфера ввода на сервере
       if (websocket && websocket.readyState === WebSocket.OPEN) {
           websocket.send(JSON.stringify({
               type: "input_audio_buffer.clear",
               event_id: `clear_${Date.now()}`
           }));
            // Отменяем любой текущий ответ, если он был
           websocket.send(JSON.stringify({
              type: "response.cancel",
              event_id: `cancel_${Date.now()}`
           }));
       }

       // Сбрасываем флаги аудио данных для нового сегмента
       hasAudioData = false;
       audioDataStartTime = Date.now(); // Запоминаем время начала сегмента
       isSilent = true; // Считаем, что начинаем с тишины (пока не появился звук)
       silenceStartTime = Date.now(); // Обновляем время начала тишины для первого звука
       hasSentAudioInCurrentSegment = false; // Сбрасываем флаг отправки

       // Активируем визуальное состояние прослушивания
       mainCircle.classList.add('listening');
       mainCircle.classList.remove('inactive', 'speaking');

       // Скрываем любые сообщения об ошибках
       hideError();

        // Показываем сообщение "Слушаю..."
        showMessage("Слушаю...", 0); // 0 означает без автоскрытия
        updateConnectionStatus('connected', 'Слушаю...'); // Обновляем статус

        // Убираем пульсацию с кнопки (если была)
        const widgetButton = document.getElementById('wellcomeai-widget-button');
         if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');

    }

    // Остановка записи голоса
    function stopListening() {
        if (!isListening) return; // Если не слушаем, ничего не делаем

        widgetLog('Останавливаем прослушивание...');
        isListening = false;

         // Отправляем команду на сервер, чтобы обработать текущий буфер
         // commitAudioBuffer() уже содержит эту логику и проверки
         commitAudioBuffer(); // Попытаемся отправить оставшийся буфер принудительно

         // Обновляем UI
         mainCircle.classList.remove('listening');
         // Если не говорим, переходим в неактивное состояние
         if (!isPlayingAudio) {
            mainCircle.classList.add('inactive');
            showMessage("Нажмите на микрофон, чтобы начать разговор"); // Текст для неактивного состояния
             updateConnectionStatus('connected', 'Готов');
             resetAudioVisualization(); // Сбрасываем визуализацию
         } else {
             // Если начали говорить, UI уже в состоянии speaking
         }

         // Сбрасываем флаги аудио данных, чтобы следующий startListening начал новый сегмент
         hasAudioData = false;
         audioDataStartTime = 0;
         isSilent = true;
         silenceStartTime = Date.now();
         hasSentAudioInCurrentSegment = false;

    }


    // Функция для отправки аудиобуфера (вызывается при детектировании тишины или остановке)
    function commitAudioBuffer() {
      // Отправляем команду commit, только если были отправлены какие-либо данные в текущем сегменте
      if (!hasSentAudioInCurrentSegment || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) {
           widgetLog("Не отправляем commit: нет аудиоданных или соединение не готово.");
           hasAudioData = false; audioDataStartTime = 0; hasSentAudioInCurrentSegment = false; // Сбрасываем на всякий случай
           return;
      }

      // Проверяем минимальную длительность аудио, если commit вызван автоматически тишиной
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс < ${minimumAudioLength}мс), не отправляем commit.`);
        // Сбрасываем флаги, чтобы этот короткий сегмент был проигнорирован
        hasAudioData = false;
        audioDataStartTime = 0;
         hasSentAudioInCurrentSegment = false;
        // Если widgetOpen и не слушаем/говорим, переходим в неактивное состояние
        if(isWidgetOpen && !isListening && !isPlayingAudio){
            mainCircle.classList.add('inactive');
            mainCircle.classList.remove('listening', 'speaking');
            showMessage("Нажмите на микрофон, чтобы начать разговор");
             updateConnectionStatus('connected', 'Готов');
             resetAudioVisualization();
        }
        return;
      }


      widgetLog("Отправка команды input_audio_buffer.commit");

      // Сбрасываем эффект прослушивания сразу при успешной отправке команды
      mainCircle.classList.remove('listening');
      // Пока не начали говорить, переходим в состояние "обработка" или "ожидание"
      if (!isPlayingAudio) {
          showMessage("Обработка...", 0); // Показываем статус обработки
           updateConnectionStatus('connected', 'Обработка...');
           mainCircle.classList.add('inactive'); // Или добавить класс 'processing' если есть стили
      }


      // Отправляем команду для завершения буфера
      websocket.send(JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}` // Добавляем ID события для отслеживания
      }));

      // Сбрасываем флаги для следующего сегмента
      hasAudioData = false;
      audioDataStartTime = 0;
      isSilent = true;
      silenceStartTime = Date.now();
      hasSentAudioInCurrentSegment = false;

      // Опционально: показать временный лоадер для мобильных (скрыт в CSS сейчас)
      // if (isMobile && loaderModal) {
      //   loaderModal.classList.add('active');
      //   setTimeout(() => { loaderModal.classList.remove('active'); }, 1000);
      // }
    }


    // Функция для полной остановки всех аудио процессов (вызывается при закрытии виджета)
    function stopAllAudioProcessing() {
      widgetLog("Stopping all audio processing...");

      // Останавливаем прослушивание
      stopListening(); // stopListening уже вызывает commit

      // Останавливаем воспроизведение
      isPlayingAudio = false;
      audioPlaybackQueue = []; // Очищаем очередь воспроизведения

      // Сбрасываем UI
      mainCircle.classList.remove('listening', 'speaking');
      mainCircle.classList.add('inactive'); // Возвращаем в неактивное состояние
      resetAudioVisualization();
      hideMessage(); // Скрываем сообщения
      hideError(); // Скрываем ошибки

      // Отправляем команду отмены ответа на сервер, если есть активное соединение
      if (websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
          websocket.send(JSON.stringify({
              type: "response.cancel",
              event_id: `cancel_${Date.now()}` // Уникальный ID для запроса отмены
          }));
          widgetLog("Sent response.cancel command.");
      }

      // Отключаем микрофон, если поток активен
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
        widgetLog("MediaStream tracks stopped.");
      }

       // Закрываем и сбрасываем AudioContext и Processor
        if (audioProcessor) {
             try {
                 audioProcessor.disconnect();
             } catch (e) { widgetLog(`Error disconnecting processor: ${e.message}`, 'warn'); }
             audioProcessor.onaudioprocess = null; // Очищаем обработчик
             audioProcessor = null;
             widgetLog("Audio processor reset.");
         }
        // Закрывать контекст лучше при совсем долгом отсутствии активности или принудительно
        // if (audioContext && audioContext.state !== 'closed') {
        //      audioContext.close().then(() => {
        //          widgetLog("AudioContext closed.");
        //          audioContext = null;
        //      }).catch(e => { widgetLog(`Error closing AudioContext: ${e.message}`, 'warn'); });
        //  }


      widgetLog("All audio processing stopped.");
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
        return new ArrayBuffer(0); // Возвращаем пустой буфер при ошибке
      }
    }

    // Обновление визуализации аудио (уровня громкости)
    function updateAudioVisualization(audioData) {
      const audioBars = document.getElementById('wellcomeai-audio-bars');
      if (!audioBars) return;

      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      const step = Math.floor(audioData.length / bars.length);
      const multiplier = isMobile ? 150 : 100; // Чувствительность визуализации

      for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = 0; j < step; j++) {
          const index = i * step + j;
          if (index < audioData.length) {
            sum += Math.abs(audioData[index]);
            count++;
          }
        }
        const average = count > 0 ? sum / count : 0;

        // Нормализуем значение для высоты полосы (от 2px до 30px)
        const height = 2 + Math.min(28, Math.floor(average * multiplier));
        if (bars[i]) { // Проверяем, что элемент существует
            bars[i].style.height = `${height}px`;
        }
      }
    }

    // Сброс визуализации аудио
    function resetAudioVisualization() {
      const audioBars = document.getElementById('wellcomeai-audio-bars');
       if (!audioBars) return;
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px';
      });
    }

    // Создаём простой WAV из PCM данных для воспроизведения
    function createWavFromPcm(pcmBuffer, sampleRate = 16000) { // Используем 16kHz по умолчанию для аудио ответа
        // Проверяем, что буфер существует и не пустой
        if (!pcmBuffer || pcmBuffer.byteLength === 0) {
            widgetLog("Attempted to create WAV from empty buffer.", 'warn');
            return new ArrayBuffer(0);
        }

        const numChannels = 1;
        const bitsPerSample = 16; // 16-bit PCM

        const wavHeader = new ArrayBuffer(44);
        const view = new DataView(wavHeader);

        // RIFF identifier 'RIFF'
        writeString(view, 0, 'RIFF');
        // file length
        view.setUint32(4, 36 + pcmBuffer.byteLength, true);
        // RIFF type 'WAVE'
        writeString(view, 8, 'WAVE');
        // format chunk identifier 'fmt '
        writeString(view, 12, 'fmt ');
        // format chunk length
        view.setUint32(16, 16, true); // 16 for PCM
        // sample format (1 for PCM)
        view.setUint16(20, 1, true);
        // number of channels
        view.setUint16(22, numChannels, true);
        // sample rate
        view.setUint32(24, sampleRate, true);
        // byte rate (sample rate * channels * bits per sample / 8)
        view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
        // block align (channels * bits per sample / 8)
        view.setUint16(32, numChannels * bitsPerSample / 8, true);
        // bits per sample
        view.setUint16(34, bitsPerSample, true);
        // data chunk identifier 'data'
        writeString(view, 36, 'data');
        // data chunk length
        view.setUint32(40, pcmBuffer.byteLength, true);

        // Объединяем заголовок и PCM данные
        const wavBuffer = new Uint8Array(wavHeader.byteLength + pcmBuffer.byteLength);
        wavBuffer.set(new Uint8Array(wavHeader), 0);
        wavBuffer.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);

        return wavBuffer.buffer; // Возвращаем ArrayBuffer
    }

     function writeString(view, offset, string) {
         for (let i = 0; i < string.length; i++) {
             view.setUint8(offset + i, string.charCodeAt(i));
         }
     }


    // Воспроизведение следующего аудио в очереди
    function playNextAudio() {
        if (audioPlaybackQueue.length === 0) {
            widgetLog("Audio playback queue empty. Finished speaking.");
            isPlayingAudio = false;
            mainCircle.classList.remove('speaking');
             updateConnectionStatus('connected', 'Готов');
             resetAudioVisualization(); // Сбрасываем визуализацию после окончания воспроизведения

            // После завершения воспроизведения, если виджет открыт, автоматически начинаем слушать
            if (isWidgetOpen && !isListening && !isReconnecting && isConnected) {
                 // Небольшая пауза перед переходом в режим прослушивания
                 setTimeout(() => {
                    widgetLog("Playback finished, attempting to start listening automatically.");
                    // Убедимся, что аудио контекст активен перед запуском прослушивания
                     if (audioContext && audioContext.state === 'running' && mediaStream && audioProcessor) {
                         startListening();
                     } else {
                         widgetLog("Audio not ready for auto-start listening after playback.");
                         // Если по какой-то причине аудио отвалилось, UI останется в inactive/error
                         mainCircle.classList.add('inactive');
                         showMessage("Нажмите на микрофон, чтобы начать разговор");
                         updateConnectionStatus('connected', 'Готов');
                     }
                 }, 500); // Увеличиваем задержку для стабильности
            } else if (!isWidgetOpen && isConnected && !connectionFailedPermanently) {
                 // Если виджет закрыт и есть соединение, показываем пульсацию
                 const widgetButton = document.getElementById('wellcomeai-widget-button');
                 if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
            } else {
                 // Если соединение потеряно или ошибка, показываем ошибку/статус
                 if (connectionFailedPermanently && isWidgetOpen) {
                      showError("Соединение с сервером отсутствует.");
                      updateConnectionStatus('disconnected', 'Отключено');
                 } else if (isWidgetOpen && !isConnected && !isReconnecting) {
                      widgetLog("Connection lost after playback, attempting reconnect.");
                     connectWebSocket(); // Попытка переподключения
                 }
            }

            return; // Очередь пуста, выходим
        }

        isPlayingAudio = true;
        isListening = false; // Прекращаем прослушивание на время воспроизведения
        mainCircle.classList.add('speaking');
        mainCircle.classList.remove('inactive', 'listening');
         updateConnectionStatus('connected', 'Говорю...'); // Обновляем статус

        const audioBase64 = audioPlaybackQueue.shift();

        try {
            const audioData = base64ToArrayBuffer(audioBase64);
             if (audioData.byteLength === 0) {
                 widgetLog("Decoded audio chunk is empty, skipping.", 'warn');
                 playNextAudio(); // Переходим к следующему в очереди
                 return;
             }

            // Создаем AudioBuffer из PCM данных
            if (!audioContext || audioContext.state === 'closed') {
                widgetLog("AudioContext is not available for playback.", "error");
                 // Пытаемся пересоздать или возобновить контекст принудительно
                 ensureAudioInitializedAndReady().then(ready => {
                     if(ready) {
                         widgetLog("AudioContext restored, retrying playback.");
                         addAudioToPlaybackQueue(base64ToArrayBuffer(audioBase64)); // Вернуть текущий чанк в начало очереди
                         playNextAudio(); // Запустить воспроизведение снова
                     } else {
                          widgetLog("Failed to restore AudioContext for playback.", "error");
                          isPlayingAudio = false;
                          mainCircle.classList.remove('speaking'); mainCircle.classList.add('inactive');
                          showMessage("Ошибка воспроизведения аудио.");
                          updateConnectionStatus('connected', 'Ошибка');
                          audioPlaybackQueue = []; // Очистить очередь, т.к. воспроизведение невозможно
                     }
                 });
                 return; // Выходим из текущего вызова
            }

            // Возобновляем AudioContext если он приостановлен (важно для мобильных)
             if (audioContext.state === 'suspended') {
                 widgetLog("Resuming AudioContext for playback...");
                 audioContext.resume().then(() => {
                     widgetLog("AudioContext resumed for playback.");
                     // Теперь можем декодировать и воспроизводить
                     decodeAndPlay(audioData);
                 }).catch(err => {
                     widgetLog(`Failed to resume AudioContext for playback: ${err.message}`, 'error');
                      isPlayingAudio = false;
                      mainCircle.classList.remove('speaking'); mainCircle.classList.add('inactive');
                     showMessage("Ошибка воспроизведения аудио.");
                     updateConnectionStatus('connected', 'Ошибка');
                     audioPlaybackQueue = []; // Очистить очередь
                 });
             } else {
                 // Если контекст активен, сразу декодируем и воспроизводим
                 decodeAndPlay(audioData);
             }

        } catch (error) {
            widgetLog(`Ошибка при подготовке аудио для воспроизведения: ${error.message}`, "error");
            playNextAudio(); // Пробуем воспроизвести следующий
        }
    }

     // Функция декодирования и воспроизведения одного аудио буфера
     function decodeAndPlay(audioDataArrayBuffer) {
         if (!audioContext || audioContext.state === 'closed') {
             widgetLog("AudioContext not available for decoding.", "error");
              playNextAudio(); // Пробуем воспроизвести следующий
             return;
         }

         audioContext.decodeAudioData(audioDataArrayBuffer)
             .then(audioBuffer => {
                 const source = audioContext.createBufferSource();
                 source.buffer = audioBuffer;
                 source.connect(audioContext.destination);

                 source.onended = function() {
                     widgetLog("Audio chunk playback ended.");
                     playNextAudio(); // Воспроизводим следующий в очереди
                 };

                 source.start(0); // Начинаем воспроизведение сразу
                 widgetLog("Started playing audio chunk.");
             })
             .catch(error => {
                 widgetLog(`Ошибка декодирования аудио данных: ${error.message}`, "error");
                 playNextAudio(); // Пробуем воспроизвести следующий
             });
     }


    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') {
          widgetLog("Received invalid audio data for playback queue.", 'warn');
          return;
      }
      // Добавляем аудио в очередь
      audioPlaybackQueue.push(audioBase64);

      // Если не запущено воспроизведение, запускаем
      if (!isPlayingAudio) {
        widgetLog("Added audio to queue. Starting playback.");
        playNextAudio();
      } else {
         widgetLog("Added audio to queue. Playback already in progress.");
      }
    }


    // Обновление индикатора статуса соединения
    function updateConnectionStatus(status, message) {
      const statusIndicator = document.getElementById('wellcomeai-status-indicator');
      const statusDot = document.getElementById('wellcomeai-status-dot');
      const statusText = document.getElementById('wellcomeai-status-text');
      const mainCircle = document.getElementById('wellcomeai-main-circle'); // Для обновления класса на круге

      if (!statusIndicator || !statusDot || !statusText || !mainCircle) {
          widgetLog("Status indicator UI elements not found.", 'warn');
          return;
      }

      statusText.textContent = message || status;

      // Удаляем все классы состояния
      statusDot.classList.remove('connected', 'disconnected', 'connecting');
      mainCircle.classList.remove('inactive', 'connecting'); // Удаляем классы состояния с круга

      // Добавляем нужный класс и обновляем состояние круга
      if (status === 'connected') {
        statusDot.classList.add('connected');
         // Круг переходит в состояние active или inactive в зависимости от isListening/isPlayingAudio
         if (isListening) {
             mainCircle.classList.add('listening');
         } else if (isPlayingAudio) {
             mainCircle.classList.add('speaking');
         } else {
              mainCircle.classList.add('inactive'); // Состояние готовности
         }
      } else if (status === 'disconnected') {
        statusDot.classList.add('disconnected');
         mainCircle.classList.add('inactive'); // Круг неактивен при отключении
      } else { // connecting
        statusDot.classList.add('connecting');
         mainCircle.classList.add('connecting'); // Можно добавить отдельный стиль для connecting на круге
         mainCircle.classList.remove('inactive'); // Убираем inactive на время подключения
      }

      // Показываем индикатор, если виджет открыт
      if (isWidgetOpen || status !== 'connected') { // Показываем ошибку/подключение даже если виджет закрыт? Или только при открытии? Решаем: показывать только при открытии, или при постоянной ошибке.
           if (isWidgetOpen) { // Показываем при открытом виджете
               statusIndicator.classList.add('show');
               // Скрываем через некоторое время, если это не ошибка/подключение
               if (status === 'connected' && message !== 'Слушаю...' && message !== 'Говорю...' && message !== 'Обработка...') {
                   setTimeout(() => {
                       statusIndicator.classList.remove('show');
                   }, 3000);
               }
           } else {
               // Если виджет закрыт и статус не "connected", возможно, хотим показать ошибку на кнопке?
               // Сейчас логика ошибки соединения показывается только при открытом виджете.
               statusIndicator.classList.remove('show'); // Скрываем индикатор статуса при закрытом виджете
           }

      } else {
           statusIndicator.classList.remove('show'); // Скрываем индикатор статуса при закрытом виджете и статусе 'connected'
      }

       // Если есть постоянная ошибка соединения, показываем ошибку в UI
       if (connectionFailedPermanently && isWidgetOpen) {
            showError("Не удалось подключиться к серверу.");
            // updateConnectionStatus('disconnected', 'Отключено'); // Это уже вызовет showError
       }
    }


    // Показать общее сообщение (статус, инструкции)
    function showMessage(message, duration = 5000) {
        const messageDisplay = document.getElementById('wellcomeai-message-display');
        if (!messageDisplay) return;

        // Скрываем ошибку, если есть
        hideError();

        messageDisplay.textContent = message;
        messageDisplay.classList.add('show');

        // Если duration > 0, устанавливаем таймер на скрытие
        if (duration > 0) {
            // Очищаем предыдущий таймер, если он был
            if (messageDisplay.__hideTimer) {
                clearTimeout(messageDisplay.__hideTimer);
            }
            messageDisplay.__hideTimer = setTimeout(() => {
                hideMessage();
            }, duration);
        } else {
             // Если duration === 0, сообщение не скрывается автоматически
             if (messageDisplay.__hideTimer) {
                 clearTimeout(messageDisplay.__hideTimer);
                 delete messageDisplay.__hideTimer;
             }
        }
    }

    // Скрыть сообщение
    function hideMessage() {
        const messageDisplay = document.getElementById('wellcomeai-message-display');
        if (!messageDisplay) return;

        messageDisplay.classList.remove('show');
        // Очищаем таймер принудительно, если он был
        if (messageDisplay.__hideTimer) {
             clearTimeout(messageDisplay.__hideTimer);
             delete messageDisplay.__hideTimer;
        }
    }

    // Показать сообщение об ошибке (микрофон, соединение и т.п.)
    function showError(message) {
        const errorMessageDiv = document.getElementById('wellcomeai-error-message');
        const mainCircle = document.getElementById('wellcomeai-main-circle');

        if (!errorMessageDiv || !mainCircle) return;

         // Скрываем обычное сообщение
         hideMessage();

        errorMessageDiv.innerHTML = `
          ${message || 'Произошла неизвестная ошибка.'}
          <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
            Повторить
          </button>
        `;
        errorMessageDiv.classList.add('visible');

         // Круг переходит в неактивное состояние
         mainCircle.classList.remove('listening', 'speaking', 'connecting');
         mainCircle.classList.add('inactive');
         resetAudioVisualization();

        // Добавляем обработчик для новой кнопки повтора
        const newRetryButton = errorMessageDiv.querySelector('#wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', function() {
            widgetLog("Retry button clicked.");
            hideError(); // Скрываем ошибку
            // В зависимости от типа ошибки, пытаемся повторить:
            // Если Permanent Error, пытаемся переподключиться. Иначе, пытаемся снова начать слушать.
            if (connectionFailedPermanently) {
                 resetConnection(); // Сброс состояния соединения и попытка переподключения
            } else {
                 // Если ошибка не постоянная ошибка соединения, возможно, это микрофон или временная ошибка.
                 // Пытаемся просто снова начать слушать. Это вызовет ensureAudio... и initAudio... если нужно.
                 if(isWidgetOpen) {
                      widgetLog("Attempting to restart listening after error.");
                      startListening(); // startListening теперь сам проверяет готовность аудио/соединения
                 } else {
                      // Если виджет закрыт, ошибка показалась только при открытии, при следующем открытии try openWidget
                 }
            }
          });
        }
        // Обновляем статус индикатора, если виджет открыт
        if(isWidgetOpen) {
             updateConnectionStatus('disconnected', 'Ошибка');
        }
    }

    // Скрыть сообщение об ошибке
    function hideError() {
        const errorMessageDiv = document.getElementById('wellcomeai-error-message');
        if (errorMessageDiv) {
            errorMessageDiv.classList.remove('visible');
        }
    }

    // Сброс состояния соединения и попытка переподключения
    function resetConnection() {
      widgetLog("Resetting connection state and attempting reconnect...");

      // Сбрасываем счетчик попыток и флаги
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      isReconnecting = false; // Сбрасываем флаг переподключения перед попыткой

      // Скрываем сообщения и ошибки
      hideError();
      hideMessage();

      // Показываем статус подключения
      if(isWidgetOpen) {
          showMessage("Подключение...");
          updateConnectionStatus('connecting', 'Подключение...');
           mainCircle.classList.remove('listening', 'speaking');
          mainCircle.classList.add('inactive');
      } else {
           // Если виджет закрыт, просто убираем пульсацию и пробуем подключиться в фоне
           const widgetButton = document.getElementById('wellcomeai-widget-button');
           if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
      }


      // Пытаемся подключиться заново
      connectWebSocket();
    }


    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
          widgetLog("WebSocket is already connecting or open.");
           // Если уже подключается, возможно, нужно показать лоадер?
           if(isWidgetOpen && websocket.readyState === WebSocket.CONNECTING) {
               loaderModal.classList.add('active');
           }
          return true; // Уже в процессе или подключено
      }

      if (!ASSISTANT_ID) {
          widgetLog("Assistant ID not found, cannot connect WebSocket.", 'error');
          if (isWidgetOpen) showError('Ошибка: ID ассистента не указан.');
          loaderModal.classList.remove('active');
          return false;
      }
       if (connectionFailedPermanently) {
           widgetLog("Connection failed permanently, not attempting reconnect.", 'warn');
           if (isWidgetOpen) showError('Не удалось восстановить соединение.');
           loaderModal.classList.remove('active');
            const widgetButton = document.getElementById('wellcomeai-widget-button');
            if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation'); // Пульсация на кнопке, если виджет закрыт
           return false;
       }


      widgetLog(`Attempting to connect to WebSocket at: ${WS_URL}`);
      isReconnecting = true; // Устанавливаем флаг переподключения/подключения

      // Показываем лоадер только при открытом виджете
       const loaderModal = document.getElementById('wellcomeai-loader-modal');
       if (isWidgetOpen && loaderModal) {
            loaderModal.classList.add('active');
       }
       hideError(); // Скрываем предыдущую ошибку перед попыткой

      // Очищаем предыдущее соединение, если оно в плохом состоянии
      if (websocket) {
        try {
          websocket.onopen = null; // Убираем старые обработчики
          websocket.onmessage = null;
          websocket.onclose = null;
          websocket.onerror = null;
          websocket.close(); // Закрываем явно
          widgetLog("Closed existing WebSocket connection before reconnect.");
        } catch (e) {
           widgetLog(`Error closing old websocket: ${e.message}`, 'warn');
        }
      }

       // Очищаем предыдущий таймер ping
       if (pingIntervalId) {
           clearInterval(pingIntervalId);
           pingIntervalId = null;
       }

       // Очищаем таймаут соединения, если есть
       if (connectionTimeout) {
           clearTimeout(connectionTimeout);
           connectionTimeout = null;
       }

       // Создаем новое WebSocket соединение
       try {
           websocket = new WebSocket(WS_URL);
           websocket.binaryType = 'arraybuffer'; // Устанавливаем двоичный тип для эффективной передачи аудио
       } catch (e) {
           widgetLog(`Failed to create WebSocket instance: ${e.message}`, 'error');
            // Это синхронная ошибка, сразу переходим к логике переподключения/ошибки
           isReconnecting = false;
           loaderModal.classList.remove('active');
           reconnectWithDelay(); // Запускаем попытку переподключения
           return false;
       }


       // Устанавливаем таймаут на открытие соединения
       connectionTimeout = setTimeout(() => {
           widgetLog("WebSocket connection timeout", "error");
           if (websocket && websocket.readyState === WebSocket.CONNECTING) {
                websocket.onclose = null; // Предотвращаем двойной вызов onclose
                websocket.close();
           }
            // Теперь логика переподключения будет вызвана из onclose или обработана здесь напрямую
            isReconnecting = false;
           loaderModal.classList.remove('active');
            reconnectWithDelay(); // Начинаем процесс переподключения
       }, CONNECTION_TIMEOUT);


       websocket.onopen = function() {
           clearTimeout(connectionTimeout); // Соединение установлено, отменяем таймаут
           widgetLog('WebSocket connection established');
           isConnected = true;
           isReconnecting = false;
           reconnectAttempts = 0; // Сбрасываем счетчик при успешном подключении
           connectionFailedPermanently = false; // Сбрасываем флаг постоянной ошибки
           loaderModal.classList.remove('active');

           // Инициализируем переменные для ping/pong
           lastPingTime = Date.now();
           lastPongTime = Date.now();

           // Настраиваем интервал ping
           const currentPingInterval = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
           pingIntervalId = setInterval(() => {
               if (websocket && websocket.readyState === WebSocket.OPEN) {
                   try {
                       websocket.send(JSON.stringify({ type: "ping" }));
                       lastPingTime = Date.now();

                       // Проверяем, получили ли мы pong в разумное время
                       if (Date.now() - lastPongTime > currentPingInterval * 3) { // Если pong не было 3 интервала
                           widgetLog("Ping timeout: No pong received.", "warn");
                           // Считаем соединение нерабочим и пытаемся переподключиться
                           if (websocket.readyState === WebSocket.OPEN) {
                               websocket.close(); // Явно закрываем, onclose вызовет reconnectWithDelay
                           }
                       }
                   } catch (e) {
                       widgetLog(`Error sending ping: ${e.message}`, "error");
                        if (websocket.readyState === WebSocket.OPEN) {
                           websocket.close(); // При ошибке отправки, закрываем соединение
                        }
                   }
               } else if (pingIntervalId) {
                    // Если websocket уже не открыт, останавливаем ping интервал
                   clearInterval(pingIntervalId);
                   pingIntervalId = null;
               }
           }, currentPingInterval);

           // Скрываем ошибку соединения, если она была показана
           hideError();

           // Обновляем статус соединения
           updateConnectionStatus('connected', 'Подключено');

           // Если виджет открыт И аудио готово, автоматически начинаем слушать
           // ensureAudioInitializedAndReady() должна быть вызвана кликом открытия виджета
            if (isWidgetOpen) {
                widgetLog("Widget is open, checking if audio is ready to start listening...");
                 // Ждем, пока ensureAudioInitializedAndReady завершится (она уже вызвана в openWidget)
                 // Проверяем состояние аудио после успешного подключения WS
                 if (audioContext && audioContext.state === 'running' && mediaStream && audioProcessor) {
                      widgetLog("Audio ready after WS connect, starting listening...");
                     startListening();
                 } else {
                     widgetLog("Audio not yet ready after WS connect. Waiting for ensureAudioInitializedAndReady completion.");
                     // Сообщение "Подключено" останется, пока startListening не изменит статус
                 }
            } else {
                 // Если виджет закрыт, добавляем пульсацию на кнопку
                 const widgetButton = document.getElementById('wellcomeai-widget-button');
                 if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
            }

       };

       websocket.onmessage = function(event) {
           // Обновляем время последнего pong при получении любого сообщения (подразумеваем, что сервер отправляет что-то регулярно)
           lastPongTime = Date.now();

           try {
               // Проверка на пустое сообщение
               if (!event.data) {
                   widgetLog("Received empty message from server.", "warn");
                   return;
               }

               // Обработка бинарных данных (аудио)
               if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
                    // Декодируем ArrayBuffer, если это он, иначе работаем с Blob
                    const arrayBufferData = event.data instanceof ArrayBuffer ? event.data : null; // пока не обрабатываем Blob

                   // Если бинарные данные - это аудио chunk
                    // Протокол может быть разный, но если сервер шлет бинарные аудиоданные напрямую...
                    // В текущем протоколе аудио приходит в Base64 в JSON сообщениях.
                    // Этот блок пока, возможно, не используется.
                   widgetLog("Received binary data from server. Ignoring or logging if unexpected.", "debug");
                   return;
               }

               // Обработка текстовых сообщений (JSON)
               const data = JSON.parse(event.data);

               // Не логируем слишком частые append сообщения
               if (data.type !== 'input_audio_buffer.append') {
                 widgetLog(`Received message type: ${data.type || 'unknown'}`);
               }

               // Проверка на ping/pong
               if (data.type === 'pong') {
                 widgetLog("Received pong.");
                 lastPongTime = Date.now();
                 return;
               }
                if (data.type === 'ping') {
                    // Сервер прислал ping, отвечаем pong
                    if (websocket && websocket.readyState === WebSocket.OPEN) {
                        websocket.send(JSON.stringify({ type: "pong" }));
                        widgetLog("Received ping, sent pong.");
                    }
                    return;
                }


               // Проверка на сообщение connection_status
               if (data.type === 'connection_status') {
                 widgetLog(`Server connection status: ${data.status} - ${data.message}`);
                  // Этот статус может быть полезен, но основной статус соединения определяем по onopen/onclose WS
                  // Если статус от сервера пришел 'disconnected' или 'error', возможно, нужно инициировать локальное переподключение
                  if (data.status === 'disconnected' || data.status === 'error') {
                       widgetLog("Server reported connection issue, initiating local reconnect.", 'warn');
                       if (websocket.readyState === WebSocket.OPEN) {
                           websocket.close(); // Закрываем, чтобы onclose запустил reconnectWithDelay
                       } else if (!isReconnecting) {
                            // Если уже закрыто, но reconnect не запущен, запускаем
                            reconnectWithDelay();
                       }
                  } else if (data.status === 'connected') {
                       // Сервер подтвердил соединение. Убеждаемся, что локальное состояние тоже connected.
                       isConnected = true;
                       isReconnecting = false;
                       reconnectAttempts = 0;
                       connectionFailedPermanently = false;
                       hideError();
                       if (isWidgetOpen) updateConnectionStatus('connected', 'Подключено');

                        // Если виджет открыт и аудио готово, стартуем прослушивание (еще раз проверяем)
                        if (isWidgetOpen && !isListening && !isPlayingAudio && audioContext && audioContext.state === 'running' && mediaStream && audioProcessor) {
                            widgetLog("Server confirmed connected, audio ready, starting listening.");
                            startListening();
                        } else if (isWidgetOpen && !isListening && !isPlayingAudio) {
                             widgetLog("Server confirmed connected, but audio not ready for auto-start listening.");
                             updateConnectionStatus('connected', 'Готов'); // Остаемся в состоянии готовности
                             mainCircle.classList.add('inactive');
                             showMessage("Нажмите на микрофон, чтобы начать разговор");
                        }
                  }
                 return; // Обработка connection_status завершена
               }

               // Обработка ошибок от сервера
               if (data.type === 'error') {
                 widgetLog(`Error from server: ${data.error ? data.error.message : 'Unknown server error'}`, "error");
                 // Особая обработка для ошибки пустого аудиобуфера при commit
                 if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                   widgetLog("Received error: empty audio buffer on commit. This is expected if user says nothing.", "warn");
                   // Если мы слушали, это нормально. Просто переходим в неактивное состояние.
                    if (isListening) {
                        // stopListening() уже был вызван перед commit'ом.
                        // Переходим в состояние готовности.
                         isListening = false; // Убедимся, что флаг снят
                         if (!isPlayingAudio) {
                             mainCircle.classList.add('inactive');
                             mainCircle.classList.remove('listening', 'speaking');
                              showMessage("Нажмите на микрофон, чтобы начать разговор");
                              updateConnectionStatus('connected', 'Готов');
                              resetAudioVisualization();
                         }
                    }
                    hideMessage(); // Скрываем возможное сообщение "Обработка..."
                   return; // Эту ошибку не показываем пользователю как критичную
                 }

                 // Прочие ошибки сервера - показываем пользователю
                 let errorMessage = data.error ? data.error.message : 'Произошла ошибка на сервере.';
                 if (isWidgetOpen) {
                     showError(errorMessage);
                 } else {
                      // Логируем ошибку даже если виджет закрыт
                      widgetLog(`Server error received while widget closed: ${errorMessage}`, 'error');
                 }
                 return; // Обработка ошибки завершена
               }

               // Обработка текстового ответа (потоковая передача)
               if (data.type === 'response.text.delta') {
                 if (data.delta) {
                   // Если виджет открыт, показываем текст
                    if (isWidgetOpen) {
                        // Добавляем дельту к текущему сообщению или заменяем
                        const messageDisplay = document.getElementById('wellcomeai-message-display');
                        if(messageDisplay) {
                             // Если это первая дельта, очищаем предыдущее сообщение и показываем лоадер (если был)
                            if (messageDisplay.textContent === '' || messageDisplay.textContent === 'Обработка...') {
                                messageDisplay.textContent = data.delta;
                                hideError(); // Убедимся, что ошибки скрыты
                                mainCircle.classList.remove('inactive', 'listening');
                                mainCircle.classList.add('speaking'); // Переходим в состояние говорения
                                updateConnectionStatus('connected', 'Говорю...');
                            } else {
                                messageDisplay.textContent += data.delta;
                            }
                             showMessage(messageDisplay.textContent, 0); // Показываем текст, не скрываем автоматически
                        }
                    }
                 }
                 return;
               }

               // Завершение текстового ответа
               if (data.type === 'response.text.done') {
                 widgetLog('Response text done received.');
                 // Текстовое сообщение остается на экране до получения audio.done или response.done
                 // Или до явного вызова hideMessage
                 return;
               }

               // Обработка аудио ответа (потоковая передача в Base64)
               if (data.type === 'response.audio.delta') {
                 if (data.delta) {
                   audioChunksBuffer.push(data.delta); // Собираем чанки аудио
                   // widgetLog(`Received audio delta chunk (${data.delta.length} chars). Buffer size: ${audioChunksBuffer.length}`); // Логируем для отладки
                 }
                 return;
               }

              // Обработка аудио транскрипции (если сервер предоставляет)
               if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
                   // Пока игнорируем или обрабатываем по необходимости (например, выводим в консоль)
                   // widgetLog(`Received transcript: ${data.transcript || 'Done'}`);
                   return;
               }


               // Аудио готово для воспроизведения (все дельты получены)
               if (data.type === 'response.audio.done') {
                 widgetLog('Response audio done received. Processing audio chunks.');
                 if (audioChunksBuffer.length > 0) {
                    const fullAudioBase64 = audioChunksBuffer.join('');
                    audioChunksBuffer = []; // Очищаем буфер
                    addAudioToPlaybackQueue(fullAudioBase64); // Добавляем в очередь воспроизведения
                 } else {
                     widgetLog("Received audio.done but audio buffer is empty.", 'warn');
                     // Если аудио нет, но текст есть, возможно, нужно скрыть сообщение через таймер?
                     const messageDisplay = document.getElementById('wellcomeai-message-display');
                      if (messageDisplay && messageDisplay.classList.contains('show') && messageDisplay.__hideTimer === undefined) {
                           showMessage(messageDisplay.textContent, 5000); // Устанавливаем таймер на скрытие
                      }
                 }
                 return; // Обработка audio.done завершена
               }

               // Ответ завершен (последнее сообщение в цепочке)
               if (data.type === 'response.done') {
                 widgetLog('Response done received.');
                 // После завершения ответа, UI перейдет в состояние готовности
                 // Логика playNextAudio при пустой очереди уже обрабатывает переход
                 // Если не было аудио, но был текст, скрываем текстовое сообщение после паузы
                 const messageDisplay = document.getElementById('wellcomeai-message-display');
                 if (messageDisplay && messageDisplay.classList.contains('show')) {
                     // Устанавливаем таймер на скрытие, если он еще не установлен audio.done
                      if (messageDisplay.__hideTimer === undefined) {
                           showMessage(messageDisplay.textContent, 5000);
                      }
                 }
                 // Если виджет открыт и нет воспроизведения, готовимся начать слушать снова
                 if (isWidgetOpen && !isPlayingAudio && !isReconnecting && isConnected) {
                     // playNextAudio при завершении очереди сам вызовет startListening
                      widgetLog("Response done, triggering auto-start listening if possible.");
                 } else if (!isWidgetOpen && isConnected && !connectionFailedPermanently) {
                      // Если виджет закрыт, добавляем пульсацию
                      const widgetButton = document.getElementById('wellcomeai-widget-button');
                      if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                 }
                 return; // Обработка response.done завершена
               }


               // Если мы дошли до этой точки, у нас неизвестный тип сообщения
               widgetLog(`Неизвестный тип сообщения от сервера: ${data.type}`, "warn");

           } catch (parseError) {
               // Если не удалось распарсить JSON, это может быть что-то нетекстовое или поврежденное сообщение
               widgetLog(`Ошибка парсинга JSON сообщения: ${parseError.message}`, "warn");
               widgetLog(`Message content: ${typeof event.data === 'string' ? event.data.substring(0, 200) + '...' : 'Binary or non-string data'}`, "debug");
           }
       };

       websocket.onclose = function(event) {
           widgetLog(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason || 'N/A'}. Clean: ${event.wasClean}`);
           isConnected = false;
           //isListening = false; // Флаг listening сбрасывается при остановке аудиопроцессов
           //isPlayingAudio = false; // Флаг speaking сбрасывается при остановке аудиопроцессов

           // Очищаем интервал ping
           if (pingIntervalId) {
               clearInterval(pingIntervalId);
               pingIntervalId = null;
           }
            // Очищаем таймаут подключения, если он еще висит
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }

            // Останавливаем аудиопроцессы, чтобы сбросить флаги прослушивания/говорения
            stopAllAudioProcessing();

           // Не пытаемся переподключаться, если соединение было закрыто нормально (коды 1000, 1001)
           if (event.code === 1000 || event.code === 1001) {
             widgetLog('Clean WebSocket close, not attempting reconnect.');
             isReconnecting = false; // Убеждаемся, что флаг снят
              if (isWidgetOpen) {
                 updateConnectionStatus('disconnected', 'Отключено'); // Показываем статус отключено
                 showMessage("Соединение закрыто.", 3000);
              } else {
                 const widgetButton = document.getElementById('wellcomeai-widget-button');
                 if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation'); // Пульсация на кнопке
              }
             return;
           }

           // Для всех остальных кодов ошибок или нечистого закрытия - пытаемся переподключиться
           widgetLog(`WebSocket closed unexpectedly (code ${event.code}). Attempting reconnect...`);
           // Вызываем функцию переподключения с экспоненциальной задержкой
           reconnectWithDelay();
       };

       websocket.onerror = function(error) {
           widgetLog(`WebSocket error: ${error.message || 'Unknown error'}`, 'error');

            // Ошибка обычно предшествует закрытию, логика переподключения будет в onclose.
            // Но здесь можно показать временное сообщение об ошибке.
            if (isWidgetOpen) {
                 showMessage("Ошибка соединения...", 0); // Не скрываем автоматически, пока не переподключились или не показали permanent error
                 updateConnectionStatus('disconnected', 'Ошибка');
                 mainCircle.classList.remove('listening', 'speaking');
                 mainCircle.classList.add('inactive');
            }
            // Логика reconnectWithDelay будет вызвана из onclose
       };

       return true; // Возвращаем true, если удалось создать WebSocket инстанс
    }

    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      // Проверяем, не превышено ли максимальное количество попыток
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

      if (connectionFailedPermanently) {
           widgetLog("Cannot reconnect: Permanent connection failure previously detected.");
           if (isWidgetOpen) {
                showError("Не удалось восстановить соединение. Пожалуйста, попробуйте перезагрузить страницу.");
                updateConnectionStatus('disconnected', 'Отключено');
           } else {
               const widgetButton = document.getElementById('wellcomeai-widget-button');
               if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
           }
           return;
      }

      if (reconnectAttempts >= maxAttempts) {
        widgetLog(`Maximum reconnection attempts (${maxAttempts}) reached.`);
        connectionFailedPermanently = true; // Устанавливаем флаг постоянной ошибки
        isReconnecting = false; // Снимаем флаг переподключения
        isConnected = false; // Убедимся, что соединение отмечено как отключенное
        stopAllAudioProcessing(); // Останавливаем аудиопроцессы
         if (isWidgetOpen) {
             showError("Не удалось подключиться к серверу. Пожалуйста, попробуйте позже.");
             updateConnectionStatus('disconnected', 'Отключено');
         } else {
            const widgetButton = document.getElementById('wellcomeai-widget-button');
            if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
         }
        return;
      }

      if (isReconnecting) {
           widgetLog("Already in reconnection process, skipping new attempt trigger.");
           return; // Уже пытаемся переподключиться
      }

      isReconnecting = true; // Устанавливаем флаг
      reconnectAttempts++; // Увеличиваем счетчик попыток

      // Вычисляем задержку: экспоненциальная backoff
      const delay = initialDelay > 0 ?
                initialDelay :
                isMobile ?
                    Math.min(20000, Math.pow(1.5, reconnectAttempts - 1) * 1000 + Math.random() * 1000) : // +1000ms для случайности
                    Math.min(40000, Math.pow(2, reconnectAttempts - 1) * 1000 + Math.random() * 2000); // +2000ms для случайности

      widgetLog(`Reconnecting in ${Math.round(delay/1000)} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);

       // Показываем сообщение пользователю, если виджет открыт
       if (isWidgetOpen) {
           showMessage(`Соединение прервано. Повторная попытка через ${Math.round(delay/1000)} сек...`, 0);
           updateConnectionStatus('connecting', 'Переподключение...');
           mainCircle.classList.remove('listening', 'speaking');
           mainCircle.classList.add('inactive');
       } else {
            // Если виджет закрыт, скрываем индикатор статуса и сообщение
             const statusIndicator = document.getElementById('wellcomeai-status-indicator');
             if (statusIndicator) statusIndicator.classList.remove('show');
             hideMessage(); hideError(); // Убираем сообщения
       }


      // Пытаемся переподключиться через вычисленную задержку
      setTimeout(() => {
          if (!connectionFailedPermanently && isReconnecting) { // Проверяем флаги перед попыткой
              connectWebSocket().then(success => {
                  // connectWebSocket сам обновит флаги и статус
                  if (!success) {
                      // Если connectWebSocket вернул false (не смог создать сокет),
                      // логика переподключения продолжится из connectWebSocket или следующего вызова reconnectWithDelay
                      widgetLog("connectWebSocket returned false during reconnect attempt.");
                  }
                  // isReconnecting флаг снимается в onopen или onclose/onerror connectWebSocket
              }).catch(() => {
                  // В случае ошибки в connectWebSocket (например, синтаксическая), флаг isReconnecting снимется там.
                   widgetLog("connectWebSocket call failed during reconnect attempt.", 'error');
              });
          } else {
               widgetLog("Skipping reconnect attempt due to permanent failure or state change.");
               isReconnecting = false; // Убедимся, что флаг снят
          }
      }, delay);
    }

    // Открыть виджет
    async function openWidget() {
      if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal) {
         widgetLog("UI elements not ready to open widget.", 'error');
          alert('WellcomeAI Widget Error: UI elements not found.');
          return;
      }
      if (!ASSISTANT_ID) {
         widgetLog("Assistant ID not found, cannot open widget.", 'error');
         showError('WellcomeAI Widget Error: ID ассистента не указан.');
         return;
      }

      widgetLog("Opening widget...");

      // Принудительно устанавливаем z-index для решения конфликтов
      widgetContainer.style.zIndex = "2147483647";
      widgetButton.style.zIndex = "2147483647"; // Кнопка должна быть выше всего

      widgetContainer.classList.add('active');
      isWidgetOpen = true;

       // Принудительно устанавливаем видимость expanded виджета (CSS transition может быть переопределен)
       const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
       if (expandedWidget) {
           expandedWidget.style.opacity = "1";
           // expandedWidget.style.height = isMobile ? "350px" : "400px"; // CSS уже управляет этим
           expandedWidget.style.pointerEvents = "all";
           expandedWidget.style.zIndex = "2147483647";
       }

       // Показываем лоадер пока идет подключение и инициализация аудио
       loaderModal.classList.add('active');
       showMessage("Загрузка...", 0); // Сообщение "Загрузка..." без автоскрытия
       updateConnectionStatus('connecting', 'Загрузка...');
       mainCircle.classList.remove('listening', 'speaking');
       mainCircle.classList.add('inactive');
       resetAudioVisualization();

       // Скрываем ошибку, если она была показана при закрытом виджете
       hideError();


      try {
          // Шаг 1: Инициируем или проверяем WebSocket соединение
           widgetLog("Step 1: Ensuring WebSocket connection is established...");
           const wsConnectedPromise = new Promise((resolve) => {
               if (isConnected) {
                   widgetLog("WS already connected.");
                   resolve(true);
               } else if (isReconnecting) {
                    widgetLog("WS is reconnecting, waiting for onopen...");
                   // Добавляем временный обработчик onopen
                   const tempOpenHandler = () => {
                       websocket.removeEventListener('open', tempOpenHandler);
                       resolve(true);
                   };
                    // Если websocket объект уже существует (напр. из-за reconnectWithDelay), добавляем listener
                    if (websocket) {
                        websocket.addEventListener('open', tempOpenHandler);
                    } else {
                        // Если websocket еще не создан, connectWebSocket создаст его и вызовет onopen
                        widgetLog("WS object not found, connectWebSocket will create it.");
                    }
               } else if (connectionFailedPermanently) {
                    widgetLog("WS connection failed permanently.", 'warn');
                   resolve(false); // Соединение не может быть установлено
               } else {
                   widgetLog("WS not connected, calling connectWebSocket...");
                   connectWebSocket().then(success => { // connectWebSocket сам устанавливает onopen/onclose etc.
                        resolve(success); // Резолвим промис в зависимости от результата connectWebSocket
                   });
               }
           });


          // Шаг 2: Инициируем или проверяем готовность аудио (AudioContext + MediaStream)
           widgetLog("Step 2: Ensuring AudioContext and MediaStream are ready...");
           // Эта функция должна быть вызвана в ответ на клик! openWidget вызывается кликом.
           const audioReadyPromise = ensureAudioInitializedAndReady();


          // Шаг 3: Ждем готовности и соединения, и аудио
           widgetLog("Step 3: Waiting for both WS connection and audio readiness...");
          const [wsSuccess, audioSuccess] = await Promise.all([wsConnectedPromise, audioReadyPromise]);

          loaderModal.classList.remove('active'); // Скрываем лоадер после завершения попыток

          if (wsSuccess && audioSuccess) {
              widgetLog("Both WS and Audio are ready. Starting listening.");
              isConnected = true; // Убедимся, что флаг соединения установлен
              startListening(); // Запускаем прослушивание
          } else {
              widgetLog(`Failed to open widget fully. WS Ready: ${wsSuccess}, Audio Ready: ${audioSuccess}`, 'error');
              // Если что-то не готово, показываем сообщение или ошибку
              if (!wsSuccess) {
                   showError(connectionFailedPermanently ? "Не удалось подключиться к серверу." : "Ошибка подключения к серверу.");
                   updateConnectionStatus('disconnected', 'Ошибка');
              } else if (!audioSuccess) {
                    // ensureAudioInitializedAndReady уже вызвала showError с причиной
                   updateConnectionStatus('connected', 'Микрофон недоступен'); // Статус соединения ок, но аудио нет
                   mainCircle.classList.remove('listening', 'speaking');
                   mainCircle.classList.add('inactive');
              } else {
                  // Неизвестная ошибка, оба промиса вернули true, но что-то пошло не так?
                  showError("Не удалось инициализировать виджет полностью. Пожалуйста, попробуйте снова.");
                  updateConnectionStatus('disconnected', 'Ошибка'); // Статус не определен
              }
               // Оставляем UI в неактивном состоянии
               mainCircle.classList.remove('listening', 'speaking');
               mainCircle.classList.add('inactive');
               showMessage("Нажмите на микрофон, чтобы начать разговор");
          }

      } catch (error) {
           widgetLog(`Unexpected error during openWidget: ${error.message}`, 'error');
           loaderModal.classList.remove('active');
           showError("Произошла внутренняя ошибка при открытии виджета.");
           updateConnectionStatus('disconnected', 'Ошибка');
           mainCircle.classList.remove('listening', 'speaking');
           mainCircle.classList.add('inactive');
      }

       // Убираем пульсацию с кнопки после попытки открытия
       widgetButton.classList.remove('wellcomeai-pulse-animation');
    }

    // Закрыть виджет
    function closeWidget() {
      widgetLog("Closing widget");

      // Останавливаем все аудио процессы (запись, воспроизведение)
      stopAllAudioProcessing();

      // Скрываем виджет
      widgetContainer.classList.remove('active');
      isWidgetOpen = false;

      // Скрываем сообщения и ошибки
      hideMessage();
      hideError();

      // Скрываем индикатор статуса, если он не показывает постоянную ошибку
      const statusIndicator = document.getElementById('wellcomeai-status-indicator');
      if (statusIndicator && !connectionFailedPermanently) { // Если есть пост.ошибка, оставляем индикатор (или показываем на кнопке)
          statusIndicator.classList.remove('show');
      }

       // Возвращаем круг в неактивное состояние
       const mainCircle = document.getElementById('wellcomeai-main-circle');
        if (mainCircle) {
             mainCircle.classList.remove('listening', 'speaking', 'connecting');
             mainCircle.classList.add('inactive');
        }
       resetAudioVisualization();

      // Принудительно скрываем расширенный виджет
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "0";
        expandedWidget.style.height = "0"; // Сбрасываем высоту
        expandedWidget.style.pointerEvents = "none";
      }

       // Если есть соединение и нет пост. ошибки, добавляем пульсацию на кнопку
       if (isConnected && !connectionFailedPermanently) {
           const widgetButton = document.getElementById('wellcomeai-widget-button');
           if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
       }
    }


  // Инициализация виджета: создание DOM, стилей и добавление обработчиков
  function initializeWidget() {
    widgetLog('Initializing WellcomeAI Widget...');

    // Проверяем, что ID ассистента существует, прежде чем создавать UI
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Widget will not be fully initialized.", 'error');
       // Оставляем только сообщение об ошибке в консоли и, возможно, alert
      // alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
      return; // Прекращаем инициализацию, если нет ID
    }

    // Загружаем необходимые стили и скрипты
    loadFontAwesome();
    createStyles(); // Создаем стили
    createWidgetHTML(); // Создаем HTML структуру

    // Получаем ссылки на основные элементы UI после их создания
    const widgetContainer = document.getElementById('wellcomeai-widget-container');
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    const widgetClose = document.getElementById('wellcomeai-widget-close');
    const mainCircle = document.getElementById('wellcomeai-main-circle');
    const audioBars = document.getElementById('wellcomeai-audio-bars'); // Получаем ссылку для создания баров
    const loaderModal = document.getElementById('wellcomeai-loader-modal'); // Получаем ссылку на лоадер
    const messageDisplay = document.getElementById('wellcomeai-message-display'); // Получаем ссылку на message display
    const errorMessageDiv = document.getElementById('wellcomeai-error-message'); // Получаем ссылку на error message
    const retryButton = errorMessageDiv ? errorMessageDiv.querySelector('#wellcomeai-retry-button') : null; // Получаем ссылку на retry button (будет пересоздаваться)
    const statusIndicator = document.getElementById('wellcomeai-status-indicator'); // Получаем ссылку на status indicator
    const statusDot = document.getElementById('wellcomeai-status-dot'); // Получаем ссылку на status dot
    const statusText = document.getElementById('wellcomeai-status-text'); // Получаем ссылку на status text


    // Проверяем, что все критически важные элементы найдены
    if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !errorMessageDiv || !statusIndicator) {
      widgetLog("Some critical UI elements were not found after creation!", 'error');
      alert('WellcomeAI Widget Error: Critical UI elements not found.');
      return; // Прекращаем инициализацию логики, если нет UI
    }

    // Создаем аудио-бары для визуализации
    createAudioBars(isMobile ? 15 : 20); // Меньше баров на мобильных для производительности

    // Добавляем обработчики событий для интерфейса
    widgetButton.addEventListener('click', function(e) {
      widgetLog('Widget button clicked (Open)');
      e.preventDefault();
      e.stopPropagation();
      openWidget(); // Один клик открывает и инициирует аудио/WS
    });

    widgetClose.addEventListener('click', function(e) {
      widgetLog('Close button clicked');
      e.preventDefault();
      e.stopPropagation();
      closeWidget(); // Закрывает виджет и останавливает все аудиопроцессы
    });

    // Обработчик для основного круга (теперь он тогглит прослушивание, если готов)
    mainCircle.addEventListener('click', function() {
        widgetLog(`Main circle clicked. Current state: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isConnected=${isConnected}, connectionFailedPermanently=${connectionFailedPermanently}`);

        // Действуем только если виджет открыт
        if (!isWidgetOpen) {
            widgetLog("Circle clicked but widget is not open.");
            return; // Игнорируем клики, когда виджет закрыт
        }

         // Если соединение не установлено и не находится в процессе переподключения, или соединение постоянно не работает
         if (!isConnected && !isReconnecting) {
             if (connectionFailedPermanently) {
                 showError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить'.");
             } else {
                  widgetLog("Connection not ready, attempting to connect.");
                  connectWebSocket(); // Пытаемся установить соединение
                  showMessage("Подключение...", 0);
                  updateConnectionStatus('connecting', 'Подключение...');
                  mainCircle.classList.remove('listening', 'speaking');
                  mainCircle.classList.add('inactive');
             }
             return;
         }

        // Если аудио не готово (контекст, стрим, процессор)
        if (!audioContext || audioContext.state !== 'running' || !mediaStream || !audioProcessor) {
            widgetLog("Audio not ready, attempting to ensure audio is ready.");
             // Пытаемся принудительно активировать аудио (внутри обработчика клика)
            ensureAudioInitializedAndReady().then(ready => {
                 if (ready) {
                     widgetLog("Audio is now ready after circle click, attempting to start listening.");
                     startListening(); // Если аудио готово, пытаемся начать слушать
                 } else {
                     widgetLog("Audio is still not ready after circle click.");
                     // ensureAudioInitializedAndReady уже вызвала showError если проблема с микрофоном
                      showMessage("Нажмите на микрофон, чтобы начать разговор"); // Оставляем инструкцию
                      mainCircle.classList.remove('listening', 'speaking');
                      mainCircle.classList.add('inactive');
                 }
            });
            return; // Выходим из текущего обработчика, логика продолжится в промисе ensureAudio...
        }


        // Если и соединение, и аудио готовы: тогглим состояние прослушивания
        if (isListening) {
            // Если сейчас слушаем, останавливаем
            stopListening();
            widgetLog("Stopped listening via circle click.");
        } else if (!isPlayingAudio) {
            // Если не слушаем и не говорим, начинаем слушать
            startListening();
            widgetLog("Started listening via circle click.");
        } else {
            // Если сейчас говорим, игнорируем клик на микрофон (или можно добавить логику прерывания речи)
            widgetLog("Circle clicked while speaking, ignoring.");
        }
    });


     // Обработчик для кнопки повторного подключения/повтора (делегирование, т.к. кнопка пересоздается)
     document.body.addEventListener('click', function(e) {
         const retryButton = e.target.closest('.wellcomeai-retry-button');
         if (retryButton) {
              widgetLog('Retry button clicked.');
              // Определяем, какая ошибка была показана, чтобы понять, что повторять
              const errorMessageDiv = document.getElementById('wellcomeai-error-message');
              const errorText = errorMessageDiv ? errorMessageDiv.textContent : '';

              hideError(); // Скрываем ошибку сразу

              // Логика повтора:
              if (connectionFailedPermanently || errorText.includes('соединение') || !isConnected) {
                  widgetLog("Attempting to retry connection.");
                  resetConnection(); // Сброс состояния соединения и попытка переподключения
              } else if (errorText.includes('микрофон') || !audioContext || audioContext.state !== 'running' || !mediaStream) {
                   widgetLog("Attempting to retry audio initialization.");
                   // Пытаемся снова начать слушать (это вызовет ensureAudioInitializedAndReady)
                   if (isWidgetOpen) {
                        startListening();
                   }
              } else {
                  // Общий повтор - пытаемся просто начать слушать
                   widgetLog("Attempting general retry (start listening).");
                   if (isWidgetOpen) {
                        startListening();
                   } else {
                        // Если виджет закрыт, просто убираем пульсацию
                        const widgetButton = document.getElementById('wellcomeai-widget-button');
                        if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
                   }
              }

         }
     });


    // Инициируем создание аудио графа при загрузке (но без запроса микрофона)
    // Запрос микрофона и активация AudioContext произойдет при первом клике на виджет
     setupAudioGraph().catch(e => {
          widgetLog(`Initial setupAudioGraph failed: ${e.message}`, 'warn');
           // Не блокируем инициализацию виджета из-за этого, т.к. ensureAudio... повторит попытку при клике
     });

    // Инициируем первое подключение WebSocket при загрузке страницы.
    // Если соединение не установится, логика переподключения позаботится об этом.
     // Loader показывается только при открытом виджете, но статус "Connecting..." может быть показан.
     // При первом запуске лоадер показывается по умолчанию в HTML. Скроем его после первой попытки подключения.
    connectWebSocket().then(() => {
         // Лоадер будет скрыт в onopen или onclose/onerror
    }).catch(() => {
         // Лоадер будет скрыт в onerror или onclose
    });


    widgetLog('WellcomeAI Widget initialization complete');

    // Показываем лоадер при загрузке страницы (он уже в HTML)
    const loaderModalElement = document.getElementById('wellcomeai-loader-modal');
    if (loaderModalElement) {
        // Убираем лоадер через 2 секунды после начала инициализации, если он не был убран раньше
        // (например, быстрым коннектом). Это для случаев, когда соединение не устанавливается сразу.
        setTimeout(() => {
             if (loaderModalElement.classList.contains('active')) {
                 widgetLog("Hiding loader after initial timeout.");
                 loaderModalElement.classList.remove('active');
                 // Если соединение еще не установлено или ошибка, показываем пульсацию на кнопке
                  if (!isConnected && !isReconnecting && !connectionFailedPermanently) {
                       const widgetButton = document.getElementById('wellcomeai-widget-button');
                       if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                       updateConnectionStatus('connecting', 'Ожидание соединения...'); // Обновляем статус индикатора
                  } else if (connectionFailedPermanently) {
                      const widgetButton = document.getElementById('wellcomeai-widget-button');
                      if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                      updateConnectionStatus('disconnected', 'Отключено');
                  }
             }
        }, 2000); // Ждем 2 секунды
    }


     // Проверка состояния DOM и виджета через некоторое время после инициализации (для отладки)
    if (DEBUG_MODE) {
        setTimeout(function() {
          widgetLog('DEBUG: State check after initialization timeout.');
          widgetLog(`DEBUG: WS state = ${websocket ? websocket.readyState : 'No websocket'}`);
          widgetLog(`DEBUG: Audio state = context: ${audioContext ? audioContext.state : 'none'}, stream: ${!!mediaStream}, processor: ${!!audioProcessor}`);
          widgetLog(`DEBUG: Widget flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}, connectionFailedPermanently: ${connectionFailedPermanently}`);
          widgetLog(`DEBUG: Audio flags = hasAudioData: ${hasAudioData}, isSilent: ${isSilent}`);
           const widgetButton = document.getElementById('wellcomeai-widget-button');
            if (widgetButton) {
                 widgetLog(`DEBUG: Button pulse animation: ${widgetButton.classList.contains('wellcomeai-pulse-animation')}`);
            }
           const loaderModalElement = document.getElementById('wellcomeai-loader-modal');
            if (loaderModalElement) {
                 widgetLog(`DEBUG: Loader active: ${loaderModalElement.classList.contains('active')}`);
            }
           const errorElement = document.getElementById('wellcomeai-error-message');
            if (errorElement) {
                 widgetLog(`DEBUG: Error message visible: ${errorElement.classList.contains('visible')}`);
                 widgetLog(`DEBUG: Error message text: ${errorElement.textContent.substring(0, 50)}...`);
            }
            const messageElement = document.getElementById('wellcomeai-message-display');
            if (messageElement) {
                 widgetLog(`DEBUG: Message display visible: ${messageElement.classList.contains('show')}`);
                 widgetLog(`DEBUG: Message display text: ${messageElement.textContent.substring(0, 50)}...`);
            }
            const statusElement = document.getElementById('wellcomeai-status-indicator');
             if (statusElement) {
                  widgetLog(`DEBUG: Status indicator visible: ${statusElement.classList.contains('show')}`);
                  widgetLog(`DEBUG: Status text: ${statusText.textContent}`);
             }


        }, 5000); // Проверка через 5 секунд
    }
  }

  // Проверяем, есть ли уже виджет на странице или идет ли загрузка
  // Если DOM уже готов, инициализируем сразу. Иначе - по событию DOMContentLoaded.
  // Также добавляем проверку, чтобы не запускать инициализацию несколько раз.
  const existingContainer = document.getElementById('wellcomeai-widget-container');
  const existingStyles = document.getElementById('wellcomeai-widget-styles');
  const initializingScript = document.querySelector('script[src*="widget.js"][data-initialized]');

  if (!existingContainer && !existingStyles && !initializingScript) {
      widgetLog('Starting WellcomeAI Widget initialization process');
      // Помечаем скрипт как инициализирующийся, чтобы избежать двойного запуска
      const currentScript = document.currentScript;
      if (currentScript) {
          currentScript.setAttribute('data-initialized', 'true');
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeWidget);
        widgetLog('Will initialize on DOMContentLoaded');
      } else {
        widgetLog('DOM already loaded, initializing immediately');
        initializeWidget();
      }
  } else {
    widgetLog('WellcomeAI Widget or initialization already exists on the page, skipping.', 'warn');
     if (existingContainer) widgetLog('Existing container found.', 'warn');
     if (existingStyles) widgetLog('Existing styles found.', 'warn');
     if (initializingScript) widgetLog('Initialization already started by another script tag.', 'warn');
  }
})();
