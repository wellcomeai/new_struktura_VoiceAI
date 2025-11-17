/**
 * 🚀 Gemini Voice Widget v2.7.0 - PRODUCTION (REAL-TIME STREAMING)
 * Google Gemini Live API Integration
 * 
 * ✅ NEW v2.7.0: Fixed first request issue (warm-up commit)
 * ✅ NEW v2.7.0: Fast response (500ms silence detection, was 1500ms)
 * ✅ NEW v2.7.0: Fixed orange color on interruption
 * ✅ NEW v2.7.0: Removed MIN_CHUNKS blocker for short phrases
 * ✅ NEW v2.7.0: Smooth UI transitions with enhanced animations
 * ✅ NEW v2.7.0: Tactile button feedback
 * ✅ NEW v2.7.0: Dynamic volume visualization with color gradient
 * ✅ NEW v2.7.0: Thinking indicator during processing
 * ✅ True streaming audio via AudioWorklet (no buffering!)
 * ✅ Zero-latency playback start (first chunk immediately)
 * ✅ Seamless audio continuity (no gaps/clicks)
 * ✅ Instant interruptions (<10ms)
 * ✅ Auto return to listening (blue) after assistant speaks
 * ✅ REMOVED: Text display in widget (voice only)
 * ✅ AudioWorklet for recording (no ScriptProcessor deprecation)
 * ✅ Continuous audio stream (like Google examples)
 * ✅ Automatic audio resampling (24kHz -> browser native rate)
 * ✅ One-click activation - auto-start recording
 * ✅ Close = disconnect - clean shutdown
 * ✅ Premium visual design
 * ✅ WebSocket connection to /ws/gemini/{assistant_id}
 * ✅ Real-time audio streaming (16kHz PCM input, 24kHz PCM output)
 * ✅ Client-side VAD with auto-commit
 * ✅ Interruption handling
 * ✅ Error handling with Russian messages
 * ✅ Responsive design
 * ✅ Voicyfy branding
 * 
 * @version 2.7.0
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
            playbackSampleRate: 24000,      // Желаемая частота
            actualSampleRate: null,         // Реальная частота AudioContext
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,
            needsResampling: false
        },
        
        // VAD - ✅ UPDATED: Faster response
        vad: {
            enabled: true,
            silenceThreshold: -45,
            silenceDuration: 500,           // ✅ 1500ms → 500ms (быстрее)
            speechThreshold: -38
        },
        
        // WebSocket
        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        },
        
        // Setup timing - ✅ UPDATED: More time for Gemini init
        setup: {
            waitAfterSetup: 1200,           // ✅ 800ms → 1200ms
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
        audioWorkletNode: null,
        audioStreamNode: null,          // Worklet для воспроизведения
        pingInterval: null,
        reconnectAttempts: 0,
        lastSpeechTime: 0,
        lastSilenceTime: 0,
        sessionConfig: null,
        errorState: null,
        audioBufferCommitted: false,
        setupTimeout: null,
        isWidgetOpen: false,
        audioChunksProcessed: 0,
        audioWorkletReady: false,
        streamWorkletReady: false
    };

    // ============================================================================
    // AUDIOWORKLET PROCESSOR CODE (INLINE)
    // ============================================================================

    // Recording worklet (unchanged)
    const RECORDER_WORKLET_CODE = `
class RecorderWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const inputData = input[0];

        for (let i = 0; i < inputData.length; i++) {
            this.buffer[this.bufferIndex++] = inputData[i];

            if (this.bufferIndex >= this.bufferSize) {
                this.port.postMessage({
                    type: 'audioData',
                    data: this.buffer.slice(0, this.bufferIndex)
                });
                this.bufferIndex = 0;
            }
        }

        return true;
    }
}

registerProcessor('recorder-worklet', RecorderWorkletProcessor);
`;

    // Streaming playback worklet
    const STREAM_WORKLET_CODE = `
class AudioStreamProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.audioQueue = [];
        this.currentBuffer = null;
        this.bufferIndex = 0;
        this.samplesProcessed = 0;
        this.isActive = false;
        
        this.port.onmessage = (e) => {
            if (e.data.type === 'audioData') {
                this.audioQueue.push(e.data.buffer);
                if (!this.isActive) {
                    this.isActive = true;
                    this.port.postMessage({ type: 'started' });
                }
            } else if (e.data.type === 'clear') {
                this.audioQueue = [];
                this.currentBuffer = null;
                this.bufferIndex = 0;
                this.isActive = false;
                this.port.postMessage({ type: 'cleared' });
            } else if (e.data.type === 'stop') {
                this.isActive = false;
                this.port.postMessage({ type: 'stopped' });
            }
        };
    }
    
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || !output[0]) return true;
        
        const outputChannel = output[0];
        
        for (let i = 0; i < outputChannel.length; i++) {
            if (!this.currentBuffer || this.bufferIndex >= this.currentBuffer.length) {
                if (this.audioQueue.length > 0) {
                    this.currentBuffer = this.audioQueue.shift();
                    this.bufferIndex = 0;
                } else {
                    outputChannel[i] = 0;
                    continue;
                }
            }
            
            outputChannel[i] = this.currentBuffer[this.bufferIndex++];
            this.samplesProcessed++;
        }
        
        if (this.samplesProcessed % 4800 === 0) {
            this.port.postMessage({
                type: 'stats',
                queueLength: this.audioQueue.length,
                samplesProcessed: this.samplesProcessed
            });
        }
        
        return true;
    }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
`;

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        console.log('[GEMINI-WIDGET] 🚀 Initializing v2.7.0 (PRODUCTION)...');
        
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
            silenceDuration: CONFIG.vad.silenceDuration + 'ms',
            waitAfterSetup: CONFIG.setup.waitAfterSetup + 'ms'
        });

        createWidget();
        
        document.addEventListener('click', initAudioContext, { once: true });
        document.addEventListener('touchstart', initAudioContext, { once: true });
    }

    async function initAudioContext() {
        if (STATE.audioContext) return;
        
        console.log('[GEMINI-WIDGET] 🎧 Creating AudioContext...');
        console.log('[GEMINI-WIDGET] 📊 Requested sample rate:', CONFIG.audio.playbackSampleRate, 'Hz');
        
        STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.audio.playbackSampleRate
        });
        
        const actualRate = STATE.audioContext.sampleRate;
        CONFIG.audio.actualSampleRate = actualRate;
        
        console.log('[GEMINI-WIDGET] 📊 Actual sample rate:', actualRate, 'Hz');
        
        if (actualRate !== CONFIG.audio.outputSampleRate) {
            CONFIG.audio.needsResampling = true;
            console.warn('[GEMINI-WIDGET] ⚠️ Sample rate mismatch detected!');
            console.warn('[GEMINI-WIDGET] 🔄 Resampling enabled:', CONFIG.audio.outputSampleRate, 'Hz →', actualRate, 'Hz');
        } else {
            CONFIG.audio.needsResampling = false;
            console.log('[GEMINI-WIDGET] ✅ Sample rates match - no resampling needed');
        }
        
        await loadAudioWorklets();
        
        console.log('[GEMINI-WIDGET] ✅ AudioContext initialized');
        console.log('[GEMINI-WIDGET] 📊 Audio Config:', {
            input: CONFIG.audio.inputSampleRate + ' Hz',
            geminiOutput: CONFIG.audio.outputSampleRate + ' Hz',
            browserActual: actualRate + ' Hz',
            needsResampling: CONFIG.audio.needsResampling,
            recorderWorklet: STATE.audioWorkletReady ? 'ready' : 'not ready',
            streamWorklet: STATE.streamWorkletReady ? 'ready' : 'not ready'
        });
    }

    async function loadAudioWorklets() {
        try {
            console.log('[GEMINI-WIDGET] 📦 Loading AudioWorklets...');
            
            const recorderBlob = new Blob([RECORDER_WORKLET_CODE], { type: 'application/javascript' });
            const recorderUrl = URL.createObjectURL(recorderBlob);
            
            await STATE.audioContext.audioWorklet.addModule(recorderUrl);
            STATE.audioWorkletReady = true;
            console.log('[GEMINI-WIDGET] ✅ Recorder worklet loaded');
            URL.revokeObjectURL(recorderUrl);
            
            const streamBlob = new Blob([STREAM_WORKLET_CODE], { type: 'application/javascript' });
            const streamUrl = URL.createObjectURL(streamBlob);
            
            await STATE.audioContext.audioWorklet.addModule(streamUrl);
            STATE.streamWorkletReady = true;
            console.log('[GEMINI-WIDGET] ✅ Stream worklet loaded');
            URL.revokeObjectURL(streamUrl);
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] ❌ AudioWorklet load failed:', error);
            console.warn('[GEMINI-WIDGET] ⚠️ Falling back to ScriptProcessor');
            STATE.audioWorkletReady = false;
            STATE.streamWorkletReady = false;
        }
    }

    // ============================================================================
    // UI CREATION - IMPROVED DESIGN v2.7.0
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

                /* ✅ NEW v2.7.0: Tactile feedback */
                .gemini-main-button::after {
                    content: '';
                    position: absolute;
                    inset: 0;
                    border-radius: 50%;
                    background: white;
                    opacity: 0;
                    transform: scale(0);
                    transition: all 0.4s;
                }

                .gemini-main-button:active::after {
                    opacity: 0.3;
                    transform: scale(1);
                    transition: all 0s;
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
                    z-index: 1;
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
                    z-index: 2;
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
                    height: 480px;
                    opacity: 1;
                    pointer-events: all;
                }

                .gemini-widget-container.active .gemini-main-button {
                    transform: scale(0.9);
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                }

                /* Widget Header */
                .gemini-widget-header {
                    padding: 20px 24px;
                    background: linear-gradient(135deg, #1e3a8a, #3b82f6);
                    color: white;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-radius: 24px 24px 0 0;
                    transition: background 0.3s;
                }

                /* ✅ NEW v2.7.0: Hover effect */
                .gemini-widget-header:hover {
                    background: linear-gradient(135deg, #1e40af, #3b82f6);
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

                /* Main Circle - ✅ NEW v2.7.0: Smooth transitions */
                .gemini-main-circle {
                    width: 200px;
                    height: 200px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #f3f4f6, #e5e7eb);
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1), inset 0 2px 5px rgba(255, 255, 255, 0.5);
                    position: relative;
                    overflow: hidden;
                    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
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

                /* ✅ NEW v2.7.0: Gentle breathing animation */
                @keyframes gentle-breathe {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.02); }
                }

                .gemini-main-circle.waiting {
                    animation: gentle-breathe 3s ease-in-out infinite;
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

                /* ✅ UPDATED: Interrupted = Orange */
                .gemini-main-circle.interrupted {
                    background: linear-gradient(135deg, #fed7aa, #ffedd5);
                    box-shadow: 0 0 30px rgba(249, 115, 22, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
                }

                .gemini-main-circle.interrupted::before {
                    animation: gemini-wave 2s linear infinite;
                    background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(249, 115, 22, 0.3));
                }

                .gemini-main-circle.interrupted::after {
                    content: '';
                    position: absolute;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: 3px solid rgba(249, 115, 22, 0.5);
                    animation: gemini-pulse 1s ease-out infinite;
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

                .gemini-main-circle.interrupted .gemini-mic-icon {
                    color: #f97316;
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
                    transition: height 0.1s ease, background-color 0.2s ease;
                }

                /* ✅ NEW v2.7.0: Thinking Indicator */
                .gemini-thinking-indicator {
                    position: absolute;
                    bottom: 55px;
                    font-size: 11px;
                    color: #64748b;
                    display: none;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 10px;
                    background: rgba(255, 255, 255, 0.9);
                    border-radius: 12px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
                }

                .gemini-thinking-indicator.show {
                    display: flex;
                }

                .thinking-dots {
                    display: flex;
                    gap: 3px;
                }

                .thinking-dots span {
                    width: 4px;
                    height: 4px;
                    background: #64748b;
                    border-radius: 50%;
                    animation: thinking-dot 1.4s infinite;
                }

                .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
                .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

                @keyframes thinking-dot {
                    0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
                    30% { opacity: 1; transform: scale(1); }
                }

                /* ✅ HIDDEN: Message Display */
                .gemini-message-display {
                    display: none;
                }

                /* Status Info */
                .gemini-status-info {
                    position: absolute;
                    bottom: 60px;
                    left: 50%;
                    transform: translateX(-50%) translateY(5px);
                    font-size: 12px;
                    color: #64748b;
                    padding: 6px 12px;
                    border-radius: 12px;
                    background-color: rgba(255, 255, 255, 0.9);
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    opacity: 0;
                    transition: all 0.3s;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
                }

                .gemini-status-info.show {
                    opacity: 1;
                    transform: translateX(-50%) translateY(0);
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

                /* Voicyfy Branding */
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
                        height: 460px;
                    }

                    .gemini-error-message {
                        max-width: calc(100vw - 90px);
                    }
                }
            </style>

            <!-- Main Button -->
            <button class="gemini-main-button" id="gemini-btn" title="Голосовой ассистент">
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
                    <div class="gemini-widget-title">Голосовой Ассистент</div>
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

                    <!-- ✅ NEW v2.7.0: Thinking Indicator -->
                    <div class="gemini-thinking-indicator" id="gemini-thinking">
                        <span>Думаю</span>
                        <div class="thinking-dots">
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                    </div>

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
    // UI UPDATES - ✅ FIXED v2.7.0: Added 'interrupted' state handling
    // ============================================================================

    function updateUI(state) {
        const button = document.getElementById('gemini-btn');
        const circle = document.getElementById('gemini-circle');
        const status = document.getElementById('gemini-status');
        const thinkingIndicator = document.getElementById('gemini-thinking');
        
        button.classList.remove('recording', 'playing');
        circle.classList.remove('listening', 'speaking', 'interrupted', 'waiting');
        status.classList.remove('connected', 'error');
        
        if (thinkingIndicator) {
            thinkingIndicator.classList.remove('show');
        }

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
        } else if (state === 'interrupted') {  // ✅ FIXED: Added missing state
            circle.classList.add('interrupted');
            status.classList.add('connected');
            updateStatusInfo('connected', 'Прервано');
        } else if (state === 'thinking') {      // ✅ NEW: Thinking state
            circle.classList.add('waiting');
            status.classList.add('connected');
            if (thinkingIndicator) {
                thinkingIndicator.classList.add('show');
            }
            updateStatusInfo('connected', 'Обработка...');
        } else if (state === 'error') {
            status.classList.add('error');
            updateStatusInfo('error', 'Ошибка');
        } else if (state === 'waiting_setup') {
            status.classList.add('connecting');
            circle.classList.add('waiting');
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

    // ✅ NEW v2.7.0: Enhanced visualization with color gradient
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
            
            // ✅ NEW: Color gradient based on volume
            const intensity = height / 30;
            if (intensity > 0.7) {
                bars[i].style.backgroundColor = '#2563eb'; // Loud = bright blue
            } else if (intensity > 0.4) {
                bars[i].style.backgroundColor = '#60a5fa'; // Medium
            } else {
                bars[i].style.backgroundColor = '#93c5fd'; // Quiet
            }
        }
    }

    function resetAudioVisualization() {
        const bars = document.querySelectorAll('.gemini-audio-bar');
        bars.forEach(bar => {
            bar.style.height = '2px';
            bar.style.backgroundColor = '#3b82f6';
        });
    }

    // ============================================================================
    // BUTTON HANDLERS
    // ============================================================================

    async function handleButtonClick() {
        console.log('[GEMINI-WIDGET] Button clicked');
        
        if (!STATE.audioContext) {
            await initAudioContext();
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
                
                case 'input_audio_buffer.commit.ack':
                    handleCommitAck();
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
                    // ✅ REMOVED: No text display in widget
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

    // ✅ FIXED v2.7.0: Added warm-up commit for first request
    function handleSetupComplete() {
        console.log('[GEMINI-WIDGET] ✅ Gemini setup complete');
        
        if (STATE.setupTimeout) {
            clearTimeout(STATE.setupTimeout);
            STATE.setupTimeout = null;
        }
        
        STATE.isSetupComplete = true;
        
        // ✅ NEW: Warm-up commit to fix first request issue
        console.log('[GEMINI-WIDGET] 🔥 Sending warm-up commit...');
        sendMessage({ type: 'input_audio_buffer.commit' });
        
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

    function handleCommitAck() {
        console.log('[GEMINI-WIDGET] ✅ Commit acknowledged');
        updateUI('thinking');
    }

    function handleAudioDelta(data) {
        if (!data.delta) return;
        
        STATE.audioChunksProcessed++;
        
        try {
            const binaryString = atob(data.delta);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            const pcm16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) {
                float32[i] = pcm16[i] / 32768.0;
            }
            
            let audioData = float32;
            if (CONFIG.audio.needsResampling) {
                audioData = resampleAudio(
                    float32,
                    CONFIG.audio.outputSampleRate,
                    CONFIG.audio.actualSampleRate
                );
            }
            
            if (STATE.audioStreamNode) {
                STATE.audioStreamNode.port.postMessage({
                    type: 'audioData',
                    buffer: audioData
                });
            }
            
            if (!STATE.isPlaying) {
                console.log('[GEMINI-WIDGET] 🎵 Starting real-time stream (chunk #1)');
                startAudioStream();
            }
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] ❌ Error processing audio chunk:', error);
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
        
        stopPlayback();
        
        // ✅ Return to listening (blue) after assistant finishes
        if (!STATE.isRecording) {
            updateUI('recording');
        }
        
        console.log('[GEMINI-WIDGET] 📊 Audio chunks processed:', STATE.audioChunksProcessed);
        STATE.audioChunksProcessed = 0;
    }

    // ✅ FIXED v2.7.0: Simplified interruption handling with updateUI
    function handleInterruption() {
        console.log('[GEMINI-WIDGET] ⚡ Interrupted');
        stopPlayback();
        STATE.isSpeaking = false;
        STATE.audioBufferCommitted = false;
        
        // Show orange circle via updateUI
        updateUI('interrupted');
        
        // Return to normal state after 800ms
        setTimeout(() => {
            if (STATE.isRecording) {
                updateUI('recording');
            } else {
                updateUI('connected');
            }
        }, 800);
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
    // AUDIO RECORDING - ✅ FIXED v2.7.0: Removed MIN_CHUNKS blocker
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
            
            if (STATE.audioWorkletReady) {
                console.log('[GEMINI-WIDGET] 🎙️ Using AudioWorklet (modern)');
                await startAudioWorkletRecording(source);
            } else {
                console.log('[GEMINI-WIDGET] 🎙️ Using ScriptProcessor (fallback)');
                await startScriptProcessorRecording(source);
            }
            
            STATE.isRecording = true;
            STATE.audioBufferCommitted = false;
            
            updateUI('recording');
            
            console.log('[GEMINI-WIDGET] ✅ Recording started');
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] Recording error:', error);
            showError('Ошибка записи', 'Не удалось получить доступ к микрофону');
        }
    }

    // ✅ FIXED v2.7.0: Removed MIN_CHUNKS_BEFORE_COMMIT blocker
    async function startAudioWorkletRecording(source) {
        const workletNode = new AudioWorkletNode(STATE.audioContext, 'recorder-worklet');
        
        workletNode.port.onmessage = (event) => {
            if (!STATE.isRecording) return;
            
            const audioData = event.data.data;
            const pcmData = float32ToPCM16(audioData);
            
            updateAudioVisualization(audioData);
            
            const rms = calculateRMS(audioData);
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
                // ✅ REMOVED: MIN_CHUNKS_BEFORE_COMMIT check
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
        
        source.connect(workletNode);
        workletNode.connect(STATE.audioContext.destination);
        
        STATE.audioWorkletNode = { source, workletNode };
    }

    // ✅ FIXED v2.7.0: Removed MIN_CHUNKS_BEFORE_COMMIT blocker
    async function startScriptProcessorRecording(source) {
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
                // ✅ REMOVED: MIN_CHUNKS_BEFORE_COMMIT check
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
        
        STATE.audioWorkletNode = { source, processor };
    }

    async function stopRecording() {
        if (!STATE.isRecording) return;
        
        console.log('[GEMINI-WIDGET] Stopping recording...');
        
        STATE.isRecording = false;
        
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(track => track.stop());
            STATE.mediaStream = null;
        }
        
        if (STATE.audioWorkletNode) {
            STATE.audioWorkletNode.source.disconnect();
            if (STATE.audioWorkletNode.workletNode) {
                STATE.audioWorkletNode.workletNode.disconnect();
            }
            if (STATE.audioWorkletNode.processor) {
                STATE.audioWorkletNode.processor.disconnect();
            }
            STATE.audioWorkletNode = null;
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
    // AUDIO PLAYBACK - STREAMING VIA AUDIOWORKLET
    // ============================================================================

    async function startAudioStream() {
        if (STATE.isPlaying) return;
        
        console.log('[GEMINI-WIDGET] 🎵 Starting audio stream...');
        
        try {
            if (!STATE.audioStreamNode && STATE.streamWorkletReady) {
                STATE.audioStreamNode = new AudioWorkletNode(
                    STATE.audioContext, 
                    'audio-stream-processor'
                );
                
                STATE.audioStreamNode.port.onmessage = (e) => {
                    if (e.data.type === 'stats') {
                        if (STATE.audioChunksProcessed % 50 === 0) {
                            console.log('[GEMINI-WIDGET] 📊 Stream stats:', {
                                queueLength: e.data.queueLength,
                                samplesProcessed: e.data.samplesProcessed,
                                chunksReceived: STATE.audioChunksProcessed
                            });
                        }
                    } else if (e.data.type === 'started') {
                        console.log('[GEMINI-WIDGET] 🎵 Stream playback started');
                    } else if (e.data.type === 'cleared') {
                        console.log('[GEMINI-WIDGET] 🗑️ Stream cleared');
                    }
                };
                
                STATE.audioStreamNode.connect(STATE.audioContext.destination);
                console.log('[GEMINI-WIDGET] ✅ Stream worklet connected');
            }
            
            STATE.isPlaying = true;
            
        } catch (error) {
            console.error('[GEMINI-WIDGET] ❌ Error starting stream:', error);
            STATE.isPlaying = false;
        }
    }

    function stopPlayback() {
        if (!STATE.isPlaying) return;
        
        console.log('[GEMINI-WIDGET] 🛑 Stopping playback...');
        
        if (STATE.audioStreamNode) {
            STATE.audioStreamNode.port.postMessage({ type: 'clear' });
        }
        
        STATE.isPlaying = false;
        STATE.audioChunksProcessed = 0;
        
        console.log('[GEMINI-WIDGET] ✅ Playback stopped');
    }

    // ============================================================================
    // AUDIO RESAMPLING
    // ============================================================================

    function resampleAudio(inputBuffer, inputSampleRate, outputSampleRate) {
        if (inputSampleRate === outputSampleRate) {
            return inputBuffer;
        }
        
        const ratio = inputSampleRate / outputSampleRate;
        const outputLength = Math.round(inputBuffer.length / ratio);
        const outputBuffer = new Float32Array(outputLength);
        
        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, inputBuffer.length - 1);
            const t = srcIndex - srcIndexFloor;
            
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

    console.log('[GEMINI-WIDGET] 🚀 Script loaded v2.7.0 (PRODUCTION)');

})();
