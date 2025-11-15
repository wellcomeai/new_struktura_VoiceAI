/**
 * 🚀 Gemini Voice Widget v2.0 - Production Ready
 * Google Gemini Live API Integration with WellcomeAI Branded UI
 * 
 * Features:
 * ✅ WebSocket connection to /ws/gemini/{assistant_id}
 * ✅ Real-time audio streaming (16kHz PCM)
 * ✅ Client-side VAD events
 * ✅ Audio resampling (24kHz → 16kHz)
 * ✅ Interruption handling
 * ✅ Visual feedback (equalizer)
 * ✅ Error handling with Russian messages
 * ✅ Responsive design
 * ✅ Unified WellcomeAI branding (same UI as OpenAI widget)
 * 
 * Usage:
 * <script>
 *   (function() {
 *     var script = document.createElement('script');
 *     script.src = 'https://yourserver.com/static/gemini-widget.js';
 *     script.dataset.assistantId = 'your-assistant-uuid';
 *     script.dataset.server = 'https://yourserver.com';
 *     script.dataset.position = 'bottom-right';
 *     script.async = true;
 *     document.head.appendChild(script);
 *   })();
 * </script>
 */

(function() {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================

    const DEBUG_MODE = true;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const PING_INTERVAL = 30000;
    const CONNECTION_TIMEOUT = 20000;

    const CONFIG = {
        // От data-атрибутов скрипта
        assistantId: null,
        serverUrl: null,
        position: 'bottom-right',
        
        // Аудио параметры
        audio: {
            inputSampleRate: 16000,      // Gemini expects 16kHz
            outputSampleRate: 24000,     // Gemini sends 24kHz
            playbackSampleRate: 16000,   // Downsampled for playback
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,          // ms
            maxBufferSize: 96000
        },
        
        // VAD
        vad: {
            enabled: true,
            silenceThreshold: -45,       // dB
            silenceDuration: 500,        // ms
            speechThreshold: -40         // dB
        },
        
        // WebSocket
        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        }
    };

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================

    const STATE = {
        ws: null,
        isConnected: false,
        isRecording: false,
        isPlaying: false,
        isSpeaking: false,
        audioContext: null,
        mediaStream: null,
        audioWorklet: null,
        audioQueue: [],
        currentAudioSource: null,
        pingInterval: null,
        reconnectAttempts: 0,
        lastSpeechTime: 0,
        lastSilenceTime: 0,
        sessionConfig: null,
        errorState: null,
        isWidgetOpen: false,
        isReconnecting: false,
        connectionFailedPermanently: false
    };

    // Состояния для обработки перебивания
    const interruptionState = {
        is_assistant_speaking: false,
        is_user_speaking: false,
        interruption_count: 0,
        current_audio_elements: []
    };

    // ============================================================================
    // LOGGING
    // ============================================================================

    const widgetLog = (message, type = 'info') => {
        if (DEBUG_MODE || type === 'error') {
            const prefix = '[Gemini Widget]';
            if (type === 'error') {
                console.error(`${prefix} ERROR:`, message);
            } else if (type === 'warn') {
                console.warn(`${prefix} WARNING:`, message);
            } else if (DEBUG_MODE) {
                console.log(`${prefix}`, message);
            }
        }
    };

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        widgetLog('Initializing Gemini Widget v2.0...');
        
        // Получаем конфигурацию из data-атрибутов
        const scriptTag = document.currentScript || 
                         document.querySelector('script[data-assistant-id]');
        
        if (!scriptTag) {
            widgetLog('Script tag not found', 'error');
            return;
        }

        CONFIG.assistantId = scriptTag.dataset.assistantId;
        CONFIG.serverUrl = scriptTag.dataset.server;
        CONFIG.position = scriptTag.dataset.position || 'bottom-right';

        if (!CONFIG.assistantId || !CONFIG.serverUrl) {
            widgetLog('Missing required parameters: assistantId, server', 'error');
            return;
        }

        widgetLog(`Config: ${JSON.stringify({
            assistantId: CONFIG.assistantId,
            server: CONFIG.serverUrl,
            position: CONFIG.position
        })}`);

        // Создаем UI
        loadFontAwesome();
        createStyles();
        createWidget();
        
        // Инициализируем AudioContext при первом взаимодействии
        document.addEventListener('click', initAudioContext, { once: true });
        document.addEventListener('touchstart', initAudioContext, { once: true });
    }

    function initAudioContext() {
        if (STATE.audioContext) return;
        
        STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.audio.inputSampleRate
        });
        
        widgetLog(`AudioContext initialized: ${STATE.audioContext.sampleRate} Hz`);
    }

    // ============================================================================
    // FONT AWESOME
    // ============================================================================

    function loadFontAwesome() {
        if (!document.getElementById('font-awesome-css')) {
            const link = document.createElement('link');
            link.id = 'font-awesome-css';
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(link);
            widgetLog('Font Awesome loaded');
        }
    }

    // ============================================================================
    // STYLES - UNIFIED WELLCOMEAI BRANDING (FROM OPENAI WIDGET)
    // ============================================================================

    function createStyles() {
        const position = CONFIG.position;
        const parts = position.split('-');
        const vertical = parts[0]; // top или bottom
        const horizontal = parts[1]; // left или right

        const styleEl = document.createElement('style');
        styleEl.id = 'gemini-widget-styles';
        styleEl.textContent = `
      .gemini-widget-container {
        position: fixed;
        ${vertical}: 20px;
        ${horizontal}: 20px;
        z-index: 2147483647;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: 'Segoe UI', 'Roboto', sans-serif;
      }
      
      /* ПРЕМИАЛЬНЫЙ ДИЗАЙН КНОПКИ */
      .gemini-widget-button {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #4a86e8, #2b59c3);
        box-shadow: 0 8px 32px rgba(74, 134, 232, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1);
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
      
      .gemini-widget-button:hover {
        transform: scale(1.05);
        box-shadow: 0 10px 30px rgba(74, 134, 232, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.15);
      }
      
      .gemini-button-inner {
        position: relative;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .gemini-pulse-ring {
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        animation: gemini-pulse-ring 3s ease-out infinite;
        background: radial-gradient(rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0) 70%);
        opacity: 0;
      }
      
      @keyframes gemini-pulse-ring {
        0% {
          transform: scale(0.5);
          opacity: 0;
        }
        25% {
          opacity: 0.4;
        }
        100% {
          transform: scale(1.2);
          opacity: 0;
        }
      }
      
      .gemini-audio-bars-mini {
        display: flex;
        align-items: center;
        height: 26px;
        gap: 4px;
        justify-content: center;
      }
      
      .gemini-audio-bar-mini {
        width: 3px;
        height: 12px;
        background-color: #ffffff;
        border-radius: 1.5px;
        animation: gemini-eq-animation 1.2s ease-in-out infinite;
        opacity: 0.9;
      }
      
      .gemini-audio-bar-mini:nth-child(1) { animation-delay: 0.0s; height: 7px; }
      .gemini-audio-bar-mini:nth-child(2) { animation-delay: 0.3s; height: 12px; }
      .gemini-audio-bar-mini:nth-child(3) { animation-delay: 0.1s; height: 18px; }
      .gemini-audio-bar-mini:nth-child(4) { animation-delay: 0.5s; height: 9px; }
      
      @keyframes gemini-eq-animation {
        0% { height: 5px; }
        50% { height: 18px; }
        100% { height: 5px; }
      }
      
      .gemini-widget-expanded {
        position: absolute;
        ${vertical}: 0;
        ${horizontal}: 0;
        width: 320px;
        height: 0;
        opacity: 0;
        pointer-events: none;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-radius: 20px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
        overflow: hidden;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        display: flex;
        flex-direction: column;
        z-index: 2147483646;
      }
      
      .gemini-widget-container.active .gemini-widget-expanded {
        height: 460px;
        opacity: 1;
        pointer-events: all;
      }
      
      .gemini-widget-container.active .gemini-widget-button {
        transform: scale(0.9);
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
      }
      
      .gemini-widget-header {
        padding: 15px 20px;
        background: linear-gradient(135deg, #1e3a8a, #3b82f6);
        color: white;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-radius: 20px 20px 0 0;
      }
      
      .gemini-widget-title {
        font-weight: 600;
        font-size: 16px;
        letter-spacing: 0.3px;
      }
      
      .gemini-widget-close {
        background: none;
        border: none;
        color: white;
        font-size: 18px;
        cursor: pointer;
        opacity: 0.8;
        transition: all 0.2s;
      }
      
      .gemini-widget-close:hover {
        opacity: 1;
        transform: scale(1.1);
      }
      
      .gemini-widget-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #f9fafc;
        position: relative;
        padding: 20px;
        padding-bottom: 10px;
      }
      
      /* ГЛАВНЫЙ КРУГ */
      .gemini-main-circle {
        width: 180px;
        height: 180px;
        border-radius: 50%;
        background: linear-gradient(135deg, #f3f4f6, #e5e7eb);
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1), inset 0 2px 5px rgba(255, 255, 255, 0.5);
        position: relative;
        overflow: hidden;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .gemini-main-circle::before {
        content: '';
        position: absolute;
        width: 140%;
        height: 140%;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.3), rgba(74, 134, 232, 0.2));
        animation: gemini-wave 8s linear infinite;
        border-radius: 40%;
      }
      
      @keyframes gemini-wave {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      
      .gemini-main-circle.listening {
        background: linear-gradient(135deg, #dbeafe, #eff6ff);
        box-shadow: 0 0 30px rgba(37, 99, 235, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
      }
      
      .gemini-main-circle.listening::before {
        animation: gemini-wave 4s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(37, 99, 235, 0.3));
      }
      
      .gemini-main-circle.listening::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        border: 3px solid rgba(37, 99, 235, 0.5);
        animation: gemini-pulse 1.5s ease-out infinite;
      }
      
      @keyframes gemini-pulse {
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
      
      .gemini-main-circle.speaking {
        background: linear-gradient(135deg, #dcfce7, #ecfdf5);
        box-shadow: 0 0 30px rgba(5, 150, 105, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
      }
      
      .gemini-main-circle.speaking::before {
        animation: gemini-wave 3s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(5, 150, 105, 0.3));
      }
      
      .gemini-main-circle.speaking::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle, transparent 50%, rgba(5, 150, 105, 0.1) 100%);
        border-radius: 50%;
        animation: gemini-ripple 2s ease-out infinite;
      }
      
      @keyframes gemini-ripple {
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
      
      .gemini-main-circle.interrupted {
        background: linear-gradient(135deg, #fef3c7, #fffbeb);
        box-shadow: 0 0 30px rgba(217, 119, 6, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
      }
      
      .gemini-main-circle.interrupted::before {
        animation: gemini-wave 2s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(217, 119, 6, 0.3));
      }
      
      .gemini-mic-icon {
        color: #3b82f6;
        font-size: 32px;
        z-index: 10;
        transition: color 0.3s ease;
      }
      
      .gemini-main-circle.listening .gemini-mic-icon {
        color: #2563eb;
      }
      
      .gemini-main-circle.speaking .gemini-mic-icon {
        color: #059669;
      }
      
      .gemini-main-circle.interrupted .gemini-mic-icon {
        color: #d97706;
      }
      
      .gemini-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px;
        bottom: -5px;
        opacity: 0.8;
        pointer-events: none;
      }
      
      .gemini-audio-bars {
        display: flex;
        align-items: flex-end;
        height: 30px;
        gap: 2px;
        width: 100%;
        justify-content: center;
      }
      
      .gemini-audio-bar {
        width: 3px;
        height: 2px;
        background-color: #3b82f6;
        border-radius: 1px;
        transition: height 0.1s ease;
      }
      
      .gemini-loader-modal {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483646;
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s;
        border-radius: 20px;
      }
      
      .gemini-loader-modal.active {
        opacity: 1;
        visibility: visible;
      }
      
      .gemini-loader {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(59, 130, 246, 0.2);
        border-radius: 50%;
        border-top-color: #3b82f6;
        animation: gemini-spin 1s linear infinite;
      }
      
      @keyframes gemini-spin {
        to { transform: rotate(360deg); }
      }
      
      .gemini-message-display {
        position: absolute;
        width: 90%;
        bottom: 70px;
        left: 50%;
        transform: translateX(-50%);
        background: white;
        padding: 12px 15px;
        border-radius: 12px;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.08);
        text-align: center;
        font-size: 14px;
        line-height: 1.4;
        opacity: 0;
        transition: all 0.3s;
        max-height: 100px;
        overflow-y: auto;
        z-index: 10;
      }
      
      .gemini-message-display.show {
        opacity: 1;
      }

      .gemini-connection-error {
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
      
      .gemini-connection-error.visible {
        display: block;
      }

      .gemini-retry-button {
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
      
      .gemini-retry-button:hover {
        background-color: #dc2626;
      }
      
      .gemini-status-indicator {
        position: absolute;
        bottom: 50px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 11px;
        color: #475569;
        padding: 4px 8px;
        border-radius: 10px;
        background-color: rgba(255, 255, 255, 0.8);
        display: flex;
        align-items: center;
        gap: 5px;
        opacity: 0;
        transition: opacity 0.3s;
      }
      
      .gemini-status-indicator.show {
        opacity: 0.8;
      }
      
      .gemini-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #10b981;
      }
      
      .gemini-status-dot.disconnected {
        background-color: #ef4444;
      }
      
      .gemini-status-dot.connecting {
        background-color: #f59e0b;
      }
      
      .gemini-status-dot.interrupted {
        background-color: #d97706;
      }
      
      /* VOICYFY БРЕНДИНГ */
      .gemini-voicyfy-container {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        text-align: center;
        padding: 8px;
        opacity: 0.8;
        transition: opacity 0.2s ease;
      }
      
      .gemini-voicyfy-container:hover {
        opacity: 1;
      }
      
      .gemini-voicyfy-link {
        display: inline-block;
        text-decoration: none;
        transition: transform 0.2s ease;
      }
      
      .gemini-voicyfy-link:hover {
        transform: translateY(-2px);
      }
      
      .gemini-voicyfy-link img {
        height: 25px;
        width: auto;
        display: block;
      }

      /* MOBILE */
      @media (max-width: 768px) {
        .gemini-widget-button {
          width: 56px;
          height: 56px;
        }
        
        .gemini-widget-expanded {
          width: calc(100vw - 40px);
          max-width: 320px;
        }
      }
    `;
        document.head.appendChild(styleEl);
        widgetLog('Styles created');
    }

    // ============================================================================
    // UI CREATION - UNIFIED WELLCOMEAI STRUCTURE
    // ============================================================================

    function createWidget() {
        const container = document.createElement('div');
        container.className = 'gemini-widget-container';
        container.id = 'gemini-widget-container';

        container.innerHTML = `
      <!-- Премиальная кнопка -->
      <div class="gemini-widget-button" id="gemini-widget-button">
        <div class="gemini-button-inner">
          <div class="gemini-pulse-ring"></div>
          
          <!-- Только эквалайзер -->
          <div class="gemini-audio-bars-mini">
            <div class="gemini-audio-bar-mini"></div>
            <div class="gemini-audio-bar-mini"></div>
            <div class="gemini-audio-bar-mini"></div>
            <div class="gemini-audio-bar-mini"></div>
          </div>
        </div>
      </div>
      
      <!-- Развернутый виджет -->
      <div class="gemini-widget-expanded" id="gemini-widget-expanded">
        <div class="gemini-widget-header">
          <div class="gemini-widget-title">Голосовой Ассистент</div>
          <button class="gemini-widget-close" id="gemini-widget-close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="gemini-widget-content">
          <!-- Главный круг -->
          <div class="gemini-main-circle" id="gemini-main-circle">
            <i class="fas fa-microphone gemini-mic-icon"></i>
            
            <!-- Аудио визуализация -->
            <div class="gemini-audio-visualization" id="gemini-audio-visualization">
              <div class="gemini-audio-bars" id="gemini-audio-bars"></div>
            </div>
          </div>
          
          <!-- Сообщение -->
          <div class="gemini-message-display" id="gemini-message-display"></div>
          
          <!-- Ошибка соединения -->
          <div class="gemini-connection-error" id="gemini-connection-error">
            Ошибка соединения с сервером
            <button class="gemini-retry-button" id="gemini-retry-button">
              Повторить подключение
            </button>
          </div>
          
          <!-- Индикатор статуса -->
          <div class="gemini-status-indicator" id="gemini-status-indicator">
            <div class="gemini-status-dot" id="gemini-status-dot"></div>
            <span id="gemini-status-text">Подключено</span>
          </div>
          
          <!-- VOICYFY -->
          <div class="gemini-voicyfy-container">
            <a href="https://voicyfy.ru/" target="_blank" rel="noopener noreferrer" class="gemini-voicyfy-link">
              <img src="https://i.ibb.co/ccw6sjdk/photo-2025-06-03-05-04-02.jpg" alt="Voicyfy - powered by AI">
            </a>
          </div>
        </div>
      </div>
      
      <!-- Загрузка -->
      <div id="gemini-loader-modal" class="gemini-loader-modal active">
        <div class="gemini-loader"></div>
      </div>
    `;

        document.body.appendChild(container);
        widgetLog('Widget HTML created');

        // Инициализация после создания
        initWidgetLogic();
    }

    // ============================================================================
    // WIDGET LOGIC
    // ============================================================================

    function initWidgetLogic() {
        const widgetButton = document.getElementById('gemini-widget-button');
        const widgetClose = document.getElementById('gemini-widget-close');
        const mainCircle = document.getElementById('gemini-main-circle');
        const audioBars = document.getElementById('gemini-audio-bars');
        const loaderModal = document.getElementById('gemini-loader-modal');
        const messageDisplay = document.getElementById('gemini-message-display');
        const connectionError = document.getElementById('gemini-connection-error');
        const retryButton = document.getElementById('gemini-retry-button');
        const statusIndicator = document.getElementById('gemini-status-indicator');
        const statusDot = document.getElementById('gemini-status-dot');
        const statusText = document.getElementById('gemini-status-text');

        if (!widgetButton || !widgetClose || !mainCircle) {
            widgetLog('UI elements not found!', 'error');
            return;
        }

        // Создаем аудио-бары
        createAudioBars(20);

        // Event handlers
        widgetButton.addEventListener('click', openWidget);
        widgetClose.addEventListener('click', closeWidget);
        mainCircle.addEventListener('click', () => {
            if (STATE.isWidgetOpen && !STATE.isRecording && !STATE.isPlaying && !STATE.isReconnecting) {
                if (STATE.isConnected) {
                    startRecording();
                } else if (STATE.connectionFailedPermanently) {
                    showConnectionError('Соединение с сервером отсутствует');
                } else {
                    connectWebSocket();
                }
            }
        });

        if (retryButton) {
            retryButton.addEventListener('click', resetConnection);
        }

        // Начальное подключение
        connectWebSocket();

        function createAudioBars(count = 20) {
            audioBars.innerHTML = '';
            for (let i = 0; i < count; i++) {
                const bar = document.createElement('div');
                bar.className = 'gemini-audio-bar';
                audioBars.appendChild(bar);
            }
        }

        function showMessage(message, duration = 5000) {
            messageDisplay.textContent = message;
            messageDisplay.classList.add('show');
            
            if (duration > 0) {
                setTimeout(() => {
                    messageDisplay.classList.remove('show');
                }, duration);
            }
        }

        function hideMessage() {
            messageDisplay.classList.remove('show');
        }

        function showConnectionError(message) {
            if (connectionError) {
                connectionError.innerHTML = `
                    ${message || 'Ошибка соединения с сервером'}
                    <button class="gemini-retry-button" onclick="this.parentElement.nextElementSibling.click()">
                        Повторить подключение
                    </button>
                `;
                connectionError.classList.add('visible');
            }
        }

        function hideConnectionError() {
            if (connectionError) {
                connectionError.classList.remove('visible');
            }
        }

        function updateConnectionStatus(status, message) {
            if (!statusIndicator || !statusDot || !statusText) return;
            
            statusText.textContent = message || status;
            
            statusDot.classList.remove('connected', 'disconnected', 'connecting', 'interrupted');
            
            if (status === 'connected') {
                statusDot.classList.add('connected');
            } else if (status === 'disconnected') {
                statusDot.classList.add('disconnected');
            } else if (status === 'interrupted') {
                statusDot.classList.add('interrupted');
            } else {
                statusDot.classList.add('connecting');
            }
            
            statusIndicator.classList.add('show');
            
            setTimeout(() => {
                statusIndicator.classList.remove('show');
            }, 3000);
        }

        function resetConnection() {
            STATE.reconnectAttempts = 0;
            STATE.connectionFailedPermanently = false;
            
            hideConnectionError();
            showMessage('Попытка подключения...');
            updateConnectionStatus('connecting', 'Подключение...');
            
            connectWebSocket();
        }

        async function openWidget() {
            widgetLog('Opening widget');
            
            const container = document.getElementById('gemini-widget-container');
            container.classList.add('active');
            STATE.isWidgetOpen = true;

            // Инициализируем аудио если нужно
            if (!STATE.audioContext) {
                initAudioContext();
            }

            if (STATE.connectionFailedPermanently) {
                showConnectionError('Не удалось подключиться к серверу');
                return;
            }

            if (STATE.isConnected && !STATE.isRecording && !STATE.isPlaying && !STATE.isReconnecting) {
                setTimeout(() => startRecording(), 500);
                updateConnectionStatus('connected', 'Подключено (Gemini API)');
            } else if (!STATE.isConnected && !STATE.isReconnecting) {
                connectWebSocket();
            }
        }

        function closeWidget() {
            widgetLog('Closing widget');
            
            stopRecording();
            
            const container = document.getElementById('gemini-widget-container');
            container.classList.remove('active');
            STATE.isWidgetOpen = false;
            
            hideMessage();
            hideConnectionError();
            
            if (statusIndicator) {
                statusIndicator.classList.remove('show');
            }
        }

        async function startRecording() {
            if (!STATE.isConnected || STATE.isPlaying || STATE.isReconnecting || STATE.isRecording) {
                widgetLog(`Cannot start recording: isConnected=${STATE.isConnected}, isPlaying=${STATE.isPlaying}, isReconnecting=${STATE.isReconnecting}, isRecording=${STATE.isRecording}`);
                return;
            }

            try {
                widgetLog('Starting recording...');

                // Проверка AudioContext
                if (!STATE.audioContext) {
                    initAudioContext();
                }

                if (STATE.audioContext.state === 'suspended') {
                    await STATE.audioContext.resume();
                }

                // Получаем доступ к микрофону
                if (!STATE.mediaStream) {
                    STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            sampleRate: CONFIG.audio.inputSampleRate,
                            channelCount: 1
                        }
                    });
                }

                STATE.isRecording = true;

                // Создаем audio worklet для обработки
                const source = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
                const processor = STATE.audioContext.createScriptProcessor(4096, 1, 1);

                let isSilent = true;
                let silenceStartTime = Date.now();

                processor.onaudioprocess = (e) => {
                    if (STATE.isRecording && STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                        const inputData = e.inputBuffer.getChannelData(0);
                        
                        // Визуализация
                        updateAudioVisualization(inputData);

                        // Конвертация в PCM16
                        const pcm16 = float32ToPCM16(inputData);
                        const base64Audio = arrayBufferToBase64(pcm16.buffer);

                        // Отправка в Gemini
                        STATE.ws.send(JSON.stringify({
                            realtime_input: {
                                media_chunks: [{
                                    data: base64Audio,
                                    mime_type: "audio/pcm"
                                }]
                            }
                        }));

                        // VAD логика
                        const rms = calculateRMS(inputData);
                        const hasSound = rms > 0.02;

                        if (hasSound) {
                            isSilent = false;
                            silenceStartTime = Date.now();
                            
                            if (!mainCircle.classList.contains('listening')) {
                                mainCircle.classList.add('listening');
                            }
                        } else if (!isSilent) {
                            const silenceDuration = Date.now() - silenceStartTime;
                            
                            if (silenceDuration > CONFIG.vad.silenceDuration) {
                                isSilent = true;
                                // Можно добавить логику автокоммита
                            }
                        }
                    }
                };

                source.connect(processor);
                processor.connect(STATE.audioContext.destination);

                STATE.audioWorklet = { source, processor };

                mainCircle.classList.add('listening');
                mainCircle.classList.remove('speaking');

                widgetLog('Recording started');

            } catch (error) {
                widgetLog(`Recording error: ${error.message}`, 'error');
                showMessage('Ошибка доступа к микрофону');
            }
        }

        function stopRecording() {
            if (!STATE.isRecording) return;
            
            widgetLog('Stopping recording');
            
            STATE.isRecording = false;
            
            if (STATE.mediaStream) {
                STATE.mediaStream.getTracks().forEach(track => track.stop());
                STATE.mediaStream = null;
            }
            
            if (STATE.audioWorklet) {
                STATE.audioWorklet.source.disconnect();
                STATE.audioWorklet.processor.disconnect();
                STATE.audioWorklet = null;
            }
            
            mainCircle.classList.remove('listening');
            
            resetAudioVisualization();
            
            widgetLog('Recording stopped');
        }

        function updateAudioVisualization(audioData) {
            const bars = audioBars.querySelectorAll('.gemini-audio-bar');
            const step = Math.floor(audioData.length / bars.length);
            
            for (let i = 0; i < bars.length; i++) {
                let sum = 0;
                for (let j = 0; j < step; j++) {
                    const index = i * step + j;
                    if (index < audioData.length) {
                        sum += Math.abs(audioData[index]);
                    }
                }
                const average = sum / step;
                const height = 2 + Math.min(28, Math.floor(average * 100));
                bars[i].style.height = `${height}px`;
            }
        }

        function resetAudioVisualization() {
            const bars = audioBars.querySelectorAll('.gemini-audio-bar');
            bars.forEach(bar => {
                bar.style.height = '2px';
            });
        }

        // ============================================================================
        // WEBSOCKET CONNECTION
        // ============================================================================

        async function connectWebSocket() {
            try {
                loaderModal.classList.add('active');
                widgetLog('Connecting to WebSocket...');

                STATE.isReconnecting = true;
                hideConnectionError();

                if (!CONFIG.assistantId) {
                    widgetLog('Assistant ID not found!', 'error');
                    showMessage('Ошибка: ID ассистента не указан');
                    loaderModal.classList.remove('active');
                    return false;
                }

                const wsUrl = CONFIG.serverUrl.replace(/^http/, 'ws') + '/ws/gemini/' + CONFIG.assistantId;
                widgetLog(`Connecting to: ${wsUrl}`);

                if (STATE.ws) {
                    try {
                        STATE.ws.close();
                    } catch (e) {
                        // ignore
                    }
                }

                if (STATE.pingInterval) {
                    clearInterval(STATE.pingInterval);
                    STATE.pingInterval = null;
                }

                STATE.ws = new WebSocket(wsUrl);

                const connectionTimeout = setTimeout(() => {
                    widgetLog('Connection timeout', 'error');
                    if (STATE.ws) {
                        STATE.ws.close();
                    }
                    STATE.isReconnecting = false;
                    loaderModal.classList.remove('active');
                    
                    STATE.reconnectAttempts++;
                    if (STATE.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                        STATE.connectionFailedPermanently = true;
                        if (STATE.isWidgetOpen) {
                            showConnectionError('Не удалось подключиться к серверу');
                            updateConnectionStatus('disconnected', 'Отключено');
                        }
                    } else {
                        reconnectWithDelay();
                    }
                }, CONNECTION_TIMEOUT);

                STATE.ws.onopen = () => {
                    clearTimeout(connectionTimeout);
                    widgetLog('✅ WebSocket connected');
                    STATE.isConnected = true;
                    STATE.isReconnecting = false;
                    STATE.reconnectAttempts = 0;
                    STATE.connectionFailedPermanently = false;
                    loaderModal.classList.remove('active');

                    // Ping
                    STATE.pingInterval = setInterval(() => {
                        if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                            try {
                                STATE.ws.send(JSON.stringify({ type: 'ping' }));
                            } catch (e) {
                                widgetLog(`Ping error: ${e.message}`, 'error');
                            }
                        }
                    }, PING_INTERVAL);

                    hideConnectionError();

                    // Setup конфигурация для Gemini
                    STATE.ws.send(JSON.stringify({
                        setup: {
                            model: "models/gemini-2.0-flash-exp",
                            generation_config: {
                                response_modalities: ["AUDIO"]
                            }
                        }
                    }));

                    if (STATE.isWidgetOpen) {
                        updateConnectionStatus('connected', 'Подключено (Gemini API)');
                        setTimeout(() => startRecording(), 500);
                    }
                };

                STATE.ws.onmessage = (event) => {
                    try {
                        if (typeof event.data !== 'string') return;

                        const data = JSON.parse(event.data);
                        
                        widgetLog(`Message type: ${data.type || 'unknown'}`);

                        // Обработка разных типов сообщений Gemini
                        if (data.serverContent) {
                            // Аудио от ассистента
                            if (data.serverContent.modelTurn) {
                                const parts = data.serverContent.modelTurn.parts;
                                parts.forEach(part => {
                                    if (part.inlineData && part.inlineData.mimeType === 'audio/pcm') {
                                        playAudioChunk(part.inlineData.data);
                                    }
                                });
                            }

                            // Текст транскрипции
                            if (data.serverContent.turnComplete) {
                                widgetLog('Turn complete');
                                if (STATE.isWidgetOpen && !STATE.isPlaying) {
                                    setTimeout(() => startRecording(), 400);
                                }
                            }
                        }

                        if (data.setupComplete) {
                            widgetLog('Setup complete');
                        }

                    } catch (error) {
                        widgetLog(`Message parse error: ${error.message}`, 'error');
                    }
                };

                STATE.ws.onclose = (event) => {
                    widgetLog(`WebSocket closed: ${event.code}`);
                    STATE.isConnected = false;
                    STATE.isRecording = false;

                    if (STATE.pingInterval) {
                        clearInterval(STATE.pingInterval);
                        STATE.pingInterval = null;
                    }

                    if (event.code === 1000 || event.code === 1001) {
                        STATE.isReconnecting = false;
                        return;
                    }

                    reconnectWithDelay();
                };

                STATE.ws.onerror = (error) => {
                    widgetLog(`WebSocket error: ${error}`, 'error');
                    if (STATE.isWidgetOpen) {
                        showMessage('Ошибка соединения с сервером');
                        updateConnectionStatus('disconnected', 'Ошибка соединения');
                    }
                };

                return true;

            } catch (error) {
                widgetLog(`Connection error: ${error.message}`, 'error');
                STATE.isReconnecting = false;
                loaderModal.classList.remove('active');
                
                STATE.reconnectAttempts++;
                if (STATE.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    STATE.connectionFailedPermanently = true;
                    if (STATE.isWidgetOpen) {
                        showConnectionError('Не удалось подключиться к серверу');
                    }
                } else {
                    reconnectWithDelay();
                }
                
                return false;
            }
        }

        function reconnectWithDelay(initialDelay = 0) {
            if (STATE.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                widgetLog('Max reconnection attempts reached');
                STATE.isReconnecting = false;
                STATE.connectionFailedPermanently = true;
                
                if (STATE.isWidgetOpen) {
                    showConnectionError('Не удалось восстановить соединение');
                    updateConnectionStatus('disconnected', 'Отключено');
                }
                return;
            }

            STATE.isReconnecting = true;

            if (STATE.isWidgetOpen) {
                showMessage('Соединение прервано. Переподключение...', 0);
                updateConnectionStatus('connecting', 'Переподключение...');
            }

            const delay = initialDelay > 0 ? initialDelay : Math.min(30000, Math.pow(2, STATE.reconnectAttempts) * 1000);
            STATE.reconnectAttempts++;

            widgetLog(`Reconnecting in ${delay/1000}s (attempt ${STATE.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

            setTimeout(() => {
                if (STATE.isReconnecting) {
                    connectWebSocket().then(success => {
                        if (success) {
                            STATE.reconnectAttempts = 0;
                            STATE.isReconnecting = false;
                            
                            if (STATE.isWidgetOpen) {
                                showMessage('Соединение восстановлено', 3000);
                                updateConnectionStatus('connected', 'Подключено (Gemini API)');
                                setTimeout(() => {
                                    if (STATE.isWidgetOpen && !STATE.isRecording && !STATE.isPlaying) {
                                        startRecording();
                                    }
                                }, 1000);
                            }
                        } else {
                            STATE.isReconnecting = false;
                        }
                    });
                }
            }, delay);
        }

        // ============================================================================
        // AUDIO PLAYBACK
        // ============================================================================

        async function playAudioChunk(base64Audio) {
            try {
                STATE.isPlaying = true;
                interruptionState.is_assistant_speaking = true;
                mainCircle.classList.add('speaking');
                mainCircle.classList.remove('listening');

                // Decode base64
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // Convert PCM16 to Float32
                const pcm16 = new Int16Array(bytes.buffer);
                const float32 = new Float32Array(pcm16.length);
                for (let i = 0; i < pcm16.length; i++) {
                    float32[i] = pcm16[i] / 32768.0;
                }

                // Resample from 24kHz to 16kHz
                const outputSampleRate = CONFIG.audio.playbackSampleRate;
                const inputSampleRate = CONFIG.audio.outputSampleRate;
                const ratio = inputSampleRate / outputSampleRate;
                const outputLength = Math.floor(float32.length / ratio);
                const resampled = new Float32Array(outputLength);

                for (let i = 0; i < outputLength; i++) {
                    const srcIndex = Math.floor(i * ratio);
                    resampled[i] = float32[srcIndex];
                }

                // Create AudioBuffer
                const audioBuffer = STATE.audioContext.createBuffer(1, resampled.length, outputSampleRate);
                audioBuffer.getChannelData(0).set(resampled);

                // Play
                const source = STATE.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(STATE.audioContext.destination);

                STATE.currentAudioSource = source;

                return new Promise((resolve) => {
                    source.onended = () => {
                        STATE.currentAudioSource = null;
                        STATE.isPlaying = false;
                        interruptionState.is_assistant_speaking = false;
                        mainCircle.classList.remove('speaking');
                        
                        // Автоматически возобновляем прослушивание
                        if (STATE.isWidgetOpen) {
                            setTimeout(() => {
                                startRecording();
                            }, 400);
                        }
                        
                        resolve();
                    };
                    source.start();
                });

            } catch (error) {
                widgetLog(`Playback error: ${error.message}`, 'error');
                STATE.isPlaying = false;
                interruptionState.is_assistant_speaking = false;
            }
        }
    }

    // ============================================================================
    // AUDIO UTILITIES
    // ============================================================================

    function float32ToPCM16(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16;
    }

    function calculateRMS(float32Array) {
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) {
            sum += float32Array[i] * float32Array[i];
        }
        return Math.sqrt(sum / float32Array.length);
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // ============================================================================
    // START APPLICATION
    // ============================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    widgetLog('Gemini Widget script loaded');

})();
