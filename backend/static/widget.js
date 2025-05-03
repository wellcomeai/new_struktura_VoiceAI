/**
 * WellcomeAI Widget Loader Script
 * Version: 1.4.0
 * 
 * This script dynamically creates and embeds a voice assistant widget
 * on any website, including Tilda and other website builders.
 * Enhanced support for mobile devices and iOS.
 */

(function() {
  // Widget configuration
  const CONFIG = {
    // Core settings
    DEBUG_MODE: false, // Set to true for development debugging
    MAX_RECONNECT_ATTEMPTS: 5, // Maximum reconnection attempts
    MOBILE_MAX_RECONNECT_ATTEMPTS: 10, // Increased attempts for mobile
    PING_INTERVAL: 15000, // Ping interval in milliseconds
    MOBILE_PING_INTERVAL: 10000, // More frequent pings for mobile
    CONNECTION_TIMEOUT: 20000, // Connection timeout in milliseconds
    MAX_DEBUG_ITEMS: 20, // Maximum number of debug entries
    
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
    
    // Android specific settings
    ANDROID_AUDIO: {
      silenceThreshold: 0.01,      // Optimized threshold for Android
      silenceDuration: 450,        // Optimized silence duration for Android
      bufferCheckInterval: 80,     // Optimized check interval for Android
      soundDetectionThreshold: 0.012, // Better sound detection for Android
      autoCommitInterval: 2000     // Auto-commit buffer every 2 seconds
    },
    
    // iOS specific settings
    IOS_AUDIO: {
      silenceThreshold: 0.002,     // Significantly reduced threshold for iOS
      silenceDuration: 600,        // Optimized silence duration for iOS
      bufferCheckInterval: 100,    // Optimized check interval for iOS
      soundDetectionThreshold: 0.005, // More sensitive sound detection for iOS
      forceAudioActivation: true,  // Force audio activation
      autoCommitInterval: 1500,    // Auto-commit buffer every 1.5 seconds
      forceCommitAudio: true,      // Force audio commit even with weak signal
      minimumRecordTime: 500       // Minimum recording time before processing
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
    // New states for audio activity tracking
    audioActivationAttempts: 0,
    autoCommitIntervalId: null,
    lastAutoCommitTime: 0,
    iosAudioFullyActivated: false,
    microphonePermissionState: 'unknown', // 'granted', 'denied', 'prompt', 'unknown'
    audioContextCreationAttempts: 0
  };
  
  // Enhanced device detection
  const DEVICE = {
    isMobile: /iPhone|iPad|iPod|Android|Mobile|Tablet/i.test(navigator.userAgent),
    isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform)),
    isAndroid: /Android/i.test(navigator.userAgent),
    hasTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
    isiPad: /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    // Check for iOS version
    iOSVersion: (function() {
      const match = navigator.userAgent.match(/OS (\d+)_(\d+)_?(\d+)?/);
      return match ? parseInt(match[1], 10) : 0;
    })()
  };
  
  // Global flags for mobile devices
  window.audioContextInitialized = false;
  window.tempAudioContext = null;
  window.hasPlayedSilence = false;
  window.widgetDebugLogs = [];

  /**
   * Widget logger function
   * @param {string} message - Message to log
   * @param {string} type - Log type (info, warn, error, debug)
   */
  const widgetLog = (message, type = 'info') => {
    // Always store logs in memory for debug access
    const timestamp = new Date().toISOString();
    window.widgetDebugLogs.push({ timestamp, message, type });
    
    // Limit stored logs
    if (window.widgetDebugLogs.length > 100) {
      window.widgetDebugLogs.shift();
    }
    
    // Format message
    const logPrefix = '[WellcomeAI Widget]';
    const formattedMessage = `${timestamp.slice(11, 23)} | ${type.toUpperCase()} | ${message}`;
    
    // On Render server or with DEBUG_MODE
    if ((typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) || 
        CONFIG.DEBUG_MODE || type === 'error') {
      
      // Output to console with proper formatting
      if (type === 'error') {
        console.error(`${logPrefix} ERROR:`, message);
      } else if (type === 'warn') {
        console.warn(`${logPrefix} WARNING:`, message);
      } else if (CONFIG.DEBUG_MODE || window.location.hostname.includes('render.com')) {
        console.log(`${logPrefix}`, message);
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
    const logs = CONFIG.DEBUG_MODE ? STATE.debugQueue : window.widgetDebugLogs;
    return logs.map(item => `[${item.timestamp}] ${item.type.toUpperCase()}: ${item.message}`).join('\n');
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
          widgetLog(`Error extracting server URL from src: ${e ? (e.message || e.toString()) : 'Unknown error'}`, 'warn');
          
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
      
      /* Permission button */
      .wellcomeai-permission-button {
        position: absolute;
        bottom: 70px;
        left: 50%;
        transform: translateX(-50%);
        background-color: var(--wellcomeai-primary);
        color: white;
        border: none;
        border-radius: 15px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: none;
        z-index: 100;
        box-shadow: var(--wellcomeai-shadow-sm);
      }
      
      .wellcomeai-permission-button.visible {
        display: block;
      }
      
      .wellcomeai-permission-button:hover {
        background-color: var(--wellcomeai-primary-dark);
      }
      
      /* Debug mode button */
      .wellcomeai-debug-button {
        position: absolute;
        bottom: 10px;
        right: 10px;
        background-color: rgba(0, 0, 0, 0.1);
        color: rgba(0, 0, 0, 0.5);
        border: none;
        border-radius: 4px;
        padding: 2px 5px;
        font-size: 9px;
        cursor: pointer;
        opacity: 0.5;
        z-index: 100;
      }
      
      .wellcomeai-debug-button:hover {
        opacity: 1;
      }
      
      /* Debug panel */
      .wellcomeai-debug-panel {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 400px;
        max-height: 80vh;
        background-color: white;
        border-radius: 8px;
        box-shadow: 0 5px 20px rgba(0, 0, 0, 0.2);
        z-index: 2147483648;
        display: none;
        overflow: hidden;
        flex-direction: column;
      }
      
      .wellcomeai-debug-panel.visible {
        display: flex;
      }
      
      .wellcomeai-debug-header {
        padding: 10px;
        background-color: #f3f4f6;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #e5e7eb;
      }
      
      .wellcomeai-debug-title {
        font-weight: 600;
        font-size: 14px;
      }
      
      .wellcomeai-debug-close {
        background: none;
        border: none;
        font-size: 14px;
        cursor: pointer;
      }
      
      .wellcomeai-debug-content {
        padding: 10px;
        overflow-y: auto;
        max-height: calc(80vh - 41px);
      }
      
      .wellcomeai-debug-logs {
        font-family: monospace;
        font-size: 12px;
        white-space: pre-wrap;
        line-height: 1.5;
      }
      
      .wellcomeai-debug-actions {
        padding: 10px;
        display: flex;
        gap: 10px;
        border-top: 1px solid #e5e7eb;
      }
      
      .wellcomeai-debug-button {
        padding: 5px 10px;
        background-color: #f3f4f6;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      
      .wellcomeai-debug-button:hover {
        background-color: #e5e7eb;
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
        
        .wellcomeai-debug-panel {
          width: 90%;
          left: 5%;
          right: 5%;
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
          
          <!-- Permission button -->
          <button class="wellcomeai-permission-button" id="wellcomeai-permission-button">
            Allow microphone access
          </button>
          
          <!-- Status indicator -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Connected</span>
          </div>
          
          <!-- Debug button (only visible in dev mode) -->
          <button class="wellcomeai-debug-button" id="wellcomeai-debug-button">DEBUG</button>
        </div>
      </div>
      
      <!-- Loading modal -->
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active">
        <div class="wellcomeai-loader"></div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);
    
    // Create debug panel
    const debugPanel = document.createElement('div');
    debugPanel.className = 'wellcomeai-debug-panel';
    debugPanel.id = 'wellcomeai-debug-panel';
    debugPanel.innerHTML = `
      <div class="wellcomeai-debug-header">
        <div class="wellcomeai-debug-title">WellcomeAI Debug Panel</div>
        <button class="wellcomeai-debug-close" id="wellcomeai-debug-close">×</button>
      </div>
      <div class="wellcomeai-debug-content">
        <div class="wellcomeai-debug-logs" id="wellcomeai-debug-logs"></div>
      </div>
      <div class="wellcomeai-debug-actions">
        <button class="wellcomeai-debug-button" id="wellcomeai-debug-toggle">Toggle Debug Mode</button>
        <button class="wellcomeai-debug-button" id="wellcomeai-debug-copy">Copy Logs</button>
        <button class="wellcomeai-debug-button" id="wellcomeai-debug-clear">Clear Logs</button>
      </div>
    `;
    document.body.appendChild(debugPanel);
    
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
      retryButton: document.getElementById('wellcomeai-retry-button'),
      statusIndicator: document.getElementById('wellcomeai-status-indicator'),
      statusDot: document.getElementById('wellcomeai-status-dot'),
      statusText: document.getElementById('wellcomeai-status-text'),
      iosAudioButton: document.getElementById('wellcomeai-ios-audio-button'),
      permissionButton: document.getElementById('wellcomeai-permission-button'),
      expandedWidget: document.getElementById('wellcomeai-widget-expanded'),
      debugButton: document.getElementById('wellcomeai-debug-button'),
      debugPanel: document.getElementById('wellcomeai-debug-panel'),
      debugLogs: document.getElementById('wellcomeai-debug-logs'),
      debugClose: document.getElementById('wellcomeai-debug-close'),
      debugToggle: document.getElementById('wellcomeai-debug-toggle'),
      debugCopy: document.getElementById('wellcomeai-debug-copy'),
      debugClear: document.getElementById('wellcomeai-debug-clear')
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
     * Check microphone permission status
     * @returns {Promise<string>} Permission status: 'granted', 'denied', 'prompt', or 'unknown'
     */
    checkMicrophonePermission: async function() {
      try {
        // First check Permissions API if available (modern browsers)
        if (navigator.permissions && navigator.permissions.query) {
          try {
            const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
            widgetLog(`Microphone permission status: ${permissionStatus.state}`);
            return permissionStatus.state; // 'granted', 'denied', or 'prompt'
          } catch (e) {
            widgetLog(`Permissions API error: ${e ? e.message : 'Unknown'}`, 'warn');
          }
        }
        
        // For older browsers or if Permissions API fails
        // Try to access the mic briefly to check if we can
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          
          // Clean up stream immediately
          stream.getTracks().forEach(track => track.stop());
          
          return 'granted';
        } catch (e) {
          if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            return 'denied';
          } else {
            // Other errors like NotFoundError (no mic) or SecurityError
            // In case of SecurityError, it could be because permission wasn't asked yet
            return 'prompt';
          }
        }
      } catch (e) {
        widgetLog(`Error checking microphone permission: ${e ? e.message : 'Unknown'}`, 'error');
        return 'unknown';
      }
    },
    
    /**
     * Combined method for unlocking audio on iOS
     * @returns {Promise<boolean>} Success status
     */
    aggressiveIOSAudioUnlock: async function() {
      if (!DEVICE.isIOS) return Promise.resolve(true);
      
      widgetLog('Starting aggressive iOS audio unlock', 'info');
      
      try {
        // Create audio element for unlocking through playback
        const unlockAudio = () => {
          return new Promise((resolve) => {
            try {
              // Create multiple sound objects to increase chances of unlocking
              const audioElements = [];
              for (let i = 0; i < 5; i++) {
                const audio = new Audio();
                audio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
                audio.volume = 0;
                audioElements.push(audio);
              }
              
              // Play all audio sequentially
              let playPromises = [];
              audioElements.forEach(audio => {
                playPromises.push(audio.play().catch(e => {
                  widgetLog(`Audio play ignored error: ${e ? e.message : 'Unknown'}`, 'debug');
                  return null;
                }));
              });
              
              Promise.all(playPromises).then(() => {
                widgetLog('All sounds successfully played for unlocking', 'info');
                window.hasPlayedSilence = true;
                resolve(true);
              }).catch(err => {
                widgetLog(`Error playing audio: ${err ? err.message : 'Unknown'}`, 'warn');
                // Return true to continue activation with other methods
                resolve(true);
              });
            } catch (e) {
              widgetLog(`Error in audio unlock: ${e ? e.message : 'Unknown'}`, 'warn');
              resolve(false);
            }
          });
        };
        
        // Unlock through AudioContext and oscillators
        const unlockAudioContext = async () => {
          try {
            // Create or get existing AudioContext
            if (!window.tempAudioContext) {
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000 // Low frequency for iOS
              });
              
              widgetLog(`Created new AudioContext with sampleRate ${window.tempAudioContext.sampleRate}`);
            }
            
            // Try to unlock context if it's in suspended state
            if (window.tempAudioContext.state === 'suspended') {
              widgetLog('Attempting to resume suspended AudioContext');
              await window.tempAudioContext.resume();
              widgetLog(`AudioContext state after resume: ${window.tempAudioContext.state}`);
            }
            
            // Generate sounds with different frequencies for unlocking
            const frequencies = [100, 200, 300, 500, 1000, 1500];
            for (const freq of frequencies) {
              const oscillator = window.tempAudioContext.createOscillator();
              const gainNode = window.tempAudioContext.createGain();
              
              gainNode.gain.value = 0.01; // Very quiet
              oscillator.type = 'sine';
              oscillator.frequency.value = freq;
              oscillator.connect(gainNode);
              gainNode.connect(window.tempAudioContext.destination);
              
              oscillator.start(0);
              oscillator.stop(0.05); // Very short sound
              
              // Small delay between sounds
              await new Promise(r => setTimeout(r, 50));
            }
            
            // Play silence to reinforce the effect
            const silentBuffer = window.tempAudioContext.createBuffer(1, 1, 16000);
            const source = window.tempAudioContext.createBufferSource();
            source.buffer = silentBuffer;
            source.connect(window.tempAudioContext.destination);
            source.start(0);
            
            window.audioContextInitialized = true;
            window.hasPlayedSilence = true;
            this.audioContext = window.tempAudioContext;
            
            widgetLog('AudioContext successfully unlocked');
            return true;
          } catch (e) {
            widgetLog(`Error unlocking AudioContext: ${e ? e.message : 'Unknown'}`, 'warn');
            return false;
          }
        };
        
        // Try both methods in parallel for maximum chance of success
        const [audioResult, contextResult] = await Promise.all([
          unlockAudio(),
          unlockAudioContext()
        ]);
        
        // Give time for full activation
        await new Promise(r => setTimeout(r, 200));
        
        // Activate special flags
        window.audioContextInitialized = true;
        window.hasPlayedSilence = true;
        STATE.iosAudioFullyActivated = audioResult || contextResult;
        
        widgetLog(`iOS audio unlock result: ${STATE.iosAudioFullyActivated ? 'Success' : 'Partial/Failed'}`);
        return STATE.iosAudioFullyActivated;
      } catch (e) {
        widgetLog(`iOS audio aggressive unlock failed: ${e ? e.message : 'Unknown error'}`, 'error');
        // Even if we fail, try to continue
        return true;
      }
    },

    /**
     * Initialize audio capture with improved logic for iOS
     * @returns {Promise<boolean>} Success status
     */
    initAudio: async function() {
      try {
        widgetLog("Requesting microphone access...");
        
        // Check getUserMedia support
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Your browser doesn't support microphone access");
        }
        
        // Check current permission state
        const permissionState = await this.checkMicrophonePermission();
        STATE.microphonePermissionState = permissionState;
        
        widgetLog(`Current microphone permission state: ${permissionState}`);
        
        // Handle denied permission
        if (permissionState === 'denied') {
          widgetLog('Microphone permission denied by user', 'error');
          if (WidgetController && WidgetController.elements && WidgetController.elements.permissionButton) {
            WidgetController.elements.permissionButton.classList.add('visible');
            WidgetController.showMessage("Microphone access is required. Please enable it in your browser settings.");
          }
          return false;
        }
        
        // Special settings for different platforms
        let audioConstraints;
        
        if (DEVICE.isIOS) {
          audioConstraints = { 
            echoCancellation: false,    // Better to disable on iOS
            noiseSuppression: false,    // Disable for faster processing on iOS
            autoGainControl: true,      // Auto gain control helps
            sampleRate: 16000          // Lower sample rate for iOS
          };
        } else if (DEVICE.isAndroid) {
          audioConstraints = { 
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 22050          // Optimal for Android
          };
        } else {
          audioConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 24000          // Higher quality for desktop
          };
        }
        
        // For iOS, unlock audio first
        if (DEVICE.isIOS) {
          await this.aggressiveIOSAudioUnlock();
          
          // Small delay for iOS to process audio activation
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // Request access to microphone with optimal settings
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Microphone access granted with ${DEVICE.isIOS ? 'iOS' : (DEVICE.isAndroid ? 'Android' : 'desktop')} settings`);
          
          // Mark permission as granted
          STATE.microphonePermissionState = 'granted';
          
          // Hide permission button if visible
          if (WidgetController && WidgetController.elements && WidgetController.elements.permissionButton) {
            WidgetController.elements.permissionButton.classList.remove('visible');
          }
        } catch (micError) {
          widgetLog(`Microphone access error: ${micError ? micError.message : 'Unknown'}`, 'error');
          
          // For iOS, try fallback with basic settings
          if (DEVICE.isIOS) {
            try {
              // Try to get access with minimal settings
              this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
              widgetLog('Microphone access granted with basic settings for iOS');
              STATE.microphonePermissionState = 'granted';
            } catch (fallbackError) {
              // On iOS make multiple attempts with delay
              widgetLog('Attempting to get microphone access with delay...', 'warn');
              
              // Reactivate audio
              await this.aggressiveIOSAudioUnlock();
              
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, 500));
              
              try {
                // Last attempt
                this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { 
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false
                }});
                widgetLog('Microphone access granted after retry');
                STATE.microphonePermissionState = 'granted';
              } catch (finalError) {
                widgetLog(`Final microphone access attempt failed: ${finalError ? finalError.message : 'Unknown'}`, 'error');
                if (WidgetController && WidgetController.elements && WidgetController.elements.permissionButton) {
                  WidgetController.elements.permissionButton.classList.add('visible');
                  WidgetController.showMessage("Please allow microphone access");
                }
                STATE.microphonePermissionState = 'denied';
                return false;
              }
            }
          } else if (DEVICE.isAndroid) {
            // For Android, try a simpler approach
            try {
              this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
              widgetLog('Microphone access granted with basic settings for Android');
              STATE.microphonePermissionState = 'granted';
            } catch (androidError) {
              widgetLog(`Android microphone access failed: ${androidError ? androidError.message : 'Unknown'}`, 'error');
              if (WidgetController && WidgetController.elements && WidgetController.elements.permissionButton) {
                WidgetController.elements.permissionButton.classList.add('visible');
                WidgetController.showMessage("Please allow microphone access");
              }
              STATE.microphonePermissionState = 'denied';
              return false;
            }
          } else {
            // For desktop, show permission UI
            if (WidgetController && WidgetController.elements && WidgetController.elements.permissionButton) {
              WidgetController.elements.permissionButton.classList.add('visible');
              WidgetController.showMessage("Microphone access is required");
            }
            STATE.microphonePermissionState = 'denied';
            return false;
          }
        }
        
        // For iOS use existing context if available
        if (DEVICE.isIOS) {
          if (window.tempAudioContext) {
            this.audioContext = window.tempAudioContext;
            
            if (this.audioContext.state === 'suspended') {
              try {
                await this.audioContext.resume();
                window.audioContextInitialized = true;
                widgetLog('Existing AudioContext activated on iOS');
              } catch (e) {
                widgetLog(`Error resuming existing AudioContext: ${e ? e.message : 'Unknown'}`, 'warn');
                
                // Try to create a new one as fallback
                try {
                  this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: 16000 // Lower load for iOS
                  });
                  window.tempAudioContext = this.audioContext;
                  window.audioContextInitialized = true;
                } catch (e2) {
                  widgetLog(`Failed to create fallback AudioContext: ${e2 ? e2.message : 'Unknown'}`, 'error');
                  return false;
                }
              }
            }
          } else {
            // Create new AudioContext with lower frequency for iOS
            try {
              this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000 // Lower load for iOS
              });
              window.tempAudioContext = this.audioContext;
              window.audioContextInitialized = true;
            } catch (e) {
              widgetLog(`Failed to create new AudioContext for iOS: ${e ? e.message : 'Unknown'}`, 'error');
              return false;
            }
          }
        } else if (DEVICE.isAndroid) {
          // For Android
          try {
            const contextOptions = { sampleRate: 22050 }; // Better for Android
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
          } catch (e) {
            widgetLog(`Failed to create AudioContext for Android: ${e ? e.message : 'Unknown'}`, 'error');
            
            // Fallback to basic context
            try {
              this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e2) {
              widgetLog(`Failed to create fallback AudioContext: ${e2 ? e2.message : 'Unknown'}`, 'error');
              return false;
            }
          }
        } else {
          // For desktop
          try {
            const contextOptions = { sampleRate: 24000 };
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
          } catch (e) {
            widgetLog(`Failed to create AudioContext for desktop: ${e ? e.message : 'Unknown'}`, 'error');
            
            // Fallback
            try {
              this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e2) {
              widgetLog(`Failed to create fallback AudioContext: ${e2 ? e2.message : 'Unknown'}`, 'error');
              return false;
            }
          }
        }
        
        widgetLog(`AudioContext created with sample rate ${this.audioContext.sampleRate} Hz`);
        
        // Optimized buffer sizes for different devices
        const bufferSize = DEVICE.isIOS ? 2048 : // Larger for iOS for stability
                          DEVICE.isAndroid ? 1024 : 
                          2048;
        
        // Check ScriptProcessorNode support
        if (this.audioContext.createScriptProcessor) {
          this.audioProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
          widgetLog(`Created ScriptProcessorNode with buffer size ${bufferSize}`);
        } else if (this.audioContext.createJavaScriptNode) { // For older Safari versions
          this.audioProcessor = this.audioContext.createJavaScriptNode(bufferSize, 1, 1);
          widgetLog(`Created legacy JavaScriptNode with buffer size ${bufferSize}`);
        } else {
          throw new Error("Your browser doesn't support audio processing");
        }
        
        widgetLog("Audio successfully initialized");
        
        // Activate flags for iOS
        if (DEVICE.isIOS) {
          window.audioContextInitialized = true;
          window.hasPlayedSilence = true;
          STATE.iosAudioFullyActivated = true;
        }
        
        return true;
      } catch (error) {
        widgetLog(`Audio initialization error: ${error ? error.message : 'Unknown error'}`, "error");
        return false;
      }
    },
    
    /**
     * Start audio capture from microphone
     * @param {Function} onAudioProcess - Callback for processing audio data
     * @returns {boolean} Success status
     */
    startCapture: function(onAudioProcess) {
      if (!this.audioContext || !this.mediaStream || !this.audioProcessor) {
        widgetLog('Cannot start capture: audio not properly initialized', 'error');
        return false;
      }
      
      try {
        // Connect audio nodes
        const streamSource = this.audioContext.createMediaStreamSource(this.mediaStream);
        streamSource.connect(this.audioProcessor);
        
        // For iOS do NOT connect directly to output to avoid feedback
        if (!DEVICE.isIOS) {
          this.audioProcessor.connect(this.audioContext.destination);
        } else {
          // For iOS create an "empty" node to avoid feedback
          const gainNode = this.audioContext.createGain();
          gainNode.gain.value = 0; // Set volume to zero
          this.audioProcessor.connect(gainNode);
          gainNode.connect(this.audioContext.destination);
          widgetLog('Using zero gainNode for iOS to prevent feedback');
        }
        
        // Set callback for audio processing
        this.audioProcessor.onaudioprocess = onAudioProcess;
        
        // Activate flags for iOS
        if (DEVICE.isIOS) {
          window.audioContextInitialized = true;
          window.hasPlayedSilence = true;
          STATE.iosAudioFullyActivated = true;
        }
        
        widgetLog('Audio capture started successfully');
        return true;
      } catch (e) {
        widgetLog(`Error starting audio capture: ${e ? e.message : 'Unknown error'}`, 'error');
        return false;
      }
    },
    
    /**
     * Stop audio capture
     */
    stopCapture: function() {
      if (this.audioProcessor) {
        try {
          this.audioProcessor.disconnect();
          widgetLog('Audio recording stopped');
        } catch (e) {
          widgetLog(`Error stopping audio processing: ${e ? e.message : 'Unknown error'}`, 'warn');
        }
      }
      
      if (this.mediaStream) {
        try {
          // Stop all tracks
          this.mediaStream.getTracks().forEach(track => track.stop());
          this.mediaStream = null;
          widgetLog('Media stream tracks stopped');
        } catch (e) {
          widgetLog(`Error stopping media stream: ${e ? e.message : 'Unknown error'}`, 'warn');
        }
      }
    },
    
    /**
     * Create simple WAV file from PCM data
     * @param {ArrayBuffer} pcmBuffer - PCM audio data
     * @param {number} sampleRate - Sample rate in Hz
     * @returns {ArrayBuffer} WAV file data
     */
    createWavFromPcm: function(pcmBuffer, sampleRate = 24000) {
      // Create WAV header
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      
      // "RIFF" chunk descriptor
      view.setUint8(0, 'R'.charCodeAt(0));
      view.setUint8(1, 'I'.charCodeAt(0));
      view.setUint8(2, 'F'.charCodeAt(0));
      view.setUint8(3, 'F'.charCodeAt(0));
      
      view.setUint32(4, 36 + pcmBuffer.byteLength, true); // File size - 8
      
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
      
      view.setUint32(16, 16, true); // fmt subchunk size
      view.setUint16(20, 1, true);  // Audio format (1 = PCM)
      view.setUint16(22, 1, true);  // Number of channels (1 = mono)
      view.setUint32(24, sampleRate, true); // Sample rate
      view.setUint32(28, sampleRate * 2, true); // Byte rate (SampleRate * NumChannels * BitsPerSample/8)
      view.setUint16(32, 2, true);  // Block align (NumChannels * BitsPerSample/8)
      view.setUint16(34, 16, true); // Bits per sample
      
      // "data" subchunk
      view.setUint8(36, 'd'.charCodeAt(0));
      view.setUint8(37, 'a'.charCodeAt(0));
      view.setUint8(38, 't'.charCodeAt(0));
      view.setUint8(39, 'a'.charCodeAt(0));
      
      view.setUint32(40, pcmBuffer.byteLength, true); // Data size
      
      // Combine header and PCM data
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      
      return wavBuffer;
    },
    
    /**
     * Play audio from base64 string with improved logic for iOS
     * @param {string} audioBase64 - Base64 encoded audio data
     * @param {Function} onComplete - Callback when playback completes
     * @param {Function} onError - Callback on error
     */
    playAudio: function(audioBase64, onComplete, onError) {
      if (!audioBase64 || typeof audioBase64 !== 'string') {
        if (onError) onError(new Error('Invalid audio data'));
        return;
      }
      
      try {
        const playAudioFn = async () => {
          const audioData = DataUtils.base64ToArrayBuffer(audioBase64);
          if (audioData.byteLength === 0) {
            if (onComplete) onComplete();
            return;
          }
          
          // For iOS do additional AudioContext activation before playback
          if (DEVICE.isIOS && !STATE.iosAudioFullyActivated) {
            await this.aggressiveIOSAudioUnlock();
          }
          
          const wavBuffer = this.createWavFromPcm(audioData);
          const blob = new Blob([wavBuffer], { type: 'audio/wav' });
          const audioUrl = URL.createObjectURL(blob);
          
          // Use single audio element for iOS
          const audio = new Audio();
          audio.src = audioUrl;
          
          // Preload for iOS
          audio.preload = 'auto';
          audio.load();
          
          // Track playback readiness
          audio.oncanplaythrough = function() {
            // Try to play
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
              playPromise.catch(error => {
                widgetLog(`Playback error: ${error ? error.message : 'Unknown'}`, "error");
                
                if (error.name === 'NotAllowedError' && DEVICE.isIOS) {
                  // On iOS try again after unlocking
                  AudioManager.aggressiveIOSAudioUnlock().then(() => {
                    setTimeout(() => {
                      audio.play().catch(e => {
                        if (onError) onError(new Error('iOS playback not allowed'));
                      });
                    }, 200);
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
          
          audio.onerror = function(e) {
            widgetLog(`Audio playback error: ${e.currentTarget.error ? e.currentTarget.error.message : 'Unknown'}`, 'error');
            URL.revokeObjectURL(audioUrl);
            if (onError) onError(new Error('Audio playback error'));
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
        widgetLog(`Audio playback error: ${error ? error.message : 'Unknown'}`, "error");
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
      try {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 10000; // Process in chunks to avoid call stack issues
        
        for (let i = 0; i < bytes.byteLength; i += chunk) {
          const slice = bytes.subarray(i, Math.min(i + chunk, bytes.byteLength));
          for (let j = 0; j < slice.length; j++) {
            binary += String.fromCharCode(slice[j]);
          }
        }
        
        return btoa(binary);
      } catch (e) {
        widgetLog(`Error converting ArrayBuffer to base64: ${e ? e.message : 'Unknown'}`, 'error');
        return '';
      }
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
        widgetLog(`Error decoding base64: ${e ? e.message : 'Unknown'}`, "error");
        return new ArrayBuffer(0);
      }
    },
    
    /**
     * Generate a unique ID for debugging
     * @returns {string} Unique identifier
     */
    generateUUID: function() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
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
    reconnectTimeoutId: null,
    connectionId: null,
    
    /**
     * Initialize connection settings
     * @param {string} serverUrl - Server base URL
     * @param {string} assistantId - Assistant ID
     */
    init: function(serverUrl, assistantId) {
      this.serverUrl = serverUrl;
      
      // Ensure proper URL format for WebSocket
      let wsUrl;
      if (serverUrl.startsWith('https://')) {
        wsUrl = serverUrl.replace('https://', 'wss://');
      } else if (serverUrl.startsWith('http://')) {
        wsUrl = serverUrl.replace('http://', 'ws://');
      } else {
        // If no protocol, use secure WebSocket for production
        if (window.location.protocol === 'https:') {
          wsUrl = 'wss://' + serverUrl;
        } else {
          wsUrl = 'ws://' + serverUrl;
        }
      }
      
      // Create unique connection ID for debugging
      this.connectionId = DataUtils.generateUUID().substring(0, 8);
      
      // Ensure path ends with slash before adding ws endpoint
      if (!wsUrl.endsWith('/')) {
        wsUrl += '/';
      }
      
      this.wsUrl = wsUrl + 'ws/' + assistantId;
      widgetLog(`WebSocket URL configured: ${this.wsUrl} (ID: ${this.connectionId})`);
    },
    
    /**
     * Establish WebSocket connection
     * @param {Object} callbacks - Callback functions for connection events
     * @returns {Promise<boolean>} Connection success
     */
    connect: async function(callbacks) {
      try {
        if (callbacks.onConnecting) callbacks.onConnecting();
        widgetLog(`Connecting to WebSocket (ID: ${this.connectionId})...`);
        
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
        
        // Clear reconnect timeout if exists
        if (this.reconnectTimeoutId) {
          clearTimeout(this.reconnectTimeoutId);
          this.reconnectTimeoutId = null;
        }
        
        // Ensure WebSocket URL is valid
        if (!this.wsUrl || 
            !(this.wsUrl.startsWith('ws://') || this.wsUrl.startsWith('wss://'))) {
          throw new Error(`Invalid WebSocket URL: ${this.wsUrl}`);
        }
        
        // Create connection promise with timeout
        const connectionPromise = new Promise((resolve, reject) => {
          try {
            // Create new WebSocket connection
            this.websocket = new WebSocket(this.wsUrl);
            
            // Set binary type for efficient audio transfer
            this.websocket.binaryType = 'arraybuffer';
            
            // Connection established
            this.websocket.onopen = () => {
              widgetLog(`WebSocket connection established (ID: ${this.connectionId})`);
              STATE.isConnected = true;
              STATE.isReconnecting = false;
              STATE.reconnectAttempts = 0;
              STATE.connectionFailedPermanently = false;
              
              // Initialize ping/pong variables
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
                    widgetLog(`Error sending ping: ${e ? e.message : 'Unknown'}`, "error");
                  }
                }
              }, pingIntervalTime);
              
              resolve(true);
            };
            
            // Message handling
            this.websocket.onmessage = (event) => {
              if (callbacks.onMessage) callbacks.onMessage(event);
            };
            
            // Connection closed
            this.websocket.onclose = (event) => {
              widgetLog(`WebSocket connection closed: code=${event.code}, reason=${event.reason} (ID: ${this.connectionId})`);
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
              const errorMsg = error ? (error.message || 'WebSocket error') : 'Unknown WebSocket error';
              widgetLog(`WebSocket error: ${errorMsg} (ID: ${this.connectionId})`, 'error');
              
              if (callbacks.onError) {
                callbacks.onError(error);
              }
              
              reject(new Error(errorMsg));
            };
          } catch (e) {
            reject(e);
          }
        });
        
        // Set connection timeout
        const timeoutPromise = new Promise((_, reject) => {
          this.connectionTimeout = setTimeout(() => {
            reject(new Error("Connection timeout exceeded"));
          }, CONFIG.CONNECTION_TIMEOUT);
        });
        
        // Race connection against timeout
        await Promise.race([connectionPromise, timeoutPromise]);
        
        // Clear timeout after successful connection
        clearTimeout(this.connectionTimeout);
        
        if (callbacks.onConnected) callbacks.onConnected();
        
        return true;
      } catch (error) {
        clearTimeout(this.connectionTimeout);
        
        const errorMsg = error ? (error.message || error.toString()) : 'Unknown connection error';
        widgetLog(`Connection error: ${errorMsg} (ID: ${this.connectionId})`, 'error');
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
                  
          widgetLog(`Reconnecting in ${delay/1000} seconds (attempt ${STATE.reconnectAttempts}/${maxAttempts})`);
          
          if (callbacks.onReconnecting) {
            callbacks.onReconnecting(delay, STATE.reconnectAttempts, maxAttempts);
          }
          
          this.reconnectTimeoutId = setTimeout(() => {
            this.connect(callbacks);
          }, delay);
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
        widgetLog(`Error sending message: ${e ? e.message : 'Unknown'}`, 'error');
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
      
      if (this.reconnectTimeoutId) {
        clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = null;
      }
      
      if (this.websocket) {
        try {
          this.websocket.close(1000, "Normal closure");
        } catch (e) {
          widgetLog(`Error closing connection: ${e ? e.message : 'Unknown'}`, 'warn');
        }
        this.websocket = null;
      }
      
      STATE.isConnected = false;
      widgetLog(`Connection closed (ID: ${this.connectionId})`);
    }
  };

  /**
   * Main widget controller
   */
  const WidgetController = {
    elements: null,
    audioConfig: null,
    minimumAudioLength: 300,
    silenceCheckIntervalId: null,
    silenceStartTime: null,
    bufferCheckIntervalId: null,
    manualListen: false,
    debugMode: false,
    
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
      if (DEVICE.isIOS) {
        this.audioConfig = CONFIG.IOS_AUDIO;
      } else if (DEVICE.isAndroid) {
        this.audioConfig = CONFIG.ANDROID_AUDIO;
      } else {
        this.audioConfig = CONFIG.DESKTOP_AUDIO;
      }
      
      // Set minimum audio length based on device
      this.minimumAudioLength = DEVICE.isIOS ? CONFIG.IOS_AUDIO.minimumRecordTime : 
                               DEVICE.isAndroid ? 800 : 
                               300;
      
      // Initialize connection manager
      ConnectionManager.init(serverUrl, assistantId);
      
      // Create audio visualization bars
      this.createAudioBars();
      
      // Attach event listeners
      this.attachEventListeners();
      
      // Setup debug toggle if in development environment
      this.setupDebugTools();
      
      // Connect to server
      this.connectToServer();
      
      // Check DOM and widget state after initialization
      this.checkInitialization();
    },
    
    /**
     * Setup debug tools
     */
    setupDebugTools: function() {
      // Check if we're in a development or testing environment
      const isDev = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' || 
                    window.location.hostname.includes('dev.') || 
                    window.location.hostname.includes('test.') ||
                    window.location.hostname.includes('staging.');
      
      // Show debug button only in development environments
      if (isDev) {
        if (this.elements.debugButton) {
          this.elements.debugButton.style.display = 'block';
        }
      } else {
        if (this.elements.debugButton) {
          this.elements.debugButton.style.display = 'none';
        }
      }
      
      // Attach debug button event
      if (this.elements.debugButton) {
        this.elements.debugButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleDebugPanel();
        });
      }
      
      // Debug panel close button
      if (this.elements.debugClose) {
        this.elements.debugClose.addEventListener('click', (e) => {
          e.preventDefault();
          this.elements.debugPanel.classList.remove('visible');
        });
      }
      
      // Debug toggle button
      if (this.elements.debugToggle) {
        this.elements.debugToggle.addEventListener('click', (e) => {
          e.preventDefault();
          CONFIG.DEBUG_MODE = !CONFIG.DEBUG_MODE;
          this.debugMode = CONFIG.DEBUG_MODE;
          widgetLog(`Debug mode: ${CONFIG.DEBUG_MODE ? 'ON' : 'OFF'}`);
          alert(`Debug mode: ${CONFIG.DEBUG_MODE ? 'ON' : 'OFF'}`);
          this.updateDebugLogs();
        });
      }
      
      // Debug copy button
      if (this.elements.debugCopy) {
        this.elements.debugCopy.addEventListener('click', (e) => {
          e.preventDefault();
          const logs = getDebugInfo();
          
          // Try to copy to clipboard
          try {
            navigator.clipboard.writeText(logs).then(() => {
              alert('Debug logs copied to clipboard');
            }).catch(err => {
              // Use fallback for older browsers
              const textarea = document.createElement('textarea');
              textarea.value = logs;
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              document.body.removeChild(textarea);
              alert('Debug logs copied to clipboard');
            });
          } catch (e) {
            alert('Failed to copy logs. Your browser may not support this feature.');
          }
        });
      }
      
      // Debug clear button
      if (this.elements.debugClear) {
        this.elements.debugClear.addEventListener('click', (e) => {
          e.preventDefault();
          STATE.debugQueue = [];
          window.widgetDebugLogs = [];
          this.updateDebugLogs();
          widgetLog('Debug logs cleared');
        });
      }
    },
    
    /**
     * Toggle debug panel visibility
     */
    toggleDebugPanel: function() {
      if (!this.elements.debugPanel) return;
      
      const isVisible = this.elements.debugPanel.classList.contains('visible');
      
      if (!isVisible) {
        this.elements.debugPanel.classList.add('visible');
        this.updateDebugLogs();
      } else {
        this.elements.debugPanel.classList.remove('visible');
      }
    },
    
    /**
     * Update debug logs in panel
     */
    updateDebugLogs: function() {
      if (!this.elements.debugLogs) return;
      
      const logs = getDebugInfo();
      this.elements.debugLogs.textContent = logs;
      
      // Scroll to bottom
      if (this.elements.debugLogs.parentElement) {
        this.elements.debugLogs.parentElement.scrollTop = this.elements.debugLogs.parentElement.scrollHeight;
      }
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
        if (!this.elements.audioBars) return;
        
        const bars = this.elements.audioBars.querySelectorAll('.wellcomeai-audio-bar');
        if (!bars || bars.length === 0) return;
        
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
          
          // Device-specific multipliers for visualization
          const multiplier = DEVICE.isIOS ? 200 : 
                          (DEVICE.isAndroid ? 150 : 100);
          
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
      if (!this.elements.audioBars) return;
      
      const bars = this.elements.audioBars.querySelectorAll('.wellcomeai-audio-bar');
      if (!bars) return;
      
      bars.forEach(bar => {
        bar.style.height = '2px';
      });
    },
    
    /**
     * Attach event listeners to widget elements
     */
    attachEventListeners: function() {
      // Open widget button
      if (this.elements.button) {
        this.elements.button.addEventListener('click', (e) => {
          widgetLog('Button clicked');
          e.preventDefault();
          e.stopPropagation();
          this.openWidget();
        });
      }
    
      // Close widget button
      if (this.elements.closeBtn) {
        this.elements.closeBtn.addEventListener('click', (e) => {
          widgetLog('Close button clicked');
          e.preventDefault();
          e.stopPropagation();
          this.closeWidget();
        });
      }
      
      // Main circle (to start voice recognition)
      if (this.elements.mainCircle) {
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
      }
      
      // iOS audio activation button
      if (DEVICE.isIOS && this.elements.iosAudioButton) {
        this.elements.iosAudioButton.addEventListener('click', () => {
          widgetLog('iOS audio button clicked');
          
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
              // If unlock fails, try more aggressive unlock
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
      
      // Permission button
      if (this.elements.permissionButton) {
        this.elements.permissionButton.addEventListener('click', () => {
          widgetLog('Permission button clicked');
          
          // Check if we can request mic access directly
          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ audio: true })
              .then(stream => {
                // Stop the stream immediately - we just needed permission
                stream.getTracks().forEach(track => track.stop());
                
                this.elements.permissionButton.classList.remove('visible');
                widgetLog('Microphone permission granted via button click');
                
                // Update permission state
                STATE.microphonePermissionState = 'granted';
                
                // Try to start listening if widget is open
                if (STATE.isWidgetOpen && STATE.isConnected && !STATE.isListening) {
                  setTimeout(() => {
                    this.startListening();
                  }, 500);
                }
              })
              .catch(err => {
                widgetLog(`Microphone access error: ${err ? err.message : 'Unknown'}`, 'error');
                this.showMessage("Please enable microphone access in your browser settings");
              });
          } else {
            this.showMessage("Please enable microphone access in your browser settings");
          }
        });
      }
      
      // Retry connection button
      if (this.elements.retryButton) {
        this.elements.retryButton.addEventListener('click', () => {
          widgetLog('Retry button clicked');
          this.resetConnection();
        });
      }
      
      // Document interaction events - close widget when clicking outside
      document.addEventListener('click', (e) => {
        if (STATE.isWidgetOpen && this.elements.container && 
            !this.elements.container.contains(e.target) &&
            !this.elements.debugPanel.contains(e.target)) {
          this.closeWidget();
        }
      });
      
      // Keyboard events for accessibility
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && STATE.isWidgetOpen) {
          this.closeWidget();
        }
      });
      
      // Special handling for Android audio activation
      if (DEVICE.isAndroid) {
        document.addEventListener('click', function androidAudioInit() {
          if (window.audioContextInitialized) {
            document.removeEventListener('click', androidAudioInit);
            return;
          }
          
          try {
            // Create a silent audio context
            const tempContext = new (window.AudioContext || window.webkitAudioContext)();
            const silentBuffer = tempContext.createBuffer(1, 1, 22050);
            const source = tempContext.createBufferSource();
            source.buffer = silentBuffer;
            source.connect(tempContext.destination);
            source.start(0);
            
            window.tempAudioContext = tempContext;
            window.audioContextInitialized = true;
            widgetLog("Android audio context initialized via click");
          } catch (e) {
            widgetLog(`Android audio init failed: ${e ? e.message : 'Unknown error'}`, 'warn');
          }
        }, { once: false });
      }
    },
    
    /**
     * Open the widget
     */
    openWidget: function() {
      if (STATE.isWidgetOpen) return;
      
      STATE.isWidgetOpen = true;
      if (this.elements.container) {
        this.elements.container.classList.add('active');
      }
      this.showStatusIndicator();
      
      // For iOS, show audio activation button if needed
      if (DEVICE.isIOS && !STATE.iosAudioFullyActivated) {
        if (this.elements.iosAudioButton) {
          this.elements.iosAudioButton.classList.add('visible');
        }
        
        // Try to unlock audio automatically
        AudioManager.aggressiveIOSAudioUnlock().then(success => {
          if (success) {
            if (this.elements.iosAudioButton) {
              this.elements.iosAudioButton.classList.remove('visible');
            }
            STATE.iosAudioFullyActivated = true;
          }
        });
      }
      
      // If no connection established, try to connect
      if (!STATE.isConnected && !STATE.isReconnecting && !STATE.connectionFailedPermanently) {
        this.connectToServer();
      }
      
      // Check microphone permission state
      AudioManager.checkMicrophonePermission().then(state => {
        STATE.microphonePermissionState = state;
        
        if (state === 'denied') {
          if (this.elements.permissionButton) {
            this.elements.permissionButton.classList.add('visible');
          }
          this.showMessage("Microphone access is required");
        }
      });
      
      widgetLog('Widget opened');
    },
    
    /**
     * Close the widget
     */
    closeWidget: function() {
      if (!STATE.isWidgetOpen) return;
      
      STATE.isWidgetOpen = false;
      if (this.elements.container) {
        this.elements.container.classList.remove('active');
      }
      
      // Stop listening if active
      if (STATE.isListening) {
        this.stopListening();
      }
      
      // Hide all messages and indicators
      this.hideMessage();
      this.hideStatusIndicator();
      this.hideConnectionError();
      
      if (this.elements.permissionButton) {
        this.elements.permissionButton.classList.remove('visible');
      }
      
      if (this.elements.iosAudioButton) {
        this.elements.iosAudioButton.classList.remove('visible');
      }
      
      widgetLog('Widget closed');
    },
    
    /**
     * Connect to server
     */
    connectToServer: function() {
      // Show loader during connection
      if (this.elements.loaderModal) {
        this.elements.loaderModal.classList.add('active');
      }
      this.updateStatus('connecting', 'Connecting...');
      
      ConnectionManager.connect({
        onConnecting: () => {
          widgetLog('Connecting to server...');
          this.updateStatus('connecting', 'Connecting...');
        },
        
        onConnected: () => {
          widgetLog('Connected to server');
          if (this.elements.loaderModal) {
            this.elements.loaderModal.classList.remove('active');
          }
          this.updateStatus('connected', 'Connected');
          
          // If widget is open, show status
          if (STATE.isWidgetOpen) {
            this.showStatusIndicator();
          }
          
          // Hide connection error if visible
          this.hideConnectionError();
        },
        
        onMessage: (event) => {
          this.handleServerMessage(event);
        },
        
        onReconnecting: (delay, attempt, maxAttempts) => {
          widgetLog(`Reconnecting (${attempt}/${maxAttempts})...`);
          this.updateStatus('connecting', `Reconnecting (${attempt}/${maxAttempts})...`);
          
          // Show connection error if widget is open
          if (STATE.isWidgetOpen) {
            this.showConnectionError(`Reconnecting... (${attempt}/${maxAttempts})`);
          }
        },
        
        onReconnectNeeded: (delay = 3000) => {
          if (STATE.isReconnecting) return;
          
          this.updateStatus('connecting', 'Connection lost');
          
          STATE.isReconnecting = true;
          
          if (STATE.isListening) {
            this.stopListening();
          }
          
          // Reconnect after delay
          setTimeout(() => {
            if (STATE.isWidgetOpen) {
              this.connectToServer();
            } else {
              STATE.isReconnecting = false;
            }
          }, delay);
        },
        
        onConnectionFailed: (message) => {
          widgetLog(`Connection failed: ${message}`, 'error');
          
          if (this.elements.loaderModal) {
            this.elements.loaderModal.classList.remove('active');
          }
          this.updateStatus('disconnected', 'Disconnected');
          
          if (STATE.isWidgetOpen) {
            this.showConnectionError(message);
          }
        },
        
        onError: (error) => {
          const errorMsg = error ? (error.message || error.toString()) : 'Unknown error';
          widgetLog(`Connection error: ${errorMsg}`, 'error');
          this.updateStatus('disconnected', 'Error');
        }
      });
    },
    
    /**
     * Reset connection and attempt reconnect
     */
    resetConnection: function() {
      STATE.connectionFailedPermanently = false;
      STATE.reconnectAttempts = 0;
      STATE.isReconnecting = false;
      
      // Hide connection error message
      this.hideConnectionError();
      
      // Reconnect
      this.connectToServer();
    },
    
    /**
     * Handle messages from the server
     * @param {MessageEvent} event - WebSocket message event
     */
    handleServerMessage: function(event) {
      try {
        // Check if it's a binary audio message
        if (event.data instanceof ArrayBuffer) {
          widgetLog(`Received binary audio data: ${event.data.byteLength} bytes`);
          this.handleAudioResponse(event.data);
          return;
        }
        
        // Parse JSON message
        const message = JSON.parse(event.data);
        
        // Handle different message types
        switch (message.type) {
          case 'pong':
            // Update last pong time for connection health check
            STATE.lastPongTime = Date.now();
            break;
            
          case 'text':
            if (message.text && message.text.trim()) {
              this.showMessage(message.text);
            }
            break;
            
          case 'audio_start':
            widgetLog('Server sent audio_start signal');
            // Handle start of audio from server
            this.beginAudioPlayback(message.data);
            break;
            
          case 'audio_chunk':
            widgetLog('Received audio chunk');
            // Handle audio chunk from server
            if (message.data) {
              this.queueAudioChunk(message.data);
            }
            break;
            
          case 'audio_end':
            widgetLog('Server sent audio_end signal');
            // Handle end of audio from server
            this.finishAudioPlayback();
            break;
            
          case 'error':
            widgetLog(`Server error: ${message.message}`, 'error');
            this.showMessage(`Error: ${message.message}`);
            break;
            
          default:
            widgetLog(`Unknown message type: ${message.type}`, 'warn');
        }
      } catch (error) {
        const errorMsg = error ? (error.message || error.toString()) : 'Unknown error';
        widgetLog(`Error handling server message: ${errorMsg}`, 'error');
      }
    },
    
    /**
     * Show message in the widget
     * @param {string} text - Message text
     */
    showMessage: function(text) {
      if (!text || !this.elements.messageDisplay) return;
      
      this.elements.messageDisplay.textContent = text;
      this.elements.messageDisplay.classList.add('show');
      
      // Auto-hide message after 5 seconds
      setTimeout(() => {
        this.hideMessage();
      }, 5000);
    },
    
    /**
     * Hide message display
     */
    hideMessage: function() {
      if (this.elements.messageDisplay) {
        this.elements.messageDisplay.classList.remove('show');
      }
    },
    
    /**
     * Show connection error
     * @param {string} message - Error message
     */
    showConnectionError: function(message) {
      if (this.elements.connectionError) {
        this.elements.connectionError.textContent = message || 'Connection error';
        
        // Add retry button if not already present
        if (!this.elements.connectionError.querySelector('.wellcomeai-retry-button') &&
            this.elements.retryButton) {
          this.elements.connectionError.appendChild(this.elements.retryButton);
        }
        
        this.elements.connectionError.classList.add('visible');
      }
    },
    
    /**
     * Hide connection error
     */
    hideConnectionError: function() {
      if (this.elements.connectionError) {
        this.elements.connectionError.classList.remove('visible');
      }
    },
    
    /**
     * Update connection status indicator
     * @param {string} status - Status type (connected, connecting, disconnected)
     * @param {string} text - Status text
     */
    updateStatus: function(status, text) {
      if (!this.elements.statusDot || !this.elements.statusText) return;
      
      // Update status dot
      this.elements.statusDot.className = 'wellcomeai-status-dot';
      if (status === 'disconnected') {
        this.elements.statusDot.classList.add('disconnected');
      } else if (status === 'connecting') {
        this.elements.statusDot.classList.add('connecting');
      }
      
      // Update status text
      this.elements.statusText.textContent = text || '';
      
      // Update debug logs if panel is visible
      if (this.elements.debugPanel && this.elements.debugPanel.classList.contains('visible')) {
        this.updateDebugLogs();
      }
    },
    
    /**
     * Show status indicator
     */
    showStatusIndicator: function() {
      if (this.elements.statusIndicator) {
        this.elements.statusIndicator.classList.add('show');
      }
    },
    
    /**
     * Hide status indicator
     */
    hideStatusIndicator: function() {
      if (this.elements.statusIndicator) {
        this.elements.statusIndicator.classList.remove('show');
      }
    },
    
    /**
     * Start listening for audio input
     */
    startListening: function() {
      if (STATE.isListening || STATE.isPlayingAudio) return;
      
      widgetLog('Starting listening...');
      
      // Initialize audio context and media stream if not already done
      AudioManager.initAudio().then(success => {
        if (!success) {
          widgetLog('Failed to initialize audio', 'error');
          this.showMessage('Microphone access is required');
          return;
        }
        
        // Update UI state
        STATE.isListening = true;
        if (this.elements.mainCircle) {
          this.elements.mainCircle.classList.add('listening');
        }
        
        // Send start listening message to server
        ConnectionManager.send({
          type: 'start_listening'
        });
        
        // Reset audio buffer
        STATE.audioChunksBuffer = [];
        STATE.hasAudioData = false;
        STATE.audioDataStartTime = Date.now();
        
        // Start audio capture
        AudioManager.startCapture((audioEvent) => {
          const audioData = audioEvent.inputBuffer.getChannelData(0);
          
          // Update audio visualization
          this.updateAudioVisualization(audioData);
          
          // Check for audio data (non-silent)
          this.processAudioData(audioData);
        });
        
        // Setup buffer check interval for silence detection
        this.bufferCheckIntervalId = setInterval(() => {
          this.checkAudioBuffer();
        }, this.audioConfig.bufferCheckInterval);
        
        // For iOS, setup auto-commit interval if needed
        if (DEVICE.isIOS && this.audioConfig.forceCommitAudio && this.audioConfig.autoCommitInterval) {
          STATE.autoCommitIntervalId = setInterval(() => {
            // If we have been recording for enough time, force send
            const recordingTime = Date.now() - STATE.audioDataStartTime;
            if (recordingTime > this.audioConfig.autoCommitInterval && STATE.hasAudioData) {
              widgetLog(`Auto-committing audio after ${recordingTime}ms`);
              this.sendAudioBuffer();
            }
          }, this.audioConfig.autoCommitInterval);
        }
        
        // For Android, also setup auto-commit interval
        if (DEVICE.isAndroid && this.audioConfig.autoCommitInterval) {
          STATE.autoCommitIntervalId = setInterval(() => {
            const recordingTime = Date.now() - STATE.audioDataStartTime;
            if (recordingTime > this.audioConfig.autoCommitInterval && STATE.hasAudioData) {
              widgetLog(`Android auto-committing audio after ${recordingTime}ms`);
              this.sendAudioBuffer();
            }
          }, this.audioConfig.autoCommitInterval);
        }
      }).catch(error => {
        const errorMsg = error ? (error.message || error.toString()) : 'Unknown error';
        widgetLog(`Error starting audio capture: ${errorMsg}`, 'error');
        this.showMessage('Error accessing microphone');
      });
    },
    
    /**
     * Stop listening for audio input
     */
    stopListening: function() {
      if (!STATE.isListening) return;
      
      widgetLog('Stopping listening');
      
      // Update UI state
      STATE.isListening = false;
      if (this.elements.mainCircle) {
        this.elements.mainCircle.classList.remove('listening');
      }
      this.resetAudioVisualization();
      
      // Clear intervals
      if (this.silenceCheckIntervalId) {
        clearInterval(this.silenceCheckIntervalId);
        this.silenceCheckIntervalId = null;
      }
      
      if (this.bufferCheckIntervalId) {
        clearInterval(this.bufferCheckIntervalId);
        this.bufferCheckIntervalId = null;
      }
      
      if (STATE.autoCommitIntervalId) {
        clearInterval(STATE.autoCommitIntervalId);
        STATE.autoCommitIntervalId = null;
      }
      
      // Stop audio capture
      AudioManager.stopCapture();
      
      // Send stop_listening message
      ConnectionManager.send({
        type: 'stop_listening'
      });
      
      // Send any remaining audio data
      if (STATE.hasAudioData && STATE.audioChunksBuffer.length > 0) {
        this.sendAudioBuffer();
      }
    },
    
    /**
     * Process incoming audio data
     * @param {Float32Array} audioData - Audio samples
     */
    processAudioData: function(audioData) {
      if (!audioData || audioData.length === 0) return;
      
      // Convert Float32Array to Int16Array for efficient transmission
      const int16Data = new Int16Array(audioData.length);
      
      // Calculate volume for silence detection
      let volume = 0;
      let hasSoundDetected = false;
      
      for (let i = 0; i < audioData.length; i++) {
        // Convert to 16-bit PCM
        int16Data[i] = audioData[i] * 32767;
        
        // Accumulate for volume calculation
        volume += Math.abs(audioData[i]);
        
        // Check for sound detection
        if (Math.abs(audioData[i]) > this.audioConfig.soundDetectionThreshold) {
          hasSoundDetected = true;
        }
      }
      
      // Calculate average volume
      volume = volume / audioData.length;
      
      // Add data to buffer if it contains sound or if we're forcing audio
      if (hasSoundDetected || (DEVICE.isIOS && this.audioConfig.forceAudioActivation)) {
        STATE.hasAudioData = true;
        STATE.audioChunksBuffer.push(int16Data.buffer);
        
        // Reset silence detection
        this.silenceStartTime = null;
      } else if (volume < this.audioConfig.silenceThreshold) {
        // Silence detected
        if (!this.silenceStartTime) {
          this.silenceStartTime = Date.now();
        } else {
          // Check if silence duration exceeds threshold
          const silenceDuration = Date.now() - this.silenceStartTime;
          
          if (silenceDuration >= this.audioConfig.silenceDuration && STATE.hasAudioData) {
            // Send audio buffer and reset
            this.sendAudioBuffer();
            this.silenceStartTime = null;
          }
        }
      } else {
        // Not silent enough to trigger, but not sound either
        this.silenceStartTime = null;
      }
    },
    
    /**
     * Check audio buffer and send if conditions are met
     */
    checkAudioBuffer: function() {
      // Check recording duration
      const recordingDuration = Date.now() - STATE.audioDataStartTime;
      
      // Send buffer if we have data and enough time has passed
      if (STATE.hasAudioData && recordingDuration > this.minimumAudioLength) {
        // For iOS, we may want to wait for auto-commit
        if (DEVICE.isIOS && this.audioConfig.forceCommitAudio) {
          // Let the auto-commit handle it
          return;
        }
        
        // Check if silence period has passed
        if (this.silenceStartTime) {
          const silenceDuration = Date.now() - this.silenceStartTime;
          
          if (silenceDuration >= this.audioConfig.silenceDuration) {
            this.sendAudioBuffer();
          }
        }
      }
    },
    
    /**
     * Send audio buffer to server
     */
    sendAudioBuffer: function() {
      if (!STATE.hasAudioData || STATE.audioChunksBuffer.length === 0) {
        return;
      }
      
      widgetLog(`Sending audio buffer: ${STATE.audioChunksBuffer.length} chunks`);
      
      try {
        // Concatenate all audio chunks
        let totalLength = 0;
        STATE.audioChunksBuffer.forEach(buffer => {
          totalLength += buffer.byteLength;
        });
        
        // Create combined buffer
        const combinedBuffer = new ArrayBuffer(totalLength);
        const combinedView = new Uint8Array(combinedBuffer);
        
        let offset = 0;
        STATE.audioChunksBuffer.forEach(buffer => {
          combinedView.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        });
        
        // Send audio data to server
        if (ConnectionManager.websocket && ConnectionManager.websocket.readyState === WebSocket.OPEN) {
          ConnectionManager.websocket.send(combinedBuffer);
          widgetLog(`Sent ${totalLength} bytes of audio data`);
        } else {
          widgetLog('WebSocket not open, cannot send audio', 'warn');
        }
      } catch (error) {
        const errorMsg = error ? (error.message || error.toString()) : 'Unknown error';
        widgetLog(`Error sending audio: ${errorMsg}`, 'error');
      }
      
      // Reset audio buffer
      STATE.audioChunksBuffer = [];
      STATE.hasAudioData = false;
      STATE.audioDataStartTime = Date.now();
      this.silenceStartTime = null;
    },
    
    /**
     * Handle audio response from server
     * @param {ArrayBuffer} audioData - Binary audio data
     */
    handleAudioResponse: function(audioData) {
      // Convert ArrayBuffer to base64 for storage/playback
      const base64Audio = DataUtils.arrayBufferToBase64(audioData);
      
      // Queue for playback
      this.queueAudioForPlayback(base64Audio);
    },
    
    /**
     * Begin audio playback sequence
     */
    beginAudioPlayback: function() {
      if (STATE.isPlayingAudio) return;
      
      widgetLog('Beginning audio playback');
      
      // Update UI
      STATE.isPlayingAudio = true;
      if (this.elements.mainCircle) {
        this.elements.mainCircle.classList.add('speaking');
      }
      
      // Clear audio queue
      STATE.audioPlaybackQueue = [];
    },
    
    /**
     * Queue audio chunk for playback
     * @param {string} audioBase64 - Base64 encoded audio chunk
     */
    queueAudioChunk: function(audioBase64) {
      if (!audioBase64) return;
      
      // Add to queue
      STATE.audioPlaybackQueue.push(audioBase64);
      
      // Start playback if not already playing
      this.processAudioQueue();
    },
    
    /**
     * Queue complete audio for playback
     * @param {string} audioBase64 - Base64 encoded audio
     */
    queueAudioForPlayback: function(audioBase64) {
      if (!audioBase64) return;
      
      // Begin playback sequence
      this.beginAudioPlayback();
      
      // Queue audio
      this.queueAudioChunk(audioBase64);
    },
    
    /**
     * Process audio playback queue
     */
    processAudioQueue: function() {
      if (!STATE.isPlayingAudio || STATE.audioPlaybackQueue.length === 0) return;
      
      widgetLog(`Processing audio queue: ${STATE.audioPlaybackQueue.length} items`);
      
      // Get next audio chunk
      const audioBase64 = STATE.audioPlaybackQueue.shift();
      
      // Play audio
      AudioManager.playAudio(audioBase64, 
        // On complete
        () => {
          // If queue has more items, play next
          if (STATE.audioPlaybackQueue.length > 0) {
            this.processAudioQueue();
          } else if (STATE.isPlayingAudio) {
            // If no more items and still in playing state, finish playback
            this.finishAudioPlayback();
          }
        },
        // On error
        (error) => {
          const errorMsg = error ? (error.message || error.toString()) : 'Unknown error';
          widgetLog(`Audio playback error: ${errorMsg}`, 'error');
          this.finishAudioPlayback();
        }
      );
    },
    
    /**
     * Finish audio playback
     */
    finishAudioPlayback: function() {
      if (!STATE.isPlayingAudio) return;
      
      widgetLog('Finishing audio playback');
      
      // Update UI
      STATE.isPlayingAudio = false;
      if (this.elements.mainCircle) {
        this.elements.mainCircle.classList.remove('speaking');
      }
      
      // Clear queue
      STATE.audioPlaybackQueue = [];
    },
    
    /**
     * Check initialization status
     */
    checkInitialization: function() {
      setTimeout(() => {
        // Check widget visibility
        if (this.elements.container) {
          const widgetStyle = window.getComputedStyle(this.elements.container);
          if (widgetStyle.display === 'none' || widgetStyle.visibility === 'hidden') {
            widgetLog('Widget is not visible after initialization', 'warn');
          }
          
          // Check if widget is properly positioned
          const rect = this.elements.container.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            widgetLog('Widget has zero dimensions after initialization', 'warn');
          }
        }
        
        // Hide loader when initialization is complete
        if (this.elements.loaderModal) {
          this.elements.loaderModal.classList.remove('active');
        }
        
        // Log device information for debugging
        widgetLog(`Device info: isMobile=${DEVICE.isMobile}, isIOS=${DEVICE.isIOS}, isAndroid=${DEVICE.isAndroid}, ` +
                 `isSafari=${DEVICE.isSafari}, isiPad=${DEVICE.isiPad}, iOSVersion=${DEVICE.iOSVersion}`);
      }, 1000);
    }
  };

  /**
   * Main initialization function
   */
  function initializeWidget() {
    widgetLog('Initializing widget...');
    
    try {
      // Load Font Awesome
      loadFontAwesome();
      
      // Get server URL and assistant ID
      const serverUrl = getServerUrl();
      const assistantId = getAssistantId();
      
      if (!assistantId) {
        widgetLog('No assistant ID provided, widget will not be initialized', 'error');
        return;
      }
      
      // Get widget position
      const position = getWidgetPosition();
      
      // Initialize widget controller
      WidgetController.init(serverUrl, assistantId, position);
      
      widgetLog('Widget initialized successfully');
      
      // Add to global scope for external access
      window.WellcomeAIWidget = {
        log: widgetLog,
        getDebugInfo: getDebugInfo,
        toggleDebug: function() {
          CONFIG.DEBUG_MODE = !CONFIG.DEBUG_MODE;
          widgetLog(`Debug mode set to ${CONFIG.DEBUG_MODE}`);
          return CONFIG.DEBUG_MODE;
        },
        open: function() {
          if (WidgetController) WidgetController.openWidget();
        },
        close: function() {
          if (WidgetController) WidgetController.closeWidget();
        },
        getDeviceInfo: function() {
          return DEVICE;
        }
      };
    } catch (error) {
      const errorMsg = error ? (error.message || error.toString()) : 'Unknown error';
      widgetLog(`Error initializing widget: ${errorMsg}`, 'error');
    }
  }

  // Initialize widget when DOM is fully loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWidget);
  } else {
    initializeWidget();
  }
})();
