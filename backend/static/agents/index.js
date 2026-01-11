// /static/agents/index.js
import { api } from './api.js';
import { ui } from './ui.js';

// ============================================================================
// ПЕРЕМЕННЫЕ СОСТОЯНИЯ
// ============================================================================

let currentAgentId = null;
let isLoading = false;
let testWidgetScript = null;
let isTestWidgetInitialized = false;
let isMicPermissionGranted = false;
let isTestActive = false;
let currentUserEmail = null;
let availableFunctions = [];

// ✅ НОВОЕ: Информация о лимитах ассистентов
let assistantsLimitInfo = {
  openaiCount: 0,
  geminiCount: 0,
  totalCount: 0,
  maxAllowed: 3,
  canCreate: true
};

// ============================================================================
// ЭЛЕМЕНТЫ DOM
// ============================================================================

let tabs, tabContents, voiceOptions, agentForm;
let viewEmbedCodeBtn, deleteAgentBtn, saveAgentBtn, createNewAgentBtn, cancelButton;
let copyEmbedCodeBtn, notification, notificationMessage, notificationClose;
let loadingOverlay, debugPanel, agentsListContainer, editAgentContainer;
let mobileMenuToggle, sidebar, sidebarOverlay;
let userMenuButton, userDropdown, userEmailDisplay, userAvatar, dropdownLogout;
let googleSheetIdInput, testSheetBtn, sheetConnectionStatus;
let agentIdDisplay, copyAgentIdBtn;

// ============================================================================
// РЕЖИМ ОТЛАДКИ
// ============================================================================

const DEBUG_MODE = false;

function debugLog(message) {
  if (DEBUG_MODE) {
    console.log('[DEBUG]', message);
    const now = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.textContent = `[${now}] ${message}`;
    debugPanel.appendChild(logEntry);
    debugPanel.scrollTop = debugPanel.scrollHeight;
    
    if (debugPanel.style.display !== 'block') {
      debugPanel.style.display = 'block';
    }
  }
}

// ============================================================================
// ✅ НОВОЕ: ПРОВЕРКА ЛИМИТА АССИСТЕНТОВ
// ============================================================================

/**
 * Загрузить информацию о количестве ассистентов и лимитах
 * @returns {Promise<object>} Объект с информацией о лимитах
 */
async function loadAssistantsLimitInfo() {
  try {
    console.log('[LIMITS] Загрузка информации о лимитах ассистентов...');
    
    // Параллельно запрашиваем все данные
    const [openaiAssistants, geminiAssistants, subscription] = await Promise.all([
      api.getAssistants().catch(err => {
        console.warn('[LIMITS] Ошибка загрузки OpenAI ассистентов:', err);
        return [];
      }),
      api.getGeminiAssistants().catch(err => {
        console.warn('[LIMITS] Ошибка загрузки Gemini ассистентов:', err);
        return [];
      }),
      api.getSubscription().catch(err => {
        console.warn('[LIMITS] Ошибка загрузки подписки:', err);
        return null;
      })
    ]);
    
    const openaiCount = Array.isArray(openaiAssistants) ? openaiAssistants.length : 0;
    const geminiCount = Array.isArray(geminiAssistants) ? geminiAssistants.length : 0;
    const totalCount = openaiCount + geminiCount;
    
    // Получаем лимит из подписки или используем дефолтный
    let maxAllowed = 3; // Дефолтный лимит
    if (subscription && subscription.subscription_plan && subscription.subscription_plan.max_assistants) {
      maxAllowed = subscription.subscription_plan.max_assistants;
    }
    
    assistantsLimitInfo = {
      openaiCount,
      geminiCount,
      totalCount,
      maxAllowed,
      canCreate: totalCount < maxAllowed
    };
    
    console.log('[LIMITS] Информация о лимитах:', assistantsLimitInfo);
    
    return assistantsLimitInfo;
    
  } catch (error) {
    console.error('[LIMITS] Ошибка загрузки информации о лимитах:', error);
    // В случае ошибки разрешаем создание (проверка будет на бэкенде)
    assistantsLimitInfo = {
      openaiCount: 0,
      geminiCount: 0,
      totalCount: 0,
      maxAllowed: 3,
      canCreate: true
    };
    return assistantsLimitInfo;
  }
}

/**
 * Проверить, можно ли создать нового ассистента
 * @returns {boolean} true если можно создать
 */
function canCreateAssistant() {
  return assistantsLimitInfo.canCreate;
}

/**
 * Показать уведомление о достижении лимита
 */
function showLimitReachedNotification() {
  const { totalCount, maxAllowed } = assistantsLimitInfo;
  ui.showNotification(
    `Достигнут лимит ассистентов (${totalCount}/${maxAllowed}). Улучшите тариф для создания новых.`,
    'error',
    7000
  );
}

/**
 * Обновить состояние кнопки создания агента
 */
function updateCreateButtonState() {
  if (!createNewAgentBtn) return;
  
  if (!canCreateAssistant()) {
    createNewAgentBtn.disabled = true;
    createNewAgentBtn.title = `Достигнут лимит ассистентов (${assistantsLimitInfo.totalCount}/${assistantsLimitInfo.maxAllowed})`;
    createNewAgentBtn.style.opacity = '0.6';
    createNewAgentBtn.style.cursor = 'not-allowed';
  } else {
    createNewAgentBtn.disabled = false;
    createNewAgentBtn.title = 'Создать нового агента';
    createNewAgentBtn.style.opacity = '1';
    createNewAgentBtn.style.cursor = 'pointer';
  }
}

// ============================================================================
// ДИНАМИЧЕСКАЯ ЗАГРУЗКА ФУНКЦИЙ
// ============================================================================

/**
 * Загрузить список доступных функций из API
 */
async function loadAvailableFunctions() {
  try {
    console.log('[FUNCTIONS] Загружаем список доступных функций...');
    const functions = await api.getFunctions();
    availableFunctions = functions;
    window.availableFunctions = availableFunctions;
    console.log('[FUNCTIONS] Загружено функций:', availableFunctions.length);
    renderFunctions(functions);
  } catch (error) {
    console.error('[FUNCTIONS] Ошибка загрузки функций:', error);
    const container = document.getElementById('functions-container');
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #ef4444;">
        <i class="fas fa-exclamation-triangle" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <p>Ошибка загрузки функций: ${error.message}</p>
        <button class="btn btn-outline" onclick="window.loadAvailableFunctions()" style="margin-top: 1rem;">
          <i class="fas fa-sync-alt"></i> Попробовать снова
        </button>
      </div>
    `;
  }
}

/**
 * Отрендерить список функций в UI
 */
function renderFunctions(functions) {
  const container = document.getElementById('functions-container');
  
  if (!functions || functions.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: var(--text-gray);">
        <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <p>Нет доступных функций</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  
  functions.forEach(func => {
    const functionId = `function-${func.name}`;
    const infoId = `${func.name}-info`;
    
    const funcGroup = document.createElement('div');
    funcGroup.className = 'form-group';
    
    const label = document.createElement('label');
    label.className = 'function-option';
    label.innerHTML = `
      <input type="checkbox" id="${functionId}" name="${functionId}" data-function-name="${func.name}">
      <span>${func.display_name || func.name}</span>
    `;
    
    funcGroup.appendChild(label);
    
    const infoDiv = document.createElement('div');
    infoDiv.id = infoId;
    infoDiv.className = 'function-info';
    infoDiv.style.display = 'none';
    
    const schemaHtml = `
      <h4>Информация о функции:</h4>
      <pre class="function-schema">${JSON.stringify({
        name: func.name,
        description: func.description,
        parameters: func.parameters
      }, null, 2)}</pre>
    `;
    
    const exampleHtml = func.example_prompt ? `
      <h4>Пример использования в промпте:</h4>
      <div class="prompt-example">
        ${func.example_prompt}
      </div>
    ` : '';
    
    infoDiv.innerHTML = schemaHtml + exampleHtml;
    funcGroup.appendChild(infoDiv);
    
    container.appendChild(funcGroup);
    
    const checkbox = document.getElementById(functionId);
    checkbox.addEventListener('change', function() {
      infoDiv.style.display = this.checked ? 'block' : 'none';
    });
  });
  
  console.log('[FUNCTIONS] Отрендерено функций:', functions.length);
}

window.loadAvailableFunctions = loadAvailableFunctions;

// ============================================================================
// СОСТОЯНИЕ ЗАГРУЗКИ
// ============================================================================

function setLoading(loading) {
  isLoading = loading;
  loadingOverlay.style.display = loading ? 'flex' : 'none';
  
  const buttons = document.querySelectorAll('.btn');
  buttons.forEach(button => {
    button.disabled = loading;
  });
}

// ============================================================================
// ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ
// ============================================================================

async function loadUserInfo() {
  try {
    const userInfo = await api.get('/users/me');
    currentUserEmail = userInfo.email;
    
    const firstName = userInfo.first_name || '';
    const lastName = userInfo.last_name || '';
    
    if (firstName || lastName) {
      userEmailDisplay.textContent = firstName + (lastName ? ` ${lastName}` : '');
      
      let initials = '';
      if (firstName) initials += firstName[0];
      if (lastName) initials += lastName[0];
      userAvatar.textContent = initials.toUpperCase();
    } else if (userInfo.company_name) {
      userEmailDisplay.textContent = userInfo.company_name;
      userAvatar.textContent = userInfo.company_name.substring(0, 2).toUpperCase();
    } else {
      userEmailDisplay.textContent = userInfo.email;
      userAvatar.textContent = userInfo.email.substring(0, 2).toUpperCase();
    }
    
    // Показываем админ панель для well96well@gmail.com
    if (userInfo.email === 'well96well@gmail.com') {
      console.log('Проверка email для админ панели:', userInfo.email);
      
      const adminSections = Array.from(document.querySelectorAll('.sidebar-section')).filter(
        section => section.textContent.trim() === 'Администрирование'
      );
      
      if (adminSections.length === 0) {
        const adminSection = document.createElement('div');
        adminSection.className = 'sidebar-section';
        adminSection.textContent = 'Администрирование';
        
        const adminNavItem = document.createElement('a');
        adminNavItem.href = '/static/admin.html';
        adminNavItem.className = 'sidebar-nav-item';
        adminNavItem.innerHTML = '<i class="fas fa-user-shield"></i> Управление';
        
        const sidebarNav = document.querySelector('.sidebar-nav');
        const accountSection = Array.from(document.querySelectorAll('.sidebar-section')).find(
          section => section.textContent.trim() === 'Аккаунт'
        );
        
        if (accountSection && sidebarNav) {
          sidebarNav.insertBefore(adminSection, accountSection);
          sidebarNav.insertBefore(adminNavItem, accountSection);
        } else {
          sidebarNav.appendChild(adminSection);
          sidebarNav.appendChild(adminNavItem);
        }
      }
    }
  } catch (error) {
    debugLog(`Ошибка загрузки информации о пользователе: ${error.message}`);
    userEmailDisplay.textContent = 'Неизвестный пользователь';
  }
}

// ============================================================================
// URL ПАРАМЕТРЫ
// ============================================================================

function getAgentIdFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const id = urlParams.get('id');
  debugLog(`ID агента из URL: ${id}`);
  return id;
}

function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const id = urlParams.get('id');
  const mode = urlParams.get('mode');
  
  if (id) {
    return { mode: 'edit', id };
  } else if (mode === 'create') {
    return { mode: 'create' };
  } else {
    return { mode: 'list' };
  }
}

// ============================================================================
// ЗАГРУЗКА ДАННЫХ АГЕНТА
// ============================================================================

async function loadAgentData() {
  if (!currentAgentId) {
    debugLog('Попытка загрузить данные без ID агента');
    return;
  }
  
  try {
    setLoading(true);
    debugLog(`Загрузка данных агента: ${currentAgentId}`);
    
    const agent = await api.getAgent(currentAgentId);
    debugLog(`Получены данные агента: ${JSON.stringify(agent).substring(0, 100)}...`);
    
    ui.fillAgentForm(agent);
    
    if (agentIdDisplay) {
      agentIdDisplay.textContent = currentAgentId;
    }
    
    const embedData = await api.getEmbedCode(currentAgentId);
    document.getElementById('embed-code').textContent = embedData.embed_code;
    debugLog('Код встраивания загружен');
    
    viewEmbedCodeBtn.style.display = 'inline-flex';
    deleteAgentBtn.style.display = 'inline-flex';
    saveAgentBtn.style.display = 'inline-flex';
    createNewAgentBtn.style.display = 'none';
  } catch (error) {
    debugLog(`Ошибка загрузки данных агента: ${error.message}`);
    ui.showNotification(error.message || 'Ошибка при загрузке данных агента', 'error');
  } finally {
    setLoading(false);
  }
}

// ============================================================================
// СПИСОК АГЕНТОВ
// ============================================================================

async function loadAgentsList() {
  try {
    setLoading(true);
    const agents = await api.getAssistants();
    renderAgentsList(agents);
  } catch (error) {
    debugLog(`Ошибка при загрузке списка агентов: ${error.message}`);
    ui.showNotification(error.message || 'Ошибка при загрузке списка агентов', 'error');
  } finally {
    setLoading(false);
  }
}

function renderAgentsList(agents) {
  const container = document.getElementById('agents-list');
  container.innerHTML = '';
  
  if (agents.length === 0) {
    // ✅ ОБНОВЛЕНО: Показываем информацию о лимитах в пустом состоянии
    const limitText = `(${assistantsLimitInfo.totalCount}/${assistantsLimitInfo.maxAllowed} использовано)`;
    
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <i class="fas fa-robot"></i>
        </div>
        <h3 class="empty-title">У вас еще нет OpenAI агентов</h3>
        <p class="empty-description">
          Создайте вашего первого голосового ассистента, чтобы встроить его на сайт или приложение.
          <br><small style="color: var(--text-light);">${limitText}</small>
        </p>
        <button class="btn btn-primary" id="empty-create-agent-btn" ${!canCreateAssistant() ? 'disabled style="opacity: 0.6; cursor: not-allowed;"' : ''}>
          <i class="fas fa-plus"></i> Создать нового агента
        </button>
      </div>
    `;
    
    const emptyBtn = document.getElementById('empty-create-agent-btn');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => {
        if (canCreateAssistant()) {
          navigateToCreateAgent();
        } else {
          showLimitReachedNotification();
        }
      });
    }
    return;
  }
  
  // ✅ ОБНОВЛЕНО: Показываем информацию о лимитах в заголовке
  const headerEl = document.createElement('div');
  headerEl.className = 'agent-list-header';
  headerEl.innerHTML = `
    <h4 class="agents-count">
      OpenAI агентов: ${agents.length} 
      <small style="color: var(--text-light); font-weight: normal;">
        (всего ${assistantsLimitInfo.totalCount}/${assistantsLimitInfo.maxAllowed})
      </small>
    </h4>
  `;
  container.appendChild(headerEl);
  
  const listEl = document.createElement('div');
  listEl.className = 'agent-items';
  
  agents.forEach(agent => {
    const agentEl = document.createElement('div');
    agentEl.className = 'agent-item';
    agentEl.innerHTML = `
      <div class="agent-icon">
        <i class="fas fa-robot"></i>
      </div>
      <div class="agent-info">
        <h3 class="agent-name">${agent.name}</h3>
        <p class="agent-description">${agent.description || 'Нет описания'}</p>
        <div class="agent-meta">
          <span class="agent-voice"><i class="fas fa-volume-up"></i> ${agent.voice}</span>
          <span class="agent-date"><i class="fas fa-calendar"></i> Создан: ${new Date(agent.created_at).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="agent-actions">
        <button class="btn btn-outline get-embed-code" data-id="${agent.id}" title="Получить код для встраивания">
          <i class="fas fa-code"></i>
        </button>
        <button class="btn btn-primary edit-agent" data-id="${agent.id}">
          <i class="fas fa-edit"></i> Редактировать
        </button>
      </div>
    `;
    listEl.appendChild(agentEl);
  });
  
  container.appendChild(listEl);
  
  document.querySelectorAll('.edit-agent').forEach(button => {
    button.addEventListener('click', function() {
      const agentId = this.getAttribute('data-id');
      window.location.href = `/static/agents.html?id=${agentId}`;
    });
  });
  
  document.querySelectorAll('.get-embed-code').forEach(button => {
    button.addEventListener('click', async function() {
      const agentId = this.getAttribute('data-id');
      try {
        setLoading(true);
        const embedData = await api.getEmbedCode(agentId);
        
        currentAgentId = agentId;
        switchToEditMode();
        
        await loadAvailableFunctions();
        await loadAgentData();
        
        document.getElementById('embed-code').textContent = embedData.embed_code;
        ui.switchTab('embed');
      } catch (error) {
        ui.showNotification(error.message || 'Ошибка при получении кода встраивания', 'error');
      } finally {
        setLoading(false);
      }
    });
  });
}

// ============================================================================
// НАВИГАЦИЯ
// ============================================================================

function navigateToCreateAgent() {
  // ✅ НОВОЕ: Проверяем лимит перед переходом на страницу создания
  if (!canCreateAssistant()) {
    showLimitReachedNotification();
    return;
  }
  window.location.href = '/static/agents.html?mode=create';
}

function initCreateMode() {
  document.getElementById('agent-name').value = '';
  document.getElementById('agent-description').value = '';
  document.getElementById('system-prompt').value = 'Ты умный голосовой помощник. Отвечай на вопросы пользователя коротко, информативно и с небольшой ноткой юмора, когда это уместно. Стремись быть полезным и предоставлять точную информацию.';
  document.getElementById('google-sheet-id').value = '';
  document.getElementById('greeting-message').value = 'Здравствуйте! Чем я могу вам помочь?';
    
  const voiceInput = document.querySelector('input[name="voice"][value="alloy"]');
  if (voiceInput) {
    voiceOptions.forEach(option => {
      option.classList.remove('selected');
    });
    voiceInput.closest('.voice-option').classList.add('selected');
    voiceInput.checked = true;
  }
  
  document.querySelectorAll('input[type="checkbox"][data-function-name]').forEach(checkbox => {
    checkbox.checked = false;
    const infoDiv = document.getElementById(`${checkbox.dataset.functionName}-info`);
    if (infoDiv) infoDiv.style.display = 'none';
  });
    
  document.querySelector('.page-title').textContent = 'Создание нового агента';
  saveAgentBtn.innerHTML = '<i class="fas fa-plus"></i> Создать';
  deleteAgentBtn.style.display = 'none';
  viewEmbedCodeBtn.style.display = 'none';
  saveAgentBtn.style.display = 'inline-flex';
  createNewAgentBtn.style.display = 'none';
  
  if (agentIdDisplay) {
    agentIdDisplay.textContent = '-';
  }
}

function switchToEditMode() {
  agentsListContainer.style.display = 'none';
  editAgentContainer.style.display = 'block';
  
  document.querySelector('.page-title').textContent = 'Управление агентом';
  
  viewEmbedCodeBtn.style.display = 'inline-flex';
  deleteAgentBtn.style.display = 'inline-flex';
  saveAgentBtn.style.display = 'inline-flex';
  saveAgentBtn.innerHTML = '<i class="fas fa-save"></i> Сохранить';
  createNewAgentBtn.style.display = 'none';
  
  setupTestingTab();
}

function switchToListMode() {
  agentsListContainer.style.display = 'block';
  editAgentContainer.style.display = 'none';
  
  document.querySelector('.page-title').textContent = 'Мои агенты';
  
  viewEmbedCodeBtn.style.display = 'none';
  deleteAgentBtn.style.display = 'none';
  saveAgentBtn.style.display = 'none';
  createNewAgentBtn.style.display = 'inline-flex';
  
  // ✅ НОВОЕ: Обновляем состояние кнопки создания
  updateCreateButtonState();
  
  currentAgentId = null;
  
  if (agentIdDisplay) {
    agentIdDisplay.textContent = '-';
  }
}

// ============================================================================
// ТЕСТИРОВАНИЕ
// ============================================================================

function initTestingTab() {
  const connectionStatus = document.getElementById('testing-connection-status');
  const voiceNameElement = document.getElementById('voice-name');
  const widgetIndicator = document.getElementById('widget-indicator');
  
  if (voiceNameElement) {
    const selectedVoice = document.querySelector('input[name="voice"]:checked');
    if (selectedVoice) {
      voiceNameElement.textContent = selectedVoice.value;
    }
  }
  
  if (!isTestWidgetInitialized && currentAgentId) {
    initTestWidget();
    
    if (widgetIndicator) {
      widgetIndicator.style.display = 'block';
      setTimeout(() => {
        widgetIndicator.style.display = 'none';
      }, 5000);
    }
  }
}

function initTestWidget() {
  if (isTestWidgetInitialized || !currentAgentId) return;
  
  updateTestConnectionStatus('connecting', 'Подключение...');
  
  if (testWidgetScript) {
    testWidgetScript.remove();
  }
  
  testWidgetScript = document.createElement('script');
  testWidgetScript.src = '/static/widget.js';
  testWidgetScript.dataset.assistantId = currentAgentId;
  testWidgetScript.dataset.position = 'bottom-right';
  
  testWidgetScript.onload = function() {
    isTestWidgetInitialized = true;
    
    setTimeout(() => {
      const widgetButton = document.querySelector('.wellcomeai-widget-button');
      if (widgetButton) {
        updateTestConnectionStatus('connected', 'Подключено');
        widgetButton.classList.add('pulse-animation');
        requestMicrophonePermission();
      } else {
        updateTestConnectionStatus('disconnected', 'Не удалось загрузить виджет');
      }
    }, 2000);
  };
  
  testWidgetScript.onerror = function() {
    updateTestConnectionStatus('disconnected', 'Ошибка загрузки виджета');
    isTestWidgetInitialized = false;
  };
  
  document.head.appendChild(testWidgetScript);
}

function requestMicrophonePermission() {
  if (isMicPermissionGranted) return;
  
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        isMicPermissionGranted = true;
        stream.getTracks().forEach(track => track.stop());
      })
      .catch(function(err) {
        console.error('Ошибка доступа к микрофону:', err);
        ui.showNotification('Для тестирования голосового ассистента необходим доступ к микрофону', 'error');
      });
  } else {
    ui.showNotification('Ваш браузер не поддерживает доступ к микрофону', 'error');
  }
}

function updateTestConnectionStatus(status, message) {
  const connectionStatus = document.getElementById('testing-connection-status');
  if (!connectionStatus) return;
  
  const statusIndicator = connectionStatus.querySelector('.status-indicator');
  const statusText = connectionStatus.querySelector('span');
  
  if (statusIndicator) {
    statusIndicator.className = 'status-indicator ' + status;
  }
  
  if (statusText) {
    statusText.textContent = message;
  }
}

function setupTestingTab() {
  const tabs = document.querySelectorAll('.tab');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', function() {
      const tabId = this.getAttribute('data-tab');
      
      if (tabId === 'testing' && currentAgentId) {
        setTimeout(initTestingTab, 100);
        
        if (!isTestWidgetInitialized) {
          setTimeout(initTestWidget, 200);
          
          setTimeout(() => {
            const widgetIndicator = document.getElementById('widget-indicator');
            if (widgetIndicator) {
              widgetIndicator.style.display = 'block';
              setTimeout(() => {
                widgetIndicator.style.display = 'none';
              }, 5000);
            }
          }, 1000);
        }
      }
      
      if (tabId === 'functions' && availableFunctions.length === 0) {
        loadAvailableFunctions();
      }
    });
  });
}

// ============================================================================
// ОБРАБОТЧИКИ СОБЫТИЙ
// ============================================================================

function setupEventHandlers() {
  // Мобильное меню
  mobileMenuToggle.addEventListener('click', function() {
    sidebar.classList.toggle('mobile-open');
    sidebarOverlay.classList.toggle('show');
  });
  
  sidebarOverlay.addEventListener('click', function() {
    sidebar.classList.remove('mobile-open');
    sidebarOverlay.classList.remove('show');
  });
  
  // Выпадающее меню пользователя
  userMenuButton.addEventListener('click', function(e) {
    e.stopPropagation();
    userDropdown.classList.toggle('show');
  });
  
  document.addEventListener('click', function(e) {
    if (userDropdown.classList.contains('show') && !userDropdown.contains(e.target) && !userMenuButton.contains(e.target)) {
      userDropdown.classList.remove('show');
    }
  });
  
  // Переключение вкладок
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');
      debugLog(`Переключение на вкладку: ${tabId}`);
      ui.switchTab(tabId);
    });
  });
  
  // Выбор голоса
  voiceOptions.forEach(option => {
    option.addEventListener('click', function() {
      voiceOptions.forEach(opt => {
        opt.classList.remove('selected');
      });
      this.classList.add('selected');
      this.querySelector('input').checked = true;
      debugLog(`Выбран голос: ${this.querySelector('input').value}`);
    });
  });
  
  // Кнопка "Код для встраивания"
  viewEmbedCodeBtn.addEventListener('click', () => {
    debugLog('Нажата кнопка "Код для встраивания"');
    ui.switchTab('embed');
  });
  
  // Копирование кода встраивания
  copyEmbedCodeBtn.addEventListener('click', () => {
    debugLog('Копирование кода встраивания');
    const embedCode = document.getElementById('embed-code');
    const tempTextarea = document.createElement('textarea');
    tempTextarea.value = embedCode.textContent;
    document.body.appendChild(tempTextarea);
    tempTextarea.select();
    document.execCommand('copy');
    document.body.removeChild(tempTextarea);
    
    ui.showNotification('Код для встраивания скопирован!', 'success');
  });
  
  // ✅ ОБНОВЛЕНО: Создание нового агента с проверкой лимита
  createNewAgentBtn.addEventListener('click', () => {
    if (canCreateAssistant()) {
      navigateToCreateAgent();
    } else {
      showLimitReachedNotification();
    }
  });
  
  // Сохранение изменений (кнопка в верхней панели)
  saveAgentBtn.addEventListener('click', async () => {
    debugLog('Нажата кнопка "Сохранить" в верхней панели');
    agentForm.dispatchEvent(new Event('submit'));
  });
  
  // ✅ ОБНОВЛЕНО: Отправка формы с проверкой лимита для создания
  agentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = ui.getFormData();
    const params = checkUrlParams();
    
    try {
      setLoading(true);
      
      if (params.mode === 'create') {
        // ✅ НОВОЕ: Проверяем лимит перед созданием
        if (!canCreateAssistant()) {
          showLimitReachedNotification();
          setLoading(false);
          return;
        }
        
        const newAgent = await api.createAssistant(formData);
        ui.showNotification('Агент успешно создан!', 'success');
        
        // ✅ НОВОЕ: Обновляем информацию о лимитах после создания
        await loadAssistantsLimitInfo();
        
        setTimeout(() => {
          window.location.href = `/static/agents.html?id=${newAgent.id}`;
        }, 1000);
      } else if (currentAgentId) {
        await api.updateAgent(currentAgentId, formData);
        ui.showNotification('Изменения успешно сохранены!', 'success');
        
        await loadAgentData();
        
        if (isTestWidgetInitialized) {
          isTestWidgetInitialized = false;
          
          const existingWidget = document.querySelector('.wellcomeai-widget-container');
          if (existingWidget) {
            existingWidget.remove();
          }
          
          setTimeout(() => {
            initTestWidget();
          }, 1000);
          
          const activeTab = document.querySelector('.tab.active');
          if (activeTab && activeTab.getAttribute('data-tab') === 'testing') {
            const widgetIndicator = document.getElementById('widget-indicator');
            if (widgetIndicator) {
              widgetIndicator.style.display = 'block';
              setTimeout(() => {
                widgetIndicator.style.display = 'none';
              }, 5000);
            }
          }
        }
      } else {
        ui.showNotification('ID агента не определен', 'error');
      }
    } catch (error) {
      debugLog(`Ошибка при сохранении: ${error.message}`);
      ui.showNotification(error.message || 'Ошибка при сохранении изменений', 'error');
    } finally {
      setLoading(false);
    }
  });
  
  // Отмена изменений
  cancelButton.addEventListener('click', () => {
    debugLog('Отмена изменений');
    
    const params = checkUrlParams();
    
    if (params.mode === 'create') {
      window.location.href = '/static/agents.html';
    } else if (params.mode === 'edit') {
      loadAgentData();
    } else {
      window.location.href = '/static/agents.html';
    }
  });
  
  // ✅ ОБНОВЛЕНО: Удаление агента с обновлением лимитов
  deleteAgentBtn.addEventListener('click', async () => {
    debugLog('Нажата кнопка "Удалить"');
    
    if (!currentAgentId) {
      ui.showNotification('ID агента не определен', 'error');
      return;
    }
    
    const confirmed = confirm('Вы уверены, что хотите удалить этого агента? Это действие нельзя отменить.');
    
    if (confirmed) {
      try {
        setLoading(true);
        await api.deleteAgent(currentAgentId);
        ui.showNotification('Агент успешно удален!', 'success');
        
        // ✅ НОВОЕ: Обновляем информацию о лимитах после удаления
        await loadAssistantsLimitInfo();
        
        setTimeout(() => {
          window.location.href = '/static/agents.html';
        }, 1000);
      } catch (error) {
        debugLog(`Ошибка при удалении: ${error.message}`);
        ui.showNotification(error.message || 'Ошибка при удалении агента', 'error');
      } finally {
        setLoading(false);
      }
    } else {
      debugLog('Отмена удаления агента');
    }
  });
  
  // Закрытие уведомления
  notificationClose.addEventListener('click', () => {
    ui.hideNotification();
  });
  
  // Выход из системы
  if (dropdownLogout) {
    dropdownLogout.addEventListener('click', function(e) {
      e.preventDefault();
      localStorage.removeItem('auth_token');
      window.location.href = 'https://voicyfy.ru/static/index.html';
    });
  }
  
  // Проверка подключения к Google таблице
  if (testSheetBtn) {
    testSheetBtn.addEventListener('click', async () => {
      const sheetId = googleSheetIdInput.value;
      
      if (!sheetId) {
        sheetConnectionStatus.innerHTML = `
          <div style="color: #ef4444;">
            <i class="fas fa-exclamation-circle"></i> Пожалуйста, укажите ID Google таблицы
          </div>
        `;
        sheetConnectionStatus.style.display = 'block';
        return;
      }
      
      sheetConnectionStatus.innerHTML = `
        <div style="color: #f59e0b;">
          <i class="fas fa-spinner fa-spin"></i> Проверка подключения...
        </div>
      `;
      sheetConnectionStatus.style.display = 'block';
      
      try {
        const assistantId = currentAgentId || 'new';
        const response = await api.verifyGoogleSheet(assistantId, sheetId);
        
        if (response.success) {
          sheetConnectionStatus.innerHTML = `
            <div style="color: #10b981;">
              <i class="fas fa-check-circle"></i> ${response.message}
            </div>
          `;
        } else {
          sheetConnectionStatus.innerHTML = `
            <div style="color: #ef4444;">
              <i class="fas fa-exclamation-circle"></i> ${response.message}
            </div>
          `;
        }
      } catch (error) {
        console.error('Ошибка при проверке таблицы:', error);
        sheetConnectionStatus.innerHTML = `
          <div style="color: #ef4444;">
            <i class="fas fa-exclamation-circle"></i> Ошибка при проверке таблицы: ${error.message}
          </div>
        `;
      }
    });
  }
  
  // Копирование ID агента
  if (copyAgentIdBtn) {
    copyAgentIdBtn.addEventListener('click', () => {
      const agentId = agentIdDisplay.textContent;
      if (agentId && agentId !== '-') {
        const tempTextarea = document.createElement('textarea');
        tempTextarea.value = agentId;
        document.body.appendChild(tempTextarea);
        tempTextarea.select();
        document.execCommand('copy');
        document.body.removeChild(tempTextarea);
        
        ui.showNotification('ID агента скопирован!', 'success');
      } else {
        ui.showNotification('Нет ID для копирования', 'error');
      }
    });
  }
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ ЭЛЕМЕНТОВ DOM
// ============================================================================

function initDOMElements() {
  tabs = document.querySelectorAll('.tab');
  tabContents = document.querySelectorAll('.tab-content');
  voiceOptions = document.querySelectorAll('.voice-option');
  agentForm = document.getElementById('agent-form');
  viewEmbedCodeBtn = document.getElementById('view-embed-code');
  deleteAgentBtn = document.getElementById('delete-agent');
  saveAgentBtn = document.getElementById('save-agent');
  createNewAgentBtn = document.getElementById('create-new-agent-btn');
  cancelButton = document.getElementById('cancel-button');
  copyEmbedCodeBtn = document.getElementById('copy-embed-code');
  notification = document.getElementById('notification');
  notificationMessage = document.getElementById('notification-message');
  notificationClose = document.getElementById('notification-close');
  loadingOverlay = document.getElementById('loading-overlay');
  debugPanel = document.getElementById('debug-panel');
  agentsListContainer = document.getElementById('agents-list-container');
  editAgentContainer = document.getElementById('edit-agent-container');
  mobileMenuToggle = document.getElementById('mobile-menu-toggle');
  sidebar = document.getElementById('sidebar');
  sidebarOverlay = document.getElementById('sidebar-overlay');
  userMenuButton = document.getElementById('user-menu-button');
  userDropdown = document.getElementById('user-dropdown');
  userEmailDisplay = document.getElementById('user-name');
  userAvatar = document.getElementById('user-avatar');
  dropdownLogout = document.getElementById('dropdown-logout');
  googleSheetIdInput = document.getElementById('google-sheet-id');
  testSheetBtn = document.getElementById('test-sheet-connection');
  sheetConnectionStatus = document.getElementById('sheet-connection-status');
  agentIdDisplay = document.getElementById('agent-id-display');
  copyAgentIdBtn = document.getElementById('copy-agent-id');
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ
// ============================================================================

async function initPage() {
  if (!api.checkAuth()) return;
  
  loadUserInfo();
  
  // ✅ НОВОЕ: Загружаем информацию о лимитах в первую очередь
  await loadAssistantsLimitInfo();
  
  const params = checkUrlParams();
  
  if (params.mode === 'edit') {
    currentAgentId = params.id;
    debugLog(`Инициализация страницы с ID агента: ${currentAgentId}`);
    
    switchToEditMode();
    await loadAvailableFunctions();
    await loadAgentData();
  } else if (params.mode === 'create') {
    // ✅ НОВОЕ: Проверяем лимит при попытке создания через URL
    if (!canCreateAssistant()) {
      showLimitReachedNotification();
      window.location.href = '/static/agents.html';
      return;
    }
    
    debugLog('Инициализация страницы в режиме создания');
    
    switchToEditMode();
    await loadAvailableFunctions();
    initCreateMode();
  } else {
    debugLog('Инициализация страницы в режиме списка агентов');
    
    switchToListMode();
    loadAgentsList();
  }
}

// ============================================================================
// ЗАПУСК ПРИЛОЖЕНИЯ
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
  initDOMElements();
  setupEventHandlers();
  initPage();
});
