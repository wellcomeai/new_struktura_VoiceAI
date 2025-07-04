/**
 * WellcomeAI Widget Loader Script
 * Версия: 2.2.1 - Премиальный дизайн с Voicyfy интеграцией
 * 
 * Исправления:
 * - Убрана отправка session.update от клиента (сервер сам управляет сессией)
 * - Улучшено воспроизведение аудио для iOS
 * - Добавлена предварительная инициализация AudioContext для iOS
 * - Обновлен дизайн виджета для премиального вида
 * - Добавлена интеграция с Voicyfy
 */

(function() {
  'use strict';

  // Настройки виджета
  const DEBUG_MODE = true;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const MOBILE_MAX_RECONNECT_ATTEMPTS = 10;
  const PING_INTERVAL = 15000;
  const MOBILE_PING_INTERVAL = 10000;
  const CONNECTION_TIMEOUT = 20000;
  const MAX_DEBUG_ITEMS = 10;

  // Глобальное хранение состояния
  let reconnectAttempts = 0;
  let pingIntervalId = null;
  let lastPongTime = Date.now();
  let isReconnecting = false;
  let debugQueue = [];
  
  // Определяем тип устройства
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  // Упрощенные глобальные флаги - только необходимые
  window.audioInitialized = false;  // Единый флаг инициализации
  window.globalAudioContext = null; // Глобальный AudioContext
  window.globalMicStream = null;    // Глобальный поток микрофона
  window.silentAudioBuffer = null;  // Буфер тишины для iOS

  // Функция для логирования
  const widgetLog = (message, type = 'info') => {
    if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('render.com')) {
      const logPrefix = '[WellcomeAI Widget]';
      const timestamp = new Date().toISOString().slice(11, 23);
      const formattedMessage = `${timestamp} | ${type.toUpperCase()} | ${message}`;
      console.log(`${logPrefix} ${formattedMessage}`);
    } else if (DEBUG_MODE || type === 'error') {
      const prefix = '[WellcomeAI Widget]';
      if (type === 'error') {
        console.error(`${prefix} ERROR:`, message);
      } else if (type === 'warn') {
        console.warn(`${prefix} WARNING:`, message);
      } else if (DEBUG_MODE) {
        console.log(`${prefix}`, message);
      }
    }
  };

  // Функция для определения URL сервера
  const getServerUrl = () => {
    const scriptTags = document.querySelectorAll('script');
    let serverUrl = null;
    
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-server')) {
        serverUrl = scriptTags[i].getAttribute('data-server');
        widgetLog(`Found server URL from data-server attribute: ${serverUrl}`);
        break;
      }
      
      if (scriptTags[i].dataset && scriptTags[i].dataset.server) {
        serverUrl = scriptTags[i].dataset.server;
        widgetLog(`Found server URL from dataset.server: ${serverUrl}`);
        break;
      }
      
      const src = scriptTags[i].getAttribute('src');
      if (src && (src.includes('widget.js') || src.includes('wellcomeai-widget.min.js'))) {
        try {
          const url = new URL(src, window.location.href);
          serverUrl = url.origin;
          widgetLog(`Extracted server URL from script src: ${serverUrl}`);
          break;
        } catch (e) {
          widgetLog(`Error extracting server URL from src: ${e.message}`, 'warn');
          
          if (src.startsWith('/')) {
            serverUrl = window.location.origin;
            widgetLog(`Using current origin for relative path: ${serverUrl}`);
            break;
          }
        }
      }
    }
    
    if (serverUrl && !serverUrl.match(/^https?:\/\//)) {
      serverUrl = window.location.protocol + '//' + serverUrl;
      widgetLog(`Added protocol to server URL: ${serverUrl}`);
    }
    
    if (!serverUrl) {
      serverUrl = 'https://realtime-saas.onrender.com';
      widgetLog(`Using fallback server URL: ${serverUrl}`);
    }
    
    return serverUrl.replace(/\/$/, '');
  };

  // Функция для получения ID ассистента
  const getAssistantId = () => {
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-assistantId') || scriptTags[i].hasAttribute('data-assistantid')) {
        const id = scriptTags[i].getAttribute('data-assistantId') || scriptTags[i].getAttribute('data-assistantid');
        widgetLog(`Found assistant ID from attribute: ${id}`);
        return id;
      }
      
      if (scriptTags[i].dataset && (scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid)) {
        const id = scriptTags[i].dataset.assistantId || scriptTags[i].dataset.assistantid;
        widgetLog(`Found assistant ID from dataset: ${id}`);
        return id;
      }
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('assistantId') || urlParams.get('assistantid');
    if (idFromUrl) {
      widgetLog(`Found assistant ID in URL param: ${idFromUrl}`);
      return idFromUrl;
    }
    
    if (window.wellcomeAIAssistantId) {
      widgetLog(`Found assistant ID in global variable: ${window.wellcomeAIAssistantId}`);
      return window.wellcomeAIAssistantId;
    }
    
    if (window.location.hostname.includes('demo') || window.location.pathname.includes('demo')) {
      widgetLog(`Using demo ID on demo page`);
      return 'demo';
    }
    
    widgetLog('No assistant ID found in script tags, URL params or global variables!', 'error');
    return null;
  };

  // Получение позиции виджета
  const getWidgetPosition = () => {
    const defaultPosition = {
      horizontal: 'right',
      vertical: 'bottom',
      distance: '20px'
    };

    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      if (scriptTags[i].hasAttribute('data-position')) {
        return parsePosition(scriptTags[i].getAttribute('data-position'));
      }
      
      if (scriptTags[i].dataset && scriptTags[i].dataset.position) {
        return parsePosition(scriptTags[i].dataset.position);
      }
    }

    return defaultPosition;

    function parsePosition(positionString) {
      const position = { ...defaultPosition };
      
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
  };

  // Определяем URL сервера и ID ассистента
  const SERVER_URL = getServerUrl();
  const ASSISTANT_ID = getAssistantId();
  const WIDGET_POSITION = getWidgetPosition();
  
  // Формируем WebSocket URL с указанием ID ассистента
  const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/' + ASSISTANT_ID;
  
  widgetLog(`Configuration: Server URL: ${SERVER_URL}, Assistant ID: ${ASSISTANT_ID}, Position: ${WIDGET_POSITION.vertical}-${WIDGET_POSITION.horizontal}`);
  widgetLog(`WebSocket URL: ${WS_URL}`);
  widgetLog(`Device: ${isIOS ? 'iOS' : (isAndroid ? 'Android' : (isMobile ? 'Mobile' : 'Desktop'))}`);

  // Создаем стили для виджета - ОБНОВЛЕННЫЕ СТИЛИ С VOICYFY
  function createStyles() {
    const styleEl = document.createElement('style');
    styleEl.id = 'wellcomeai-widget-styles';
    styleEl.textContent = `
      .wellcomeai-widget-container {
        position: fixed;
        ${WIDGET_POSITION.vertical}: ${WIDGET_POSITION.distance};
        ${WIDGET_POSITION.horizontal}: ${WIDGET_POSITION.distance};
        z-index: 2147483647;
        transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: 'Segoe UI', 'Roboto', sans-serif;
      }
      
      /* НОВЫЙ ПРЕМИАЛЬНЫЙ ДИЗАЙН КНОПКИ */
      .wellcomeai-widget-button {
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
      
      .wellcomeai-widget-button:hover {
        transform: scale(1.05);
        box-shadow: 0 10px 30px rgba(74, 134, 232, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.15);
      }
      
      /* Элементы анимации кнопки */
      .wellcomeai-button-inner {
        position: relative;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .wellcomeai-pulse-ring {
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        animation: wellcomeai-pulse-ring 3s ease-out infinite;
        background: radial-gradient(rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0) 70%);
        opacity: 0;
      }
      
      @keyframes wellcomeai-pulse-ring {
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
      
      .wellcomeai-audio-bars-mini {
        display: flex;
        align-items: center;
        height: 26px;
        gap: 4px;
        justify-content: center;
      }
      
      .wellcomeai-audio-bar-mini {
        width: 3px;
        height: 12px;
        background-color: #ffffff;
        border-radius: 1.5px;
        animation: wellcomeai-eq-animation 1.2s ease-in-out infinite;
        opacity: 0.9;
      }
      
      .wellcomeai-audio-bar-mini:nth-child(1) { animation-delay: 0.0s; height: 7px; }
      .wellcomeai-audio-bar-mini:nth-child(2) { animation-delay: 0.3s; height: 12px; }
      .wellcomeai-audio-bar-mini:nth-child(3) { animation-delay: 0.1s; height: 18px; }
      .wellcomeai-audio-bar-mini:nth-child(4) { animation-delay: 0.5s; height: 9px; }
      
      @keyframes wellcomeai-eq-animation {
        0% { height: 5px; }
        50% { height: 18px; }
        100% { height: 5px; }
      }
      
      .wellcomeai-widget-icon {
        color: #fff;
        font-size: 22px;
        z-index: 2;
        opacity: 0;
        position: absolute;
        transition: opacity 0.3s ease;
        display: none; /* Полностью скрываем иконку */
      }
      
      .wellcomeai-widget-icon.active {
        opacity: 1;
      }
      
      .wellcomeai-widget-expanded {
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
      
      .wellcomeai-widget-container.active .wellcomeai-widget-expanded {
        height: 460px; /* Увеличено для размещения Voicyfy */
        opacity: 1;
        pointer-events: all;
      }
      
      .wellcomeai-widget-container.active .wellcomeai-widget-button {
        transform: scale(0.9);
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
      }
      
      .wellcomeai-widget-header {
        padding: 15px 20px;
        background: linear-gradient(135deg, #1e3a8a, #3b82f6);
        color: white;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-radius: 20px 20px 0 0;
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
        background: #f9fafc;
        position: relative;
        padding: 20px;
        padding-bottom: 10px; /* Уменьшено для размещения Voicyfy */
      }
      
      /* Улучшенный дизайн главного круга */
      .wellcomeai-main-circle {
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
        background: linear-gradient(135deg, #dbeafe, #eff6ff);
        box-shadow: 0 0 30px rgba(37, 99, 235, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
      }
      
      .wellcomeai-main-circle.listening::before {
        animation: wellcomeai-wave 4s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(37, 99, 235, 0.3));
      }
      
      .wellcomeai-main-circle.listening::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        border: 3px solid rgba(37, 99, 235, 0.5);
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
        background: linear-gradient(135deg, #dcfce7, #ecfdf5);
        box-shadow: 0 0 30px rgba(5, 150, 105, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
      }
      
      .wellcomeai-main-circle.speaking::before {
        animation: wellcomeai-wave 3s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(5, 150, 105, 0.3));
      }
      
      .wellcomeai-main-circle.speaking::after {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle, transparent 50%, rgba(5, 150, 105, 0.1) 100%);
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
      
      .wellcomeai-main-circle.interrupted {
        background: linear-gradient(135deg, #fef3c7, #fffbeb);
        box-shadow: 0 0 30px rgba(217, 119, 6, 0.5), inset 0 2px 5px rgba(255, 255, 255, 0.5);
      }
      
      .wellcomeai-main-circle.interrupted::before {
        animation: wellcomeai-wave 2s linear infinite;
        background: linear-gradient(45deg, rgba(255, 255, 255, 0.5), rgba(217, 119, 6, 0.3));
      }
      
      .wellcomeai-mic-icon {
        color: #3b82f6;
        font-size: 32px;
        z-index: 10;
        transition: color 0.3s ease;
      }
      
      .wellcomeai-main-circle.listening .wellcomeai-mic-icon {
        color: #2563eb;
      }
      
      .wellcomeai-main-circle.speaking .wellcomeai-mic-icon {
        color: #059669;
      }
      
      .wellcomeai-main-circle.interrupted .wellcomeai-mic-icon {
        color: #d97706;
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
        background-color: #3b82f6;
        border-radius: 1px;
        transition: height 0.1s ease;
      }
      
      .wellcomeai-loader-modal {
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
      
      .wellcomeai-loader-modal.active {
        opacity: 1;
        visibility: visible;
      }
      
      .wellcomeai-loader {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(59, 130, 246, 0.2);
        border-radius: 50%;
        border-top-color: #3b82f6;
        animation: wellcomeai-spin 1s linear infinite;
      }
      
      @keyframes wellcomeai-spin {
        to { transform: rotate(360deg); }
      }
      
      .wellcomeai-message-display {
        position: absolute;
        width: 90%;
        bottom: 70px; /* Поднято выше для размещения Voicyfy */
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
      
      .wellcomeai-connection-error.visible {
        display: block;
      }

      .wellcomeai-retry-button {
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
      
      .wellcomeai-retry-button:hover {
        background-color: #dc2626;
      }
      
      .wellcomeai-status-indicator {
        position: absolute;
        bottom: 50px; /* Поднято для размещения Voicyfy */
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
      
      .wellcomeai-status-indicator.show {
        opacity: 0.8;
      }
      
      .wellcomeai-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #10b981;
      }
      
      .wellcomeai-status-dot.disconnected {
        background-color: #ef4444;
      }
      
      .wellcomeai-status-dot.connecting {
        background-color: #f59e0b;
      }
      
      .wellcomeai-status-dot.interrupted {
        background-color: #d97706;
      }
      
      /* СТИЛИ ДЛЯ VOICYFY */
      .wellcomeai-voicyfy-container {
        position: absolute;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
        text-align: center;
        padding: 8px;
        opacity: 0.8;
        transition: opacity 0.2s ease;
      }
      
      .wellcomeai-voicyfy-container:hover {
        opacity: 1;
      }
      
      .wellcomeai-voicyfy-link {
        display: inline-block;
        text-decoration: none;
        transition: transform 0.2s ease;
      }
      
      .wellcomeai-voicyfy-link:hover {
        transform: translateY(-2px);
      }
      
      .wellcomeai-voicyfy-link img {
        height: 25px;
        width: auto;
        display: block;
      }
    `;
    document.head.appendChild(styleEl);
    widgetLog("Styles created and added to head");
  }

  // Загрузка Font Awesome для иконок
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

  // Создание HTML структуры виджета - ОБНОВЛЕННАЯ СТРУКТУРА С VOICYFY
  function createWidgetHTML() {
    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'wellcomeai-widget-container';
    widgetContainer.id = 'wellcomeai-widget-container';
    widgetContainer.style.zIndex = "2147483647";

    let widgetHTML = `
      <!-- Премиальная кнопка (минимизированное состояние) -->
      <div class="wellcomeai-widget-button" id="wellcomeai-widget-button">
        <div class="wellcomeai-button-inner">
          <div class="wellcomeai-pulse-ring"></div>
          
          <!-- Только эквалайзер для кнопки -->
          <div class="wellcomeai-audio-bars-mini">
            <div class="wellcomeai-audio-bar-mini"></div>
            <div class="wellcomeai-audio-bar-mini"></div>
            <div class="wellcomeai-audio-bar-mini"></div>
            <div class="wellcomeai-audio-bar-mini"></div>
          </div>
        </div>
      </div>
      
      <!-- Развернутый виджет -->
      <div class="wellcomeai-widget-expanded" id="wellcomeai-widget-expanded">
        <div class="wellcomeai-widget-header">
          <div class="wellcomeai-widget-title">Голосовой Ассистент</div>
          <button class="wellcomeai-widget-close" id="wellcomeai-widget-close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="wellcomeai-widget-content">
          <!-- Основной элемент - круг с иконкой микрофона -->
          <div class="wellcomeai-main-circle" id="wellcomeai-main-circle">
            <i class="fas fa-microphone wellcomeai-mic-icon"></i>
            
            <!-- Аудио визуализация -->
            <div class="wellcomeai-audio-visualization" id="wellcomeai-audio-visualization">
              <div class="wellcomeai-audio-bars" id="wellcomeai-audio-bars"></div>
            </div>
          </div>
          
          <!-- Сообщение -->
          <div class="wellcomeai-message-display" id="wellcomeai-message-display"></div>
          
          <!-- Сообщение об ошибке соединения -->
          <div class="wellcomeai-connection-error" id="wellcomeai-connection-error">
            Ошибка соединения с сервером
            <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
              Повторить подключение
            </button>
          </div>
          
          <!-- Индикатор статуса -->
          <div class="wellcomeai-status-indicator" id="wellcomeai-status-indicator">
            <div class="wellcomeai-status-dot" id="wellcomeai-status-dot"></div>
            <span id="wellcomeai-status-text">Подключено</span>
          </div>
          
          <!-- VOICYFY ИНТЕГРАЦИЯ -->
          <div class="wellcomeai-voicyfy-container">
            <a href="https://voicyfy.ru/" target="_blank" rel="noopener noreferrer" class="wellcomeai-voicyfy-link">
              <img src="https://i.ibb.co/ccw6sjdk/photo-2025-06-03-05-04-02.jpg" alt="Voicyfy - powered by AI">
            </a>
          </div>
        </div>
      </div>
      
      <!-- Модальное окно загрузки -->
      <div id="wellcomeai-loader-modal" class="wellcomeai-loader-modal active">
        <div class="wellcomeai-loader"></div>
      </div>
    `;

    widgetContainer.innerHTML = widgetHTML;
    document.body.appendChild(widgetContainer);
    widgetLog("HTML structure created and appended to body");
    
    // Делаем кнопку виджета видимой
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    if (widgetButton) {
      widgetButton.style.opacity = '1';
      widgetButton.style.visibility = 'visible';
      widgetButton.style.pointerEvents = 'auto';
    }
  }

  // ОБНОВЛЕННАЯ инициализация аудио с специальной поддержкой iOS
  async function initializeAudio() {
    widgetLog(`[AUDIO] Начало инициализации для ${isIOS ? 'iOS' : (isAndroid ? 'Android' : (isMobile ? 'Mobile' : 'Desktop'))}`);
    
    try {
      // 1. Проверяем поддержку getUserMedia
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Браузер не поддерживает доступ к микрофону");
      }

      // 2. Создаем ЕДИНЫЙ AudioContext для всех устройств
      if (!window.globalAudioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        window.globalAudioContext = new AudioContextClass({
          sampleRate: 24000,
          latencyHint: 'interactive'
        });
        widgetLog(`[AUDIO] AudioContext создан с частотой ${window.globalAudioContext.sampleRate} Гц`);
      }

      // 3. Активируем AudioContext если приостановлен
      if (window.globalAudioContext.state === 'suspended') {
        await window.globalAudioContext.resume();
        widgetLog('[AUDIO] AudioContext активирован');
      }

      // 4. Получаем доступ к микрофону с едиными настройками
      if (!window.globalMicStream) {
        const constraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 24000,
            channelCount: 1
          }
        };

        window.globalMicStream = await navigator.mediaDevices.getUserMedia(constraints);
        widgetLog(`[AUDIO] Микрофон активирован`);

        // Обработчик закрытия потока
        window.globalMicStream.getAudioTracks().forEach(track => {
          track.onended = () => {
            widgetLog('[AUDIO] Поток микрофона завершен');
            window.globalMicStream = null;
          };
        });
      }

      // 5. УЛУЧШЕНИЕ ДЛЯ iOS - создаем буфер тишины для разблокировки
      if (isIOS && !window.silentAudioBuffer) {
        try {
          // Создаем очень короткий буфер тишины
          window.silentAudioBuffer = window.globalAudioContext.createBuffer(1, 1, window.globalAudioContext.sampleRate);
          const channelData = window.silentAudioBuffer.getChannelData(0);
          channelData[0] = 0; // Тишина
          
          // Воспроизводим тишину для разблокировки iOS
          const silentSource = window.globalAudioContext.createBufferSource();
          silentSource.buffer = window.silentAudioBuffer;
          silentSource.connect(window.globalAudioContext.destination);
          silentSource.start(0);
          
          widgetLog('[AUDIO iOS] Тишина воспроизведена для разблокировки iOS');
        } catch (iosError) {
          widgetLog(`[AUDIO iOS] Ошибка при создании буфера тишины: ${iosError.message}`, 'warn');
        }
      }

      // 6. Для мобильных устройств - дополнительная проверка
      if (isMobile) {
        // Проверяем что контекст действительно работает
        if (window.globalAudioContext.state !== 'running') {
          widgetLog('[AUDIO Mobile] Пытаемся снова активировать AudioContext');
          await window.globalAudioContext.resume();
        }
      }

      // 7. Устанавливаем флаг успешной инициализации
      window.audioInitialized = true;
      widgetLog('[AUDIO] Инициализация завершена успешно');
      
      return true;

    } catch (error) {
      widgetLog(`[AUDIO] Ошибка инициализации: ${error.message}`, 'error');
      return false;
    }
  }

  // Основная логика виджета
  function initWidget() {
    // Проверяем, что ID ассистента существует
    if (!ASSISTANT_ID) {
      widgetLog("Assistant ID not found. Please add data-assistantId attribute to the script tag.", 'error');
      alert('WellcomeAI Widget Error: Assistant ID not found. Please check console for details.');
      return;
    }

    // Элементы UI
    const widgetContainer = document.getElementById('wellcomeai-widget-container');
    const widgetButton = document.getElementById('wellcomeai-widget-button');
    const widgetClose = document.getElementById('wellcomeai-widget-close');
    const mainCircle = document.getElementById('wellcomeai-main-circle');
    const audioBars = document.getElementById('wellcomeai-audio-bars');
    const loaderModal = document.getElementById('wellcomeai-loader-modal');
    const messageDisplay = document.getElementById('wellcomeai-message-display');
    const connectionError = document.getElementById('wellcomeai-connection-error');
    const retryButton = document.getElementById('wellcomeai-retry-button');
    const statusIndicator = document.getElementById('wellcomeai-status-indicator');
    const statusDot = document.getElementById('wellcomeai-status-dot');
    const statusText = document.getElementById('wellcomeai-status-text');
    
    // Проверка элементов
    if (!widgetButton || !widgetClose || !mainCircle || !audioBars || !loaderModal || !messageDisplay) {
      widgetLog("Some UI elements were not found!", 'error');
      return;
    }
    
    // Делаем виджет видимым
    widgetButton.style.opacity = '1';
    widgetButton.style.visibility = 'visible';
    widgetButton.style.pointerEvents = 'auto';
    
    // Переменные для обработки аудио
    let audioChunksBuffer = [];
    let audioPlaybackQueue = [];
    let isPlayingAudio = false;
    let hasAudioData = false;
    let audioDataStartTime = 0;
    let minimumAudioLength = 300;
    let isListening = false;
    let websocket = null;
    let audioProcessor = null;
    let isConnected = false;
    let isWidgetOpen = false;
    let connectionFailedPermanently = false;
    let pingInterval = null;
    let lastPingTime = Date.now();
    let lastPongTime = Date.now();
    let connectionTimeout = null;
    
    // Состояния для обработки перебивания
    let interruptionState = {
      is_assistant_speaking: false,
      is_user_speaking: false,
      last_interruption: 0,
      interruption_count: 0,
      current_audio_elements: [],
      pending_audio_stop: false
    };
    
    // Единая конфигурация аудио для всех устройств
    const AUDIO_CONFIG = {
      silenceThreshold: 0.01,
      silenceDuration: 300,
      bufferCheckInterval: 50,
      soundDetectionThreshold: 0.02,
      amplificationFactor: isMobile ? 2.0 : 1.0
    };
    
    // Создаем аудио-бары для визуализации
    function createAudioBars(count = 20) {
      audioBars.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const bar = document.createElement('div');
        bar.className = 'wellcomeai-audio-bar';
        audioBars.appendChild(bar);
      }
    }
    createAudioBars();

    // Преобразование ArrayBuffer в Base64
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }
    
    // Преобразование Base64 в ArrayBuffer
    function base64ToArrayBuffer(base64) {
      try {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      } catch (e) {
        widgetLog(`Ошибка при декодировании base64: ${e.message}`, "error");
        return new ArrayBuffer(0);
      }
    }

    // Создаём простой WAV из PCM данных
    function createWavFromPcm(pcmBuffer, sampleRate = 24000) {
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      
      // "RIFF" chunk descriptor
      view.setUint8(0, 'R'.charCodeAt(0));
      view.setUint8(1, 'I'.charCodeAt(0));
      view.setUint8(2, 'F'.charCodeAt(0));
      view.setUint8(3, 'F'.charCodeAt(0));
      
      view.setUint32(4, 36 + pcmBuffer.byteLength, true);
      
      // "WAVE" формат
      view.setUint8(8, 'W'.charCodeAt(0));
      view.setUint8(9, 'A'.charCodeAt(0));
      view.setUint8(10, 'V'.charCodeAt(0));
      view.setUint8(11, 'E'.charCodeAt(0));
      
      // "fmt " субчанк
      view.setUint8(12, 'f'.charCodeAt(0));
      view.setUint8(13, 'm'.charCodeAt(0));
      view.setUint8(14, 't'.charCodeAt(0));
      view.setUint8(15, ' '.charCodeAt(0));
      
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      
      // "data" субчанк
      view.setUint8(36, 'd'.charCodeAt(0));
      view.setUint8(37, 'a'.charCodeAt(0));
      view.setUint8(38, 't'.charCodeAt(0));
      view.setUint8(39, 'a'.charCodeAt(0));
      
      view.setUint32(40, pcmBuffer.byteLength, true);
      
      const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
      const wavBytes = new Uint8Array(wavBuffer);
      
      wavBytes.set(new Uint8Array(wavHeader), 0);
      wavBytes.set(new Uint8Array(pcmBuffer), wavHeader.byteLength);
      
      return wavBuffer;
    }

    // УЛУЧШЕННОЕ воспроизведение аудио для iOS
    function playNextAudio() {
      if (audioPlaybackQueue.length === 0) {
        isPlayingAudio = false;
        interruptionState.is_assistant_speaking = false;
        mainCircle.classList.remove('speaking');
        
        if (!isWidgetOpen) {
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        
        // После воспроизведения автоматически возобновляем прослушивание
        if (isWidgetOpen) {
          setTimeout(() => {
            startListening();
          }, 400);
        }
        return;
      }
      
      isPlayingAudio = true;
      interruptionState.is_assistant_speaking = true;
      mainCircle.classList.add('speaking');
      mainCircle.classList.remove('listening');
      
      const audioBase64 = audioPlaybackQueue.shift();
      
      try {
        const audioData = base64ToArrayBuffer(audioBase64);
        if (audioData.byteLength === 0) {
          playNextAudio();
          return;
        }
        
        const wavBuffer = createWavFromPcm(audioData);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);
        
        const audio = new Audio();
        
        // КРИТИЧЕСКИЕ настройки для iOS
        audio.playsInline = true;  // Обязательно для iOS
        audio.muted = false;       // Убеждаемся что не заглушено
        audio.volume = 1.0;        // Максимальная громкость
        audio.preload = 'auto';    // Предзагружаем
        
        // Устанавливаем источник только после настроек
        audio.src = audioUrl;
        
        // Добавляем к списку активных аудио элементов
        interruptionState.current_audio_elements.push(audio);
        
        // УЛУЧШЕННАЯ обработка событий для iOS
        audio.onloadeddata = function() {
          widgetLog('[AUDIO iOS] Аудио данные загружены');
        };
        
        audio.oncanplay = function() {
          widgetLog('[AUDIO iOS] Аудио готово к воспроизведению');
          
          // Проверяем что не было прервано
          if (!interruptionState.is_assistant_speaking) {
            URL.revokeObjectURL(audioUrl);
            const index = interruptionState.current_audio_elements.indexOf(audio);
            if (index > -1) {
              interruptionState.current_audio_elements.splice(index, 1);
            }
            playNextAudio();
            return;
          }
          
          // СПЕЦИАЛЬНО ДЛЯ iOS - дополнительная разблокировка
          if (isIOS && window.globalAudioContext && window.globalAudioContext.state === 'suspended') {
            window.globalAudioContext.resume().then(() => {
              widgetLog('[AUDIO iOS] AudioContext активирован перед воспроизведением');
              attemptPlayback();
            }).catch(err => {
              widgetLog(`[AUDIO iOS] Ошибка активации AudioContext: ${err.message}`, 'error');
              attemptPlayback();
            });
          } else {
            attemptPlayback();
          }
          
          function attemptPlayback() {
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
              playPromise
                .then(() => {
                  widgetLog('[AUDIO iOS] Воспроизведение началось успешно');
                })
                .catch(error => {
                  widgetLog(`[AUDIO iOS] Ошибка воспроизведения: ${error.message}`, "error");
                  
                  // Для iOS попробуем еще раз после небольшой задержки
                  if (isIOS && error.name === 'NotAllowedError') {
                    widgetLog('[AUDIO iOS] Попытка повторного воспроизведения через 100мс', 'warn');
                    setTimeout(() => {
                      audio.play().catch(retryError => {
                        widgetLog(`[AUDIO iOS] Повторная попытка не удалась: ${retryError.message}`, 'error');
                        cleanupAndNext();
                      });
                    }, 100);
                  } else {
                    cleanupAndNext();
                  }
                });
            } else {
              widgetLog('[AUDIO iOS] play() вернул undefined', 'warn');
              cleanupAndNext();
            }
          }
          
          function cleanupAndNext() {
            URL.revokeObjectURL(audioUrl);
            const index = interruptionState.current_audio_elements.indexOf(audio);
            if (index > -1) {
              interruptionState.current_audio_elements.splice(index, 1);
            }
            playNextAudio();
          }
        };
        
        audio.onended = function() {
          widgetLog('[AUDIO iOS] Воспроизведение завершено');
          URL.revokeObjectURL(audioUrl);
          const index = interruptionState.current_audio_elements.indexOf(audio);
          if (index > -1) {
            interruptionState.current_audio_elements.splice(index, 1);
          }
          playNextAudio();
        };
        
        audio.onerror = function(e) {
          widgetLog(`[AUDIO iOS] Ошибка аудио элемента: ${e.message || 'Неизвестная ошибка'}`, 'error');
          URL.revokeObjectURL(audioUrl);
          const index = interruptionState.current_audio_elements.indexOf(audio);
          if (index > -1) {
            interruptionState.current_audio_elements.splice(index, 1);
          }
          playNextAudio();
        };
        
        // Загружаем аудио
        audio.load();
        
      } catch (error) {
        widgetLog(`[AUDIO iOS] Ошибка создания аудио: ${error.message}`, "error");
        playNextAudio();
      }
    }
    
    // Добавить аудио в очередь воспроизведения
    function addAudioToPlaybackQueue(audioBase64) {
      if (!audioBase64 || typeof audioBase64 !== 'string') return;
      
      audioPlaybackQueue.push(audioBase64);
      
      if (!isPlayingAudio) {
        playNextAudio();
      }
    }

    // Обработка событий перебивания
    function handleInterruptionEvent(eventData) {
      const now = Date.now();
      
      widgetLog(`[INTERRUPTION] Получено событие перебивания: ${JSON.stringify(eventData)}`);
      
      interruptionState.interruption_count = eventData.interruption_count || (interruptionState.interruption_count + 1);
      interruptionState.last_interruption = eventData.timestamp || now;
      
      stopAllAudioPlayback();
      switchToListeningMode();
      
      mainCircle.classList.remove('speaking');
      mainCircle.classList.add('interrupted');
      
      setTimeout(() => {
        mainCircle.classList.remove('interrupted');
        if (!interruptionState.is_assistant_speaking) {
          mainCircle.classList.add('listening');
        }
      }, 1000);
      
      updateConnectionStatus('interrupted', `Перебивание #${interruptionState.interruption_count}`);
      
      widgetLog(`[INTERRUPTION] Обработано перебивание #${interruptionState.interruption_count}`);
    }
    
    // Остановка всех аудио воспроизведений
    function stopAllAudioPlayback() {
      widgetLog('[INTERRUPTION] Остановка всех аудио воспроизведений');
      
      isPlayingAudio = false;
      interruptionState.is_assistant_speaking = false;
      
      interruptionState.current_audio_elements.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          if (audio.src && audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
          }
        } catch (e) {
          widgetLog(`[INTERRUPTION] Ошибка при остановке аудио: ${e.message}`, 'warn');
        }
      });
      
      interruptionState.current_audio_elements = [];
      audioPlaybackQueue = [];
      
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        try {
          websocket.send(JSON.stringify({
            type: "audio_playback.stopped",
            timestamp: Date.now()
          }));
        } catch (e) {
          widgetLog(`[INTERRUPTION] Ошибка отправки события остановки: ${e.message}`, 'warn');
        }
      }
      
      widgetLog('[INTERRUPTION] Все аудио воспроизведения остановлены');
    }
    
    // Переключение в режим прослушивания
    function switchToListeningMode() {
      widgetLog('[INTERRUPTION] Переключение в режим прослушивания');
      
      if (isListening) {
        widgetLog('[INTERRUPTION] Уже в режиме прослушивания');
        return;
      }
      
      interruptionState.is_user_speaking = true;
      
      mainCircle.classList.remove('speaking', 'interrupted');
      mainCircle.classList.add('listening');
      
      if (isConnected && !isReconnecting) {
        setTimeout(() => {
          if (!isListening && !isPlayingAudio) {
            startListening();
          }
        }, 100);
      }
      
      widgetLog('[INTERRUPTION] Переключение в режим прослушивания завершено');
    }
    
    // Обработка начала речи пользователя
    function handleSpeechStarted(eventData) {
      widgetLog(`[INTERRUPTION] Пользователь начал говорить: ${JSON.stringify(eventData)}`);
      
      interruptionState.is_user_speaking = true;
      
      if (interruptionState.is_assistant_speaking) {
        stopAllAudioPlayback();
        mainCircle.classList.add('interrupted');
        updateConnectionStatus('interrupted', 'Перебивание');
      }
      
      mainCircle.classList.remove('speaking');
      mainCircle.classList.add('listening');
    }
    
    // Обработка окончания речи пользователя
    function handleSpeechStopped(eventData) {
      widgetLog(`[INTERRUPTION] Пользователь закончил говорить: ${JSON.stringify(eventData)}`);
      
      interruptionState.is_user_speaking = false;
      
      setTimeout(() => {
        mainCircle.classList.remove('interrupted');
        if (!interruptionState.is_assistant_speaking) {
          mainCircle.classList.remove('listening');
        }
      }, 500);
    }
    
    // Обработка начала речи ассистента
    function handleAssistantSpeechStarted(eventData) {
      widgetLog(`[INTERRUPTION] Ассистент начал говорить: ${JSON.stringify(eventData)}`);
      
      interruptionState.is_assistant_speaking = true;
      
      mainCircle.classList.remove('listening', 'interrupted');
      mainCircle.classList.add('speaking');
      
      updateConnectionStatus('connected', 'Ассистент говорит');
    }
    
    // Обработка окончания речи ассистента
    function handleAssistantSpeechEnded(eventData) {
      widgetLog(`[INTERRUPTION] Ассистент закончил говорить: ${JSON.stringify(eventData)}`);
      
      interruptionState.is_assistant_speaking = false;
      
      mainCircle.classList.remove('speaking');
      
      // Автоматически начинаем слушать
      if (isWidgetOpen && isConnected && !isReconnecting) {
        setTimeout(() => {
          if (!isListening && !isPlayingAudio) {
            startListening();
          }
        }, 500);
      }
      
      updateConnectionStatus('connected', 'Готов к разговору');
    }
    
    // Обновление индикатора статуса соединения
    function updateConnectionStatus(status, message) {
      if (!statusIndicator || !statusDot || !statusText) return;
      
      statusText.textContent = message || status;
      
      statusDot.classList.remove('connected', 'disconnected', 'connecting', 'interrupted');
      
      if (status === 'connected') {
        statusDot.classList.add('connected');
      } else if (status === 'disconnected') {
        statusDot.classList.add('disconnected');
      } else if (status === 'interrupted') {
        statusDot.classList.add('interrupted');
      } else {
        statusDot.classList.add('connecting');
      }
      
      statusIndicator.classList.add('show');
      
      setTimeout(() => {
        statusIndicator.classList.remove('show');
      }, 3000);
    }

    // Функция для полной остановки всех аудио процессов
    function stopAllAudioProcessing() {
      isListening = false;
      
      stopAllAudioPlayback();
      
      audioChunksBuffer = [];
      audioPlaybackQueue = [];
      
      hasAudioData = false;
      audioDataStartTime = 0;
      
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
        
        websocket.send(JSON.stringify({
          type: "response.cancel",
          event_id: `cancel_${Date.now()}`
        }));
      }
      
      mainCircle.classList.remove('listening', 'speaking', 'interrupted');
      
      resetAudioVisualization();
      
      interruptionState.is_assistant_speaking = false;
      interruptionState.is_user_speaking = false;
    }
    
    // Показать сообщение
    function showMessage(message, duration = 5000) {
      messageDisplay.textContent = message;
      messageDisplay.classList.add('show');
      
      if (duration > 0) {
        setTimeout(() => {
          messageDisplay.classList.remove('show');
        }, duration);
      }
    }

    // Скрыть сообщение
    function hideMessage() {
      messageDisplay.classList.remove('show');
    }
    
    // Показать ошибку соединения
    function showConnectionError(message) {
      if (connectionError) {
        connectionError.innerHTML = `
          ${message || 'Ошибка соединения с сервером'}
          <button class="wellcomeai-retry-button" id="wellcomeai-retry-button">
            Повторить подключение
          </button>
        `;
        connectionError.classList.add('visible');
        
        const newRetryButton = connectionError.querySelector('#wellcomeai-retry-button');
        if (newRetryButton) {
          newRetryButton.addEventListener('click', function() {
            resetConnection();
          });
        }
      }
    }
    
    // Скрыть ошибку соединения
    function hideConnectionError() {
      if (connectionError) {
        connectionError.classList.remove('visible');
      }
    }
    
    // Сброс состояния соединения
    function resetConnection() {
      reconnectAttempts = 0;
      connectionFailedPermanently = false;
      
      hideConnectionError();
      
      showMessage("Попытка подключения...");
      updateConnectionStatus('connecting', 'Подключение...');
      
      connectWebSocket();
    }
    
    // Открыть виджет
    async function openWidget() {
      widgetLog("Opening widget");
      
      widgetContainer.style.zIndex = "2147483647";
      widgetButton.style.zIndex = "2147483647";
      
      widgetContainer.classList.add('active');
      isWidgetOpen = true;
      
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "1";
        expandedWidget.style.height = "460px"; // Обновлено для размещения Voicyfy
        expandedWidget.style.pointerEvents = "all";
        expandedWidget.style.zIndex = "2147483647";
      }
      
      // ЕДИНАЯ ИНИЦИАЛИЗАЦИЯ для всех устройств при открытии виджета
      if (!window.audioInitialized) {
        widgetLog('[AUDIO] Начинаем инициализацию аудио при открытии виджета');
        
        const success = await initializeAudio();
        
        if (!success) {
          showMessage("Ошибка доступа к микрофону. Проверьте настройки браузера.", 5000);
          return;
        }
      }
      
      if (connectionFailedPermanently) {
        showConnectionError('Не удалось подключиться к серверу. Нажмите кнопку "Повторить подключение".');
        return;
      }
      
      // Запускаем прослушивание при открытии, если соединение активно
      if (isConnected && !isListening && !isPlayingAudio && !isReconnecting) {
        startListening();
        updateConnectionStatus('connected', 'Подключено');
      } else if (!isConnected && !isReconnecting) {
        connectWebSocket();
      } else {
        widgetLog(`Cannot start listening yet: isConnected=${isConnected}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
        
        if (isReconnecting) {
          updateConnectionStatus('connecting', 'Переподключение...');
        }
      }
      
      widgetButton.classList.remove('wellcomeai-pulse-animation');
    }
    
    // Закрыть виджет
    function closeWidget() {
      widgetLog("Closing widget");
      
      stopAllAudioProcessing();
      
      widgetContainer.classList.remove('active');
      isWidgetOpen = false;
      
      hideMessage();
      hideConnectionError();
      
      if (statusIndicator) {
        statusIndicator.classList.remove('show');
      }
      
      const expandedWidget = document.getElementById('wellcomeai-widget-expanded');
      if (expandedWidget) {
        expandedWidget.style.opacity = "0";
        expandedWidget.style.height = "0";
        expandedWidget.style.pointerEvents = "none";
      }
    }
    
    // Начало записи голоса - БЕЗ ИЗМЕНЕНИЙ
    async function startListening() {
      if (!isConnected || isPlayingAudio || isReconnecting || isListening) {
        widgetLog(`Не удается начать прослушивание: isConnected=${isConnected}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}, isListening=${isListening}`);
        return;
      }
      
      // Проверяем инициализацию аудио
      if (!window.audioInitialized || !window.globalAudioContext || !window.globalMicStream) {
        widgetLog('Аудио не инициализировано, пытаемся инициализировать', 'warn');
        const success = await initializeAudio();
        if (!success) {
          widgetLog('Не удалось инициализировать аудио', 'error');
          showMessage("Ошибка доступа к микрофону");
          return;
        }
      }
      
      isListening = true;
      widgetLog('Начинаем прослушивание');
      
      // Отправляем команду для очистки буфера ввода
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: "input_audio_buffer.clear",
          event_id: `clear_${Date.now()}`
        }));
      }
      
      // Проверяем и возобновляем AudioContext если нужно
      if (window.globalAudioContext.state === 'suspended') {
        try {
          await window.globalAudioContext.resume();
          widgetLog('AudioContext возобновлен');
        } catch (error) {
          widgetLog(`Не удалось возобновить AudioContext: ${error}`, 'error');
          isListening = false;
          return;
        }
      }
      
      // Создаем аудио процессор если его нет
      if (!audioProcessor) {
        const bufferSize = 2048;
        
        audioProcessor = window.globalAudioContext.createScriptProcessor(bufferSize, 1, 1);
        widgetLog(`Создан ScriptProcessorNode с размером буфера ${bufferSize}`);
        
        // Переменные для отслеживания звука
        let isSilent = true;
        let silenceStartTime = Date.now();
        let lastCommitTime = 0;
        let hasSentAudioInCurrentSegment = false;
        
        // Обработчик аудио - ЕДИНЫЙ для всех устройств
        audioProcessor.onaudioprocess = function(e) {
          if (isListening && websocket && websocket.readyState === WebSocket.OPEN && !isReconnecting) {
            const inputBuffer = e.inputBuffer;
            let inputData = inputBuffer.getChannelData(0);
            
            if (inputData.length === 0) {
              return;
            }
            
            // Вычисляем максимальную амплитуду
            let maxAmplitude = 0;
            for (let i = 0; i < inputData.length; i++) {
              maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
            }
            
            // Применяем усиление только для мобильных устройств если нужно
            if (isMobile && AUDIO_CONFIG.amplificationFactor > 1.0) {
              const amplifiedData = new Float32Array(inputData.length);
              const gainFactor = AUDIO_CONFIG.amplificationFactor;
              
              for (let i = 0; i < inputData.length; i++) {
                amplifiedData[i] = Math.max(-1.0, Math.min(1.0, inputData[i] * gainFactor));
              }
              
              inputData = amplifiedData;
              
              // Пересчитываем максимальную амплитуду после усиления
              maxAmplitude = 0;
              for (let i = 0; i < inputData.length; i++) {
                maxAmplitude = Math.max(maxAmplitude, Math.abs(inputData[i]));
              }
            }
            
            // Определяем наличие звука
            const hasSound = maxAmplitude > AUDIO_CONFIG.soundDetectionThreshold;
            
            // Обновляем визуализацию
            updateAudioVisualization(inputData);
            
            // Преобразуем float32 в int16
            const pcm16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              pcm16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(inputData[i] * 32767)));
            }
            
            // Отправляем данные через WebSocket
            try {
              const message = JSON.stringify({
                type: "input_audio_buffer.append",
                event_id: `audio_${Date.now()}`,
                audio: arrayBufferToBase64(pcm16Data.buffer)
              });
              
              websocket.send(message);
              hasSentAudioInCurrentSegment = true;
              
              if (!hasAudioData && hasSound) {
                hasAudioData = true;
                audioDataStartTime = Date.now();
                widgetLog("Начало записи аудиоданных");
              }
              
            } catch (error) {
              widgetLog(`Ошибка отправки аудио: ${error.message}`, "error");
            }
            
            // Логика определения тишины и автоматической отправки
            const now = Date.now();
            
            if (hasSound) {
              isSilent = false;
              silenceStartTime = now;
              
              if (!mainCircle.classList.contains('listening') && 
                  !mainCircle.classList.contains('speaking')) {
                mainCircle.classList.add('listening');
              }
            } else if (!isSilent) {
              const silenceDuration = now - silenceStartTime;
              
              if (silenceDuration > AUDIO_CONFIG.silenceDuration) {
                isSilent = true;
                
                if (now - lastCommitTime > 1000 && hasSentAudioInCurrentSegment) {
                  setTimeout(() => {
                    if (isSilent && isListening && !isReconnecting) {
                      commitAudioBuffer();
                      lastCommitTime = Date.now();
                      hasSentAudioInCurrentSegment = false;
                    }
                  }, 100);
                }
              }
            }
          }
        };
        
        // Подключаем обработчик
        const streamSource = window.globalAudioContext.createMediaStreamSource(window.globalMicStream);
        streamSource.connect(audioProcessor);
        
        // Создаем пустой gain node для избежания обратной связи
        const gainNode = window.globalAudioContext.createGain();
        gainNode.gain.value = 0;
        audioProcessor.connect(gainNode);
        gainNode.connect(window.globalAudioContext.destination);
      }
      
      // Сбрасываем флаги аудио данных
      hasAudioData = false;
      audioDataStartTime = 0;
      
      // Активируем визуальное состояние прослушивания если не воспроизводится аудио
      if (!isPlayingAudio) {
        mainCircle.classList.add('listening');
        mainCircle.classList.remove('speaking');
      }
      
      widgetLog("Прослушивание начато успешно");
    }
    
    // Функция для отправки аудиобуфера
    function commitAudioBuffer() {
      if (!isListening || !websocket || websocket.readyState !== WebSocket.OPEN || isReconnecting) return;
      
      if (!hasAudioData) {
        widgetLog("Не отправляем пустой аудиобуфер", "warn");
        return;
      }
      
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < minimumAudioLength) {
        widgetLog(`Аудиобуфер слишком короткий (${audioLength}мс), ожидаем больше данных`, "warn");
        
        setTimeout(() => {
          if (isListening && hasAudioData && !isReconnecting) {
            widgetLog(`Отправка аудиобуфера после дополнительной записи (${Date.now() - audioDataStartTime}мс)`);
            sendCommitBuffer();
          }
        }, minimumAudioLength - audioLength + 50);
        
        return;
      }
      
      sendCommitBuffer();
    }
    
    // Функция для фактической отправки буфера
    function sendCommitBuffer() {
      widgetLog("Отправка аудиобуфера");
      
      const audioLength = Date.now() - audioDataStartTime;
      if (audioLength < 100) {
        widgetLog(`Аудиобуфер слишком короткий для OpenAI (${audioLength}мс < 100мс), не отправляем`, "warn");
        
        hasAudioData = false;
        audioDataStartTime = 0;
        
        return;
      }
      
      mainCircle.classList.remove('listening');
      
      websocket.send(JSON.stringify({
        type: "input_audio_buffer.commit",
        event_id: `commit_${Date.now()}`
      }));
      
      hasAudioData = false;
      audioDataStartTime = 0;
    }
    
    // Обновление визуализации аудио
    function updateAudioVisualization(audioData) {
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
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
        
        const multiplier = isMobile ? 200 : 100;
        
        const height = 2 + Math.min(28, Math.floor(average * multiplier));
        bars[i].style.height = `${height}px`;
      }
    }
    
    // Сброс визуализации аудио
    function resetAudioVisualization() {
      const bars = audioBars.querySelectorAll('.wellcomeai-audio-bar');
      bars.forEach(bar => {
        bar.style.height = '2px';
      });
    }
    
    // Функция для переподключения с задержкой
    function reconnectWithDelay(initialDelay = 0) {
      const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
      
      if (reconnectAttempts >= maxAttempts) {
        widgetLog('Maximum reconnection attempts reached');
        isReconnecting = false;
        connectionFailedPermanently = true;
        
        if (isWidgetOpen) {
          showConnectionError("Не удалось восстановить соединение. Попробуйте перезагрузить страницу.");
          updateConnectionStatus('disconnected', 'Отключено');
        } else {
          widgetButton.classList.add('wellcomeai-pulse-animation');
        }
        return;
      }
      
      isReconnecting = true;
      
      if (isWidgetOpen) {
        showMessage("Соединение прервано. Переподключение...", 0);
        updateConnectionStatus('connecting', 'Переподключение...');
      }
      
      const delay = initialDelay > 0 ? 
                initialDelay : 
                isMobile ? 
                    Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) :
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
      
      reconnectAttempts++;
      
      widgetLog(`Reconnecting in ${delay/1000} seconds, attempt ${reconnectAttempts}/${maxAttempts}`);
      
      setTimeout(() => {
        if (isReconnecting) {
          connectWebSocket().then(success => {
            if (success) {
              reconnectAttempts = 0;
              isReconnecting = false;
              
              if (isWidgetOpen) {
                showMessage("Соединение восстановлено", 3000);
                updateConnectionStatus('connected', 'Подключено');
                
                setTimeout(() => {
                  if (isWidgetOpen && !isListening && !isPlayingAudio) {
                    startListening();
                  }
                }, 1000);
              }
            } else {
              isReconnecting = false;
            }
          }).catch(() => {
            isReconnecting = false;
          });
        }
      }, delay);
    }
    
    // Подключение к WebSocket серверу
    async function connectWebSocket() {
      try {
        loaderModal.classList.add('active');
        widgetLog("Подключение...");
        
        isReconnecting = true;
        
        hideConnectionError();
        
        if (!ASSISTANT_ID) {
          widgetLog('Assistant ID not found!', 'error');
          showMessage("Ошибка: ID ассистента не указан. Проверьте код встраивания.");
          loaderModal.classList.remove('active');
          return false;
        }
        
        widgetLog(`Connecting to WebSocket at: ${WS_URL}`);
        
        if (websocket) {
          try {
            websocket.close();
          } catch (e) {
            // Игнорируем ошибки при закрытии
          }
        }
        
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }
        
        websocket = new WebSocket(WS_URL);
        
        websocket.binaryType = 'arraybuffer';
        
        connectionTimeout = setTimeout(() => {
          widgetLog("Превышено время ожидания соединения", "error");
          
          if (websocket) {
            websocket.close();
          }
          
          isReconnecting = false;
          loaderModal.classList.remove('active');
          
          reconnectAttempts++;
          
          const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
          
          if (reconnectAttempts >= maxAttempts) {
            connectionFailedPermanently = true;
            
            if (isWidgetOpen) {
              showConnectionError("Не удалось подключиться к серверу. Пожалуйста, попробуйте позже.");
              updateConnectionStatus('disconnected', 'Отключено');
            } else {
              widgetButton.classList.add('wellcomeai-pulse-animation');
            }
          } else {
            const delay = isMobile ?
                    Math.min(15000, Math.pow(1.5, reconnectAttempts) * 1000) :
                    Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
                    
            widgetLog(`Попытка переподключения через ${delay/1000} секунд (${reconnectAttempts}/${maxAttempts})`);
            
            if (isWidgetOpen) {
              showMessage(`Превышено время ожидания. Повторная попытка через ${Math.round(delay/1000)} сек...`);
              updateConnectionStatus('connecting', 'Переподключение...');
            }
            
            setTimeout(() => {
              connectWebSocket();
            }, delay);
          }
        }, CONNECTION_TIMEOUT);
        
        websocket.onopen = function() {
          clearTimeout(connectionTimeout);
          widgetLog('WebSocket connection established');
          isConnected = true;
          isReconnecting = false;
          reconnectAttempts = 0;
          connectionFailedPermanently = false;
          loaderModal.classList.remove('active');
          
          lastPingTime = Date.now();
          lastPongTime = Date.now();
          
          const pingIntervalTime = isMobile ? MOBILE_PING_INTERVAL : PING_INTERVAL;
          
          pingInterval = setInterval(() => {
            if (websocket && websocket.readyState === WebSocket.OPEN) {
              try {
                websocket.send(JSON.stringify({ type: "ping" }));
                lastPingTime = Date.now();
                
                if (Date.now() - lastPongTime > pingIntervalTime * 3) {
                  widgetLog("Ping timeout, no pong received", "warn");
                  
                  clearInterval(pingInterval);
                  websocket.close();
                  reconnectWithDelay(1000);
                }
              } catch (e) {
                widgetLog(`Error sending ping: ${e.message}`, "error");
              }
            }
          }, pingIntervalTime);
          
          hideConnectionError();
          
          // ИСПРАВЛЕНИЕ: НЕ отправляем session.update от клиента!
          // Сервер сам управляет сессией через openai_client.update_session()
          widgetLog("[CONNECTION] Соединение установлено, сервер сам настроит сессию");
          
          if (isWidgetOpen) {
            updateConnectionStatus('connected', 'Подключено');
            startListening();
          }
        };
        
        websocket.onmessage = function(event) {
          try {
            if (event.data instanceof Blob) {
              widgetLog("Получены бинарные данные от сервера");
              return;
            }
            
            if (!event.data) {
              widgetLog("Получено пустое сообщение от сервера", "warn");
              return;
            }

            try {
              const data = JSON.parse(event.data);
              
              lastPongTime = Date.now();
              
              if (data.type !== 'input_audio_buffer.append') {
                widgetLog(`Получено сообщение типа: ${data.type || 'unknown'}`);
              }
              
              // Обработка событий перебивания
              if (data.type === 'conversation.interrupted') {
                handleInterruptionEvent(data);
                return;
              }
              
              if (data.type === 'speech.started') {
                handleSpeechStarted(data);
                return;
              }
              
              if (data.type === 'speech.stopped') {
                handleSpeechStopped(data);
                return;
              }
              
              if (data.type === 'assistant.speech.started') {
                handleAssistantSpeechStarted(data);
                return;
              }
              
              if (data.type === 'assistant.speech.ended') {
                handleAssistantSpeechEnded(data);
                return;
              }
              
              if (data.type === 'response.cancelled') {
                widgetLog(`[INTERRUPTION] Ответ отменен: ${JSON.stringify(data)}`);
                
                stopAllAudioPlayback();
                
                mainCircle.classList.remove('speaking');
                mainCircle.classList.add('interrupted');
                
                setTimeout(() => {
                  mainCircle.classList.remove('interrupted');
                  if (isWidgetOpen && !interruptionState.is_assistant_speaking) {
                    switchToListeningMode();
                  }
                }, 500);
                
                return;
              }
              
              if (data.type === 'session.created' || data.type === 'session.updated') {
                widgetLog(`Получена информация о сессии: ${data.type}`);
                return;
              }
              
              if (data.type === 'connection_status') {
                widgetLog(`Статус соединения: ${data.status} - ${data.message}`);
                if (data.status === 'connected') {
                  isConnected = true;
                  reconnectAttempts = 0;
                  connectionFailedPermanently = false;
                  
                  hideConnectionError();
                  
                  if (isWidgetOpen) {
                    startListening();
                  }
                }
                return;
              }
              
              if (data.type === 'error') {
                if (data.error && data.error.code === 'input_audio_buffer_commit_empty') {
                  widgetLog("Ошибка: пустой аудиобуфер", "warn");
                  if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                    setTimeout(() => { 
                      startListening(); 
                    }, 500);
                  }
                  return;
                }
                
                widgetLog(`Ошибка от сервера: ${data.error ? data.error.message : 'Неизвестная ошибка'}`, "error");
                showMessage(data.error ? data.error.message : 'Произошла ошибка на сервере', 5000);
                return;
              } 
              
              if (data.type === 'response.text.delta') {
                if (data.delta) {
                  showMessage(data.delta, 0);
                  
                  if (!isWidgetOpen) {
                    widgetButton.classList.add('wellcomeai-pulse-animation');
                  }
                }
                return;
              }
              
              if (data.type === 'response.text.done') {
                setTimeout(() => {
                  hideMessage();
                }, 5000);
                return;
              }
              
              if (data.type === 'response.audio.delta') {
                if (data.delta) {
                  audioChunksBuffer.push(data.delta);
                }
                return;
              }
              
              if (data.type === 'response.audio_transcript.delta' || data.type === 'response.audio_transcript.done') {
                return;
              }
              
              if (data.type === 'response.audio.done') {
                if (audioChunksBuffer.length > 0) {
                  const fullAudio = audioChunksBuffer.join('');
                  addAudioToPlaybackQueue(fullAudio);
                  audioChunksBuffer = [];
                }
                return;
              }
              
              if (data.type === 'response.done') {
                widgetLog('Response done received');
                if (isWidgetOpen && !isPlayingAudio && !isReconnecting) {
                  setTimeout(() => {
                    startListening();
                  }, 400);
                }
                return;
              }
              
              // Игнорируем неизвестные типы сообщений с .ack
              if (data.type && data.type.includes('.ack')) {
                return;
              }
              
              widgetLog(`Неизвестный тип сообщения: ${data.type}`, "warn");
              
            } catch (parseError) {
              widgetLog(`Ошибка парсинга JSON: ${parseError.message}`, "warn");
              
              if (event.data === 'pong') {
                lastPongTime = Date.now();
                widgetLog("Получен pong-ответ");
                return;
              }
              
              widgetLog(`Содержимое сообщения: ${typeof event.data === 'string' ? event.data.substring(0, 100) : 'не строка'}...`, "debug");
            }
          } catch (generalError) {
            widgetLog(`Общая ошибка обработки сообщения: ${generalError.message}`, "error");
          }
        };
        
        websocket.onclose = function(event) {
          widgetLog(`WebSocket connection closed: ${event.code}, ${event.reason}`);
          isConnected = false;
          isListening = false;
          
          interruptionState.is_assistant_speaking = false;
          interruptionState.is_user_speaking = false;
          
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          
          if (event.code === 1000 || event.code === 1001) {
            isReconnecting = false;
            widgetLog('Clean WebSocket close, not reconnecting');
            return;
          }
          
          reconnectWithDelay();
        };
        
        websocket.onerror = function(error) {
          widgetLog(`WebSocket error: ${error}`, 'error');
          
          if (isWidgetOpen) {
            showMessage("Ошибка соединения с сервером");
            updateConnectionStatus('disconnected', 'Ошибка соединения');
          }
        };
        
        return true;
      } catch (error) {
        widgetLog(`Error connecting to WebSocket: ${error}`, 'error');
        isReconnecting = false;
        loaderModal.classList.remove('active');
        
        reconnectAttempts++;
        
        const maxAttempts = isMobile ? MOBILE_MAX_RECONNECT_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;
        
        if (reconnectAttempts >= maxAttempts) {
          connectionFailedPermanently = true;
          if (isWidgetOpen) {
            showConnectionError("Не удалось подключиться к серверу. Пожалуйста, попробуйте позже.");
            updateConnectionStatus('disconnected', 'Отключено');
          }
        } else {
          reconnectWithDelay();
        }
        
        return false;
      }
    }

    // Добавляем обработчики событий для интерфейса
    widgetButton.addEventListener('click', function(e) {
      widgetLog('Button clicked');
      e.preventDefault();
      e.stopPropagation();
      openWidget(); // ЕДИНАЯ точка входа для всех устройств
    });

    widgetClose.addEventListener('click', function(e) {
      widgetLog('Close button clicked');
      e.preventDefault();
      e.stopPropagation();
      closeWidget();
    });
    
    // Обработчик для основного круга - для дополнительного запуска распознавания
    mainCircle.addEventListener('click', function() {
      widgetLog(`Circle clicked: isWidgetOpen=${isWidgetOpen}, isListening=${isListening}, isPlayingAudio=${isPlayingAudio}, isReconnecting=${isReconnecting}`);
      
      if (isWidgetOpen && !isListening && !isPlayingAudio && !isReconnecting) {
        if (isConnected) {
          startListening();
        } else if (connectionFailedPermanently) {
          showConnectionError("Соединение с сервером отсутствует. Нажмите кнопку 'Повторить подключение'.");
        } else {
          connectWebSocket();
        }
      }
    });
    
    // Обработчик для кнопки повторного подключения
    if (retryButton) {
      retryButton.addEventListener('click', function() {
        widgetLog('Retry button clicked');
        resetConnection();
      });
    }
    
    // Создаем WebSocket соединение
    connectWebSocket();
    
    // Проверка DOM и состояния после инициализации
    setTimeout(function() {
      widgetLog('DOM check after initialization');
      
      const widgetContainer = document.getElementById('wellcomeai-widget-container');
      const widgetButton = document.getElementById('wellcomeai-widget-button');
      const widgetExpanded = document.getElementById('wellcomeai-widget-expanded');
      
      if (!widgetContainer) {
        widgetLog('Widget container not found in DOM!', 'error');
      } else {
        widgetLog(`Container z-index = ${getComputedStyle(widgetContainer).zIndex}`);
      }
      
      if (!widgetButton) {
        widgetLog('Button not found in DOM!', 'error');
      } else {
        widgetLog(`Button is visible = ${getComputedStyle(widgetButton).display !== 'none'}`);
      }
      
      if (!widgetExpanded) {
        widgetLog('Expanded widget not found in DOM!', 'error');
      }
      
      widgetLog(`Connection state = ${websocket ? websocket.readyState : 'No websocket'}`);
      widgetLog(`Status flags = isConnected: ${isConnected}, isListening: ${isListening}, isPlayingAudio: ${isPlayingAudio}, isReconnecting: ${isReconnecting}, isWidgetOpen: ${isWidgetOpen}`);
      
      if (window.audioInitialized) {
        widgetLog(`[AUDIO] Audio state: initialized=${window.audioInitialized}`);
        if (window.globalAudioContext) {
          widgetLog(`[AUDIO] AudioContext state=${window.globalAudioContext.state}, sampleRate=${window.globalAudioContext.sampleRate}`);
        }
        if (window.globalMicStream) {
          widgetLog(`[AUDIO] MediaStream active=${window.globalMicStream.active}, tracks=${window.globalMicStream.getAudioTracks().length}`);
        }
      }
      
      widgetLog(`Interruption state: assistant_speaking=${interruptionState.is_assistant_speaking}, user_speaking=${interruptionState.is_user_speaking}, count=${interruptionState.interruption_count}`);
    }, 2000);
  }

  // Инициализируем виджет
  function initializeWidget() {
    widgetLog('Starting unified initialization process');
    
    widgetLog(`Device type: ${isIOS ? 'iOS' : (isAndroid ? 'Android' : (isMobile ? 'Mobile' : 'Desktop'))}`);
    
    loadFontAwesome();
    createStyles();
    
    createWidgetHTML();
    
    initWidget();
    
    widgetLog('Unified widget initialization complete - same behavior for all devices');
  }
  
  // Проверяем, есть ли уже виджет на странице
  if (!document.getElementById('wellcomeai-widget-container')) {
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
