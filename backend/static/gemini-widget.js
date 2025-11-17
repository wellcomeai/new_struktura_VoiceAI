/**
 * 🚀 Gemini Voice Widget v2.7.1 - PRODUCTION (PREMIUM UI)
 * Google Gemini Live API Integration
 * 
 * ✅ v2.7.1: Fixed header text visibility + audio bars for assistant speech
 * ✅ NEW: Premium modern UI design
 * ✅ NEW: Glassmorphism effects
 * ✅ NEW: Animated gradient borders
 * ✅ NEW: Pulsating rings
 * ✅ NEW: Smooth state transitions
 * ✅ NEW: Hidden text output
 * ✅ True streaming audio via AudioWorklet
 * ✅ Zero-latency playback start
 * ✅ Seamless audio continuity
 * ✅ Instant interruptions (<10ms)
 * ✅ One-click activation - auto-start recording
 * ✅ Close = disconnect - clean shutdown
 * 
 * @version 2.7.1
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
        assistantId: null,
        serverUrl: null,
        position: 'bottom-right',
        
        audio: {
            inputSampleRate: 16000,
            outputSampleRate: 24000,
            playbackSampleRate: 24000,
            actualSampleRate: null,
            channelCount: 1,
            bitsPerSample: 16,
            chunkDuration: 100,
            needsResampling: false
        },
        
        vad: {
            enabled: true,
            silenceThreshold: -45,
            silenceDuration: 1500,
            speechThreshold: -38
        },
        
        ws: {
            reconnectDelay: 2000,
            maxReconnectAttempts: 5,
            pingInterval: 30000
        },
        
        setup: {
            waitAfterSetup: 800,
            maxSetupWait: 10000
        },
        
        colors: {
            primary: '#4a86e8',
            listening: '#3b82f6',
            speaking: '#10b981',
            processing: '#8b5cf6',
            error: '#ef4444'
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
        audioStreamNode: null,
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
        console.log('[GEMINI-WIDGET] 🚀 Initializing v2.7.1 (PREMIUM UI)...');
        
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

    async function initAudioContext() {
        if (STATE.audioContext) return;
        
        console.log('[GEMINI-WIDGET] 🎧 Creating AudioContext...');
        
        STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: CONFIG.audio.playbackSampleRate
        });
        
        const actualRate = STATE.audioContext.sampleRate;
        CONFIG.audio.actualSampleRate = actualRate;
        
        console.log('[GEMINI-WIDGET] 📊 Sample rates:', {
            requested: CONFIG.audio.playbackSampleRate,
            actual: actualRate
        });
        
        if (actualRate !== CONFIG.audio.outputSampleRate) {
            CONFIG.audio.needsResampling = true;
            console.warn('[GEMINI-WIDGET] 🔄 Resampling enabled:', CONFIG.audio.outputSampleRate, 'Hz →', actualRate, 'Hz');
        } else {
            CONFIG.audio.needsResampling = false;
            console.log('[GEMINI-WIDGET] ✅ No resampling needed');
        }
        
        await loadAudioWorklets();
        
        console.log('[GEMINI-WIDGET] ✅ AudioContext ready');
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
            STATE.audioWorkletReady = false;
            STATE.streamWorkletReady = false;
        }
    }

    // ============================================================================
    // UI CREATION - PREMIUM MODERN DESIGN
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

                /* ============================================ */
                /* PREMIUM MAIN BUTTON */
                /* ============================================ */
                .gemini-main-button {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border: none;
                    cursor: pointer;
                    box-shadow: 
                        0 8px 32px rgba(102, 126, 234, 0.4),
                        0 0 0 0 rgba(102, 126, 234, 0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    position: relative;
                    overflow: hidden;
                    animation: button-pulse 3s ease-in-out infinite;
                }

                @keyframes button-pulse {
                    0%, 100% {
                        box-shadow: 
                            0 8px 32px rgba(102, 126, 234, 0.4),
                            0 0 0 0 rgba(102, 126, 234, 0.7);
                    }
                    50% {
                        box-shadow: 
                            0 8px 32px rgba(102, 126, 234, 0.6),
                            0 0 0 10px rgba(102, 126, 234, 0);
                    }
                }

                .gemini-main-button::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    border-radius: 50%;
                    background: linear-gradient(135deg, rgba(255,255,255,0.3), rgba(255,255,255,0));
                    opacity: 0;
                    transition: opacity 0.3s;
                }

                .gemini-main-button:hover {
                    transform: scale(1.1);
                    box-shadow: 0 12px 40px rgba(102, 126, 234, 0.6);
                }

                .gemini-main-button:hover::before {
                    opacity: 1;
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
                    0%, 100% { 
                        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
                        transform: scale(1);
                    }
                    50% { 
                        box-shadow: 0 4px 24px rgba(239, 68, 68, 0.8);
                        transform: scale(1.05);
                    }
                }

                @keyframes pulse-playing {
                    0%, 100% { 
                        box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
                        transform: scale(1);
                    }
                    50% { 
                        box-shadow: 0 4px 24px rgba(16, 185, 129, 0.8);
                        transform: scale(1.05);
                    }
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
                    0% { transform: scale(0.5); opacity: 0; }
                    25% { opacity: 0.5; }
                    100% { transform: scale(1.3); opacity: 0; }
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

                .gemini-status-indicator {
                    position: absolute;
                    top: -5px;
                    right: -5px;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    background: #94A3B8;
                    border: 2px solid white;
                    transition: all 0.3s ease;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                }

                .gemini-status-indicator.connected {
                    background: linear-gradient(135deg, #10b981, #059669);
                    box-shadow: 0 2px 8px rgba(16, 185, 129, 0.5);
                }

                .gemini-status-indicator.error {
                    background: linear-gradient(135deg, #ef4444, #dc2626);
                    animation: blink 1s ease-in-out infinite;
                    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.5);
                }

                @keyframes blink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }

                /* ============================================ */
                /* EXPANDED WIDGET - PREMIUM DESIGN */
                /* ============================================ */
                .gemini-widget-expanded {
                    position: absolute;
                    bottom: 70px;
                    right: 0;
                    width: 400px;
                    height: 0;
                    opacity: 0;
                    pointer-events: none;
                    background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border-radius: 28px;
                    box-shadow: 
                        0 20px 60px rgba(0, 0, 0, 0.15),
                        0 0 0 1px rgba(255, 255, 255, 0.5),
                        inset 0 1px 0 rgba(255, 255, 255, 0.8);
                    overflow: hidden;
                    transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
                    display: flex;
                    flex-direction: column;
                }

                .gemini-widget-container.active .gemini-widget-expanded {
                    height: 520px;
                    opacity: 1;
                    pointer-events: all;
                }

                .gemini-widget-container.active .gemini-main-button {
                    transform: scale(0.85);
                }

                /* Header */
                .gemini-widget-header {
                    padding: 24px 28px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-radius: 28px 28px 0 0;
                    position: relative;
                    overflow: hidden;
                }

                .gemini-widget-header::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: linear-gradient(135deg, rgba(255,255,255,0.2), transparent);
                    pointer-events: none;
                }

                .gemini-widget-title {
                    font-weight: 600;
                    font-size: 19px;
                    letter-spacing: 0.2px;
                    position: relative;
                    z-index: 1;
                    white-space: nowrap;
                }

                .gemini-widget-close {
                    background: rgba(255, 255, 255, 0.25);
                    backdrop-filter: blur(10px);
                    border: none;
                    color: white;
                    font-size: 20px;
                    cursor: pointer;
                    width: 36px;
                    height: 36px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                    position: relative;
                    z-index: 1;
                }

                .gemini-widget-close:hover {
                    background: rgba(255, 255, 255, 0.35);
                    transform: scale(1.1) rotate(90deg);
                }

                /* ============================================ */
                /* WIDGET CONTENT - MODERN GRADIENT MESH */
                /* ============================================ */
                .gemini-widget-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
                    position: relative;
                    padding: 40px 20px 20px;
                    overflow: hidden;
                }

                /* Animated background mesh */
                .gemini-widget-content::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: 
                        radial-gradient(circle at 20% 30%, rgba(102, 126, 234, 0.08) 0%, transparent 50%),
                        radial-gradient(circle at 80% 70%, rgba(118, 75, 162, 0.08) 0%, transparent 50%);
                    animation: mesh-float 8s ease-in-out infinite;
                    pointer-events: none;
                }

                @keyframes mesh-float {
                    0%, 100% { transform: translate(0, 0) scale(1); }
                    33% { transform: translate(10px, -10px) scale(1.05); }
                    66% { transform: translate(-10px, 10px) scale(0.95); }
                }

                /* ============================================ */
                /* PREMIUM MAIN CIRCLE */
                /* ============================================ */
                .gemini-main-circle {
                    width: 220px;
                    height: 220px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%);
                    box-shadow: 
                        0 20px 40px rgba(59, 130, 246, 0.15),
                        inset 0 2px 10px rgba(255, 255, 255, 0.8),
                        inset 0 -2px 10px rgba(0, 0, 0, 0.05);
                    position: relative;
                    overflow: visible;
                    transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                /* Pulsating rings */
                .gemini-main-circle::before,
                .gemini-main-circle::after {
                    content: '';
                    position: absolute;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: 3px solid rgba(59, 130, 246, 0.3);
                    animation: pulse-ring 3s ease-out infinite;
                }

                .gemini-main-circle::after {
                    animation-delay: 1.5s;
                }

                @keyframes pulse-ring {
                    0% {
                        transform: scale(0.95);
                        opacity: 1;
                    }
                    100% {
                        transform: scale(1.3);
                        opacity: 0;
                    }
                }

                /* Glassmorphism inner glow */
                .gemini-main-circle-inner {
                    position: absolute;
                    width: 90%;
                    height: 90%;
                    border-radius: 50%;
                    background: rgba(255, 255, 255, 0.4);
                    backdrop-filter: blur(10px);
                    box-shadow: 
                        inset 0 2px 8px rgba(255, 255, 255, 0.9),
                        inset 0 -2px 8px rgba(0, 0, 0, 0.05);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                /* State: Listening (Blue) */
                .gemini-main-circle.listening {
                    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                    box-shadow: 
                        0 0 40px rgba(59, 130, 246, 0.6),
                        0 20px 40px rgba(59, 130, 246, 0.3),
                        inset 0 2px 10px rgba(255, 255, 255, 0.5);
                    animation: breathing 3s ease-in-out infinite;
                }

                .gemini-main-circle.listening::before,
                .gemini-main-circle.listening::after {
                    border-color: rgba(59, 130, 246, 0.5);
                }

                @keyframes breathing {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                }

                /* State: Speaking (Green) */
                .gemini-main-circle.speaking {
                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                    box-shadow: 
                        0 0 40px rgba(16, 185, 129, 0.6),
                        0 20px 40px rgba(16, 185, 129, 0.3),
                        inset 0 2px 10px rgba(255, 255, 255, 0.5);
                    animation: speaking-pulse 1.5s ease-in-out infinite;
                }

                .gemini-main-circle.speaking::before,
                .gemini-main-circle.speaking::after {
                    border-color: rgba(16, 185, 129, 0.5);
                }

                @keyframes speaking-pulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.08); }
                }

                /* Microphone Icon */
                .gemini-mic-icon {
                    color: #3b82f6;
                    font-size: 48px;
                    z-index: 10;
                    transition: all 0.3s ease;
                    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.1));
                }

                .gemini-main-circle.listening .gemini-mic-icon {
                    color: #ffffff;
                    transform: scale(1.1);
                }

                .gemini-main-circle.speaking .gemini-mic-icon {
                    color: #ffffff;
                    animation: mic-bounce 0.5s ease infinite;
                }

                @keyframes mic-bounce {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(-5px); }
                }

                /* ============================================ */
                /* AUDIO VISUALIZATION */
                /* ============================================ */
                .gemini-audio-visualization {
                    position: absolute;
                    width: 100%;
                    max-width: 200px;
                    height: 40px;
                    bottom: -10px;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.3s;
                }

                .gemini-main-circle.listening .gemini-audio-visualization,
                .gemini-main-circle.speaking .gemini-audio-visualization {
                    opacity: 1;
                }

                .gemini-audio-bars {
                    display: flex;
                    align-items: flex-end;
                    height: 40px;
                    gap: 3px;
                    width: 100%;
                    justify-content: center;
                }

                .gemini-audio-bar {
                    width: 4px;
                    height: 3px;
                    background: linear-gradient(180deg, #3b82f6, #2563eb);
                    border-radius: 2px;
                    transition: height 0.1s ease;
                    box-shadow: 0 2px 6px rgba(59, 130, 246, 0.4);
                }

                .gemini-main-circle.speaking .gemini-audio-bar {
                    background: linear-gradient(180deg, #10b981, #059669);
                    box-shadow: 0 2px 6px rgba(16, 185, 129, 0.4);
                }

                /* ============================================ */
                /* MESSAGE DISPLAY - HIDDEN */
                /* ============================================ */
                .gemini-message-display {
                    display: none !important;
                }

                /* ============================================ */
                /* STATUS INFO */
                /* ============================================ */
                .gemini-status-info {
                    position: absolute;
                    bottom: 70px;
                    left: 50%;
                    transform: translateX(-50%);
                    font-size: 13px;
                    font-weight: 500;
                    color: #64748b;
                    padding: 8px 16px;
                    border-radius: 20px;
                    background: rgba(255, 255, 255, 0.9);
                    backdrop-filter: blur(10px);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    opacity: 0;
                    transition: all 0.3s;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
                    border: 1px solid rgba(255, 255, 255, 0.5);
                }

                .gemini-status-info.show {
                    opacity: 1;
                }

                .gemini-status-dot {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #10b981, #059669);
                    box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
                    animation: dot-pulse 2s ease-in-out infinite;
                }

                @keyframes dot-pulse {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.2); opacity: 0.8; }
                }

                .gemini-status-dot.disconnected {
                    background: linear-gradient(135deg, #ef4444, #dc2626);
                    box-shadow: 0 0 10px rgba(239, 68, 68, 0.5);
                }

                .gemini-status-dot.connecting {
                    background: linear-gradient(135deg, #f59e0b, #d97706);
                    box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
                }

                /* ============================================ */
                /* VOICYFY BRANDING */
                /* ============================================ */
                .gemini-voicyfy-container {
                    position: absolute;
                    bottom: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    text-align: center;
                    padding: 8px;
                    opacity: 0.6;
                    transition: all 0.2s ease;
                }

                .gemini-voicyfy-container:hover {
                    opacity: 1;
                    transform: translateX(-50%) translateY(-2px);
                }

                .gemini-voicyfy-link {
                    display: inline-block;
                    text-decoration: none;
                }

                .gemini-voicyfy-link img {
                    height: 32px;
                    width: auto;
                    display: block;
                    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
                }

                /* ============================================ */
                /* ERROR MESSAGE */
                /* ============================================ */
                .gemini-error-message {
                    position: absolute;
                    bottom: 75px;
                    right: 0;
                    background: white;
                    padding: 16px 20px;
                    border-radius: 16px;
                    box-shadow: 0 8px 24px rgba(239, 68, 68, 0.2);
                    max-width: 320px;
                    display: none;
                    animation: slideUp 0.3s ease-out;
                    border-left: 4px solid #ef4444;
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
                    font-weight: 700;
                    font-size: 15px;
                    margin-bottom: 6px;
                }

                .gemini-error-text {
                    color: #64748B;
                    font-size: 13px;
                    line-height: 1.6;
                }

                /* ============================================ */
                /* LOADING SPINNER */
                /* ============================================ */
                .gemini-loader-modal {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(10px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 100;
                    opacity: 0;
                    visibility: hidden;
                    transition: all 0.3s;
                    border-radius: 28px;
                }

                .gemini-loader-modal.active {
                    opacity: 1;
                    visibility: visible;
                }

                .gemini-loader {
                    width: 50px;
                    height: 50px;
                    border: 4px solid rgba(102, 126, 234, 0.2);
                    border-radius: 50%;
                    border-top-color: #667eea;
                    animation: gemini-spin 1s linear infinite;
                }

                @keyframes gemini-spin {
                    to { transform: rotate(360deg); }
                }

                /* ============================================ */
                /* MOBILE RESPONSIVE */
                /* ============================================ */
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
                        max-width: 400px;
                    }

                    .gemini-widget-container.active .gemini-widget-expanded {
                        height: 500px;
                    }

                    .gemini-main-circle {
                        width: 200px;
                        height: 200px;
                    }

                    .gemini-mic-icon {
                        font-size: 42px;
                    }

                    .gemini-error-message {
                        max-width: calc(100vw - 90px);
                    }

                    .gemini-widget-title {
                        font-size: 17px;
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
                    <div class="gemini-widget-title">Голосовой Ассистент</div>
                    <button class="gemini-widget-close" id="gemini-close" title="Закрыть">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <div class="gemini-widget-content">
                    <div class="gemini-main-circle" id="gemini-circle">
                        <div class="gemini-main-circle-inner">
                            <i class="fas fa-microphone gemini-mic-icon"></i>
                        </div>
                        
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
        circle.classList.remove('listening', 'speaking');
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
        // Text output is hidden, but keep function for compatibility
        return;
    }

    function hideMessage() {
        return;
    }

    function createAudioBars(count = 25) {
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
            const height = 3 + Math.min(35, Math.floor(average * 120));
            bars[i].style.height = `${height}px`;
        }
    }

    function resetAudioVisualization() {
        const bars = document.querySelectorAll('.gemini-audio-bar');
        bars.forEach(bar => {
            bar.style.height = '3px';
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

        createAudioBars(25);
        
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
                    // Text output hidden
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
            
            // ✅ Визуализация аудио ответа ассистента
            updateAudioVisualization(audioData);
            
            if (STATE.audioStreamNode) {
                STATE.audioStreamNode.port.postMessage({
                    type: 'audioData',
                    buffer: audioData
                });
            }
            
            if (!STATE.isPlaying) {
                console.log('[GEMINI-WIDGET] 🎵 Starting real-time stream');
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
        resetAudioVisualization();
        
        if (!STATE.isRecording) {
            updateUI('connected');
        }
        
        console.log('[GEMINI-WIDGET] 📊 Audio chunks processed:', STATE.audioChunksProcessed);
        STATE.audioChunksProcessed = 0;
    }

    function handleInterruption() {
        console.log('[GEMINI-WIDGET] ⚡ Interrupted');
        stopPlayback();
        STATE.isSpeaking = false;
        STATE.audioBufferCommitted = false;
        
        if (STATE.isRecording) {
            updateUI('recording');
        } else {
            updateUI('connected');
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
                console.log('[GEMINI-WIDGET] 🎙️ Using AudioWorklet');
                await startAudioWorkletRecording(source);
            } else {
                console.log('[GEMINI-WIDGET] 🎙️ Using ScriptProcessor');
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
    // AUDIO PLAYBACK
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
    // AUDIO UTILITIES
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

    console.log('[GEMINI-WIDGET] 🚀 Script loaded v2.7.1 (PREMIUM UI)');

})();
