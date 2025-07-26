// ============= ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ =============
let currentAgentId = null;
let isLoading = false;
let availableVoices = [];
let currentAgentData = null;

// ✅ Данные для новых функций
let knowledgeBase = {
  files: [],
  urls: [],
  texts: [],
  totalSize: 0,
  totalChars: 0
};

let dynamicVariables = [];
let serverTools = [];
let clientTools = [];
let systemTools = {
  endCall: false,
  agentTransfer: false,
  humanHandoff: false,
  languageDetection: false
};

// ✅ УЛУЧШЕННЫЙ CONVERSATION MANAGER С ДИАГНОСТИКОЙ
let conversationManager = null;

// ============= ✅ ИСПРАВЛЕННЫЙ API MANAGEMENT =============

const api = {
  baseUrl: '/api/elevenlabs',
  
  getToken() {
    return localStorage.getItem('auth_token');
  },
  
  isAuthenticated() {
    return this.getToken() !== null;
  },
  
  async fetch(endpoint, options = {}) {
    // ✅ ПРАВИЛЬНАЯ авторизация
    if (this.isAuthenticated()) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${this.getToken()}`
      };
    }
    
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
      options.headers = {
        ...options.headers,
        'Content-Type': 'application/json'
      };
      options.body = JSON.stringify(options.body);
    }
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    
    // ✅ ПРАВИЛЬНАЯ обработка 401
    if (response.status === 401) {
      localStorage.removeItem('auth_token');
      window.location.href = '/static/login.html';
      throw new Error('Требуется авторизация');
    }
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.detail || 'Произошла ошибка');
    }
    
    return data;
  },
  
  get(endpoint) {
    return this.fetch(endpoint, { method: 'GET' });
  },
  
  post(endpoint, data) {
    return this.fetch(endpoint, { method: 'POST', body: data });
  },
  
  put(endpoint, data) {
    return this.fetch(endpoint, { method: 'PUT', body: data });
  },
  
  delete(endpoint) {
    return this.fetch(endpoint, { method: 'DELETE' });
  },
  
  // ✅ НОВЫЙ метод для multipart form data (файлы)
  async postFormData(endpoint, formData) {
    const options = {
      method: 'POST',
      body: formData
    };
    
    if (this.isAuthenticated()) {
      options.headers = {
        'Authorization': `Bearer ${this.getToken()}`
      };
    }
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    
    if (response.status === 401) {
      localStorage.removeItem('auth_token');
      window.location.href = '/static/login.html';
      throw new Error('Требуется авторизация');
    }
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.detail || 'Произошла ошибка');
    }
    
    return data;
  }
};

// ============= UI UTILITIES =============

const ui = {
  showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    const notificationMessage = document.getElementById('notification-message');
    
    notification.className = `notification notification-${type} show`;
    notificationMessage.textContent = message;
    notification.style.display = 'flex';
    
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => {
        notification.style.display = 'none';
      }, 300);
    }, 5000);
  },
  
  showLoading() {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'flex';
    }
  },
  
  hideLoading() {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'none';
    }
  },
  
  // ✅ ИСПРАВЛЕННАЯ функция setFormData с правильным маппингом полей
  setFormData(form, data) {
    console.log('🔍 Заполнение формы данными:', data);
    
    // ✅ ПРАВИЛЬНЫЙ маппинг полей API -> HTML элементы
    const fieldMapping = {
      // Основные поля
      'name': 'agent-name',
      'language': 'agent-language', 
      'first_message': 'first-message',
      'system_prompt': 'system-prompt',
      'voice_id': 'voice_id', // Обрабатывается отдельно через радио кнопки
      
      // LLM настройки
      'llm_model': 'llm-model',
      'llm_temperature': 'llm-temperature',
      'llm_max_tokens': 'llm-max-tokens',
      
      // TTS настройки
      'tts_stability': 'tts-stability',
      'tts_similarity_boost': 'tts-similarity',
      'tts_speaker_boost': 'tts-speaker-boost'
    };
    
    // Заполняем основные поля
    Object.keys(fieldMapping).forEach(apiField => {
      const htmlFieldId = fieldMapping[apiField];
      const element = form.querySelector(`#${htmlFieldId}`);
      const value = data[apiField];
      
      console.log(`📝 Поле ${apiField} -> #${htmlFieldId}:`, value);
      
      if (element && value !== undefined && value !== null) {
        if (element.type === 'checkbox') {
          element.checked = Boolean(value);
          console.log(`✅ Checkbox ${htmlFieldId} установлен:`, element.checked);
        } else if (element.type === 'radio') {
          const radio = form.querySelector(`[name="${element.name}"][value="${value}"]`);
          if (radio) {
            radio.checked = true;
            console.log(`✅ Radio ${htmlFieldId} выбран:`, value);
          }
        } else {
          element.value = value;
          console.log(`✅ Input ${htmlFieldId} заполнен:`, element.value);
        }
      } else if (!element) {
        console.warn(`⚠️ Элемент #${htmlFieldId} не найден для поля ${apiField}`);
      }
    });
    
    // ✅ Обновляем отображение значений слайдеров
    this.updateSliderDisplays(data);
    
    console.log('✅ Форма заполнена данными');
  },
  
  // ✅ НОВАЯ функция для обновления отображения слайдеров
  updateSliderDisplays(data) {
    const sliderMappings = [
      { value: data.llm_temperature || 0.7, displayId: 'temperature-value', sliderId: 'llm-temperature' },
      { value: data.llm_max_tokens || 150, displayId: 'max-tokens-value', sliderId: 'llm-max-tokens' },
      { value: data.tts_stability || 0.5, displayId: 'stability-value', sliderId: 'tts-stability' },
      { value: data.tts_similarity_boost || 0.5, displayId: 'similarity-value', sliderId: 'tts-similarity' }
    ];
    
    sliderMappings.forEach(mapping => {
      const displayElement = document.getElementById(mapping.displayId);
      const sliderElement = document.getElementById(mapping.sliderId);
      
      if (displayElement) {
        displayElement.textContent = mapping.value;
        console.log(`✅ Обновлено отображение слайдера ${mapping.displayId}:`, mapping.value);
      }
      
      if (sliderElement) {
        sliderElement.value = mapping.value;
        console.log(`✅ Обновлено значение слайдера ${mapping.sliderId}:`, mapping.value);
      }
    });
  },
  
  getFormData(form) {
    const data = {};
    const formData = new FormData(form);
    
    for (const [key, value] of formData.entries()) {
      data[key] = value;
    }
    
    form.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      data[checkbox.name || checkbox.id] = checkbox.checked;
    });
    
    return data;
  }
};

// ============= ✅ НОВАЯ ФУНКЦИЯ ДЛЯ ЗАГРУЗКИ ВСЕХ ДОКУМЕНТОВ KB =============

async function loadAllKnowledgeBaseDocuments() {
  try {
    console.log('📚 Загружаем ВСЕ документы Knowledge Base через API...');
    ui.showLoading();
    
    // Получаем все документы через API
    const response = await api.get('/knowledge-base');
    
    if (!response.documents || !Array.isArray(response.documents)) {
      console.warn('⚠️ Нет документов в Knowledge Base');
      return;
    }
    
    console.log(`📊 Получено документов: ${response.documents.length}`);
    
    // Сбрасываем текущие данные
    window.knowledgeBase = {
      files: [],
      urls: [],
      texts: [],
      totalSize: 0,
      totalChars: 0
    };
    
    // Загружаем детали каждого документа
    for (const doc of response.documents) {
      try {
        console.log(`📄 Загружаем детали документа: ${doc.id}`);
        const docDetails = await api.get(`/knowledge-base/${doc.id}`);
        
        const docInfo = {
          document_id: doc.id,
          name: docDetails.name || doc.name || 'Без названия',
          chars: docDetails.character_count || docDetails.metadata?.character_count || 0,
          size: docDetails.size_in_bytes || docDetails.metadata?.size_bytes || 0,
          status: 'uploaded',
          created_at: docDetails.created_at_unix_secs || doc.created_at_unix_secs,
          source_type: docDetails.type || doc.type || 'unknown',
          index_status: docDetails.rag_index?.status || 'ready'
        };
        
        // Распределяем по типам
        switch (docInfo.source_type) {
          case 'file':
            docInfo.filename = docDetails.filename || docInfo.name;
            window.knowledgeBase.files.push(docInfo);
            console.log(`✅ Добавлен файл: ${docInfo.filename}`);
            break;
            
          case 'url':
            docInfo.url = docDetails.url || '';
            docInfo.title = docInfo.name;
            window.knowledgeBase.urls.push(docInfo);
            console.log(`✅ Добавлен URL: ${docInfo.url}`);
            break;
            
          case 'text':
            docInfo.title = docInfo.name;
            docInfo.content = docDetails.text ? docDetails.text.substring(0, 200) : '';
            window.knowledgeBase.texts.push(docInfo);
            console.log(`✅ Добавлен текст: ${docInfo.title}`);
            break;
            
          default:
            // Неизвестный тип - добавляем как текст
            console.warn(`⚠️ Неизвестный тип документа: ${docInfo.source_type}`);
            docInfo.title = docInfo.name;
            docInfo.content = '';
            window.knowledgeBase.texts.push(docInfo);
            break;
        }
        
        // Обновляем статистику
        window.knowledgeBase.totalSize += docInfo.size;
        window.knowledgeBase.totalChars += docInfo.chars;
        
      } catch (error) {
        console.error(`❌ Ошибка загрузки деталей документа ${doc.id}:`, error);
      }
    }
    
    console.log('✅ Knowledge Base полностью загружена:', {
      files: window.knowledgeBase.files.length,
      urls: window.knowledgeBase.urls.length,
      texts: window.knowledgeBase.texts.length,
      totalSize: window.knowledgeBase.totalSize,
      totalChars: window.knowledgeBase.totalChars
    });
    
    // Обновляем UI если таб Knowledge Base открыт
    if (document.getElementById('knowledge-tab')?.classList.contains('active')) {
      window.updateKnowledgeStats();
      window.renderKnowledgeFiles();
      window.renderKnowledgeUrls();
      window.renderKnowledgeTexts();
    }
    
  } catch (error) {
    console.error('❌ Ошибка загрузки Knowledge Base:', error);
    ui.showNotification('Ошибка загрузки базы знаний', 'error');
  } finally {
    ui.hideLoading();
  }
}

// ============= ✅ ИСПРАВЛЕННЫЕ ОСНОВНЫЕ ФУНКЦИИ =============

// ✅ ИСПРАВЛЕНА функция проверки API ключа
async function checkApiKey() {
  try {
    console.log('🔍 Проверка API ключа ElevenLabs...');
    const response = await api.get('/api-key/status');
    console.log('📊 Статус API ключа:', response);
    
    if (response.has_api_key && response.is_valid) {
      console.log('✅ API ключ валиден');
      document.getElementById('api-key-container').style.display = 'none';
      document.getElementById('agents-list-container').style.display = 'block';
      
      await updateApiKeyDisplay();
      
      // Загружаем агентов
      loadAgents();
      // Загружаем голоса
      loadVoices();
      // ✅ НОВОЕ: Загружаем ВСЕ документы Knowledge Base
      await loadAllKnowledgeBaseDocuments();
      
      return true;
    } else if (response.has_api_key && !response.is_valid) {
      console.log('❌ API ключ недействителен');
      ui.showNotification('API ключ ElevenLabs недействителен. Обновите ключ в настройках.', 'error');
      document.getElementById('api-key-container').style.display = 'block';
      document.getElementById('agents-list-container').style.display = 'none';
      return false;
    } else {
      console.log('⚠️ API ключ не установлен');
      document.getElementById('api-key-container').style.display = 'block';
      document.getElementById('agents-list-container').style.display = 'none';
      return false;
    }
  } catch (error) {
    console.error('❌ Ошибка проверки API ключа:', error);
    ui.showNotification('Ошибка при проверке API ключа: ' + error.message, 'error');
    document.getElementById('api-key-container').style.display = 'block';
    document.getElementById('agents-list-container').style.display = 'none';
    return false;
  }
}

// ✅ ИСПРАВЛЕНА функция обновления отображения API ключа
async function updateApiKeyDisplay() {
  try {
    const response = await api.get('/api-key/status');
    const apiKeyDisplay = document.getElementById('api-key-display');
    if (apiKeyDisplay && response.has_api_key) {
      apiKeyDisplay.textContent = 'sk_...****';
    }
  } catch (error) {
    console.error('Ошибка обновления отображения API ключа:', error);
  }
}

// ✅ ИСПРАВЛЕНА функция сохранения API ключа
async function saveApiKey(apiKey) {
  try {
    ui.showLoading();
    const response = await api.post('/api-key', { api_key: apiKey });
    
    if (response.success) {
      availableVoices = response.voices || [];
      ui.showNotification('API ключ сохранен успешно!', 'success');
      await updateApiKeyDisplay();
      await loadAgents();
      // ✅ НОВОЕ: Загружаем Knowledge Base после сохранения ключа
      await loadAllKnowledgeBaseDocuments();
      
      // Переключаемся на список агентов
      document.getElementById('api-key-container').style.display = 'none';
      document.getElementById('agents-list-container').style.display = 'block';
    } else {
      throw new Error('Не удалось сохранить API ключ');
    }
  } catch (error) {
    ui.showNotification(error.message || 'Ошибка при сохранении API ключа', 'error');
  } finally {
    ui.hideLoading();
  }
}

// ✅ ИСПРАВЛЕНА функция удаления API ключа
async function removeApiKey() {
  if (!confirm('Удалить API ключ? Это отключит всех агентов.')) {
    return;
  }
  
  try {
    ui.showLoading();
    await api.post('/api-key', { api_key: '' });
    ui.showNotification('API ключ удален', 'success');
    await updateApiKeyDisplay();
    
    // Очищаем Knowledge Base
    window.knowledgeBase = {
      files: [],
      urls: [],
      texts: [],
      totalSize: 0,
      totalChars: 0
    };
    
    // Переключаемся на форму API ключа
    document.getElementById('api-key-container').style.display = 'block';
    document.getElementById('agents-list-container').style.display = 'none';
  } catch (error) {
    ui.showNotification(`Ошибка: ${error.message}`, 'error');
  } finally {
    ui.hideLoading();
  }
}

// ✅ ИСПРАВЛЕНА функция загрузки голосов
async function loadVoices() {
  try {
    const voices = await api.get('/voices');
    availableVoices = voices || [];
    renderVoiceOptions();
  } catch (error) {
    console.error('Ошибка загрузки голосов:', error);
    ui.showNotification('Ошибка загрузки голосов', 'warning');
  }
}

function renderVoiceOptions() {
  const voiceOptions = document.getElementById('voice-options');
  if (!voiceOptions) return;
  
  voiceOptions.innerHTML = '';
  
  if (availableVoices.length === 0) {
    voiceOptions.innerHTML = '<p style="color: var(--text-gray);">Голоса недоступны. Проверьте API ключ.</p>';
    return;
  }
  
  availableVoices.forEach((voice, index) => {
    const voiceEl = document.createElement('label');
    voiceEl.className = 'voice-option';
    if (index === 0) voiceEl.classList.add('selected');
    
    voiceEl.innerHTML = `
      <input type="radio" name="voice" value="${voice.voice_id}" ${index === 0 ? 'checked' : ''}>
      <span>${voice.name}</span>
      ${voice.preview_url ? `<span class="voice-preview" data-url="${voice.preview_url}">▶</span>` : ''}
    `;
    
    voiceOptions.appendChild(voiceEl);
  });
  
  document.querySelectorAll('.voice-option').forEach(option => {
    option.addEventListener('click', function() {
      document.querySelectorAll('.voice-option').forEach(opt => opt.classList.remove('selected'));
      this.classList.add('selected');
      this.querySelector('input').checked = true;
      
      const selectedVoiceName = this.querySelector('span').textContent;
      const selectedVoiceNameEl = document.getElementById('selected-voice-name');
      if (selectedVoiceNameEl) {
        selectedVoiceNameEl.textContent = selectedVoiceName;
      }
    });
  });
  
  document.querySelectorAll('.voice-preview').forEach(preview => {
    preview.addEventListener('click', function(e) {
      e.stopPropagation();
      const url = this.getAttribute('data-url');
      if (url) {
        const audio = new Audio(url);
        audio.play();
      }
    });
  });
}

// ✅ ИСПРАВЛЕНА функция загрузки агентов
async function loadAgents() {
  try {
    const agents = await api.get('/');
    renderAgentsList(agents || []);
  } catch (error) {
    console.error('Ошибка загрузки агентов:', error);
    ui.showNotification('Ошибка загрузки агентов', 'error');
  }
}

function renderAgentsList(agents) {
  const agentsList = document.getElementById('agents-list');
  if (!agentsList) return;
  
  agentsList.innerHTML = '';
  
  if (!agents || agents.length === 0) {
    agentsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <i class="fas fa-robot"></i>
        </div>
        <h3 class="empty-title">У вас еще нет голосовых агентов</h3>
        <p class="empty-description">
          Создайте вашего первого голосового ассистента ElevenLabs с новыми возможностями:<br>
          📚 База знаний • 🎛️ Персонализация • 🔧 Внешние API • 🤖 Системные инструменты
        </p>
        <button class="btn btn-primary" id="empty-create-agent-btn">
          <i class="fas fa-plus"></i> Создать голосового агента
        </button>
      </div>
    `;
    
    // Добавляем обработчик для кнопки создания
    const emptyCreateBtn = document.getElementById('empty-create-agent-btn');
    if (emptyCreateBtn) {
      emptyCreateBtn.addEventListener('click', () => editAgent('new'));
    }
    return;
  }
  
  agents.forEach(agent => {
    const agentEl = document.createElement('div');
    agentEl.className = 'agent-item';
    
    // ✅ Правильно получаем ID агента
    const agentId = agent.elevenlabs_agent_id || agent.id;
    
    agentEl.innerHTML = `
      <div class="agent-icon">
        <i class="fas fa-microphone"></i>
      </div>
      <div class="agent-info">
        <h3 class="agent-name">${agent.name || 'Unnamed Agent'}</h3>
        <div class="agent-details">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <i class="fas fa-check-circle" style="color: var(--success-color);"></i>
            <span>ID: ${agentId}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <i class="fas fa-volume-up" style="color: var(--primary-blue);"></i>
            <span>Голос: ${agent.voice_id || 'Не выбран'}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <i class="fas fa-globe" style="color: var(--primary-blue);"></i>
            <span>Язык: ${getLanguageName(agent.language || 'en')}</span>
          </div>
          ${agent.llm_model ? `
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <i class="fas fa-brain" style="color: var(--primary-blue);"></i>
            <span>Модель: ${agent.llm_model}</span>
          </div>
          ` : ''}
          ${agent.first_message ? `
          <div style="display: flex; align-items: flex-start; gap: 0.5rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
            <i class="fas fa-comment-dots" style="color: var(--text-light); margin-top: 0.1rem;"></i>
            <div style="flex: 1;">
              <div style="font-size: 0.75rem; color: var(--text-light); text-transform: uppercase; margin-bottom: 0.25rem;">Первая фраза:</div>
              <div style="font-style: italic; color: var(--text-gray); line-height: 1.3;">"${agent.first_message.length > 80 ? agent.first_message.substring(0, 80) + '...' : agent.first_message}"</div>
            </div>
          </div>
          ` : ''}
          
          <!-- ✅ Показываем новые возможности если есть -->
          <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap;">
            ${agent.knowledge_base_documents && agent.knowledge_base_documents.length > 0 ? `
            <span style="background: #dcfce7; color: #166534; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;">
              📚 База знаний (${agent.knowledge_base_documents.length})
            </span>
            ` : ''}
            ${agent.dynamic_variables && agent.dynamic_variables.length > 0 ? `
            <span style="background: #dbeafe; color: #1e40af; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;">
              🎛️ Переменные (${agent.dynamic_variables.length})
            </span>
            ` : ''}
            ${agent.server_tools && agent.server_tools.length > 0 ? `
            <span style="background: #fef3c7; color: #92400e; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;">
              🔧 Инструменты (${agent.server_tools.length})
            </span>
            ` : ''}
            ${agent.system_tools && Object.values(agent.system_tools).some(Boolean) ? `
            <span style="background: #f3e8ff; color: #7c2d12; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;">
              🤖 Системные
            </span>
            ` : ''}
          </div>
        </div>
        <div class="agent-actions">
          <button class="btn btn-outline edit-agent" data-id="${agentId}">
            <i class="fas fa-edit"></i> Редактировать
          </button>
        </div>
      </div>
    `;
    
    agentsList.appendChild(agentEl);
  });
  
  // ✅ Правильно добавляем обработчики
  document.querySelectorAll('.edit-agent').forEach(button => {
    button.addEventListener('click', function(e) {
      e.preventDefault();
      const agentId = this.getAttribute('data-id');
      console.log('🔍 Редактируем агента с ID:', agentId);
      editAgent(agentId);
    });
  });
}

function getLanguageName(code) {
  const languages = {
    'en': '🇺🇸 English',
    'ru': '🇷🇺 Русский',
    'es': '🇪🇸 Español',
    'fr': '🇫🇷 Français',
    'de': '🇩🇪 Deutsch',
    'it': '🇮🇹 Italiano',
    'pt': '🇵🇹 Português',
    'ja': '🇯🇵 日本語',
    'ko': '🇰🇷 한국어',
    'zh': '🇨🇳 中文'
  };
  return languages[code] || code;
}

// ✅ ИСПРАВЛЕНА функция редактирования агента
async function editAgent(agentId) {
  try {
    console.log('🔍 Начинаем редактирование агента:', agentId);
    ui.showLoading();
    currentAgentId = agentId;
    
    // ✅ ИСПРАВЛЕНИЕ 2: Синхронизируем с window объектом
    window.currentAgentId = currentAgentId;
    
    if (agentId === 'new') {
      console.log('✨ Создание нового агента');
      // Создание нового агента
      currentAgentData = {
        name: '',
        language: 'ru',
        first_message: 'Привет! Как дела? Чем могу помочь?',
        system_prompt: 'Вы полезный ассистент.',
        voice_id: availableVoices[0]?.voice_id || '',
        llm_model: 'gpt-4',
        llm_temperature: 0.7,
        llm_max_tokens: 150,
        tts_stability: 0.5,
        tts_similarity_boost: 0.5,
        tts_speaker_boost: true
      };
      
      // Сброс дополнительных данных (кроме Knowledge Base)
      dynamicVariables = [];
      serverTools = [];
      clientTools = [];
      systemTools = { endCall: false, agentTransfer: false, humanHandoff: false, languageDetection: false };
      
      console.log('✅ Новый агент инициализирован с дефолтными данными');
      
    } else {
      console.log('📥 Загрузка существующего агента из API:', agentId);
      
      // ✅ ИСПРАВЛЕНО: Используем правильный endpoint для загрузки агента
      const agentData = await api.get(`/${agentId}`);
      console.log('📊 Получены данные агента от API:', agentData);
      
      currentAgentData = agentData;
      
      // Загружаем остальные данные агента
      dynamicVariables = agentData.dynamic_variables || [];
      serverTools = agentData.server_tools || [];
      clientTools = agentData.client_tools || [];
      systemTools = agentData.system_tools || { endCall: false, agentTransfer: false, humanHandoff: false, languageDetection: false };
      
      console.log('✅ Дополнительные данные агента загружены');
    }
    
    // ✅ База знаний уже загружена при инициализации страницы
    console.log('📚 Используем уже загруженную Knowledge Base:', {
      files: window.knowledgeBase.files.length,
      urls: window.knowledgeBase.urls.length,
      texts: window.knowledgeBase.texts.length
    });
    
    // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Заполняем форму ПОСЛЕ загрузки данных
    console.log('🖊️ Заполнение формы данными агента...');
    await fillAgentForm(currentAgentData);
    
    // ✅ Показываем форму редактирования
    showEditForm();
    
  } catch (error) {
    console.error('❌ Ошибка загрузки агента:', error);
    ui.showNotification(`Ошибка загрузки агента: ${error.message}`, 'error');
  } finally {
    ui.hideLoading();
  }
}

// ✅ КАРДИНАЛЬНО ПЕРЕПИСАНА функция заполнения формы
async function fillAgentForm(agentData) {
  console.log('🖊️ Начинаем заполнение формы данными:', agentData);
  
  const agentForm = document.getElementById('agent-form');
  if (!agentForm) {
    console.error('❌ Форма агента не найдена!');
    return;
  }
  
  // ✅ ЖДЕМ рендеринга голосов если они еще не загружены
  if (availableVoices.length === 0) {
    console.log('⏳ Голоса не загружены, загружаем...');
    await loadVoices();
  }
  
  // ✅ Заполняем форму через исправленную функцию
  ui.setFormData(agentForm, agentData);
  
  // ✅ КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Правильный выбор голоса
  console.log('🎵 Установка голоса:', agentData.voice_id);
  setSelectedVoice(agentData.voice_id);
  
  // ✅ Обновляем отображение выбранного голоса
  updateSelectedVoiceName(agentData.voice_id);
  
  console.log('✅ Форма успешно заполнена');
}

// ✅ НОВАЯ функция для правильной установки выбранного голоса
function setSelectedVoice(voiceId) {
  if (!voiceId) {
    console.log('⚠️ Voice ID не указан, используем первый доступный голос');
    if (availableVoices.length > 0) {
      voiceId = availableVoices[0].voice_id;
    } else {
      console.warn('❌ Нет доступных голосов');
      return;
    }
  }
  
  const voiceOptions = document.getElementById('voice-options');
  if (!voiceOptions) {
    console.error('❌ Контейнер голосов не найден');
    return;
  }
  
  // Сбрасываем все выборы
  document.querySelectorAll('.voice-option').forEach(option => {
    option.classList.remove('selected');
    const radio = option.querySelector('input[type="radio"]');
    if (radio) radio.checked = false;
  });
  
  // Находим и выбираем нужный голос
  const targetVoiceRadio = voiceOptions.querySelector(`input[value="${voiceId}"]`);
  if (targetVoiceRadio) {
    targetVoiceRadio.checked = true;
    const voiceOption = targetVoiceRadio.closest('.voice-option');
    if (voiceOption) {
      voiceOption.classList.add('selected');
    }
    console.log('✅ Голос выбран:', voiceId);
  } else {
    console.warn('⚠️ Голос не найден среди доступных:', voiceId);
    // Выбираем первый доступный как fallback
    const firstVoiceRadio = voiceOptions.querySelector('input[type="radio"]');
    if (firstVoiceRadio) {
      firstVoiceRadio.checked = true;
      firstVoiceRadio.closest('.voice-option')?.classList.add('selected');
      console.log('✅ Выбран первый доступный голос как fallback');
    }
  }
}

function updateSelectedVoiceName(voiceId) {
  const selectedVoiceNameEl = document.getElementById('selected-voice-name');
  if (selectedVoiceNameEl) {
    const voice = availableVoices.find(v => v.voice_id === voiceId);
    selectedVoiceNameEl.textContent = voice ? voice.name : '-';
    console.log('✅ Обновлено отображение выбранного голоса:', voice?.name || 'не найден');
  }
}

function showEditForm() {
  console.log('📱 Показываем форму редактирования');
  
  document.getElementById('agents-list-container').style.display = 'none';
  document.getElementById('edit-agent-container').style.display = 'block';
  
  // Показываем кнопки в хедере
  if (currentAgentId !== 'new') {
    document.getElementById('delete-agent').style.display = 'inline-flex';
    document.getElementById('view-embed-code').style.display = 'inline-flex';
  }
  document.getElementById('save-agent').style.display = 'inline-flex';
  
  console.log('✅ Форма редактирования показана');
}

function hideEditForm() {
  document.getElementById('agents-list-container').style.display = 'block';
  document.getElementById('edit-agent-container').style.display = 'none';
  
  // Скрываем кнопки в хедере
  document.getElementById('delete-agent').style.display = 'none';
  document.getElementById('view-embed-code').style.display = 'none';
  document.getElementById('save-agent').style.display = 'none';
  
  currentAgentId = null;
  currentAgentData = null;
}

// ✅ ИСПРАВЛЕННАЯ функция сохранения агента
async function saveAgent() {
  try {
    ui.showLoading();
    
    const agentForm = document.getElementById('agent-form');
    const formData = ui.getFormData(agentForm);
    
    // ✅ ИСПРАВЛЕННАЯ валидация с правильными ID полей
    const agentName = document.getElementById('agent-name')?.value?.trim();
    const systemPrompt = document.getElementById('system-prompt')?.value?.trim();
    
    if (!agentName) {
      ui.showNotification('Введите название агента', 'error');
      return;
    }
    
    if (!systemPrompt) {
      ui.showNotification('Введите системный промпт', 'error');
      return;
    }
    
    // Добавляем выбранный голос
    const selectedVoice = document.querySelector('input[name="voice"]:checked');
    if (!selectedVoice || !selectedVoice.value) {
      ui.showNotification('Выберите голос для агента', 'error');
      return;
    }
    
    // ✅ ПРАВИЛЬНОЕ формирование данных агента
    const agentData = {
      // Основные поля с правильными значениями из формы
      name: agentName,
      language: document.getElementById('agent-language')?.value || 'ru',
      first_message: document.getElementById('first-message')?.value?.trim() || '',
      system_prompt: systemPrompt,
      voice_id: selectedVoice.value,
      
      // LLM настройки
      llm_model: document.getElementById('llm-model')?.value || 'gpt-4',
      llm_temperature: parseFloat(document.getElementById('llm-temperature')?.value || 0.7),
      llm_max_tokens: parseInt(document.getElementById('llm-max-tokens')?.value || 150),
      
      // TTS настройки
      tts_stability: parseFloat(document.getElementById('tts-stability')?.value || 0.5),
      tts_similarity_boost: parseFloat(document.getElementById('tts-similarity')?.value || 0.5),
      tts_speaker_boost: document.getElementById('tts-speaker-boost')?.checked || true,
      
      // ✅ ИСПРАВЛЕНО: Правильная обработка Knowledge Base
      knowledge_base_documents: [],
      knowledge_base: window.knowledgeBase,
      
      // ✅ Фильтруем пустые dynamic variables
      dynamic_variables: (window.dynamicVariables || []).filter(v => 
        v && v.name && v.name.trim() && v.value && v.value.trim()
      ),
      
      // ✅ Фильтруем пустые server tools
      server_tools: (window.serverTools || []).filter(t => 
        t && t.name && t.name.trim() && t.url && t.url.trim()
      ),
      
      // ✅ Фильтруем пустые client tools
      client_tools: (window.clientTools || []).filter(t => 
        t && t.name && t.name.trim() && t.description && t.description.trim()
      ),
      
      // ✅ System tools
      system_tools: window.systemTools || {}
    };
    
    // Собираем ID документов из Knowledge Base
    if (window.knowledgeBase) {
      const knowledgeBaseDocIds = [];
      
      // Добавляем ID документов из файлов
      window.knowledgeBase.files.forEach(file => {
        if (file.document_id) {
          knowledgeBaseDocIds.push(file.document_id);
        }
      });
      
      // Добавляем ID документов из URL
      window.knowledgeBase.urls.forEach(url => {
        if (url.document_id) {
          knowledgeBaseDocIds.push(url.document_id);
        }
      });
      
      // Добавляем ID документов из текстов
      window.knowledgeBase.texts.forEach(text => {
        if (text.document_id) {
          knowledgeBaseDocIds.push(text.document_id);
        }
      });
      
      agentData.knowledge_base_documents = knowledgeBaseDocIds;
    }
    
    console.log('📤 Отправляем данные агента:', {
      name: agentData.name,
      voice_id: agentData.voice_id,
      llm_model: agentData.llm_model,
      knowledge_base_documents: agentData.knowledge_base_documents.length,
      dynamic_variables: agentData.dynamic_variables.length,
      server_tools: agentData.server_tools.length,
      client_tools: agentData.client_tools.length,
      system_tools: Object.keys(agentData.system_tools).length
    });
    
    let result;
    if (currentAgentId === 'new') {
      // ✅ Создание нового агента
      result = await api.post('/', agentData);
      currentAgentId = result.elevenlabs_agent_id || result.id;
      
      // ✅ ИСПРАВЛЕНИЕ 2: Синхронизируем с window объектом
      window.currentAgentId = currentAgentId;
      
      ui.showNotification('Агент успешно создан!', 'success');
      
      // Обновляем кнопки в хедере
      document.getElementById('delete-agent').style.display = 'inline-flex';
      document.getElementById('view-embed-code').style.display = 'inline-flex';
      
    } else {
      // ✅ Обновление существующего агента
      result = await api.put(`/${currentAgentId}`, agentData);
      
      // ✅ ИСПРАВЛЕНИЕ 2: Убеждаемся что ID не изменился
      window.currentAgentId = currentAgentId;
      
      ui.showNotification('Агент успешно обновлен!', 'success');
    }
    
    // Обновляем текущие данные агента
    currentAgentData = result;
    
    // Загружаем embed код если агент сохранен
    if (currentAgentId && currentAgentId !== 'new') {
      try {
        const embedData = await api.get(`/${currentAgentId}/embed`);
        const embedCodeEl = document.getElementById('embed-code');
        if (embedCodeEl) {
          embedCodeEl.textContent = embedData.embed_code;
        }
      } catch (error) {
        console.warn('Не удалось загрузить embed код:', error);
      }
    }
    
  } catch (error) {
    console.error('❌ Ошибка сохранения агента:', error);
    
    // Показываем более детальную ошибку пользователю
    let errorMessage = 'Неизвестная ошибка при сохранении агента';
    
    if (error.message) {
      if (error.message.includes('Voice ID')) {
        errorMessage = 'Проблема с выбранным голосом. Выберите другой голос.';
      } else if (error.message.includes('prompt')) {
        errorMessage = 'Проблема с системным промптом. Проверьте содержание.';
      } else if (error.message.includes('knowledge')) {
        errorMessage = 'Проблема с базой знаний. Проверьте загруженные документы.';
      } else if (error.message.includes('tool')) {
        errorMessage = 'Проблема с инструментами. Проверьте настройки tools.';
      } else {
        errorMessage = error.message;
      }
    }
    
    ui.showNotification(`Ошибка сохранения: ${errorMessage}`, 'error');
    
  } finally {
    ui.hideLoading();
  }
}

// ✅ ИСПРАВЛЕНА функция удаления агента
async function deleteAgent() {
  if (!currentAgentId || currentAgentId === 'new') return;
  
  if (!confirm('Вы уверены, что хотите удалить этого агента? Это действие нельзя отменить.')) {
    return;
  }
  
  try {
    ui.showLoading();
    // ✅ ИСПРАВЛЕНО: Используем правильный endpoint для удаления
    await api.delete(`/${currentAgentId}`);
    ui.showNotification('Агент успешно удален!', 'success');
    
    // Возвращаемся к списку агентов
    await loadAgents();
    hideEditForm();
    
  } catch (error) {
    console.error('Ошибка удаления агента:', error);
    ui.showNotification(`Ошибка удаления: ${error.message}`, 'error');
  } finally {
    ui.hideLoading();
  }
}

function testAgent(agentId) {
  editAgent(agentId);
  // Переключаемся на таб тестирования
  switchToTab('testing');
}

function showEmbedCode(agentId) {
  editAgent(agentId);
  // Переключаемся на таб встраивания
  switchToTab('embed');
}

function switchToTab(tabName) {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.classList.remove('active');
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    }
  });
  
  tabContents.forEach(content => {
    content.classList.remove('active');
    if (content.id === `${tabName}-tab`) {
      content.classList.add('active');
    }
  });
  
  if (tabName === 'embed') {
    generateEmbedCode();
  }
}

// ✅ ИСПРАВЛЕНА функция генерации embed кода
async function generateEmbedCode() {
  if (!currentAgentId || currentAgentId === 'new') {
    const embedCodeEl = document.getElementById('embed-code');
    if (embedCodeEl) {
      embedCodeEl.textContent = 'Сначала сохраните агента для получения кода встраивания';
    }
    return;
  }
  
  try {
    // ✅ ИСПРАВЛЕНО: Используем правильный endpoint для embed кода
    const embedData = await api.get(`/${currentAgentId}/embed`);
    const embedCodeEl = document.getElementById('embed-code');
    if (embedCodeEl) {
      embedCodeEl.textContent = embedData.embed_code;
    }
  } catch (error) {
    console.error('Ошибка получения embed кода:', error);
    const embedCodeEl = document.getElementById('embed-code');
    if (embedCodeEl) {
      embedCodeEl.textContent = `Ошибка получения кода: ${error.message}`;
    }
  }
}

// ============= ✅ ИСПРАВЛЕННЫЕ ФУНКЦИИ ДЛЯ KNOWLEDGE BASE =============

// ✅ БЫСТРАЯ загрузка файлов БЕЗ ОЖИДАНИЯ
async function handleFileUpload(files) {
  console.log('📁 Загрузка файлов:', files.length);
  
  // НЕ показываем общий индикатор загрузки, только отдельные для файлов
  
  let successCount = 0;
  let errorCount = 0;
  const uploadPromises = [];
  
  // Сразу добавляем файлы в UI со статусом "загрузка"
  for (const file of files) {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fileData = {
      name: file.name,
      filename: file.name,
      size: file.size,
      chars: Math.round(file.size * 0.8),
      status: 'uploading',
      document_id: tempId,
      _tempId: tempId
    };
    
    window.knowledgeBase.files.push(fileData);
  }
  
  // Обновляем UI сразу
  window.updateKnowledgeBase();
  if (window.renderKnowledgeFiles) {
    window.renderKnowledgeFiles();
  }
  if (window.updateKnowledgeStats) {
    window.updateKnowledgeStats();
  }
  
  // Загружаем файлы параллельно
  files.forEach((file, index) => {
    const promise = (async () => {
      try {
        const tempId = window.knowledgeBase.files[window.knowledgeBase.files.length - files.length + index]._tempId;
        
        // ✅ РЕАЛЬНАЯ загрузка через API
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', file.name);
        
        const response = await api.postFormData('/knowledge-base/file', formData);
        
        // Находим файл по временному ID и обновляем
        const fileIndex = window.knowledgeBase.files.findIndex(f => f._tempId === tempId);
        if (fileIndex !== -1) {
          window.knowledgeBase.files[fileIndex] = {
            name: response.name || file.name,
            filename: file.name,
            size: file.size,
            chars: response.chars || Math.round(file.size * 0.8),
            status: 'uploaded',
            document_id: response.document_id,
            index_status: 'in_progress' // Индексация началась автоматически
          };
        }
        
        successCount++;
        console.log(`✅ Файл загружен: ${response.document_id}`);
        
        // Обновляем только этот файл в UI
        if (window.renderKnowledgeFiles) {
          window.renderKnowledgeFiles();
        }
        
      } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        errorCount++;
        
        // Помечаем файл как ошибочный
        const tempId = window.knowledgeBase.files[window.knowledgeBase.files.length - files.length + index]._tempId;
        const fileIndex = window.knowledgeBase.files.findIndex(f => f._tempId === tempId);
        if (fileIndex !== -1) {
          window.knowledgeBase.files[fileIndex].status = 'error';
          window.knowledgeBase.files[fileIndex].error = error.message;
        }
        
        if (window.renderKnowledgeFiles) {
          window.renderKnowledgeFiles();
        }
      }
    })();
    
    uploadPromises.push(promise);
  });
  
  // Ждем завершения всех загрузок
  await Promise.all(uploadPromises);
  
  // Обновляем общую статистику
  window.updateKnowledgeBase();
  if (window.updateKnowledgeStats) {
    window.updateKnowledgeStats();
  }
  
  // Показываем результат
  if (successCount > 0 && errorCount === 0) {
    ui.showNotification(`Все файлы успешно загружены (${successCount})!`, 'success');
  } else if (successCount > 0 && errorCount > 0) {
    ui.showNotification(`Загружено ${successCount} файлов, ошибок: ${errorCount}`, 'warning');
  } else {
    ui.showNotification(`Не удалось загрузить файлы`, 'error');
  }
  
  // Перезагружаем весь список документов после загрузки
  setTimeout(() => {
    loadAllKnowledgeBaseDocuments();
  }, 2000);
}

// ✅ БЫСТРОЕ добавление URL БЕЗ ОЖИДАНИЯ
async function handleUrlAdd(url) {
  console.log('🌐 Добавление URL:', url);
  
  // Сразу добавляем в UI со статусом загрузки
  const tempId = `temp_url_${Date.now()}`;
  const urlData = {
    url: url,
    title: `URL: ${url}`,
    document_id: tempId,
    chars: 2000, // Примерная оценка
    status: 'uploading',
    _tempId: tempId
  };
  
  window.knowledgeBase.urls.push(urlData);
  window.updateKnowledgeBase();
  
  // Очищаем поле ввода сразу
  const urlInput = document.getElementById('knowledge-url');
  if (urlInput) {
    urlInput.value = '';
  }
  
  // Обновляем отображение
  if (window.renderKnowledgeUrls) {
    window.renderKnowledgeUrls();
  }
  if (window.updateKnowledgeStats) {
    window.updateKnowledgeStats();
  }
  
  try {
    // ✅ РЕАЛЬНОЕ добавление через API в фоне
    const response = await api.post('/knowledge-base/url', {
      url: url,
      name: `URL: ${url}`
    });
    
    // Находим URL по временному ID и обновляем
    const urlIndex = window.knowledgeBase.urls.findIndex(u => u._tempId === tempId);
    if (urlIndex !== -1) {
      window.knowledgeBase.urls[urlIndex] = {
        url: url,
        title: response.name || `URL: ${url}`,
        document_id: response.document_id,
        chars: response.chars || 2000,
        status: 'uploaded',
        index_status: 'in_progress'
      };
    }
    
    // Обновляем отображение
    if (window.renderKnowledgeUrls) {
      window.renderKnowledgeUrls();
    }
    if (window.updateKnowledgeStats) {
      window.updateKnowledgeStats();
    }
    
    console.log(`✅ URL добавлен: ${response.document_id}`);
    ui.showNotification(`URL успешно добавлен!`, 'success');
    
    // Перезагружаем весь список документов после добавления
    setTimeout(() => {
      loadAllKnowledgeBaseDocuments();
    }, 2000);
    
  } catch (error) {
    console.error('❌ Ошибка добавления URL:', error);
    
    // Помечаем как ошибку
    const urlIndex = window.knowledgeBase.urls.findIndex(u => u._tempId === tempId);
    if (urlIndex !== -1) {
      window.knowledgeBase.urls[urlIndex].status = 'error';
      window.knowledgeBase.urls[urlIndex].error = error.message;
    }
    
    if (window.renderKnowledgeUrls) {
      window.renderKnowledgeUrls();
    }
    
    ui.showNotification(`Ошибка добавления URL: ${error.message}`, 'error');
  }
}

// ✅ БЫСТРОЕ добавление текста БЕЗ ОЖИДАНИЯ
async function handleTextAdd(text) {
  console.log('✏️ Добавление текста:', text.substring(0, 50) + '...');
  
  const textName = `Текст ${window.knowledgeBase.texts.length + 1}`;
  
  // Сразу добавляем в UI со статусом загрузки
  const tempId = `temp_text_${Date.now()}`;
  const textData = {
    title: textName,
    content: text,
    document_id: tempId,
    chars: text.length,
    status: 'uploading',
    _tempId: tempId
  };
  
  window.knowledgeBase.texts.push(textData);
  window.updateKnowledgeBase();
  
  // Очищаем поле ввода сразу
  const textInput = document.getElementById('knowledge-text');
  if (textInput) {
    textInput.value = '';
  }
  
  // Обновляем отображение
  if (window.renderKnowledgeTexts) {
    window.renderKnowledgeTexts();
  }
  if (window.updateKnowledgeStats) {
    window.updateKnowledgeStats();
  }
  
  try {
    // ✅ РЕАЛЬНОЕ добавление через API в фоне
    const response = await api.post('/knowledge-base/text', {
      text: text,
      name: textName
    });
    
    // Находим текст по временному ID и обновляем
    const textIndex = window.knowledgeBase.texts.findIndex(t => t._tempId === tempId);
    if (textIndex !== -1) {
      window.knowledgeBase.texts[textIndex] = {
        title: response.name || textName,
        content: text,
        document_id: response.document_id,
        chars: response.chars || text.length,
        status: 'uploaded',
        index_status: 'in_progress'
      };
    }
    
    // Обновляем отображение
    if (window.renderKnowledgeTexts) {
      window.renderKnowledgeTexts();
    }
    if (window.updateKnowledgeStats) {
      window.updateKnowledgeStats();
    }
    
    console.log(`✅ Текст добавлен: ${response.document_id}`);
    ui.showNotification(`Текст успешно добавлен!`, 'success');
    
    // Перезагружаем весь список документов после добавления
    setTimeout(() => {
      loadAllKnowledgeBaseDocuments();
    }, 2000);
    
  } catch (error) {
    console.error('❌ Ошибка добавления текста:', error);
    
    // Помечаем как ошибку
    const textIndex = window.knowledgeBase.texts.findIndex(t => t._tempId === tempId);
    if (textIndex !== -1) {
      window.knowledgeBase.texts[textIndex].status = 'error';
      window.knowledgeBase.texts[textIndex].error = error.message;
    }
    
    if (window.renderKnowledgeTexts) {
      window.renderKnowledgeTexts();
    }
    
    ui.showNotification(`Ошибка добавления текста: ${error.message}`, 'error');
  }
}

// ============= ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ DYNAMIC VARIABLES =============

window.updateVariable = function(index, field, value) {
  if (!dynamicVariables[index]) {
    dynamicVariables[index] = {};
  }
  dynamicVariables[index][field] = value;
};

window.removeVariable = function(index) {
  dynamicVariables.splice(index, 1);
  if (window.renderDynamicVariables) {
    window.renderDynamicVariables();
  }
};

// ============= ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ KNOWLEDGE BASE =============

window.removeKnowledgeFile = async function(index) {
  const file = knowledgeBase.files[index];
  if (!file || !file.document_id || file.document_id.startsWith('temp_')) {
    knowledgeBase.files.splice(index, 1);
    updateKnowledgeBase();
    if (window.renderKnowledgeFiles) {
      window.renderKnowledgeFiles();
    }
    return;
  }
  
  if (!confirm(`Удалить файл "${file.name}" из базы знаний?`)) {
    return;
  }
  
  try {
    await api.delete(`/knowledge-base/${file.document_id}`);
    knowledgeBase.files.splice(index, 1);
    updateKnowledgeBase();
    if (window.renderKnowledgeFiles) {
      window.renderKnowledgeFiles();
    }
    ui.showNotification('Файл удален из базы знаний', 'success');
    
    // Перезагружаем список после удаления
    setTimeout(() => {
      loadAllKnowledgeBaseDocuments();
    }, 1000);
  } catch (error) {
    ui.showNotification(`Ошибка удаления файла: ${error.message}`, 'error');
  }
};

window.removeKnowledgeUrl = async function(index) {
  const url = knowledgeBase.urls[index];
  if (!url || !url.document_id || url.document_id.startsWith('temp_')) {
    knowledgeBase.urls.splice(index, 1);
    updateKnowledgeBase();
    if (window.renderKnowledgeUrls) {
      window.renderKnowledgeUrls();
    }
    return;
  }
  
  if (!confirm(`Удалить URL "${url.url}" из базы знаний?`)) {
    return;
  }
  
  try {
    await api.delete(`/knowledge-base/${url.document_id}`);
    knowledgeBase.urls.splice(index, 1);
    updateKnowledgeBase();
    if (window.renderKnowledgeUrls) {
      window.renderKnowledgeUrls();
    }
    ui.showNotification('URL удален из базы знаний', 'success');
    
    // Перезагружаем список после удаления
    setTimeout(() => {
      loadAllKnowledgeBaseDocuments();
    }, 1000);
  } catch (error) {
    ui.showNotification(`Ошибка удаления URL: ${error.message}`, 'error');
  }
};

window.removeKnowledgeText = async function(index) {
  const text = knowledgeBase.texts[index];
  if (!text || !text.document_id || text.document_id.startsWith('temp_')) {
    knowledgeBase.texts.splice(index, 1);
    updateKnowledgeBase();
    if (window.renderKnowledgeTexts) {
      window.renderKnowledgeTexts();
    }
    return;
  }
  
  if (!confirm(`Удалить текст "${text.title}" из базы знаний?`)) {
    return;
  }
  
  try {
    await api.delete(`/knowledge-base/${text.document_id}`);
    knowledgeBase.texts.splice(index, 1);
    updateKnowledgeBase();
    if (window.renderKnowledgeTexts) {
      window.renderKnowledgeTexts();
    }
    ui.showNotification('Текст удален из базы знаний', 'success');
    
    // Перезагружаем список после удаления
    setTimeout(() => {
      loadAllKnowledgeBaseDocuments();
    }, 1000);
  } catch (error) {
    ui.showNotification(`Ошибка удаления текста: ${error.message}`, 'error');
  }
};

function updateKnowledgeBase() {
  knowledgeBase.totalSize = knowledgeBase.files.reduce((sum, file) => sum + (file.size || 0), 0);
  knowledgeBase.totalChars = [...knowledgeBase.files, ...knowledgeBase.urls, ...knowledgeBase.texts]
    .reduce((sum, item) => sum + (item.chars || 0), 0);
}

// ============= ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ SERVER TOOLS =============

window.updateServerTool = function(index, field, value) {
  if (!serverTools[index]) {
    serverTools[index] = {};
  }
  serverTools[index][field] = value;
};

window.removeServerTool = function(index) {
  serverTools.splice(index, 1);
  if (window.renderServerTools) {
    window.renderServerTools();
  }
};

window.testServerTool = function(index) {
  const tool = serverTools[index];
  ui.showNotification(`Тестирование ${tool.name}: отправка запроса на ${tool.url}`, 'info');
  // TODO: реализовать реальное тестирование
};

// ============= ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ CLIENT TOOLS =============

window.updateClientTool = function(index, field, value) {
  if (!clientTools[index]) {
    clientTools[index] = {};
  }
  clientTools[index][field] = value;
};

window.removeClientTool = function(index) {
  clientTools.splice(index, 1);
  if (window.renderClientTools) {
    window.renderClientTools();
  }
};

window.testClientTool = function(index) {
  const tool = clientTools[index];
  ui.showNotification(`Тестирование клиентской функции: ${tool.name}`, 'info');
  // TODO: реализовать реальное тестирование
};

// ============= ЭКСПОРТ В ГЛОБАЛЬНУЮ ОБЛАСТЬ =============

// Экспортируем все необходимые переменные и функции в window для доступа из других файлов
window.api = api;
window.ui = ui;
window.currentAgentId = currentAgentId;
window.currentAgentData = currentAgentData;
window.availableVoices = availableVoices;
window.knowledgeBase = knowledgeBase;
window.dynamicVariables = dynamicVariables;
window.serverTools = serverTools;
window.clientTools = clientTools;
window.systemTools = systemTools;
window.conversationManager = conversationManager;

// Экспортируем основные функции
window.checkApiKey = checkApiKey;
window.saveApiKey = saveApiKey;
window.removeApiKey = removeApiKey;
window.loadVoices = loadVoices;
window.loadAgents = loadAgents;
window.editAgent = editAgent;
window.saveAgent = saveAgent;
window.deleteAgent = deleteAgent;
window.testAgent = testAgent;
window.showEmbedCode = showEmbedCode;
window.switchToTab = switchToTab;
window.generateEmbedCode = generateEmbedCode;
window.updateKnowledgeBase = updateKnowledgeBase;
window.setSelectedVoice = setSelectedVoice;
window.loadAllKnowledgeBaseDocuments = loadAllKnowledgeBaseDocuments;

// ✅ НОВЫЕ функции для Knowledge Base
window.handleFileUpload = handleFileUpload;
window.handleUrlAdd = handleUrlAdd;
window.handleTextAdd = handleTextAdd;

// ✅ ИСПРАВЛЕНИЕ 2: Добавляем диагностику для testing handler
const startTestBtn = document.getElementById('start-test');
if (startTestBtn) {
  startTestBtn.addEventListener('click', async () => {
    console.log('🔍 ДИАГНОСТИКА WebSocket:', {
      currentAgentId: window.currentAgentId,
      localCurrentAgentId: currentAgentId,
      agentIdIsNew: window.currentAgentId === 'new',
      agentIdExists: !!window.currentAgentId
    });
    
    if (!window.currentAgentId || window.currentAgentId === 'new') {
      window.ui.showNotification('Сначала сохраните агента', 'warning');
      return;
    }
    
    window.conversationManager = new window.EnhancedElevenLabsConversationManager();
    const success = await window.conversationManager.startConversation(window.currentAgentId);
    
    if (!success) {
      window.conversationManager = null;
    }
  });
}

// ✅ ИСПРАВЛЕНИЕ 2: Синхронизация при инициализации
window.currentAgentId = currentAgentId;
