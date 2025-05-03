* WellcomeAI Widget Loader Script
 * Версия: 1.3.1 (Merged Original Structure with One-Click Activation)
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


  // --- Вспомогательные функции (аудио, утилиты, UI) ---
  // Перемещены сюда, чтобы быть доступными для initializeWidget и других функций

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
            const mainCircle = document.getElementById('wellcomeai-main-circle');
            if(mainCircle) mainCircle.classList.remove('speaking');
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
                         const mainCircle = document.getElementById('wellcomeai-main-circle');
                         if(mainCircle) mainCircle.classList.add('inactive');
                         showMessage("Нажмите на микрофон, чтобы начать разговор");
                         updateConnectionStatus('connected', 'Готов');
                     }
                 }, 500); // Увеличиваем задержку для стабильности
            } else if (!isWidgetOpen && isConnected && !connectionFailedPermanently) {
                 // Если виджет закрыт и есть соединение, показываем пульсацию
                 const widgetButton = document.getElementById('wellcomeai-widget-button');
                 if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
            } else {
                 // Если соединение потеряно или ошибка, показываем ошибку/статус при открытом виджете
                 if (connectionFailedPermanently && isWidgetOpen) {
                      showError("Не удалось восстановить соединение.");
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
        const mainCircle = document.getElementById('wellcomeai-main-circle');
        if(mainCircle) {
            mainCircle.classList.add('speaking');
            mainCircle.classList.remove('inactive', 'listening');
        }
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
                          const mainCircle = document.getElementById('wellcomeai-main-circle');
                          if(mainCircle) { mainCircle.classList.remove('speaking'); mainCircle.classList.add('inactive'); }
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
                       const mainCircle = document.getElementById('wellcomeai-main-circle');
                       if(mainCircle) { mainCircle.classList.remove('speaking'); mainCircle.classList.add('inactive'); }
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
      mainCircle.classList.remove('inactive', 'connecting', 'listening', 'speaking'); // Удаляем все классы состояния с круга

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
      }

      // Показываем индикатор, если виджет открыт или есть постоянная ошибка/подключение
      if (isWidgetOpen || status !== 'connected' || connectionFailedPermanently) {
           statusIndicator.classList.add('show');
           // Скрываем через некоторое время, если это не ошибка/подключение и виджет открыт
           if (isWidgetOpen && status === 'connected' && message !== 'Слушаю...' && message !== 'Говорю...' && message !== 'Обработка...') {
               setTimeout(() => {
                   statusIndicator.classList.remove('show');
               }, 3000);
           }
      } else {
           statusIndicator.classList.remove('show'); // Скрываем индикатор статуса при закрытом виджете и статусе 'connected'
      }

       // Если есть постоянная ошибка соединения, показываем ошибку в UI при открытом виджете
       if (connectionFailedPermanently && isWidgetOpen) {
            showError("Не удалось подключиться к серверу.");
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

        // Добавляем обработчик для новой кнопки повтора - ДЕЛЕГИРОВАНО В initializeWidget
        // const newRetryButton = errorMessageDiv.querySelector('#wellcomeai-retry-button');
        // if (newRetryButton) {
        //   newRetryButton.addEventListener('click', function() { /* ... */ });
        // }
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
          showMessage("Подключение...", 0);
          updateConnectionStatus('connecting', 'Подключение...');
           const mainCircle = document.getElementById('wellcomeai-main-circle');
           if(mainCircle) { mainCircle.classList.remove('listening', 'speaking'); mainCircle.classList.add('inactive'); }
      } else {
           // Если виджет закрыт, просто убираем пульсацию и пробуем подключиться в фоне
           const widgetButton = document.getElementById('wellcomeai-widget-button');
           if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
      }


      // Пытаемся подключиться заново
      connectWebSocket();
    }


    // Инициализация микрофона и AudioContext (создание графа)
    // Эту функцию можно вызвать рано, она не запрашивает разрешение.
    async function setupAudioGraph() {
      try {
        if (audioContext && audioProcessor) {
           widgetLog("Audio graph already setup.");
           return true; // Уже инициализировано
        }

        widgetLog("Setting up audio graph...");

        // Проверяем поддержку AudioContext
         if (!window.AudioContext && !window.webkitAudioContext) {
             throw new Error("Ваш браузер не поддерживает Web Audio API (AudioContext)");
         }

        // Создаем AudioContext.
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
                const audioProcessingConfig = { // Конфигурация для обработки аудио
                    silenceThreshold: isMobile ? 0.015 : 0.01,
                    silenceDuration: isMobile ? 600 : 400,
                    soundDetectionThreshold: isMobile ? 0.015 : 0.02
                };
                 const soundThreshold = isIOS ? 0.005 : audioProcessingConfig.soundDetectionThreshold; // Более низкий порог для iOS

                if (!hasAudioData && maxAmplitude > soundThreshold) {
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
             const audioProcessingConfig = { // Конфигурация для обработки аудио
                silenceThreshold: isMobile ? 0.015 : 0.01,
                silenceDuration: isMobile ? 600 : 400,
                soundDetectionThreshold: isMobile ? 0.015 : 0.02
            };
            const silenceThreshold = isMobile ? audioProcessingConfig.silenceThreshold * 0.8 : audioProcessingConfig.silenceThreshold; // Чуть более строгий порог для детекции тишины при тишине

            if (currentAmplitude > silenceThreshold) {
                 // Есть звук, сбрасываем таймер тишины
                isSilent = false;
                silenceStartTime = now;
            } else {
                 // Тишина
                 if (!isSilent) { // Только что наступила тишина
                     const silenceDuration = now - silenceStartTime;

                     if (silenceDuration > audioProcessingConfig.silenceDuration) {
                         isSilent = true;
                         widgetLog(`Тишина детектирована (${audioProcessingConfig.silenceDuration} мс), отправляем commit, если есть данные.`);

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


        // Подключаем поток с микрофона к процессору.
        // mediaStream еще может быть null здесь, подключение произойдет в ensureAudioInitializedAndReady
        if (mediaStream) {
             const streamSource = audioContext.createMediaStreamSource(mediaStream);
             streamSource.connect(audioProcessor);

             // Подключаем процессор к выходу аудиоконтекста (но с нулевой громкостью)
             const gainNode = audioContext.createGain();
             gainNode.gain.value = 0; // Установка громкости на ноль
             audioProcessor.connect(gainNode);
             gainNode.connect(audioContext.destination);
             widgetLog("Audio graph connected stream and gain node.");
        } else {
             widgetLog("Audio graph created, but media stream not yet available. Will connect later.");
              // Processor пока не подключен к источнику и выходу.
              // Это произойдет в ensureAudioInitializedAndReady после получения mediaStream.
        }


        widgetLog("Аудио граф инициализирован (созданы Context и Processor).");
        return true;

      } catch (error) {
        widgetLog(`Ошибка настройки аудио графа: ${error.message}`, "error");
        // Ошибки на этом этапе (до getUserMedia) маловероятны, но возможны (напр. браузер без AudioContext)
        // showError("Не удалось настроить аудио. Пожалуйста, обновите браузер."); // Можно показать пользователю
        return false;
      }
    }

    // Функция для активации AudioContext и запроса микрофона
    // Должна быть вызвана в ответ на явный жест пользователя (например, клик по кнопке виджета).
    // Эта функция также подключает mediaStream к audioProcessor, если это еще не сделано.
    async function ensureAudioInitializedAndReady() {
        widgetLog("Ensuring AudioContext and MediaStream are ready (triggered by user gesture)...");

        try {
             // 1. Проверяем и возобновляем AudioContext
             if (!audioContext) {
                 // Если контекст еще не создан (что маловероятно, если setupAudioGraph вызвана), создаем его сейчас
                 const contextOptions = { sampleRate: isMobile ? 16000 : 24000 };
                 audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
                 widgetLog(`AudioContext created by user gesture with sample rate: ${audioContext.sampleRate} Hz`);
             }

             if (audioContext.state === 'suspended') {
                 widgetLog("Attempting to resume AudioContext...");
                 await audioContext.resume();
                 widgetLog("AudioContext resumed successfully.");
             }

             // 2. Запрашиваем доступ к микрофону и получаем MediaStream
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
             }


             // 3. Подключаем MediaStream к AudioProcessor (если не подключен)
             if (mediaStream && audioProcessor && audioContext && audioContext.state !== 'closed') {
                 // Проверяем, подключен ли streamSource к processor. Это нетривиально.
                 // Проще переподключить, если processor существует, но не соединен с destination (т.е. с нашим gainNode)
                 let processorConnectedToDestination = false;
                  try {
                     // Проверяем входящие соединения destination. Это не стандартный API, может не работать везде.
                      // Или просто проверяем, что audioProcessor имеет output connections.
                      // Более надежный способ: проверить, что processor подключен к узлу с нулевым гейном, который подключен к destination
                      const destinationInputs = audioContext.destination.numberOfInputs; // Всегда 1
                      // console.log(audioContext.destination.numberOfInputs); // Отладка
                      // Не существует стандартного API для проверки исходящих соединений у ProcessorNode.
                      // Предполагаем, что если processor существует, но не подключен, его нужно подключить.

                      // Если processor существует, но не подключен к выходу, подключаем
                      if (audioProcessor.numberOfOutputs > 0) { // Проверяем, что у processor есть выходы
                         // Попытка переподключить: сначала отключаем все, потом подключаем
                         try { audioProcessor.disconnect(); } catch(e) {}
                         const streamSource = audioContext.createMediaStreamSource(mediaStream);
                         streamSource.connect(audioProcessor);
                         // Убедимся, что processor подключен к выходу (через нулевой gainNode)
                         const gainNode = audioContext.createGain();
                         gainNode.gain.value = 0;
                         audioProcessor.connect(gainNode);
                         gainNode.connect(audioContext.destination);
                         widgetLog("Reconnected audio processor to stream source and gain node.");
                         processorConnectedToDestination = true; // Считаем подключенным
                      } else {
                           // Если processor не имеет выходов, это странная ситуация или ошибка создания
                           throw new Error("Audio processor has no output channels.");
                      }

                  } catch (e) {
                       widgetLog(`Error during audio graph connection check/reconnection: ${e.message}`, 'warn');
                        // Если переподключение не удалось, возможно, нужно пересоздать весь граф?
                        widgetLog("Attempting to recreate audio graph due to connection issue.");
                        await setupAudioGraph(); // Пересоздаем граф, который должен теперь использовать mediaStream
                        // После пересоздания графа с mediaStream, processor должен быть подключен
                        if (audioContext && audioProcessor && audioContext.state !== 'closed' && audioProcessor.numberOfOutputs > 0) {
                             processorConnectedToDestination = true;
                        } else {
                             throw new Error("Failed to recreate and connect audio graph.");
                        }
                  }
                  // Если processor не существовал, setupAudioGraph его создаст и подключит
             } else if (mediaStream && audioContext && audioContext.state !== 'closed' && !audioProcessor) {
                  // Если mediaStream и Context есть, но Processor нет, создаем и подключаем
                  widgetLog("Audio processor not found but stream/context exist. Setting up audio graph.");
                  await setupAudioGraph();
                  // После создания графа, он должен быть подключен к stream и destination
                  if (audioContext && audioProcessor && audioContext.state !== 'closed' && audioProcessor.numberOfOutputs > 0) {
                       // Проверяем, что streamSource подключен к processor
                       // Нет прямого API для проверки, полагаемся на логику setupAudioGraph
                        const streamSource = audioContext.createMediaStreamSource(mediaStream);
                       try { streamSource.connect(audioProcessor); } catch(e) { widgetLog(`Error connecting streamSource after late setup: ${e.message}`, 'warn'); }
                        const gainNode = audioContext.createGain();
                        gainNode.gain.value = 0;
                       try { audioProcessor.connect(gainNode); } catch(e) { widgetLog(`Error connecting processor to gain after late setup: ${e.message}`, 'warn'); }
                       try { gainNode.connect(audioContext.destination); } catch(e) { widgetLog(`Error connecting gain to destination after late setup: ${e.message}`, 'warn'); }
                       widgetLog("Audio graph setup and connected late.");
                       processorConnectedToDestination = true;
                  } else {
                       throw new Error("Failed to setup audio graph after getting media stream.");
                  }
             }


            widgetLog("Audio is ready (Context running, MediaStream obtained, Processor connected).");
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
                widgetLog("Stopping media stream tracks due to error.");
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
            }
            // audioProcessor и audioContext могут быть оставлены, но их состояние нерабочее
            // Для надежности можно попробовать их сбросить/закрыть
            // if (audioProcessor) { try{audioProcessor.disconnect();}catch(e){} audioProcessor.onaudioprocess = null; audioProcessor = null; }
            // if (audioContext && audioContext.state !== 'closed') { audioContext.close().catch(e => widgetLog(`Error closing context after error: ${e.message}`,'warn')); audioContext = null; }


            return false; // Сигнализируем об ошибке
        }
    }


    // Начало записи голоса
    async function startListening() {
      const mainCircle = document.getElementById('wellcomeai-main-circle');
      if (!mainCircle) { widgetLog("Main circle UI element not found.", 'warn'); return; }

      // Проверяем все условия перед стартом
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
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

         // Если аудио не готово, пытаемся его активировать (это произойдет при клике открытия или клике на круг)
         if (!audioContext || audioContext.state !== 'running' || !mediaStream || !audioProcessor) {
              widgetLog("Audio not ready, cannot start listening.");
              showMessage("Нажмите на микрофон, чтобы начать разговор"); // Текст для неактивного состояния
              mainCircle.classList.add('inactive');
              mainCircle.classList.remove('listening', 'speaking', 'connecting'); // Удаляем connecting
         } else {
              // Если соединение и аудио готовы, но мы не слушаем/говорим, возможно, просто нужно вызвать ensureAudio...
              // Но вызов ensureAudio... должен быть в ответ на жест. startListening сам по себе не должен запрашивать микрофон.
              // Если startListening вызвана, значит жест УЖЕ был (openWidget или клик по кругу).
              // Если здесь аудио НЕ готово, это проблема, которую ensureAudio... должна была решить.
              widgetLog("Audio should be ready but isn't. ensureAudioInitializedAndReady likely failed or wasn't called by gesture.", 'error');
              // UI останется в inactive/error состоянии, показанном ensureAudio...
         }

        return; // Выходим, если не можем начать
      }

       // Если мы дошли сюда, значит, соединение установлено, аудио готово (проверено ранее), и мы не слушаем/говорим.
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
       mainCircle.classList.remove('inactive', 'speaking', 'connecting');

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
         const mainCircle = document.getElementById('wellcomeai-main-circle');
         if(mainCircle) mainCircle.classList.remove('listening');

         // Если не говорим, переходим в неактивное состояние
         if (!isPlayingAudio) {
            if(mainCircle) mainCircle.classList.add('inactive');
            showMessage("Нажмите на микрофон, чтобы начать разговор"); // Текст для неактивного состояния
             updateConnectionStatus('connected', 'Готов');
             resetAudioVisualization(); // Сбрасываем визуализацию
         } else {
             // Если начали говорить, UI уже в состоянии speaking, не меняем его
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
            // Если widgetOpen и не слушаем/говорим, переходим в неактивное состояние
           if(isWidgetOpen && !isListening && !isPlayingAudio){
               const mainCircle = document.getElementById('wellcomeai-main-circle');
               if(mainCircle) mainCircle.classList.add('inactive');
               mainCircle.classList.remove('listening', 'speaking', 'connecting'); // Удаляем connecting
               showMessage("Нажмите на микрофон, чтобы начать разговор");
               updateConnectionStatus('connected', 'Готов');
               resetAudioVisualization();
           }
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
            const mainCircle = document.getElementById('wellcomeai-main-circle');
            if(mainCircle) mainCircle.classList.add('inactive');
            mainCircle.classList.remove('listening', 'speaking', 'connecting'); // Удаляем connecting
            showMessage("Нажмите на микрофон, чтобы начать разговор");
             updateConnectionStatus('connected', 'Готов');
             resetAudioVisualization();
        }
        return;
      }


      widgetLog("Отправка команды input_audio_buffer.commit");

      // Сбрасываем эффект прослушивания сразу при успешной отправке команды
       const mainCircle = document.getElementById('wellcomeai-main-circle');
       if(mainCircle) mainCircle.classList.remove('listening');

      // Пока не начали говорить, переходим в состояние "обработка" или "ожидание"
      if (!isPlayingAudio) {
          showMessage("Обработка...", 0); // Показываем статус обработки
           updateConnectionStatus('connected', 'Обработка...');
           if(mainCircle) mainCircle.classList.add('inactive'); // Или добавить класс 'processing' если есть стили
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
      // const loaderModal = document.getElementById('wellcomeai-loader-modal');
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
      const mainCircle = document.getElementById('wellcomeai-main-circle');
       if(mainCircle) {
           mainCircle.classList.remove('listening', 'speaking', 'connecting');
           mainCircle.classList.add('inactive'); // Возвращаем в неактивное состояние
       }
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
        widgetLog("Stopping media stream tracks.");
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }

       // Закрываем и сбрасываем AudioContext и Processor
        if (audioProcessor) {
             try {
                 // Отключаем Processor от всех его выходов (gainNode, destination)
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


    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
          widgetLog("WebSocket is already connecting or open.");
           // Если уже подключается, возможно, нужно показать лоадер?
           const loaderModal = document.getElementById('wellcomeai-loader-modal');
           if(isWidgetOpen && loaderModal && websocket.readyState === WebSocket.CONNECTING) {
               loaderModal.classList.add('active');
           }
          return true; // Уже в процессе или подключено
      }

      if (!ASSISTANT_ID) {
          widgetLog("Assistant ID not found, cannot connect WebSocket.", 'error');
          if (isWidgetOpen) showError('Ошибка: ID ассистента не указан.');
           const loaderModal = document.getElementById('wellcomeai-loader-modal');
           if (loaderModal) loaderModal.classList.remove('active');
          return false;
      }
       if (connectionFailedPermanently) {
           widgetLog("Connection failed permanently, not attempting reconnect.", 'warn');
           if (isWidgetOpen) showError('Не удалось восстановить соединение.');
            const loaderModal = document.getElementById('wellcomeai-loader-modal');
            if (loaderModal) loaderModal.classList.remove('active');
            const widgetButton = document.getElementById('wellcomeai-widget-button');
            if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation'); // Пульсация на кнопке, если виджет закрыт
           return false;
       }


      widgetLog(`Attempting to connect to WebSocket at: ${WS_URL}`);
      isReconnecting = true; // Устанавливаем флаг переподключения/подключения

      // Показываем лоадер и статус подключения при открытом виджете
       const loaderModal = document.getElementById('wellcomeai-loader-modal');
       const mainCircle = document.getElementById('wellcomeai-main-circle');
       if (isWidgetOpen) {
            if (loaderModal) loaderModal.classList.add('active');
            showMessage("Подключение...", 0); // Показываем статус
            updateConnectionStatus('connecting', 'Подключение...');
            if(mainCircle) mainCircle.classList.remove('listening', 'speaking');
            if(mainCircle) mainCircle.classList.add('connecting');
       } else {
           // Если виджет закрыт, только обновляем статус индикатора в фоне
           updateConnectionStatus('connecting', 'Подключение...');
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
           if (loaderModal) loaderModal.classList.remove('active');
           reconnectWithDelay(); // Запускаем попытку переподключения
           return false;
       }


       // Устанавливаем таймаут на открытие соединения
       connectionTimeout = setTimeout(() => {
           widgetLog("WebSocket connection timeout", "error");
           if (websocket && websocket.readyState === WebSocket.CONNECTING) {
                websocket.onclose = null; // Предотвращаем двойной вызов onclose
                try { websocket.close(); } catch(e){}
           }
            // Теперь логика переподключения будет вызвана из onclose или обработана здесь напрямую
            isReconnecting = false;
           if (loaderModal) loaderModal.classList.remove('active');
            reconnectWithDelay(); // Начинаем процесс переподключения
       }, CONNECTION_TIMEOUT);


       websocket.onopen = function() {
           clearTimeout(connectionTimeout); // Соединение установлено, отменяем таймаут
           widgetLog('WebSocket connection established');
           isConnected = true;
           isReconnecting = false;
           reconnectAttempts = 0; // Сбрасываем счетчик при успешном подключении
           connectionFailedPermanently = false; // Сбрасываем флаг постоянной ошибки
           if (loaderModal) loaderModal.classList.remove('active');

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
           hideMessage(); // Скрываем сообщение "Подключение..."

           // Обновляем статус соединения
           updateConnectionStatus('connected', 'Подключено');

           // Если виджет открыт, инициируем проверку аудио и старт прослушивания
            if (isWidgetOpen) {
                widgetLog("Widget is open, checking if audio is ready to start listening...");
                 // Теперь, когда WS подключен, пытаемся убедиться, что аудио готово и стартовать прослушивание.
                 // ensureAudioInitializedAndReady() должна быть вызвана кликом открытия виджета.
                 // Здесь мы просто проверяем, готово ли аудио ПОСЛЕ onopen и стартуем listening если да.
                 // Если аудио еще не готово (напр., еще не получен стрим), startListening сама вызовет ensure... (при клике на круг)
                 if (audioContext && audioContext.state === 'running' && mediaStream && audioProcessor) {
                      widgetLog("Audio ready after WS connect, starting listening...");
                     startListening();
                 } else {
                     widgetLog("Audio not yet ready after WS connect. Waiting for ensureAudioInitializedAndReady completion.");
                      // UI останется в состоянии "Подключено" или "Готов" до старта прослушивания
                      updateConnectionStatus('connected', 'Готов');
                       const mainCircle = document.getElementById('wellcomeai-main-circle');
                       if(mainCircle) mainCircle.classList.add('inactive');
                       showMessage("Нажмите на микрофон, чтобы начать разговор");
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
                    // В текущем протоколе аудио приходит в Base64 в JSON сообщениях.
                    // Этот блок пока, возможно, не используется.
                   widgetLog("Received binary data from server. Ignoring or logging if unexpected.", "debug");
                   return;
               }

               // Обработка текстовых сообщений (JSON)
               const data = JSON.parse(event.data);

               // Не логируем слишком частые append сообщения
               if (data.type !== 'input_audio_buffer.append' && data.type !== 'ping' && data.type !== 'pong') {
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
                       if (websocket && websocket.readyState === WebSocket.OPEN) {
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
                       hideError(); // Скрываем локальную ошибку

                       if (isWidgetOpen) {
                           updateConnectionStatus('connected', 'Подключено');
                            // Если виджет открыт и аудио готово, стартуем прослушивание (еще раз проверяем)
                           if (!isListening && !isPlayingAudio && audioContext && audioContext.state === 'running' && mediaStream && audioProcessor) {
                               widgetLog("Server confirmed connected, audio ready, starting listening.");
                               startListening();
                           } else if (!isListening && !isPlayingAudio) {
                                widgetLog("Server confirmed connected, but audio not ready for auto-start listening.");
                                updateConnectionStatus('connected', 'Готов'); // Остаемся в состоянии готовности
                                const mainCircle = document.getElementById('wellcomeai-main-circle');
                                if(mainCircle) mainCircle.classList.add('inactive');
                                showMessage("Нажмите на микрофон, чтобы начать разговор");
                           }
                       } else {
                           // Виджет закрыт, соединение восстановлено.
                           const widgetButton = document.getElementById('wellcomeai-widget-button');
                           if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation'); // Показываем пульсацию
                           updateConnectionStatus('connected', 'Подключено'); // Показываем статус briefly if logic allows
                           setTimeout(() => updateConnectionStatus('connected', 'Подключено'), 300); // Показываем статус на короткое время
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
                         isListening = false; // Убедимся, что флаг снят
                         if (!isPlayingAudio) {
                             const mainCircle = document.getElementById('wellcomeai-main-circle');
                             if(mainCircle) { mainCircle.classList.add('inactive'); mainCircle.classList.remove('listening', 'speaking', 'connecting'); }
                              showMessage("Нажмите на микрофон, чтобы начать разговор");
                              updateConnectionStatus('connected', 'Готов');
                              resetAudioVisualization();
                         }
                    }
                    hideMessage(); // Скрываем возможное сообщение "Обработка..."
                   return; // Эту ошибку не показываем пользователю как критичную
                 }

                 // Прочие ошибки сервера - показываем пользователю, если виджет открыт
                 let errorMessage = data.error ? data.error.message : 'Произошла ошибка на сервере.';
                 if (isWidgetOpen) {
                     showError(errorMessage);
                 } else {
                      // Логируем ошибку даже если виджет закрыт
                      widgetLog(`Server error received while widget closed: ${errorMessage}`, 'error');
                      // Можно добавить пульсацию на кнопку виджета, если соединение еще есть, но есть ошибка ответа
                      if (isConnected && !connectionFailedPermanently) {
                           const widgetButton = document.getElementById('wellcomeai-widget-button');
                           if (widgetButton) widgetButton.classList.add('wellcomeai-pulse-animation');
                           // Также можно показать временный статус "Ошибка ответа"
                            updateConnectionStatus('connected', 'Ошибка ответа');
                            setTimeout(() => updateConnectionStatus('connected', 'Подключено'), 3000); // Вернуть статус через 3 сек
                      }
                 }
                 return; // Обработка ошибки завершена
               }

               // Обработка текстового ответа (потоковая передача)
               if (data.type === 'response.text.delta') {
                 if (data.delta) {
                   // Если виджет открыт, показываем текст
                    if (isWidgetOpen) {
                        const messageDisplay = document.getElementById('wellcomeai-message-display');
                        const mainCircle = document.getElementById('wellcomeai-main-circle');
                        if(messageDisplay && mainCircle) {
                             // Если это первая дельта, очищаем предыдущее сообщение и показываем лоадер (если был)
                            if (messageDisplay.textContent === '' || messageDisplay.textContent === 'Обработка...' || messageDisplay.textContent === 'Слушаю...') {
                                messageDisplay.textContent = data.delta;
                                hideError(); // Убедимся, что ошибки скрыты
                                mainCircle.classList.remove('inactive', 'listening', 'connecting');
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
                 updateConnectionStatus('disconnected', 'Отключено'); // Показываем статус временно
                 setTimeout(() => { const statusIndicator = document.getElementById('wellcomeai-status-indicator'); if(statusIndicator) statusIndicator.classList.remove('show'); }, 3000);
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
            // Но здесь можно показать временное сообщение об ошибке при открытом виджете.
            if (isWidgetOpen) {
                 showMessage("Ошибка соединения...", 0); // Не скрываем автоматически, пока не переподключились или не показали permanent error
                 updateConnectionStatus('disconnected', 'Ошибка соединения');
                  const mainCircle = document.getElementById('wellcomeai-main-circle');
                 if(mainCircle) { mainCircle.classList.remove('listening', 'speaking', 'connecting'); mainCircle.classList.add('inactive'); }
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
               updateConnectionStatus('disconnected', 'Отключено');
               const statusIndicator = document.getElementById('wellcomeai-status-indicator');
               if (statusIndicator) statusIndicator.classList.add('show'); // Показываем статус постоянно при перманентной ошибке
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
             updateConnectionStatus('disconnected', 'Отключено');
              const statusIndicator = document.getElementById('wellcomeai-status-indicator');
             if (statusIndicator) statusIndicator.classList.add('show'); // Показываем статус постоянно при перманентной ошибке
         }
        return;
      }

      if (isReconnecting) {
           widgetLog("Already in reconnection process, skipping new attempt trigger.");
           return; // Уже пытаемся переподключиться
      }

      isReconnecting = true; // Устанавливаем флаг
      reconnectAttempts++; // Увеличиваем счетчик попыток

      // Вычисляем задержку: экспоненциальная backoff + случайность
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
           const mainCircle = document.getElementById('wellcomeai-main-circle');
           if(mainCircle) { mainCircle.classList.remove('listening', 'speaking'); mainCircle.classList.add('connecting'); }
       } else {
            // Если виджет закрыт, скрываем индикатор статуса и сообщение (он покажется снова при следующем updateConnectionStatus)
             // const statusIndicator = document.getElementById('wellcomeai-status-indicator');
             // if (statusIndicator) statusIndicator.classList.remove('show');
             hideMessage(); hideError(); // Убираем сообщения
              updateConnectionStatus('connecting', 'Переподключение...'); // Показываем статус временно
       }


      // Пытаемся переподключиться через вычисленную задержку
      setTimeout(() => {
          if (!connectionFailedPermanently && isReconnecting) { // Проверяем флаги перед попыткой
              connectWebSocket().then(success => {
                  // connectWebSocket сам обновит флаги и статус
                  if (!success) {
                      widgetLog("connectWebSocket returned false during reconnect attempt.");
                      // Если connectWebSocket вернул false (не смог создать сокет),
                      // логика переподключения продолжится из connectWebSocket или следующего вызова reconnectWithDelay
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
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      const widgetClose = document.getElementById('wellcomeai-widget-close');
      const mainCircle = document.getElementById('wellcomeai-main-circle');
      const audioBars = document.getElementById('wellcomeai-audio-bars');
      const loaderModal = document.getElementById('wellcomeai-loader-modal');

      if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal) {
         widgetLog("UI elements not ready to open widget.", 'error');
          // alert('WellcomeAI Widget Error: UI elements not found.'); // Избегаем alert в продакшене
          showError("Виджет не инициализирован полностью. Элементы UI отсутствуют.");
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
       mainCircle.classList.add('connecting'); // Переходим в состояние подключения/загрузки
       resetAudioVisualization(); // Сбрасываем визуализацию


       // Скрываем ошибку, если она была показана при закрытом виджете
       hideError();


      try {
          // Шаг 1: Инициируем или проверяем WebSocket соединение
           widgetLog("Step 1: Ensuring WebSocket connection is established...");
           // connectWebSocket() уже запущен при загрузке. Здесь мы просто ждем его.
           // Если он не подключен и не переподключается, запускаем его.
           if (!isConnected && !isReconnecting && !connectionFailedPermanently) {
               widgetLog("WS not connected or reconnecting, initiating connection.");
               connectWebSocket(); // Запускаем или продолжаем процесс подключения
           }

           // Ждем, пока соединение будет установлено или попытки исчерпаются
            const waitForConnection = new Promise((resolve) => {
                if (isConnected) {
                    widgetLog("WS is already connected when opening.");
                    resolve(true);
                } else if (connectionFailedPermanently) {
                    widgetLog("WS connection permanently failed when opening.");
                    resolve(false);
                } else {
                    // Если не подключен и не перманентная ошибка, значит, он либо CONNECTING, либо Reconnecting, либо попытка сейчас начнется.
                    // Ждем onopen или onclose с перманентной ошибкой
                    const openHandler = () => {
                         websocket.removeEventListener('open', openHandler);
                         resolve(true);
                    };
                    const closeHandler = () => { // Этот обработчик сработает, если соединение упадет до onopen
                         websocket.removeEventListener('close', closeHandler);
                         // Если закрытие привело к permanent failure, то resolve(false)
                         // Логика permanent failure уже в reconnectWithDelay
                         // Если просто закрылось без перманентной ошибки, reconnectWithDelay запустит новую попытку, и мы снова будем ждать.
                         // Проще: если onclose с кодом НЕ 1000/1001, то это ошибка.
                         // Но лучше полагаться на флаг connectionFailedPermanently, который устанавливает reconnectWithDelay
                         if (connectionFailedPermanently) {
                             resolve(false);
                         } else {
                             // Если закрылось, но не перманентная ошибка, возможно, reconnectWithDelay запустится.
                             // В этом случае, мы просто ждем следующего onopen.
                             // Этот обработчик onclose здесь не должен делать resolve(false), только resolve(true) в onopen.
                             // Если коннект совсем упал, таймаут или permanent failure в итоге сработают.
                         }
                    };

                    // Добавляем слушатели к текущему или будущему websocket объекту
                    // Это нужно делать осторожно, чтобы не добавить много слушателей
                    // Альтернатива: использовать флаг isReconnecting и промис, который резолвится в connectWebSocket onopen
                     let connectionResolved = false;
                     const wsConnectionPromise = new Promise((wsResolve) => {
                          if (websocket && websocket.readyState === WebSocket.OPEN) {
                              connectionResolved = true; wsResolve(true);
                          } else if (connectionFailedPermanently) {
                              connectionResolved = true; wsResolve(false);
                          } else {
                              const tempOpen = () => {
                                   if (!connectionResolved) { connectionResolved = true; wsResolve(true); }
                                   if(websocket) websocket.removeEventListener('open', tempOpen);
                                   // if(websocket) websocket.removeEventListener('close', tempCloseForResolve);
                              };
                               const tempCloseForResolve = () => {
                                    if (connectionFailedPermanently && !connectionResolved) {
                                         connectionResolved = true; wsResolve(false);
                                    }
                                     if(websocket) websocket.removeEventListener('open', tempOpen);
                                    if(websocket) websocket.removeEventListener('close', tempCloseForResolve);
                               };
                              // Добавляем слушатели. connectWebSocket гарантирует, что websocket объект будет создан.
                               // Но слушатели нужно добавить до того, как он станет OPEN.
                               // Лучше всего: connectWebSocket сам должен возвращать промис.
                               // **Редизайн connectWebSocket для возврата промиса:** Это было бы чисто, но требует переписать connectWebSocket.
                               // Текущий подход: полагаемся на глобальные флаги и слушаем onopen/onclose.

                               // Если websocket уже создан (напр, CONNECTING или RECONNECTING) добавляем слушатель к нему
                               if (websocket) {
                                   websocket.addEventListener('open', tempOpen);
                                    // websocket.addEventListener('close', tempCloseForResolve); // Close listener might complicate things if reconnecting happens
                               } else {
                                    // Если connectWebSocket еще не вызывался или завершился ошибкой, он будет вызван ниже.
                                    // Его onopen/onclose обработчики будут управлять глобальными флагами.
                                    // Мы можем просто периодически проверять флаг isConnected или полагаться на connectWebSocket.onopen
                               }

                               // Fallback: если WS объект еще не создан, connectWebSocket его создаст и вызовет onopen
                               // Мы полагаемся на то, что connectWebSocket вызовет onopen при успехе.
                               // А логика в onopen проверит isWidgetOpen и запустит startListening.
                               // Поэтому в openWidget нам, возможно, не нужно ЯВНО ждать WS промис?
                               // Нет, нам нужно знать, успешно ли подключились, чтобы решить, запускать ли аудио.
                               // Давайте вернемся к идее промиса или колбэка в connectWebSocket для открытого виджета.
                               // Простейший вариант: Просто убеждаемся, что connectWebSocket() вызван, а остальное произойдет в его onopen.
                               // Но тогда openWidget не async и не может ждать audioReadyPromise.

                               // Давайте оставим openWidget async и ждать Promises.
                               // Промис для WS:
                               const wsPromise = new Promise((resolve, reject) => {
                                    // Если уже connected или permanently failed, резолвим сразу
                                    if (isConnected) return resolve(true);
                                    if (connectionFailedPermanently) return resolve(false); // Reject? No, indicates failure

                                    let tempWs = websocket;
                                    // Если WS не создан, создаем его, и его onopen/onclose/onerror вызовут resolve/reject
                                    if (!tempWs || tempWs.readyState === WebSocket.CLOSED) {
                                        // Создаем новый WS и переопределяем его обработчики временно
                                        tempWs = new WebSocket(WS_URL); // Эта строка может выбросить ошибку
                                         tempWs.binaryType = 'arraybuffer';
                                         widgetLog(`Temp WS created in openWidget for promise.`);
                                        websocket = tempWs; // Обновляем глобальную ссылку
                                         // Добавляем таймаут на этот конкретный промис тоже
                                         const openTimeout = setTimeout(() => {
                                             widgetLog("WS Promise timeout in openWidget.", 'warn');
                                             // reject(new Error("WS connection timeout")); // Reject приведет к catch
                                             if(tempWs && tempWs.readyState === WebSocket.CONNECTING) { try{tempWs.close();}catch(e){}}
                                             resolve(false); // Resolve с false для неудачи по таймауту
                                         }, CONNECTION_TIMEOUT);
                                    }

                                    // Добавляем одноразовые слушатели к tempWs
                                    const onOpen = () => {
                                        widgetLog("WS Promise resolved true in openWidget (onopen).");
                                         clearTimeout(openTimeout);
                                         tempWs.removeEventListener('open', onOpen);
                                         tempWs.removeEventListener('error', onError);
                                         // tempWs.removeEventListener('close', onClose); // close handled by global handler
                                         // Глобальные обработчики теперь подключаются в connectWebSocket, а не здесь
                                         // connectWebSocket(); // Убеждаемся, что глобальные обработчики привязаны к ЭТОМУ websocket объекту
                                        // Нет, connectWebSocket вызывается до или в начале openWidget. Его слушатели уже будут на websocket.
                                        // Нужно просто убедиться, что этот tempWs - это глобальный websocket.
                                        resolve(true); // Успех
                                    };
                                    const onError = (err) => {
                                         widgetLog(`WS Promise resolved false in openWidget (onerror): ${err.message}`, 'error');
                                         clearTimeout(openTimeout);
                                         tempWs.removeEventListener('open', onOpen);
                                         tempWs.removeEventListener('error', onError);
                                         // tempWs.removeEventListener('close', onClose);
                                         // Ошибка обычно ведет к close, логика reconnectWithDelay будет там.
                                         // Но здесь мы просто фиксируем ошибку для Promise.all
                                         resolve(false); // Неудача
                                    };
                                     // const onClose = (event) => { ... logic ... resolve(false) if permanent }; // Too complex, rely on global flag

                                     if (tempWs.readyState === WebSocket.OPEN) { // Проверка после создания
                                         onOpen();
                                     } else if (tempWs.readyState === WebSocket.CLOSED) { // Проверка после создания
                                         widgetLog("WS was closed immediately after creation?", 'warn');
                                          resolve(false); // Сразу неудача
                                     } else { // CONNECTING
                                        tempWs.addEventListener('open', onOpen);
                                        tempWs.addEventListener('error', onError); // onError usually precedes onClose
                                         // tempWs.addEventListener('close', onClose); // Add close listener if needed to catch non-permanent failure
                                     }

                               }); // End of wsPromise


          // Шаг 2: Инициируем или проверяем готовность аудио (AudioContext + MediaStream)
           widgetLog("Step 2: Ensuring AudioContext and MediaStream are ready...");
           // Эта функция должна быть вызвана в ответ на клик! openWidget вызывается кликом.
           const audioReadyPromise = ensureAudioInitializedAndReady();


          // Шаг 3: Ждем готовности и соединения, и аудио
           widgetLog("Step 3: Waiting for both WS connection and audio readiness...");
          // Используем Promise.allSettled, чтобы не упасть, если один из промисов завершится Reject
          const [wsResult, audioResult] = await Promise.allSettled([wsPromise, audioReadyPromise]);

          const wsSuccess = wsResult.status === 'fulfilled' && wsResult.value === true;
          const audioSuccess = audioResult.status === 'fulfilled' && audioResult.value === true;

          loaderModal.classList.remove('active'); // Скрываем лоадер после завершения попыток
          if(mainCircle) mainCircle.classList.remove('connecting'); // Убираем connecting класс с круга

          if (wsSuccess && audioSuccess) {
              widgetLog("Both WS and Audio are ready. Starting listening.");
              isConnected = true; // Убедимся, что флаг соединения установлен
               hideMessage(); // Скрываем сообщение "Загрузка..."
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
                   if(mainCircle) mainCircle.classList.remove('listening', 'speaking', 'connecting');
                   if(mainCircle) mainCircle.classList.add('inactive');
                    showMessage("Нажмите на микрофон, чтобы начать разговор"); // Инструкция, если микрофон недоступен
              } else {
                  // Неизвестная ошибка, оба промиса вернули true, но что-то пошло не так?
                  showError("Произошла внутренняя ошибка при открытии виджета.");
                  updateConnectionStatus('disconnected', 'Ошибка'); // Статус не определен
              }
               // Оставляем UI в неактивном состоянии
               if(mainCircle) {
                   mainCircle.classList.remove('listening', 'speaking', 'connecting');
                   mainCircle.classList.add('inactive');
               }
               // Если не показана ошибка showError, показываем стандартное сообщение
               const errorMessageDiv = document.getElementById('wellcomeai-error-message');
               if (!errorMessageDiv || !errorMessageDiv.classList.contains('visible')) {
                    showMessage("Нажмите на микрофон, чтобы начать разговор");
               }

          }

      } catch (error) {
           widgetLog(`Unexpected error during openWidget: ${error.message}`, 'error');
           loaderModal.classList.remove('active');
           const mainCircle = document.getElementById('wellcomeai-main-circle');
           if(mainCircle) mainCircle.classList.remove('connecting');
           showError("Произошла внутренняя ошибка при открытии виджета.");
           updateConnectionStatus('disconnected', 'Ошибка');
            if(mainCircle) { mainCircle.classList.remove('listening', 'speaking'); mainCircle.classList.add('inactive'); }
      }

       // Убираем пульсацию с кнопки после попытки открытия
       const widgetButton = document.getElementById('wellcomeai-widget-button');
       if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
    }

    // Закрыть виджет
    function closeWidget() {
      widgetLog("Closing widget");
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      const mainCircle = document.getElementById('wellcomeai-main-circle');


      // Останавливаем все аудио процессы (запись, воспроизведение)
      stopAllAudioProcessing();

      // Скрываем виджет
      if(widgetContainer) widgetContainer.classList.remove('active');
      isWidgetOpen = false;

      // Скрываем сообщения и ошибки
      hideMessage();
      hideError();

      // Скрываем индикатор статуса, если он не показывает постоянную ошибку
      const statusIndicator = document.getElementById('wellcomeai-status-indicator');
      if (statusIndicator && !connectionFailedPermanently) { // Если есть пост.ошибка, оставляем индикатор
          statusIndicator.classList.remove('show');
      }

       // Возвращаем круг в неактивное состояние
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
       if (isConnected && !connectionFailedPermanently && widgetButton) {
           widgetButton.classList.add('wellcomeai-pulse-animation');
       } else if (!isConnected && !isReconnecting && !connectionFailedPermanently && widgetButton) {
            // Если нет соединения, но нет и постоянной ошибки, тоже пульсируем, чтобы привлечь внимание
            widgetButton.classList.add('wellcomeai-pulse-animation');
            updateConnectionStatus('disconnected', 'Отключено'); // Показываем статус briefly
             setTimeout(() => { const statusIndicator = document.getElementById('wellcomeai-status-indicator'); if(statusIndicator) statusIndicator.classList.remove('show'); }, 3000);
       } else if (connectionFailedPermanently && widgetButton) {
            // Если постоянная ошибка, пульсируем и оставляем статус
             widgetButton.classList.add('wellcomeai-pulse-animation');
             updateConnectionStatus('disconnected', 'Отключено');
              if (statusIndicator) statusIndicator.classList.add('show');
       }
    }


  // --- Основная логика инициализации ---
  // Эта функция запускается один раз при загрузке скрипта/DOM ready

  function initializeWidget() {
    widgetLog('Initializing WellcomeAI Widget...');

    // Проверяем, что ID ассистента существует, прежде чем создавать UI
    const assistantId = getAssistantId(); // Получаем ID здесь для ранней проверки
     if (!assistantId) {
       widgetLog("Assistant ID not found. Widget will not be fully initialized.", 'error');
        // alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.'); // Избегаем alert
        // Виджет не будет создан, оставим только лог ошибки
       return; // Прекращаем инициализацию, если нет ID
     }
     // Если ID найден, сохраняем его в константу (уже сделано в глобальной области)


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
    // const retryButton = errorMessageDiv ? errorMessageDiv.querySelector('#wellcomeai-retry-button') : null; // Получаем ссылку на retry button (будет пересоздаваться)
    const statusIndicator = document.getElementById('wellcomeai-status-indicator'); // Получаем ссылку на status indicator
    const statusDot = document.getElementById('wellcomeai-status-dot'); // Получаем ссылку на status dot
    const statusText = document.getElementById('wellcomeai-status-text'); // Получаем ссылку на status text


    // Проверяем, что все критически важные элементы найдены
    if (!widgetContainer || !widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay || !errorMessageDiv || !statusIndicator) {
      widgetLog("Some critical UI elements were not found after creation!", 'error');
      // alert('WellcomeAI Widget Error: Critical UI elements not found.'); // Избегаем alert
      // Показываем ошибку в UI, если это возможно
      if (errorMessageDiv) {
          errorMessageDiv.innerHTML = "WellcomeAI Widget Error: Critical UI elements not found. Check console.";
          errorMessageDiv.classList.add('visible');
      }
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
            widgetLog("Circle clicked but widget is not open. Ignoring.");
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
                  mainCircle.classList.add('connecting');
             }
             return; // Выходим, т.к. соединение не готово
         }

        // Если аудио не готово (контекст, стрим, процессор)
        if (!audioContext || audioContext.state !== 'running' || !mediaStream || !audioProcessor) {
            widgetLog("Audio not ready, attempting to ensure audio is ready via circle click.");
             // Пытаемся принудительно активировать аудио (внутри обработчика клика)
            ensureAudioInitializedAndReady().then(ready => {
                 if (ready) {
                     widgetLog("Audio is now ready after circle click, attempting to start listening.");
                     // Проверяем соединение снова, т.к. оно могло упасть пока ждали ensureAudio...
                     if (isConnected && !isReconnecting) {
                          startListening(); // Если аудио и соединение готовы, пытаемся начать слушать
                     } else {
                          widgetLog("Connection not ready after audio activation click. Cannot start listening.");
                         // UI останется в inactive/error состоянии, показанном ранее
                     }
                 } else {
                     widgetLog("Audio is still not ready after circle click.");
                     // ensureAudioInitializedAndReady уже вызвала showError если проблема с микрофоном
                      showMessage("Нажмите на микрофон, чтобы начать разговор"); // Оставляем инструкцию
                      mainCircle.classList.remove('listening', 'speaking', 'connecting');
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
     // Ищем клики по классу 'wellcomeai-retry-button' на всем теле документа
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
              } else if (errorText.includes('микрофон') || !audioContext || (audioContext.state !== 'running' && audioContext.state !== 'suspended') || !mediaStream) {
                   widgetLog("Attempting to retry audio initialization via startListening.");
                   // Пытаемся снова начать слушать (это вызовет ensureAudioInitializedAndReady при клике на круг)
                   // Но чтобы вызвать ensureAudioInitializedAndReady, нужен клик.
                   // Если ошибка микрофона, просто показываем сообщение "Нажмите на микрофон"
                   if (isWidgetOpen) {
                       showMessage("Нажмите на микрофон, чтобы начать разговор"); // Инструкция
                        const mainCircle = document.getElementById('wellcomeai-main-circle');
                         if(mainCircle) { mainCircle.classList.remove('listening', 'speaking', 'connecting'); mainCircle.classList.add('inactive'); }
                        updateConnectionStatus(isConnected ? 'connected' : 'disconnected', isConnected ? 'Готов' : 'Ошибка');
                   }
              } else {
                  // Общий повтор - пытаемся просто начать слушать
                   widgetLog("Attempting general retry (start listening).");
                   if (isWidgetOpen) {
                        // Проверяем, готово ли аудио и соединение перед стартом
                        if (isConnected && !isReconnecting && audioContext && audioContext.state === 'running' && mediaStream && audioProcessor) {
                             startListening();
                        } else {
                             widgetLog("Cannot start listening on general retry, audio/connection not ready.");
                              // Если не готовы, UI останется в inactive/connecting/error состоянии
                        }
                   } else {
                        // Если виджет закрыт, просто убираем пульсацию
                        const widgetButton = document.getElementById('wellcomeai-widget-button');
                        if (widgetButton) widgetButton.classList.remove('wellcomeai-pulse-animation');
                   }
              }

         }
     });


    // Инициируем создание аудио графа при загрузке (но без запроса микрофона)
    // Запрос микрофона и активация AudioContext произойдет при первом клике на виджет (в openWidget)
     setupAudioGraph().catch(e => {
          widgetLog(`Initial setupAudioGraph failed: ${e.message}`, 'warn');
           // Не блокируем инициализацию виджета из-за этого, т.к. ensureAudio... повторит попытку при клике
     });

    // Инициируем первое подключение WebSocket при загрузке страницы.
    // Если соединение не установится, логика переподключения позаботится об этом.
     // Loader показывается по умолчанию в HTML. Скроем его после первой попытки подключения.
    connectWebSocket().then(() => {
         // Лоадер будет скрыт в onopen или onclose/onerror
    }).catch(() => {
         // Лоадер будет скрыт в onerror или onclose
    });


    widgetLog('WellcomeAI Widget initialization complete');

    // Показываем лоадер при загрузке страницы (он уже в HTML)
    const loaderModalElement = document.getElementById('wellcomeai-loader-modal');
    const widgetButton = document.getElementById('wellcomeai-widget-button');

    if (loaderModalElement) {
        // Убираем лоадер через 2 секунды после начала инициализации, если он не был убран раньше
        // (например, быстрым коннектом). Это для случаев, когда соединение не устанавливается сразу.
        setTimeout(() => {
             if (loaderModalElement.classList.contains('active')) {
                 widgetLog("Hiding loader after initial timeout.");
                 loaderModalElement.classList.remove('active');
                 // Если соединение еще не установлено или ошибка, показываем пульсацию на кнопке
                  if (!isConnected && !isReconnecting && !connectionFailedPermanently && widgetButton) {
                       widgetButton.classList.add('wellcomeai-pulse-animation');
                       updateConnectionStatus('connecting', 'Ожидание соединения...'); // Обновляем статус индикатора
                  } else if (connectionFailedPermanently && widgetButton) {
                      widgetButton.classList.add('wellcomeai-pulse-animation');
                      updateConnectionStatus('disconnected', 'Отключено');
                       const statusIndicator = document.getElementById('wellcomeai-status-indicator');
                       if (statusIndicator) statusIndicator.classList.add('show'); // Показываем статус постоянно при перманентной ошибке
                  } else if (isConnected && widgetButton) {
                       // Если подключились в фоне, показываем пульсацию и статус "Подключено"
                       widgetButton.classList.add('wellcomeai-pulse-animation');
                       updateConnectionStatus('connected', 'Подключено');
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
                  widgetLog(`DEBUG: Status text: ${statusText ? statusText.textContent : 'N/A'}`);
             }


        }, 5000); // Проверка через 5 секунд
    }
  }

  // Логика запуска initializeWidget при загрузке DOM
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
