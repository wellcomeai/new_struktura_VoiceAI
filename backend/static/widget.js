(function() {
  'use strict';

  // Системы логирования
  function widgetLog(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = '[WellcomeAI Widget]';
    
    switch (level) {
      case 'error':
        console.error(`${prefix} ERROR: ${message}`);
        break;
      case 'warn':
        console.warn(`${prefix} WARNING: ${message}`);
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }

  // Системы стилей
  function createStyles() {
    const css = `
      .wellcomeai-widget-container {
        position: fixed;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        bottom: 20px;
        right: 20px;
        width: 60px;
        height: 60px;
        transition: all 0.3s ease;
      }

      .wellcomeai-widget-container.wellcomeai-widget-open {
        width: 350px;
        height: 500px;
        border-radius: 16px;
        background: white;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        border: 1px solid #e5e7eb;
        overflow: hidden;
      }

      .wellcomeai-chat-button {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.3s ease;
        box-shadow: 0 4px 20px rgba(102, 126, 234, 0.4);
        position: relative;
        overflow: hidden;
      }

      .wellcomeai-chat-button:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 25px rgba(102, 126, 234, 0.6);
      }

      .wellcomeai-chat-button i {
        color: white;
        font-size: 24px;
        transition: transform 0.3s ease;
      }

      .wellcomeai-widget-open .wellcomeai-chat-button {
        display: none;
      }

      .wellcomeai-chat-interface {
        display: none;
        flex-direction: column;
        height: 100%;
        background: white;
      }

      .wellcomeai-widget-open .wellcomeai-chat-interface {
        display: flex;
      }

      .wellcomeai-chat-header {
        padding: 20px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .wellcomeai-chat-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .wellcomeai-close-button {
        background: none;
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background-color 0.2s;
      }

      .wellcomeai-close-button:hover {
        background-color: rgba(255, 255, 255, 0.1);
      }

      .wellcomeai-chat-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        position: relative;
        background: #f8fafc;
      }

      .wellcomeai-voice-interface {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
      }

      .wellcomeai-voice-circle {
        width: 120px;
        height: 120px;
        border-radius: 50%;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 24px;
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
      }

      .wellcomeai-voice-circle.listening {
        animation: wellcomeai-pulse 2s infinite;
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      }

      .wellcomeai-voice-circle.speaking {
        animation: wellcomeai-speaking 1.5s infinite;
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      }

      .wellcomeai-voice-circle i {
        color: white;
        font-size: 48px;
        z-index: 1;
      }

      @keyframes wellcomeai-pulse {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
        70% { transform: scale(1.05); box-shadow: 0 0 0 20px rgba(16, 185, 129, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }

      @keyframes wellcomeai-speaking {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.1); }
      }

      @keyframes wellcomeai-button-pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }

      .wellcomeai-pulse-animation {
        animation: wellcomeai-button-pulse 1s infinite;
      }

      .wellcomeai-status-text {
        font-size: 16px;
        color: #6b7280;
        text-align: center;
        margin-bottom: 16px;
      }

      .wellcomeai-status-text.listening {
        color: #10b981;
        font-weight: 500;
      }

      .wellcomeai-status-text.speaking {
        color: #f59e0b;
        font-weight: 500;
      }

      .wellcomeai-connection-status {
        font-size: 14px;
        color: #9ca3af;
        text-align: center;
      }

      .wellcomeai-connection-status.connected {
        color: #10b981;
      }

      .wellcomeai-connection-status.disconnected {
        color: #ef4444;
      }

      /* Мобильные стили */
      @media (max-width: 768px) {
        .wellcomeai-widget-container {
          bottom: 20px;
          right: 20px;
          width: 56px;
          height: 56px;
        }

        .wellcomeai-widget-container.wellcomeai-widget-open {
          width: calc(100vw - 40px);
          height: calc(100vh - 80px);
          bottom: 20px;
          right: 20px;
          max-width: 400px;
          max-height: 600px;
        }

        .wellcomeai-chat-button {
          width: 56px;
          height: 56px;
        }

        .wellcomeai-chat-button i {
          font-size: 20px;
        }

        .wellcomeai-voice-circle {
          width: 100px;
          height: 100px;
        }

        .wellcomeai-voice-circle i {
          font-size: 40px;
        }
      }

      /* Стили для мобильной кнопки активации аудио */
      .wellcomeai-mobile-audio-button {
        position: fixed;
        bottom: 100px;
        right: 20px;
        background: #667eea;
        color: white;
        border: none;
        padding: 12px 20px;
        border-radius: 25px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(102, 126, 234, 0.4);
        z-index: 2147483646;
        opacity: 0;
        transform: translateY(20px);
        pointer-events: none;
        transition: all 0.3s ease;
      }

      .wellcomeai-mobile-audio-button.visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .wellcomeai-mobile-audio-button:hover {
        background: #5a67d8;
        transform: translateY(-2px);
        box-shadow: 0 6px 25px rgba(102, 126, 234, 0.6);
      }

      /* Стили для отображения сообщений */
      .wellcomeai-message-display {
        position: fixed;
        bottom: 160px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        font-size: 14px;
        max-width: 250px;
        text-align: center;
        z-index: 2147483646;
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: all 0.3s ease;
      }

      .wellcomeai-message-display.show {
        opacity: 1;
        transform: translateY(0);
      }
    `;

    const style = document.createElement('style');
    style.textContent = css;
    return style;
  }

  // Простая функция для показа кнопки разблокировки
  function showAudioUnlockButtonSimple(audioUrl, audio, cleanupAudio, playNextAudio) {
    const mobileAudioButton = document.getElementById('wellcomeai-mobile-audio-button');
    const messageDisplay = document.getElementById('wellcomeai-message-display');
    
    if (mobileAudioButton) {
      mobileAudioButton.textContent = '🔊 Включить звук';
      mobileAudioButton.classList.add('visible');
      
      // Показываем сообщение
      if (messageDisplay) {
        messageDisplay.textContent = "Нажмите кнопку для включения звука ответов";
        messageDisplay.classList.add('show');
      }
      
      // Удаляем предыдущие обработчики
      mobileAudioButton.onclick = null;
      
      // Обработчик клика для разблокировки
      mobileAudioButton.onclick = async function() {
        widgetLog('[AUDIO] Попытка разблокировки через кнопку на iOS');
        
        try {
          // Пробуем воспроизвести тестовое аудио для разблокировки
          const testAudio = new Audio();
          testAudio.src = 'data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoAAABBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBzqU3vLEeSsFJYXO9tiDNgYZaLvs559NEAxNm+PyvmchBjuL2vLOeywE';
          testAudio.volume = 0.01;
          testAudio.playsInline = true;
          
          await testAudio.play();
          
          // Если тестовое аудио прошло, пробуем оригинальное
          await audio.play();
          
          // Успешно разблокировано
          window.audioPlaybackUnlocked = true;
          mobileAudioButton.classList.remove('visible');
          
          if (messageDisplay) {
            messageDisplay.classList.remove('show');
          }
          
          widgetLog('[AUDIO] Воспроизведение успешно разблокировано на iOS');
          
        } catch (error) {
          widgetLog(`[AUDIO] Не удалось разблокировать на iOS: ${error.message}`, 'error');
          
          // Показываем сообщение об ошибке
          if (messageDisplay) {
            messageDisplay.textContent = "Не удалось включить звук. Попробуйте еще раз.";
            setTimeout(() => {
              messageDisplay.classList.remove('show');
            }, 3000);
          }
          
          // Очищаем текущее аудио и переходим к следующему
          cleanupAudio(audioUrl, audio);
          playNextAudio();
        }
      };
    }
  }

  // ФАБРИЧНАЯ функция для создания playNextAudio с правильным контекстом
  function createPlayNextAudio(interruptionState, audioPlaybackQueue, mainCircle, isWidgetOpen, widgetButton, startListening, base64ToArrayBuffer, createWavFromPcm) {
    return function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        // Обновляем переменные через замыкание
        window.isPlayingAudio = false;
        interruptionState.is_assistant_speaking = false;
        mainCircle.classList.remove('speaking');
        
        if (!isWidgetOpen()) {
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        
        // ВАЖНО: После воспроизведения автоматически возобновляем прослушивание
        // как в десктопной версии - микрофон остается активным
        if (isWidgetOpen()) {
          setTimeout(() => {
            startListening();
          }, 400);
        }
        return;
      }
      
      window.isPlayingAudio = true;
      interruptionState.is_assistant_speaking = true;
      mainCircle.classList.remove('listening');
      mainCircle.classList.add('speaking');
      
      const audioBase64 = audioPlaybackQueue.shift();
      
      try {
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
        
        // Создаем cleanup функцию с правильным контекстом
        const cleanupAudio = createCleanupAudio(interruptionState);
        
        // Добавляем к списку активных аудио элементов
        interruptionState.current_audio_elements.push(audio);
        
        // Настройки для всех устройств, особенно iOS
        audio.preload = 'auto';
        audio.volume = 1.0; // Полная громкость
        audio.playsInline = true; // Критично для iOS
        audio.muted = false;
        
        // НОВАЯ логика обработки воспроизведения с проверкой разблокировки
        audio.oncanplaythrough = function() {
          if (!interruptionState.is_assistant_speaking) {
            cleanupAudio(audioUrl, audio);
            playNextAudio();
            return;
          }
          
          widgetLog('[AUDIO] Попытка воспроизведения аудио');
          
          const playPromise = audio.play();
          
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                widgetLog('[AUDIO] Аудио воспроизводится успешно');
                // Если это первое успешное воспроизведение на мобильном, отмечаем что разблокировано
                if (isMobile && !window.audioPlaybackUnlocked) {
                  window.audioPlaybackUnlocked = true;
                  widgetLog('[AUDIO] Воспроизведение разблокировано через успешный play()');
                  
                  // Скрываем кнопку активации если она показана
                  const mobileAudioButton = document.getElementById('wellcomeai-mobile-audio-button');
                  if (mobileAudioButton) {
                    mobileAudioButton.classList.remove('visible');
                  }
                }
              })
              .catch(error => {
                widgetLog(`[AUDIO] Ошибка воспроизведения: ${error.message}`, "error");
                
                // Если ошибка связана с autoplay policy на мобильных
                if (isMobile && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
                  widgetLog('[AUDIO] Требуется разблокировка воспроизведения для мобильного устройства');
                  
                  // Показываем кнопку для разблокировки воспроизведения
                  showAudioUnlockButtonSimple(audioUrl, audio, cleanupAudio, playNextAudio);
                } else {
                  // Для других ошибок переходим к следующему аудио
                  cleanupAudio(audioUrl, audio);
                  playNextAudio();
                }
              });
          } else {
            // Старые браузеры без промисов
            widgetLog('[AUDIO] Воспроизведение запущено (старый браузер)');
          }
        };
        
        audio.onended = function() {
          widgetLog('[AUDIO] Воспроизведение аудио завершено');
          cleanupAudio(audioUrl, audio);
          playNextAudio();
        };
        
        audio.onerror = function(e) {
          widgetLog(`[AUDIO] Ошибка аудио элемента: ${e.message || 'Unknown error'}`, 'error');
          cleanupAudio(audioUrl, audio);
          playNextAudio();
        };
        
        // ВАЖНО для iOS: загружаем аудио
        audio.load();
        
      } catch (error) {
        widgetLog(`[AUDIO] Ошибка воспроизведения аудио: ${error.message}`, "error");
        playNextAudio();
      }
    };
  }

  // Создаём простой WAV из PCM данных
  function createWavFromPcm(pcmData) {
    const sampleRate = 24000;
    const numChannels = 1;
    const bytesPerSample = 2;
    
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmData.byteLength;
    const fileSize = 44 + dataSize;
    
    const wav = new ArrayBuffer(fileSize);
    const view = new DataView(wav);
    
    // RIFF header
    view.setUint8(0, 0x52); // R
    view.setUint8(1, 0x49); // I
    view.setUint8(2, 0x46); // F
    view.setUint8(3, 0x46); // F
    view.setUint32(4, fileSize - 8, true); // file size - 8
    view.setUint8(8, 0x57); // W
    view.setUint8(9, 0x41); // A
    view.setUint8(10, 0x56); // V
    view.setUint8(11, 0x45); // E
    
    // fmt chunk
    view.setUint8(12, 0x66); // f
    view.setUint8(13, 0x6d); // m
    view.setUint8(14, 0x74); // t
    view.setUint8(15, 0x20); // ' '
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // audio format (PCM)
    view.setUint16(22, numChannels, true); // number of channels
    view.setUint32(24, sampleRate, true); // sample rate
    view.setUint32(28, byteRate, true); // byte rate
    view.setUint16(32, blockAlign, true); // block align
    view.setUint16(34, bytesPerSample * 8, true); // bits per sample
    
    // data chunk
    view.setUint8(36, 0x64); // d
    view.setUint8(37, 0x61); // a
    view.setUint8(38, 0x74); // t
    view.setUint8(39, 0x61); // a
    view.setUint32(40, dataSize, true); // data size
    
    // PCM data
    const pcmView = new Uint8Array(pcmData);
    const wavView = new Uint8Array(wav);
    wavView.set(pcmView, 44);
    
    return wav;
  }

  // ФАБРИЧНАЯ функция для создания cleanupAudio с контекстом
  function createCleanupAudio(interruptionState) {
    return function cleanupAudio(audioUrl, audio) {
      try {
        if (audioUrl && audioUrl.startsWith('blob:')) {
          URL.revokeObjectURL(audioUrl);
        }
        
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          
          // Удаляем из списка активных аудио элементов
          const index = interruptionState.current_audio_elements.indexOf(audio);
          if (index > -1) {
            interruptionState.current_audio_elements.splice(index, 1);
          }
        }
      } catch (error) {
        widgetLog(`[AUDIO] Ошибка при очистке аудио: ${error.message}`, 'error');
      }
    };
  }

  // Создание HTML структуры виджета
  function createWidgetHTML() {
    return `
      <div class="wellcomeai-widget-container" id="wellcomeai-widget-container">
        <button class="wellcomeai-chat-button" id="wellcomeai-chat-button">
          <i class="fas fa-microphone"></i>
        </button>
        
        <div class="wellcomeai-chat-interface" id="wellcomeai-chat-interface">
          <div class="wellcomeai-chat-header">
            <h3>WellcomeAI</h3>
            <button class="wellcomeai-close-button" id="wellcomeai-close-button">
              <i class="fas fa-times"></i>
            </button>
          </div>
          
          <div class="wellcomeai-chat-body">
            <div class="wellcomeai-voice-interface">
              <div class="wellcomeai-voice-circle" id="wellcomeai-voice-circle">
                <i class="fas fa-microphone"></i>
              </div>
              <div class="wellcomeai-status-text" id="wellcomeai-status-text">
                Нажмите для начала разговора
              </div>
              <div class="wellcomeai-connection-status" id="wellcomeai-connection-status">
                Подключение...
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <button class="wellcomeai-mobile-audio-button" id="wellcomeai-mobile-audio-button">
        🔊 Включить звук
      </button>
      
      <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>
    `;
  }

  // Основная функция инициализации виджета
  function initWidget(serverUrl, assistantId) {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    widgetLog(`Device type: ${isMobile ? 'Mobile' : 'Desktop'}`);
    
    // Создаем и добавляем стили
    const style = createStyles();
    if (!document.head.querySelector('style[data-wellcomeai-styles]')) {
      style.setAttribute('data-wellcomeai-styles', 'true');
      document.head.appendChild(style);
      widgetLog('Styles created and added to head');
    }
    
    // Создаем и добавляем HTML структуру
    const widgetContainer = document.createElement('div');
    widgetContainer.innerHTML = createWidgetHTML();
    document.body.appendChild(widgetContainer.firstElementChild);
    widgetLog('HTML structure created and appended to body');
    
    // Получаем элементы DOM
    const container = document.getElementById('wellcomeai-widget-container');
    const widgetButton = document.getElementById('wellcomeai-chat-button');
    const chatInterface = document.getElementById('wellcomeai-chat-interface');
    const closeButton = document.getElementById('wellcomeai-close-button');
    const mainCircle = document.getElementById('wellcomeai-voice-circle');
    const statusText = document.getElementById('wellcomeai-status-text');
    const connectionStatus = document.getElementById('wellcomeai-connection-status');
    
    // Состояние виджета
    let isWidgetOpen = false;
    let websocket = null;
    let audioPlaybackQueue = [];
    
    // Состояния для обработки перебивания
    let interruptionState = {
      is_assistant_speaking: false,
      is_user_speaking: false,
      last_interruption: 0,
      interruption_count: 0,
      current_audio_elements: [],
      pending_audio_stop: false
    };
    
    // Единая конфигурация аудио для всех устройств
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,
      silenceDuration: 300,
      bufferCheckInterval: 50,
      soundDetectionThreshold: 0.02,
      amplificationFactor: isMobile ? 2.0 : 1.0 // Небольшое усиление только для мобильных
    };
    
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

    // Создаем playNextAudio через фабрику с правильным контекстом
    const playNextAudio = createPlayNextAudio(
      interruptionState,
      audioPlaybackQueue,
      mainCircle,
      () => isWidgetOpen, // Передаем функцию для получения актуального значения
      widgetButton,
      () => startListening(), // Передаем функцию
      base64ToArrayBuffer, // Передаем функцию base64ToArrayBuffer
      createWavFromPcm // Передаем функцию createWavFromPcm
    );

    // Функция для отправки аудиобуфера
    function commitAudioBuffer() {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        widgetLog('Отправка аудиобуфера');
        websocket.send(JSON.stringify({
          type: 'input_audio_buffer.commit'
        }));
      }
    }

    // Функция добавления аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(base64Audio) {
      audioPlaybackQueue.push(base64Audio);
      
      // Если не воспроизводим - запускаем воспроизведение
      if (!window.isPlayingAudio) {
        playNextAudio();
      }
    }

    // Функция остановки всех текущих воспроизведений (для перебивания)
    function stopAllAudioPlayback() {
      widgetLog('[INTERRUPTION] Остановка всех аудио воспроизведений');
      
      // Останавливаем все активные аудио элементы
      interruptionState.current_audio_elements.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch (e) {
          // Игнорируем ошибки при остановке
        }
      });
      
      // Очищаем массив активных элементов
      interruptionState.current_audio_elements = [];
      
      // Очищаем очередь воспроизведения
      audioPlaybackQueue.length = 0;
      
      // Обновляем состояния
      window.isPlayingAudio = false;
      interruptionState.is_assistant_speaking = false;
      
      // Обновляем интерфейс
      mainCircle.classList.remove('speaking');
      
      widgetLog('[INTERRUPTION] Все аудио воспроизведения остановлены');
    }

    // Аудио переменные
    let audioContext = null;
    let microphone = null;
    let processor = null;
    let isListening = false;

    // Функция инициализации аудио
    async function initializeAudio() {
      try {
        widgetLog('[AUDIO] Начинаем инициализацию аудио при открытии виджета');
        
        if (isMobile) {
          widgetLog('[AUDIO] Начало единой инициализации для iOS');
          
          // Создаем AudioContext
          audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 24000,
            latencyHint: 'interactive'
          });
          
          widgetLog(`[AUDIO] AudioContext создан с частотой ${audioContext.sampleRate} Гц`);
          
          // Получаем микрофон
          microphone = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              sampleRate: 24000,
              sampleSize: 16,
              channelCount: 1
            }
          });
          
          widgetLog('[AUDIO] Микрофон активирован');
          
          // Воспроизводим тишину для разблокировки AudioContext
          if (audioContext.state === 'suspended') {
            const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            source.start();
            await audioContext.resume();
          }
          
          widgetLog('[AUDIO] Тишина воспроизведена для разблокировки AudioContext');
          
          // Тестируем HTML5 Audio
          try {
            widgetLog('[AUDIO] Тестируем HTML5 Audio воспроизведение...');
            const testAudio = new Audio();
            testAudio.src = 'data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoAAABBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBzqU3vLEeSsFJYXO9tiDNgYZaLvs559NEAxNm+PyvmchBjuL2vLOeywE';
            testAudio.volume = 0.01;
            testAudio.playsInline = true;
            await testAudio.play();
            widgetLog('[AUDIO] HTML5 Audio разблокировано успешно');
            window.audioPlaybackUnlocked = true;
          } catch (e) {
            widgetLog(`[AUDIO] HTML5 Audio требует пользовательского взаимодействия: ${e.message}`);
            window.audioPlaybackUnlocked = false;
          }
          
          widgetLog('[AUDIO] Единая инициализация завершена успешно');
        } else {
          // Десктопная инициализация
          audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 24000
          });
          
          microphone = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              sampleRate: 24000,
              sampleSize: 16,
              channelCount: 1
            }
          });
          
          window.audioPlaybackUnlocked = true;
          widgetLog('[AUDIO] Десктопная инициализация завершена');
        }
        
        return true;
      } catch (error) {
        widgetLog(`[AUDIO] Ошибка инициализации аудио: ${error.message}`, 'error');
        connectionStatus.textContent = 'Ошибка доступа к микрофону';
        connectionStatus.className = 'wellcomeai-connection-status disconnected';
        return false;
      }
    }

    // Функция начала прослушивания
    async function startListening() {
      if (!isConnected || window.isPlayingAudio || isReconnecting || isListening) {
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${window.isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`);
        return;
      }

      try {
        widgetLog('Начинаем прослушивание');
        
        if (!audioContext || !microphone) {
          const success = await initializeAudio();
          if (!success) return;
        }

        // Создаем ScriptProcessorNode
        processor = audioContext.createScriptProcessor(2048, 1, 1);
        const source = audioContext.createMediaStreamSource(microphone);
        
        widgetLog(`Создан ScriptProcessorNode с размером буфера ${processor.bufferSize}`);
        
        // Переменные для детекции речи
        let silenceStart = Date.now();
        let speechDetected = false;
        let audioBuffer = [];

        processor.onaudioprocess = function(e) {
          if (!isListening) return;

          const inputData = e.inputBuffer.getChannelData(0);
          const bufferLength = inputData.length;

          // Вычисляем RMS (среднеквадратичное значение)
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sum / bufferLength);

          // Определяем, есть ли звук
          const hasSound = rms > AUDIO_CONFIG.soundDetectionThreshold;

          if (hasSound) {
            if (!speechDetected) {
              speechDetected = true;
              silenceStart = Date.now();
            }
          } else {
            if (speechDetected && (Date.now() - silenceStart) > AUDIO_CONFIG.silenceDuration) {
              speechDetected = false;
            }
          }

          // Конвертируем в PCM16 и отправляем
          const pcm16 = new Int16Array(bufferLength);
          for (let i = 0; i < bufferLength; i++) {
            const sample = Math.max(-1, Math.min(1, inputData[i] * AUDIO_CONFIG.amplificationFactor));
            pcm16[i] = sample * 32767;
          }

          audioBuffer.push(...pcm16);

          // Отправляем буферы по 2048 сэмплов
          if (audioBuffer.length >= 2048) {
            const chunkToSend = audioBuffer.splice(0, 2048);
            const uint8Array = new Uint8Array(chunkToSend.buffer);
            const base64 = arrayBufferToBase64(uint8Array.buffer);

            if (websocket && websocket.readyState === WebSocket.OPEN) {
              websocket.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: base64
              }));
            }
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        isListening = true;
        window.isListening = true;
        
        // Очищаем входной буфер перед началом
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({
            type: 'input_audio_buffer.clear'
          }));
        }

        mainCircle.classList.add('listening');
        statusText.textContent = 'Слушаю...';
        statusText.className = 'wellcomeai-status-text listening';

        widgetLog('Прослушивание начато успешно');
        widgetLog('Начало записи аудиоданных');

      } catch (error) {
        widgetLog(`Ошибка при запуске прослушивания: ${error.message}`, 'error');
        isListening = false;
        window.isListening = false;
      }
    }

    // Функция остановки прослушивания
    function stopListening() {
      if (!isListening) return;

      widgetLog('Остановка прослушивания');

      try {
        if (processor) {
          processor.disconnect();
          processor = null;
        }

        isListening = false;
        window.isListening = false;

        mainCircle.classList.remove('listening');
        statusText.textContent = 'Подключен';
        statusText.className = 'wellcomeai-status-text';

        widgetLog('Прослушивание остановлено');
      } catch (error) {
        widgetLog(`Ошибка при остановке прослушивания: ${error.message}`, 'error');
      }
    }

    // WebSocket переменные
    let isConnected = false;
    let isReconnecting = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    // Функция подключения к WebSocket
    function connectWebSocket() {
      const wsUrl = `wss://${serverUrl}/ws/${assistantId}`;
      widgetLog(`Connecting to WebSocket at: ${wsUrl}`);

      websocket = new WebSocket(wsUrl);

      websocket.onopen = function() {
        widgetLog('WebSocket connection established');
        isConnected = true;
        isReconnecting = false;
        reconnectAttempts = 0;
        
        connectionStatus.textContent = 'Подключен';
        connectionStatus.className = 'wellcomeai-connection-status connected';
        
        // Отправляем конфигурацию сессии
        websocket.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: 'Ты полезный голосовой ассистент. Отвечай кратко и по существу.',
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 200
            },
            tools: [],
            tool_choice: 'auto',
            temperature: 0.8,
            max_response_output_tokens: 'inf'
          }
        }));
      };

      websocket.onmessage = function(event) {
        try {
          const message = JSON.parse(event.data);
          handleWebSocketMessage(message);
        } catch (error) {
          widgetLog(`Ошибка парсинга сообщения: ${error.message}`, 'error');
        }
      };

      websocket.onclose = function(event) {
        widgetLog(`WebSocket connection closed: ${event.code} - ${event.reason}`);
        isConnected = false;
        
        connectionStatus.textContent = 'Отключен';
        connectionStatus.className = 'wellcomeai-connection-status disconnected';
        
        stopListening();
        
        // Автоматическое переподключение
        if (!isReconnecting && reconnectAttempts < maxReconnectAttempts) {
          isReconnecting = true;
          reconnectAttempts++;
          
          connectionStatus.textContent = `Переподключение... (${reconnectAttempts}/${maxReconnectAttempts})`;
          
          setTimeout(() => {
            if (isReconnecting) {
              connectWebSocket();
            }
          }, 2000 * reconnectAttempts);
        } else if (reconnectAttempts >= maxReconnectAttempts) {
          connectionStatus.textContent = 'Ошибка подключения';
          connectionStatus.className = 'wellcomeai-connection-status disconnected';
        }
      };

      websocket.onerror = function(error) {
        widgetLog(`WebSocket error: ${error}`, 'error');
      };
    }

    // Обработка сообщений WebSocket
    function handleWebSocketMessage(message) {
      widgetLog(`Получено сообщение типа: ${message.type}`);

      switch (message.type) {
        case 'session.created':
        case 'session.updated':
          widgetLog(`Получена информация о сессии: ${message.type}`);
          break;

        case 'input_audio_buffer.committed':
          // Буфер зафиксирован
          break;

        case 'input_audio_buffer.cleared':
          // Буфер очищен
          break;

        case 'conversation.item.created':
          // Создан элемент диалога
          break;

        case 'response.created':
          // Создан ответ
          break;

        case 'response.output_item.added':
          // Добавлен элемент вывода
          break;

        case 'response.content_part.added':
          // Добавлена часть контента
          break;

        case 'response.audio_transcript.delta':
          // Получена дельта транскрипции
          break;

        case 'response.audio_transcript.done':
          // Транскрипция завершена
          break;

        case 'response.audio.delta':
          if (message.delta) {
            addAudioToPlaybackQueue(message.delta);
          }
          break;

        case 'response.audio.done':
          widgetLog('[AUDIO] Получение аудиоданных завершено');
          break;

        case 'response.done':
          widgetLog('Response done received');
          break;

        case 'error':
          widgetLog(`Ошибка: ${message.error?.message || 'Неизвестная ошибка'}`, 'error');
          break;

        case 'speech.started':
          widgetLog(`[INTERRUPTION] Пользователь начал говорить: ${JSON.stringify(message)}`);
          interruptionState.is_user_speaking = true;
          interruptionState.last_interruption = Date.now();
          break;

        case 'speech.stopped':
          widgetLog(`[INTERRUPTION] Пользователь закончил говорить: ${JSON.stringify(message)}`);
          interruptionState.is_user_speaking = false;
          break;

        case 'assistant.speech.started':
          widgetLog(`[INTERRUPTION] Ассистент начал говорить: ${JSON.stringify(message)}`);
          interruptionState.is_assistant_speaking = true;
          interruptionState.interruption_count = 0;
          break;

        case 'assistant.speech.ended':
          widgetLog(`[INTERRUPTION] Ассистент закончил говорить: ${JSON.stringify(message)}`);
          interruptionState.is_assistant_speaking = false;
          break;

        case 'connection_status':
          widgetLog(`Статус соединения: ${message.status} - ${message.message}`);
          break;

        case 'pong':
          // Ответ на ping
          break;

        default:
          // Неизвестные типы сообщений логируем как предупреждения
          if (!message.type?.includes('.ack')) {
            widgetLog(`Неизвестный тип сообщения: ${message.type}`, 'warn');
          }
          break;
      }
    }

    // Функции управления виджетом
    async function openWidget() {
      if (isWidgetOpen) return;

      widgetLog('Opening widget');
      
      container.classList.add('wellcomeai-widget-open');
      isWidgetOpen = true;
      
      // Инициализируем аудио при открытии
      const audioInitSuccess = await initializeAudio();
      if (!audioInitSuccess) {
        widgetLog('Не удалось инициализировать аудио', 'error');
        return;
      }
      
      // Подключаемся к WebSocket если еще не подключены
      if (!websocket || websocket.readyState === WebSocket.CLOSED) {
        connectWebSocket();
      }
      
      // Запускаем прослушивание
      if (isConnected) {
        await startListening();
      }
      
      widgetButton.classList.remove('wellcomeai-pulse-animation');
    }

    function closeWidget() {
      if (!isWidgetOpen) return;

      widgetLog('Closing widget');
      
      // Останавливаем все воспроизведения при закрытии
      stopAllAudioPlayback();
      
      // Отменяем текущий ответ если он генерируется
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: 'response.cancel'
        }));
        
        websocket.send(JSON.stringify({
          type: 'input_audio_buffer.clear'
        }));
      }
      
      stopListening();
      
      container.classList.remove('wellcomeai-widget-open');
      isWidgetOpen = false;
      
      statusText.textContent = 'Нажмите для начала разговора';
      statusText.className = 'wellcomeai-status-text';
      mainCircle.className = 'wellcomeai-voice-circle';
    }

    // Добавляем обработчики событий
    widgetButton.addEventListener('click', async function() {
      widgetLog('Button clicked');
      await openWidget();
    });

    closeButton.addEventListener('click', function() {
      widgetLog('Close button clicked');
      closeWidget();
    });

    // Начальная инициализация
    connectWebSocket();

    // Отладочная информация
    function logDebugInfo() {
      setTimeout(() => {
        widgetLog('DOM check after initialization');
        widgetLog(`Container z-index = ${getComputedStyle(container).zIndex}`);
        widgetLog(`Button is visible = ${getComputedStyle(widgetButton).display !== 'none'}`);
        widgetLog(`Connection state = ${websocket ? websocket.readyState : 'null'}`);
        widgetLog(`Status flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${window.isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}`);
        widgetLog(`Interruption state: assistant_speaking=${interruptionState.is_assistant_speaking}, user_speaking=${interruptionState.is_user_speaking}, count=${interruptionState.interruption_count}`);
      }, 1000);
    }

    logDebugInfo();
  }

  // Извлекаем конфигурацию из script tag
  function extractConfig() {
    const scripts = document.querySelectorAll('script[src*="widget.js"]');
    let serverUrl = null;
    let assistantId = null;

    scripts.forEach(script => {
      const src = script.src;
      if (src) {
        // Извлекаем URL сервера из src
        const url = new URL(src);
        serverUrl = url.origin.replace(/^https?:\/\//, '');
        widgetLog(`Extracted server URL from script src: https://${serverUrl}`);

        // Ищем assistant ID в data-атрибутах
        assistantId = script.dataset.assistantId;
        if (assistantId) {
          widgetLog(`Found assistant ID from dataset: ${assistantId}`);
        }
      }
    });

    return { serverUrl, assistantId };
  }

  // Главная функция инициализации
  function initializeWidget() {
    const { serverUrl, assistantId } = extractConfig();

    if (!serverUrl || !assistantId) {
      widgetLog('Server URL or Assistant ID not found', 'error');
      return;
    }

    widgetLog(`Configuration: Server URL: https://${serverUrl}, Assistant ID: ${assistantId}, Position: bottom-right`);
    widgetLog(`WebSocket URL: wss://${serverUrl}/ws/${assistantId}`);

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    widgetLog(`Device: ${isMobile ? 'iOS' : 'Desktop'}`);

    // Проверяем, не инициализирован ли уже виджет
    if (document.getElementById('wellcomeai-widget-container')) {
      widgetLog('Widget already exists on the page, skipping initialization');
      return;
    }

    // Загружаем Font Awesome если его нет
    if (!document.querySelector('link[href*="font-awesome"]') && !document.querySelector('link[href*="fontawesome"]')) {
      const fontAwesome = document.createElement('link');
      fontAwesome.rel = 'stylesheet';
      fontAwesome.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
      document.head.appendChild(fontAwesome);
    }

    widgetLog('Font Awesome loaded');

    // Инициализируем виджет
    initWidget(serverUrl, assistantId);
  }

  // Запуск инициализации
  widgetLog('Starting unified initialization process');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      widgetLog('DOM loaded, initializing widget');
      initializeWidget();
    });
  } else {
    widgetLog('DOM already loaded, initializing immediately');
    initializeWidget();
  }

  // Экспортируем функции в глобальную область для отладки
  window.WellcomeAI = {
    log: widgetLog,
    reinitialize: initializeWidget
  };

  widgetLog('Unified widget initialization complete - same behavior for all devices');

})();
