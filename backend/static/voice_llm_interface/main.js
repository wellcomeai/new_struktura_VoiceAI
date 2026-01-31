/* ============================================================ */
/* JARVIS AI - Main Application                                 */
/* Voice LLM Interface - Voicyfy                                */
/* Version: 4.3                                                 */
/* ============================================================ */

'use strict';

// ============================================================================
// GET MODULES
// ============================================================================

const Config = window.JarvisConfig;
const Audio = window.JarvisAudio;

const {
    DEBUG_MODE,
    MAX_RECONNECT_ATTEMPTS,
    MOBILE_MAX_RECONNECT_ATTEMPTS,
    PING_INTERVAL,
    MOBILE_PING_INTERVAL,
    STORAGE_KEY_ASSISTANT,
    HISTORY_STORAGE_KEY,
    MAX_HISTORY_PAIRS,
    SERVER_URL,
    isMobile,
    log
} = Config;

// ============================================================================
// APPLICATION STATE
// ============================================================================

const urlParams = new URLSearchParams(window.location.search);
let ASSISTANT_ID = urlParams.get('assistant') || null;
let userActivated = false;

// Connection state
window.websocket = null;
let llmWebSocket = null;
window.isConnected = false;
let isLLMConnected = false;
let reconnectAttempts = 0;
let pingInterval = null;
let lastPongTime = Date.now();
window.isReconnecting = false;

// LLM state
window.isStreamingLLM = false;
let streamingContent = "";
let currentRequestId = null;
let currentLLMContent = '';

// Three.js state
let threeScene, threeCamera, threeRenderer, threeParticles;
let threeInitialized = false;

// ============================================================================
// DOM READY
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    log('🚀 JARVIS AI Interface v4.3 Starting...');
    log(`   Mode: Gemini Voice (WS1) + LLM Text (WS2)`);
    log(`   Mute: Enabled`);
    log(`   Assistant ID: ${ASSISTANT_ID || 'Not configured'}`);

    initializeApp();
});

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeApp() {
    // Cache DOM elements
    const elements = cacheElements();
    
    // Setup event listeners
    setupEventListeners(elements);
    
    // Initialize visualizer
    Audio.createCircularVisualizer();
    
    // Initialize Three.js background
    initThreeJS();
    
    // Load assistants if not in embed mode
    const isEmbedMode = urlParams.has('assistant');
    if (!isEmbedMode) {
        loadGeminiAssistantsList();
    } else {
        log('📦 Running in EMBED mode');
    }
    
    // Initialize chat history
    updateContextInfo();
    renderChatHistory();
    
    // Set initial status
    updateStatus('connecting', 'Нажмите чтобы начать', 'connecting');
}

function cacheElements() {
    return {
        startOverlay: document.getElementById('startOverlay'),
        startButton: document.getElementById('startButton'),
        assistantSelect: document.getElementById('assistantSelect'),
        saveBtn: document.getElementById('saveBtn'),
        testBtn: document.getElementById('testBtn'),
        copyBtn: document.getElementById('copyBtn'),
        successMessage: document.getElementById('successMessage'),
        mobileMenuToggle: document.getElementById('mobile-menu-toggle'),
        sidebar: document.getElementById('sidebar'),
        sidebarOverlay: document.getElementById('sidebar-overlay'),
        jarvisSphere: document.getElementById('jarvisSphere'),
        muteButton: document.getElementById('muteButton'),
        llmContent: document.getElementById('llmContent'),
        llmMeta: document.getElementById('llmMeta'),
        voiceStatus: document.getElementById('voiceStatus'),
        statusText: document.getElementById('statusText'),
        errorContainer: document.getElementById('errorContainer'),
        chatInput: document.getElementById('chatInput'),
        chatSendBtn: document.getElementById('chatSendBtn'),
        clearHistoryBtn: document.getElementById('clearHistoryBtn'),
        hudFrames: [
            document.getElementById('hudTL'),
            document.getElementById('hudTR'),
            document.getElementById('hudBL'),
            document.getElementById('hudBR')
        ]
    };
}

function setupEventListeners(el) {
    // Start overlay
    if (el.startButton) {
        el.startButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            activateAudioAndStart();
        });
    }
    
    if (el.startOverlay) {
        el.startOverlay.addEventListener('click', function(e) {
            if (e.target === el.startOverlay) {
                activateAudioAndStart();
            }
        });
    }
    
    // Mute button
    if (el.muteButton) {
        el.muteButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            Audio.toggleMute();
        });
    }
    
    // Sphere click
    if (el.jarvisSphere) {
        el.jarvisSphere.addEventListener('click', handleSphereClick);
    }
    
    // Config buttons
    if (el.saveBtn) {
        el.saveBtn.addEventListener('click', saveConfig);
    }
    if (el.testBtn) {
        el.testBtn.addEventListener('click', testAgent);
    }
    if (el.copyBtn) {
        el.copyBtn.addEventListener('click', copyHTMLCode);
    }
    
    // Copy LLM response
    const copyLlmButton = document.getElementById('copyLlmButton');
    if (copyLlmButton) {
        copyLlmButton.addEventListener('click', copyLLMResponse);
    }
    
    // Mobile menu
    if (el.mobileMenuToggle) {
        el.mobileMenuToggle.addEventListener('click', function() {
            el.sidebar.classList.toggle('mobile-open');
            el.sidebarOverlay.classList.toggle('show');
        });
    }
    
    if (el.sidebarOverlay) {
        el.sidebarOverlay.addEventListener('click', function() {
            el.sidebar.classList.remove('mobile-open');
            el.sidebarOverlay.classList.remove('show');
        });
    }
    
    // Chat input
    if (el.chatInput && el.chatSendBtn) {
        el.chatInput.addEventListener('input', function() {
            el.chatSendBtn.disabled = !this.value.trim() || !isLLMConnected || window.isStreamingLLM;
        });
        
        el.chatInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!el.chatSendBtn.disabled) {
                    sendTextMessage();
                }
            }
        });
        
        el.chatSendBtn.addEventListener('click', sendTextMessage);
    }
    
    // Clear history
    if (el.clearHistoryBtn) {
        el.clearHistoryBtn.addEventListener('click', clearChatHistory);
    }
    
    // Window resize for Three.js
    window.addEventListener('resize', handleWindowResize);
}

// ============================================================================
// USER ACTIVATION
// ============================================================================

async function activateAudioAndStart() {
    log('🎬 User activation triggered');
    
    try {
        const audioSuccess = await Audio.initializeAudio();
        if (!audioSuccess) {
            log('❌ Audio initialization failed', 'error');
        }
        
        Audio.initPlaybackAudioContext();
        userActivated = true;
        
        const startOverlay = document.getElementById('startOverlay');
        if (startOverlay) {
            startOverlay.classList.add('hidden');
        }
        
        log('✅ Overlay hidden, audio activated');
        
        if (ASSISTANT_ID) {
            log('🔌 Connecting WebSocket after user activation...');
            connectWebSocket();
        } else {
            updateStatus('connecting', 'Выберите Gemini ассистента', 'connecting');
        }
        
    } catch (error) {
        log(`❌ Activation error: ${error}`, 'error');
        const startOverlay = document.getElementById('startOverlay');
        if (startOverlay) {
            startOverlay.classList.add('hidden');
        }
        userActivated = true;
    }
}

// ============================================================================
// SPHERE CLICK HANDLER
// ============================================================================

async function handleSphereClick() {
    if (!userActivated) {
        const startOverlay = document.getElementById('startOverlay');
        if (startOverlay) {
            startOverlay.classList.remove('hidden');
        }
        return;
    }
    
    if (!window.audioInitialized) {
        const success = await Audio.initializeAudio();
        if (!success) return;
    }
    
    Audio.initPlaybackAudioContext();
    
    const isListening = Audio.getIsListening();
    const isPlayingAudio = Audio.getIsPlayingAudio();
    const isMuted = Audio.getMuteState();
    
    if (!isListening && !isPlayingAudio && !window.isReconnecting && !window.isStreamingLLM && !isMuted) {
        if (window.isConnected) {
            Audio.startListening();
        } else {
            connectWebSocket();
        }
    }
}

// ============================================================================
// ASSISTANT MANAGEMENT
// ============================================================================

async function loadGeminiAssistantsList() {
    const assistantSelect = document.getElementById('assistantSelect');
    const testBtn = document.getElementById('testBtn');
    const copyBtn = document.getElementById('copyBtn');
    
    try {
        log('📋 Loading Gemini assistants...');
        
        const response = await fetch(`${SERVER_URL}/api/gemini-assistants`, {
            headers: {
                'Authorization': `Bearer ${getAuthToken()}`
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to load Gemini assistants');
        }
        
        const assistants = await response.json();
        log(`   Loaded: ${assistants.length} assistants`);
        
        assistantSelect.innerHTML = '<option value="">-- Выберите Gemini ассистента --</option>';
        
        assistants.forEach(assistant => {
            const option = document.createElement('option');
            option.value = assistant.id;
            option.textContent = `💎 ${assistant.name || assistant.id}`;
            assistantSelect.appendChild(option);
        });
        
        // Restore from URL or localStorage
        if (ASSISTANT_ID && assistantSelect.querySelector(`option[value="${ASSISTANT_ID}"]`)) {
            assistantSelect.value = ASSISTANT_ID;
            testBtn.disabled = false;
            copyBtn.disabled = false;
            log(`   Using assistant from URL: ${ASSISTANT_ID}`);
        } else {
            const savedAssistantId = localStorage.getItem(STORAGE_KEY_ASSISTANT);
            if (savedAssistantId && assistantSelect.querySelector(`option[value="${savedAssistantId}"]`)) {
                assistantSelect.value = savedAssistantId;
                ASSISTANT_ID = savedAssistantId;
                testBtn.disabled = false;
                copyBtn.disabled = false;
                log(`   Restored from localStorage: ${savedAssistantId}`);
            }
        }
        
    } catch (error) {
        log(`❌ Error loading assistants: ${error}`, 'error');
        assistantSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
    }
}

function getAuthToken() {
    return localStorage.getItem('auth_token') ||
           document.cookie.split('; ').find(row => row.startsWith('auth_token='))?.split('=')[1] ||
           '';
}

// ============================================================================
// CONFIG ACTIONS
// ============================================================================

async function saveConfig() {
    const assistantSelect = document.getElementById('assistantSelect');
    const saveBtn = document.getElementById('saveBtn');
    const testBtn = document.getElementById('testBtn');
    const copyBtn = document.getElementById('copyBtn');
    
    const selectedAssistantId = assistantSelect.value;

    if (!selectedAssistantId) {
        alert('❌ Пожалуйста, выберите Gemini ассистента!');
        return;
    }

    try {
        setLoading(true);
        ASSISTANT_ID = selectedAssistantId;
        localStorage.setItem(STORAGE_KEY_ASSISTANT, selectedAssistantId);
        log(`💾 Assistant saved: ${selectedAssistantId}`);

        testBtn.disabled = false;
        copyBtn.disabled = false;
        showSuccess('✅ Gemini ассистент сохранён!');

        if (userActivated) {
            if (window.websocket) window.websocket.close();
            if (llmWebSocket) {
                llmWebSocket.close();
                llmWebSocket = null;
                isLLMConnected = false;
            }
            connectWebSocket();
        }

    } catch (error) {
        log(`❌ Save error: ${error}`, 'error');
        alert('❌ Ошибка: ' + error.message);
    } finally {
        setLoading(false);
    }
}

function testAgent() {
    if (!ASSISTANT_ID) {
        alert('❌ Сначала выберите ассистента!');
        return;
    }

    if (!userActivated) {
        const startOverlay = document.getElementById('startOverlay');
        if (startOverlay) {
            startOverlay.classList.remove('hidden');
        }
        return;
    }

    if (!window.isConnected) {
        showSuccess('🔄 Подключение к Gemini...');
        connectWebSocket();
    } else {
        showSuccess('✅ Готов! Нажмите на сферу и говорите');
    }
}

function copyHTMLCode() {
    if (!ASSISTANT_ID) {
        alert('❌ Сначала выберите ассистента!');
        return;
    }

    const embedUrl = `${SERVER_URL}/static/voice_llm_interface/?assistant=${ASSISTANT_ID}`;
    const embedCode = `<!-- Voicyfy JARVIS AI (Gemini) Widget -->
<iframe
    src="${embedUrl}"
    width="100%"
    height="800px"
    frameborder="0"
    allow="microphone"
    style="border-radius: 16px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);">
</iframe>`;

    navigator.clipboard.writeText(embedCode).then(() => {
        showSuccess('✅ Код скопирован в буфер обмена!');
    }).catch(() => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = embedCode;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showSuccess('✅ Код скопирован!');
    });
}

function setLoading(isLoading) {
    const saveBtn = document.getElementById('saveBtn');
    const testBtn = document.getElementById('testBtn');
    const copyBtn = document.getElementById('copyBtn');
    
    if (isLoading) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение...';
        testBtn.disabled = true;
        copyBtn.disabled = true;
    } else {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Сохранить';
    }
}

// ============================================================================
// UI HELPERS
// ============================================================================

function showSuccess(message) {
    const successMessage = document.getElementById('successMessage');
    const successText = document.getElementById('successText');
    
    if (successText) successText.textContent = message;
    if (successMessage) {
        successMessage.classList.add('show');
        setTimeout(() => successMessage.classList.remove('show'), 3000);
    }
}

function showError(title, text) {
    const errorContainer = document.getElementById('errorContainer');
    const errorTitle = document.getElementById('errorTitle');
    const errorText = document.getElementById('errorText');
    
    if (errorTitle) errorTitle.textContent = title;
    if (errorText) errorText.textContent = text;
    if (errorContainer) errorContainer.classList.add('active');
}

window.updateStatus = function(status, text, className) {
    const statusText = document.getElementById('statusText');
    const voiceStatus = document.getElementById('voiceStatus');
    
    if (statusText) statusText.textContent = text;
    if (voiceStatus) voiceStatus.className = `voice-status ${className}`;
};

// ============================================================================
// CHAT HISTORY (sessionStorage)
// ============================================================================

function loadChatHistory() {
    try {
        const saved = sessionStorage.getItem(HISTORY_STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch (e) {
        log(`Chat history load error: ${e}`, 'error');
        return [];
    }
}

function saveChatHistory(history) {
    try {
        sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        log(`Chat history save error: ${e}`, 'error');
    }
}

function addToHistory(role, content) {
    const history = loadChatHistory();
    history.push({ role, content, timestamp: Date.now() });
    
    // Keep only last N pairs
    while (history.length > MAX_HISTORY_PAIRS * 2) {
        history.shift();
    }
    
    saveChatHistory(history);
    updateContextInfo();
    return history;
}

function clearChatHistory() {
    sessionStorage.removeItem(HISTORY_STORAGE_KEY);
    updateContextInfo();
    renderChatHistory();
    showSuccess('🗑️ История очищена');
}

function updateContextInfo() {
    const history = loadChatHistory();
    const pairs = Math.floor(history.length / 2);
    const contextInfo = document.getElementById('chatContextInfo');
    const clearBtn = document.getElementById('clearHistoryBtn');
    
    if (contextInfo) {
        contextInfo.textContent = `Контекст: ${pairs}/${MAX_HISTORY_PAIRS} сообщений`;
    }
    if (clearBtn) {
        clearBtn.style.display = history.length > 0 ? 'block' : 'none';
    }
}

function renderChatHistory() {
    const history = loadChatHistory();
    const llmContent = document.getElementById('llmContent');
    const placeholder = document.getElementById('llmPlaceholder');
    
    if (history.length === 0) {
        if (placeholder) {
            llmContent.innerHTML = '';
            llmContent.appendChild(placeholder);
            placeholder.style.display = 'flex';
        }
        return;
    }
    
    if (placeholder) placeholder.style.display = 'none';
    
    let html = '';
    history.forEach(msg => {
        const roleLabel = msg.role === 'user' ? 'Вы' : 'ИИ';
        html += `
            <div class="chat-message ${msg.role}">
                <div class="chat-message-role">${roleLabel}</div>
                <div class="chat-message-content">${formatMarkdown(msg.content)}</div>
            </div>
        `;
    });
    
    llmContent.innerHTML = html;
    llmContent.scrollTop = llmContent.scrollHeight;
}

// ============================================================================
// TEXT CHAT
// ============================================================================

function sendTextMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message) return;
    if (!isLLMConnected) {
        showSuccess('❌ LLM не подключен');
        return;
    }
    if (window.isStreamingLLM) {
        showSuccess('⏳ Дождитесь завершения ответа');
        return;
    }
    
    // Add user message to history
    addToHistory('user', message);
    
    // Clear input
    input.value = '';
    input.disabled = true;
    document.getElementById('chatSendBtn').disabled = true;
    
    // Start streaming UI
    startStreamingUI(message);
    
    // Get history for context (without current message)
    const history = loadChatHistory();
    const contextHistory = history.slice(0, -1);
    
    // Send to WebSocket
    llmWebSocket.send(JSON.stringify({
        type: 'llm.query',
        query: message,
        history: contextHistory,
        request_id: `text_${Date.now()}`
    }));
    
    log(`📝 Sent text message with ${contextHistory.length} history items`);
}

// ============================================================================
// LLM STREAMING
// ============================================================================

function startStreamingUI(query) {
    log(`📝 Starting LLM streaming for: ${query.substring(0, 50)}...`);
    
    window.isStreamingLLM = true;
    streamingContent = "";
    
    const jarvisSphere = document.getElementById('jarvisSphere');
    if (jarvisSphere) {
        jarvisSphere.classList.remove('listening', 'speaking', 'processing', 'muted');
        jarvisSphere.classList.add('streaming');
    }
    
    updateStatus('streaming', 'Генерация ответа...', 'streaming');
    
    const llmMeta = document.getElementById('llmMeta');
    if (llmMeta) llmMeta.textContent = 'Streaming...';
    
    // Render history + streaming message
    appendStreamingMessage();
    
    const copyButton = document.getElementById('copyLlmButton');
    if (copyButton) copyButton.style.display = 'none';
}

function appendStreamingMessage() {
    const llmContent = document.getElementById('llmContent');
    const placeholder = document.getElementById('llmPlaceholder');
    
    if (placeholder) placeholder.style.display = 'none';
    
    const history = loadChatHistory();
    let html = '';
    
    history.forEach(msg => {
        const roleLabel = msg.role === 'user' ? 'Вы' : 'ИИ';
        html += `
            <div class="chat-message ${msg.role}">
                <div class="chat-message-role">${roleLabel}</div>
                <div class="chat-message-content">${formatMarkdown(msg.content)}</div>
            </div>
        `;
    });
    
    // Add streaming container
    html += `
        <div class="chat-message assistant streaming" id="streamingMessage">
            <div class="chat-message-role">ИИ</div>
            <div class="chat-message-content" id="streamingText"></div>
            <span class="streaming-cursor"></span>
        </div>
    `;
    
    llmContent.innerHTML = html;
    llmContent.scrollTop = llmContent.scrollHeight;
}

function appendStreamingText(content) {
    if (!window.isStreamingLLM) return;
    streamingContent += content;
    
    const streamingText = document.getElementById('streamingText');
    const llmContent = document.getElementById('llmContent');
    
    if (streamingText) {
        streamingText.innerHTML = formatMarkdown(streamingContent);
        if (llmContent) llmContent.scrollTop = llmContent.scrollHeight;
    }
}

function finishStreamingUI(data) {
    log('✅ LLM streaming finished');
    
    window.isStreamingLLM = false;
    
    const jarvisSphere = document.getElementById('jarvisSphere');
    if (jarvisSphere) {
        jarvisSphere.classList.remove('streaming');
        if (Audio.getMuteState()) {
            jarvisSphere.classList.add('muted');
        }
    }
    
    const isMuted = Audio.getMuteState();
    if (isMuted) {
        updateStatus('muted', 'Микрофон отключён', 'muted');
    } else {
        updateStatus('connected', 'Готов', 'connected');
    }
    
    const fullContent = data.full_content || streamingContent;
    
    // Save AI response to history
    addToHistory('assistant', fullContent);
    
    // Render full history
    renderChatHistory();
    
    // Unlock input
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    if (input) {
        input.disabled = false;
        input.focus();
    }
    if (sendBtn) {
        sendBtn.disabled = !input || !input.value.trim();
    }
    
    const llmMeta = document.getElementById('llmMeta');
    if (llmMeta && data.duration_ms) {
        const seconds = (data.duration_ms / 1000).toFixed(1);
        llmMeta.textContent = `${data.model || 'gpt-4o-mini'} • ${seconds}s`;
    }
    
    // Show copy button
    const copyButton = document.getElementById('copyLlmButton');
    if (copyButton) copyButton.style.display = 'flex';
    
    currentLLMContent = formatMarkdown(fullContent);
    
    streamingContent = "";
    currentRequestId = null;
}

function showStreamingError(message) {
    log(`❌ LLM streaming error: ${message}`, 'error');
    
    window.isStreamingLLM = false;
    streamingContent = "";
    
    const jarvisSphere = document.getElementById('jarvisSphere');
    if (jarvisSphere) {
        jarvisSphere.classList.remove('streaming');
        if (Audio.getMuteState()) {
            jarvisSphere.classList.add('muted');
        }
    }
    
    updateStatus('error', 'Ошибка', 'error');
    
    // Show history + error
    const history = loadChatHistory();
    const llmContent = document.getElementById('llmContent');
    const llmMeta = document.getElementById('llmMeta');
    
    let html = '';
    history.forEach(msg => {
        const roleLabel = msg.role === 'user' ? 'Вы' : 'ИИ';
        html += `
            <div class="chat-message ${msg.role}">
                <div class="chat-message-role">${roleLabel}</div>
                <div class="chat-message-content">${formatMarkdown(msg.content)}</div>
            </div>
        `;
    });
    
    html += `
        <div class="llm-error">
            <div class="llm-error-icon">❌</div>
            <div class="llm-error-title">Ошибка генерации</div>
            <div class="llm-error-text">${message}</div>
        </div>
    `;
    
    if (llmContent) llmContent.innerHTML = html;
    if (llmMeta) llmMeta.textContent = 'Ошибка';
    
    // Unlock input
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    if (input) {
        input.disabled = false;
        input.focus();
    }
    if (sendBtn) {
        sendBtn.disabled = !input || !input.value.trim() || !isLLMConnected;
    }
    
    setTimeout(() => {
        const isMuted = Audio.getMuteState();
        if (isMuted) {
            updateStatus('muted', 'Микрофон отключён', 'muted');
        } else {
            updateStatus('connected', 'Готов', 'connected');
        }
    }, 3000);
}

// ============================================================================
// TEXT FORMATTING
// ============================================================================

function formatMarkdown(text) {
    if (!text) return '<p>Нет контента</p>';
    return text
        .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        .replace(/^\* (.+)$/gim, '<li>$1</li>')
        .replace(/^- (.+)$/gim, '<li>$1</li>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
}

function copyLLMResponse() {
    if (!currentLLMContent) {
        showSuccess('❌ Нет контента для копирования');
        return;
    }

    const copyButton = document.getElementById('copyLlmButton');
    const copyButtonText = document.getElementById('copyButtonText');
    const copyIcon = copyButton ? copyButton.querySelector('i') : null;

    // Convert HTML to plain text
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = currentLLMContent;
    const plainText = tempDiv.textContent || tempDiv.innerText || '';

    navigator.clipboard.writeText(plainText).then(() => {
        if (copyButton) copyButton.classList.add('copied');
        if (copyIcon) copyIcon.className = 'fas fa-check';
        if (copyButtonText) copyButtonText.textContent = 'Скопировано!';

        setTimeout(() => {
            if (copyButton) copyButton.classList.remove('copied');
            if (copyIcon) copyIcon.className = 'fas fa-copy';
            if (copyButtonText) copyButtonText.textContent = 'Копировать';
        }, 2000);
    }).catch(() => showSuccess('❌ Ошибка копирования'));
}

// ============================================================================
// WEBSOCKET - GEMINI VOICE
// ============================================================================

async function connectWebSocket() {
    if (!ASSISTANT_ID) {
        log('⏳ Waiting for Gemini assistant configuration');
        updateStatus('connecting', 'Выберите Gemini ассистента', 'connecting');
        return;
    }
    
    if (!userActivated) {
        log('⏳ Waiting for user activation');
        return;
    }

    try {
        const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/gemini-browser/' + ASSISTANT_ID;
        
        log(`🔌 Connecting to Gemini WebSocket...`);
        log(`   URL: ${WS_URL}`);
        
        window.isReconnecting = true;
        
        // Close existing connections
        if (window.websocket) {
            try { window.websocket.close(); } catch (e) {}
        }
        
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
        
        window.websocket = new WebSocket(WS_URL);
        window.websocket.binaryType = 'arraybuffer';
        
        window.websocket.onopen = function() {
            log('✅ Gemini WebSocket connected');
            window.isConnected = true;
            window.isReconnecting = false;
            reconnectAttempts = 0;
            
            // Activate HUD
            const hudFrames = document.querySelectorAll('.hud-frame');
            hudFrames.forEach(frame => frame.classList.add('active'));
            
            const isMuted = Audio.getMuteState();
            if (isMuted) {
                updateStatus('muted', 'Микрофон отключён', 'muted');
            } else {
                updateStatus('connected', 'Готов', 'connected');
            }
            
            // Connect LLM WebSocket
            connectLLMWebSocket();
            
            // Start listening (if not muted)
            setTimeout(() => {
                if (!Audio.getMuteState()) {
                    Audio.startListening();
                }
            }, 500);
            
            // Setup ping
            const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
            pingInterval = setInterval(() => {
                if (window.websocket && window.websocket.readyState === WebSocket.OPEN) {
                    window.websocket.send(JSON.stringify({ type: "ping" }));
                }
            }, pingIntervalTime);
        };
        
        window.websocket.onmessage = handleGeminiMessage;
        
        window.websocket.onclose = function(event) {
            log(`🔌 WebSocket closed: ${event.code}`);
            window.isConnected = false;
            Audio.stopListening();
            
            if (pingInterval) {
                clearInterval(pingInterval);
                pingInterval = null;
            }
            
            if (event.code === 1000 || event.code === 1001) return;
            
            // Reconnect logic
            const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
            if (reconnectAttempts < maxAttempts && userActivated) {
                reconnectAttempts++;
                const delay = Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
                log(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxAttempts})`);
                updateStatus('connecting', 'Переподключение...', 'connecting');
                setTimeout(() => connectWebSocket(), delay);
            } else {
                updateStatus('error', 'Ошибка подключения', 'error');
                showError('Ошибка подключения', 'Не удалось подключиться к серверу. Обновите страницу.');
            }
        };
        
        window.websocket.onerror = function(error) {
            log(`❌ WebSocket error: ${error}`, 'error');
        };
        
        return true;
        
    } catch (error) {
        log(`❌ Connection error: ${error}`, 'error');
        window.isReconnecting = false;
        return false;
    }
}

function handleGeminiMessage(event) {
    try {
        if (event.data instanceof Blob || !event.data) return;

        try {
            const data = JSON.parse(event.data);
            lastPongTime = Date.now();
            
            // LLM request from voice
            if (data.type === 'llm.request') {
                log(`📝 LLM request received: ${data.query}`);
                startStreamingUI(data.query);
                sendLLMQuery(data.query, data.request_id);
                return;
            }
            
            // LLM streaming events
            if (data.type === 'llm.stream.start') {
                currentRequestId = data.request_id;
                startStreamingUI(data.query);
                return;
            }
            
            if (data.type === 'llm.stream.delta') {
                if (data.request_id === currentRequestId || !currentRequestId) {
                    appendStreamingText(data.content);
                }
                return;
            }
            
            if (data.type === 'llm.stream.done') {
                finishStreamingUI(data);
                return;
            }
            
            if (data.type === 'llm.stream.error') {
                showStreamingError(data.message);
                return;
            }
            
            // Connection status
            if (data.type === 'connection_status') {
                log(`Gemini connection: ${data.status}`);
                if (data.status === 'connected') {
                    const isMuted = Audio.getMuteState();
                    if (isMuted) {
                        updateStatus('muted', 'Микрофон отключён', 'muted');
                    } else {
                        updateStatus('connected', 'Gemini готов', 'connected');
                    }
                }
                return;
            }
            
            if (data.type === 'gemini.setup.complete') {
                log('Gemini setup complete');
                return;
            }
            
            // Function calls
            if (data.type === 'function_call.executing') {
                log(`🔧 Function executing: ${data.function}`);
                if (data.function === 'query_llm') {
                    updateStatus('processing', 'Запрос к ИИ...', 'processing');
                    const jarvisSphere = document.getElementById('jarvisSphere');
                    if (jarvisSphere) jarvisSphere.classList.add('processing');
                }
                return;
            }
            
            if (data.type === 'function_call.completed') {
                log(`✅ Function completed: ${data.function}`);
                return;
            }
            
            // Audio playback
            if (data.type === 'response.audio.delta') {
                if (data.delta) Audio.addAudioChunkToBuffer(data.delta);
                return;
            }
            
            if (data.type === 'assistant.speech.started') {
                log('🔊 Assistant started speaking');
                return;
            }
            
            if (data.type === 'assistant.speech.ended') {
                log('🔇 Assistant speech ended (server)');
                return;
            }
            
            if (data.type === 'response.done') return;
            
            // Transcriptions
            if (data.type === 'input.transcription') {
                log(`👤 User: ${data.text}`);
                return;
            }
            
            if (data.type === 'output.transcription') {
                log(`🤖 Gemini: ${data.text}`);
                return;
            }
            
            // Errors
            if (data.type === 'error') {
                log(`Gemini API Error: ${JSON.stringify(data.error)}`, 'error');
                
                if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                    const isPlayingAudio = Audio.getIsPlayingAudio();
                    const isMuted = Audio.getMuteState();
                    if (!isPlayingAudio && !window.isReconnecting && !window.isStreamingLLM && !isMuted) {
                        setTimeout(() => Audio.startListening(), 500);
                    }
                    return;
                }
                
                updateStatus('error', 'Ошибка', 'error');
                return;
            }
            
        } catch (parseError) {
            if (event.data === 'pong') {
                lastPongTime = Date.now();
            }
        }
    } catch (generalError) {
        log(`Message processing error: ${generalError.message}`, "error");
    }
}

// ============================================================================
// WEBSOCKET - LLM TEXT
// ============================================================================

function connectLLMWebSocket() {
    if (llmWebSocket && llmWebSocket.readyState === WebSocket.OPEN) {
        log('📝 LLM WebSocket already connected');
        return;
    }
    
    try {
        let LLM_WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/llm-stream';
        if (ASSISTANT_ID) {
            LLM_WS_URL += '?assistant_id=' + encodeURIComponent(ASSISTANT_ID);
        }
        
        log(`📝 Connecting to LLM WebSocket: ${LLM_WS_URL}`);
        
        llmWebSocket = new WebSocket(LLM_WS_URL);
        
        llmWebSocket.onopen = function() {
            log('📝 ✅ LLM WebSocket connected');
            isLLMConnected = true;
            
            // Unlock chat input
            const chatInput = document.getElementById('chatInput');
            const chatSendBtn = document.getElementById('chatSendBtn');
            if (chatInput) {
                chatInput.disabled = false;
                chatInput.placeholder = 'Введите сообщение...';
            }
            if (chatSendBtn && chatInput && chatInput.value.trim()) {
                chatSendBtn.disabled = false;
            }
        };
        
        llmWebSocket.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'llm.stream.start') {
                    currentRequestId = data.request_id;
                    startStreamingUI(data.query);
                    return;
                }
                
                if (data.type === 'llm.stream.delta') {
                    if (data.request_id === currentRequestId || !currentRequestId) {
                        appendStreamingText(data.content);
                    }
                    return;
                }
                
                if (data.type === 'llm.stream.done') {
                    finishStreamingUI(data);
                    return;
                }
                
                if (data.type === 'llm.stream.error') {
                    showStreamingError(data.message || data.error);
                    return;
                }
                
                if (data.type === 'error') {
                    showStreamingError(data.error);
                    return;
                }
                
                if (data.type === 'connection_status') {
                    log(`📝 LLM connection: ${data.status}`);
                    return;
                }
                
            } catch (e) {
                log(`📝 LLM WS parse error: ${e}`, 'error');
            }
        };
        
        llmWebSocket.onclose = function() {
            log('📝 LLM WebSocket disconnected');
            isLLMConnected = false;
            
            // Lock chat input
            const chatInput = document.getElementById('chatInput');
            const chatSendBtn = document.getElementById('chatSendBtn');
            if (chatInput) {
                chatInput.placeholder = 'Подключение...';
            }
            if (chatSendBtn) {
                chatSendBtn.disabled = true;
            }
            
            // Reconnect
            setTimeout(() => {
                if (window.isConnected && ASSISTANT_ID && userActivated) {
                    connectLLMWebSocket();
                }
            }, 3000);
        };
        
        llmWebSocket.onerror = function(error) {
            log(`📝 LLM WebSocket error: ${error}`, 'error');
        };
        
    } catch (error) {
        log(`📝 LLM WebSocket connection error: ${error}`, 'error');
    }
}

function sendLLMQuery(query, requestId) {
    if (!llmWebSocket || llmWebSocket.readyState !== WebSocket.OPEN) {
        log('📝 LLM WebSocket not connected, connecting...', 'warn');
        connectLLMWebSocket();
        setTimeout(() => sendLLMQuery(query, requestId), 500);
        return;
    }
    
    log(`📝 Sending query to LLM: ${query.substring(0, 50)}...`);
    llmWebSocket.send(JSON.stringify({
        type: 'llm.query',
        query: query,
        request_id: requestId
    }));
}

// ============================================================================
// THREE.JS BACKGROUND
// ============================================================================

function createCircleTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    
    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

function initThreeJS() {
    try {
        const canvas = document.getElementById('jarvis-three-canvas');
        if (!canvas) return;

        threeScene = new THREE.Scene();
        threeCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
        threeCamera.position.z = 500;

        threeRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !isMobile });
        threeRenderer.setSize(window.innerWidth, window.innerHeight);
        threeRenderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));

        const particleCount = isMobile ? 800 : 1500;
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        const colorPalette = [
            new THREE.Color(0x8b5cf6),
            new THREE.Color(0x6366f1),
            new THREE.Color(0xa855f7)
        ];

        for (let i = 0; i < particleCount; i++) {
            const i3 = i * 3;
            positions[i3] = (Math.random() - 0.5) * 2000;
            positions[i3 + 1] = (Math.random() - 0.5) * 2000;
            positions[i3 + 2] = (Math.random() - 0.5) * 1500;

            const color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
            colors[i3] = color.r;
            colors[i3 + 1] = color.g;
            colors[i3 + 2] = color.b;
        }

        const particleGeometry = new THREE.BufferGeometry();
        particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const particleMaterial = new THREE.PointsMaterial({
            size: isMobile ? 2 : 3,
            vertexColors: true,
            transparent: true,
            opacity: 0.6,
            sizeAttenuation: true,
            blending: THREE.AdditiveBlending,
            map: createCircleTexture()
        });

        threeParticles = new THREE.Points(particleGeometry, particleMaterial);
        threeScene.add(threeParticles);

        threeInitialized = true;
        animateThreeJS();
        
        log('🎨 Three.js initialized');

    } catch (error) {
        log(`Three.js error: ${error.message}`, 'error');
    }
}

function animateThreeJS() {
    if (!threeInitialized) return;
    requestAnimationFrame(animateThreeJS);

    if (threeParticles) {
        threeParticles.rotation.y += 0.0002;
        threeParticles.rotation.x += 0.0001;

        const positions = threeParticles.geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
            positions[i + 1] += Math.sin(Date.now() * 0.0001 + i) * 0.05;
            if (positions[i + 1] > 1000) positions[i + 1] = -1000;
            if (positions[i + 1] < -1000) positions[i + 1] = 1000;
        }
        threeParticles.geometry.attributes.position.needsUpdate = true;
    }

    threeRenderer.render(threeScene, threeCamera);
}

function handleWindowResize() {
    if (!threeInitialized) return;
    threeCamera.aspect = window.innerWidth / window.innerHeight;
    threeCamera.updateProjectionMatrix();
    threeRenderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================================
// EXPOSE GLOBAL FUNCTIONS (for compatibility)
// ============================================================================

window.saveConfig = saveConfig;
window.testAgent = testAgent;
window.copyHTMLCode = copyHTMLCode;
window.copyLLMResponse = copyLLMResponse;
