/**
 * 🚀 Gemini Voice Widget v3.0 - PRODUCTION READY
 * Google Gemini Live API Integration
 * 
 * ✅ Auto-start recording after setup.complete
 * ✅ Proper interruption handling with separate user/assistant flags
 * ✅ iOS-compatible audio playback
 * ✅ Global AudioContext + MediaStream (initialized once)
 * ✅ Auto-return to recording after response
 * ✅ Yellow interrupted animation
 * ✅ Clean state management
 * 
 * @version 3.0.0
 * @author WellcomeAI Team
 * @license MIT
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
            inputSampleRate: 16000,      // Gemini expects 16kHz
            outputSampleRate: 24000,     // Gemini sends 24kHz
            playbackSampleRate: 24000,   // Keep as is (no resample)
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,          // ms
            maxBufferSize: 96000
        },
        
        // VAD
        vad: {
            enabled: true,
            silenceThreshold: -45,       // dB
            silenceDuration: 900,        // ms - optimized
            speechThreshold: -38,        // dB
            minSpeechDuration: 200       // ms - ignore clicks
        },
        
        // WebSocket
        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        },
        
        // UI
        colors: {
            primary: '#4a86e8',
            gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            success: '#10B981',
            error: '#EF4444',
            warning: '#F59E0B',
            interrupted: '#d97706'  // Yellow for interruption
        }
    };

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================

    const STATE = {
        ws: null,
        isConnected: false,
        isGeminiReady: false,           // ✅ NEW: Ready flag after setup.complete
        isRecording: false,
        isPlaying: false,
        audioContext: null,              // ✅ Global AudioContext
        mediaStream: null,               // ✅ Global MediaStream
        audioWorklet: null,
        audioQueue: [],
        audioChunksBuffer: [],
        currentAudioSource: null,
        pingInterval: null,
        reconnectAttempts: 0,
        lastSpeechTime: 0,
        speechStartTime: 0,
        errorState: null
    };

    // ✅ NEW: Interruption state with separate flags
    const INTERRUPTION_STATE = {
        is_assistant_speaking: false,
        is_user_speaking: false,
        interruption_count: 0,
        last_interruption_time: 0,
        current_audio_elements: []       // Array of Audio elements for interruption
    };

    // ✅ Global audio initialization flags
    window.audioInitialized = false;
    window.globalAudioContext = null;
    window.globalMicStream = null;
    window.silentAudioBuffer = null;     // For iOS unlock

    // Determine device type
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        console.log('[GEMINI-WIDGET] Initializing v3.0 PRODUCTION...');
        
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
            position: CONFIG.position,
            device: isIOS ? 'iOS' : (isAndroid ? 'Android' : (isMobile ? 'Mobile' : 'Desktop'))
        });

        createWidget();
        
        // Initialize AudioContext on first user interaction
        document.addEventListener('click', initAudioContext, { once: true });
        document.addEventListener('touchstart', initAudioContext, { once: true });
    }

    // ✅ Global AudioContext initialization (once)
    async function initAudioContext() {
        if (window.audioInitialized) return true;
        
        console.log('[GEMINI-WIDGET] Initializing global AudioContext...');
        
        try {
            // 1. Create AudioContext
            if (!window.globalAudioContext) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                window.globalAudioContext = new AudioContextClass({
                    sampleRate: CONFIG.audio.playbackSampleRate,
                    latencyHint: 'interactive'
                });
                console.log('[GEMINI-WIDGET] AudioContext created:', window.globalAudioContext.sampleRate, 'Hz');
            }

            // 2. Resume if suspended
            if (window.globalAudioContext.state === 'suspended') {
                await window.globalAudioContext.resume();
                console.log('[GEMINI-WIDGET] AudioContext resumed');
            }

            // 3. Get microphone access
            if (!window.globalMicStream) {
                const constraints = {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: CONFIG.audio.inputSampleRate,
                        channelCount: 1
                    }
                };

                window.globalMicStream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log('[GEMINI-WIDGET] Microphone access granted');

                // Handle stream end
                window.globalMicStream.getAudioTracks().forEach(track => {
                    track.onended = () => {
                        console.log('[GEMINI-WIDGET] Microphone stream ended');
                        window.globalMicStream = null;
                        window.audioInitialized = false;
                    };
                });
            }

            // 4. iOS unlock - play silent buffer
            if (isIOS && !window.silentAudioBuffer) {
                try {
                    window.silentAudioBuffer = window.globalAudioContext.createBuffer(1, 1, window.globalAudioContext.sampleRate);
                    const channelData = window.silentAudioBuffer.getChannelData(0);
                    channelData[0] = 0;
                    
                    const silentSource = window.globalAudioContext.createBufferSource();
                    silentSource.buffer = window.silentAudioBuffer;
                    silentSource.connect(window.globalAudioContext.destination);
                    silentSource.start(0);
                    
                    console.log('[GEMINI-WIDGET iOS] Silent buffer played for unlock');
                } catch (iosError) {
                    console.warn('[GEMINI-WIDGET iOS] Silent buffer error:', iosError.message);
                }
            }

            window.audioInitialized = true;
            console.log('[GEMINI-WIDGET] ✅ Audio initialized successfully');
            return true;

        } catch (error) {
            console.error('[GEMINI-WIDGET] Audio initialization error:', error.message);
            showError('Ошибка микрофона', 'Не удалось получить доступ к микрофону');
            return false;
        }
    }

    // ============================================================================
    // UI CREATION
    // ============================================================================

    function createWidget() {
        const container = document.createElement('div');
        container.id = 'gemini-voice-widget';
        container.className = `gemini-widget-container position-${CONFIG.position}`;
        
        container.innerHTML = `
            <style>
                #gemini-voice-widget * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

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

                .gemini-main-button {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    background: ${CONFIG.colors.gradient};
                    border: none;
                    cursor: pointer;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.3s ease;
                    position: relative;
                }

                .gemini-main-button:hover {
                    transform: scale(1.05);
                    box-shadow: 0 6px 16px rgba(0,0,0,0.2);
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

                /* ✅ NEW: Interrupted animation (yellow) */
                .gemini-main-button.interrupted {
                    animation: pulse-interrupted 1s ease-in-out;
                }

                @keyframes pulse-recording {
                    0%, 100% { box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4); }
                    50% { box-shadow: 0 4px 20px rgba(239, 68, 68, 0.8); }
                }

                @keyframes pulse-playing {
                    0%, 100% { box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4); }
                    50% { box-shadow: 0 4px 20px rgba(16, 185, 129, 0.8); }
                }

                @keyframes pulse-interrupted {
                    0%, 100% { 
                        box-shadow: 0 4px 12px rgba(217, 119, 6, 0.4);
                        background: ${CONFIG.colors.gradient};
                    }
                    50% { 
                        box-shadow: 0 4px 20px rgba(217, 119, 6, 0.9);
                        background: linear-gradient(135deg, #f59e0b, #d97706);
                    }
                }

                .gemini-button-icon {
                    color: white;
                    font-size: 24px;
                }

                .gemini-equalizer {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    display: none;
                    gap: 3px;
                }

                .gemini-equalizer.active {
                    display: flex;
                }

                .gemini-equalizer-bar {
                    width: 3px;
                    background: white;
                    border-radius: 2px;
                    animation: equalizer 0.8s ease-in-out infinite;
                }

                .gemini-equalizer-bar:nth-child(1) { height: 8px; animation-delay: 0s; }
                .gemini-equalizer-bar:nth-child(2) { height: 12px; animation-delay: 0.1s; }
                .gemini-equalizer-bar:nth-child(3) { height: 16px; animation-delay: 0.2s; }
                .gemini-equalizer-bar:nth-child(4) { height: 12px; animation-delay: 0.3s; }
                .gemini-equalizer-bar:nth-child(5) { height: 8px; animation-delay: 0.4s; }

                @keyframes equalizer {
                    0%, 100% { transform: scaleY(0.5); }
                    50% { transform: scaleY(1.2); }
                }

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
                    background: ${CONFIG.colors.success};
                }

                .gemini-status-indicator.error {
                    background: ${CONFIG.colors.error};
                    animation: blink 1s ease-in-out infinite;
                }

                @keyframes blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }

                .gemini-error-message {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
                    background: white;
                    padding: 12px 16px;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
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
                    color: ${CONFIG.colors.error};
                    font-weight: 600;
                    font-size: 14px;
                    margin-bottom: 4px;
                }

                .gemini-error-text {
                    color: #64748B;
                    font-size: 12px;
                    line-height: 1.4;
                }

                .gemini-branding {
                    position: absolute;
                    bottom: -30px;
                    right: 0;
                    font-size: 10px;
                    color: #94A3B8;
                    text-decoration: none;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    transition: color 0.3s ease;
                }

                .gemini-branding:hover {
                    color: ${CONFIG.colors.primary};
                }

                @media (max-width: 768px) {
                    .gemini-widget-container {
                        bottom: 15px !important;
                        right: 15px !important;
                    }

                    .gemini-main-button {
                        width: 56px;
                        height: 56px;
                    }

                    .gemini-error-message {
                        max-width: calc(100vw - 90px);
                    }
                }
            </style>

            <button class="gemini-main-button" id="gemini-btn" title="Голосовой помощник">
                <i class="gemini-button-icon">🎤</i>
                
                <div class="gemini-equalizer" id="gemini-equalizer">
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                    <div class="gemini-equalizer-bar"></div>
                </div>

                <div class="gemini-status-indicator" id="gemini-status"></div>
            </button>

            <div class="gemini-error-message" id="gemini-error">
                <div class="gemini-error-title">Ошибка</div>
                <div class="gemini-error-text" id="gemini-error-text"></div>
            </div>

            <a href="https://voicyfy.ru" target="_blank" class="gemini-branding">
                <span>Powered by</span>
                <strong>Voicyfy</strong>
            </a>
        `;

        document.body.appendChild(container);
        console.log('[GEMINI-WIDGET] ✅ UI created');
    }

    // ============================================================================
    // UI UPDATES
    // ============================================================================

    function updateUI(state) {
        const button = document.getElementById('gemini-btn');
        const icon = button.querySelector('.gemini-button-icon');
        const equalizer = document.getElementById('gemini-equalizer');
        const status = document.getElementById('gemini-status');
        
        button.classList.remove('recording', 'playing', 'interrupted');
        equalizer.classList.remove('active');
        status.classList.remove('connected', 'error');

        if (state === 'connected') {
            status.classList.add('connected');
            icon.textContent = '🎤';
            icon.style.display = 'flex';
        } else if (state === 'recording') {
            button.classList.add('recording');
            equalizer.classList.add('active');
            icon.style.display = 'none';
            status.classList.add('connected');
        } else if (state === 'playing') {
            button.classList.add('playing');
            equalizer.classList.add('active');
            icon.style.display = 'none';
            status.classList.add('connected');
        } else if (state === 'interrupted') {
            button.classList.add('interrupted');
            status.classList.add('connected');
            // Remove interrupted class after 1 second
            setTimeout(() => {
                button.classList.remove('interrupted');
            }, 1000);
        } else if (state === 'error') {
            status.classList.add('error');
            icon.textContent = '❌';
            icon.style.display = 'flex';
        } else {
            icon.textContent = '🎤';
            icon.style.display = 'flex';
        }
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

    // ============================================================================
    // BUTTON CLICK HANDLER
    // ============================================================================

    async function handleButtonClick() {
        console.log('[GEMINI-WIDGET] Button clicked');
        
        // Initialize audio context if not done
        if (!window.audioInitialized) {
            const success = await initAudioContext();
            if (!success) return;
        }

        // Connect if not connected
        if (!STATE.isConnected) {
            await connectWebSocket();
        }
        // If connected but Gemini not ready, wait
        else if (!STATE.isGeminiReady) {
            console.log('[GEMINI-WIDGET] Waiting for Gemini setup...');
        }
        // If playing, do nothing (let it finish)
        else if (STATE.isPlaying) {
            console.log('[GEMINI-WIDGET] Audio playing, please wait...');
        }
        // If not recording, start
        else if (!STATE.isRecording) {
            await startRecording();
        }
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
        
        // Start ping interval
        STATE.pingInterval = setInterval(() => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                sendMessage({ type: 'ping' });
            }
        }, CONFIG.ws.pingInterval);

        // ✅ Note: We don't send session.create - server handles it
        // We just wait for gemini.setup.complete event
        console.log('[GEMINI-WIDGET] Waiting for setup.complete...');
    }

    function handleWSMessage(event) {
        try {
            const data = JSON.parse(event.data);
            
            // Don't log ACK messages
            if (!data.type || !data.type.includes('.ack')) {
                console.log('[GEMINI-WIDGET] Message:', data.type);
            }
            
            switch (data.type) {
                // ✅ NEW: Setup complete - START RECORDING!
                case 'gemini.setup.complete':
                    handleGeminiSetupComplete();
                    break;
                
                case 'connection_status':
                    handleConnectionStatus(data);
                    break;
                
                // ✅ Interruption events
                case 'conversation.interrupted':
                    handleInterruptionEvent(data);
                    break;
                
                case 'speech.started':
                    handleSpeechStarted(data);
                    break;
                
                case 'speech.stopped':
                    handleSpeechStopped(data);
                    break;
                
                case 'assistant.speech.started':
                    handleAssistantSpeechStarted(data);
                    break;
                
                case 'assistant.speech.ended':
                    handleAssistantSpeechEnded(data);
                    break;
                
                // ✅ Audio events
                case 'response.audio.delta':
                    handleAudioDelta(data);
                    break;
                
                case 'response.audio.done':
                    handleAudioDone();
                    break;
                
                // ✅ Response done - auto-return to recording
                case 'response.done':
                    handleResponseDone();
                    break;
                
                case 'response.cancelled':
                    handleResponseCancelled();
                    break;
                
                case 'error':
                    handleError(data);
                    break;
                
                case 'pong':
                    // Ping response
                    break;
                
                default:
                    if (!data.type || !data.type.includes('.ack')) {
                        console.log('[GEMINI-WIDGET] Unhandled:', data.type);
                    }
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
        STATE.isGeminiReady = false;
        
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

    // ✅ NEW: Handle Gemini setup complete
    function handleGeminiSetupComplete() {
        console.log('[GEMINI-WIDGET] ✅ Gemini setup complete');
        STATE.isGeminiReady = true;
        
        // ✅ AUTO-START RECORDING after setup
        if (!STATE.isRecording && !STATE.isPlaying) {
            setTimeout(() => {
                console.log('[GEMINI-WIDGET] 🎙️ Auto-starting recording...');
                startRecording();
            }, 500);
        }
        
        updateUI('connected');
    }

    function handleConnectionStatus(data) {
        console.log('[GEMINI-WIDGET] Connection status:', data);
    }

    function handleAudioDelta(data) {
        if (!data.delta) return;
        STATE.audioChunksBuffer.push(data.delta);
    }

    function handleAudioDone() {
        if (STATE.audioChunksBuffer.length > 0) {
            const fullAudio = STATE.audioChunksBuffer.join('');
            addAudioToPlaybackQueue(fullAudio);
            STATE.audioChunksBuffer = [];
        }
    }

    // ✅ NEW: Auto-return to recording after response
    function handleResponseDone() {
        console.log('[GEMINI-WIDGET] Response done');
        
        // ✅ Auto-start recording if not playing and not already recording
        if (!STATE.isPlaying && !STATE.isRecording && STATE.isGeminiReady) {
            setTimeout(() => {
                startRecording();
            }, 400);
        }
    }

    function handleResponseCancelled() {
        console.log('[GEMINI-WIDGET] Response cancelled');
        stopAllAudioPlayback();
        updateUI('interrupted');
    }

    // ✅ NEW: Interruption event
    function handleInterruptionEvent(data) {
        console.log('[GEMINI-WIDGET] ⚡ INTERRUPTION detected');
        
        INTERRUPTION_STATE.interruption_count++;
        INTERRUPTION_STATE.last_interruption_time = Date.now();
        
        stopAllAudioPlayback();
        updateUI('interrupted');
        
        console.log(`[GEMINI-WIDGET] Interruption #${INTERRUPTION_STATE.interruption_count}`);
    }

    // ✅ NEW: Speech started (user)
    function handleSpeechStarted(data) {
        console.log('[GEMINI-WIDGET] 🗣️ User started speaking');
        INTERRUPTION_STATE.is_user_speaking = true;
        
        // If assistant is speaking, interrupt
        if (INTERRUPTION_STATE.is_assistant_speaking) {
            stopAllAudioPlayback();
            updateUI('interrupted');
        }
    }

    // ✅ NEW: Speech stopped (user)
    function handleSpeechStopped(data) {
        console.log('[GEMINI-WIDGET] 🤐 User stopped speaking');
        INTERRUPTION_STATE.is_user_speaking = false;
    }

    // ✅ NEW: Assistant speech started
    function handleAssistantSpeechStarted(data) {
        console.log('[GEMINI-WIDGET] 🔊 Assistant started speaking');
        INTERRUPTION_STATE.is_assistant_speaking = true;
        updateUI('playing');
    }

    // ✅ NEW: Assistant speech ended
    function handleAssistantSpeechEnded(data) {
        console.log('[GEMINI-WIDGET] 🔇 Assistant stopped speaking');
        INTERRUPTION_STATE.is_assistant_speaking = false;
        
        // Return to recording if not already
        if (!STATE.isRecording && STATE.isGeminiReady) {
            setTimeout(() => {
                startRecording();
            }, 500);
        }
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
        
        if (!STATE.isGeminiReady) {
            console.log('[GEMINI-WIDGET] ⚠️ Gemini not ready yet');
            return;
        }
        
        console.log('[GEMINI-WIDGET] Starting recording...');
        
        try {
            // Ensure audio is initialized
            if (!window.audioInitialized || !window.globalAudioContext || !window.globalMicStream) {
                console.log('[GEMINI-WIDGET] Audio not initialized, initializing...');
                const success = await initAudioContext();
                if (!success) {
                    showError('Ошибка микрофона', 'Не удалось получить доступ к микрофону');
                    return;
                }
            }

            // Resume AudioContext if suspended
            if (window.globalAudioContext.state === 'suspended') {
                await window.globalAudioContext.resume();
                console.log('[GEMINI-WIDGET] AudioContext resumed');
            }

            // Create audio processor
            const source = window.globalAudioContext.createMediaStreamSource(window.globalMicStream);
            const processor = window.globalAudioContext.createScriptProcessor(4096, 1, 1);
            
            let isSilent = true;
            let silenceStartTime = Date.now();
            
            processor.onaudioprocess = (e) => {
                if (!STATE.isRecording || !STATE.isGeminiReady) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                
                // Calculate RMS
                const rms = calculateRMS(inputData);
                const db = 20 * Math.log10(rms);
                
                // ✅ VAD with separate user speaking flag
                if (db > CONFIG.vad.speechThreshold) {
                    if (!INTERRUPTION_STATE.is_user_speaking) {
                        const now = Date.now();
                        STATE.speechStartTime = now;
                        console.log('[GEMINI-WIDGET] 🗣️ User speaking detected');
                        
                        // ✅ If assistant is speaking = INTERRUPTION
                        if (INTERRUPTION_STATE.is_assistant_speaking) {
                            console.log('[GEMINI-WIDGET] ⚡ Interrupting assistant...');
                            stopAllAudioPlayback();
                            updateUI('interrupted');
                        }
                        
                        INTERRUPTION_STATE.is_user_speaking = true;
                        sendMessage({ type: 'speech.user_started' });
                    }
                    STATE.lastSpeechTime = Date.now();
                    isSilent = false;
                    silenceStartTime = Date.now();
                } else if (INTERRUPTION_STATE.is_user_speaking && 
                          STATE.lastSpeechTime > 0 && 
                          Date.now() - STATE.lastSpeechTime > CONFIG.vad.silenceDuration) {
                    
                    // Check minimum speech duration
                    const speechDuration = Date.now() - STATE.speechStartTime;
                    if (speechDuration >= CONFIG.vad.minSpeechDuration) {
                        console.log('[GEMINI-WIDGET] 🤐 User stopped (silence detected)');
                        console.log(`[GEMINI-WIDGET] Speech duration: ${speechDuration}ms`);
                        
                        sendMessage({ type: 'speech.user_stopped' });
                        sendMessage({ type: 'input_audio_buffer.commit' });
                        
                        INTERRUPTION_STATE.is_user_speaking = false;
                        STATE.lastSpeechTime = 0;
                        STATE.speechStartTime = 0;
                        isSilent = true;
                    }
                }
                
                // Convert to PCM16
                const pcm16Data = float32ToPCM16(inputData);
                
                // Send audio
                const base64Audio = arrayBufferToBase64(pcm16Data.buffer);
                sendMessage({
                    type: 'input_audio_buffer.append',
                    audio: base64Audio
                });
            };
            
            source.connect(processor);
            processor.connect(window.globalAudioContext.destination);
            
            STATE.audioWorklet = { source, processor };
            STATE.isRecording = true;
            
            updateUI('recording');
            
            console.log('[GEMINI-WIDGET] ✅ Recording started');
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Recording error:', error);
            showError('Ошибка записи', 'Не удалось начать запись');
        }
    }

    async function stopRecording() {
        if (!STATE.isRecording) return;
        
        console.log('[GEMINI-WIDGET] Stopping recording...');
        
        STATE.isRecording = false;
        
        // Disconnect audio nodes
        if (STATE.audioWorklet) {
            STATE.audioWorklet.source.disconnect();
            STATE.audioWorklet.processor.disconnect();
            STATE.audioWorklet = null;
        }
        
        // Final commit if user was speaking
        if (INTERRUPTION_STATE.is_user_speaking) {
            console.log('[GEMINI-WIDGET] 💾 Final commit');
            sendMessage({ type: 'input_audio_buffer.commit' });
            INTERRUPTION_STATE.is_user_speaking = false;
        }
        
        if (INTERRUPTION_STATE.is_assistant_speaking) {
            updateUI('playing');
        } else {
            updateUI('connected');
        }
        
        console.log('[GEMINI-WIDGET] ✅ Recording stopped');
    }

    // ============================================================================
    // AUDIO PLAYBACK
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
        
        // ✅ Auto-return to recording after playback
        if (STATE.isGeminiReady && !STATE.isRecording) {
            setTimeout(() => {
                startRecording();
            }, 400);
        }
    }

    // ✅ iOS-compatible audio playback
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
            
            // ✅ No resampling - keep at 24kHz as is
            const audioBuffer = window.globalAudioContext.createBuffer(
                1,
                float32.length,
                CONFIG.audio.outputSampleRate  // 24000 Hz
            );
            audioBuffer.getChannelData(0).set(float32);
            
            // Play using Web Audio API
            const source = window.globalAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(window.globalAudioContext.destination);
            
            // ✅ Save for interruption
            INTERRUPTION_STATE.current_audio_elements.push(source);
            
            return new Promise((resolve) => {
                source.onended = () => {
                    // Remove from array
                    const idx = INTERRUPTION_STATE.current_audio_elements.indexOf(source);
                    if (idx > -1) {
                        INTERRUPTION_STATE.current_audio_elements.splice(idx, 1);
                    }
                    resolve();
                };
                source.start();
            });
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Playback error:', error);
        }
    }

    // ✅ NEW: Stop all audio playback (for interruptions)
    function stopAllAudioPlayback() {
        console.log('[GEMINI-WIDGET] Stopping all audio playback');
        
        STATE.isPlaying = false;
        INTERRUPTION_STATE.is_assistant_speaking = false;
        
        // Stop all audio sources
        INTERRUPTION_STATE.current_audio_elements.forEach(source => {
            try {
                source.stop();
                source.disconnect();
            } catch (e) {
                // Already stopped
            }
        });
        
        INTERRUPTION_STATE.current_audio_elements = [];
        STATE.audioQueue = [];
        STATE.audioChunksBuffer = [];
        
        // Notify server
        if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
            sendMessage({
                type: "response.cancel"
            });
        }
        
        console.log('[GEMINI-WIDGET] ✅ All audio stopped');
    }

    function stopPlayback() {
        stopAllAudioPlayback();
    }

    function addAudioToPlaybackQueue(audioBase64) {
        if (!audioBase64 || typeof audioBase64 !== 'string') return;
        
        STATE.audioQueue.push(audioBase64);
        
        if (!STATE.isPlaying) {
            playAudioQueue();
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

    // Setup button click handler after DOM is ready
    setTimeout(() => {
        const button = document.getElementById('gemini-btn');
        if (button) {
            button.addEventListener('click', handleButtonClick);
            console.log('[GEMINI-WIDGET] ✅ Button handler attached');
        }
    }, 100);

    console.log('[GEMINI-WIDGET] Script loaded v3.0 PRODUCTION');

})();
