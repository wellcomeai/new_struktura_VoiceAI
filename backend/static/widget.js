(function() {
  // --- Константы и Настройки ---
  const DEBUG_MODE = true; // Включаем отладочный режим для тестирования
  const MAX_RECONNECT_ATTEMPTS = 10; // Максимальное количество попыток переподключения
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 15; // Увеличено для мобильных
  const PING_INTERVAL = 15000; // Интервал отправки ping (мс)
  const MOBILE_PING_INTERVAL = 10000; // Более частые пинги для мобильных
  const CONNECTION_TIMEOUT = 25000; // Таймаут для установления соединения (мс) - увеличено
  const AUDIO_SEND_INTERVAL = 100; // Интервал отправки аудио пакетов на сервер (мс)
  const UI_MESSAGE_DURATION = 4000; // Длительность показа временных сообщений UI (мс) - уменьшено
  const AUDIO_COMMIT_MIN_LENGTH = 100; // Минимальная длина аудио для отправки на сервер после "коммита" (мс)

  // --- Глобальные Переменные Состояния (инкапсулированы в IIFE) ---
  let websocket = null;
  let audioContext = null; // Контекст для Input/Output
  let mediaStream = null; // Поток с микрофона
  let audioProcessor = null; // Node для обработки аудио
  let clientAudioBuffer = []; // Буфер для накопления аудио перед отправкой на сервер
  let audioSendTimer = null; // Таймер для периодической отправки буфера
  let audioPlaybackQueue = []; // Очередь для воспроизведения аудио
  let audioBufferSourceNode = null; // Текущий воспроизводимый AudioBufferSourceNode
  let audioPlaybackStartTime = 0; // Время начала воспроизведения текущего буфера
  let audioPlaybackOffset = 0; // Смещение в текущем буфере
  let pingIntervalId = null; // ID таймера для ping
  let connectionTimeoutId = null; // ID таймаута соединения
  let retryConnectTimerId = null; // ID таймера для повторного подключения
  let messageDisplayTimerId = null; // ID таймера для скрытия сообщения UI
  let audioDataAccumulated = false; // Флаг, показывающий, были ли записаны аудиоданные в текущем сегменте

  // --- Управление Состоянием Виджета ---
  const widgetState = {
    current: 'LOADING', // Состояния: 'LOADING', 'IDLE', 'CONNECTING', 'CONNECTED', 'LISTENING', 'SPEAKING', 'RECONNECTING', 'ERROR'
    message: '', // Сообщение для отображения пользователю
    isConnected: false,
    isWidgetOpen: false,
    isListening: false,
    isPlayingAudio: false,
    isReconnecting: false,
    isMicInitialized: false, // Флаг успешной инициализации микрофона/аудио контекста
    connectionFailedPermanently: false // Флаг невосстановимой ошибки соединения
  };

  // --- Определение Устройства ---
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  // --- DOM Элементы (собираются после создания HTML) ---
  const elements = {};

  // --- Вспомогательные Функции ---

  // Логирование
  const widgetLog = (message, type = 'info') => {
    const prefix = '[WellcomeAI Widget]';
    const timestamp = new Date().toISOString().slice(11, 23);
    const logMessage = `${prefix} ${timestamp} | ${type.toUpperCase()} | ${message}`;

    // Для Render.com или любого хостинга, где console.* перенаправляется
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      console.log(logMessage); // Render собирает console.log
    } else if (DEBUG_MODE || type === 'error' || type === 'warn') {
      // Для локальной разработки или важных сообщений
      if (type === 'error') console.error(logMessage);
      else if (type === 'warn') console.warn(logMessage);
      else if (DEBUG_MODE) console.log(logMessage);
    }
  };

  // Сбор DOM элементов после их создания
  const getDOMElements = () => {
    // Ищем контейнер виджета. Если он уже есть, значит элементы уже созданы.
    if (!elements.widgetContainer) {
        elements.widgetContainer = document.getElementById('wellcomeai-widget-container');
    }

    if (!elements.widgetContainer) {
        // Если контейнер не найден, возможно, HTML еще не создан или есть проблема
        return false;
    }

    // Теперь собираем все остальные элементы внутри контейнера
    elements.widgetButton = elements.widgetContainer.querySelector('#wellcomeai-widget-button');
    elements.widgetClose = elements.widgetContainer.querySelector('#wellcomeai-widget-close');
    elements.mainCircle = elements.widgetContainer.querySelector('#wellcomeai-main-circle');
    elements.audioBarsContainer = elements.widgetContainer.querySelector('#wellcomeai-audio-bars');
    elements.loaderModal = elements.widgetContainer.querySelector('#wellcomeai-loader-modal');
    elements.messageDisplay = elements.widgetContainer.querySelector('#wellcomeai-message-display');
    elements.connectionError = elements.widgetContainer.querySelector('#wellcomeai-connection-error');
    // elements.retryButton - этот элемент создается динамически внутри connectionError
    elements.statusIndicator = elements.widgetContainer.querySelector('#wellcomeai-status-indicator');
    elements.statusDot = elements.widgetContainer.querySelector('#wellcomeai-status-dot');
    elements.statusText = elements.widgetContainer.querySelector('#wellcomeai-status-text');
    elements.iosAudioButton = elements.widgetContainer.querySelector('#wellcomeai-ios-audio-button');
    elements.widgetExpanded = elements.widgetContainer.querySelector('#wellcomeai-widget-expanded');


    // Проверка наличия основных элементов
    if (!elements.widgetButton || !elements.widgetClose || !elements.mainCircle || !elements.audioBarsContainer || !elements.loaderModal || !elements.messageDisplay || !elements.statusIndicator || !elements.statusDot || !elements.statusText || !elements.widgetExpanded) {
      widgetLog("ERROR: One or more essential UI elements not found *within* the container!", 'error');
       // Попытка создать аудио бары на случай, если контейнер найден, но бары нет (например, ошибка в createWidgetHTML)
       if (elements.audioBarsContainer && elements.audioBarsContainer.children.length === 0) {
            createAudioBars();
       }
      return false;
    }
    //widgetLog("All essential UI elements found.");
    return true;
  };

  // Обновление UI на основе текущего состояния
  const updateUI = () => {
    if (!getDOMElements()) {
        widgetLog("UI Update: Essential DOM elements not found.", 'warn');
        return; // Не обновляем UI, если элементы недоступны
    }

    // Обновление основного контейнера
    if (widgetState.isWidgetOpen) {
      elements.widgetContainer.classList.add('active');
      // Принудительное управление стилями для большей надежности на конструкторах
      elements.widgetContainer.style.opacity = '1';
      elements.widgetContainer.style.pointerEvents = 'all';
      elements.widgetContainer.style.zIndex = '2147483647'; // Агрессивный z-index

      // Управление развернутым виджетом
       elements.widgetExpanded.style.height = '400px';
       elements.widgetExpanded.style.opacity = '1';
       elements.widgetExpanded.style.pointerEvents = 'all';
       elements.widgetExpanded.style.zIndex = '2147483646'; // Ниже кнопки

    } else {
      elements.widgetContainer.classList.remove('active');
       elements.widgetExpanded.style.height = '0';
       elements.widgetExpanded.style.opacity = '0';
       elements.widgetExpanded.style.pointerEvents = 'none';
    }

    // Обновление состояния основного круга (микрофона)
    elements.mainCircle.classList.remove('listening', 'speaking');
    if (widgetState.isListening) {
      elements.mainCircle.classList.add('listening');
    } else if (widgetState.isPlayingAudio) {
      elements.mainCircle.classList.add('speaking');
    } else {
       resetAudioVisualization(); // Сброс визализации, когда не слушаем и не говорим
    }


    // Управление лоадером
    if (widgetState.current === 'LOADING' || widgetState.current === 'CONNECTING' || widgetState.current === 'RECONNECTING') {
      elements.loaderModal.classList.add('active');
    } else {
       elements.loaderModal.classList.remove('active');
    }

    // Управление сообщением UI
    if (widgetState.message) {
        elements.messageDisplay.textContent = widgetState.message;
        elements.messageDisplay.classList.add('show');
    } else {
       elements.messageDisplay.classList.remove('show');
    }

    // Управление ошибкой соединения
    if (widgetState.current === 'ERROR' && widgetState.connectionFailedPermanently) {
       // Сообщение об ошибке показывается только если она невосстановима
       showConnectionError("Не удалось подключиться к серверу. Нажмите кнопку ниже.");
    } else {
       hideConnectionError();
    }

    // Управление кнопкой iOS активации аудио
    // Показываем кнопку, если iOS, виджет открыт, микрофон еще не инициализирован,
    // и мы находимся в состоянии IDLE или CONNECTED (ожидаем активации пользователем)
    if (isIOS && !widgetState.isMicInitialized && widgetState.isWidgetOpen && (widgetState.current === 'IDLE' || widgetState.current === 'CONNECTED' || widgetState.current === 'ERROR')) {
       elements.iosAudioButton.classList.add('visible');
    } else {
       elements.iosAudioButton.classList.remove('visible');
    }

    // Управление индикатором статуса
    // Показываем индикатор, если виджет открыт И мы не в состоянии IDLE (IDLE - это когда виджет закрыт)
    if (widgetState.isWidgetOpen && widgetState.current !== 'IDLE') {
        elements.statusIndicator.classList.add('show');
        if (widgetState.current === 'CONNECTED') {
            elements.statusDot.className = 'wellcomeai-status-dot connected';
            elements.statusText.textContent = 'Подключено';
        } else if (widgetState.current === 'CONNECTING' || widgetState.current === 'RECONNECTING' || widgetState.current === 'LOADING') {
            elements.statusDot.className = 'wellcomeai-status-dot connecting';
            elements.statusText.textContent = widgetState.current === 'LOADING' ? 'Загрузка...' : 'Подключение...';
        } else if (widgetState.current === 'ERROR') {
            elements.statusDot.className = 'wellcomeai-status-dot disconnected';
            elements.statusText.textContent = widgetState.connectionFailedPermanently ? 'Отключено' : 'Ошибка';
        } else if (widgetState.current === 'LISTENING') {
             elements.statusDot.className = 'wellcomeai-status-dot connected'; // Можно использовать connected или другой цвет
             elements.statusText.textContent = 'Слушаю...';
        } else if (widgetState.current === 'SPEAKING') {
             elements.statusDot.className = 'wellcomeai-status-dot connected'; // Можно использовать connected или другой цвет
             elements.statusText.textContent = 'Говорю...';
        } else {
             elements.statusDot.className = 'wellcomeai-status-dot'; // Default
             elements.statusText.textContent = '';
        }
    } else {
         elements.statusIndicator.classList.remove('show');
    }

     // Управление пульсацией кнопки (для привлечения внимания к необходимости открыть виджет или переподключиться)
     if (!widgetState.isWidgetOpen && (widgetState.isConnected || widgetState.current === 'ERROR')) {
         elements.widgetButton.classList.add('wellcomeai-pulse-animation');
     } else {
         elements.widgetButton.classList.remove('wellcomeai-pulse-animation');
     }
  };

  // Функция смены состояния
  const updateState = (newState, message = '') => {
    if (widgetState.current === newState) {
        //widgetLog(`State already ${newState}, updating message only.`);
         widgetState.message = message;
          if (messageDisplayTimerId) {
               clearTimeout(messageDisplayTimerId);
               messageDisplayTimerId = null;
          }
          if (message && newState !== 'ERROR' && UI_MESSAGE_DURATION > 0) {
               messageDisplayTimerId = setTimeout(() => {
                   widgetState.message = '';
                   updateUI();
               }, UI_MESSAGE_DURATION);
          }
         updateUI(); // Обновляем UI даже если состояние то же, т.к. могло измениться сообщение
         return;
    }

    widgetLog(`State transition: ${widgetState.current} -> ${newState}`);
    widgetState.current = newState;
    widgetState.message = message; // Устанавливаем или очищаем сообщение UI

    // Обновляем основные флаги в соответствии с новым состоянием
    widgetState.isConnected = (newState === 'CONNECTED' || newState === 'LISTENING' || newState === 'SPEAKING');
    widgetState.isListening = (newState === 'LISTENING');
    widgetState.isPlayingAudio = (newState === 'SPEAKING');
    widgetState.isReconnecting = (newState === 'RECONNECTING');
    // Флаг connectionFailedPermanently управляется отдельно

    // Сброс таймера сообщения, если устанавливается новое или меняется состояние
    if (messageDisplayTimerId) {
      clearTimeout(messageDisplayTimerId);
      messageDisplayTimerId = null;
    }

    // Запускаем таймер для скрытия сообщения, если оно временное (есть message и не 'ERROR')
    // Сообщения в состояниях LOADING, CONNECTING, RECONNECTING тоже могут быть временными, если не приведут к ошибке.
    // Оставим логику скрытия через UI_MESSAGE_DURATION для всех состояний, кроме ERROR с постоянной ошибкой.
    if (message && !(newState === 'ERROR' && widgetState.connectionFailedPermanently) && UI_MESSAGE_DURATION > 0) {
        messageDisplayTimerId = setTimeout(() => {
            widgetState.message = ''; // Очищаем сообщение
            updateUI(); // Обновляем UI, чтобы скрыть сообщение
        }, UI_MESSAGE_DURATION);
    }


    updateUI(); // Обновляем пользовательский интерфейс
  };

   // Показать ошибку соединения с кнопкой повтора
  const showConnectionError = (message) => {
    if (getDOMElements() && elements.connectionError) {
        // Проверяем, есть ли уже кнопка, чтобы не добавлять несколько раз
        let retryBtn = elements.connectionError.querySelector('#wellcomeai-retry-button');
        if (!retryBtn) {
            elements.connectionError.innerHTML = `
              ${message || 'Ошибка соединения с сервером'}
              <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
                Повторить подключение
              </button>
            `;
             retryBtn = elements.connectionError.querySelector('#wellcomeai-retry-button');
             if(retryBtn) {
                 retryBtn.onclick = resetConnection; // Добавляем обработчик
             }
        } else {
             // Если кнопка уже есть, просто обновляем текст сообщения
             const textNode = elements.connectionError.firstChild; // Текстовый узел перед кнопкой
             if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                 textNode.nodeValue = message || 'Ошибка соединения с сервером';
             } else {
                 // Если структура изменилась, пересоздаем innerHTML
                 elements.connectionError.innerHTML = `
                   ${message || 'Ошибка соединения с сервером'}
                   <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
                     Повторить подключение
                   </button>
                 `;
                  retryBtn = elements.connectionError.querySelector('#wellcomeai-retry-button');
                  if(retryBtn) {
                      retryBtn.onclick = resetConnection;
                  }
             }
        }
        elements.connectionError.classList.add('visible');
    }
  };

  // Скрыть ошибку соединения
  const hideConnectionError = () => {
    if (getDOMElements() && elements.connectionError) {
        elements.connectionError.classList.remove('visible');
    }
  };

  // Получить URL сервера
  const getServerUrl = () => {
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;

    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-server') || (scriptTags[i].dataset && scriptTags[i].dataset.server)) {
        serverUrl = scriptTags[i].getAttribute('data-server') || scriptTags[i].dataset.server;
        widgetLog(`Found server URL from script attribute: ${serverUrl}`);
        break;
      }
      const src = scriptTags[i].getAttribute('src');
      if (src && (src.includes('widget.js') || src.includes('wellcomeai-widget.min.js'))) { // Ищем скрипт виджета по имени файла (добавил .min.js)
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
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }

    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com'; // Fallback URL
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }

    return serverUrl.replace(/\/$/, ''); // Убираем конечный слеш
  };

  // Получить ID ассистента
  const getAssistantId = () => {
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      const data = scriptTags[i].dataset;
      if (data && (data.assistantId || data.assistantid)) { // Проверяем оба варианта
        const id = data.assistantId || data.assistantid;
        widgetLog(`Found assistant ID from dataset: ${id}`);
        return id;
      }
      if (scriptTags[i].hasAttribute('data-assistantId') || scriptTags[i].hasAttribute('data-assistantid')) {
        const id = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid');
        widgetLog(`Found assistant ID from attribute: ${id}`);
        return id;
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

     // Для демонстрации
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo';
    }

    widgetLog('No assistant ID found!', 'error');
    return null;
  };

    // Получение позиции виджета
    const getWidgetPosition = () => {
        const defaultPosition = { horizontal: 'right', vertical: 'bottom', distance: '20px' };
        const scriptTags = document.querySelectorAll('script');
        for (let i = 0; i < scriptTags.length; i++) {
            const data = scriptTags[i].dataset;
            if (data && data.position) {
                return parsePosition(data.position);
            }
             if (scriptTags[i].hasAttribute('data-position')) {
                 return parsePosition(scriptTags[i].getAttribute('data-position'));
             }
        }
        return defaultPosition;

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
             // Парсинг расстояния (опционально, можно добавить в data-distance)
             // Пока не реализовано, используется дефолтное.
            return position;
        }
    };

  // Конфигурация виджета
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID;

  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Android/Mobile' : 'Desktop')}`);


  // --- Аудио Вспомогательные Функции ---

  // Создание AudioContext (с учетом префикса для старых браузеров)
  const createAudioContext = () => {
      if (audioContext) {
          // Проверка и попытка возобновления для существующего контекста
           if (audioContext.state === 'suspended') {
               widgetLog('Existing AudioContext is suspended, attempting to resume...');
               audioContext.resume().then(() => {
                   widgetLog('Existing AudioContext resumed successfully.');
                   widgetState.isMicInitialized = true; // Считаем инициализированным после resume
                   updateUI();
               }).catch(err => {
                    widgetLog(`Failed to resume existing AudioContext: ${err.message}`, 'error');
                    widgetState.isMicInitialized = false; // Сброс флага, если не удалось
                    updateUI();
               });
           } else {
                widgetState.isMicInitialized = true; // Контекст сразу активен
                updateUI();
           }
          return audioContext; // Используем существующий контекст
      }

      try {
          // Опции контекста - можно адаптировать sample rate
          // Желаемый sample rate для сервера, например 16000 или 24000
          const targetSampleRate = 16000; // Установите Sample Rate, который ожидает ваш сервер ASR

          // Браузер может не поддерживать желаемый Sample Rate напрямую в конструкторе.
          // Создаем контекст с настройками по умолчанию, затем будем пересэмплировать, если нужно.
           const contextOptions = isMobile ? {} : { sampleRate: targetSampleRate }; // Мобильные часто игнорируют sampleRate в конструкторе


          audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
          widgetLog(`AudioContext created. Browser's sample rate: ${audioContext.sampleRate}. Target: ${targetSampleRate}`);

           // Если sample rate отличается от целевого, потребуется пересэмплирование
           if (audioContext.sampleRate !== targetSampleRate) {
               widgetLog(`Warning: Browser's sample rate (${audioContext.sampleRate}) differs from target (${targetSampleRate}). Resampling will be needed.`, 'warn');
               // TODO: Реализовать пересэмплирование в onaudioprocess или использовать AudioWorklet
               // Для простоты в этом коде пока предполагаем, что сервер может обработать разный SR,
               // или что браузер выберет близкий. Реальное пересэмплирование нужно для качества.
           }


           // Проверка и попытка возобновления, если нужно (особенно на iOS/мобильных)
           if (audioContext.state === 'suspended') {
               widgetLog('New AudioContext is suspended, attempting to resume...');
               audioContext.resume().then(() => {
                   widgetLog('New AudioContext resumed successfully.');
                   widgetState.isMicInitialized = true; // Считаем инициализированным после resume
                   updateUI();
               }).catch(err => {
                    widgetLog(`Failed to resume new AudioContext: ${err.message}`, 'error');
                    // Возможно, потребуется пользовательское взаимодействие
                    widgetState.isMicInitialized = false;
                    updateUI();
               });
           } else {
                widgetState.isMicInitialized = true; // Контекст сразу активен
                updateUI();
           }


          return audioContext;
      } catch (e) {
          widgetLog(`Error creating AudioContext: ${e.message}`, 'error');
          audioContext = null;
          widgetState.isMicInitialized = false;
          updateUI();
          return null;
      }
  };

    // Инициализация микрофона и аудио-обработки
    const initMic = async () => {
        if (widgetState.isMicInitialized && mediaStream && audioContext) {
             // Проверка, что контекст активен
             if (audioContext.state === 'running') {
                 widgetLog("Микрофон и AudioContext уже инициализированы и активны.");
                 return true;
             } else if (audioContext.state === 'suspended') {
                  widgetLog("Микрофон и AudioContext инициализированы, но контекст приостановлен. Попытка возобновить...");
                 try {
                     await audioContext.resume();
                      widgetLog("AudioContext успешно возобновлен.");
                      widgetState.isMicInitialized = true; // Подтверждаем инициализацию
                      updateUI();
                      return true;
                 } catch (err) {
                      widgetLog(`Не удалось возобновить AudioContext: ${err.message}`, 'error');
                      // На iOS может потребоваться пользовательский клик
                      if (isIOS && getDOMElements() && elements.iosAudioButton) {
                           elements.iosAudioButton.classList.add('visible');
                          updateState('CONNECTED', "Нажмите кнопку ниже для активации микрофона");
                      } else {
                           updateState('ERROR', 'Ошибка активации микрофона.');
                      }
                      widgetState.isMicInitialized = false; // Сбрасываем флаг, если не удалось
                      updateUI();
                     return false;
                 }
             }
             // Если состояние 'closed', нужно пересоздать
             if (audioContext.state === 'closed') {
                 widgetLog("AudioContext был закрыт. Пересоздаем.");
                 audioContext = null; // Очищаем ссылку
                 widgetState.isMicInitialized = false; // Сбрасываем флаг
             } else {
                 widgetLog(`Микрофон и AudioContext в состоянии: ${audioContext.state}. Не начинаем initMic.`);
                 return false; // В другом неизвестном состоянии
             }
        }

        widgetLog("Инициализация микрофона...");

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
             widgetLog("Ваш браузер не поддерживает доступ к микрофону.", 'error');
             updateState('ERROR', 'Ошибка: Доступ к микрофону не поддерживается.');
             widgetState.connectionFailedPermanently = true; // Это фатальная ошибка для функционала
             return false;
        }

         // Создаем AudioContext, если он еще не создан или был закрыт
         const ctx = createAudioContext();
         if (!ctx || ctx.state === 'closed') {
              widgetLog("Не удалось создать или возобновить AudioContext.", 'error');
              updateState('ERROR', 'Ошибка: Не удалось создать AudioContext.');
               widgetState.connectionFailedPermanently = true;
              return false;
         }

        // Конфигурация захвата аудио - адаптируем под мобильные/iOS
        const audioConstraints = isIOS ?
           {
             echoCancellation: false, // Отключаем для iOS - может мешать
             noiseSuppression: true, // Полагаемся на системное ШП
             autoGainControl: true, // Полагаемся на системную АРУ
             // sampleRate: 16000 // Браузер может проигнорировать
           } :
           isMobile ?
           {
             echoCancellation: true, // Включаем для Android
             noiseSuppression: true,
             autoGainControl: true,
             // sampleRate: 16000 // Браузер может проигнорировать
           } :
           {
             echoCancellation: true, // Настройки для десктопа
             noiseSuppression: true,
             autoGainControl: true,
             // sampleRate: 24000 // Предпочитаемый sample rate, но может быть изменен браузером
           };

        try {
            // Запрашиваем поток с микрофона
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
            widgetLog(`Доступ к микрофону получен. Фактический Sample Rate потока: ${ctx.sampleRate} Гц`);

            const streamSource = ctx.createMediaStreamSource(mediaStream);

            // Использование ScriptProcessorNode (устаревший, но широко поддерживаемый)
            // Альтернатива: AudioWorklet (современнее, но меньшая поддержка в старых браузерах)
            // Выбираем размер буфера: 2^n, типичные значения: 256, 512, 1024, 2048, 4096, 8192, 16384
            // Больший буфер = меньше вызовов onaudioprocess, но большая задержка.
            // Меньший буфер = больше вызовов, меньшая задержка, но выше нагрузка CPU.
            // Для мобильных устройств и стабильности часто используются большие буферы.
            const bufferSize = isIOS ? 4096 : (isMobile ? 2048 : 4096);
            // Проверка на допустимые размеры буфера для ScriptProcessorNode
            const validBufferSizes = [256, 512, 1024, 2048, 4096, 8192, 16384];
            if (validBufferSizes.indexOf(bufferSize) === -1) {
                widgetLog(`Warning: Chosen bufferSize (${bufferSize}) is not a standard ScriptProcessorNode size. Using 4096.`, 'warn');
                 bufferSize = 4096; // Fallback к стандартному размеру
            }

            if (ctx.createScriptProcessor) {
                 audioProcessor = ctx.createScriptProcessor(bufferSize, 1, 1);
                 widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
            } else if (ctx.createJavaScriptNode) { // Fallback для старых Safari
                 audioProcessor = ctx.createJavaScriptNode(bufferSize, 1, 1);
                 widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${bufferSize}`);
            } else {
                 throw new Error("Браузер не поддерживает обработку аудио (ScriptProcessorNode/JavaScriptNode).");
            }


            // Обработчик аудиопроцессинга
            audioProcessor.onaudioprocess = function(e) {
              if (!widgetState.isListening || !websocket || websocket.readyState !== WebSocket.OPEN) {
                // Если не слушаем или WS не открыт, просто возвращаемся
                // Очищаем буфер только при явной остановке, а не на каждом вызове, если не слушаем
                // clientAudioBuffer = []; // Это может привести к потере данных
                return;
              }

              const inputBuffer = e.inputBuffer.getChannelData(0);
              if (inputBuffer.length === 0) return;

              // --- Визуализация аудио ---
              updateAudioVisualization(inputBuffer);

              // --- Обработка и буферизация аудио для отправки ---
              // Преобразование Float32Array (полученного из микрофона) в Int16Array (для отправки)
              const pcm16Data = new Int16Array(inputBuffer.length);
              let maxAmplitude = 0;
              for (let i = 0; i < inputBuffer.length; i++) {
                 const sample = inputBuffer[i];
                 pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
                 maxAmplitude = Math.max(maxAmplitude, Math.abs(sample));
              }

               // Добавляем данные в клиентский буфер (как ArrayBuffer)
              clientAudioBuffer.push(pcm16Data.buffer); // Накапливаем буферы

              // Проверяем, появились ли хоть какие-то звуковые данные
              const soundThreshold = isIOS ? 0.005 : 0.01; // Чувствительность к звуку. Можно адаптировать.
               // Если обнаружен звук ВПЕРВЫЕ в текущем сегменте записи
              if (!audioDataAccumulated && maxAmplitude > soundThreshold) {
                  audioDataAccumulated = true;
                  widgetLog("Обнаружены первые звуковые данные в сегменте.");
                   // Тут можно начать отслеживать таймер активности/тишины, если нужен клиентский VAD
                   // или отправить специальный маркер на сервер.
              }
            };

            // Подключаем узлы: Источник (микрофон) -> Обработчик -> ...
            streamSource.connect(audioProcessor);

            // Для iOS и Android: не подключаем processor напрямую к destination,
            // чтобы избежать обратной связи и эха. Используем GainNode с громкостью 0.
             const gainNode = ctx.createGain();
             gainNode.gain.value = 0;
             audioProcessor.connect(gainNode);
             gainNode.connect(ctx.destination);
             widgetLog('Используем нулевой gainNode для предотвращения обратной связи');

             widgetState.isMicInitialized = true; // Микрофон успешно инициализирован
             updateUI();
             return true; // Успех
        } catch (err) {
            widgetLog(`Ошибка при доступе или инициализации микрофона: ${err.name} - ${err.message}`, 'error');
            // Очищаем ресурсы, если не удалось
            if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
            }
             if (audioProcessor) {
                 audioProcessor.disconnect();
                 audioProcessor = null;
             }
             // Note: AudioContext не закрываем, т.к. он может использоваться для воспроизведения

            widgetState.isMicInitialized = false; // Инициализация микрофона не удалась
            updateUI();
            // Сообщение об ошибке будет показано UI через updateState в handleMainCircleClick или openWidget
            return false; // Неудача
        }
    };


    // Запуск таймера для отправки аудио-буфера на сервер
    const startAudioSendTimer = () => {
      if (audioSendTimer) {
        clearInterval(audioSendTimer);
      }
      // Отправляем собранные данные регулярно
      audioSendTimer = setInterval(sendAudioBufferChunk, AUDIO_SEND_INTERVAL);
      // widgetLog(`Таймер отправки аудио запущен с интервалом ${AUDIO_SEND_INTERVAL} мс`);
    };

    // Остановка таймера отправки аудио-буфера
    const stopAudioSendTimer = () => {
      if (audioSendTimer) {
        clearInterval(audioSendTimer);
        audioSendTimer = null;
      }
      // widgetLog("Таймер отправки аудио остановлен.");
    };

    // Отправка накопленного аудио-буфера на сервер
    const sendAudioBufferChunk = () => {
      if (!websocket || websocket.readyState !== WebSocket.OPEN || clientAudioBuffer.length === 0 || widgetState.isReconnecting) {
        // widgetLog("Пропуск отправки аудио чанка (WS не готов, буфер пуст, или идет переподключение)", "debug");
        return;
      }

       // Объединяем все ArrayBuffers в clientAudioBuffer
       const totalLength = clientAudioBuffer.reduce((sum, buffer) => sum + buffer.byteLength, 0);
       if (totalLength === 0) {
           clientAudioBuffer = []; // Очищаем на всякий случай
           return;
       }

       // Создаем один большой Int16Array из всех буферов
       const combinedBuffer = new Uint8Array(totalLength);
       let offset = 0;
       for (const buffer of clientAudioBuffer) {
           combinedBuffer.set(new Uint8Array(buffer), offset);
           offset += buffer.byteLength;
       }

       // Очищаем клиентский буфер после сборки
       clientAudioBuffer = [];

      try {
        // Преобразуем объединенный буфер в Base64 и отправляем
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.append",
          event_id: `audio_chunk_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, // Уникальный ID для каждого чанка
          audio: arrayBufferToBase64(combinedBuffer.buffer)
        }));
         // widgetLog(`Отправлен аудио чанк ${combinedBuffer.buffer.byteLength} байт`, "debug"); // Осторожно, может генерировать много логов
      } catch (error) {
        widgetLog(`Ошибка отправки аудио чанка: ${error.message}`, "error");
        // Если ошибка отправки, возможно, соединение нестабильно.
        // WS onclose/onerror должны обрабатывать переподключение.
      }
    };

     // Сигнал "коммита" буфера на сервере (например, по кнопке Стоп или после детектирования тишины на сервере)
     const commitAudioBuffer = () => {
       if (!websocket || websocket.readyState !== WebSocket.OPEN || widgetState.isReconnecting) {
          widgetLog("Невозможно отправить команду commit (WS не готов)", "warn");
          return;
       }

       // Перед отправкой commit, отправляем все оставшиеся данные в буфере
       sendAudioBufferChunk(); // Отправляем все, что осталось в буфере

        // Проверяем, были ли вообще какие-то данные отправлены в текущем сегменте прослушивания
        // Это флаг audioDataAccumulated, который ставится в onaudioprocess при обнаружении звука.
        // if (!audioDataAccumulated) {
        //    widgetLog("Нет накопленных аудио данных для коммита. Не отправляем команду commit.", "warn");
            // Просто останавливаем прослушивание, но не сигнализируем серверу об окончании фразы
            // stopListening(); // stopListening уже вызывается перед commit в handleMainCircleClick
            // return;
        // }

        // Отправляем команду commit
       websocket.send(JSON.stringify({
         type: "input_audio_buffer.commit",
         event_id: `commit_${Date.now()}`
       }));
       widgetLog("Отправлена команда input_audio_buffer.commit");

        audioDataAccumulated = false; // Сбрасываем флаг после коммита
     };


    // Начало прослушивания
    const startListening = async () => {
        // Проверка предварительных условий
        if (!widgetState.isConnected || widgetState.isListening || widgetState.isPlayingAudio || widgetState.isReconnecting || widgetState.current === 'ERROR') {
             widgetLog(`Cannot start listening: isConnected=${widgetState.isConnected}, isListening=${widgetState.isListening}, isPlayingAudio=${widgetState.isPlayingAudio}, isReconnecting=${widgetState.isReconnecting}, state=${widgetState.current}`);
             // Если виджет открыт, но не можем начать слушать, и это не ошибка соединения, возможно, проблема с микрофоном.
             if (widgetState.isWidgetOpen && widgetState.current !== 'ERROR' && !widgetState.isReconnecting && !widgetState.isConnected) {
                  // Это может быть состояние, когда WS подключен ('CONNECTED'), но микрофон не инициализирован ('isMicInitialized: false')
                  // handleMainCircleClick или openWidget должны были вызвать initMic.
                  // Если они не смогли, initMic уже показал ошибку или iOS кнопку.
                  // Здесь просто логируем и выходим.
             }
             return;
        }

        widgetLog('Attempting to start listening...');

         // Инициализация микрофона, если еще не сделано или контекст приостановлен
        if (!widgetState.isMicInitialized || (audioContext && audioContext.state === 'suspended')) {
             widgetLog('Microphone not initialized or context suspended. Calling initMic.');
            const micInitSuccess = await initMic(); // initMic сам обработает resume/create
            if (!micInitSuccess) {
                widgetLog('Failed to initialize microphone', 'error');
                 // initMic уже обновит состояние до ERROR или покажет iOS кнопку
                return;
            }
             // После успешной инициализации initMic, контекст должен быть active/running
             if (!audioContext || audioContext.state !== 'running') {
                  widgetLog(`AudioContext state is not running after initMic: ${audioContext?.state}`, 'error');
                  updateState('ERROR', 'Не удалось запустить аудио.');
                  return;
             }
        } else if (!audioContext || audioContext.state !== 'running') {
             // Этого не должно произойти, но на всякий случай
             widgetLog(`AudioContext is in unexpected state ${audioContext?.state} before starting listening.`, 'error');
             updateState('ERROR', 'Проблема с аудио.');
             return;
        }


        // Убеждаемся, что WS соединение открыто
        if (!websocket || websocket.readyState !== WebSocket.OPEN) {
             widgetLog("WebSocket is not open, cannot start listening.", "warn");
             if (!widgetState.isReconnecting && !widgetState.connectionFailedPermanently) {
                  connectWebSocket(); // Попытка переподключения
             }
             // updateState уже должен быть установлен в CONNECTING или RECONNECTING
             return;
        }

        // Отправляем команду серверу, что начинаем принимать аудио
        websocket.send(JSON.stringify({
          type: "input_audio_stream.start",
          event_id: `start_${Date.now()}`
        }));
        widgetLog("Отправлена команда input_audio_stream.start");


        updateState('LISTENING', 'Говорите...'); // Обновляем состояние и UI
        startAudioSendTimer(); // Запускаем таймер регулярной отправки буфера
        audioDataAccumulated = false; // Сбрасываем флаг накопления данных для нового сегмента

        // Скрываем iOS кнопку активации, если она была видна
        if (getDOMElements() && elements.iosAudioButton) {
             elements.iosAudioButton.classList.remove('visible');
        }

        // Убираем пульсацию с кнопки
         if (getDOMElements()) {
             elements.widgetButton.classList.remove('wellcomeai-pulse-animation');
         }
    };

    // Остановка прослушивания
    const stopListening = () => {
        if (!widgetState.isListening) {
             // widgetLog("Прослушивание уже остановлено."); // Слишком много логов
             return;
        }

        widgetLog('Stopping listening...');

        stopAudioSendTimer(); // Останавливаем таймер отправки

        // Перед отправкой команды остановки стрима, убедимся, что последний чанк отправлен
        sendAudioBufferChunk(); // Отправляем все, что осталось в буфере

        // Отправляем команду серверу, что прекращаем принимать аудио
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              type: "input_audio_stream.stop",
              event_id: `stop_${Date.now()}`
            }));
             widgetLog("Отправлена команда input_audio_stream.stop");
        }

        // Очищаем буфер только после отправки последнего чанка и команды остановки
        clientAudioBuffer = [];
        audioDataAccumulated = false; // Сбрасываем флаг

        // Меняем состояние только если не воспроизводится аудио
        if (!widgetState.isPlayingAudio) {
             // Переходим в CONNECTED, если виджет открыт, иначе в IDLE
             if (widgetState.isWidgetOpen) {
                  updateState('CONNECTED', 'Готов'); // Статус "Готов"
             } else {
                  updateState('IDLE', ''); // Скрываем все
             }
        } else {
            // Если воспроизводится ответ, остаемся в состоянии SPEAKING
            // Переход в CONNECTED/IDLE произойдет после завершения воспроизведения в playNextAudioFromQueue
        }
    };


    // Преобразование ArrayBuffer в Base64
    const arrayBufferToBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return window.btoa(binary);
    };

    // Преобразование Base64 в ArrayBuffer
    const base64ToArrayBuffer = (base64) => {
      try {
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      } catch (e) {
        widgetLog(`Ошибка при декодировании base64: ${e.message}`, "error");
        return new ArrayBuffer(0);
      }
    };

    // Обновление визуализации аудио
    const updateAudioVisualization = (audioData) => {
      if (!getDOMElements() || !elements.audioBarsContainer) return;
      const bars = elements.audioBarsContainer.querySelectorAll('.wellcomeai-audio-bar');
      if (bars.length === 0) return;

      const step = Math.floor(audioData.length / bars.length);
      // Мультипликатор для адаптации чувствительности визуализации
      // Можно сделать его адаптивным в зависимости от среднего уровня шума или просто фиксированным.
      const multiplier = isMobile ? 150 : 100; // Увеличил чувствительность для мобильных

      for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        const start = i * step;
        const end = Math.min(start + step, audioData.length);

        for (let j = start; j < end; j++) {
          sum += Math.abs(audioData[j]);
        }
        const average = sum / (end - start);

        // Нормализация и ограничение высоты (от 2px до 30px)
        // Высота 2px - это базовая линия тишины
        const height = 2 + Math.min(28, Math.floor(average * multiplier));
        bars[i].style.height = `${height}px`;
      }
    };

    // Сброс визуализации аудио
    const resetAudioVisualization = () => {
       if (!getDOMElements() || !elements.audioBarsContainer) return;
       const bars = elements.audioBarsContainer.querySelectorAll('.wellcomeai-audio-bar');
       bars.forEach(bar => {
         bar.style.height = '2px'; // Возвращаем к базовой высоте
       });
    };

    // Добавление аудио данных в очередь воспроизведения
    const addAudioToPlaybackQueue = (audioBase64Chunk) => {
       if (!audioBase64Chunk) return;
       // Декодируем Base64 и добавляем ArrayBuffer в очередь
       const audioBuffer = base64ToArrayBuffer(audioBase664Chunk);
       if (audioBuffer.byteLength > 0) {
            audioPlaybackQueue.push(audioBuffer);
            // widgetLog(`Добавлен аудио чанк ${audioBuffer.byteLength} байт в очередь. Длина очереди: ${audioPlaybackQueue.length}`);
            // Если воспроизведение не активно, запускаем его
           if (!widgetState.isPlayingAudio) {
               playNextAudioFromQueue();
           }
       }
    };

    // Воспроизведение следующего аудио из очереди с использованием Web Audio API
    const playNextAudioFromQueue = async () => {
        // Если очередь пуста и нет текущего воспроизведения, завершаем состояние SPEAKING
        if (audioPlaybackQueue.length === 0 && !audioBufferSourceNode) {
             widgetState.isPlayingAudio = false;
             updateUI(); // Обновляем UI (убираем состояние 'speaking')
             audioPlaybackStartTime = 0; // Сбрасываем время начала для следующей серии воспроизведения
             audioPlaybackOffset = 0; // Сбрасываем смещение

             // Когда воспроизведение закончено, возвращаемся к прослушиванию, если виджет открыт
             // и состояние позволяет (например, не в ERROR или RECONNECTING)
             if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isReconnecting) {
                // Небольшая пауза перед возвратом к прослушиванию
                setTimeout(() => {
                  // Дополнительная проверка перед стартом
                  if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isListening && !widgetState.isReconnecting) {
                      startListening(); // Начинаем слушать снова
                  }
                }, 800); // Пауза
             } else if (!widgetState.isWidgetOpen) {
                  // Если виджет закрыт, переходим в IDLE
                  updateState('IDLE', '');
                  // Добавляем пульсацию на кнопку
                  if (getDOMElements()) {
                      elements.widgetButton.classList.add('wellcomeai-pulse-animation');
                  }
             } else {
                  // Виджет открыт, но не CONNECTED (например, ERROR или RECONNECTING)
                  // Состояние уже отражает проблему, не начинаем слушать
                  widgetLog("Воспроизведение завершено, но не CONNECTED. Не начинаем слушать.");
             }

             return;
        }

        // Если уже что-то воспроизводится, ждем
        if (widgetState.isPlayingAudio && audioBufferSourceNode) {
             // widgetLog("Аудио уже воспроизводится, ожидаем завершения текущего буфера...");
             return;
        }

        // Переходим в состояние SPEAKING, если еще не там
        if (widgetState.current !== 'SPEAKING') {
             updateState('SPEAKING'); // Сообщение может быть пустым, текст идет через delta
        }
        widgetState.isPlayingAudio = true; // Флаг воспроизведения

        // Берем первый буфер из очереди
        const nextAudioBuffer = audioPlaybackQueue.shift();
        if (!nextAudioBuffer || nextAudioBuffer.byteLength === 0) {
             widgetLog("Пустой аудио буфер в очереди, пропускаем.", "warn");
             playNextAudioFromQueue(); // Переходим к следующему
             return;
        }

         // Создаем AudioContext если еще не создан (или пытаемся возобновить)
        const ctx = createAudioContext();
        if (!ctx || ctx.state === 'closed') {
             widgetLog("Не удалось получить AudioContext для воспроизведения.", "error");
             widgetState.isPlayingAudio = false; // Не удалось воспроизвести
             updateUI();
             playNextAudioFromQueue(); // Пропускаем этот буфер
             return;
        }

         // Убедиться, что AudioContext активен (особенно после приостановки на iOS/мобильных)
         if (ctx.state === 'suspended') {
             widgetLog('Playback AudioContext is suspended, attempting to resume...');
             try {
                 await ctx.resume();
                 widgetLog('Playback AudioContext resumed successfully.');
                 widgetState.isMicInitialized = true; // Считаем активированным
                 updateUI();
             } catch (err) {
                 widgetLog(`Failed to resume Playback AudioContext: ${err.message}`, 'error');
                 // На iOS может потребоваться клик пользователя
                 if (isIOS && getDOMElements() && elements.iosAudioButton) {
                      elements.iosAudioButton.classList.add('visible');
                     updateState('CONNECTED', "Нажмите кнопку ниже для активации звука"); // Сообщаем о необходимости активации
                 } else {
                      updateState('ERROR', 'Ошибка воспроизведения звука.');
                 }
                 widgetState.isPlayingAudio = false; // Не удалось воспроизвести
                 updateUI();
                 // Не запускаем playNextAudioFromQueue автоматически, ждем активации/решения проблемы
                 return;
             }
         }

        // Декодируем ArrayBuffer в AudioBuffer
        try {
             const audioBuffer = await ctx.decodeAudioData(nextAudioBuffer);

             // Создаем AudioBufferSourceNode
             audioBufferSourceNode = ctx.createBufferSource();
             audioBufferSourceNode.buffer = audioBuffer;
             audioBufferSourceNode.connect(ctx.destination); // Подключаем к выходу

             // Вычисляем время начала воспроизведения
             const now = ctx.currentTime;
             // Если audioPlaybackStartTime равно 0 (первый буфер или после сброса),
             // начинаем с текущего времени контекста. Иначе - с конца предыдущего буфера.
             let startTime = audioPlaybackStartTime > now ? audioPlaybackStartTime : now;

             audioBufferSourceNode.start(startTime, audioPlaybackOffset); // start(when, offset)

             // Обновляем время начала для следующего буфера.
             // Время окончания текущего буфера = startTime + audioBuffer.duration
             audioPlaybackStartTime = startTime + audioBuffer.duration;
             audioPlaybackOffset = 0; // Сбрасываем смещение после успешного воспроизведения буфера

             // Обработчик окончания воспроизведения текущего буфера
             audioBufferSourceNode.onended = () => {
                 audioBufferSourceNode = null; // Очищаем ссылку
                 playNextAudioFromQueue(); // Проигрываем следующий из очереди
             };

             widgetLog(`Начато воспроизведение аудио буфера (${audioBuffer.duration.toFixed(3)} сек)`);

        } catch (e) {
             widgetLog(`Ошибка декодирования или воспроизведения аудио: ${e.message}`, "error");
             audioBufferSourceNode = null; // Очищаем ссылку
             // Оставляем isPlayingAudio=true и состояние SPEAKING, пока очередь не пуста
             // playNextAudioFromQueue сам перейдет к следующему буферу или завершит воспроизведение
             playNextAudioFromQueue(); // Пропускаем этот буфер и переходим к следующему
        }
    };


     // --- WebSocket Управление ---

     // Очистка всех связанных с WS таймеров
     const clearWebSocketTimers = () => {
          if (pingIntervalId) {
              clearInterval(pingIntervalId);
              pingIntervalId = null;
          }
          if (connectionTimeoutId) {
              clearTimeout(connectionTimeoutId);
              connectionTimeoutId = null;
          }
          if (retryConnectTimerId) {
              clearTimeout(retryConnectTimerId);
              retryConnectTimerId = null;
          }
          // widgetLog("Очищены WS таймеры."); // Слишком много логов
     };

    // Полное отключение WebSocket
    const disconnectWebSocket = (code = 1000, reason = "Client initiated") => {
        // Corrected condition: check if websocket is not null first
        if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
            try {
                websocket.close(code, reason);
                widgetLog(`Закрытие WebSocket соединения с кодом ${code} и причиной: ${reason}`);
            } catch (e) {
                widgetLog(`Ошибка при попытке закрытия WS: ${e.message}`, "warn");
            }
        } else {
             widgetLog("WS уже закрыт или в процессе закрытия (или был null). Не выполняем close().", "debug");
        }

         // Очистка ресурсов и флагов - делаем это здесь для надежности,
         // даже если onclose будет вызван чуть позже.
         clearWebSocketTimers();
         stopAudioSendTimer();
         clientAudioBuffer = [];
         audioDataAccumulated = false; // Сброс флага накопления аудио

         websocket = null; // Устанавливаем ссылку на null
         widgetState.isReconnecting = false; // Выходим из состояния переподключения
         widgetState.isConnected = false; // Флаг подключения установлен в false

         // Состояние UI будет обновлено в onclose, где будет определено, чистое ли закрытие.
         // Если disconnect вызван при явном сбросе или закрытии виджета, updateState уже был вызван.
    };

     // Сброс состояния соединения и попытка переподключения
    const resetConnection = () => {
        widgetLog("Запрошен сброс соединения и переподключение.");
        // Очищаем все таймеры и текущее соединение
        clearWebSocketTimers();
        disconnectWebSocket(1001, "Client reset"); // Закрываем текущее соединение если есть

        // Сбрасываем флаги и счетчик попыток
        reconnectAttempts = 0;
        widgetState.connectionFailedPermanently = false; // Сброс флага, если пользователь явно нажал "Повторить"

        // Меняем состояние и обновляем UI
        updateState('CONNECTING', 'Попытка подключения...');
        hideConnectionError(); // Скрываем сообщение об ошибке соединения

        // Небольшая задержка перед первой попыткой после сброса
        retryConnectTimerId = setTimeout(() => {
            widgetLog("Запуск connectWebSocket из таймера resetConnection.");
            connectWebSocket();
        }, 500);
    };


    // Запуск процесса переподключения с экспоненциальной задержкой
    const reconnectWithDelay = () => {
         // Если уже идет переподключение или соединение было закрыто чисто, ничего не делаем
         // Проверка widgetState.isReconnecting важнее, чем websocket state здесь.
         // Если websocket === null, но widgetState.isReconnecting === true, мы уже ждем таймер.
         if (widgetState.isReconnecting) {
              widgetLog("Уже в процессе переподключения. Не запускаем новую попытку.");
              return;
         }

        const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

        if (reconnectAttempts >= maxAttempts) {
            widgetLog(`Maximum reconnection attempts (${maxAttempts}) reached. Giving up.`);
            widgetState.isReconnecting = false; // Выходим из состояния переподключения
            widgetState.connectionFailedPermanently = true; // Помечаем как невосстановимую ошибку
            updateState('ERROR', 'Не удалось подключиться. Нажмите кнопку ниже.'); // Обновляем UI на ошибку
            // UI updateState покажет ошибку соединения с кнопкой "Повторить"
            return;
        }

         widgetState.isReconnecting = true; // Входим в состояние переподключения
         updateState('RECONNECTING', `Переподключение (${reconnectAttempts + 1}/${maxAttempts})...`); // Обновляем UI

         // Экспоненциальная задержка
         const baseDelay = isMobile ? 1000 : 2000; // Базовая задержка (мс)
         const delay = Math.min(30000, baseDelay * Math.pow(1.5, reconnectAttempts) + (Math.random() * 1000)); // Добавляем немного случайности

         reconnectAttempts++; // Увеличиваем счетчик *перед* установкой таймера

         widgetLog(`Попытка переподключения через ${Math.round(delay/1000)} секунд...`);

         retryConnectTimerId = setTimeout(() => {
             widgetLog("Запуск connectWebSocket из таймера переподключения.");
             connectWebSocket(); // Запускаем следующую попытку
         }, delay);
    };


    // Подключение к WebSocket серверу
    const connectWebSocket = async () => {
        // Проверяем, не находимся ли уже в процессе или подключены
        if (websocket && (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN)) {
            widgetLog("WebSocket уже подключается или открыт.", "debug");
            return; // Не пытаемся подключиться повторно
        }
        // Проверяем, не находимся ли в состоянии переподключения
        if (widgetState.isReconnecting && retryConnectTimerId) {
             widgetLog("Уже идет процесс переподключения по таймеру.", "debug");
             return; // Ждем завершения текущей попытки переподключения
        }

         if (!ASSISTANT_ID) {
             widgetLog('Assistant ID не найден. Подключение невозможно.', 'error');
             updateState('ERROR', 'Ошибка: ID ассистента не указан.');
             widgetState.connectionFailedPermanently = true; // Невозможно подключиться без ID
             if (getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
             updateUI();
             return; // Не пытаемся подключиться без ID
         }

        widgetLog(`Попытка подключения к WebSocket: ${WS_URL}`);

        // Очищаем предыдущие таймеры и соединение перед новой попыткой
        clearWebSocketTimers();
        disconnectWebSocket(1001, "Connecting"); // Закрываем предыдущее, если не закрыто

        // Только после явной очистки создаем новое соединение
        websocket = new WebSocket(WS_URL);
        websocket.binaryType = 'arraybuffer'; // Для аудио данных

        // Устанавливаем таймаут на открытие соединения
        connectionTimeoutId = setTimeout(() => {
            widgetLog(`Таймаут соединения WebSocket (${CONNECTION_TIMEOUT} мс).`);
            // Если таймаут сработал до onopen, это ошибка
            if (websocket && websocket.readyState !== WebSocket.OPEN) {
                 disconnectWebSocket(1001, "Connection timeout"); // Закрываем с кодом ошибки
                 // reconnectWithDelay будет вызван из onclose/onerror
            }
        }, CONNECTION_TIMEOUT);

        updateState('CONNECTING', 'Подключение...'); // Обновляем UI

        // --- Обработчики событий WebSocket ---

        websocket.onopen = function() {
            clearTimeout(connectionTimeoutId); // Соединение установлено, отменяем таймаут
            widgetLog('WebSocket connection established.');

            // Сбрасываем флаги состояния
            widgetState.isConnected = true;
            widgetState.isReconnecting = false;
            reconnectAttempts = 0;
            widgetState.connectionFailedPermanently = false;

            // Обновляем состояние и UI
            updateState('CONNECTED', 'Подключено');

            // Запускаем ping
            startPing();

            // Если виджет открыт, автоматически пытаемся начать слушать
            if (widgetState.isWidgetOpen) {
               // initMic и startListening теперь вызываются из handleMainCircleClick
               // или openWidget после того, как пользователь кликнул или открыл виджет
               // Здесь мы просто переходим в состояние CONNECTED и ждем действия пользователя
                widgetLog("Widget is open, WS connected. Waiting for user action to start listening.");
                // Если микрофон еще не инициализирован, initMic будет вызван при клике или в openWidget
                // Если iOS и требует активации, кнопка будет показана
                 if (!widgetState.isMicInitialized || (audioContext && audioContext.state === 'suspended')) {
                    if (isIOS && getDOMElements() && elements.iosAudioButton) {
                         elements.iosAudioButton.classList.add('visible');
                        updateState('CONNECTED', "Нажмите кнопку ниже для активации микрофона");
                    } else if (!isIOS) {
                         // На Android/Desktop пытаемся инициализировать микрофон сразу при открытии виджета после коннекта
                         initMic().then(success => {
                             if (success) {
                                  // Если микрофон инициализирован успешно, сразу начинаем слушать
                                  startListening();
                             } else {
                                  // initMic покажет ошибку или сообщение
                             }
                         });
                    } else {
                         widgetLog("iOS AudioContext не активен, ожидаем активации...");
                    }
               } else {
                    // Микрофон уже инициализирован и контекст активен
                     startListening(); // Начинаем слушать сразу
               }

            } else {
                 // Если виджет закрыт, просто показываем статус "Подключено" на кнопке
                 updateState('IDLE', 'Подключено'); // Состояние IDLE для закрытого виджета
                 // Добавляем пульсацию на кнопку, чтобы показать, что виджет готов к открытию
                 if (getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
            }
        };

        websocket.onmessage = function(event) {
            // Обработка возможных бинарных данных (хотя ожидаем JSON или Base64 в JSON)
            if (event.data instanceof Blob) {
              widgetLog("Получены бинарные данные (Blob) от сервера. Игнорируем.");
              return;
            }
             if (event.data instanceof ArrayBuffer) {
                widgetLog("Получены бинарные данные (ArrayBuffer) от сервера. Игнорируем.");
                return;
             }

            // Проверка на пустое сообщение
            if (!event.data || typeof event.data !== 'string') {
              widgetLog("Получено пустое или нестроковое сообщение от сервера.", "warn");
              return;
            }

            try {
                // Ожидаем JSON для всех остальных сообщений
                const data = JSON.parse(event.data);
                //widgetLog(`Получено сообщение типа: ${data.type}`); // Логируем тип

                 // Обработка сообщений по типу
                handleWebSocketMessage(data);

            } catch (e) {
                widgetLog(`Ошибка парсинга сообщения от сервера: ${e.message}. Содержимое: ${event.data.substring(0, 200)}...`, 'warn');
                 // Если парсинг не удался, возможно, это не JSON (например, старый текстовый ping/pong)
                 // Или поврежденные данные. Пока игнорируем, если не смогли распарсить как JSON.
            }
        };

        websocket.onerror = function(error) {
            widgetLog(`WebSocket error occurred: ${error.message || error}`, 'error');

            // Ошибка обычно приводит к последующему событию onclose.
            // Логика переподключения находится в onclose.
            // Здесь можно обновить UI на временную ошибку, если нужно.
             if (widgetState.current !== 'RECONNECTING' && widgetState.current !== 'ERROR') {
                  updateState('ERROR', 'Ошибка соединения.'); // Временное сообщение об ошибке
             }
        };

        websocket.onclose = function(event) {
            widgetLog(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}. Clean: ${event.wasClean}`);

            // Останавливаем все процессы, связанные с аудио и соединением
            stopListening(); // Останавливает прослушивание и таймер отправки
            // Останавливаем воспроизведение, если оно было активным
            audioPlaybackQueue = [];
             if (audioBufferSourceNode) {
                  try { audioBufferSourceNode.stop(); } catch(e) {}
                  audioBufferSourceNode = null;
             }
             widgetState.isPlayingAudio = false;
             audioPlaybackStartTime = 0;
             audioPlaybackOffset = 0;


            // Сбрасываем флаги подключения
            widgetState.isConnected = false;
            websocket = null; // Очищаем ссылку на WS объект

            // Очищаем таймеры, если они еще не очищены (например, в disconnectWebSocket)
            clearWebSocketTimers();


            // Если закрытие было чистым (инициировано клиентом, кодом 1000 или 1001)
            if (event.wasClean || event.code === 1000 || event.code === 1001) {
                widgetLog('Clean WebSocket close. No automatic reconnection.');
                widgetState.isReconnecting = false; // Убеждаемся, что флаг сброшен
                widgetState.connectionFailedPermanently = false; // Не фатальная ошибка

                // Меняем состояние на IDLE, если виджет закрыт, или CONNECTED, если открыт и чисто отключился (редкий случай)
                 if (!widgetState.isWidgetOpen) {
                      updateState('IDLE', 'Отключено');
                      if (getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
                 } else {
                      // Виджет открыт, но соединение чисто закрыто. Редкий случай.
                      // Можем остаться в CONNECTED, но показать статус "Отключено"
                      updateState('CONNECTED', 'Отключено');
                       if (getDOMEElements()) showConnectionError("Соединение закрыто. Нажмите 'Повторить'."); // Предлагаем повторить
                 }


            } else {
                // Не чистое закрытие - пытаемся переподключиться
                widgetLog('WebSocket closed unexpectedly. Attempting to reconnect...');
                reconnectWithDelay(); // Запускаем логику переподключения
            }

             // Скрываем загрузчик, если он висел
            if (getDOMElements() && elements.loaderModal) {
                 elements.loaderModal.classList.remove('active');
            }
        };

        // Возвращаем true, если процесс подключения начался (не гарантирует успех)
        return true;
    };

     // Запуск ping для поддержания соединения
    const startPing = () => {
        if (pingIntervalId) {
            clearInterval(pingIntervalId);
        }
        const pingFreq = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
        widgetLog(`Запуск пинга с интервалом ${pingFreq} мс`);

        // Таймер для отправки пинга
        pingIntervalId = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                try {
                    // Отправляем ping в формате, понятном серверу (JSON)
                     websocket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
                     // widgetLog("Пинг отправлен"); // Слишком много логов в DEBUG

                    // Примечание: Отслеживание таймаута pong не реализовано явным образом здесь.
                    // Предполагается, что если сервер не отвечает, соединение рано или поздно оборвется,
                    // и onclose/onerror сработает, инициируя переподключение.
                    // Если нужен более агрессивный таймаут по pong, его нужно добавить.

                } catch (e) {
                    widgetLog(`Ошибка отправки пинга: ${e.message}`, "error");
                    // Ошибка отправки может означать, что соединение уже неактивно,
                    // onclose/onerror сработает.
                     clearInterval(pingIntervalId); // Останавливаем интервал, если ошибка
                     pingIntervalId = null;
                }
            } else {
                 widgetLog("Невозможно отправить пинг, WS не открыт.", "warn");
                 // Если WS не открыт, вероятно, уже сработал onclose/onerror
                 // Очищаем интервал, чтобы избежать спама
                 clearInterval(pingIntervalId);
                 pingIntervalId = null;
            }
        }, pingFreq);
    };


     // --- Обработчики сообщений WebSocket по типу ---

    const handleWebSocketMessage = (data) => {
       // Обновляем время последнего pong при получении любого сообщения
       // Это полезно для диагностики, но не используется в текущей логике переподключения.
       // lastPongTime = Date.now();

       switch (data.type) {
           case 'session.created':
           case 'session.updated':
               // handleSessionUpdate(data); // Просто логируем, если нужно
               widgetLog(`Получена информация о сессии: ${data.type}`);
               break;
           case 'connection_status':
               // handleConnectionStatus(data); // Просто логируем, если нужно
               widgetLog(`Статус соединения от сервера: ${data.status} - ${data.message}`);
               // Если сервер отправляет status='connected', это может быть подтверждением после нашего onopen
               if (data.status === 'connected' && widgetState.current === 'CONNECTING') {
                    widgetLog("Сервер подтвердил подключение.");
                    // updateState('CONNECTED', 'Подключено'); // Это уже делается в onopen
               }
               break;
           case 'error':
               handleServerError(data);
               break;
           case 'response.text.delta':
               handleTextDelta(data);
               break;
           case 'response.text.done':
               handleTextDone(data);
               break;
           case 'response.audio.delta':
               handleAudioDelta(data);
               break;
           case 'response.audio.done':
               handleAudioDone(data);
               break;
           case 'response.audio_transcript.delta':
           case 'response.audio_transcript.done':
                // handleTranscriptUpdate(data); // Опционально: обрабатывать транскрипцию
                // widgetLog(`Transcript Update: ${data.text || ''} (${data.type})`);
                break;
           case 'response.done':
               handleResponseDone(data);
               break;
           case 'pong': // Если сервер отправляет pong в JSON формате
               // widgetLog("Получен JSON pong"); // Слишком много логов в DEBUG
               // Ничего не делаем, главное - что пришло сообщение
               break;
           default:
               widgetLog(`Неизвестный тип сообщения: ${data.type}`, "warn");
       }
    };

     const handleServerError = (data) => {
       widgetLog(`Server Error: Code=${data.error.code}, Message=${data.error.message}`, 'error');

       // Останавливаем прослушивание и воспроизведение при любой ошибке от сервера
       stopListening();
       // Очищаем очередь воспроизведения и останавливаем текущий AudioBufferSourceNode
        audioPlaybackQueue = [];
         if (audioBufferSourceNode) {
              try { audioBufferSourceNode.stop(); } catch(e) {}
              audioBufferSourceNode = null;
         }
         widgetState.isPlayingAudio = false;
         audioPlaybackStartTime = 0;
         audioPlaybackOffset = 0;


       // Особая обработка для конкретных ошибок
       if (data.error.code === 'input_audio_buffer_commit_empty' || data.error.code === 'input_audio_stream_empty') {
            widgetLog("Ошибка: пустой аудио ввод. Возможно, не было обнаружено речи или отправлен пустой commit.");
           // Можно показать краткое сообщение пользователю
           if (widgetState.isWidgetOpen) {
               updateState('CONNECTED', 'Не расслышал, попробуйте снова.'); // Возвращаемся в состояние готовности
           } else {
                updateState('IDLE', 'Не расслышал.'); // Возвращаемся в IDLE, если закрыт
                if(getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
           }
       } else if (data.error.code === 'assistant_not_found' || data.error.code === 'authentication_failed' || data.error.code === 'invalid_api_key') {
             widgetLog(`Фатальная ошибка конфигурации/авторизации: ${data.error.code}`, 'error');
             updateState('ERROR', `Ошибка: ${data.error.message}`); // Показываем сообщение об ошибке
             widgetState.connectionFailedPermanently = true; // Помечаем как невосстановимую ошибку
             // Не пытаемся переподключиться при таких ошибках
             disconnectWebSocket(1000, "Fatal server error"); // Чистое закрытие
       }
       else {
            // Для прочих ошибок
             // Если виджет открыт, показываем сообщение, но остаемся в CONNECTED (или откуда пришла ошибка)
             if (widgetState.isWidgetOpen) {
                 updateState('CONNECTED', `Ошибка: ${data.error.message}`); // Показываем сообщение об ошибке, оставаясь в CONNECTED
             } else {
                 // Если виджет закрыт, просто логируем ошибку и остаемся в IDLE
                  widgetLog(`Ошибка от сервера при закрытом виджете: ${data.error.message}`, 'error');
                  // Можно добавить временную пульсацию на кнопку, если нужно
                   if(getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
             }
       }
     };

     let fullResponseText = ""; // Переменная для накопления полного текстового ответа

     const handleTextDelta = (data) => {
       if (data.delta) {
          // Добавляем к накопленному тексту
           fullResponseText += data.delta;

          // Обновляем отображение сообщения.
          // Можно показывать либо дельту, либо полный накопленный текст.
          // Показ дельты дает эффект "печатания", показ полного текста - обновляется по частям.
          // Давайте показывать полный накопленный текст.
           if (widgetState.current !== 'SPEAKING') {
                // Переключаемся в состояние SPEAKING, если еще не там
                updateState('SPEAKING', fullResponseText);
           } else {
               // Если уже в SPEAKING, просто обновляем текст сообщения
               if (getDOMElements() && elements.messageDisplay) {
                    elements.messageDisplay.textContent = fullResponseText;
                    // Убеждаемся, что сообщение видно
                    elements.messageDisplay.classList.add('show');
                    // Сбрасываем таймер скрытия, пока приходит текст
                    if (messageDisplayTimerId) {
                       clearTimeout(messageDisplayTimerId);
                       messageDisplayTimerId = null;
                    }
               } else {
                   // Если элементы недоступны, просто логируем
                   widgetLog(`Cannot update message display: ${fullResponseText}`, 'warn');
               }
           }

           // Если виджет закрыт, добавляем пульсацию на кнопку, чтобы показать активность
           if (!widgetState.isWidgetOpen && getDOMElements()) {
               elements.widgetButton.classList.add('wellcomeai-pulse-animation');
           }
       }
     };

     const handleTextDone = (data) => {
        widgetLog('Text response done.');
        // Текстовый ответ завершен.
        // Накопленный текст в fullResponseText - это полный ответ.
        // Сообщение на UI останется видимым. Таймер скрытия запустится
        // после получения handleResponseDone или по таймауту.
        // Если handleResponseDone не приходит, сообщение все равно должно скрыться.
        // updateState('SPEAKING', fullResponseText); // Обновляем последний раз полным текстом
        // Таймер скрытия будет установлен в handleResponseDone
     };

     let audioChunksBuffer = []; // Буфер для накопления аудио Base64 перед добавлением в очередь воспроизведения

     const handleAudioDelta = (data) => {
       if (data.delta) {
          // Накапливаем аудио чанки (Base64) временно в этом буфере
          audioChunksBuffer.push(data.delta);
       }
     };

     const handleAudioDone = (data) => {
        widgetLog('Audio response done.');
        // Все аудио чанки получены для этого сегмента.
        // Объединяем их и добавляем в очередь воспроизведения.
        if (audioChunksBuffer.length > 0) {
             const fullAudioBase64 = audioChunksBuffer.join('');
             addAudioToPlaybackQueue(fullAudioBase64); // Добавляем в очередь декодированный буфер
             audioChunksBuffer = []; // Очищаем буфер
        } else {
             widgetLog("Received audio.done but audioChunksBuffer is empty.", "warn");
        }
         // Воспроизведение запустится автоматически, если не было активным,
         // при добавлении в очередь в addAudioToPlaybackQueue.
     };

     // const handleTranscriptUpdate = (data) => { ... } // Оставлено как опциональное


     const handleResponseDone = (data) => {
        widgetLog('Full response processing done.');
        fullResponseText = ""; // Сбрасываем накопленный текст после завершения ответа

        // Ответ от сервера полностью обработан (аудио может еще воспроизводиться).
        // Устанавливаем таймер на скрытие текстового сообщения, если оно есть
        if (getDOMElements() && elements.messageDisplay && elements.messageDisplay.classList.contains('show')) {
             if (messageDisplayTimerId) {
                clearTimeout(messageDisplayTimerId);
             }
             messageDisplayTimerId = setTimeout(() => {
                 widgetState.message = ''; // Очищаем сообщение
                 updateUI(); // Обновляем UI, чтобы скрыть сообщение
             }, UI_MESSAGE_DURATION); // Скрываем через заданное время
        }


        // Возвращаемся к прослушиванию, если виджет открыт, подключен, и не воспроизводится аудио
        // (или воспроизведение скоро закончится)
         if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isReconnecting) {
              // Небольшая пауза перед возвратом к прослушиванию.
              // Если аудио воспроизводится (isPlayingAudio=true), то startListening будет вызван
              // после завершения воспроизведения в playNextAudioFromQueue.
              // Если аудио не воспроизводится, начинаем слушать сейчас.
             if (!widgetState.isPlayingAudio) {
                  setTimeout(() => {
                     // Дополнительная проверка перед стартом
                     if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isListening && !widgetState.isReconnecting) {
                         startListening(); // Начинаем слушать снова
                     }
                  }, 800); // Пауза перед переходом к прослушиванию
             } else {
                 widgetLog("Аудио еще воспроизводится. Вернусь к слушанию после его завершения.");
             }
         } else if (!widgetState.isWidgetOpen && !widgetState.isPlayingAudio) {
              // Если виджет закрыт и нет воспроизведения аудио, переходим в IDLE
              updateState('IDLE', '');
               // Добавляем пульсацию на кнопку
              if(getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
         }
         // Если widgetState.isPlayingAudio === true, переход в IDLE/CONNECTED произойдет после завершения воспроизведения в playNextAudioFromQueue
     };


    // --- UI События ---

    const openWidget = async () => {
      if (widgetState.isWidgetOpen) {
         widgetLog("Widget is already open.");
         // Если открыт, но в ERROR состоянии, возможно, нужно показать ошибку снова
         if (widgetState.current === 'ERROR' && widgetState.connectionFailedPermanently) {
              showConnectionError("Не удалось подключиться к серверу. Нажмите кнопку ниже.");
         }
         return;
      }
      widgetLog("Opening widget.");
      widgetState.isWidgetOpen = true;
      updateUI(); // Обновляем UI для открытия

      // Скрываем ошибку соединения, если она видна
      hideConnectionError();

      // Если соединение не установлено и нет попытки переподключения, пытаемся подключиться
      if (!widgetState.isConnected && !widgetState.isReconnecting && !widgetState.connectionFailedPermanently) {
           connectWebSocket();
      } else if (widgetState.connectionFailedPermanently) {
           // Если была невосстановимая ошибка, показываем ее снова
           showConnectionError("Не удалось подключиться к серверу. Нажмите кнопку ниже.");
           updateState('ERROR', 'Отключено'); // Обновляем статус
      } else if (widgetState.isConnected) {
           // Если уже подключено, пытаемся начать слушать (после инициализации микрофона, если требуется)
           widgetLog("Widget opened and connected. Attempting to start listening.");
           await initMic(); // Попытка инициализации микрофона (или возобновления AudioContext)
            // initMic обновит isMicInitialized и, возможно, покажет iOS кнопку или ошибку.
            // startListening будет вызван либо сразу после успешного initMic,
            // либо при клике по iOS кнопке, либо при клике по кругу.
            if (widgetState.isMicInitialized && audioContext && audioContext.state === 'running') {
                 // Микрофон готов, начинаем слушать сразу
                 startListening();
            } else if (isIOS && getDOMElements() && elements.iosAudioButton && !widgetState.isMicInitialized) {
                 // На iOS показываем кнопку активации
                 elements.iosAudioButton.classList.add('visible');
                 updateState('CONNECTED', "Нажмите кнопку ниже для активации микрофона");
            } else if (widgetState.current !== 'ERROR') {
                 // В других случаях (например, Android mic init failed) остаемся в CONNECTED и ждем
                 updateState('CONNECTED', 'Нажмите микрофон для начала.');
            }
      }
      // Если isReconnecting, UI уже покажет "Переподключение..."

      // Убираем пульсацию с кнопки
       if (getDOMElements()) elements.widgetButton.classList.remove('wellcomeai-pulse-animation');
    };

    const closeWidget = () => {
       if (!widgetState.isWidgetOpen) {
           widgetLog("Widget is already closed.");
           return;
       }
      widgetLog("Closing widget.");
      widgetState.isWidgetOpen = false;

      // Останавливаем прослушивание и воспроизведение
      stopListening(); // Это также остановит таймер отправки аудио

      // Очищаем очередь воспроизведения и останавливаем текущий AudioBufferSourceNode
      audioPlaybackQueue = [];
      if (audioBufferSourceNode) {
         try { audioBufferSourceNode.stop(); } catch(e) { widgetLog(`Error stopping AudioBufferSourceNode: ${e.message}`, 'warn');}
         audioBufferSourceNode = null;
      }
      widgetState.isPlayingAudio = false; // Убеждаемся, что флаг воспроизведения сброшен
      audioPlaybackStartTime = 0; // Сбрасываем время начала воспроизведения
      audioPlaybackOffset = 0;

      // Скрываем сообщения и ошибки
      updateState('IDLE', ''); // Переходим в состояние IDLE, очищаем сообщение
      hideConnectionError();

       // Скрываем iOS кнопку, если она была видна
      if (getDOMElements() && elements.iosAudioButton) {
         elements.iosAudioButton.classList.remove('visible');
      }

      // Обновляем UI для закрытия
      updateUI();

      // Добавляем пульсацию на кнопку, если соединение не потеряно безвозвратно
      if (widgetState.isConnected || widgetState.isReconnecting) {
         if (getDOMElements()) elements.widgetButton.classList.add('wellcomeai-pulse-animation');
      }
      // Если соединение потеряно без возможности переподключения, пульсация уже есть

      // Приостанавливаем AudioContext после закрытия виджета, чтобы сэкономить ресурсы на мобильных
      if (audioContext && audioContext.state === 'running') {
           widgetLog("Suspending AudioContext on widget close.");
          audioContext.suspend().catch(err => {
               widgetLog(`Failed to suspend AudioContext: ${err.message}`, 'error');
          });
           widgetState.isMicInitialized = false; // Флаг сбрасывается, потребуется resume
      }
    };

    // Обработчик клика по основному кругу (Микрофон)
    const handleMainCircleClick = async () => {
       widgetLog(`Main Circle clicked. State: ${widgetState.current}`);

       // Если виджет открыт и не находится в состоянии прослушивания, воспроизведения или переподключения
       if (widgetState.isWidgetOpen && !widgetState.isListening && !widgetState.isPlayingAudio && !widgetState.isReconnecting && widgetState.current !== 'LOADING') {
           if (widgetState.isConnected) {
                // Если подключено, пытаемся начать слушать (после инициализации микрофона, если требуется)
               widgetLog("Connected and idle. Attempting to start listening via circle click.");
               await initMic(); // Попытка инициализации микрофона (или возобновления AudioContext)
               // initMic обновит isMicInitialized и, возможно, покажет iOS кнопку или ошибку.
               // startListening будет вызван либо сразу после успешного initMic, либо при клике по iOS кнопке.
               if (widgetState.isMicInitialized && audioContext && audioContext.state === 'running') {
                   startListening(); // Микрофон готов, начинаем слушать сразу
               } else if (isIOS && getDOMElements() && elements.iosAudioButton && !widgetState.isMicInitialized) {
                    // На iOS показываем кнопку активации
                    elements.iosAudioButton.classList.add('visible');
                   updateState('CONNECTED', "Нажмите кнопку ниже для активации микрофона");
               } else if (widgetState.current !== 'ERROR') {
                   // В других случаях (например, Android mic init failed) остаемся в CONNECTED
                    updateState('CONNECTED', 'Ошибка микрофона. Проверьте разрешения.'); // Уточняем сообщение
               }

           } else if (widgetState.connectionFailedPermanently) {
               // Если ошибка невосстановима, показываем сообщение об ошибке соединения
                showConnectionError("Не удалось подключиться к серверу. Нажмите кнопку 'Повторить подключение'.");
               updateState('ERROR', 'Отключено'); // Обновляем статус
           } else {
               // Если не подключено, но ошибка не невосстановима, пробуем подключиться
               widgetLog("Not connected and not permanently failed. Attempting to connect via circle click.");
               connectWebSocket();
           }
       } else if (widgetState.isListening) {
           // Если слушаем, клик означает "Стоп" (конец фразы)
           widgetLog("Listening. Stopping listening and committing buffer via circle click.");
           stopListening(); // Останавливаем прослушивание (отправка stream.stop)
           commitAudioBuffer(); // Отправляем команду коммита для обработки накопленного буфера

       } else if (widgetState.isPlayingAudio) {
           // Если говорим, клик означает "Прервать"
           widgetLog("Speaking. Stopping playback via circle click.");
           // Очищаем очередь воспроизведения и останавливаем текущий узел
           audioPlaybackQueue = [];
           if (audioBufferSourceNode) {
                try { audioBufferSourceNode.stop(); } catch(e) { widgetLog(`Error stopping AudioBufferSourceNode: ${e.message}`, 'warn');}
                audioBufferSourceNode = null;
           }
           widgetState.isPlayingAudio = false; // Меняем флаг
            audioPlaybackStartTime = 0; // Сбрасываем время начала
            audioPlaybackOffset = 0; // Сбрасываем смещение

           // Также прерываем обработку на сервере (если сервер поддерживает response.cancel)
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                 websocket.send(JSON.stringify({ type: "response.cancel", event_id: `cancel_${Date.now()}` }));
                 widgetLog("Отправлена команда response.cancel");
            }

           updateState('CONNECTED', 'Отменено.'); // Обновляем статус и сообщение
            // И сразу пытаемся вернуться к прослушиванию, если виджет открыт
            if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isReconnecting) {
                 setTimeout(() => {
                     if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isListening && !widgetState.isReconnecting) {
                         startListening();
                     }
                 }, 500); // Короткая пауза
            } else if (!widgetState.isWidgetOpen) {
                 updateState('IDLE', 'Отменено.');
            }
       }
       // Если в состоянии LOADING, CONNECTING, RECONNECTING, клик игнорируется
    };

     // Обработчик клика по кнопке активации iOS аудио
    const handleIOSAudioButtonClick = async () => {
        widgetLog("iOS Audio Button clicked.");
         if (!getDOMElements() || !elements.iosAudioButton) return; // Проверка элементов

        // Попытка инициализировать микрофон и активировать AudioContext
        const success = await initMic(); // initMic сам попытается resume/create

        if (success && audioContext && audioContext.state === 'running') {
             widgetLog("iOS AudioContext активирован после клика по кнопке.");
            widgetState.isMicInitialized = true; // Флаг успешной инициализации
            elements.iosAudioButton.classList.remove('visible'); // Скрываем кнопку

             // Пытаемся начать слушать, если виджет открыт и состояние позволяет
             if (widgetState.isWidgetOpen && widgetState.isConnected && !widgetState.isListening && !widgetState.isReconnecting) {
                 startListening(); // Начинаем слушать
             } else if (widgetState.isWidgetOpen && widgetState.current === 'CONNECTED') {
                 // Виджет открыт, подключен, но не LISTENING/SPEAKING - ждем клика по кругу
                  updateState('CONNECTED', 'Нажмите микрофон для начала.');
             }

        } else {
             widgetLog("Не удалось активировать iOS AudioContext после клика.", "warn");
             // Кнопка останется видимой, если не удалось
             updateState('CONNECTED', "Не удалось активировать микрофон. Нажмите снова."); // Обновляем сообщение
             // Не сбрасываем isMicInitialized = false, т.к. это уже сделано в initMic, если была ошибка.
             if (getDOMElements() && elements.iosAudioButton) {
                 elements.iosAudioButton.classList.add('visible'); // Убеждаемся, что кнопка видима
             }
        }
         updateUI(); // Обновляем UI в любом случае
    };


  // --- HTML Структура и Стили (интегрированы для самодостаточности) ---

  // SVG Иконки (замена Font Awesome)
  // Path data взята из Font Awesome Free SVG @ 6.5.1
  const svgIcons = {
      robot: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512"><path fill="currentColor" d="M272 512c-9.6 0-19.2-3.8-26.5-11.1l-32-32c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l32 32c7.8 7.8 20.5 7.8 28.3 0l32-32c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3l-32 32c-7.3 7.3-16.9 11.1-26.5 11.1H272zM256 256c0-17.7 14.3-32 32-32h64c17.7 0 32 14.3 32 32v96c0 17.7-14.3 32-32 32H288c-17.7 0-32-14.3-32-32V256zM544 160H96C43 160 0 203 0 256v32C0 336.8 35.2 372 80 372c17.7 0 32-14.3 32-32s-14.3-32-32-32c-8.8 0-16-7.2-16-16s7.2-16 16-16H560c8.8 0 16 7.2 16 16s-7.2 16-16 16c-17.7 0-32 14.3-32 32s14.3 32 32 32c44.8 0 80-35.2 80-80V256c0-53-43-96-96-96zM160 128c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32H480c-17.7 0-32 14.3-32 32V96c0 17.7 14.3 32 32 32h32c17.7 0 32-14.3 32-32V64c0-35.3-28.7-64-64-64H160C124.7 0 96 28.7 96 64V96c0 17.7 14.3 32 32 32h32z"/></svg>',
      times: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512"><path fill="currentColor" d="M310.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L160 210.7 54.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L114.7 256 9.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L160 301.3 265.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L205.3 256 310.6 150.6z"/></svg>',
      microphone: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="currentColor" d="M192 0C159.2 0 133.3 25.88 133.3 58.67V160C133.3 192.8 159.2 218.7 192 218.7C224.8 218.7 250.7 192.8 250.7 160V58.67C250.7 25.88 224.8 0 192 0zM368 218.7C358.4 218.7 349.3 222.5 342.6 229.2C335.9 235.9 332 245 332 254.7V320C332 407.5 262.8 477.3 176 478.9C175.8 478.9 175.6 478.9 175.3 478.9H176C89.24 477.3 20 407.5 20 320V254.7C20 245 16.13 235.9 9.375 229.2C2.617 222.5-6.506 218.7-16 218.7C-25.5 218.7-34.62 222.5-41.38 229.2C-48.04 235.9-51.91 245-51.91 254.7V320C-51.91 440.3 42.05 538.7 160 543.5V576C160 585.7 163.9 594.7 170.6 601.4C177.3 608.1 186.4 612 195.1 612C204.7 612 213.8 608.1 220.5 601.4C227.2 594.7 231 585.7 231 576V543.5C349 538.7 442.9 440.3 442.9 320V254.7C442.9 245 439 235.9 432.2 229.2C425.5 222.5 416.4 218.7 406.9 218.7H368z"/></svg>'
  };


  // Создание стилей (встраиваем CSS прямо в JS)
  function createStyles() {
      if (document.getElementById('wellcomeai-widget-styles')) return; // Избегаем дублирования
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
          /* Начальное состояние - скрыто */
          opacity: 0;
          pointer-events: none;
        }

        /* Активация контейнера при открытии */
        .wellcomeai-widget-container.active {
          opacity: 1;
          pointer-events: all;
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
          z-index: 2147483647; /* Кнопка должна быть поверх развернутого виджета */
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

        .wellcomeai-widget-icon svg { /* Стили для SVG внутри кнопки */
          color: white;
          width: 22px;
          height: 22px;
          z-index: 2;
          transition: all 0.3s ease;
        }

        .wellcomeai-widget-expanded {
          position: absolute;
          ${WIDGET_POSITION.vertical}: 0;
          ${WIDGET_POSITION.horizontal}: 0;
          width: 320px;
          max-width: 90vw; /* Ограничение ширины для маленьких экранов */
          height: 0; /* Изначально свернут */
          opacity: 0;
          pointer-events: none;
          background: white;
          border-radius: 20px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
          overflow: hidden;
          transition: height 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
          display: flex;
          flex-direction: column;
          z-index: 2147483646; /* Ниже кнопки */
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
          flex-shrink: 0; /* Не сжимать шапку */
          padding: 15px 20px;
          background: linear-gradient(135deg, #4a86e8, #2b59c3);
          color: white;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-radius: 20px 20px 0 0;
           user-select: none; /* Не выделять текст */
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
          display: flex; /* Центрирование SVG */
          align-items: center;
          justify-content: center;
        }
         .wellcomeai-widget-close svg {
             width: 18px;
             height: 18px;
         }

        .wellcomeai-widget-close:hover {
          opacity: 1;
          transform: scale(1.1);
        }

        .wellcomeai-widget-content {
          flex: 1; /* Занимает все доступное место */
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: #f9fafc;
          position: relative;
          padding: 20px;
          overflow: hidden; /* Скрываем контент, выходящий за рамки */
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
          cursor: pointer; /* Круг кликабельный */
           user-select: none;
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
           /* Использование радиального градиента для эффекта расходящихся волн */
           background: radial-gradient(circle, transparent 50%, rgba(76, 175, 80, 0.1) 100%);
           border-radius: 50%;
           animation: wellcomeai-ripple 2s ease-out infinite; /* Анимация "ряби" */
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


        .wellcomeai-mic-icon svg { /* Стили для SVG иконки микрофона */
          color: #4a86e8;
          width: 32px;
          height: 32px;
          z-index: 10;
        }

        .wellcomeai-main-circle.listening .wellcomeai-mic-icon svg {
          color: #2196f3;
        }

        .wellcomeai-main-circle.speaking .wellcomeai-mic-icon svg {
          color: #4caf50;
        }

        .wellcomeai-audio-visualization {
          position: absolute;
          width: 100%;
          max-width: 160px;
          height: 30px;
          bottom: 15px; /* Немного выше */
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
          height: 2px; /* Минимальная высота */
          background-color: #4a86e8;
          border-radius: 1px;
          transition: height 0.1s ease;
        }
         .wellcomeai-main-circle.listening .wellcomeai-audio-bar {
             background-color: #2196f3; /* Синий при прослушивании */
         }
         .wellcomeai-main-circle.speaking .wellcomeai-audio-bar {
             background-color: #4caf50; /* Зеленый при воспроизведении */
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
          z-index: 2147483640; /* Ниже основных элементов виджета */
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
          bottom: 80px; /* Выше, чтобы не перекрывать статус и кнопку iOS */
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
          max-height: 80px; /* Ограничиваем высоту, чтобы не перекрывать все */
          overflow-y: auto;
          z-index: 10;
          pointer-events: none; /* Сообщение не должно блокировать клики */
        }

        .wellcomeai-message-display.show {
          opacity: 1;
           pointer-events: auto; /* Активно, только когда показано, но только для чтения */
        }

        @keyframes wellcomeai-button-pulse {
          0% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0.7); }
          70% { box-shadow: 0 0 0 15px rgba(74, 134, 232, 0); } /* Увеличен радиус пульсации */
          100% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0); }
        }

        .wellcomeai-pulse-animation {
          animation: wellcomeai-button-pulse 2s infinite;
        }

        .wellcomeai-connection-error {
          color: #ef4444;
          background-color: rgba(254, 226, 226, 0.9); /* Немного менее прозрачный фон */
          border: 1px solid #ef4444;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          margin-top: 10px;
          text-align: center;
          display: flex; /* Используем flex для центрирования текста и кнопки */
          flex-direction: column;
          align-items: center;
          gap: 5px; /* Отступ между текстом и кнопкой */
          position: absolute; /* Абсолютное позиционирование внутри контента */
          bottom: 20px; /* Позиция внизу */
          left: 20px; /* Отступы от краев */
          right: 20px;
          z-index: 20; /* Выше других элементов контента */
          visibility: hidden; /* Изначально скрыто */
          opacity: 0;
          transition: opacity 0.3s, visibility 0.3s;
        }

        .wellcomeai-connection-error.visible {
          visibility: visible;
          opacity: 1;
        }

        .wellcomeai-retry-button {
          background-color: #ef4444;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 5px 10px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
          flex-shrink: 0; /* Не сжимать кнопку */
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
          background-color: rgba(255, 255, 255, 0.8); /* Чуть менее прозрачный */
          display: flex;
          align-items: center;
          gap: 5px;
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.3s, visibility 0.3s;
          z-index: 15; /* Выше основной визуализации, но ниже сообщения */
          user-select: none; /* Не выделять текст статуса */
        }

        .wellcomeai-status-indicator.show {
          opacity: 1;
          visibility: visible;
        }

        .wellcomeai-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background-color: #64748b; /* Серый по умолчанию */
        }

        .wellcomeai-status-dot.connected {
          background-color: #10b981; /* Зеленый */
        }

        .wellcomeai-status-dot.disconnected {
          background-color: #ef4444; /* Красный */
        }

        .wellcomeai-status-dot.connecting {
          background-color: #f59e0b; /* Оранжевый */
        }

        /* Кнопка принудительной активации аудио для iOS */
        .wellcomeai-ios-audio-button {
          position: absolute;
          bottom: 20px; /* Позиция */
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
          display: none; /* Изначально скрыта */
          z-index: 100; /* Высокий z-index */
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
           transition: background-color 0.2s ease;
        }

        .wellcomeai-ios-audio-button:hover {
            background-color: #2b59c3;
        }

        .wellcomeai-ios-audio-button.visible {
          display: block;
        }

        /* Медиа-запросы для адаптации на маленьких экранах */
        @media (max-width: 400px) {
            .wellcomeai-widget-expanded {
                 width: 95vw; /* Немного уже на очень маленьких экранах */
                 height: 350px; /* Меньше высота */
            }
             .wellcomeai-main-circle {
                 width: 150px; /* Меньше круг */
                 height: 150px;
             }
            .wellcomeai-mic-icon svg {
                width: 28px; /* Меньше иконка микрофона */
                height: 28px;
            }
            .wellcomeai-audio-visualization {
                 max-width: 130px; /* Меньше визуализация */
                 bottom: 10px;
            }
             .wellcomeai-message-display {
                 bottom: 60px; /* Выше сообщение */
                 font-size: 13px;
                 max-height: 70px;
             }
             .wellcomeai-ios-audio-button {
                 bottom: 15px; /* Ниже кнопка iOS */
                 font-size: 12px;
                 padding: 6px 10px;
             }
             .wellcomeai-connection-error {
                 bottom: 10px; /* Ниже ошибка */
                 left: 10px;
                 right: 10px;
                 padding: 6px 10px;
                 font-size: 12px;
             }
        }
      `;
      document.head.appendChild(styleEl);
      widgetLog("Styles created and added to head.");
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
      if (document.getElementById('wellcomeai-widget-container')) {
          widgetLog('Widget container already exists during createWidgetHTML. Skipping.');
          return; // Избегаем дублирования
      }

      const widgetContainer = document.createElement('div');
      widgetContainer.className = 'wellcomeai-widget-container';
      widgetContainer.id = 'wellcomeai-widget-container';
      // Z-index и видимость будут управляться через CSS класс 'active' и JS

      widgetContainer.innerHTML = `
        <!-- Кнопка (минимизированное состояние) -->
        <div class="wellcomeai-widget-button" id="wellcomeai-widget-button">
          <span class="wellcomeai-widget-icon">${svgIcons.robot}</span>
        </div>

        <!-- Развернутый виджет -->
        <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
          <div class="wellcomeai-widget-header">
            <div class="wellcomeai-widget-title">WellcomeAI</div>
            <button class="wellcomeai-widget-close" id="wellcomeai-widget-close">
              ${svgIcons.times}
            </button>
          </div>
          <div class="wellcomeai-widget-content">
            <!-- Основной элемент - круг с иконкой микрофона -->
            <div class="wellcomeai-main-circle" id="wellcomeai-main-circle">
              <span class="wellcomeai-mic-icon">${svgIcons.microphone}</span>

              <!-- Аудио визуализация -->
              <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
                <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
              </div>
            </div>

            <!-- Сообщение UI (текст ответа или статус) -->
            <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>

            <!-- Сообщение об ошибке соединения -->
            <div class="wellcomeai-connection-error" id="wellcomeai-connection-error">
              <!-- Content populated by JS -->
            </div>

            <!-- Специальная кнопка для активации аудио на iOS -->
            <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
              Нажмите для активации
            </button>

            <!-- Индикатор статуса -->
            <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
              <span class="wellcomeai-status-dot" id="wellcomeai-status-dot"></span>
              <span id="wellcomeai-status-text">Загрузка...</span>
            </div>
          </div>
        </div>

        <!-- Модальное окно загрузки -->
        <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active">
          <div class="wellcomeai-loader"></div>
        </div>
      `;

      document.body.appendChild(widgetContainer);
      widgetLog("HTML structure created and appended to body.");

      // Собираем элементы после их создания, чтобы создать аудио-бары
      if (getDOMElements()) {
          createAudioBars(); // Создаем аудио-бары сразу после создания HTML
      } else {
          widgetLog("Could not get elements after creating HTML. Audio bars not created.", 'error');
      }
  }

    // Создание аудио-баров для визуализации
    function createAudioBars(count = 25) { // Увеличил количество баров для более плавной визуализации
      if (!getDOMElements() || !elements.audioBarsContainer) {
         widgetLog("Cannot create audio bars, container element not found.", 'warn');
         return;
      }
      elements.audioBarsContainer.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        elements.audioBarsContainer.appendChild(bar);
      }
       widgetLog(`Created ${count} audio bars.`);
    }


  // --- Инициализация и События ---

  function initWidget() {
    widgetLog('Initializing widget logic...');

    // Собираем ссылки на DOM элементы. Это нужно сделать первым делом.
    if (!getDOMElements()) {
        widgetLog("Failed to get essential DOM elements. Aborting initialization.", 'error');
        updateState('ERROR', 'Ошибка инициализации виджета.');
        widgetState.connectionFailedPermanently = true; // Считаем фатальной ошибкой
        return;
    }

     // Аудио бары уже должны быть созданы в createWidgetHTML после getDOMElements

    // Добавляем обработчики событий UI
    if(elements.widgetButton) elements.widgetButton.addEventListener('click', openWidget);
    if(elements.widgetClose) elements.widgetClose.addEventListener('click', closeWidget);
    if(elements.mainCircle) elements.mainCircle.addEventListener('click', handleMainCircleClick);

     if (isIOS && elements.iosAudioButton) {
          elements.iosAudioButton.addEventListener('click', handleIOSAudioButtonClick);
     }

     // Обработчик кнопки повтора (изначально отсутствует, добавляется при показе ошибки)
     // Добавляется динамически в showConnectionError

    // Начинаем с состояния LOADING и пытаемся подключиться
    updateState('LOADING', 'Загрузка...');
    connectWebSocket();

     // Дополнительная проверка DOM и состояния после небольшой задержки
     setTimeout(() => {
         widgetLog('Post-initialization DOM and State check.');
         widgetLog(`Current State: ${widgetState.current}`);
         // Проверяем доступность элементов перед использованием
         if (getDOMElements()) {
            widgetLog(`UI Elements Visibility: Loader=${elements.loaderModal.classList.contains('active')}, Message=${elements.messageDisplay.classList.contains('show')}, Error=${elements.connectionError.classList.contains('visible')}, iOSButton=${elements.iosAudioButton && elements.iosAudioButton.classList.contains('visible')}`);
         } else {
            widgetLog("Post-init check: DOM elements are not accessible.", 'warn');
         }
         if (audioContext) {
              widgetLog(`AudioContext State: ${audioContext.state}, SampleRate: ${audioContext.sampleRate}`);
         } else {
              widgetLog("AudioContext is not yet created.");
         }
          if (mediaStream) {
              widgetLog("MediaStream obtained.");
          } else {
              widgetLog("MediaStream not obtained.");
          }
          if (websocket) {
              widgetLog(`WebSocket State: ${websocket.readyState}`);
          } else {
               widgetLog("WebSocket object is null.");
          }


     }, 2000);
  }

  // --- Главная Точка Входа ---
  widgetLog('WellcomeAI Widget script loaded.');

  // Проверяем, есть ли уже виджет на странице по его ID
  // Создаем стили и HTML ПЕРВЫМ ДЕЛОМ, если виджета нет.
  if (!document.getElementById('wellcomeai-widget-container')) {
    widgetLog('Widget container not found. Starting full initialization.');

    // Создаем стили и HTML структуру
    createStyles();
    createWidgetHTML(); // Это создаст HTML и попытается собрать элементы и создать бары

    // Ждем загрузки DOM, если он еще не готов
    // Инициализация логики initWidget должна происходить только после того, как HTML добавлен в DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWidget);
        widgetLog('Will initialize logic on DOMContentLoaded.');
    } else {
        // DOM уже готов, инициализируем логику сразу
        widgetLog('DOM already loaded. Initializing logic immediately.');
        initWidget();
    }
  } else {
    // Виджет уже существует. Возможно, нужно проверить его состояние или обновить
    widgetLog('Widget container already exists on the page. Skipping full initialization.');
    // TODO: Возможно, добавить логику "присоединения" к существующему виджету
    // или просто игнорировать, если предполагается только одно встраивание.
    // Для текущей версии просто игнорируем.
  }
})();
