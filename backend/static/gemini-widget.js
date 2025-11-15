/**
 * 🚀 Gemini Voice Widget v2.1 - Production Ready (WAV Audio Fix)
 * Google Gemini Live API Integration with Premium UI
 * 
 * Features:
 * ✅ WebSocket connection to /ws/gemini/{assistant_id}
 * ✅ Real-time audio streaming (24kHz PCM → WAV)
 * ✅ Dynamic screen context (based on assistant config)
 * ✅ Client-side VAD events
 * ✅ NO RESAMPLING - Direct WAV playback for crystal clear audio
 * ✅ Interruption handling with visual feedback
 * ✅ Visual feedback (equalizer + status indicators)
 * ✅ Error handling with Russian messages
 * ✅ Responsive design
 * ✅ Premium Voicyfy branded UI
 * ✅ Fixed protocol for backend proxy
 * 
 * Changelog v2.1:
 * 🔧 FIXED: Removed primitive resampling - now uses WAV format
 * 🔧 FIXED: AudioContext set to 24kHz (matches Gemini output)
 * 🔧 FIXED: Interruption status now shows visual feedback
 * 🔧 IMPROVED: Audio playback through HTML5 Audio element
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

    // Определяем тип устройства
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    // Функция для логирования
    const widgetLog = (message, type = 'info') => {
        if (DEBUG_MODE || type === 'error') {
            const prefix = '[Gemini Widget v2.1]';
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
    // GET CONFIGURATION FROM SCRIPT TAG
    // ============================================================================

    function getServerUrl() {
        const scriptTags = document.querySelectorAll('script');
        for (let i = 0; i < scriptTags.length; i++) {
            if (scriptTags[i].hasAttribute('data-server')) {
                return scriptTags[i].getAttribute('data-server');
            }
            if (scriptTags[i].dataset && scriptTags[i].dataset.server) {
                return scriptTags[i].dataset.server;
            }
        }
        return null;
    }

    function getAssistantId() {
        const scriptTags = document.querySelectorAll('script');
        for (let i = 0; i < scriptTags.length; i++) {
            if (scriptTags[i].hasAttribute('data-assistantId')) {
                return scriptTags[i].getAttribute('data-assistantId');
            }
            if (scriptTags[i].dataset && scriptTags[i].dataset.assistantId) {
                return scriptTags[i].dataset.assistantId;
            }
        }
        return null;
    }

    function getWidgetPosition() {
        const scriptTags = document.querySelectorAll('script');
        for (let i = 0; i < scriptTags.length; i++) {
            if (scriptTags[i].hasAttribute('data-position')) {
                return parsePosition(scriptTags[i].getAttribute('data-position'));
            }
            if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
                return parsePosition(scriptTags[i].dataset.position);
            }
        }
        
        return { vertical: 'bottom', horizontal: 'right', distance: '20px' };

        function parsePosition(positionString) {
            const position = { vertical: 'bottom', horizontal: 'right', distance: '20px' };
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
            return position;
        }
    }

    const SERVER_URL = getServerUrl();
    const ASSISTANT_ID = getAssistantId();
    const WIDGET_POSITION = getWidgetPosition();

    if (!SERVER_URL || !ASSISTANT_ID) {
        widgetLog('Missing configuration: server or assistantId', 'error');
        return;
    }

    const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/gemini/' + ASSISTANT_ID;

    widgetLog(`Configuration: Server: ${SERVER_URL}, Assistant: ${ASSISTANT_ID}`);
    widgetLog(`WebSocket URL: ${WS_URL}`);
    widgetLog(`Device: ${isIOS ? 'iOS' : (isMobile ? 'Mobile' : 'Desktop')}`);

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================

    const STATE = {
        ws: null,
        isConnected: false,
        isRecording: false,
        isPlaying: false,
        isSpeaking: false,
        isUserSpeaking: false,
        audioContext: null,
        mediaStream: null,
        audioWorklet: null,
        audioQueue: [],
        currentAudioElement: null, // Изменено: используем Audio элемент вместо source
        pingInterval: null,
        reconnectAttempts: 0,
        sessionConfig: null,
        isWidgetOpen: false,
        isReconnecting: false,
        connectionFailedPermanently: false
    };

    const interruptionState = {
        is_assistant_speaking: false,
        is_user_speaking: false,
        interruption_count: 0,
        current_audio_elements: []
    };

    // Глобальные флаги для аудио
    window.audioInitialized = false;
    window.globalAudioContext = null;
    window.globalMicStream = null;

    // ============================================================================
    // STYLES - PREMIUM UI FROM WIDGET.JS
    // ============================================================================

    function createStyles() {
        const styleEl = document.createElement('style');
        styleEl.id = 'gemini-widget-styles';
        styleEl.textContent = `
      .gemini-widget-container {
        position: fixed;
        ${WIDGET_POSITION.vertical}: ${WIDGET_POSITION.distance};
        ${WIDGET_POSITION.horizontal}: ${WIDGET_POSITION.distance};
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
        ${WIDGET_POSITION.vertical}: 0;
        ${WIDGET_POSITION.horizontal}: 0;
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
        cursor: pointer;
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
        animation: gemini-interrupt-pulse 0.5s ease-in-out 3;
      }
      
      @keyframes gemini-interrupt-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.3); opacity: 0.7; }
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
    // LOAD FONT AWESOME
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
    // CREATE HTML - PREMIUM UI FROM WIDGET.JS
    // ============================================================================

    function createWidgetHTML() {
        const container = document.createElement('div');
        container.className = 'gemini-widget-container';
        container.id = 'gemini-widget-container';

        container.innerHTML = `
      <!-- Премиальная кнопка -->
      <div class="gemini-widget-button" id="gemini-widget-button">
        <div class="gemini-button-inner">
          <div class="gemini-pulse-ring"></div>
          
          <!-- Эквалайзер на кнопке -->
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
    }

    // ============================================================================
    // INITIALIZATION & AUDIO
    // ============================================================================

    async function initializeAudio() {
        widgetLog(`Initializing audio for ${isIOS ? 'iOS' : (isMobile ? 'Mobile' : 'Desktop')}`);
        
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Browser doesn't support microphone access");
            }

            if (!window.globalAudioContext) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                // ✅ ИСПРАВЛЕНО: 24kHz для соответствия Gemini API
                window.globalAudioContext = new AudioContextClass({
                    sampleRate: 24000,
                    latencyHint: 'interactive'
                });
                widgetLog(`AudioContext created: ${window.globalAudioContext.sampleRate} Hz`);
            }

            if (window.globalAudioContext.state === 'suspended') {
                await window.globalAudioContext.resume();
                widgetLog('AudioContext resumed');
            }

            if (!window.globalMicStream) {
                window.globalMicStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 24000,
                        channelCount: 1
                    }
                });
                widgetLog('Microphone access granted');
            }

            window.audioInitialized = true;
            widgetLog('Audio initialization complete');
            return true;

        } catch (error) {
            widgetLog(`Audio initialization error: ${error.message}`, 'error');
            return false;
        }
    }

    // ============================================================================
    // WAV AUDIO FUNCTIONS (NEW - FIXED AUDIO PLAYBACK)
    // ============================================================================

    /**
     * ✅ НОВАЯ ФУНКЦИЯ: Создание WAV файла из PCM данных
     * Заменяет примитивный ресемплинг - теперь звук чистый!
     */
    function createWavFromPcm(pcmBuffer, sampleRate = 24000) {
        const wavHeader = new ArrayBuffer(44);
        const view = new DataView(wavHeader);
        
        // "RIFF" chunk descriptor
        view.setUint8(0, 'R'.charCodeAt(0));
        view.setUint8(1, 'I'.charCodeAt(0));
        view.setUint8(2, 'F'.charCodeAt(0));
        view.setUint8(3, 'F'.charCodeAt(0));
        
        view.setUint32(4, 36 + pcmBuffer.byteLength, true);
        
        // "WAVE" format
        view.setUint8(8, 'W'.charCodeAt(0));
        view.setUint8(9, 'A'.charCodeAt(0));
        view.setUint8(10, 'V'.charCodeAt(0));
        view.setUint8(11, 'E'.charCodeAt(0));
        
        // "fmt " subchunk
        view.setUint8(12, 'f'.charCodeAt(0));
        view.setUint8(13, 'm'.charCodeAt(0));
        view.setUint8(14, 't'.charCodeAt(0));
        view.setUint8(15, ' '.charCodeAt(0));
        
        view.setUint32(16, 16, true); // Subchunk size
        view.setUint16(20, 1, true);  // Audio format (PCM)
        view.setUint16(22, 1, true);  // Number of channels (Mono)
        view.setUint32(24, sampleRate, true); // Sample rate
        view.setUint32(28, sampleRate * 2, true); // Byte rate
        view.setUint16(32, 2, true);  // Block align
        view.setUint16(34, 16, true); // Bits per sample
        
        // "data" subchunk
        view.setUint8(36, 'd'.charCodeAt(0));
        view.setUint8(37, 'a'.charCodeAt(0));
        view.setUint8(38, 't'.charCodeAt(0));
        view.setUint8(39, 'a'.charCodeAt(0));
        
        view.setUint32(40, pcmBuffer.byteLength, true);
        
        // Combine header and data
        const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
        const wavBytes = new Uint8Array(wavBuffer);
        
        wavBytes.set(new Uint8Array(wavHeader), 0);
        wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
        
        return wavBuffer;
    }

    // ============================================================================
    // MAIN WIDGET LOGIC
    // ============================================================================

    function initWidget() {
        // UI элементы
        const widgetContainer = document.getElementById('gemini-widget-container');
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
        function createAudioBars(count = 20) {
            audioBars.innerHTML = '';
            for (let i = 0; i < count; i++) {
                const bar = document.createElement('div');
                bar.className = 'gemini-audio-bar';
                audioBars.appendChild(bar);
            }
        }
        createAudioBars();

        // UI helper functions
        function showMessage(message, duration = 5000) {
            messageDisplay.textContent = message;
            messageDisplay.classList.add('show');
            if (duration > 0) {
                setTimeout(() => messageDisplay.classList.remove('show'), duration);
            }
        }

        function hideMessage() {
            messageDisplay.classList.remove('show');
        }

        function showConnectionError(message) {
            if (connectionError) {
                connectionError.innerHTML = `
                    ${message || 'Ошибка соединения с сервером'}
                    <button class="gemini-retry-button" onclick="document.getElementById('gemini-retry-button').click()">
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
            
            if (status === 'connected') statusDot.classList.add('connected');
            else if (status === 'disconnected') statusDot.classList.add('disconnected');
            else if (status === 'interrupted') statusDot.classList.add('interrupted');
            else statusDot.classList.add('connecting');
            
            statusIndicator.classList.add('show');
            setTimeout(() => statusIndicator.classList.remove('show'), 3000);
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
            widgetContainer.classList.add('active');
            STATE.isWidgetOpen = true;

            if (!window.audioInitialized) {
                const success = await initializeAudio();
                if (!success) {
                    showMessage('Ошибка доступа к микрофону');
                    return;
                }
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
            widgetContainer.classList.remove('active');
            STATE.isWidgetOpen = false;
            hideMessage();
            hideConnectionError();
            if (statusIndicator) statusIndicator.classList.remove('show');
        }

        // Audio utilities
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
            bars.forEach(bar => bar.style.height = '2px');
        }

        // Recording
        async function startRecording() {
            if (!STATE.isConnected || STATE.isPlaying || STATE.isReconnecting || STATE.isRecording) {
                widgetLog(`Cannot start recording`);
                return;
            }

            try {
                widgetLog('Starting recording...');

                if (!window.globalAudioContext || !window.globalMicStream) {
                    const success = await initializeAudio();
                    if (!success) {
                        showMessage('Ошибка доступа к микрофону');
                        return;
                    }
                }

                if (window.globalAudioContext.state === 'suspended') {
                    await window.globalAudioContext.resume();
                }

                STATE.isRecording = true;
                STATE.isUserSpeaking = false;

                const source = window.globalAudioContext.createMediaStreamSource(window.globalMicStream);
                const processor = window.globalAudioContext.createScriptProcessor(4096, 1, 1);

                let silenceStartTime = 0;

                processor.onaudioprocess = (e) => {
                    if (STATE.isRecording && STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                        const inputData = e.inputBuffer.getChannelData(0);
                        
                        updateAudioVisualization(inputData);

                        const rms = calculateRMS(inputData);
                        const db = 20 * Math.log10(rms);
                        
                        if (db > -40) {
                            if (!STATE.isUserSpeaking) {
                                STATE.isUserSpeaking = true;
                                interruptionState.is_user_speaking = true;
                                widgetLog('🗣️ User started speaking');
                                sendMessage({ type: 'speech.user_started' });
                                
                                if (STATE.isPlaying) {
                                    stopPlayback();
                                }
                            }
                            silenceStartTime = 0;
                            
                            if (!mainCircle.classList.contains('listening')) {
                                mainCircle.classList.add('listening');
                                mainCircle.classList.remove('speaking');
                            }
                        } else if (STATE.isUserSpeaking) {
                            if (silenceStartTime === 0) {
                                silenceStartTime = Date.now();
                            } else if (Date.now() - silenceStartTime > 500) {
                                STATE.isUserSpeaking = false;
                                interruptionState.is_user_speaking = false;
                                widgetLog('🤐 User stopped speaking');
                                sendMessage({ type: 'speech.user_stopped' });
                                silenceStartTime = 0;
                            }
                        }

                        const pcm16 = float32ToPCM16(inputData);
                        const base64Audio = arrayBufferToBase64(pcm16.buffer);

                        sendMessage({
                            type: 'input_audio_buffer.append',
                            audio: base64Audio
                        });
                    }
                };

                source.connect(processor);
                processor.connect(window.globalAudioContext.destination);

                STATE.audioWorklet = { source, processor };

                mainCircle.classList.add('listening');
                mainCircle.classList.remove('speaking');

                widgetLog('✅ Recording started');

            } catch (error) {
                widgetLog(`Recording error: ${error.message}`, 'error');
                showMessage('Ошибка доступа к микрофону');
            }
        }

        function stopRecording() {
            if (!STATE.isRecording) return;
            
            widgetLog('Stopping recording');
            STATE.isRecording = false;
            STATE.isUserSpeaking = false;
            
            if (window.globalMicStream) {
                window.globalMicStream.getTracks().forEach(track => track.stop());
                window.globalMicStream = null;
            }
            
            if (STATE.audioWorklet) {
                STATE.audioWorklet.source.disconnect();
                STATE.audioWorklet.processor.disconnect();
                STATE.audioWorklet = null;
            }

            sendMessage({ type: 'input_audio_buffer.commit' });
            
            mainCircle.classList.remove('listening');
            resetAudioVisualization();
            
            widgetLog('✅ Recording stopped');
        }

        // ✅ НОВАЯ ФУНКЦИЯ: Playback через WAV (вместо примитивного ресемплинга)
        async function playAudioQueue() {
            if (STATE.isPlaying || STATE.audioQueue.length === 0) return;
            
            STATE.isPlaying = true;
            interruptionState.is_assistant_speaking = true;
            
            mainCircle.classList.add('speaking');
            mainCircle.classList.remove('listening');
            
            while (STATE.audioQueue.length > 0) {
                const base64Audio = STATE.audioQueue.shift();
                await playAudioChunk(base64Audio);
                if (!STATE.isPlaying) break;
            }
            
            STATE.isPlaying = false;
            interruptionState.is_assistant_speaking = false;
            mainCircle.classList.remove('speaking');
        }

        /**
         * ✅ ИСПРАВЛЕННАЯ ФУНКЦИЯ: Воспроизведение через WAV
         * Теперь звук кристально чистый без хрипа!
         */
        async function playAudioChunk(base64Audio) {
            try {
                // Декодируем base64 в ArrayBuffer
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // ✅ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: Создаем WAV файл вместо ручного ресемплинга
                const wavBuffer = createWavFromPcm(bytes.buffer, 24000); // Gemini возвращает 24kHz
                const blob = new Blob([wavBuffer], { type: 'audio/wav' });
                const audioUrl = URL.createObjectURL(blob);
                
                // Используем HTML5 Audio element
                const audio = new Audio();
                
                // Настройки для iOS совместимости
                audio.playsInline = true;
                audio.muted = false;
                audio.volume = 1.0;
                audio.preload = 'auto';
                audio.src = audioUrl;
                
                STATE.currentAudioElement = audio;
                interruptionState.current_audio_elements.push(audio);

                return new Promise((resolve, reject) => {
                    audio.onended = () => {
                        URL.revokeObjectURL(audioUrl);
                        STATE.currentAudioElement = null;
                        const index = interruptionState.current_audio_elements.indexOf(audio);
                        if (index > -1) {
                            interruptionState.current_audio_elements.splice(index, 1);
                        }
                        resolve();
                    };
                    
                    audio.onerror = (e) => {
                        widgetLog(`Audio playback error: ${e}`, 'error');
                        URL.revokeObjectURL(audioUrl);
                        STATE.currentAudioElement = null;
                        const index = interruptionState.current_audio_elements.indexOf(audio);
                        if (index > -1) {
                            interruptionState.current_audio_elements.splice(index, 1);
                        }
                        reject(e);
                    };
                    
                    // Запускаем воспроизведение
                    audio.play().catch(error => {
                        widgetLog(`Play failed: ${error.message}`, 'error');
                        URL.revokeObjectURL(audioUrl);
                        reject(error);
                    });
                });

            } catch (error) {
                widgetLog(`Playback error: ${error.message}`, 'error');
            }
        }

        function stopPlayback() {
            widgetLog('Stopping playback');
            
            // Останавливаем текущий аудио элемент
            if (STATE.currentAudioElement) {
                try {
                    STATE.currentAudioElement.pause();
                    STATE.currentAudioElement.currentTime = 0;
                    if (STATE.currentAudioElement.src && STATE.currentAudioElement.src.startsWith('blob:')) {
                        URL.revokeObjectURL(STATE.currentAudioElement.src);
                    }
                } catch (e) {
                    widgetLog(`Error stopping audio: ${e.message}`, 'warn');
                }
                STATE.currentAudioElement = null;
            }
            
            // Останавливаем все аудио элементы в очереди перебивания
            if (interruptionState.current_audio_elements) {
                interruptionState.current_audio_elements.forEach(audio => {
                    try {
                        audio.pause();
                        audio.currentTime = 0;
                        if (audio.src && audio.src.startsWith('blob:')) {
                            URL.revokeObjectURL(audio.src);
                        }
                    } catch (e) {
                        widgetLog(`Error stopping audio element: ${e.message}`, 'warn');
                    }
                });
                interruptionState.current_audio_elements = [];
            }
            
            STATE.audioQueue = [];
            STATE.isPlaying = false;
            interruptionState.is_assistant_speaking = false;
        }

        // WebSocket
        async function connectWebSocket() {
            try {
                loaderModal.classList.add('active');
                widgetLog('Connecting to WebSocket...');

                STATE.isReconnecting = true;
                hideConnectionError();

                if (STATE.ws) {
                    try { STATE.ws.close(); } catch (e) {}
                }

                if (STATE.pingInterval) {
                    clearInterval(STATE.pingInterval);
                    STATE.pingInterval = null;
                }

                STATE.ws = new WebSocket(WS_URL);

                const connectionTimeout = setTimeout(() => {
                    widgetLog('Connection timeout', 'error');
                    if (STATE.ws) STATE.ws.close();
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

                    STATE.pingInterval = setInterval(() => {
                        if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                            try {
                                sendMessage({ type: 'ping' });
                            } catch (e) {
                                widgetLog(`Ping error: ${e.message}`, 'error');
                            }
                        }
                    }, PING_INTERVAL);

                    hideConnectionError();

                    if (STATE.isWidgetOpen) {
                        updateConnectionStatus('connected', 'Подключено (Gemini API)');
                        setTimeout(() => startRecording(), 500);
                    }
                };

                STATE.ws.onmessage = (event) => {
                    try {
                        if (typeof event.data !== 'string') return;
                        const data = JSON.parse(event.data);
                        
                        widgetLog(`📩 Message type: ${data.type || 'unknown'}`);

                        switch(data.type) {
                            case 'connection_status':
                                widgetLog('✅ Connection status received');
                                STATE.sessionConfig = {
                                    model: data.model,
                                    functions_enabled: data.functions_enabled,
                                    google_sheets: data.google_sheets,
                                    thinking_enabled: data.thinking_enabled,
                                    client_id: data.client_id
                                };
                                widgetLog(`Session config: ${JSON.stringify(STATE.sessionConfig)}`);
                                break;

                            case 'gemini.setup.complete':
                                widgetLog('✅ Gemini setup complete');
                                break;
                                
                            case 'response.audio.delta':
                                if (data.delta) {
                                    STATE.audioQueue.push(data.delta);
                                    if (!STATE.isPlaying) {
                                        playAudioQueue();
                                    }
                                }
                                break;
                                
                            case 'assistant.speech.started':
                                widgetLog('🔊 Assistant started speaking');
                                STATE.isSpeaking = true;
                                interruptionState.is_assistant_speaking = true;
                                mainCircle.classList.add('speaking');
                                mainCircle.classList.remove('listening');
                                updateConnectionStatus('connected', 'Ассистент говорит');
                                break;
                                
                            case 'assistant.speech.ended':
                                widgetLog('🔇 Assistant stopped speaking');
                                STATE.isSpeaking = false;
                                interruptionState.is_assistant_speaking = false;
                                mainCircle.classList.remove('speaking');
                                
                                if (STATE.isWidgetOpen && !STATE.isRecording && !STATE.isPlaying) {
                                    setTimeout(() => startRecording(), 400);
                                }
                                updateConnectionStatus('connected', 'Готов к разговору');
                                break;

                            case 'conversation.interrupted':
                                widgetLog('⚡ Conversation interrupted');
                                stopPlayback();
                                STATE.isSpeaking = false;
                                interruptionState.is_assistant_speaking = false;
                                interruptionState.interruption_count++;
                                
                                mainCircle.classList.remove('speaking');
                                mainCircle.classList.add('interrupted');
                                
                                // ✅ ИСПРАВЛЕНО: Добавлен визуальный статус при перебивании
                                updateConnectionStatus('interrupted', `Перебивание #${interruptionState.interruption_count}`);
                                
                                setTimeout(() => {
                                    mainCircle.classList.remove('interrupted');
                                    if (!interruptionState.is_assistant_speaking) {
                                        mainCircle.classList.add('listening');
                                    }
                                    updateConnectionStatus('connected', 'Готов к разговору');
                                }, 1000);
                                break;
                                
                            case 'error':
                                widgetLog(`❌ Server error: ${data.error?.message || 'Unknown error'}`, 'error');
                                handleServerError(data);
                                break;

                            case 'pong':
                                break;

                            case 'input_audio_buffer.append.ack':
                                break;

                            case 'response.text.delta':
                                if (data.text) {
                                    widgetLog(`Text: ${data.text}`);
                                }
                                break;
                                
                            default:
                                widgetLog(`Unhandled message type: ${data.type}`, 'warn');
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

        function reconnectWithDelay() {
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

            const delay = Math.min(30000, Math.pow(2, STATE.reconnectAttempts) * 1000);
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

        function sendMessage(message) {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                try {
                    STATE.ws.send(JSON.stringify(message));
                } catch (error) {
                    widgetLog(`Send error: ${error.message}`, 'error');
                }
            }
        }

        function handleServerError(data) {
            const error = data.error || {};
            let title = 'Ошибка';
            let message = error.message || 'Произошла ошибка';
            
            switch (error.code) {
                case 'TRIAL_EXPIRED':
                    title = 'Пробный период истек';
                    message = 'Пожалуйста, оформите подписку для продолжения работы';
                    break;
                case 'SUBSCRIPTION_EXPIRED':
                    title = 'Подписка истекла';
                    message = 'Пожалуйста, продлите подписку для продолжения работы';
                    break;
                case 'assistant_not_found':
                    title = 'Ассистент не найден';
                    message = 'Проверьте правильность ID ассистента';
                    break;
                case 'gemini_connection_failed':
                    title = 'Ошибка Gemini';
                    message = 'Не удалось подключиться к Gemini API';
                    break;
                case 'no_api_key':
                    title = 'Нет API ключа';
                    message = 'Gemini API ключ не настроен';
                    break;
            }
            
            showMessage(`${title}: ${message}`, 10000);
            
            if (error.requires_payment) {
                if (STATE.ws) {
                    STATE.ws.close();
                }
            }
        }

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

        // Initial connection
        connectWebSocket();
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function initialize() {
        widgetLog('Initializing Gemini Widget v2.1 (WAV Audio Fix)...');
        
        loadFontAwesome();
        createStyles();
        createWidgetHTML();
        
        document.addEventListener('click', initializeAudio, { once: true });
        document.addEventListener('touchstart', initializeAudio, { once: true });
        
        initWidget();
        
        widgetLog('✅ Gemini Widget v2.1 initialized - Crystal clear audio with WAV playback!');
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    widgetLog('Gemini Widget v2.1 script loaded');

})();
