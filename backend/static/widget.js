/**
 * WellcomeAI Widget Loader Script
 * Version: 1.3.0
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
    
    // iOS specific settings
    IOS_AUDIO: {
      silenceThreshold: 0.005,     // Even lower threshold for iOS
      silenceDuration: 800,        // Longer silence duration for iOS
      bufferCheckInterval: 150,    // Longer interval for iOS
      soundDetectionThreshold: 0.01 // More sensitive for iOS
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
    audioPlaybackQueue: []
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
     * Unlock audio context on iOS
     * @returns {Promise<boolean>} Success status
     */
    unlockAudioOnIOS: function() {
      if (!DEVICE.isIOS) return Promise.resolve(true);
      
      widgetLog('Attempting to unlock audio on iOS');
      
      return new Promise((resolve) => {
        // Create temporary audio element
        const tempAudio = document.createElement('audio');
        tempAudio.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
        tempAudio.volume = 0;
        
        // Unlock by playing
        const playPromise = tempAudio.play();
        
        if (playPromise !== undefined) {
          playPromise.then(() => {
            // Playback started successfully - audio unlocked
            widgetLog('Successfully unlocked audio through audio element');
            
            // Now initialize AudioContext
            if (!window.tempAudioContext) {
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            if (window.tempAudioContext.state === 'suspended') {
              window.tempAudioContext.resume().then(() => {
                window.audioContextInitialized = true;
                widgetLog('AudioContext successfully activated');
                resolve(true);
              }).catch(err => {
                widgetLog(`Failed to activate AudioContext: ${err.message}`, 'error');
                resolve(false);
              });
            } else {
              window.audioContextInitialized = true;
              resolve(true);
            }
          }).catch(err => {
            widgetLog(`Error unlocking audio: ${err.message}`, 'error');
            resolve(false);
          });
        } else {
          // For very old browsers
          widgetLog('Using fallback unlock method for legacy devices');
          setTimeout(() => {
            this.playSilence(); // Fallback with playing silence
            resolve(true);
          }, 100);
        }
      });
    },
    
    /**
     * Force iOS audio unlock with multiple frequencies
     * @returns {Promise<boolean>} Success status
     */
    forceIOSAudioUnlock: function() {
      if (!DEVICE.isIOS) return Promise.resolve(true);
      
      return new Promise((resolve) => {
        // Play short sounds with different frequencies
        const frequencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
        let index = 0;
        
        const playNextTone = () => {
          if (index >= frequencies.length) {
            window.hasPlayedSilence = true;
            window.audioContextInitialized = true;
            widgetLog('Completed multiple audio unlocking on iOS');
            resolve(true);
            return;
          }
          
          try {
            // Create context if it doesn't exist
            if (!window.tempAudioContext) {
              window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            const ctx = window.tempAudioContext;
            
            if (ctx.state === 'suspended') {
              ctx.resume().then(() => {
                const oscillator = ctx.createOscillator();
                const gainNode = ctx.createGain();
                
                gainNode.gain.value = 0.01; // Very quiet
                oscillator.type = 'sine';
                oscillator.frequency.value = frequencies[index];
                oscillator.connect(gainNode);
                gainNode.connect(ctx.destination);
                
                oscillator.start(0);
                oscillator.stop(0.1);
                
                setTimeout(() => {
                  index++;
                  playNextTone();
                }, 200);
              });
            } else {
              const oscillator = ctx.createOscillator();
              const gainNode = ctx.createGain();
              
              gainNode.gain.value = 0.01;
              oscillator.type = 'sine';
              oscillator.frequency.value = frequencies[index];
              oscillator.connect(gainNode);
              gainNode.connect(ctx.destination);
              
              oscillator.start(0);
              oscillator.stop(0.1);
              
              setTimeout(() => {
                index++;
                playNextTone();
              }, 200);
            }
          } catch (e) {
            widgetLog(`Error unlocking with tones: ${e.message}`, 'warn');
            index++;
            setTimeout(playNextTone, 200);
          }
        };
        
        // Start playing tones
        playNextTone();
      });
    },

    /**
     * Play silence to unlock audio (fallback for iOS)
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
     * Initialize audio capture
     * @returns {Promise<boolean>} Success status
     */
    initAudio: async function() {
      try {
        widgetLog("Requesting microphone permission...");
        
        // Check getUserMedia support
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Your browser doesn't support microphone access");
        }
        
        // Special settings for iOS
        const audioConstraints = DEVICE.isIOS ? 
          { 
            echoCancellation: false, // Better to disable on iOS
            noiseSuppression: true,
            autoGainControl: true
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
        
        // On iOS unlock audio first
        if (DEVICE.isIOS) {
          await this.unlockAudioOnIOS();
        }
        
        // Request microphone access with optimal settings
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          widgetLog(`Microphone access granted (${DEVICE.isIOS ? 'iOS settings' : (DEVICE.isMobile ? 'Android settings' : 'desktop settings')})`);
        } catch (micError) {
          widgetLog(`Microphone access error: ${micError.message}`, 'error');
          
          // For iOS try fallback with basic settings
          if (DEVICE.isIOS) {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            widgetLog('Microphone access granted with basic settings for iOS');
          } else {
            throw micError; // Propagate error
          }
        }
        
        // For iOS use existing context
        if (DEVICE.isIOS) {
          if (window.tempAudioContext) {
            this.audioContext = window.tempAudioContext;
            
            if (this.audioContext.state === 'suspended') {
              await this.audioContext.resume();
              window.audioContextInitialized = true;
              widgetLog('Existing AudioContext activated on iOS');
            }
          } else {
            // Create new AudioContext with lower sample rate for iOS
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
              sampleRate: 16000 // Lower load for iOS
            });
            window.tempAudioContext = this.audioContext;
            window.audioContextInitialized = true;
          }
        } else {
          // For other devices
          const contextOptions = DEVICE.isMobile ? {} : { sampleRate: 24000 };
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
        }
        
        widgetLog(`AudioContext created with sample rate ${this.audioContext.sampleRate} Hz`);
        
        // Optimized buffer sizes for different devices
        const bufferSize = DEVICE.isIOS ? 2048 : // Larger for iOS for stability
                          DEVICE.isMobile ? 1024 : 
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
        
        widgetLog("Audio initialized successfully");
        return true;
      } catch (error) {
        widgetLog(`Audio initialization error: ${error.message}`, "error");
        return false;
      }
    },
    
    /**
     * Start audio capture
     * @param {Function} onAudioProcess - Callback for processing audio data
     * @returns {boolean} Success status
     */
    startCapture: function(onAudioProcess) {
      if (!this.audioContext || !this.mediaStream || !this.audioProcessor) return false;
      
      try {
        // Connect audio nodes
        const streamSource = this.audioContext.createMediaStreamSource(this.mediaStream);
        streamSource.connect(this.audioProcessor);
        
        // For iOS DO NOT connect directly to output to avoid feedback
        if (!DEVICE.isIOS) {
          this.audioProcessor.connect(this.audioContext.destination);
        } else {
          // For iOS create "empty" node to avoid feedback
          const gainNode = this.audioContext.createGain();
          gainNode.gain.value = 0; // Set volume to zero
          this.audioProcessor.connect(gainNode);
          gainNode.connect(this.audioContext.destination);
          widgetLog('Using zero gainNode for iOS to avoid feedback');
        }
        
        // Set audio processing callback
        this.audioProcessor.onaudioprocess = onAudioProcess;
        
        return true;
      } catch (e) {
        widgetLog(`Error starting audio capture: ${e.message}`, 'error');
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
          widgetLog('Audio capture stopped');
        } catch (e) {
          widgetLog(`Error stopping audio capture: ${e.message}`, 'warn');
        }
      }
      
      if (this.mediaStream) {
        try {
          // Stop all tracks
          this.mediaStream.getTracks().forEach(track => track.stop());
          this.mediaStream = null;
          widgetLog('Media stream tracks stopped');
        } catch (e) {
          widgetLog(`Error stopping media stream: ${e.message}`, 'warn');
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
     * Play audio from base64 string
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
        const playAudioFn = () => {
          const audioData = DataUtils.base64ToArrayBuffer(audioBase64);
          if (audioData.byteLength === 0) {
            if (onComplete) onComplete();
            return;
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
                widgetLog(`Playback error: ${error.message}`, "error");
                
                if (error.name === 'NotAllowedError' && DEVICE.isIOS) {
                  if (onError) onError(new Error('iOS playback not allowed'));
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
            widgetLog('Audio playback error', 'error');
            URL.revokeObjectURL(audioUrl);
            if (onError) onError(new Error('Audio playback error'));
          };
        };
        
        if (DEVICE.isIOS) {
          this.unlockAudioOnIOS().then(() => {
            playAudioFn();
          });
        } else {
          playAudioFn();
        }
      } catch (error) {
        widgetLog(`Audio playback error: ${error.message}`, "error");
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
          
          // For mobile devices increase sensitivity
          const multiplier = DEVICE.isMobile ? 150 : 100;
          
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
        
        // On iOS this click will also help initialize audio context
        if (DEVICE.isIOS) {
          AudioManager.unlockAudioOnIOS().then(unlocked => {
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
          AudioManager.unlockAudioOnIOS().then(success => {
            if (success) {
              this.elements.iosAudioButton.classList.remove('visible');
              
              // Try to start listening after a short delay
              setTimeout(() => {
                if (STATE.isConnected && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                  this.startListening();
                }
              }, 500);
            } else {
              // If unlock failed, try more aggressive unlock
              AudioManager.forceIOSAudioUnlock().then(() => {
                this.elements.iosAudioButton.classList.remove('visible');
                
                setTimeout(() => {
                  if (STATE.isConnected && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                    this.startListening();
                  }
                }, 500);
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
            
            // Automatically start listening if widget is open
            if (DEVICE.isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
              // Show activation button for iOS
              if (this.elements.iosAudioButton) {
                this.elements.iosAudioButton.classList.add('visible');
              }
              this.showMessage("Tap the button below to activate microphone", 0);
            } else {
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
              
              // Automatically start listening if widget is open
              if (STATE.isWidgetOpen) {
                this.startListening();
              }
            }
            return;
          }
          
          // Handle errors
          if (data.type === 'error') {
            // Special handling for empty audio buffer error
            if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
              widgetLog("Error: empty audio buffer", "warn");
              // Restart listening without user notification
              if (STATE.isWidgetOpen && !STATE.isPlayingAudio && !STATE.isReconnecting) {
                setTimeout(() => { 
                  this.startListening(); 
                }, 500);
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
            // Automatically start listening again if widget is open
            if (STATE.isWidgetOpen && !STATE.isPlayingAudio && !STATE.isReconnecting) {
              // Check audio state for iOS before starting
              if (DEVICE.isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
                // Show activation button for iOS
                if (this.elements.iosAudioButton) {
                  this.elements.iosAudioButton.classList.add('visible');
                }
                this.showMessage("Tap the button below to activate microphone", 0);
              } else {
                setTimeout(() => {
                  this.startListening();
                }, 800); // Longer delay for stability
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
     * Start listening for audio input
     */
    startListening: async function() {
      if (!STATE.isConnected || STATE.isPlayingAudio || STATE.isReconnecting || STATE.isListening) {
        widgetLog(`Cannot start listening: isConnected=${STATE.isConnected}, isPlayingAudio=${STATE.isPlayingAudio}, isReconnecting=${STATE.isReconnecting}, isListening=${STATE.isListening}`);
        return;
      }
      
      // For iOS apply deep audio unlock before recording start
      if (DEVICE.isIOS) {
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          await AudioManager.forceIOSAudioUnlock();
        }
      }
      
      STATE.isListening = true;
      widgetLog('Starting listening');
      
      // Send command to clear input buffer
      if (ConnectionManager.websocket && ConnectionManager.websocket.readyState === WebSocket.OPEN) {
        ConnectionManager.send({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        });
      }
      
      // Special handling for iOS devices
      if (DEVICE.isIOS) {
        // If audio not initialized, activate it
        if (!window.audioContextInitialized || !window.hasPlayedSilence) {
          // Try to force activation
          await AudioManager.unlockAudioOnIOS();
          
          // If still not activated, show button
          if (!window.audioContextInitialized) {
            if (this.elements.iosAudioButton) {
              this.elements.iosAudioButton.classList.add('visible');
            }
            this.showMessage("Tap the button below to activate microphone", 0);
            STATE.isListening = false;
            return;
          }
        }
      }
      
      // If audio not initialized, do it
      if (!AudioManager.audioContext) {
        const success = await AudioManager.initAudio();
        if (!success) {
          widgetLog('Failed to initialize audio', 'error');
          STATE.isListening = false;
          
          // For iOS show special button
          if (DEVICE.isIOS && this.elements.iosAudioButton) {
            this.elements.iosAudioButton.classList.add('visible');
            this.showMessage("Tap the button below to activate microphone", 0);
          } else {
            this.showMessage("Microphone access error. Check browser settings.");
          }
          
          return;
        }
      } else if (AudioManager.audioContext.state === 'suspended') {
        // Resume AudioContext if suspended
        try {
          await AudioManager.audioContext.resume();
          widgetLog('AudioContext resumed');
        } catch (error) {
          widgetLog(`Failed to resume AudioContext: ${error}`, 'error');
          STATE.isListening = false;
          
          // For iOS show special button
          if (DEVICE.isIOS && this.elements.iosAudioButton) {
            this.elements.iosAudioButton.classList.add('visible');
            this.showMessage("Tap the button below to activate microphone", 0);
          }
          
          return;
        }
      }
      
      // Reset audio data flags
      STATE.hasAudioData = false;
      STATE.audioDataStartTime = 0;
      
      // Active visual listening state if not playing audio
      if (!STATE.isPlayingAudio) {
        this.elements.mainCircle.classList.add('listening');
        this.elements.mainCircle.classList.remove('speaking');
      }
      
      // Variables for tracking sound
      let isSilent = true;
      let silenceStartTime = Date.now();
      let lastCommitTime = 0;
      let hasSentAudioInCurrentSegment = false;
      
      // Start audio capture and processing
      const success = AudioManager.startCapture(function(e) {
        if (STATE.isListening && ConnectionManager.websocket && 
            ConnectionManager.websocket.readyState === WebSocket.OPEN && 
            !STATE.isReconnecting) {
          // Get data from microphone
          const inputBuffer = e.inputBuffer;
          let inputData = inputBuffer.getChannelData(0);
          
          // Check for empty data
          if (inputData.length === 0) {
            return;
          }
          
          // Calculate maximum amplitude
          let maxAmplitude = 0;
          let sumAmplitude = 0;
          
          for (let i = 0; i < inputData.length; i++) {
            const absValue = Math.abs(inputData[i]);
            maxAmplitude = Math.max(maxAmplitude, absValue);
            sumAmplitude += absValue;
          }
          
          // Average amplitude (useful for iOS)
          const avgAmplitude = sumAmplitude / inputData.length;
          
          // Apply normalization for iOS devices to improve quality
          if (DEVICE.isIOS && maxAmplitude > 0) {
            // If signal too quiet, amplify it
            const normalizedData = new Float32Array(inputData.length);
            if (maxAmplitude < 0.1) {
              const gain = Math.min(5, 0.3 / maxAmplitude); // Amplify, but not too much
              for (let i = 0; i < inputData.length; i++) {
                normalizedData[i] = inputData[i] * gain;
              }
              // Update input data with normalized values
              inputData = normalizedData;
            }
          }
          
          // Use settings based on device
          const soundThreshold = DEVICE.isIOS ? 
                              0.005 : // Lower threshold for iOS
                              WidgetController.audioConfig.soundDetectionThreshold;
          
          const hasSound = maxAmplitude > soundThreshold;
          
          // Update visualization
          WidgetController.updateAudioVisualization(inputData);
          
          // Convert float32 to int16 with normalization for iOS
          const pcm16Data = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            // For iOS apply additional gain if needed
            const sample = DEVICE.isIOS && maxAmplitude < 0.1 ? 
                        inputData[i] * 2 : // Amplify weak signal
                        inputData[i];
            pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
          }
          
          // Send data through WebSocket
          try {
            const message = JSON.stringify({
              type: "input_audio_buffer.append",
              event_id: `audio_${Date.now()}`,
              audio: DataUtils.arrayBufferToBase64(pcm16Data.buffer)
            });
            
            ConnectionManager.websocket.send(message);
            hasSentAudioInCurrentSegment = true;
            
            // Mark presence of audio data
            if (!STATE.hasAudioData && hasSound) {
              STATE.hasAudioData = true;
              STATE.audioDataStartTime = Date.now();
              widgetLog("Started recording audio data");
            }
            
          } catch (error) {
            widgetLog(`Error sending audio: ${error.message}`, "error");
          }
          
          // Silence detection and automatic sending logic
          const now = Date.now();
          
          if (hasSound) {
            // Reset silence start time
            isSilent = false;
            silenceStartTime = now;
            
            // Activate visual listening state
            if (!WidgetController.elements.mainCircle.classList.contains('listening') && 
                !WidgetController.elements.mainCircle.classList.contains('speaking')) {
              WidgetController.elements.mainCircle.classList.add('listening');
            }
          } else if (!isSilent) {
            // If silence started
            const silenceDuration = now - silenceStartTime;
            
            // For iOS use increased silence duration
            const effectiveSilenceDuration = DEVICE.isIOS ? 
                                          800 : // More time for processing on iOS
                                          WidgetController.audioConfig.silenceDuration;
            
            if (silenceDuration > effectiveSilenceDuration) {
              isSilent = true;
              
              // If enough time passed since last send and we have data
              if (now - lastCommitTime > 1000 && hasSentAudioInCurrentSegment) {
                // For iOS add delay before sending
                const iosDelay = DEVICE.isIOS ? 300 : 100;
                
                setTimeout(() => {
                  // Check again, no sound appeared
                  if (isSilent && STATE.isListening && !STATE.isReconnecting) {
                    WidgetController.commitAudioBuffer();
                    lastCommitTime = Date.now();
                    hasSentAudioInCurrentSegment = false;
                  }
                }, iosDelay);
              }
            }
          }
        }
      });
      
      if (!success) {
        STATE.isListening = false;
        widgetLog('Failed to start audio capture', 'error');
        this.showMessage("Could not access microphone. Please check browser permissions.");
      }
    },
    
    /**
     * Open widget
     */
    openWidget: function() {
      widgetLog("Opening widget");
      
      // Force set z-index to resolve conflicts
      this.elements.container.style.zIndex = "2147483647";
      this.elements.button.style.zIndex = "2147483647";
      
      this.elements.container.classList.add('active');
      STATE.isWidgetOpen = true;
      
      // Force visibility of expanded widget
      this.elements.expandedWidget.style.opacity = "1";
      this.elements.expandedWidget.style.height = "400px";
      this.elements.expandedWidget.style.pointerEvents = "all";
      this.elements.expandedWidget.style.zIndex = "2147483647";
      
      // Special handling for iOS devices
      if (DEVICE.isIOS) {
        // Show special button for iOS if needed
        if (this.elements.iosAudioButton && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
          this.elements.iosAudioButton.classList.add('visible');
          this.elements.iosAudioButton.addEventListener('click', function() {
            AudioManager.unlockAudioOnIOS().then(success => {
              if (success) {
                WidgetController.elements.iosAudioButton.classList.remove('visible');
                // Try to start listening after audio activation
                setTimeout(() => {
                  if (STATE.isConnected && !STATE.isListening && !STATE.isPlayingAudio) {
                    WidgetController.startListening();
                  }
                }, 500);
              }
            });
          });
        }
        
        // Try to unlock audio immediately
        if (!window.hasPlayedSilence) {
          AudioManager.unlockAudioOnIOS();
        }
      }
      // For other mobile devices (Android)
      else if (DEVICE.isMobile && !window.audioContextInitialized) {
        try {
          // Create temporary audio context for mobile
          if (!window.tempAudioContext) {
            window.tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          // On Android, creating context after user interaction is enough
          window.audioContextInitialized = true;
          widgetLog("Mobile audio context initialized");
        } catch (e) {
          widgetLog(`Failed to initialize audio context: ${e.message}`, "error");
        }
      }
      
      // Show connection problem message if there is one
      if (STATE.connectionFailedPermanently) {
        this.showConnectionError('Failed to connect to server. Click "Retry connection" button.');
        return;
      }
      
      // Start listening when opened if connection is active
      if (STATE.isConnected && !STATE.isListening && !STATE.isPlayingAudio && !STATE.isReconnecting) {
        // On iOS don't start listening automatically
        // until audio permissions are activated
        if (DEVICE.isIOS && (!window.audioContextInitialized || !window.hasPlayedSilence)) {
          this.showMessage("Tap the button below to activate voice assistant", 0);
        } else {
          this.startListening();
        }
        this.updateConnectionStatus('connected', 'Connected');
      } else if (!STATE.isConnected && !STATE.isReconnecting) {
        // If connection not active and not reconnecting,
        // try to connect again
        this.connectToServer();
      } else {
        widgetLog(`Cannot start listening yet: isConnected=${STATE.isConnected}, isListening=${STATE.isListening}, isPlayingAudio=${STATE.isPlayingAudio}, isReconnecting=${STATE.isReconnecting}`);
        
        if (STATE.isReconnecting) {
          this.updateConnectionStatus('connecting', 'Reconnecting...');
        }
      }
      
      // Remove pulse from button
      this.elements.button.classList.remove('wellcomeai-pulse-animation');
    },
    
    /**
     * Close widget
     */
    closeWidget: function() {
      widgetLog("Closing widget");
      
      // Stop all audio processes
      this.stopAllAudioProcessing();
      
      // Hide widget
      this.elements.container.classList.remove('active');
      STATE.isWidgetOpen = false;
      
      // Hide messages and errors
      this.hideMessage();
      this.hideConnectionError();
      
      // Hide status indicator
      if (this.elements.statusIndicator) {
        this.elements.statusIndicator.classList.remove('show');
      }
      
      // Hide iOS activation button
      if (this.elements.iosAudioButton) {
        this.elements.iosAudioButton.classList.remove('visible');
      }
      
      // Force hide expanded widget
      this.elements.expandedWidget.style.opacity = "0";
      this.elements.expandedWidget.style.height = "0";
      this.elements.expandedWidget.style.pointerEvents = "none";
    },
    
    /**
     * Stop all audio processing
     */
    stopAllAudioProcessing: function() {
      // Stop listening
      STATE.isListening = false;
      
      // Stop playback
      STATE.isPlayingAudio = false;
      
      // Clear buffers and queues
      STATE.audioChunksBuffer = [];
      STATE.audioPlaybackQueue = [];
      
      // Reset flags
      STATE.hasAudioData = false;
      STATE.audioDataStartTime = 0;
      
      // Stop audio capture
      AudioManager.stopCapture();
      
      // If active WebSocket connection, send stop command
      if (ConnectionManager.websocket && ConnectionManager.websocket.readyState === WebSocket.OPEN) {
        // Clear input buffer
        ConnectionManager.send({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        });
        
        // Cancel any current response
        ConnectionManager.send({
          type: "response.cancel",
          event_id: `cancel_${Date.now()}`
        });
      }
      
      // Reset UI state
      this.elements.mainCircle.classList.remove('listening');
      this.elements.mainCircle.classList.remove('speaking');
      
      // Reset visualization
      this.resetAudioVisualization();
    },
    
    /**
     * Send audio buffer to server
     */
    commitAudioBuffer: function() {
      if (!STATE.isListening || !ConnectionManager.websocket || 
          ConnectionManager.websocket.readyState !== WebSocket.OPEN || 
          STATE.isReconnecting) return;
      
      // Check if buffer has enough audio data
      if (!STATE.hasAudioData) {
        widgetLog("Not sending empty audio buffer", "warn");
        return;
      }
      
      // Check minimum audio length
      const audioLength = Date.now() - STATE.audioDataStartTime;
      if (audioLength < this.minimumAudioLength) {
        widgetLog(`Audio buffer too short (${audioLength}ms), waiting for more data`, "warn");
        
        // Use longer delay for mobile devices
        const extraDelay = DEVICE.isMobile ? 200 : 50;
        
        // Continue recording a bit longer
        setTimeout(() => {
          // Try to send buffer again
          if (STATE.isListening && STATE.hasAudioData && !STATE.isReconnecting) {
            widgetLog(`Sending audio buffer after additional recording (${Date.now() - STATE.audioDataStartTime}ms)`);
            this.sendCommitBuffer();
          }
        }, this.minimumAudioLength - audioLength + extraDelay);
        
        return;
      }
      
      // If all checks passed, send buffer
      this.sendCommitBuffer();
    },
    
    /**
     * Actually send buffer to server
     */
    sendCommitBuffer: function() {
      widgetLog("Sending audio buffer");
      
      // Additional check for minimum audio length
      const audioLength = Date.now() - STATE.audioDataStartTime;
      if (audioLength < 100) {
        widgetLog(`Audio buffer too short for OpenAI (${audioLength}ms < 100ms), not sending`, "warn");
        
        // Start next listening cycle
        STATE.hasAudioData = false;
        STATE.audioDataStartTime = 0;
        
        return;
      }
      
      // For mobile devices add brief pause before sending
      if (DEVICE.isMobile) {
        // Reset activity effect with small delay
        setTimeout(() => {
          this.elements.mainCircle.classList.remove('listening');
        }, 100);
      } else {
        // Reset activity effect immediately
        this.elements.mainCircle.classList.remove('listening');
      }
      
      // Send command to commit buffer
      ConnectionManager.send({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}`
      });
      
      // Show loading indicator for mobile devices
      if (DEVICE.isMobile && this.elements.loaderModal) {
        // Briefly show loading
        this.elements.loaderModal.classList.add('active');
        setTimeout(() => {
          this.elements.loaderModal.classList.remove('active');
        }, 1000);
      }
      
      // Start processing and reset flags
      STATE.hasAudioData = false;
      STATE.audioDataStartTime = 0;
    },
    
    /**
     * Add audio to playback queue
     * @param {string} audioBase64 - Base64 encoded audio data
     */
    addAudioToPlaybackQueue: function(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') return;
      
      // Add audio to queue
      STATE.audioPlaybackQueue.push(audioBase64);
      
      // If playback not running, start it
      if (!STATE.isPlayingAudio) {
        this.playNextAudio();
      }
    },
    
    /**
     * Play next audio in queue
     */
    playNextAudio: function() {
      if (STATE.audioPlaybackQueue.length === 0) {
        STATE.isPlayingAudio = false;
        this.elements.mainCircle.classList.remove('speaking');
        
        if (!STATE.isWidgetOpen) {
          this.elements.button.classList.add('wellcomeai-pulse-animation');
        }
        
        if (STATE.isWidgetOpen) {
          setTimeout(() => {
            if (DEVICE.isIOS) {
              AudioManager.unlockAudioOnIOS().then(unlocked => {
                if (unlocked) {
                  this.startListening();
                } else if (this.elements.iosAudioButton) {
                  this.elements.iosAudioButton.classList.add('visible');
                  this.showMessage("Tap button to activate microphone", 0);
                }
              });
            } else {
              this.startListening();
            }
          }, 800);
        }
        return;
      }
      
      STATE.isPlayingAudio = true;
      this.elements.mainCircle.classList.add('speaking');
      this.elements.mainCircle.classList.remove('listening');
      
      const audioBase64 = STATE.audioPlaybackQueue.shift();
      
      AudioManager.playAudio(
        audioBase64,
        // onComplete callback
        () => this.playNextAudio(),
        // onError callback
        (error) => {
          widgetLog(`Audio playback error: ${error.message}`, "error");
          
          // For iOS activation error
          if (DEVICE.isIOS && error.message === 'iOS playback not allowed') {
            if (this.elements.iosAudioButton) {
              this.elements.iosAudioButton.classList.add('visible');
              this.showMessage("Tap button to activate audio", 0);
            }
          } else {
            // For other errors just proceed to next audio
            this.playNextAudio();
          }
        }
      );
    },
    
    /**
     * Show message
     * @param {string} message - Message text
     * @param {number} duration - Duration in ms (0 for no auto-hide)
     */
    showMessage: function(message, duration = 5000) {
      this.elements.messageDisplay.textContent = message;
      this.elements.messageDisplay.classList.add('show');
      
      if (duration > 0) {
        setTimeout(() => {
          this.elements.messageDisplay.classList.remove('show');
        }, duration);
      }
    },

    /**
     * Hide message
     */
    hideMessage: function() {
      this.elements.messageDisplay.classList.remove('show');
    },
    
    /**
     * Show connection error
     * @param {string} message - Error message
     */
    showConnectionError: function(message) {
      if (this.elements.connectionError) {
        this.elements.connectionError.innerHTML = `
          ${message || 'Error connecting to server'}
          <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
            Retry connection
          </button>
        `;
        this.elements.connectionError.classList.add('visible');
        
        // Add handler for new button
        const newRetryButton = this.elements.connectionError.querySelector('#wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', () => {
            this.resetConnection();
          });
        }
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
     * @param {string} status - Status type (connected, disconnected, connecting)
     * @param {string} message - Status message
     */
    updateConnectionStatus: function(status, message) {
      if (!this.elements.statusIndicator || !this.elements.statusDot || !this.elements.statusText) return;
      
      this.elements.statusText.textContent = message || status;
      
      // Remove all status classes
      this.elements.statusDot.classList.remove('connected', 'disconnected', 'connecting');
      
      // Add appropriate class
      if (status === 'connected') {
        this.elements.statusDot.classList.add('connected');
      } else if (status === 'disconnected') {
        this.elements.statusDot.classList.add('disconnected');
      } else {
        this.elements.statusDot.classList.add('connecting');
      }
      
      // Show indicator
      this.elements.statusIndicator.classList.add('show');
      
      // Hide after some time
      setTimeout(() => {
        this.elements.statusIndicator.classList.remove('show');
      }, 3000);
    },
    
    /**
     * Reset connection state
     */
    resetConnection: function() {
      // Reset attempts counter and flags
      STATE.reconnectAttempts = 0;
      STATE.connectionFailedPermanently = false;
      
      // Hide error message
      this.hideConnectionError();
      
      // Show reconnection message
      this.showMessage("Attempting to connect...");
      this.updateConnectionStatus('connecting', 'Connecting...');
      
      // Try to connect again
      this.connectToServer();
    },
    
    /**
     * Reconnect with delay
     * @param {number} initialDelay - Initial delay in ms
     */
    reconnectWithDelay: function(initialDelay = 0) {
      // Check if maximum attempts exceeded
      // Use different value for mobile and desktop
      const maxAttempts = DEVICE.isMobile ? 
                        CONFIG.MOBILE_MAX_RECONNECT_ATTEMPTS : 
                        CONFIG.MAX_RECONNECT_ATTEMPTS;
      
      if (STATE.reconnectAttempts >= maxAttempts) {
        widgetLog('Maximum reconnection attempts reached');
        STATE.isReconnecting = false;
        STATE.connectionFailedPermanently = true;
        
        // Show message to user
        if (STATE.isWidgetOpen) {
          this.showConnectionError("Failed to restore connection. Try reloading the page.");
          this.updateConnectionStatus('disconnected', 'Disconnected');
        } else {
          // If widget closed, add pulse to button
          this.elements.button.classList.add('wellcomeai-pulse-animation');
        }
        return;
      }
      
      STATE.isReconnecting = true;
      
      // Show message to user if widget is open
      if (STATE.isWidgetOpen) {
        this.showMessage("Connection interrupted. Reconnecting...", 0);
        this.updateConnectionStatus('connecting', 'Reconnecting...');
      }
      
      // If initial delay specified, use it, otherwise exponential
      // For mobile devices use shorter delay
      const delay = initialDelay > 0 ? 
                initialDelay : 
                DEVICE.isMobile ? 
                    Math.min(15000, Math.pow(1.5, STATE.reconnectAttempts) * 1000) : // shorter exponential delay
                    Math.min(30000, Math.pow(2, STATE.reconnectAttempts) * 1000);
      
      STATE.reconnectAttempts++;
      
      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${STATE.reconnectAttempts}/${maxAttempts}`);
      
      // Try to reconnect with increasing delay
      setTimeout(() => {
        if (STATE.isReconnecting) {
          this.connectToServer();
        }
      }, delay);
    },
    
    /**
     * Check widget initialization state
     */
    checkInitialization: function() {
      setTimeout(() => {
        widgetLog('DOM check after initialization');
        
        // Check visibility and z-index of elements
        if (!this.elements.container) {
          widgetLog('Widget container not found in DOM!', 'error');
        } else {
          widgetLog(`Container z-index = ${getComputedStyle(this.elements.container).zIndex}`);
        }
        
        if (!this.elements.button) {
          widgetLog('Button not found in DOM!', 'error');
        } else {
          widgetLog(`Button is visible = ${getComputedStyle(this.elements.button).display !== 'none'}`);
        }
        
        if (!this.elements.expandedWidget) {
          widgetLog('Expanded widget not found in DOM!', 'error');
        }
        
        // Check connection
        widgetLog(`Connection state = ${ConnectionManager.websocket ? ConnectionManager.websocket.readyState : 'No websocket'}`);
        widgetLog(`Status flags = isConnected: ${STATE.isConnected}, isListening: ${STATE.isListening}, isPlayingAudio: ${STATE.isPlayingAudio}, isReconnecting: ${STATE.isReconnecting}, isWidgetOpen: ${STATE.isWidgetOpen}`);
        
        // For mobile devices add audio state check
        if (DEVICE.isMobile) {
          widgetLog(`Mobile audio state: initialized=${window.audioContextInitialized}, hasPlayedSilence=${window.hasPlayedSilence}`);
          if (AudioManager.audioContext) {
            widgetLog(`AudioContext state=${AudioManager.audioContext.state}, sampleRate=${AudioManager.audioContext.sampleRate}`);
          }
        }
      }, 2000);
    }
  };

  /**
   * Initialize widget
   */
  function initializeWidget() {
    widgetLog('Initializing...');
    
    // Log device type
    widgetLog(`Device type: ${DEVICE.isIOS ? 'iOS' : (DEVICE.isMobile ? 'Android/Mobile' : 'Desktop')}`);
    
    // Get server URL, assistant ID and position
    const SERVER_URL = getServerUrl();
    const ASSISTANT_ID = getAssistantId();
    const WIDGET_POSITION = getWidgetPosition();
    
    // Check for assistant ID
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag.", 'error');
      alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
      return;
    }
    
    // Load required styles and scripts
    loadFontAwesome();
    
    // Initialize and start widget
    WidgetController.init(SERVER_URL, ASSISTANT_ID, WIDGET_POSITION);
    
    widgetLog('Initialization complete');
  }
  
  // Check if widget already exists on page
  if (!document.getElementById('wellcomeai-widget-container')) {
    widgetLog('Starting initialization process');
    // If DOM already loaded, initialize immediately
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeWidget);
      widgetLog('Will initialize on DOMContentLoaded');
    } else {
      widgetLog('DOM already loaded, initializing immediately');
      initializeWidget();
    }
  } else {
    widgetLog('Widget already exists on the page, skipping initialization');
  }
})();
