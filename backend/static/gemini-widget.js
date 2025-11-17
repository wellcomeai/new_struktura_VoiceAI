/**
 * 🚀 Gemini Voice Widget v2.4 - Production Ready (AUDIO FIX)
 * Google Gemini Live API Integration
 * 
 * ✅ NEW: Automatic audio resampling (24kHz -> browser native rate)
 * ✅ NEW: Real sample rate detection and logging
 * ✅ FIXED: Audio distortion/crackling from sample rate mismatch
 * ✅ One-click activation - auto-start recording when widget opens
 * ✅ Close = disconnect - clean shutdown on close
 * ✅ Setup timing - wait for Gemini to be ready before processing audio
 * ✅ Native 24kHz playback with fallback resampling
 * ✅ Automatic audio buffer commit on silence detection
 * ✅ Premium visual design with improved layout
 * ✅ WebSocket connection to /ws/gemini/{assistant_id}
 * ✅ Real-time audio streaming (16kHz PCM input, 24kHz PCM output)
 * ✅ Client-side VAD with auto-commit
 * ✅ Interruption handling
 * ✅ Error handling with Russian messages
 * ✅ Responsive design
 * ✅ Voicyfy branding
 * 
 * @version 2.4.0
 * @author WellcomeAI Team
 * @license MIT
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
        
        // Аудио параметры
        audio: {
            inputSampleRate: 16000,
            outputSampleRate: 24000,        // Частота от Gemini API
            playbackSampleRate: 24000,      // Желаемая частота (будет скорректирована)
            actualSampleRate: null,         // ✅ NEW: Реальная частота AudioContext
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,
            maxBufferSize: 96000,
            needsResampling: false          // ✅ NEW: Флаг необходимости ресемплинга
        },
        
        // VAD
        vad: {
            enabled: true,
            silenceThreshold: -45,
            silenceDuration: 1500,
            speechThreshold: -38
        },
        
        // WebSocket
        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        },
        
        // Setup timing
        setup: {
            waitAfterSetup: 800,
            maxSetupWait: 10000
        },
        
        // UI
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
        isSetupComplete: false,
        readyToRecord: false,
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
        audioBufferCommitted: false,
        setupTimeout: null,
        isWidgetOpen: false,
        audioChunksProcessed: 0  // ✅ NEW: Счетчик для статистики
    };

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        console.log('[GEMINI-WIDGET] 🚀 Initializing v2.4 (AUDIO FIX)...');
        
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
            console.error('[GEMINI-WIDGET] Missing required parameters');
            return;
        }

        console.log('[GEMINI-WIDGET] Config:', {
            assistantId: CONFIG.assistantId,
            server: CONFIG.serverUrl,
            position: CONFIG.position
        });

        createWidget();
        
        document.addEventListener('click', initAudioContext, { once: true });
        document.addEventListener('touchstart', initAudioContext, { once: true });
    }

    function initAudioContext() {
        if (STATE.audioContext) return;
        
        console.log('[GEMINI-WIDGET] 🎧 Creating AudioContext...');
        console.log('[GEMINI-WIDGET] 📊 Requested sample rate:', CONFIG.audio.playbackSampleRate, 'Hz');
        
        STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.audio.playbackSampleRate
        });
        
        // ✅ ПРОВЕРЯЕМ РЕАЛЬНУЮ ЧАСТОТУ
        const actualRate = STATE.audioContext.sampleRate;
        CONFIG.audio.actualSampleRate = actualRate;
        
        console.log('[GEMINI-WIDGET] 📊 Actual sample rate:', actualRate, 'Hz');
        
        // ✅ ОПРЕДЕЛЯЕМ НЕОБХОДИМОСТЬ РЕСЕМПЛИНГА
        if (actualRate !== CONFIG.audio.outputSampleRate) {
            CONFIG.audio.needsResampling = true;
            console.warn('[GEMINI-WIDGET] ⚠️ Sample rate mismatch detected!');
            console.warn('[GEMINI-WIDGET] 🔄 Resampling enabled:', CONFIG.audio.outputSampleRate, 'Hz →', actualRate, 'Hz');
        } else {
            CONFIG.audio.needsResampling = false;
            console.log('[GEMINI-WIDGET] ✅ Sample rates match - no resampling needed');
        }
        
        console.log('[GEMINI-WIDGET] ✅ AudioContext initialized');
        console.log('[GEMINI-WIDGET] 📊 Audio Config:', {
            input: CONFIG.audio.inputSampleRate + ' Hz',
            geminiOutput: CONFIG.audio.outputSampleRate + ' Hz',
            browserActual: actualRate + ' Hz',
            needsResampling: CONFIG.audio.needsResampling
        });
    }

    // ============================================================================
    // UI CREATION - IMPROVED DESIGN
    // ============================================================================

    function createWidget() {
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
                    box-shadow: 0 10px 30px rgba(74, 134, 232, 0.4);
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

                /* Button Inner */
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
                    0% { transform: scale(0.5); opacity: 0; }
                    25% { opacity: 0.4; }
                    100% { transform: scale(1.2); opacity: 0; }
                }

                /* Mini Equalizer */
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

                /* Expanded Widget - IMPROVED */
                .gemini-widget-expanded {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
                    width: 360px;
                    height: 0;
                    opacity: 0;
                    pointer-events: none;
                    background: rgba(255, 255, 255, 0.98);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    border-radius: 24px;
                    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.06);
                    overflow: hidden;
                    transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    display: flex;
                    flex-direction: column;
                }

                .gemini-widget-container.active .gemini-widget-expanded {
                    height: 500px;
                    opacity: 1;
                    pointer-events: all;
                }

                .gemini-widget-container.active .gemini-main-button {
                    transform: scale(0.9);
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                }

                /* Widget Header - IMPROVED */
                .gemini-widget-header {
                    padding: 20px 24px;
                    background: linear-gradient(135deg, #1e3a8a, #3b82f6);
                    color: white;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-radius: 24px 24px 0 0;
                }

                .gemini-widget-title {
                    font-weight: 600;
                    font-size: 18px;
                    letter-spacing: 0.3px;
                }

                .gemini-widget-close {
                    background: rgba(255, 255, 255, 0.2);
                    border: none;
                    color: white;
                    font-size: 20px;
                    cursor: pointer;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }

                .gemini-widget-close:hover {
                    background: rgba(255, 255, 255, 0.3);
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
                    padding: 30px 20px 20px;
                }

                /* Main Circle */
                .gemini-main-circle {
                    width: 200px;
                    height: 200px;
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
                    0% { transform: scale(0.95); opacity: 0.7; }
                    50% { transform: scale(1.05); opacity: 0.3; }
                    100% { transform: scale(0.95); opacity: 0.7; }
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
                    0% { transform: scale(0.8); opacity: 0; }
                    50% { opacity: 0.5; }
                    100% { transform: scale(1.2); opacity: 0; }
                }

                .gemini-mic-icon {
                    color: #3b82f6;
                    font-size: 36px;
                    z-index: 10;
                    transition: color 0.3s ease;
                }

                .gemini-main-circle.listening .gemini-mic-icon {
                    color: #2563eb;
                }

                .gemini-main-circle.speaking .gemini-mic-icon {
                    color: #059669;
                }

                /* Audio Visualization */
                .gemini-audio-visualization {
                    position: absolute;
                    width: 100%;
                    max-width: 180px;
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

                /* Message Display - IMPROVED */
                .gemini-message-display {
                    position: absolute;
                    width: 90%;
                    bottom: 80px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: white;
                    padding: 14px 18px;
                    border-radius: 14px;
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.08);
                    text-align: center;
                    font-size: 15px;
                    line-height: 1.5;
                    opacity: 0;
                    transition: all 0.3s;
                    max-height: 120px;
                    overflow-y: auto;
                    z-index: 10;
                }

                .gemini-message-display.show {
                    opacity: 1;
                }

                /* Status Info - IMPROVED */
                .gemini-status-info {
                    position: absolute;
                    bottom: 60px;
                    left: 50%;
                    transform: translateX(-50%);
                    font-size: 12px;
                    color: #64748b;
                    padding: 6px 12px;
                    border-radius: 12px;
                    background-color: rgba(255, 255, 255, 0.9);
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    opacity: 0;
                    transition: opacity 0.3s;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
                }

                .gemini-status-info.show {
                    opacity: 1;
                }

                .gemini-status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background-color: #10b981;
                }

                .gemini-status-dot.disconnected {
                    background-color: #ef4444;
                }

                .gemini-status-dot.connecting {
                    background-color: #f59e0b;
                }

                /* Voicyfy Branding - IMPROVED */
                .gemini-voicyfy-container {
                    position: absolute;
                    bottom: 16px;
                    left: 50%;
                    transform: translateX(-50%);
                    text-align: center;
                    padding: 8px;
                    opacity: 0.7;
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
                    height: 28px;
                    width: auto;
                    display: block;
                }

                /* Error Message */
                .gemini-error-message {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
                    background: white;
                    padding: 14px 18px;
                    border-radius: 12px;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    max-width: 300px;
                    display: none;
                    animation: slideUp 0.3s ease-out;
                }

                .gemini-error-message.show {
                    display: block;
                }

                @keyframes slideUp {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .gemini-error-title {
                    color: #ef4444;
                    font-weight: 600;
                    font-size: 15px;
                    margin-bottom: 6px;
                }

                .gemini-error-text {
                    color: #64748B;
                    font-size: 13px;
                    line-height: 1.5;
                }

                /* Loading Spinner */
                .gemini-loader-modal {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(255, 255, 255, 0.9);
                    backdrop-filter: blur(5px);
                    -webkit-backdrop-filter: blur(5px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 100;
                    opacity: 0;
                    visibility: hidden;
                    transition: all 0.3s;
                    border-radius: 24px;
                }

                .gemini-loader-modal.active {
                    opacity: 1;
                    visibility: visible;
                }

                .gemini-loader {
                    width: 44px;
                    height: 44px;
                    border: 4px solid rgba(59, 130, 246, 0.2);
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
                        max-width: 360px;
                    }

                    .gemini-widget-container.active .gemini-widget-expanded {
                        height: 480px;
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
                    
                    <div class="gemini-audio-bars-mini">
                        <div class="gemini-audio-bar-mini"></div>
                        <div class="gemini-audio-bar-mini"></div>
                        <div class="gemini-audio-bar-mini"></div>
                        <div class="gemini-audio-bar-mini"></div>
                    </div>
                </div>

                <div class="gemini-status-indicator" id="gemini-status"></div>
            </button>

            <!-- Expanded Widget -->
            <div class="gemini-widget-expanded" id="gemini-expanded">
                <div class="gemini-widget-header">
                    <div class="gemini-widget-title">Gemini Ассистент</div>
                    <button class="gemini-widget-close" id="gemini-close" title="Закрыть">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <div class="gemini-widget-content">
                    <div class="gemini-main-circle" id="gemini-circle">
                        <i class="fas fa-microphone gemini-mic-icon"></i>
                        
                        <div class="gemini-audio-visualization">
                            <div class="gemini-audio-bars" id="gemini-bars"></div>
                        </div>
                    </div>

                    <div class="gemini-message-display" id="gemini-message"></div>

                    <div class="gemini-status-info" id="gemini-status-info">
                        <div class="gemini-status-dot" id="gemini-status-dot"></div>
                        <span id="gemini-status-text">Подключение...</span>
                    </div>

                    <div class="gemini-voicyfy-container">
                        <a href="https://voicyfy.ru/" target="_blank" rel="noopener noreferrer" class="gemini-voicyfy-link">
                            <img src="https://i.ibb.co/ccw6sjdk/photo-2025-06-03-05-04-02.jpg" alt="Powered by Voicyfy">
                        </a>
                    </div>
                </div>

                <div class="gemini-loader-modal" id="gemini-loader">
                    <div class="gemini-loader"></div>
                </div>
            </div>

            <div class="gemini-error-message" id="gemini-error">
                <div class="gemini-error-title">Ошибка</div>
                <div class="gemini-error-text" id="gemini-error-text"></div>
            </div>
        `;

        document.body.appendChild(container);

        if (!document.getElementById('font-awesome-gemini')) {
            const link = document.createElement('link');
            link.id = 'font-awesome-gemini';
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(link);
        }

        const button = document.getElementById('gemini-btn');
        const closeBtn = document.getElementById('gemini-close');
        
        button.addEventListener('click', handleButtonClick);
        closeBtn.addEventListener('click', handleClose);
        
        console.log('[GEMINI-WIDGET] ✅ UI created');
    }

    // ============================================================================
    // UI UPDATES
    // ============================================================================

    function updateUI(state) {
        const button = document.getElementById('gemini-btn');
        const circle = document.getElementById('gemini-circle');
        const status = document.getElementById('gemini-status');
        
        button.classList.remove('recording', 'playing');
        circle.classList.remove('listening', 'speaking', 'interrupted');
        status.classList.remove('connected', 'error');

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
        } else if (state === 'error') {
            status.classList.add('error');
            updateStatusInfo('error', 'Ошибка');
        } else if (state === 'waiting_setup') {
            status.classList.add('connecting');
            updateStatusInfo('connecting', 'Подготовка...');
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
    // BUTTON HANDLERS - AUTO-START LOGIC
    // ============================================================================

    async function handleButtonClick() {
        console.log('[GEMINI-WIDGET] Button clicked');
        
        if (!STATE.audioContext) {
            initAudioContext();
        }

        const container = document.querySelector('.gemini-widget-container');
        const isOpen = container.classList.contains('active');

        if (!isOpen) {
            container.classList.add('active');
            STATE.isWidgetOpen = true;
            
            if (!STATE.isConnected) {
                await connectWebSocket();
            }
        }
    }

    async function handleClose() {
        console.log('[GEMINI-WIDGET] ✅ Close - disconnecting...');
        
        const container = document.querySelector('.gemini-widget-container');
        container.classList.remove('active');
        STATE.isWidgetOpen = false;
        
        if (STATE.isRecording) {
            await stopRecording();
        }
        
        stopPlayback();
        
        if (STATE.ws) {
            try {
                STATE.ws.close();
                console.log('[GEMINI-WIDGET] WebSocket closed');
            } catch (e) {
                console.error('[GEMINI-WIDGET] Error closing WebSocket:', e);
            }
        }
        
        STATE.isConnected = false;
        STATE.isSetupComplete = false;
        STATE.readyToRecord = false;
        STATE.isSpeaking = false;
        STATE.audioBufferCommitted = false;
        STATE.audioChunksProcessed = 0;
        
        if (STATE.pingInterval) {
            clearInterval(STATE.pingInterval);
            STATE.pingInterval = null;
        }
        
        if (STATE.setupTimeout) {
            clearTimeout(STATE.setupTimeout);
            STATE.setupTimeout = null;
        }
        
        hideMessage();
        hideError();
        
        console.log('[GEMINI-WIDGET] ✅ Clean shutdown complete');
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
        
        STATE.pingInterval = setInterval(() => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                sendMessage({ type: 'ping' });
            }
        }, CONFIG.ws.pingInterval);

        createAudioBars(20);
        
        STATE.setupTimeout = setTimeout(() => {
            if (!STATE.isSetupComplete) {
                console.error('[GEMINI-WIDGET] ⚠️ Setup timeout - forcing ready');
                STATE.isSetupComplete = true;
                STATE.readyToRecord = true;
                
                if (STATE.isWidgetOpen && !STATE.isRecording) {
                    startRecording();
                }
            }
        }, CONFIG.setup.maxSetupWait);
    }

    function handleWSMessage(event) {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type !== 'input_audio_buffer.append.ack') {
                console.log('[GEMINI-WIDGET] Message:', data.type);
            }
            
            switch (data.type) {
                case 'connection_status':
                    handleConnectionStatus(data);
                    break;
                
                case 'gemini.setup.complete':
                    handleSetupComplete();
                    break;
                
                case 'input_audio_buffer.append.ack':
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
                    break;
                
                default:
                    console.log('[GEMINI-WIDGET] Unhandled:', data.type);
            }
        } catch (error) {
            console.error('[GEMINI-WIDGET] Parse error:', error);
        }
    }

    function handleWSError(error) {
        console.error('[GEMINI-WIDGET] WebSocket error:', error);
        showError('Ошибка соединения', 'Потеряно соединение с сервером');
        updateUI('error');
    }

    function handleWSClose(event) {
        console.log('[GEMINI-WIDGET] WebSocket closed:', event.code);
        STATE.isConnected = false;
        STATE.isSetupComplete = false;
        STATE.readyToRecord = false;
        
        if (STATE.pingInterval) {
            clearInterval(STATE.pingInterval);
            STATE.pingInterval = null;
        }
        
        if (STATE.setupTimeout) {
            clearTimeout(STATE.setupTimeout);
            STATE.setupTimeout = null;
        }
        
        if (STATE.isRecording) {
            stopRecording();
        }
        
        if (STATE.isPlaying) {
            stopPlayback();
        }
        
        if (!STATE.isWidgetOpen) {
            console.log('[GEMINI-WIDGET] Widget closed - no reconnect');
            return;
        }
        
        if (STATE.reconnectAttempts < CONFIG.ws.maxReconnectAttempts) {
            STATE.reconnectAttempts++;
            console.log(`[GEMINI-WIDGET] Reconnecting... Attempt ${STATE.reconnectAttempts}`);
            setTimeout(connectWebSocket, CONFIG.ws.reconnectDelay);
        } else {
            showError('Соединение потеряно', 'Превышено количество попыток');
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

    function handleSetupComplete() {
        console.log('[GEMINI-WIDGET] ✅ Gemini setup complete');
        
        if (STATE.setupTimeout) {
            clearTimeout(STATE.setupTimeout);
            STATE.setupTimeout = null;
        }
        
        STATE.isSetupComplete = true;
        
        console.log(`[GEMINI-WIDGET] ⏳ Waiting ${CONFIG.setup.waitAfterSetup}ms...`);
        updateUI('waiting_setup');
        
        setTimeout(() => {
            STATE.readyToRecord = true;
            console.log('[GEMINI-WIDGET] ✅ Ready!');
            updateUI('connected');
            
            if (STATE.isWidgetOpen && !STATE.isRecording) {
                console.log('[GEMINI-WIDGET] 🎙️ AUTO-START recording...');
                startRecording();
            }
        }, CONFIG.setup.waitAfterSetup);
    }

    function handleAudioDelta(data) {
        if (!data.delta) return;
        
        STATE.audioQueue.push(data.delta);
        
        if (!STATE.isPlaying) {
            playAudioQueue();
        }
    }

    function handleAssistantSpeechStarted() {
        console.log('[GEMINI-WIDGET] 🔊 Assistant speaking');
        STATE.isSpeaking = true;
        updateUI('playing');
    }

    function handleAssistantSpeechEnded() {
        console.log('[GEMINI-WIDGET] 🔇 Assistant stopped');
        STATE.isSpeaking = false;
        STATE.audioBufferCommitted = false;
        
        if (!STATE.isRecording) {
            updateUI('connected');
        }
        
        // ✅ ЛОГИРУЕМ СТАТИСТИКУ
        console.log('[GEMINI-WIDGET] 📊 Audio chunks processed:', STATE.audioChunksProcessed);
        STATE.audioChunksProcessed = 0;
    }

    function handleInterruption() {
        console.log('[GEMINI-WIDGET] ⚡ Interrupted');
        stopPlayback();
        STATE.isSpeaking = false;
        STATE.audioBufferCommitted = false;
        
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
        console.error('[GEMINI-WIDGET] Error:', data.error);
        
        const error = data.error;
        let title = 'Ошибка';
        let message = error.message || 'Произошла ошибка';
        
        switch (error.code) {
            case 'TRIAL_EXPIRED':
                title = 'Пробный период истек';
                message = 'Оформите подписку для продолжения';
                break;
            case 'SUBSCRIPTION_EXPIRED':
                title = 'Подписка истекла';
                message = 'Продлите подписку для продолжения';
                break;
            case 'assistant_not_found':
                title = 'Ассистент не найден';
                message = 'Проверьте ID ассистента';
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
        
        if (error.requires_payment && STATE.ws) {
            STATE.ws.close();
        }
    }

    // ============================================================================
    // AUDIO RECORDING
    // ============================================================================

    async function startRecording() {
        if (STATE.isRecording) return;
        
        if (!STATE.isSetupComplete || !STATE.readyToRecord) {
            console.log('[GEMINI-WIDGET] ⚠️ Not ready');
            return;
        }
        
        console.log('[GEMINI-WIDGET] Starting recording...');
        
        try {
            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: CONFIG.audio.inputSampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            console.log('[GEMINI-WIDGET] Microphone granted');
            
            const source = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
            const processor = STATE.audioContext.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
                if (!STATE.isRecording) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = float32ToPCM16(inputData);
                
                updateAudioVisualization(inputData);
                
                const rms = calculateRMS(inputData);
                const db = 20 * Math.log10(rms);
                
                if (db > CONFIG.vad.speechThreshold) {
                    if (!STATE.isSpeaking) {
                        console.log('[GEMINI-WIDGET] 🗣️ User speaking');
                        sendMessage({ type: 'speech.user_started' });
                        STATE.isSpeaking = true;
                        STATE.audioBufferCommitted = false;
                    }
                    STATE.lastSpeechTime = Date.now();
                } else if (STATE.isSpeaking && 
                          STATE.lastSpeechTime > 0 && 
                          Date.now() - STATE.lastSpeechTime > CONFIG.vad.silenceDuration &&
                          !STATE.audioBufferCommitted) {
                    console.log('[GEMINI-WIDGET] 🤐 User stopped');
                    sendMessage({ type: 'speech.user_stopped' });
                    
                    console.log('[GEMINI-WIDGET] 💾 Committing audio');
                    sendMessage({ type: 'input_audio_buffer.commit' });
                    
                    STATE.isSpeaking = false;
                    STATE.lastSpeechTime = 0;
                    STATE.audioBufferCommitted = true;
                }
                
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
            STATE.audioBufferCommitted = false;
            
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
        
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(track => track.stop());
            STATE.mediaStream = null;
        }
        
        if (STATE.audioWorklet) {
            STATE.audioWorklet.source.disconnect();
            STATE.audioWorklet.processor.disconnect();
            STATE.audioWorklet = null;
        }
        
        if (!STATE.audioBufferCommitted) {
            console.log('[GEMINI-WIDGET] 💾 Final commit');
            sendMessage({ type: 'input_audio_buffer.commit' });
            STATE.audioBufferCommitted = true;
        }
        
        resetAudioVisualization();
        
        if (STATE.isSpeaking) {
            updateUI('playing');
        } else {
            updateUI('connected');
        }
        
        console.log('[GEMINI-WIDGET] ✅ Recording stopped');
    }

    // ============================================================================
    // AUDIO PLAYBACK - WITH RESAMPLING
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
            // ✅ 1. Декодируем Base64 → ArrayBuffer
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            // ✅ 2. Int16Array → Float32Array (PCM16 → Float)
            const pcm16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) {
                float32[i] = pcm16[i] / 32768.0;
            }
            
            console.log(`[GEMINI-WIDGET] 🎵 Chunk #${++STATE.audioChunksProcessed}: ${float32.length} samples @ ${CONFIG.audio.outputSampleRate}Hz`);
            
            // ✅ 3. РЕСЕМПЛИНГ ЕСЛИ НУЖНО
            let audioData = float32;
            let targetSampleRate = CONFIG.audio.outputSampleRate;
            
            if (CONFIG.audio.needsResampling) {
                const resampled = resampleAudio(
                    float32,
                    CONFIG.audio.outputSampleRate,
                    CONFIG.audio.actualSampleRate
                );
                audioData = resampled;
                targetSampleRate = CONFIG.audio.actualSampleRate;
                
                console.log(`[GEMINI-WIDGET] 🔄 Resampled: ${float32.length} → ${resampled.length} samples`);
            }
            
            // ✅ 4. Создаем AudioBuffer
            const audioBuffer = STATE.audioContext.createBuffer(
                1,
                audioData.length,
                targetSampleRate
            );
            audioBuffer.getChannelData(0).set(audioData);
            
            // ✅ 5. Воспроизводим
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
            console.error('[GEMINI-WIDGET] ❌ Playback error:', error);
            console.error('[GEMINI-WIDGET] Error details:', {
                message: error.message,
                stack: error.stack,
                audioQueueLength: STATE.audioQueue.length,
                needsResampling: CONFIG.audio.needsResampling
            });
        }
    }

    function stopPlayback() {
        if (STATE.currentAudioSource) {
            try {
                STATE.currentAudioSource.stop();
                STATE.currentAudioSource = null;
            } catch (e) {}
        }
        
        STATE.audioQueue = [];
        STATE.isPlaying = false;
    }

    // ============================================================================
    // AUDIO RESAMPLING - LINEAR INTERPOLATION
    // ============================================================================

    /**
     * Ресемплинг аудио с использованием линейной интерполяции
     * @param {Float32Array} inputBuffer - Входной аудиобуфер
     * @param {number} inputSampleRate - Исходная частота дискретизации
     * @param {number} outputSampleRate - Целевая частота дискретизации
     * @returns {Float32Array} - Пересемплированный буфер
     */
    function resampleAudio(inputBuffer, inputSampleRate, outputSampleRate) {
        if (inputSampleRate === outputSampleRate) {
            return inputBuffer;
        }
        
        const ratio = inputSampleRate / outputSampleRate;
        const outputLength = Math.round(inputBuffer.length / ratio);
        const outputBuffer = new Float32Array(outputLength);
        
        console.log(`[GEMINI-WIDGET] 🔄 Resampling: ${inputSampleRate}Hz → ${outputSampleRate}Hz (ratio: ${ratio.toFixed(3)})`);
        console.log(`[GEMINI-WIDGET] 📏 Length: ${inputBuffer.length} → ${outputLength} samples`);
        
        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, inputBuffer.length - 1);
            const t = srcIndex - srcIndexFloor;
            
            // Линейная интерполяция
            outputBuffer[i] = inputBuffer[srcIndexFloor] * (1 - t) + inputBuffer[srcIndexCeil] * t;
        }
        
        return outputBuffer;
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
    // START
    // ============================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('[GEMINI-WIDGET] 🚀 Script loaded v2.4 (AUDIO FIX)');

})();
