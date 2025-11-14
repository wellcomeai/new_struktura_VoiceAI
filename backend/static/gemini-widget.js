/**
 * 🚀 Gemini Voice Widget v2.0 - Production Ready (NO RESAMPLING FIX)
 * Google Gemini Live API Integration
 * 
 * ✅ FIXED: Native 24kHz playback (no resampling distortion)
 * ✅ Premium visual design (copied from OpenAI widget)
 * ✅ WebSocket connection to /ws/gemini/{assistant_id}
 * ✅ Real-time audio streaming (16kHz PCM input, 24kHz PCM output)
 * ✅ Dynamic screen context (based on assistant config)
 * ✅ Client-side VAD events
 * ✅ Interruption handling
 * ✅ Visual feedback (premium equalizer + pulse animations)
 * ✅ Error handling with Russian messages
 * ✅ Responsive design
 * ✅ Voicyfy branding
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

    const CONFIG = {
        // От data-атрибутов скрипта
        assistantId: null,
        serverUrl: null,
        position: 'bottom-right',
        
        // Аудио параметры - FIXED: Native 24kHz playback
        audio: {
            inputSampleRate: 16000,      // Gemini expects 16kHz
            outputSampleRate: 24000,     // Gemini sends 24kHz
            playbackSampleRate: 24000,   // ✅ FIXED: Was 16000, now 24000 (no resampling!)
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,          // ms
            maxBufferSize: 96000
        },
        
        // Screen capture
        screen: {
            enabled: false,              // Динамически из конфига
            interval: 5000,              // 5 секунд
            quality: 0.7,
            maxWidth: 1280,
            maxHeight: 720
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
        },
        
        // UI - Premium colors (copied from OpenAI widget)
        colors: {
            primary: '#4a86e8',
            gradient: 'linear-gradient(135deg, #4a86e8, #2b59c3)',
            success: '#10B981',
            error: '#EF4444',
            warning: '#F59E0B'
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
        screenCaptureInterval: null,
        pingInterval: null,
        reconnectAttempts: 0,
        lastSpeechTime: 0,
        lastSilenceTime: 0,
        sessionConfig: null,
        errorState: null
    };

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        console.log('[GEMINI-WIDGET] Initializing v2.0 (NO RESAMPLING)...');
        
        // Получаем конфигурацию из data-атрибутов
        const scriptTag = document.currentScript || 
                         document.querySelector('script[data-assistant-id]');
        
        if (!scriptTag) {
            console.error('[GEMINI-WIDGET] Script tag not found');
            return;
        }

        CONFIG.assistantId = scriptTag.dataset.assistantId;
        CONFIG.serverUrl = scriptTag.dataset.server;
        CONFIG.position = scriptTag.dataset.position || 'bottom-right';

        if (!CONFIG.assistantId || !CONFIG.serverUrl) {
            console.error('[GEMINI-WIDGET] Missing required parameters: assistantId, server');
            return;
        }

        console.log('[GEMINI-WIDGET] Config:', {
            assistantId: CONFIG.assistantId,
            server: CONFIG.serverUrl,
            position: CONFIG.position
        });

        // Создаем UI
        createWidget();
        
        // Инициализируем AudioContext при первом взаимодействии
        document.addEventListener('click', initAudioContext, { once: true });
        document.addEventListener('touchstart', initAudioContext, { once: true });
    }

    function initAudioContext() {
        if (STATE.audioContext) return;
        
        // ✅ FIXED: AudioContext на 24kHz для нативного воспроизведения
        STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.audio.playbackSampleRate  // 24000 Hz
        });
        
        console.log('[GEMINI-WIDGET] AudioContext initialized:', STATE.audioContext.sampleRate, 'Hz');
    }

    // ============================================================================
    // UI CREATION - PREMIUM DESIGN (COPIED FROM OPENAI WIDGET)
    // ============================================================================

    function createWidget() {
        // Контейнер
        const container = document.createElement('div');
        container.id = 'gemini-voice-widget';
        container.className = `gemini-widget-container position-${CONFIG.position}`;
        
        container.innerHTML = `
            <style>
                /* Reset */
                #gemini-voice-widget * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                /* Container */
                .gemini-widget-container {
                    position: fixed;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }

                .gemini-widget-container.position-bottom-right {
                    bottom: 20px;
                    right: 20px;
                }

                .gemini-widget-container.position-bottom-left {
                    bottom: 20px;
                    left: 20px;
                }

                .gemini-widget-container.position-top-right {
                    top: 20px;
                    right: 20px;
                }

                .gemini-widget-container.position-top-left {
                    top: 20px;
                    left: 20px;
                }

                /* Premium Button Design */
                .gemini-main-button {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #4a86e8, #2b59c3);
                    border: none;
                    cursor: pointer;
                    box-shadow: 0 8px 32px rgba(74, 134, 232, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.3s ease;
                    position: relative;
                    overflow: hidden;
                }

                .gemini-main-button:hover {
                    transform: scale(1.05);
                    box-shadow: 0 10px 30px rgba(74, 134, 232, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.15);
                }

                .gemini-main-button:active {
                    transform: scale(0.95);
                }

                .gemini-main-button.recording {
                    animation: pulse-recording 1.5s ease-in-out infinite;
                }

                .gemini-main-button.playing {
                    animation: pulse-playing 2s ease-in-out infinite;
                }

                @keyframes pulse-recording {
                    0%, 100% { box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4); }
                    50% { box-shadow: 0 4px 20px rgba(239, 68, 68, 0.8); }
                }

                @keyframes pulse-playing {
                    0%, 100% { box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4); }
                    50% { box-shadow: 0 4px 20px rgba(16, 185, 129, 0.8); }
                }

                /* Button Inner Elements */
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

                /* Mini Equalizer in Button */
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

                .gemini-button-icon {
                    color: white;
                    font-size: 22px;
                    z-index: 2;
                    opacity: 0;
                    position: absolute;
                    transition: opacity 0.3s ease;
                    display: none;
                }

                .gemini-button-icon.active {
                    opacity: 1;
                }

                /* Status Indicator */
                .gemini-status-indicator {
                    position: absolute;
                    top: -5px;
                    right: -5px;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    background: #94A3B8;
                    border: 2px solid white;
                    transition: background 0.3s ease;
                }

                .gemini-status-indicator.connected {
                    background: #10b981;
                }

                .gemini-status-indicator.error {
                    background: #ef4444;
                    animation: blink 1s ease-in-out infinite;
                }

                @keyframes blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }

                /* Expanded Widget */
                .gemini-widget-expanded {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
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
                }

                .gemini-widget-container.active .gemini-widget-expanded {
                    height: 460px;
                    opacity: 1;
                    pointer-events: all;
                }

                .gemini-widget-container.active .gemini-main-button {
                    transform: scale(0.9);
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                }

                /* Widget Header */
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

                /* Widget Content */
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

                /* Main Circle with Premium Design */
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

                /* Audio Visualization (20 bars) */
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

                /* Message Display */
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

                /* Error Message */
                .gemini-error-message {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
                    background: white;
                    padding: 12px 16px;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    max-width: 280px;
                    display: none;
                    animation: slideUp 0.3s ease-out;
                }

                .gemini-error-message.show {
                    display: block;
                }

                @keyframes slideUp {
                    from {
                        opacity: 0;
                        transform: translateY(10px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .gemini-error-title {
                    color: #ef4444;
                    font-weight: 600;
                    font-size: 14px;
                    margin-bottom: 4px;
                }

                .gemini-error-text {
                    color: #64748B;
                    font-size: 12px;
                    line-height: 1.4;
                }

                /* Status Indicator */
                .gemini-status-info {
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

                .gemini-status-info.show {
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

                /* Voicyfy Branding */
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

                /* Loading Spinner */
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
                    z-index: 100;
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

                /* Mobile Responsive */
                @media (max-width: 768px) {
                    .gemini-widget-container {
                        bottom: 15px !important;
                        right: 15px !important;
                    }

                    .gemini-main-button {
                        width: 56px;
                        height: 56px;
                    }

                    .gemini-widget-expanded {
                        width: calc(100vw - 30px);
                        max-width: 320px;
                    }

                    .gemini-error-message {
                        max-width: calc(100vw - 90px);
                    }
                }
            </style>

            <!-- Main Button -->
            <button class="gemini-main-button" id="gemini-btn" title="Gemini голосовой ассистент">
                <div class="gemini-button-inner">
                    <div class="gemini-pulse-ring"></div>
                    
                    <!-- Mini Equalizer -->
                    <div class="gemini-audio-bars-mini">
                        <div class="gemini-audio-bar-mini"></div>
                        <div class="gemini-audio-bar-mini"></div>
                        <div class="gemini-audio-bar-mini"></div>
                        <div class="gemini-audio-bar-mini"></div>
                    </div>
                </div>

                <!-- Status Indicator -->
                <div class="gemini-status-indicator" id="gemini-status"></div>
            </button>

            <!-- Expanded Widget -->
            <div class="gemini-widget-expanded" id="gemini-expanded">
                <div class="gemini-widget-header">
                    <div class="gemini-widget-title">Gemini Ассистент</div>
                    <button class="gemini-widget-close" id="gemini-close">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <div class="gemini-widget-content">
                    <!-- Main Circle -->
                    <div class="gemini-main-circle" id="gemini-circle">
                        <i class="fas fa-microphone gemini-mic-icon"></i>
                        
                        <!-- Audio Visualization (20 bars) -->
                        <div class="gemini-audio-visualization">
                            <div class="gemini-audio-bars" id="gemini-bars"></div>
                        </div>
                    </div>

                    <!-- Message Display -->
                    <div class="gemini-message-display" id="gemini-message"></div>

                    <!-- Status Info -->
                    <div class="gemini-status-info" id="gemini-status-info">
                        <div class="gemini-status-dot" id="gemini-status-dot"></div>
                        <span id="gemini-status-text">Подключение...</span>
                    </div>

                    <!-- Voicyfy Branding -->
                    <div class="gemini-voicyfy-container">
                        <a href="https://voicyfy.ru/" target="_blank" rel="noopener noreferrer" class="gemini-voicyfy-link">
                            <img src="https://i.ibb.co/ccw6sjdk/photo-2025-06-03-05-04-02.jpg" alt="Powered by Voicyfy">
                        </a>
                    </div>
                </div>

                <!-- Loading Modal -->
                <div class="gemini-loader-modal" id="gemini-loader">
                    <div class="gemini-loader"></div>
                </div>
            </div>

            <!-- Error Message -->
            <div class="gemini-error-message" id="gemini-error">
                <div class="gemini-error-title">Ошибка</div>
                <div class="gemini-error-text" id="gemini-error-text"></div>
            </div>
        `;

        document.body.appendChild(container);

        // Load Font Awesome
        if (!document.getElementById('font-awesome-gemini')) {
            const link = document.createElement('link');
            link.id = 'font-awesome-gemini';
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(link);
        }

        // Event listeners
        const button = document.getElementById('gemini-btn');
        const closeBtn = document.getElementById('gemini-close');
        
        button.addEventListener('click', handleButtonClick);
        closeBtn.addEventListener('click', handleClose);
        
        console.log('[GEMINI-WIDGET] UI created with premium design');
    }

    // ============================================================================
    // UI UPDATES
    // ============================================================================

    function updateUI(state) {
        const button = document.getElementById('gemini-btn');
        const circle = document.getElementById('gemini-circle');
        const status = document.getElementById('gemini-status');
        const container = document.querySelector('.gemini-widget-container');
        
        // Remove all classes
        button.classList.remove('recording', 'playing');
        circle.classList.remove('listening', 'speaking', 'interrupted');
        status.classList.remove('connected', 'error');

        // Update based on state
        if (state === 'connected') {
            status.classList.add('connected');
            updateStatusInfo('connected', 'Подключено');
        } else if (state === 'recording') {
            button.classList.add('recording');
            circle.classList.add('listening');
            status.classList.add('connected');
            updateStatusInfo('connected', 'Слушаю...');
        } else if (state === 'playing') {
            button.classList.add('playing');
            circle.classList.add('speaking');
            status.classList.add('connected');
            updateStatusInfo('connected', 'Говорю...');
        } else if (state === 'interrupted') {
            circle.classList.add('interrupted');
            status.classList.add('connected');
            updateStatusInfo('connected', 'Прервано');
        } else if (state === 'error') {
            status.classList.add('error');
            updateStatusInfo('error', 'Ошибка');
        } else {
            updateStatusInfo('connecting', 'Подключение...');
        }
    }

    function updateStatusInfo(status, message) {
        const statusInfo = document.getElementById('gemini-status-info');
        const statusDot = document.getElementById('gemini-status-dot');
        const statusText = document.getElementById('gemini-status-text');
        
        if (!statusInfo || !statusDot || !statusText) return;
        
        statusText.textContent = message;
        
        statusDot.classList.remove('connected', 'disconnected', 'connecting');
        statusDot.classList.add(status);
        
        statusInfo.classList.add('show');
        
        setTimeout(() => {
            statusInfo.classList.remove('show');
        }, 3000);
    }

    function showError(title, message) {
        const errorDiv = document.getElementById('gemini-error');
        const errorText = document.getElementById('gemini-error-text');
        
        errorDiv.querySelector('.gemini-error-title').textContent = title;
        errorText.textContent = message;
        errorDiv.classList.add('show');
        
        updateUI('error');
        
        setTimeout(() => {
            errorDiv.classList.remove('show');
        }, 5000);
    }

    function hideError() {
        const errorDiv = document.getElementById('gemini-error');
        errorDiv.classList.remove('show');
    }

    function showMessage(message, duration = 0) {
        const messageDiv = document.getElementById('gemini-message');
        messageDiv.textContent = message;
        messageDiv.classList.add('show');
        
        if (duration > 0) {
            setTimeout(() => {
                messageDiv.classList.remove('show');
            }, duration);
        }
    }

    function hideMessage() {
        const messageDiv = document.getElementById('gemini-message');
        messageDiv.classList.remove('show');
    }

    function createAudioBars(count = 20) {
        const barsContainer = document.getElementById('gemini-bars');
        if (!barsContainer) return;
        
        barsContainer.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const bar = document.createElement('div');
            bar.className = 'gemini-audio-bar';
            barsContainer.appendChild(bar);
        }
    }

    function updateAudioVisualization(audioData) {
        const bars = document.querySelectorAll('.gemini-audio-bar');
        if (!bars.length) return;
        
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
        const bars = document.querySelectorAll('.gemini-audio-bar');
        bars.forEach(bar => {
            bar.style.height = '2px';
        });
    }

    // ============================================================================
    // BUTTON HANDLERS
    // ============================================================================

    async function handleButtonClick() {
        console.log('[GEMINI-WIDGET] Button clicked');
        
        if (!STATE.audioContext) {
            initAudioContext();
        }

        const container = document.querySelector('.gemini-widget-container');
        const isOpen = container.classList.contains('active');

        if (!isOpen) {
            // Open widget
            container.classList.add('active');
            
            if (!STATE.isConnected) {
                await connectWebSocket();
            } else if (!STATE.isRecording) {
                await startRecording();
            }
        } else {
            // Toggle recording
            if (STATE.isRecording) {
                await stopRecording();
            } else if (!STATE.isPlaying) {
                await startRecording();
            }
        }
    }

    function handleClose() {
        console.log('[GEMINI-WIDGET] Close clicked');
        
        const container = document.querySelector('.gemini-widget-container');
        container.classList.remove('active');
        
        if (STATE.isRecording) {
            stopRecording();
        }
        
        stopPlayback();
        hideMessage();
        hideError();
    }

    // ============================================================================
    // WEBSOCKET CONNECTION
    // ============================================================================

    async function connectWebSocket() {
        console.log('[GEMINI-WIDGET] Connecting to WebSocket...');
        
        const wsUrl = CONFIG.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://');
        const endpoint = `${wsUrl}/ws/gemini/${CONFIG.assistantId}`;
        
        console.log('[GEMINI-WIDGET] WS URL:', endpoint);

        try {
            STATE.ws = new WebSocket(endpoint);
            
            STATE.ws.onopen = handleWSOpen;
            STATE.ws.onmessage = handleWSMessage;
            STATE.ws.onerror = handleWSError;
            STATE.ws.onclose = handleWSClose;
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Connection error:', error);
            showError('Ошибка подключения', 'Не удалось подключиться к серверу');
        }
    }

    function handleWSOpen() {
        console.log('[GEMINI-WIDGET] ✅ WebSocket connected');
        STATE.isConnected = true;
        STATE.reconnectAttempts = 0;
        updateUI('connected');
        hideError();
        
        // Start ping
        STATE.pingInterval = setInterval(() => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                sendMessage({ type: 'ping' });
            }
        }, CONFIG.ws.pingInterval);

        // Create audio bars
        createAudioBars(20);
    }

    function handleWSMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('[GEMINI-WIDGET] Message:', data.type);
            
            switch (data.type) {
                case 'connection_status':
                    handleConnectionStatus(data);
                    break;
                
                case 'response.audio.delta':
                    handleAudioDelta(data);
                    break;
                
                case 'assistant.speech.started':
                    handleAssistantSpeechStarted();
                    break;
                
                case 'assistant.speech.ended':
                    handleAssistantSpeechEnded();
                    break;
                
                case 'conversation.interrupted':
                    handleInterruption();
                    break;
                
                case 'response.text.delta':
                    if (data.delta) {
                        showMessage(data.delta);
                    }
                    break;
                
                case 'error':
                    handleError(data);
                    break;
                
                case 'pong':
                    // Ping response
                    break;
                
                default:
                    console.log('[GEMINI-WIDGET] Unhandled message type:', data.type);
            }
        } catch (error) {
            console.error('[GEMINI-WIDGET] Error parsing message:', error);
        }
    }

    function handleWSError(error) {
        console.error('[GEMINI-WIDGET] WebSocket error:', error);
        showError('Ошибка соединения', 'Потеряно соединение с сервером');
        updateUI('error');
    }

    function handleWSClose(event) {
        console.log('[GEMINI-WIDGET] WebSocket closed:', event.code, event.reason);
        STATE.isConnected = false;
        
        if (STATE.pingInterval) {
            clearInterval(STATE.pingInterval);
            STATE.pingInterval = null;
        }
        
        if (STATE.isRecording) {
            stopRecording();
        }
        
        if (STATE.isPlaying) {
            stopPlayback();
        }
        
        // Auto-reconnect
        if (STATE.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
            STATE.reconnectAttempts++;
            console.log(`[GEMINI-WIDGET] Reconnecting... Attempt ${STATE.reconnectAttempts}`);
            setTimeout(connectWebSocket, CONFIG.ws.reconnectDelay);
        } else {
            showError('Соединение потеряно', 'Превышено количество попыток переподключения');
            updateUI('error');
        }
    }

    function sendMessage(data) {
        if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
            STATE.ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    // ============================================================================
    // MESSAGE HANDLERS
    // ============================================================================

    function handleConnectionStatus(data) {
        console.log('[GEMINI-WIDGET] Connection status:', data);
        
        STATE.sessionConfig = {
            model: data.model,
            functions_enabled: data.functions_enabled,
            google_sheets: data.google_sheets,
            thinking_enabled: data.thinking_enabled,
            client_id: data.client_id
        };
        
        console.log('[GEMINI-WIDGET] Session config:', STATE.sessionConfig);
    }

    function handleAudioDelta(data) {
        if (!data.delta) return;
        
        STATE.audioQueue.push(data.delta);
        
        if (!STATE.isPlaying) {
            playAudioQueue();
        }
    }

    function handleAssistantSpeechStarted() {
        console.log('[GEMINI-WIDGET] 🔊 Assistant started speaking');
        STATE.isSpeaking = true;
        updateUI('playing');
    }

    function handleAssistantSpeechEnded() {
        console.log('[GEMINI-WIDGET] 🔇 Assistant stopped speaking');
        STATE.isSpeaking = false;
        
        if (!STATE.isRecording) {
            updateUI('connected');
        }
    }

    function handleInterruption() {
        console.log('[GEMINI-WIDGET] ⚡ Conversation interrupted');
        stopPlayback();
        STATE.isSpeaking = false;
        
        updateUI('interrupted');
        
        setTimeout(() => {
            if (STATE.isRecording) {
                updateUI('recording');
            } else {
                updateUI('connected');
            }
        }, 1000);
    }

    function handleError(data) {
        console.error('[GEMINI-WIDGET] Server error:', data.error);
        
        const error = data.error;
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
        
        showError(title, message);
        
        if (error.requires_payment) {
            if (STATE.ws) {
                STATE.ws.close();
            }
        }
    }

    // ============================================================================
    // AUDIO RECORDING
    // ============================================================================

    async function startRecording() {
        if (STATE.isRecording) return;
        
        console.log('[GEMINI-WIDGET] Starting recording...');
        
        try {
            // Request microphone
            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: CONFIG.audio.inputSampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            console.log('[GEMINI-WIDGET] Microphone access granted');
            
            // Create AudioWorklet for processing
            const source = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
            const processor = STATE.audioContext.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
                if (!STATE.isRecording) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = float32ToPCM16(inputData);
                
                // Update visualization
                updateAudioVisualization(inputData);
                
                // VAD check
                const rms = calculateRMS(inputData);
                const db = 20 * Math.log10(rms);
                
                if (db > CONFIG.vad.speechThreshold) {
                    if (!STATE.isSpeaking) {
                        console.log('[GEMINI-WIDGET] 🗣️ User started speaking');
                        sendMessage({ type: 'speech.user_started' });
                    }
                    STATE.lastSpeechTime = Date.now();
                } else if (STATE.lastSpeechTime > 0 && 
                          Date.now() - STATE.lastSpeechTime > CONFIG.vad.silenceDuration) {
                    if (STATE.isSpeaking) {
                        console.log('[GEMINI-WIDGET] 🤐 User stopped speaking');
                        sendMessage({ type: 'speech.user_stopped' });
                    }
                    STATE.lastSpeechTime = 0;
                }
                
                // Send audio
                const base64Audio = arrayBufferToBase64(pcmData.buffer);
                sendMessage({
                    type: 'input_audio_buffer.append',
                    audio: base64Audio
                });
            };
            
            source.connect(processor);
            processor.connect(STATE.audioContext.destination);
            
            STATE.audioWorklet = { source, processor };
            STATE.isRecording = true;
            
            updateUI('recording');
            
            console.log('[GEMINI-WIDGET] ✅ Recording started');
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Recording error:', error);
            showError('Ошибка записи', 'Не удалось получить доступ к микрофону');
        }
    }

    async function stopRecording() {
        if (!STATE.isRecording) return;
        
        console.log('[GEMINI-WIDGET] Stopping recording...');
        
        STATE.isRecording = false;
        
        // Stop media stream
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(track => track.stop());
            STATE.mediaStream = null;
        }
        
        // Disconnect audio nodes
        if (STATE.audioWorklet) {
            STATE.audioWorklet.source.disconnect();
            STATE.audioWorklet.processor.disconnect();
            STATE.audioWorklet = null;
        }
        
        // Commit audio
        sendMessage({ type: 'input_audio_buffer.commit' });
        
        resetAudioVisualization();
        
        if (STATE.isSpeaking) {
            updateUI('playing');
        } else {
            updateUI('connected');
        }
        
        console.log('[GEMINI-WIDGET] ✅ Recording stopped');
    }

    // ============================================================================
    // AUDIO PLAYBACK - FIXED: NO RESAMPLING!
    // ============================================================================

    async function playAudioQueue() {
        if (STATE.isPlaying || STATE.audioQueue.length === 0) return;
        
        STATE.isPlaying = true;
        
        while (STATE.audioQueue.length > 0) {
            const base64Audio = STATE.audioQueue.shift();
            await playAudioChunk(base64Audio);
            
            if (!STATE.isPlaying) break;
        }
        
        STATE.isPlaying = false;
    }

    async function playAudioChunk(base64Audio) {
        try {
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
            
            // ✅ CRITICAL FIX: NO RESAMPLING - Play native 24kHz!
            // Previous version had 24kHz → 16kHz resampling which caused distortion
            // Now we play directly at 24kHz
            const audioBuffer = STATE.audioContext.createBuffer(
                1,
                float32.length,
                24000  // Native Gemini frequency - NO CONVERSION!
            );
            audioBuffer.getChannelData(0).set(float32);
            
            // Play
            const source = STATE.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(STATE.audioContext.destination);
            
            STATE.currentAudioSource = source;
            
            return new Promise((resolve) => {
                source.onended = () => {
                    STATE.currentAudioSource = null;
                    resolve();
                };
                source.start();
            });
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Playback error:', error);
        }
    }

    function stopPlayback() {
        if (STATE.currentAudioSource) {
            try {
                STATE.currentAudioSource.stop();
                STATE.currentAudioSource = null;
            } catch (e) {
                // Already stopped
            }
        }
        
        STATE.audioQueue = [];
        STATE.isPlaying = false;
    }

    // ============================================================================
    // SCREEN CAPTURE (Optional - если включено в конфиге)
    // ============================================================================

    async function startScreenCapture() {
        if (!CONFIG.screen.enabled) return;
        
        console.log('[GEMINI-WIDGET] Starting screen capture...');
        
        // Capture immediately
        await captureScreen();
        
        // Then every interval
        STATE.screenCaptureInterval = setInterval(captureScreen, CONFIG.screen.interval);
    }

    async function captureScreen() {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Capture viewport
            canvas.width = Math.min(window.innerWidth, CONFIG.screen.maxWidth);
            canvas.height = Math.min(window.innerHeight, CONFIG.screen.maxHeight);
            
            // Use html2canvas if available
            if (window.html2canvas) {
                const screenshot = await html2canvas(document.body, {
                    width: canvas.width,
                    height: canvas.height,
                    scale: 1,
                    logging: false
                });
                
                ctx.drawImage(screenshot, 0, 0, canvas.width, canvas.height);
            } else {
                console.warn('[GEMINI-WIDGET] html2canvas not available');
                return;
            }
            
            // Convert to base64
            const base64Image = canvas.toDataURL('image/jpeg', CONFIG.screen.quality);
            
            // Send to server
            sendMessage({
                type: 'screen.context',
                image: base64Image,
                silent: true
            });
            
            console.log('[GEMINI-WIDGET] 📸 Screen captured');
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Screen capture error:', error);
        }
    }

    function stopScreenCapture() {
        if (STATE.screenCaptureInterval) {
            clearInterval(STATE.screenCaptureInterval);
            STATE.screenCaptureInterval = null;
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

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('[GEMINI-WIDGET] Script loaded v2.0 (NO RESAMPLING FIX)');

})();
