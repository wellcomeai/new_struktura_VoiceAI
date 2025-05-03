/**
 * WellcomeAI Widget Loader Script
 * Version: 1.3.1
 * 
 * This script dynamically creates and embeds a voice assistant widget
 * on any website, including Tilda and other website builders.
 * Enhanced support for mobile devices and iOS.
 */

(function() {
  // Widget configuration
  const CONFIG = {
    // Core settings
    DEBUG_MODE: false, // Disable debug mode in production
    MAX_RECONNECT_ATTEMPTS: 5, // Maximum reconnection attempts
    MOBILE_MAX_RECONNECT_ATTEMPTS: 10, // Increased attempts for mobile
    PING_INTERVAL: 15000, // Ping interval in milliseconds
    MOBILE_PING_INTERVAL: 10000, // More frequent pings for mobile
    CONNECTION_TIMEOUT: 20000, // Connection timeout in milliseconds
    MAX_DEBUG_ITEMS: 10, // Maximum number of debug entries
    
    // Audio processing
    DESKTOP_AUDIO: {
      silenceThreshold: 0.01,      // Threshold for silence detection
      silenceDuration: 300,        // Silence duration for sending (ms)
      bufferCheckInterval: 50,     // Buffer check frequency (ms)
      soundDetectionThreshold: 0.02 // Sound detection sensitivity
    },
    
    MOBILE_AUDIO: {
      silenceThreshold: 0.015,     // Lower threshold for mobile devices
      silenceDuration: 500,        // Increased silence duration
      bufferCheckInterval: 100,    // Increased check interval
      soundDetectionThreshold: 0.015 // More sensitive sound detection
    },
    
    // iOS specific settings - модифицированные настройки для iOS
    IOS_AUDIO: {
      silenceThreshold: 0.002,     // Значительно сниженный порог для iOS
      silenceDuration: 600,        // Оптимизированная длительность тишины для iOS
      bufferCheckInterval: 100,    // Оптимизированный интервал для iOS
      soundDetectionThreshold: 0.005, // Более чувствительное определение звука для iOS
      // Новые параметры для агрессивной работы на iOS
      forceAudioActivation: true,  // Принудительная активация аудио
      autoCommitInterval: 1500,    // Автоматическая отправка буфера каждые 1.5 секунды
      forceCommitAudio: true       // Принудительная отправка аудио даже при слабом сигнале
    }
  };

  // Global state storage
  const STATE = {
    reconnectAttempts: 0,
    pingIntervalId: null,
    lastPongTime: Date.now(),
    isReconnecting: false,
    debugQueue: [],
    isConnected: false,
    isListening: false,
    isPlayingAudio: false,
    isWidgetOpen: false,
    connectionFailedPermanently: false,
    hasAudioData: false,
    audioDataStartTime: 0,
    audioChunksBuffer: [],
    audioPlaybackQueue: [],
    // Новые состояния для отслеживания активности аудио
    audioActivationAttempts: 0,
    autoCommitIntervalId: null,
    lastAutoCommitTime: 0,
    iosAudioFullyActivated: false
  };
  
  // Detect device type
  const DEVICE = {
    isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
    isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent),
    hasTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0
  };
  
  // Global flags for mobile devices
  window.audioContextInitialized = false;
  window.tempAudioContext = null;
  window.hasPlayedSilence = false;

  /**
   * Widget logger function
   * @param {string} message - Message to log
   * @param {string} type - Log type (info, warn, error, debug)
   */
  const widgetLog = (message, type = 'info') => {
    // On Render server, the global object will be available
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      // Format message for Render
      const logPrefix = '[WellcomeAI Widget]';
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
      
      // In Render environment, this will go to logs
      console.log(`${logPrefix} ${formattedMessage}`);
    } else if (CONFIG.DEBUG_MODE || type === 'error') {
      // For local development with DEBUG_MODE enabled
      const prefix = '[WellcomeAI Widget]';
      if (type === 'error') {
        console.error(`${prefix} ERROR:`, message);
      } else if (type === 'warn') {
        console.warn(`${prefix} WARNING:`, message);
      } else if (CONFIG.DEBUG_MODE) {
        console.log(`${prefix}`, message);
      }
    }
    
    // Add to debug queue if debugging enabled
    if (CONFIG.DEBUG_MODE) {
      addToDebugQueue(message, type);
    }
  };

  /**
   * Add message to debug queue
   * @param {string} message - Message to add
   * @param {string} type - Message type
   */
  const addToDebugQueue = (message, type = 'info') => {
    if (!CONFIG.DEBUG_MODE) return; // Skip in production mode
    
    const timestamp = new Date().toISOString();
    STATE.debugQueue.push({ timestamp, message, type });
    
    // Limit queue size
    if (STATE.debugQueue.length > CONFIG.MAX_DEBUG_ITEMS) {
      STATE.debugQueue.shift();
    }
  };

  /**
   * Get debug info as a string
   * @returns {string} Debug information
   */
  const getDebugInfo = () => {
    if (!CONFIG.DEBUG_MODE) return "";
    return STATE.debugQueue.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
  };

  /**
   * Get server URL from script tag or fallback
   * @returns {string} Server URL
   */
  const getServerUrl = () => {
    // First check if there's a data-server attribute on the script
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;
    
    // Look for script with data-server
    for (let i = 0; i < scriptTags.length; i++) {
      // Check data-server attribute
      if (scriptTags[i].hasAttribute('data-server')) {
        serverUrl = scriptTags[i].getAttribute('data-server');
        widgetLog(`Found server URL from data-server attribute: ${serverUrl}`);
        break;
      }
      
      // Check dataset.server
      if (scriptTags[i].dataset && scriptTags[i].dataset.server) {
        serverUrl = scriptTags[i].dataset.server;
        widgetLog(`Found server URL from dataset.server: ${serverUrl}`);
        break;
      }
      
      // If no data-server, look for widget script
      const src = scriptTags[i].getAttribute('src');
      if (src && src.includes('widget.js')) {
        try {
          // Use URL API for correct absolute URL construction
          const url = new URL(src, window.location.href);
          serverUrl = url.origin;
          widgetLog(`Extracted server URL from script src: ${serverUrl}`);
          break;
        } catch (e) {
          widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');
          
          // If src is relative, use current domain
          if (src.startsWith('/')) {
            serverUrl = window.location.origin;
            widgetLog(`Using current origin for relative path: ${serverUrl}`);
            break;
          }
        }
      }
    }
    
    // Check if URL contains protocol
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) {
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }
    
    // If not found, use fallback URL (Render hosting)
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com';
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }
    
    return serverUrl.replace(/\/$/, ''); // Remove trailing slash if present
  };

  /**
   * Get assistant ID from script, URL params, or global variable
   * @returns {string|null} Assistant ID or null if not found
   */
  const getAssistantId = () => {
    // 1. Check for data-assistantId attribute in script
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      // Check both capitalization variants
      if (scriptTags[i].hasAttribute('data-assistantId') || scriptTags[i].hasAttribute('data-assistantid')) {
        const id = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid');
        widgetLog(`Found assistant ID from attribute: ${id}`);
        return id;
      }
      
      // Check dataset attribute
      if (scriptTags[i].dataset && (scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid)) {
        const id = scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid;
        widgetLog(`Found assistant ID from dataset: ${id}`);
        return id;
      }
    }
    
    // 2. Try to get ID from URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) {
      widgetLog(`Found assistant ID in URL param: ${idFromUrl}`);
      return idFromUrl;
    }
    
    // 3. Check for global variable
    if (window.wellcomeAIAssistantId) {
      widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`);
      return window.wellcomeAIAssistantId;
    }
    
    // If using demo page, return demo identifier
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo';
    }
    
    widgetLog('No assistant ID found in script tags, URL params or global variables!', 'error');
    return null;
  };

  /**
   * Get widget position from script attributes
   * @returns {Object} Position object with horizontal, vertical, and distance properties
   */
  const getWidgetPosition = () => {
    // Default positions
    const defaultPosition = {
      horizontal: 'right',
      vertical: 'bottom',
      distance: '20px'
    };

    // Look for script with position attribute
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      // Check attribute
      if (scriptTags[i].hasAttribute('data-position')) {
        return parsePosition(scriptTags[i].getAttribute('data-position'));
      }
      
      // Check dataset
      if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
        return parsePosition(scriptTags[i].dataset.position);
      }
    }

    // Return default position
    return defaultPosition;

    // Helper function to parse position
    function parsePosition(positionString) {
      const position = { ...defaultPosition };
      
      if (!positionString) return position;
      
      const parts = positionString.split('-');
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
  };

  /**
   * Create and inject widget styles
   * @param {Object} position - Widget position object
   */
  function createStyles(position) {
    const styleEl = document.createElement('style');
    styleEl.id = 'wellcomeai-widget-styles';
    
    // Color palette as CSS custom properties for easy theming
    const styles = `
      :root {
        --wellcomeai-primary: #4a86e8;
        --wellcomeai-primary-dark: #2b59c3;
        --wellcomeai-primary-light: #e1f5fe;
        --wellcomeai-success: #4caf50;
        --wellcomeai-error: #ef4444;
        --wellcomeai-warning: #f59e0b;
        --wellcomeai-text: #333333;
        --wellcomeai-text-light: #64748b;
        --wellcomeai-bg-light: #f9fafc;
        --wellcomeai-shadow-sm: 0 4px 15px rgba(74, 134, 232, 0.4);
        --wellcomeai-shadow-md: 0 6px 20px rgba(74, 134, 232, 0.5);
        --wellcomeai-shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.15);
        --wellcomeai-border-radius: 20px;
      }
      
      .wellcomeai-widget-container {
        position: fixed;
        ${position.vertical}: ${position.distance};
        ${position.horizontal}: ${position.distance};
        z-index: 2147483647;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: 'Segoe UI', 'Roboto', sans-serif;
      }
      
      .wellcomeai-widget-button {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--wellcomeai-primary), var(--wellcomeai-primary-dark));
        box-shadow: var(--wellcomeai-shadow-sm);
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
      
      .wellcomeai-widget-button:hover {
        transform: scale(1.05);
        box-shadow: var(--wellcomeai-shadow-md);
      }
      
      .wellcomeai-widget-button::before {
        content: '';
        position: absolute;
        width: 150%;
        height: 150%;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.2));
        transform: rotate(45deg);
        top: -30%;
        left: -30%;
        transition: all 0.6s ease;
      }
      
      .wellcomeai-widget-button:hover::before {
        transform: rotate(90deg);
      }
      
      .wellcomeai-widget-icon {
        color: white;
        font-size: 22px;
        z-index: 2;
        transition: all 0.3s ease;
      }
      
      .wellcomeai-widget-expanded {
        position: absolute;
        ${position.vertical}: 0;
        ${position.horizontal}: 0;
        width: 320px;
        height: 0;
        opacity: 0;
        pointer-events: none;
        background: white;
        border-radius: var(--wellcomeai-border-radius);
        box-shadow: var(--wellcomeai-shadow-lg);
        overflow: hidden;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        display: flex;
        flex-direction: column;
        z-index: 2147483647;
      }
      
      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 400px;
        opacity: 1;
        pointer-events: all;
      }
      
      .wellcomeai-widget-container.active .wellcomeai-widget-button {
        transform: scale(0.9);
        box-shadow: 0 2px 10px rgba(74, 134, 232, 0.3);
      }
      
      .wellcomeai-widget-header {
        padding: 15px 20px;
        background: linear-gradient(135deg, var(--wellcomeai-primary), var(--wellcomeai-primary-dark));
        color: white;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-radius: var(--wellcomeai-border-radius) var(--wellcomeai-border-radius) 0 0;
      }
      
      .wellcomeai-widget-title {
        font-weight: 600;
        font-size: 16px;
        letter-spacing: 0.3px;
      }
      
      .wellcomeai-widget-close {
        background: none;
        border: none;
        color: white;
        font-size: 18px;
        cursor: pointer;
        opacity: 0.8;
        transition: all 0.2s;
      }
      
      .wellcomeai-widget-close:hover {
        opacity: 1;
        transform: scale(1.1);
      }
      
      .wellcomeai-widget-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: var(--wellcomeai-bg-light);
        position: relative;
        padding: 20px;
      }
      
      .wellcomeai-main-circle {
        width: 180px;
        height: 180px;
        border-radius: 50%;
        background: linear-gradient(135deg, #ffffff, var(--wellcomeai-primary-light), var(--wellcomeai-primary));
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
        position: relative;
        overflow: hidden;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .wellcomeai-main-circle::before {
        content: '';
        position: absolute;
        width: 140%;
        height: 140%;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.3), rgba(74, 134, 232, 0.2));
        animation: wellcomeai-wave 8s linear infinite;
        border-radius: 40%;
      }
      
      @keyframes wellcomeai-wave {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      
      .wellcomeai-main-circle.listening {
        background: linear-gradient(135deg, #ffffff, #e3f2fd, #2196f3);
        box-shadow: 0 0 30px rgba(33, 150, 243, 0.6);
      }
      
      .wellcomeai-main-circle.listening::before {
        animation: wellcomeai-wave 4s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(33, 150, 243, 0.3));
      }
      
      .wellcomeai-main-circle.listening::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        border: 3px solid rgba(33, 150, 243, 0.5);
        animation: wellcomeai-pulse 1.5s ease-out infinite;
      }
      
      @keyframes wellcomeai-pulse {
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
      
      .wellcomeai-main-circle.speaking {
        background: linear-gradient(135deg, #ffffff, #e8f5e9, var(--wellcomeai-success));
        box-shadow: 0 0 30px rgba(76, 175, 80, 0.6);
      }
      
      .wellcomeai-main-circle.speaking::before {
        animation: wellcomeai-wave 3s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(76, 175, 80, 0.3));
      }
      
      .wellcomeai-main-circle.speaking::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle, transparent 50%, rgba(76, 175, 80, 0.1) 100%);
        border-radius: 50%;
        animation: wellcomeai-ripple 2s ease-out infinite;
      }
      
      @keyframes wellcomeai-ripple {
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
      
      .wellcomeai-mic-icon {
        color: var(--wellcomeai-primary);
        font-size: 32px;
        z-index: 10;
      }
      
      .wellcomeai-main-circle.listening .wellcomeai-mic-icon {
        color: #2196f3;
      }
      
      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon {
        color: var(--wellcomeai-success);
      }
      
      .wellcomeai-audio-visualization {
        position: absolute;
        width: 100%;
        max-width: 160px;
        height: 30px;
        bottom: -5px;
        opacity: 0.8;
        pointer-events: none;
      }
      
      .wellcomeai-audio-bars {
        display: flex;
        align-items: flex-end;
        height: 30px;
        gap: 2px;
        width: 100%;
        justify-content: center;
      }
      
      .wellcomeai-audio-bar {
        width: 3px;
        height: 2px;
        background-color: var(--wellcomeai-primary);
        border-radius: 1px;
        transition: height 0.1s ease;
      }
      
      .wellcomeai-loader-modal {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483646;
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s;
        border-radius: var(--wellcomeai-border-radius);
      }
      
      .wellcomeai-loader-modal.active {
        opacity: 1;
        visibility: visible;
      }
      
      .wellcomeai-loader {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(74, 134, 232, 0.3);
        border-radius: 50%;
        border-top-color: var(--wellcomeai-primary);
        animation: wellcomeai-spin 1s linear infinite;
      }
      
      @keyframes wellcomeai-spin {
        to { transform: rotate(360deg); }
      }
      
      .wellcomeai-message-display {
        position: absolute;
        width: 90%;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: white;
        padding: 12px 15px;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        text-align: center;
        font-size: 14px;
        line-height: 1.4;
        opacity: 0;
        transition: all 0.3s;
        max-height: 100px;
        overflow-y: auto;
        z-index: 10;
      }
      
      .wellcomeai-message-display.show {
        opacity: 1;
      }
      
      @keyframes wellcomeai-button-pulse {
        0% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(74, 134, 232, 0); }
        100% { box-shadow: 0 0 0 0 rgba(74, 134, 232, 0); }
      }
      
      .wellcomeai-pulse-animation {
        animation: wellcomeai-button-pulse 2s infinite;
      }

      .wellcomeai-connection-error {
        color: var(--wellcomeai-error);
        background-color: rgba(254, 226, 226, 0.8);
        border: 1px solid var(--wellcomeai-error);
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        margin-top: 10px;
        text-align: center;
        display: none;
      }
      
      .wellcomeai-connection-error.visible {
        display: block;
      }

      .wellcomeai-retry-button {
        background-color: var(--wellcomeai-error);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
        margin-top: 8px;
        transition: all 0.2s;
      }
      
      .wellcomeai-retry-button:hover {
        background-color: #dc2626;
      }
      
      .wellcomeai-status-indicator {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 11px;
        color: var(--wellcomeai-text-light);
        padding: 4px 8px;
        border-radius: 10px;
        background-color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        gap: 5px;
        opacity: 0;
        transition: opacity 0.3s;
      }
      
      .wellcomeai-status-indicator.show {
        opacity: 0.8;
      }
      
      .wellcomeai-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--wellcomeai-success);
      }
      
      .wellcomeai-status-dot.disconnected {
        background-color: var(--wellcomeai-error);
      }
      
      .wellcomeai-status-dot.connecting {
        background-color: var(--wellcomeai-warning);
      }
      
      /* iOS audio activation button */
      .wellcomeai-ios-audio-button {
        position: absolute;
        bottom: 60px;
        left: 50%;
        transform: translateX(-50%);
        background-color: var(--wellcomeai-primary);
        color: white;
        border: none;
        border-radius: 15px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        display: none;
        z-index: 100;
      }
      
      .wellcomeai-ios-audio-button.visible {
        display: block;
      }
      
      /* Improved mobile support */
      @media (max-width: 480px) {
        .wellcomeai-widget-expanded {
          width: 290px;
        }
        
        .wellcomeai-main-circle {
          width: 160px;
          height: 160px;
        }
        
        .wellcomeai-message-display {
          width: 85%;
        }
      }
    `;
    
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);
    widgetLog("Styles created and added to head");
  }

  /**
   * Load Font Awesome for icons
   */
  function loadFontAwesome() {
    if (!document.getElementById('font-awesome-css')) {
      const link = document.createElement('link');
      link.id = 'font-awesome-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
      document.head.appendChild(link);
      widgetLog("Font Awesome loaded");
    }
  }

  /**
   * Create HTML structure for the widget
   * @returns {Object} Reference to widget elements
   */
  function createWidgetHTML() {
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647";

    let widgetHTML = `
      <!-- Button (minimized state) -->
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button">
        <i class="fas fa-robot wellcomeai-widget-icon"></i>
      </div>
      
      <!-- Expanded widget -->
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">WellcomeAI</div>
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <!-- Main element - circle with microphone icon -->
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>
            
            <!-- Audio visualization -->
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>
          
          <!-- Message display -->
          <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>
          
          <!-- Connection error message -->
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error">
            Connection error with server
            <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
              Retry connection
            </button>
          </div>
          
          <!-- Special button for iOS audio activation -->
          <button class="wellcomeai-ios-audio-button" id="wellcomeai-ios-audio-button">
            Tap to activate audio
          </button>
          
          <!-- Status indicator -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Connected</span>
          </div>
        </div>
      </div>
      
      <!-- Loading modal -->
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active">
        <div class="wellcomeai-loader"></div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);
    widgetLog("HTML structure created and appended to body");
    
    // Return references to elements for better performance
    return {
      container: widgetContainer,
      button: document.getElementById('wellcomeai-widget-button'),
      closeBtn: document.getElementById('wellcomeai-widget-close'),
      mainCircle: document.getElementById('wellcomeai-main-circle'),
      audioBars: document.getElementById('wellcomeai-audio-bars'),
      loaderModal: document.getElementById('wellcomeai-loader-modal'),
      messageDisplay: document.getElementById('wellcomeai-message-display'),
      connectionError: document.getElementById('wellcomeai-connection-error'),
      retryButton: document.getElementById('wellcomeai-connection-error').querySelector('#wellcomeai-retry-button'),
      statusIndicator: document.getElementById('wellcomeai-status-indicator'),
      statusDot: document.getElementById('wellcomeai-status-dot'),
      statusText: document.getElementById('wellcomeai-status-text'),
      iosAudioButton: document.getElementById('wellcomeai-ios-audio-button'),
      expandedWidget: document.getElementById('wellcomeai-widget-expanded')
    };
  }

  /**
   * Audio handling module
   */
  const AudioManager = {
    audioContext: null,
    mediaStream: null,
    audioProcessor: null,
    
    /**
     * Комбинированный метод разблокировки аудио на iOS
     * @returns {Promise<boolean>} Success status
     */
    aggressiveIOSAudioUnlock: async function() {
      if (!DEVICE.isIOS) return Promise.resolve(true);
      
      widgetLog('Агрессивная разблокировка аудио на iOS', 'info');
      
      // Создаем аудио элемент для разблокировки через воспроизведение
      const unlockAudio = () => {
        return new Promise((resolve) => {
          try {
            // Создать несколько звуковых объектов для повышения шансов на разблокировку
            const audioElements = [];
            for (let i = 0; i < 5; i++) {
              const audio = new Audio();
              audio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
              audio.volume = 0;
              audioElements.push(audio);
            }
            
            // Запускаем все аудио последовательно
            let playPromises = [];
            audioElements.forEach(audio => {
              playPromises.push(audio.play().catch(e => console.log('Audio play ignored error:', e)));
            });
            
            Promise.all(playPromises).then(() => {
              widgetLog('Все звуки успешно запущены для разблокировки', 'info');
              window.hasPlayedSilence = true;
              resolve(true);
            }).catch(err => {
              widgetLog(`Ошибка при воспроизведении аудио: ${err}`, 'warn');
              // Возвращаем true, чтобы продолжить активацию другими методами
              resolve(true);
            });
          } catch (e) {
            widgetLog(`Ошибка в разблокировке аудио: ${e}`, 'warn');
            resolve(false);
          }
        });
      };
      
      // Разблокировка через AudioContext и осцилляторы
      const unlockAudioContext = async () => {
        try {
          // Создаем или получаем существующий AudioContext
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)({
              sampleRate: 16000 // Низкая частота для iOS
            });
          }
          
          // Пытаемся разблокировать контекст если он в suspended состоянии
          if (window.tempAudioContext.state === 'suspended') {
            await window.tempAudioContext.resume();
          }
          
          // Генерируем звуки с разными частотами для разблокировки
          const frequencies = [100, 200, 300, 500, 1000, 1500];
          for (const freq of frequencies) {
            const oscillator = window.tempAudioContext.createOscillator();
            const gainNode = window.tempAudioContext.createGain();
            
            gainNode.gain.value = 0.01; // Очень тихо
            oscillator.type = 'sine';
            oscillator.frequency.value = freq;
            oscillator.connect(gainNode);
            gainNode.connect(window.tempAudioContext.destination);
            
            oscillator.start(0);
            oscillator.stop(0.05); // Очень короткий звук
            
            // Небольшая задержка между звуками
            await new Promise(r => setTimeout(r, 50));
          }
          
          // Воспроизводим тишину для закрепления эффекта
          const silentBuffer = window.tempAudioContext.createBuffer(1, 1, 16000);
          const source = window.tempAudioContext.createBufferSource();
          source.buffer = silentBuffer;
          source.connect(window.tempAudioContext.destination);
          source.start(0);
          
          window.audioContextInitialized = true;
          window.hasPlayedSilence = true;
          this.audioContext = window.tempAudioContext;
          
          widgetLog('AudioContext успешно разблокирован');
          return true;
        } catch (e) {
          widgetLog(`Ошибка при разблокировке AudioContext: ${e}`, 'warn');
          return false;
        }
      };
      
      // Запускаем оба метода разблокировки параллельно
      const [audioResult, contextResult] = await Promise.all([
        unlockAudio(),
        unlockAudioContext()
      ]);
      
      // Даем время для полной активации
      await new Promise(r => setTimeout(r, 100));
      
      // Активируем специальные флаги
      window.audioContextInitialized = true;
      window.hasPlayedSilence = true;
      STATE.iosAudioFullyActivated = true;
      
      return audioResult || contextResult;
    },
    
    /**
     * Более простой метод разблокировки аудио (оставлен для совместимости)
     */
    unlockAudioOnIOS: function() {
      if (!DEVICE.isIOS) return Promise.resolve(true);
      
      // Делегируем работу новому агрессивному методу
      return this.aggressiveIOSAudioUnlock();
    },
    
    /**
     * Старый метод форсированной разблокировки (оставлен для совместимости)
     */
    forceIOSAudioUnlock: function() {
      if (!DEVICE.isIOS) return Promise.resolve(true);
      
      // Делегируем работу новому агрессивному методу
      return this.aggressiveIOSAudioUnlock();
    },
    
    /**
     * Воспроизведение тишины для разблокировки аудио (оставлен для совместимости)
     */
    playSilence: function() {
      try {
        if (!window.tempAudioContext) {
          window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // Create and play silence to unlock audio
        const silentBuffer = window.tempAudioContext.createBuffer(1, 1, 22050);
        const source = window.tempAudioContext.createBufferSource();
        source.buffer = silentBuffer;
        source.connect(window.tempAudioContext.destination);
        source.start(0);
        
        window.hasPlayedSilence = true;
        widgetLog("Played silence to unlock audio on iOS");
        
        // Unlock audioContext
        if (window.tempAudioContext.state === 'suspended') {
          window.tempAudioContext.resume().then(() => {
            window.audioContextInitialized = true;
            widgetLog("Audio context successfully resumed on iOS");
          }).catch(err => {
            widgetLog(`Failed to resume audio context: ${err.message}`, 'error');
          });
        }
      } catch (e) {
        widgetLog(`Error playing silence: ${e.message}`, 'error');
      }
    },

    /**
     * Инициализация захвата аудио с улучшенной логикой для iOS
     * @returns {Promise<boolean>} Success status
     */
    initAudio: async function() {
      try {
        widgetLog("Запрос доступа к микрофону...");
        
        // Проверка поддержки getUserMedia
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает доступ к микрофону");
        }
        
        // Специальные настройки для iOS - уменьшен эхо и шумоподавление
        const audioConstraints = DEVICE.isIOS ? 
          { 
            echoCancellation: false, // Лучше отключить на iOS
            noiseSuppression: false, // Отключаем для более быстрой обработки на iOS
            autoGainControl: true    // Автоматическая регулировка усиления помогает
          } : 
          DEVICE.isMobile ? 
          { 
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          } :
          {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 24000
          };
        
        // Для iOS сначала разблокируем аудио
        if (DEVICE.isIOS) {
          await this.aggressiveIOSAudioUnlock();
        }
        
        // Запрос доступа к микрофону с оптимальными настройками
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Доступ к микрофону получен (${DEVICE.isIOS ? 'настройки iOS' : (DEVICE.isMobile ? 'настройки Android' : 'настройки десктоп')})`);
        } catch (micError) {
          widgetLog(`Ошибка доступа к микрофону: ${micError.message}`, 'error');
          
          // Для iOS пробуем запасной вариант с базовыми настройками
          if (DEVICE.isIOS) {
            try {
              // Пытаемся получить доступ с минимальными настройками
              this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
              widgetLog('Доступ к микрофону получен с базовыми настройками для iOS');
            } catch (fallbackError) {
              // На iOS делаем несколько попыток с задержкой
              widgetLog('Попытка получить доступ к микрофону с задержкой...', 'warn');
              
              // Повторная активация аудио
              await this.aggressiveIOSAudioUnlock();
              
              // Ожидаем с повторной попыткой
              await new Promise(resolve => setTimeout(resolve, 300));
              
              // Последняя попытка
              this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { 
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
              }});
              widgetLog('Доступ к микрофону получен после повторной попытки');
            }
          } else {
            throw micError; // Для других устройств пробрасываем ошибку
          }
        }
        
        // Для iOS используем существующий контекст
        if (DEVICE.isIOS) {
          if (window.tempAudioContext) {
            this.audioContext = window.tempAudioContext;
            
            if (this.audioContext.state === 'suspended') {
              await this.audioContext.resume();
              window.audioContextInitialized = true;
              widgetLog('Существующий AudioContext активирован на iOS');
            }
          } else {
            // Создаем новый AudioContext с более низкой частотой для iOS
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
              sampleRate: 16000 // Меньшая нагрузка для iOS
            });
            window.tempAudioContext = this.audioContext;
            window.audioContextInitialized = true;
          }
        } else {
          // Для других устройств
          const contextOptions = DEVICE.isMobile ? {} : { sampleRate: 24000 };
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
        }
        
        widgetLog(`AudioContext создан с частотой дискретизации ${this.audioContext.sampleRate} Гц`);
        
        // Оптимизированные размеры буфера для разных устройств
        const bufferSize = DEVICE.isIOS ? 2048 : // Больше для iOS для стабильности
                          DEVICE.isMobile ? 1024 : 
                          2048;
        
        // Проверка поддержки ScriptProcessorNode
        if (this.audioContext.createScriptProcessor) {
          this.audioProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
          widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
        } else if (this.audioContext.createJavaScriptNode) { // Для старых версий Safari
          this.audioProcessor = this.audioContext.createJavaScriptNode(bufferSize, 1, 1);
          widgetLog(`Создан устаревший JavaScriptNode с размером буфера ${bufferSize}`);
        } else {
          throw new Error("Ваш браузер не поддерживает обработку аудио");
        }
        
        widgetLog("Аудио успешно инициализировано");
        
        // Активируем флаги для iOS
        if (DEVICE.isIOS) {
          window.audioContextInitialized = true;
          window.hasPlayedSilence = true;
          STATE.iosAudioFullyActivated = true;
        }
        
        return true;
      } catch (error) {
        widgetLog(`Ошибка инициализации аудио: ${error.message}`, "error");
        return false;
      }
    },
    
    /**
     * Начало захвата аудио с микрофона
     * @param {Function} onAudioProcess - Callback для обработки аудио данных
     * @returns {boolean} Success status
     */
    startCapture: function(onAudioProcess) {
      if (!this.audioContext || !this.mediaStream || !this.audioProcessor) return false;
      
      try {
        // Подключаем аудио ноды
        const streamSource = this.audioContext.createMediaStreamSource(this.mediaStream);
        streamSource.connect(this.audioProcessor);
        
        // Для iOS НЕ подключаем напрямую к выходу, чтобы избежать фидбека
        if (!DEVICE.isIOS) {
          this.audioProcessor.connect(this.audioContext.destination);
        } else {
          // Для iOS создаем "пустой" нод, чтобы избежать фидбека
          const gainNode = this.audioContext.createGain();
          gainNode.gain.value = 0; // Устанавливаем громкость в ноль
          this.audioProcessor.connect(gainNode);
          gainNode.connect(this.audioContext.destination);
          widgetLog('Использование нулевого gainNode для iOS для предотвращения фидбека');
        }
        
        // Устанавливаем колбэк для обработки аудио
        this.audioProcessor.onaudioprocess = onAudioProcess;
        
        // Активируем флаги для iOS
        if (DEVICE.isIOS) {
          window.audioContextInitialized = true;
          window.hasPlayedSilence = true;
          STATE.iosAudioFullyActivated = true;
        }
        
        return true;
      } catch (e) {
        widgetLog(`Ошибка начала записи аудио: ${e.message}`, 'error');
        return false;
      }
    },
    
    /**
     * Остановка захвата аудио
     */
    stopCapture: function() {
      if (this.audioProcessor) {
        try {
          this.audioProcessor.disconnect();
          widgetLog('Запись аудио остановлена');
        } catch (e) {
          widgetLog(`Ошибка остановки записи аудио: ${e.message}`, 'warn');
        }
      }
      
      if (this.mediaStream) {
        try {
          // Останавливаем все треки
          this.mediaStream.getTracks().forEach(track => track.stop());
          this.mediaStream = null;
          widgetLog('Треки медиа-потока остановлены');
        } catch (e) {
          widgetLog(`Ошибка остановки медиа-потока: ${e.message}`, 'warn');
        }
      }
    },
    
    /**
     * Создание простого WAV файла из PCM данных
     * @param {ArrayBuffer} pcmBuffer - PCM аудио данные
     * @param {number} sampleRate - Частота дискретизации в Гц
     * @returns {ArrayBuffer} WAV файл данных
     */
    createWavFromPcm: function(pcmBuffer, sampleRate = 24000) {
      // Создание WAV заголовка
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      
      // "RIFF" chunk descriptor
      view.setUint8(0, 'R'.charCodeAt(0));
      view.setUint8(1, 'I'.charCodeAt(0));
      view.setUint8(2, 'F'.charCodeAt(0));
      view.setUint8(3, 'F'.charCodeAt(0));
      
      view.setUint32(4, 36 + pcmBuffer.byteLength, true); // Размер файла - 8
      
      // "WAVE" формат
      view.setUint8(8, 'W'.charCodeAt(0));
      view.setUint8(9, 'A'.charCodeAt(0));
      view.setUint8(10, 'V'.charCodeAt(0));
      view.setUint8(11, 'E'.charCodeAt(0));
      
      // "fmt " подчанк
      view.setUint8(12, 'f'.charCodeAt(0));
      view.setUint8(13, 'm'.charCodeAt(0));
      view.setUint8(14, 't'.charCodeAt(0));
      view.setUint8(15, ' '.charCodeAt(0));
      
      view.setUint32(16, 16, true); // Размер подчанка fmt
      view.setUint16(20, 1, true);  // Аудио формат (1 = PCM)
      view.setUint16(22, 1, true);  // Количество каналов (1 = моно)
      view.setUint32(24, sampleRate, true); // Частота дискретизации
      view.setUint32(28, sampleRate * 2, true); // Байт рейт (SampleRate * NumChannels * BitsPerSample/8)
      view.setUint16(32, 2, true);  // Выравнивание блоков (NumChannels * BitsPerSample/8)
      view.setUint16(34, 16, true); // Бит на сэмпл
      
      // "data" подчанк
      view.setUint8(36, 'd'.charCodeAt(0));
      view.setUint8(37, 'a'.charCodeAt(0));
      view.setUint8(38, 't'.charCodeAt(0));
      view.setUint8(39, 'a'.charCodeAt(0));
      
      view.setUint32(40, pcmBuffer.byteLength, true); // Размер данных
      
      // Объединяем заголовок и PCM данные
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      
      return wavBuffer;
    },
    
    /**
     * Воспроизведение аудио из base64 строки с улучшенной логикой для iOS
     * @param {string} audioBase64 - Base64 закодированные аудио данные
     * @param {Function} onComplete - Callback когда воспроизведение завершается
     * @param {Function} onError - Callback при ошибке
     */
    playAudio: function(audioBase64, onComplete, onError) {
      if (!audioBase64 || typeof audioBase64 !== 'string') {
        if (onError) onError(new Error('Некорректные аудио данные'));
        return;
      }
      
      try {
        const playAudioFn = async () => {
          const audioData = DataUtils.base64ToArrayBuffer(audioBase64);
          if (audioData.byteLength === 0) {
            if (onComplete) onComplete();
            return;
          }
          
          // Для iOS делаем дополнительную активацию AudioContext до воспроизведения
          if (DEVICE.isIOS && !STATE.iosAudioFullyActivated) {
            await this.aggressiveIOSAudioUnlock();
          }
          
          const wavBuffer = this.createWavFromPcm(audioData);
          const blob = new Blob([wavBuffer], { type: 'audio/wav' });
          const audioUrl = URL.createObjectURL(blob);
          
          // Используем единственный аудио элемент для iOS
          const audio = new Audio();
          audio.src = audioUrl;
          
          // Предзагрузка для iOS
          audio.preload = 'auto';
          audio.load();
          
          // Отслеживаем готовность воспроизведения
          audio.oncanplaythrough = function() {
            // Пытаемся воспроизвести
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
              playPromise.catch(error => {
                widgetLog(`Ошибка воспроизведения: ${error.message}`, "error");
                
                if (error.name === 'NotAllowedError' && DEVICE.isIOS) {
                  // На iOS пытаемся еще раз после разблокировки
                  AudioManager.aggressiveIOSAudioUnlock().then(() => {
                    setTimeout(() => {
                      audio.play().catch(e => {
                        if (onError) onError(new Error('iOS playback not allowed'));
                      });
                    }, 100);
                  });
                } else {
                  if (onError) onError(error);
                }
              });
            }
          };
          
          audio.onended = function() {
            URL.revokeObjectURL(audioUrl);
            if (onComplete) onComplete();
          };
          
          audio.onerror = function() {
            widgetLog('Ошибка воспроизведения аудио', 'error');
            URL.revokeObjectURL(audioUrl);
            if (onError) onError(new Error('Ошибка воспроизведения аудио'));
          };
        };
        
        if (DEVICE.isIOS) {
          this.aggressiveIOSAudioUnlock().then(() => {
            playAudioFn();
          });
        } else {
          playAudioFn();
        }
      } catch (error) {
        widgetLog(`Ошибка воспроизведения аудио: ${error.message}`, "error");
        if (onError) onError(error);
      }
    }
  };

  /**
   * Data utilities
   */
  const DataUtils = {
    /**
     * Convert ArrayBuffer to Base64
     * @param {ArrayBuffer} buffer - Binary data
     * @returns {string} Base64 encoded string
     */
    arrayBufferToBase64: function(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    },
    
    /**
     * Convert Base64 to ArrayBuffer
     * @param {string} base64 - Base64 encoded string
     * @returns {ArrayBuffer} Binary data
     */
    base64ToArrayBuffer: function(base64) {
      try {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      } catch (e) {
        widgetLog(`Error decoding base64: ${e.message}`, "error");
        return new ArrayBuffer(0);
      }
    }
  };

  /**
   * WebSocket connection manager
   */
  const ConnectionManager = {
    websocket: null,
    pingInterval: null,
    connectionTimeout: null,
    serverUrl: null,
    wsUrl: null,
    
    /**
     * Initialize connection settings
     * @param {string} serverUrl - Server base URL
     * @param {string} assistantId - Assistant ID
     */
    init: function(serverUrl, assistantId) {
      this.serverUrl = serverUrl;
      this.wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/' + assistantId;
      widgetLog(`WebSocket URL configured: ${this.wsUrl}`);
    },
    
    /**
     * Establish WebSocket connection
     * @param {Object} callbacks - Callback functions for connection events
     * @returns {Promise<boolean>} Connection success
     */
    connect: async function(callbacks) {
      try {
        if (callbacks.onConnecting) callbacks.onConnecting();
        widgetLog("Connecting...");
        
        // Reset reconnection flag
        STATE.isReconnecting = true;
        
        // Clean previous connection if exists
        if (this.websocket) {
          try {
            this.websocket.close();
          } catch (e) {
            // Ignore errors when closing
          }
        }
        
        // Clear previous ping timer
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        
        // Clear connection timeout if exists
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
        }
        
        // Create new WebSocket connection
        this.websocket = new WebSocket(this.wsUrl);
        
        // Set binary type for efficient audio transfer
        this.websocket.binaryType = 'arraybuffer';
        
        // Set connection timeout
        this.connectionTimeout = setTimeout(() => {
          widgetLog("Connection timeout exceeded", "error");
          
          if (this.websocket) {
            this.websocket.close();
          }
          
          STATE.isReconnecting = false;
          
          // Increment attempts counter and check maximum
          STATE.reconnectAttempts++;
          
          const maxAttempts = DEVICE.isMobile ? 
                            CONFIG.MOBILE_MAX_RECONNECT_ATTEMPTS : 
                            CONFIG.MAX_RECONNECT_ATTEMPTS;
          
          if (STATE.reconnectAttempts >= maxAttempts) {
            STATE.connectionFailedPermanently = true;
            
            if (callbacks.onConnectionFailed) {
              callbacks.onConnectionFailed("Failed to connect to server. Please try again later.");
            }
          } else {
            // Exponential backoff delay before retry
            // Shorter delay for mobile devices
            const delay = DEVICE.isMobile ?
                    Math.min(15000, Math.pow(1.5, STATE.reconnectAttempts) * 1000) :
                    Math.min(30000, Math.pow(2, STATE.reconnectAttempts) * 1000);
                    
            widgetLog(`Reconnecting in ${delay/1000} seconds (${STATE.reconnectAttempts}/${maxAttempts})`);
            
            if (callbacks.onReconnecting) {
              callbacks.onReconnecting(delay, STATE.reconnectAttempts, maxAttempts);
            }
            
            setTimeout(() => {
              this.connect(callbacks);
            }, delay);
          }
        }, CONFIG.CONNECTION_TIMEOUT);
        
        // Connection established
        this.websocket.onopen = () => {
          clearTimeout(this.connectionTimeout);
          widgetLog('WebSocket connection established');
          STATE.isConnected = true;
          STATE.isReconnecting = false;
          STATE.reconnectAttempts = 0;
          STATE.connectionFailedPermanently = false;
          
          // Initialize ping/pong variables
          const lastPingTime = Date.now();
          STATE.lastPongTime = Date.now();
          
          // Configure ping interval with different frequency for mobile and desktop
          const pingIntervalTime = DEVICE.isMobile ? 
                                 CONFIG.MOBILE_PING_INTERVAL : 
                                 CONFIG.PING_INTERVAL;
          
          // Start ping to maintain connection
          this.pingInterval = setInterval(() => {
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
              try {
                this.websocket.send(JSON.stringify({ type: "ping" }));
                const pingTime = Date.now();
                
                // Check if we received pong
                if (pingTime - STATE.lastPongTime > pingIntervalTime * 3) {
                  widgetLog("Ping timeout, no pong received", "warn");
                  
                  // Try to reconnect
                  clearInterval(this.pingInterval);
                  this.websocket.close();
                  
                  if (callbacks.onReconnectNeeded) {
                    callbacks.onReconnectNeeded(1000); // Fast reconnect
                  }
                }
              } catch (e) {
                widgetLog(`Error sending ping: ${e.message}`, "error");
              }
            }
          }, pingIntervalTime);
          
          if (callbacks.onConnected) callbacks.onConnected();
        };
        
        // Message handling
        this.websocket.onmessage = (event) => {
          if (callbacks.onMessage) callbacks.onMessage(event);
        };
        
        // Connection closed
        this.websocket.onclose = (event) => {
          widgetLog(`WebSocket connection closed: ${event.code}, ${event.reason}`);
          STATE.isConnected = false;
          STATE.isListening = false;
          
          // Clear ping interval
          if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
          }
          
          // Don't try to reconnect if connection was closed normally
          if (event.code === 1000 || event.code === 1001) {
            STATE.isReconnecting = false;
            widgetLog('Clean WebSocket close, not reconnecting');
            return;
          }
          
          if (callbacks.onReconnectNeeded) {
            callbacks.onReconnectNeeded();
          }
        };
        
        // Connection error
        this.websocket.onerror = (error) => {
          widgetLog(`WebSocket error: ${error}`, 'error');
          
          if (callbacks.onError) {
            callbacks.onError(error);
          }
        };
        
        return true;
      } catch (error) {
        widgetLog(`Error connecting to WebSocket: ${error}`, 'error');
        STATE.isReconnecting = false;
        
        // Increment attempts counter and check maximum
        STATE.reconnectAttempts++;
        
        const maxAttempts = DEVICE.isMobile ? 
                          CONFIG.MOBILE_MAX_RECONNECT_ATTEMPTS : 
                          CONFIG.MAX_RECONNECT_ATTEMPTS;
        
        if (STATE.reconnectAttempts >= maxAttempts) {
          STATE.connectionFailedPermanently = true;
          
          if (callbacks.onConnectionFailed) {
            callbacks.onConnectionFailed("Failed to connect to server. Please try again later.");
          }
        } else {
          // Exponential backoff delay
          if (callbacks.onReconnectNeeded) {
            callbacks.onReconnectNeeded();
          }
        }
        
        return false;
      }
    },
    
    /**
     * Send message to server
     * @param {Object} message - Message to send
     * @returns {boolean} Send success
     */
    send: function(message) {
      if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        widgetLog('Cannot send message, connection not open', 'warn');
        return false;
      }
      
      try {
        this.websocket.send(JSON.stringify(message));
        return true;
      } catch (e) {
        widgetLog(`Error sending message: ${e.message}`, 'error');
        return false;
      }
    },
    
    /**
     * Close connection
     */
    disconnect: function() {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      
      if (this.websocket) {
        try {
          this.websocket.close(1000, "Normal closure");
        } catch (e) {
          widgetLog(`Error closing connection: ${e.message}`, 'warn');
        }
        this.websocket = null;
      }
      
      STATE.isConnected = false;
      widgetLog('Connection closed');
    }
  };

  /**
   * Main widget controller
   */
  const WidgetController = {
    elements: null,
    audioConfig: null,
    minimumAudioLength: 300,
    
    /**
     * Initialize widget
     * @param {string} serverUrl - Server URL
     * @param {string} assistantId - Assistant ID
     * @param {Object} position - Widget position
     */
    init: function(serverUrl, assistantId, position) {
      // Create styles and HTML
      createStyles(position);
      this.elements = createWidgetHTML();
      
      // Configure audio based on device
      this.audioConfig = DEVICE.isIOS ? 
                       CONFIG.IOS_AUDIO : 
                       (DEVICE.isMobile ? CONFIG.MOBILE_AUDIO : CONFIG.DESKTOP_AUDIO);
      
      // Initialize connection manager
      ConnectionManager.init(serverUrl, assistantId);
      
      // Create audio visualization bars
      this.createAudioBars();
      
      // Attach event listeners
      this.attachEventListeners();
      
      // Connect to server
      this.connectToServer();
      
      // Check DOM and widget state after initialization
      this.checkInitialization();
    },
    
    /**
     * Create audio visualization bars
     * @param {number} count - Number of bars
     */
    createAudioBars: function(count = 20) {
      this.elements.audioBars.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        this.elements.audioBars.appendChild(bar);
      }
    },
    
    /**
     * Update audio visualization with audio data
     * @param {Float32Array} audioData - Audio samples
     */
    updateAudioVisualization: function(audioData) {
      // Use requestAnimationFrame for better performance
      requestAnimationFrame(() => {
        const bars = this.elements.audioBars.querySelectorAll('.wellcomeai-audio-bar');
        const step = Math.floor(audioData.length / bars.length);
        
        for (let i = 0; i < bars.length; i++) {
          // Calculate average amplitude for this audio segment
          let sum = 0;
          for (let j = 0; j < step; j++) {
            const index = i * step + j;
            if (index < audioData.length) {
              sum += Math.abs(audioData[index]);
            }
          }
          const average = sum / step;
          
          // Для устройств iOS увеличиваем чувствительность
          const multiplier = DEVICE.isIOS ? 200 : 
                          (DEVICE.isMobile ? 150 : 100);
          
          // Normalize value for bar height (2px to 30px)
          const height = 2 + Math.min(28, Math.floor(average * multiplier));
          bars[i].style.height = `${height}px`;
        }
      });
    },
    
    /**
     * Reset audio visualization
     */
    resetAudioVisualization: function() {
      const bars = this.elements.audioBars.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px';
      });
    },
    
    /**
     * Attach event listeners to widget elements
     */
    attachEventListeners: function() {
      // Open widget button
      this.elements.button.addEventListener('click', (e) => {
        widgetLog('Button clicked');
        e.preventDefault();
        e.stopPropagation();
        this.openWidget();
      });
    
      // Close widget button
      this.elements.closeBtn.addEventListener('click', (e) => {
        widgetLog('Close button clicked');
        e.preventDefault();
        e.stopPropagation();
        this.closeWidget();
      });
      
      // Main circle (to start voice recognition)
      this.elements.mainCircle.addEventListener('click', () => {
        widgetLog(`Circle clicked: isWidgetOpen=${STATE.isWidgetOpen}, isListening=${STATE.isListening}, isPlayingAudio=${STATE.isPlayingAudio}, isReconnecting=${STATE.isReconnecting}`);
        
        // For iOS, this click will help initialize audio context
        if (DEVICE.isIOS) {
          AudioManager.aggressiveIOSAudioUnlock().then(unlocked => {
            if (unlocked) {
              widgetLog('Audio context successfully unlocked via circle click');
              
              if (this.elements.iosAudioButton) {
                this.elements.iosAudioButton.classList.remove('visible');
              }
              
              if (STATE.isWidgetOpen && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                if (STATE.isConnected) {
                  this.startListening();
                } else if (STATE.connectionFailedPermanently) {
                  this.showConnectionError("No server connection. Click 'Retry connection' button.");
                } else {
                  // Try to reconnect
                  this.connectToServer();
                }
              }
            }
          });
        } else {
          if (STATE.isWidgetOpen && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
            if (STATE.isConnected) {
              this.startListening();
            } else if (STATE.connectionFailedPermanently) {
              this.showConnectionError("No server connection. Click 'Retry connection' button.");
            } else {
              // Try to reconnect
              this.connectToServer();
            }
          }
        }
      });
      
      // iOS audio activation button
      if (DEVICE.isIOS && this.elements.iosAudioButton) {
        this.elements.iosAudioButton.addEventListener('click', () => {
          AudioManager.aggressiveIOSAudioUnlock().then(success => {
            if (success) {
              this.elements.iosAudioButton.classList.remove('visible');
              
              // Try to start listening after a short delay
              setTimeout(() => {
                if (STATE.isConnected && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                  this.startListening();
                }
              }, 300);
            } else {
              // Если разблокировка не удалась, пробуем более агрессивную разблокировку
              AudioManager.aggressiveIOSAudioUnlock().then(() => {
                this.elements.iosAudioButton.classList.remove('visible');
                
                setTimeout(() => {
                  if (STATE.isConnected && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                    this.startListening();
                  }
                }, 300);
              });
            }
          });
        });
      }
      
      // Retry connection button
      if (this.elements.retryButton) {
        this.elements.retryButton.addEventListener('click', () => {
          widgetLog('Retry button clicked');
          this.resetConnection();
        });
      }
    },
    
    /**
     * Connect to WebSocket server
     */
    connectToServer: function() {
      ConnectionManager.connect({
        onConnecting: () => {
          this.elements.loaderModal.classList.add('active');
          this.updateConnectionStatus('connecting', 'Connecting...');
        },
        
        onConnected: () => {
          this.elements.loaderModal.classList.remove('active');
          this.hideConnectionError();
          
          if (STATE.isWidgetOpen) {
            this.updateConnectionStatus('connected', 'Connected');
            
            // На iOS автоматически активируем аудио и микрофон без ожидания
            if (DEVICE.isIOS) {
              // Запускаем агрессивную разблокировку аудио
              AudioManager.aggressiveIOSAudioUnlock().then(() => {
                // После разблокировки сразу начинаем слушать
                setTimeout(() => {
                  this.startListening();
                }, 100);
              });
            } else {
              // Для других устройств сразу начинаем слушать
              this.startListening();
            }
          }
        },
        
        onConnectionFailed: (message) => {
          this.elements.loaderModal.classList.remove('active');
          
          if (STATE.isWidgetOpen) {
            this.showConnectionError(message);
            this.updateConnectionStatus('disconnected', 'Disconnected');
          } else {
            // If widget is closed, add pulse animation to button
            this.elements.button.classList.add('wellcomeai-pulse-animation');
          }
        },
        
        onReconnecting: (delay, attempt, maxAttempts) => {
          if (STATE.isWidgetOpen) {
            this.showMessage(`Connection timeout. Retrying in ${Math.round(delay/1000)} sec...`);
            this.updateConnectionStatus('connecting', 'Reconnecting...');
          }
        },
        
        onReconnectNeeded: (initialDelay = 0) => {
          this.reconnectWithDelay(initialDelay);
        },
        
        onError: (error) => {
          if (STATE.isWidgetOpen) {
            this.showMessage("Connection error with server");
            this.updateConnectionStatus('disconnected', 'Connection error');
          }
        },
        
        onMessage: (event) => {
          this.handleServerMessage(event);
        }
      });
    },
    
    /**
     * Handle server messages
     * @param {MessageEvent} event - WebSocket message event
     */
    handleServerMessage: function(event) {
      try {
        // Handle possible binary data
        if (event.data instanceof Blob) {
          widgetLog("Received binary data from server");
          return;
        }
        
        // Check for empty message
        if (!event.data) {
          widgetLog("Received empty message from server", "warn");
          return;
        }

        // Handle text messages
        try {
          const data = JSON.parse(event.data);
          
          // Update last pong time with any message
          STATE.lastPongTime = Date.now();
          
          // Log all message types except frequent audio messages
          if (data.type !== 'input_audio_buffer.append') {
            widgetLog(`Received message type: ${data.type || 'unknown'}`);
          }
          
          // Check for session.created and session.updated message
          if (data.type === 'session.created' || data.type === 'session.updated') {
            widgetLog(`Received session info: ${data.type}`);
            // Just accept this message, no special handling needed
            return;
          }
          
          // Check for connection_status message
          if (data.type === 'connection_status') {
            widgetLog(`Connection status: ${data.status} - ${data.message}`);
            if (data.status === 'connected') {
              // Connection established, can start listening
              STATE.isConnected = true;
              STATE.reconnectAttempts = 0;
              STATE.connectionFailedPermanently = false;
              
              // Hide connection error if shown
              this.hideConnectionError();
              
              // Автоматически начинаем слушать если виджет открыт
              if (STATE.isWidgetOpen) {
                if (DEVICE.isIOS) {
                  // Для iOS запускаем разблокировку аудио
                  AudioManager.aggressiveIOSAudioUnlock().then(() => {
                    setTimeout(() => {
                      this.startListening();
                    }, 100);
                  });
                } else {
                  this.startListening();
                }
              }
            }
            return;
          }
          
          // Handle errors
          if (data.type === 'error') {
            // Special handling for empty audio buffer error
            if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
              widgetLog("Error: empty audio buffer", "warn");
              // На iOS могут быть проблемы с пустым буфером, пробуем заново начать запись
              if (STATE.isWidgetOpen && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                if (DEVICE.isIOS) {
                  // Разблокируем аудио перед перезапуском
                  AudioManager.aggressiveIOSAudioUnlock().then(() => {
                    setTimeout(() => { 
                      this.startListening(); 
                    }, 300);
                  });
                } else {
                  setTimeout(() => { 
                    this.startListening(); 
                  }, 500);
                }
              }
              return;
            }
            
            // Other errors
            widgetLog(`Server error: ${data.error ? data.error.message : 'Unknown error'}`, "error");
            this.showMessage(data.error ? data.error.message : 'Server error occurred', 5000);
            return;
          } 
          
          // Handle text response
          if (data.type === 'response.text.delta') {
            if (data.delta) {
              this.showMessage(data.delta, 0); // Set duration = 0 to keep message visible
              
              // If widget is closed, add pulse to button
              if (!STATE.isWidgetOpen) {
                this.elements.button.classList.add('wellcomeai-pulse-animation');
              }
            }
            return;
          }
          
          // Text completion
          if (data.type === 'response.text.done') {
            // After text completion, set timer to hide message
            setTimeout(() => {
              this.hideMessage();
            }, 5000);
            return;
          }
          
          // Handle audio
          if (data.type === 'response.audio.delta') {
            if (data.delta) {
              STATE.audioChunksBuffer.push(data.delta);
            }
            return;
          }
          
          // Handle audio transcription
          if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
            // Could save or display audio transcription here
            return;
          }
          
          // Audio ready for playback
          if (data.type === 'response.audio.done') {
            if (STATE.audioChunksBuffer.length > 0) {
              const fullAudio = STATE.audioChunksBuffer.join('');
              this.addAudioToPlaybackQueue(fullAudio);
              STATE.audioChunksBuffer = [];
            }
            return;
          }
          
          // Response complete
          if (data.type === 'response.done') {
            widgetLog('Response done received');
            // Автоматически начинаем слушать снова если виджет открыт
            if (STATE.isWidgetOpen && !STATE.isPlayingAudio && !STATE.isReconnecting) {
              // Проверяем состояние аудио для iOS перед стартом
              if (DEVICE.isIOS) {
                // Сначала разблокируем аудио, потом начинаем слушать
                AudioManager.aggressiveIOSAudioUnlock().then(() => {
                  setTimeout(() => {
                    this.startListening();
                  }, 300);
                });
              } else {
                setTimeout(() => {
                  this.startListening();
                }, 800);
              }
            }
            return;
          }
          
          // If we reached this point, we have an unknown message type
          widgetLog(`Unknown message type: ${data.type}`, "warn");
          
        } catch (parseError) {
          // If JSON parsing failed, just log the error
          widgetLog(`JSON parsing error: ${parseError.message}`, "warn");
          
          // Check for ping-pong messages
          if (event.data === 'pong') {
            STATE.lastPongTime = Date.now();
            widgetLog("Received pong response");
            return;
          }
          
          widgetLog(`Message content: ${typeof event.data === 'string' ? event.data.substring(0, 100) : 'not a string'}...`, "debug");
        }
      } catch (generalError) {
        widgetLog(`General message processing error: ${generalError.message}`, "error");
      }
    },
    
    /**
     * Улучшенная функция начала записи аудио для iOS
     */
    startListening: async function() {
      if (!STATE.isConnected) {
        widgetLog('Невозможно начать запись: нет соединения с сервером', 'warn');
        return;
      }
      
      // Проверяем что не воспроизводим аудио и не в процессе переподключения
      if (STATE.isPlayingAudio || STATE.isReconnecting) {
        widgetLog(`Невозможно начать запись: isPlayingAudio=${STATE.isPlayingAudio}, isReconnecting=${STATE.isReconnecting}`, 'warn');
        return;
      }
      
      // Можем начать запись, даже если уже слушаем (перезапустить)
      if (STATE.isListening) {
        // Останавливаем текущую запись
        AudioManager.stopCapture();
        
        // Очищаем установленные интервалы
        if (STATE.autoCommitIntervalId) {
          clearInterval(STATE.autoCommitIntervalId);
          STATE.autoCommitIntervalId = null;
        }
      }
      
      // Устанавливаем флаг записи
      STATE.isListening = true;
      widgetLog('Начинаем запись аудио');
      
      // Отправляем команду очистки входного буфера
      if (ConnectionManager.websocket && ConnectionManager.websocket.readyState === WebSocket.OPEN) {
        ConnectionManager.send({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        });
      }
      
      // Специальная обработка для iOS устройств - агрессивная разблокировка аудио
      if (DEVICE.isIOS) {
        await AudioManager.aggressiveIOSAudioUnlock();
        
        // Даже если не удалось полностью активировать, продолжаем
        // iOS часто требует несколько попыток
        if (!window.audioContextInitialized) {
          widgetLog('Аудио контекст не полностью инициализирован, но продолжаем', 'warn');
          window.audioContextInitialized = true; // Принудительно устанавливаем флаг
        }
      }
      
      // Проверяем инициализацию аудио
      if (!AudioManager.audioContext) {
        const success = await AudioManager.initAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио', 'error');
          STATE.isListening = false;
          
          // Для iOS попробуем еще раз активировать аудио
          if (DEVICE.isIOS) {
            widgetLog('Повторная попытка активации аудио на iOS', 'info');
            
            try {
              await AudioManager.aggressiveIOSAudioUnlock();
              
              // Пробуем заново инициализировать аудио после разблокировки
              const secondAttempt = await AudioManager.initAudio();
              if (!secondAttempt) {
                widgetLog('Вторая попытка инициализации аудио не удалась', 'error');
                return;
              }
            } catch (e) {
              widgetLog(`Ошибка повторной активации аудио: ${e.message}`, 'error');
              return;
            }
          } else {
            // Для других платформ показываем сообщение об ошибке
            this.showMessage("Ошибка доступа к микрофону. Проверьте разрешения браузера.");
            return;
          }
        }
      } else if (AudioManager.audioContext.state === 'suspended') {
        // Восстанавливаем AudioContext если приостановлен
        try {
          await AudioManager.audioContext.resume();
          widgetLog('AudioContext возобновлен');
        } catch (error) {
          widgetLog(`Ошибка возобновления AudioContext: ${error.message}`, 'error');
          
          // Для iOS пробуем перезапустить аудио полностью
          if (DEVICE.isIOS) {
            AudioManager.stopCapture();
            
            try {
              await AudioManager.aggressiveIOSAudioUnlock();
              await AudioManager.initAudio();
            } catch (e) {
              widgetLog(`Не удалось перезапустить аудио: ${e.message}`, 'error');
              STATE.isListening = false;
              return;
            }
          } else {
            STATE.isListening = false;
            this.showMessage("Ошибка доступа к аудио. Пожалуйста, перезагрузите страницу.");
            return;
          }
        }
