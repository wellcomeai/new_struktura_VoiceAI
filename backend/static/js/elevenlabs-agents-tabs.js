// ============= TABS CONTENT RENDERING =============

// ✅ ФУНКЦИИ ДЛЯ KNOWLEDGE BASE

function renderKnowledgeBase() {
  // Загружаем контент таба knowledge base
  const knowledgeTab = document.getElementById('knowledge-tab');
  if (!knowledgeTab) return;
  
  knowledgeTab.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom: 1.5rem; color: var(--text-dark);">
        <i class="fas fa-book" style="color: var(--primary-blue); margin-right: 0.5rem;"></i>
        База знаний агента
      </h3>
      
      <p style="color: var(--text-gray); margin-bottom: 2rem; line-height: 1.6;">
        Загрузите документы, добавьте ссылки на ресурсы или введите текст напрямую. 
        База знаний поможет агенту отвечать на специфические вопросы о вашем продукте или услуге.
        <strong>Все документы автоматически индексируются для RAG.</strong>
      </p>
      
      <div class="knowledge-base-section">
        <h4 style="margin-bottom: 1rem;">📁 Загрузка файлов</h4>
        
        <div class="upload-area" id="file-upload-area">
          <div class="upload-icon">
            <i class="fas fa-cloud-upload-alt"></i>
          </div>
          <p><strong>Перетащите файлы сюда</strong> или <span style="color: var(--primary-blue); cursor: pointer;" id="file-select-text">выберите файлы</span></p>
          <p style="font-size: 0.875rem; color: var(--text-light); margin-top: 0.5rem;">
            Поддерживаются: PDF, TXT, DOCX, MD (до 20MB общий размер)<br>
            <strong>Файлы автоматически индексируются для RAG поиска</strong>
          </p>
          <input type="file" id="file-upload-input" multiple accept=".pdf,.txt,.docx,.md" style="display: none;">
        </div>
        
        <div id="knowledge-files" class="knowledge-files" style="display: none;">
          <h4 style="margin-bottom: 0.5rem;">Загруженные файлы:</h4>
          <div id="knowledge-files-list">
            <!-- Список файлов будет заполнен динамически -->
          </div>
        </div>
      </div>
      
      <div class="knowledge-base-section">
        <h4 style="margin-bottom: 1rem;">🌐 URL-ресурсы</h4>
        
        <div class="form-group">
          <label for="knowledge-url">Добавить URL для парсинга</label>
          <div style="display: flex; gap: 0.5rem;">
            <input type="url" id="knowledge-url" class="form-control" placeholder="https://example.com/docs">
            <button type="button" class="btn btn-primary" id="add-url-btn">
              <i class="fas fa-plus"></i> Добавить
            </button>
          </div>
          <p style="margin-top: 0.5rem; color: var(--text-gray); font-size: 0.875rem;">
            Система автоматически извлечет текстовый контент со страницы и проиндексирует для RAG
          </p>
        </div>
        
        <div id="knowledge-urls" style="display: none;">
          <h4 style="margin-bottom: 0.5rem;">Добавленные URL:</h4>
          <div id="knowledge-urls-list">
            <!-- Список URL будет заполнен динамически -->
          </div>
        </div>
      </div>
      
      <div class="knowledge-base-section">
        <h4 style="margin-bottom: 1rem;">✏️ Прямой ввод текста</h4>
        
        <div class="form-group">
          <label for="knowledge-text">Введите текстовую информацию</label>
          <textarea id="knowledge-text" class="form-control" 
                    placeholder="FAQ, инструкции, каталог продуктов..." 
                    style="min-height: 200px;"></textarea>
          <button type="button" class="btn btn-primary" id="add-text-btn" style="margin-top: 0.5rem;">
            <i class="fas fa-plus"></i> Добавить текст
          </button>
          <p style="margin-top: 0.5rem; color: var(--text-gray); font-size: 0.875rem;">
            <strong>Текст будет автоматически проиндексирован для RAG поиска</strong>
          </p>
        </div>
        
        <div id="knowledge-texts" style="display: none;">
          <h4 style="margin-bottom: 0.5rem;">Добавленные тексты:</h4>
          <div id="knowledge-texts-list">
            <!-- Список текстов будет заполнен динамически -->
          </div>
        </div>
      </div>
      
      <div class="knowledge-stats">
        <div class="stat-item">
          <div class="stat-value" id="kb-files-count">0</div>
          <div class="stat-label">Файлов</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="kb-urls-count">0</div>
          <div class="stat-label">URL</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="kb-texts-count">0</div>
          <div class="stat-label">Текстов</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="kb-size">0 KB</div>
          <div class="stat-label">Размер</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="kb-chars">0</div>
          <div class="stat-label">Символов</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="kb-indexed-count" style="color: var(--success-color);">0</div>
          <div class="stat-label">Проиндексировано</div>
        </div>
      </div>
    </div>
  `;
  
  // ✅ ИСПРАВЛЕНО: Сразу обновляем отображение если есть данные
  if (window.knowledgeBase && (
    window.knowledgeBase.files.length > 0 || 
    window.knowledgeBase.urls.length > 0 || 
    window.knowledgeBase.texts.length > 0
  )) {
    console.log('📚 Отображаем загруженную Knowledge Base:', {
      files: window.knowledgeBase.files.length,
      urls: window.knowledgeBase.urls.length,
      texts: window.knowledgeBase.texts.length
    });
  }
  
  updateKnowledgeStats();
  renderKnowledgeFiles();
  renderKnowledgeUrls();
  renderKnowledgeTexts();
}

// ✅ ИСПРАВЛЕННАЯ функция обновления статистики с учетом индексированных документов
function updateKnowledgeStats() {
  const kbFilesCount = document.getElementById('kb-files-count');
  const kbUrlsCount = document.getElementById('kb-urls-count');
  const kbTextsCount = document.getElementById('kb-texts-count');
  const kbSize = document.getElementById('kb-size');
  const kbChars = document.getElementById('kb-chars');
  const kbIndexedCount = document.getElementById('kb-indexed-count');
  
  if (kbFilesCount) kbFilesCount.textContent = window.knowledgeBase.files.length;
  if (kbUrlsCount) kbUrlsCount.textContent = window.knowledgeBase.urls.length;
  if (kbTextsCount) kbTextsCount.textContent = window.knowledgeBase.texts.length;
  if (kbSize) kbSize.textContent = formatFileSize(window.knowledgeBase.totalSize);
  if (kbChars) kbChars.textContent = window.knowledgeBase.totalChars.toLocaleString();
  
  // Подсчет проиндексированных документов
  if (kbIndexedCount) {
    let indexedCount = 0;
    
    // Считаем файлы
    indexedCount += window.knowledgeBase.files.filter(f => 
      f.document_id && 
      !f.document_id.startsWith('temp_') && 
      (f.index_status === 'ready' || f.index_status === 'completed' || f.status === 'uploaded')
    ).length;
    
    // Считаем URL
    indexedCount += window.knowledgeBase.urls.filter(u => 
      u.document_id && 
      !u.document_id.startsWith('temp_') &&
      (u.index_status === 'ready' || u.index_status === 'completed' || u.status === 'uploaded')
    ).length;
    
    // Считаем тексты
    indexedCount += window.knowledgeBase.texts.filter(t => 
      t.document_id && 
      !t.document_id.startsWith('temp_') &&
      (t.index_status === 'ready' || t.index_status === 'completed' || t.status === 'uploaded')
    ).length;
    
    kbIndexedCount.textContent = indexedCount;
    console.log('📊 Проиндексированных документов:', indexedCount);
  }
}

// ✅ ИСПРАВЛЕННАЯ функция отображения файлов с правильным статусом индексации
function renderKnowledgeFiles() {
  const knowledgeFiles = document.getElementById('knowledge-files');
  const knowledgeFilesList = document.getElementById('knowledge-files-list');
  
  if (!knowledgeFiles || !knowledgeFilesList) return;
  
  if (window.knowledgeBase.files.length === 0) {
    knowledgeFiles.style.display = 'none';
    return;
  }
  
  knowledgeFiles.style.display = 'block';
  knowledgeFilesList.innerHTML = '';
  
  window.knowledgeBase.files.forEach((file, index) => {
    const fileElement = document.createElement('div');
    fileElement.className = `knowledge-file ${file.status || 'uploaded'}`;
    
    // Определяем статус индексации
    let statusIcon = '';
    let statusText = '';
    let statusColor = '';
    
    if (file.status === 'uploading') {
      statusIcon = '<i class="fas fa-spinner fa-spin"></i>';
      statusText = 'Загрузка...';
      statusColor = 'var(--primary-blue)';
    } else if (file.status === 'error') {
      statusIcon = '<i class="fas fa-exclamation-triangle"></i>';
      statusText = '❌ Ошибка';
      statusColor = 'var(--error-color)';
    } else if (file.index_status === 'ready' || file.index_status === 'completed') {
      statusIcon = '<i class="fas fa-check-circle"></i>';
      statusText = '✅ Проиндексирован';
      statusColor = 'var(--success-color)';
    } else if (file.index_status === 'in_progress' || file.index_status === 'processing') {
      statusIcon = '<i class="fas fa-clock"></i>';
      statusText = `🔄 Индексация... ${file.index_progress || 0}%`;
      statusColor = 'var(--warning-color)';
    } else if (file.index_status === 'failed') {
      statusIcon = '<i class="fas fa-times-circle"></i>';
      statusText = '❌ Ошибка индексации';
      statusColor = 'var(--error-color)';
    } else {
      statusIcon = '<i class="fas fa-file"></i>';
      statusText = '📄 Загружен';
      statusColor = 'var(--text-light)';
    }
    
    const isTemporary = file.document_id && file.document_id.startsWith('temp_');
    
    fileElement.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <i class="fas fa-file-${getFileIcon(file.filename || file.name)}"></i>
        </div>
        <div class="file-details">
          <div class="file-name">
            ${file.filename || file.name || 'Без названия'}
            ${file.document_id && !isTemporary ? `
              <div style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">
                ID: <code style="background: var(--bg-light); padding: 0.1rem 0.3rem; border-radius: 0.25rem; user-select: all;">${file.document_id}</code>
              </div>
            ` : ''}
          </div>
          <div class="file-size">${formatFileSize(file.size)} • ${file.chars || 0} символов</div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem;">
            <span style="color: ${statusColor};">${statusIcon}</span>
            <span style="font-size: 0.75rem; color: var(--text-gray);">${statusText}</span>
          </div>
          ${file.error ? `<div style="color: var(--error-color); font-size: 0.75rem; margin-top: 0.25rem;">Ошибка: ${file.error}</div>` : ''}
          ${file.created_at ? `<div style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">Создан: ${new Date(file.created_at * 1000).toLocaleString()}</div>` : ''}
        </div>
      </div>
      <button class="btn btn-mini btn-danger" onclick="removeKnowledgeFile(${index})" ${file.status === 'uploading' ? 'disabled' : ''}>
        <i class="fas fa-trash"></i>
      </button>
    `;
    knowledgeFilesList.appendChild(fileElement);
  });
}

// ✅ ИСПРАВЛЕННАЯ функция отображения URL с правильным статусом индексации
function renderKnowledgeUrls() {
  const knowledgeUrls = document.getElementById('knowledge-urls');
  const knowledgeUrlsList = document.getElementById('knowledge-urls-list');
  
  if (!knowledgeUrls || !knowledgeUrlsList) return;
  
  if (window.knowledgeBase.urls.length === 0) {
    knowledgeUrls.style.display = 'none';
    return;
  }
  
  knowledgeUrls.style.display = 'block';
  knowledgeUrlsList.innerHTML = '';
  
  window.knowledgeBase.urls.forEach((urlData, index) => {
    const urlElement = document.createElement('div');
    urlElement.className = 'knowledge-file';
    
    // Определяем статус индексации
    let statusIcon = '';
    let statusText = '';
    let statusColor = '';
    const isTemporary = urlData.document_id && urlData.document_id.startsWith('temp_');
    
    if (urlData.status === 'uploading') {
      statusIcon = '<i class="fas fa-spinner fa-spin"></i>';
      statusText = 'Загрузка...';
      statusColor = 'var(--primary-blue)';
    } else if (urlData.status === 'error') {
      statusIcon = '<i class="fas fa-exclamation-triangle"></i>';
      statusText = '❌ Ошибка';
      statusColor = 'var(--error-color)';
    } else if (urlData.index_status === 'ready' || urlData.index_status === 'completed') {
      statusIcon = '<i class="fas fa-check-circle"></i>';
      statusText = '✅ Проиндексирован';
      statusColor = 'var(--success-color)';
    } else if (urlData.index_status === 'in_progress' || urlData.index_status === 'processing') {
      statusIcon = '<i class="fas fa-clock"></i>';
      statusText = `🔄 Индексация... ${urlData.index_progress || 0}%`;
      statusColor = 'var(--warning-color)';
    } else if (urlData.index_status === 'failed') {
      statusIcon = '<i class="fas fa-times-circle"></i>';
      statusText = '❌ Ошибка индексации';
      statusColor = 'var(--error-color)';
    } else if (urlData.document_id && !isTemporary) {
      statusIcon = '<i class="fas fa-check"></i>';
      statusText = '🌐 Загружен';
      statusColor = 'var(--primary-blue)';
    } else {
      statusIcon = '<i class="fas fa-globe"></i>';
      statusText = 'Обработка...';
      statusColor = 'var(--text-light)';
    }
    
    urlElement.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <i class="fas fa-globe"></i>
        </div>
        <div class="file-details">
          <div class="file-name">
            <a href="${urlData.url}" target="_blank" style="color: var(--primary-blue); text-decoration: none;">
              ${urlData.title || urlData.name || urlData.url}
            </a>
            ${urlData.document_id && !isTemporary ? `
              <div style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">
                ID: <code style="background: var(--bg-light); padding: 0.1rem 0.3rem; border-radius: 0.25rem; user-select: all;">${urlData.document_id}</code>
              </div>
            ` : ''}
          </div>
          <div class="file-size">${urlData.chars || 0} символов • ${formatFileSize(urlData.size || 0)}</div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem;">
            <span style="color: ${statusColor};">${statusIcon}</span>
            <span style="font-size: 0.75rem; color: var(--text-gray);">${statusText}</span>
          </div>
          ${urlData.error ? `<div style="color: var(--error-color); font-size: 0.75rem; margin-top: 0.25rem;">Ошибка: ${urlData.error}</div>` : ''}
          ${urlData.created_at ? `<div style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">Создан: ${new Date(urlData.created_at * 1000).toLocaleString()}</div>` : ''}
        </div>
      </div>
      <button class="btn btn-mini btn-danger" onclick="removeKnowledgeUrl(${index})" ${urlData.status === 'uploading' ? 'disabled' : ''}>
        <i class="fas fa-trash"></i>
      </button>
    `;
    knowledgeUrlsList.appendChild(urlElement);
  });
}

// ✅ ИСПРАВЛЕННАЯ функция отображения текстов с правильным статусом индексации
function renderKnowledgeTexts() {
  const knowledgeTexts = document.getElementById('knowledge-texts');
  const knowledgeTextsList = document.getElementById('knowledge-texts-list');
  
  if (!knowledgeTexts || !knowledgeTextsList) return;
  
  if (window.knowledgeBase.texts.length === 0) {
    knowledgeTexts.style.display = 'none';
    return;
  }
  
  knowledgeTexts.style.display = 'block';
  knowledgeTextsList.innerHTML = '';
  
  window.knowledgeBase.texts.forEach((textData, index) => {
    const textElement = document.createElement('div');
    textElement.className = 'knowledge-file';
    
    // Определяем статус индексации
    let statusIcon = '';
    let statusText = '';
    let statusColor = '';
    const isTemporary = textData.document_id && textData.document_id.startsWith('temp_');
    
    if (textData.status === 'uploading') {
      statusIcon = '<i class="fas fa-spinner fa-spin"></i>';
      statusText = 'Загрузка...';
      statusColor = 'var(--primary-blue)';
    } else if (textData.status === 'error') {
      statusIcon = '<i class="fas fa-exclamation-triangle"></i>';
      statusText = '❌ Ошибка';
      statusColor = 'var(--error-color)';
    } else if (textData.index_status === 'ready' || textData.index_status === 'completed') {
      statusIcon = '<i class="fas fa-check-circle"></i>';
      statusText = '✅ Проиндексирован';
      statusColor = 'var(--success-color)';
    } else if (textData.index_status === 'in_progress' || textData.index_status === 'processing') {
      statusIcon = '<i class="fas fa-clock"></i>';
      statusText = `🔄 Индексация... ${textData.index_progress || 0}%`;
      statusColor = 'var(--warning-color)';
    } else if (textData.index_status === 'failed') {
      statusIcon = '<i class="fas fa-times-circle"></i>';
      statusText = '❌ Ошибка индексации';
      statusColor = 'var(--error-color)';
    } else if (textData.document_id && !isTemporary) {
      statusIcon = '<i class="fas fa-check"></i>';
      statusText = '📝 Загружен';
      statusColor = 'var(--primary-blue)';
    } else {
      statusIcon = '<i class="fas fa-file-text"></i>';
      statusText = 'Обработка...';
      statusColor = 'var(--text-light)';
    }
    
    textElement.innerHTML = `
      <div class="file-info">
        <div class="file-icon">
          <i class="fas fa-file-text"></i>
        </div>
        <div class="file-details">
          <div class="file-name">
            ${textData.title || textData.name || `Текст ${index + 1}`}
            ${textData.document_id && !isTemporary ? `
              <div style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">
                ID: <code style="background: var(--bg-light); padding: 0.1rem 0.3rem; border-radius: 0.25rem; user-select: all;">${textData.document_id}</code>
              </div>
            ` : ''}
          </div>
          <div class="file-size">${textData.chars || 0} символов • ${formatFileSize(textData.size || 0)}</div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem;">
            <span style="color: ${statusColor};">${statusIcon}</span>
            <span style="font-size: 0.75rem; color: var(--text-gray);">${statusText}</span>
          </div>
          ${textData.content ? `
            <div style="color: var(--text-gray); font-size: 0.875rem; margin-top: 0.25rem; max-height: 2.4em; overflow: hidden; line-height: 1.2;">
              ${textData.content.substring(0, 100)}${textData.content.length > 100 ? '...' : ''}
            </div>
          ` : ''}
          ${textData.error ? `<div style="color: var(--error-color); font-size: 0.75rem; margin-top: 0.25rem;">Ошибка: ${textData.error}</div>` : ''}
          ${textData.created_at ? `<div style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">Создан: ${new Date(textData.created_at * 1000).toLocaleString()}</div>` : ''}
        </div>
      </div>
      <button class="btn btn-mini btn-danger" onclick="removeKnowledgeText(${index})" ${textData.status === 'uploading' ? 'disabled' : ''}>
        <i class="fas fa-trash"></i>
      </button>
    `;
    knowledgeTextsList.appendChild(textElement);
  });
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  switch (ext) {
    case 'pdf': return 'pdf';
    case 'doc':
    case 'docx': return 'word';
    case 'txt': return 'alt';
    case 'md': return 'markdown';
    default: return 'alt';
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ✅ ФУНКЦИИ ДЛЯ DYNAMIC VARIABLES

function renderDynamicVariables() {
  const personalizationTab = document.getElementById('personalization-tab');
  if (!personalizationTab) return;
  
  personalizationTab.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom: 1.5rem; color: var(--text-dark);">
        <i class="fas fa-user-edit" style="color: var(--primary-blue); margin-right: 0.5rem;"></i>
        Динамические переменные
      </h3>
      
      <p style="color: var(--text-gray); margin-bottom: 2rem; line-height: 1.6;">
        Создайте переменные для персонализации разговоров. Используйте синтаксис {{variable_name}} в системном промпте и первом сообщении.
        <strong>Переменные передаются в ElevenLabs при инициализации разговора.</strong>
      </p>
      
      <div class="variables-section">
        <h4 style="margin-bottom: 1rem;">👤 Пользовательские переменные</h4>
        
        <div id="dynamic-variables-list">
          <!-- Список переменных будет заполнен динамически -->
        </div>
        
        <button type="button" class="btn btn-outline" id="add-variable-btn">
          <i class="fas fa-plus"></i> Добавить переменную
        </button>
        
        <div style="margin-top: 2rem;">
          <h5 style="margin-bottom: 1rem;">💡 Примеры использования:</h5>
          <div style="background-color: var(--bg-light); padding: 1rem; border-radius: var(--radius-md); font-family: monospace; font-size: 0.875rem;">
            <div>Системный промпт: "Ты помощник компании {{company_name}}. Обращайся к пользователю {{user_name}}."</div>
            <div style="margin-top: 0.5rem;">Первое сообщение: "Привет, {{user_name}}! Я помощник {{company_name}}. Чем могу помочь?"</div>
          </div>
        </div>
      </div>
      
      <div class="system-variables-info">
        <h4><i class="fas fa-info-circle"></i> Доступные системные переменные:</h4>
        <ul>
          <li>{{system__agent_id}} - ID агента</li>
          <li>{{system__time_utc}} - Текущее время UTC</li>
          <li>{{system__conversation_id}} - ID разговора</li>
          <li>{{system__caller_id}} - Номер звонящего (только для звонков)</li>
          <li>{{system__call_duration_secs}} - Длительность звонка в секундах</li>
        </ul>
      </div>
    </div>
  `;
  
  renderVariablesList();
}

function renderVariablesList() {
  const dynamicVariablesList = document.getElementById('dynamic-variables-list');
  if (!dynamicVariablesList) return;
  
  dynamicVariablesList.innerHTML = '';
  
  window.dynamicVariables.forEach((variable, index) => {
    addVariableToDOM(variable, index);
  });
  
  if (window.dynamicVariables.length === 0) {
    dynamicVariablesList.innerHTML = `
      <div style="text-align: center; color: var(--text-gray); padding: 2rem;">
        <i class="fas fa-plus-circle" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <p>Нет переменных. Нажмите "Добавить переменную" для создания.</p>
      </div>
    `;
  }
}

function addVariableToDOM(variable, index) {
  const dynamicVariablesList = document.getElementById('dynamic-variables-list');
  if (!dynamicVariablesList) return;
  
  const variableElement = document.createElement('div');
  variableElement.className = 'variable-item';
  variableElement.innerHTML = `
    <div class="variable-name">
      <input type="text" class="form-control" placeholder="имя_переменной" 
             value="${variable.name || ''}" onchange="updateVariable(${index}, 'name', this.value)">
    </div>
    <div class="variable-value">
      <input type="text" class="form-control" placeholder="Значение переменной" 
             value="${variable.value || ''}" onchange="updateVariable(${index}, 'value', this.value)">
    </div>
    <div class="variable-options">
      <button class="btn btn-small btn-danger" onclick="removeVariable(${index})">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;
  dynamicVariablesList.appendChild(variableElement);
}

// ✅ ФУНКЦИИ ДЛЯ TOOLS

function renderTools() {
  const toolsTab = document.getElementById('tools-tab');
  if (!toolsTab) return;
  
  toolsTab.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom: 1.5rem; color: var(--text-dark);">
        <i class="fas fa-tools" style="color: var(--primary-blue); margin-right: 0.5rem;"></i>
        Внешние инструменты
      </h3>
      
      <p style="color: var(--text-gray); margin-bottom: 2rem; line-height: 1.6;">
        Подключите внешние API и сервисы, чтобы агент мог получать данные и выполнять действия.
        <strong>Инструменты интегрируются с ElevenLabs Function Calling.</strong>
      </p>
      
      <div class="tools-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h4>🌐 Серверные инструменты (Webhooks)</h4>
          <button type="button" class="btn btn-primary" id="add-server-tool-btn">
            <i class="fas fa-plus"></i> Добавить webhook
          </button>
        </div>
        
        <div id="server-tools-list">
          <!-- Список серверных инструментов будет заполнен динамически -->
        </div>
      </div>
      
      <div class="tools-section" style="margin-top: 2rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h4>💻 Клиентские инструменты</h4>
          <button type="button" class="btn btn-primary" id="add-client-tool-btn">
            <i class="fas fa-plus"></i> Добавить функцию
          </button>
        </div>
        
        <div id="client-tools-list">
          <!-- Список клиентских инструментов будет заполнен динамически -->
        </div>
        
        <div style="margin-top: 1rem; padding: 1rem; background-color: var(--bg-blue-light); border-radius: var(--radius-md);">
          <h5 style="color: var(--primary-blue); margin-bottom: 0.5rem;">
            <i class="fas fa-info-circle"></i> Примеры клиентских функций:
          </h5>
          <ul style="margin: 0; padding-left: 1.5rem; color: var(--text-gray); font-size: 0.875rem;">
            <li><code>showNotification(message, type)</code> - показать уведомление</li>
            <li><code>navigateTo(url)</code> - перейти на страницу</li>
            <li><code>openModal(content)</code> - открыть модальное окно</li>
            <li><code>updateUI(element, data)</code> - обновить элемент интерфейса</li>
          </ul>
        </div>
      </div>
    </div>
  `;
  
  renderServerTools();
  renderClientTools();
}

function renderServerTools() {
  const serverToolsList = document.getElementById('server-tools-list');
  if (!serverToolsList) return;
  
  serverToolsList.innerHTML = '';
  
  window.serverTools.forEach((tool, index) => {
    addServerToolToDOM(tool, index);
  });
  
  if (window.serverTools.length === 0) {
    serverToolsList.innerHTML = `
      <div style="text-align: center; color: var(--text-gray); padding: 2rem; border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        <i class="fas fa-plus-circle" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <p>Нет серверных инструментов. Добавьте webhook для внешних интеграций.</p>
      </div>
    `;
  }
}

// ✅ ИСПРАВЛЕНА функция addServerToolToDOM
function addServerToolToDOM(tool, index) {
  const serverToolsList = document.getElementById('server-tools-list');
  if (!serverToolsList) return;
  
  const toolElement = document.createElement('div');
  toolElement.className = 'tool-item';
  toolElement.innerHTML = `
    <div class="tool-header">
      <div class="tool-name">${tool.name || 'Новый webhook'}</div>
      <div class="tool-type-badge tool-type-server">Server</div>
    </div>
    
    <div class="tool-config">
      <div class="form-group">
        <label>Название функции</label>
        <input type="text" class="form-control" placeholder="get_weather" 
               value="${tool.name || ''}" onchange="updateServerTool(${index}, 'name', this.value)">
      </div>
      
      <div class="form-group">
        <label>Описание</label>
        <input type="text" class="form-control" placeholder="Получить погоду для города" 
               value="${tool.description || ''}" onchange="updateServerTool(${index}, 'description', this.value)">
      </div>
      
      <div class="form-group">
        <label>URL</label>
        <input type="url" class="form-control" placeholder="https://api.example.com/weather" 
               value="${tool.url || ''}" onchange="updateServerTool(${index}, 'url', this.value)">
      </div>
      
      <div class="form-group">
        <label>Метод</label>
        <select class="form-control method-select" onchange="updateServerTool(${index}, 'method', this.value)">
          <option value="GET" ${tool.method === 'GET' ? 'selected' : ''}>GET</option>
          <option value="POST" ${tool.method === 'POST' ? 'selected' : ''}>POST</option>
          <option value="PUT" ${tool.method === 'PUT' ? 'selected' : ''}>PUT</option>
          <option value="DELETE" ${tool.method === 'DELETE' ? 'selected' : ''}>DELETE</option>
        </select>
      </div>
      
      <div class="tool-config-full">
        <label>Параметры (JSON Schema)</label>
        <textarea class="form-control" placeholder='{"type": "object", "properties": {"city": {"type": "string", "description": "Название города"}}}' 
                  onchange="updateServerTool(${index}, 'parameters', this.value)">${tool.parameters || ''}</textarea>
        <p style="margin-top: 0.5rem; color: var(--text-gray); font-size: 0.875rem;">
          JSON Schema для параметров функции, используемый ElevenLabs Function Calling
        </p>
      </div>
    </div>
    
    <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;">
      <button class="btn btn-small btn-outline" onclick="testServerTool(${index})">
        <i class="fas fa-flask"></i> Тест
      </button>
      <button class="btn btn-small btn-danger" onclick="removeServerTool(${index})">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;
  serverToolsList.appendChild(toolElement);
}

function renderClientTools() {
  const clientToolsList = document.getElementById('client-tools-list');
  if (!clientToolsList) return;
  
  clientToolsList.innerHTML = '';
  
  window.clientTools.forEach((tool, index) => {
    addClientToolToDOM(tool, index);
  });
  
  if (window.clientTools.length === 0) {
    clientToolsList.innerHTML = `
      <div style="text-align: center; color: var(--text-gray); padding: 2rem; border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        <i class="fas fa-plus-circle" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <p>Нет клиентских функций. Добавьте JavaScript функции для взаимодействия с интерфейсом.</p>
      </div>
    `;
  }
}

function addClientToolToDOM(tool, index) {
  const clientToolsList = document.getElementById('client-tools-list');
  if (!clientToolsList) return;
  
  const toolElement = document.createElement('div');
  toolElement.className = 'tool-item';
  toolElement.innerHTML = `
    <div class="tool-header">
      <div class="tool-name">${tool.name || 'Новая функция'}</div>
      <div class="tool-type-badge tool-type-client">Client</div>
    </div>
    
    <div class="tool-config">
      <div class="form-group">
        <label>Название функции</label>
        <input type="text" class="form-control" placeholder="showNotification" 
               value="${tool.name || ''}" onchange="updateClientTool(${index}, 'name', this.value)">
      </div>
      
      <div class="form-group">
        <label>Описание</label>
        <input type="text" class="form-control" placeholder="Показать уведомление пользователю" 
               value="${tool.description || ''}" onchange="updateClientTool(${index}, 'description', this.value)">
      </div>
      
      <div class="tool-config-full">
        <label>Параметры (JSON Schema)</label>
        <textarea class="form-control" placeholder='{"type": "object", "properties": {"message": {"type": "string"}, "type": {"type": "string", "enum": ["info", "success", "warning", "error"]}}}' 
                  onchange="updateClientTool(${index}, 'parameters', this.value)">${tool.parameters || ''}</textarea>
        <p style="margin-top: 0.5rem; color: var(--text-gray); font-size: 0.875rem;">
          JSON Schema для параметров функции, используемый ElevenLabs Function Calling
        </p>
      </div>
      
      <div class="tool-config-full">
        <label>JavaScript код</label>
        <textarea class="form-control" placeholder="function showNotification(message, type) { /* ваш код */ }" 
                  style="min-height: 120px;" onchange="updateClientTool(${index}, 'code', this.value)">${tool.code || ''}</textarea>
      </div>
    </div>
    
    <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;">
      <button class="btn btn-small btn-outline" onclick="testClientTool(${index})">
        <i class="fas fa-flask"></i> Тест
      </button>
      <button class="btn btn-small btn-danger" onclick="removeClientTool(${index})">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;
  clientToolsList.appendChild(toolElement);
}

// ✅ ФУНКЦИИ ДЛЯ SYSTEM TOOLS

function renderSystemTools() {
  const systemToolsTab = document.getElementById('system-tools-tab');
  if (!systemToolsTab) return;
  
  systemToolsTab.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom: 1.5rem; color: var(--text-dark);">
        <i class="fas fa-cogs" style="color: var(--primary-blue); margin-right: 0.5rem;"></i>
        Системные инструменты
      </h3>
      
      <p style="color: var(--text-gray); margin-bottom: 2rem; line-height: 1.6;">
        Настройте автоматическое управление разговором: завершение звонков, передача агентам, передача операторам.
        <strong>Инструменты встроены в ElevenLabs платформу.</strong>
      </p>
      
      <div class="system-tools-grid">
        <!-- Автозавершение звонков -->
        <div class="system-tool-card" id="end-call-tool">
          <div class="system-tool-header">
            <div class="system-tool-icon">🔚</div>
            <div>
              <div class="system-tool-title">Автозавершение звонков</div>
              <label style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                <input type="checkbox" id="enable-end-call">
                <span>Включить</span>
              </label>
            </div>
          </div>
          <div class="system-tool-description">
            Агент автоматически завершит разговор, когда задача выполнена или пользователь хочет закончить беседу.
          </div>
          <div class="system-tool-config" id="end-call-config" style="display: none;">
            <div class="form-group">
              <label>Ключевые фразы для завершения:</label>
              <textarea class="form-control" id="end-call-phrases" 
                        placeholder="до свидания, спасибо за помощь, всё понятно"
                        style="min-height: 80px;"></textarea>
            </div>
          </div>
        </div>
        
        <!-- Передача между агентами -->
        <div class="system-tool-card" id="agent-transfer-tool">
          <div class="system-tool-header">
            <div class="system-tool-icon">🔄</div>
            <div>
              <div class="system-tool-title">Передача между агентами</div>
              <label style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                <input type="checkbox" id="enable-agent-transfer">
                <span>Включить</span>
              </label>
            </div>
          </div>
          <div class="system-tool-description">
            Передача разговора специализированным агентам в зависимости от темы или потребностей пользователя.
          </div>
          <div class="system-tool-config" id="agent-transfer-config" style="display: none;">
            <div class="form-group">
              <label>Доступные агенты для передачи:</label>
              <div id="transfer-agents-list">
                <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem;">
                  <input type="text" class="form-control" placeholder="ID агента" style="flex: 1;">
                  <input type="text" class="form-control" placeholder="Название" style="flex: 2;">
                  <button type="button" class="btn btn-small btn-danger">
                    <i class="fas fa-trash"></i>
                  </button>
                </div>
              </div>
              <button type="button" class="btn btn-small btn-outline" id="add-transfer-agent">
                <i class="fas fa-plus"></i> Добавить агента
              </button>
            </div>
          </div>
        </div>
        
        <!-- Передача оператору -->
        <div class="system-tool-card" id="human-handoff-tool">
          <div class="system-tool-header">
            <div class="system-tool-icon">👤</div>
            <div>
              <div class="system-tool-title">Передача оператору</div>
              <label style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                <input type="checkbox" id="enable-human-handoff">
                <span>Включить</span>
              </label>
            </div>
          </div>
          <div class="system-tool-description">
            Передача разговора человеку-оператору при сложных вопросах или по запросу пользователя.
          </div>
          <div class="system-tool-config" id="human-handoff-config" style="display: none;">
            <div class="form-group">
              <label>Номер для передачи:</label>
              <input type="tel" class="form-control" id="handoff-phone" placeholder="+1234567890">
            </div>
            <div class="form-group">
              <label>Сообщение для оператора:</label>
              <textarea class="form-control" id="handoff-operator-message" 
                        placeholder="Переданный клиент из AI агента..."
                        style="min-height: 80px;"></textarea>
            </div>
            <div class="form-group">
              <label>Сообщение для клиента:</label>
              <textarea class="form-control" id="handoff-customer-message" 
                        placeholder="Передаю вас нашему специалисту..."
                        style="min-height: 80px;"></textarea>
            </div>
          </div>
        </div>
        
        <!-- Автоопределение языка -->
        <div class="system-tool-card" id="language-detection-tool">
          <div class="system-tool-header">
            <div class="system-tool-icon">🌐</div>
            <div>
              <div class="system-tool-title">Автоопределение языка</div>
              <label style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                <input type="checkbox" id="enable-language-detection">
                <span>Включить</span>
              </label>
            </div>
          </div>
          <div class="system-tool-description">
            Автоматическое переключение языка агента в зависимости от языка пользователя.
          </div>
          <div class="system-tool-config" id="language-detection-config" style="display: none;">
            <div class="form-group">
              <label>Поддерживаемые языки:</label>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.5rem;">
                <label><input type="checkbox" value="en"> 🇺🇸 English</label>
                <label><input type="checkbox" value="ru"> 🇷🇺 Русский</label>
                <label><input type="checkbox" value="es"> 🇪🇸 Español</label>
                <label><input type="checkbox" value="fr"> 🇫🇷 Français</label>
                <label><input type="checkbox" value="de"> 🇩🇪 Deutsch</label>
                <label><input type="checkbox" value="it"> 🇮🇹 Italiano</label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  updateSystemToolsState();
}

function updateSystemToolsState() {
  const enableEndCall = document.getElementById('enable-end-call');
  const enableAgentTransfer = document.getElementById('enable-agent-transfer');
  const enableHumanHandoff = document.getElementById('enable-human-handoff');
  const enableLanguageDetection = document.getElementById('enable-language-detection');
  
  if (enableEndCall) enableEndCall.checked = window.systemTools.endCall;
  if (enableAgentTransfer) enableAgentTransfer.checked = window.systemTools.agentTransfer;
  if (enableHumanHandoff) enableHumanHandoff.checked = window.systemTools.humanHandoff;
  if (enableLanguageDetection) enableLanguageDetection.checked = window.systemTools.languageDetection;
  
  toggleSystemToolConfig('end-call', window.systemTools.endCall);
  toggleSystemToolConfig('agent-transfer', window.systemTools.agentTransfer);
  toggleSystemToolConfig('human-handoff', window.systemTools.humanHandoff);
  toggleSystemToolConfig('language-detection', window.systemTools.languageDetection);
}

function toggleSystemToolConfig(toolName, enabled) {
  const configElement = document.getElementById(`${toolName}-config`);
  const cardElement = document.getElementById(`${toolName}-tool`);
  
  if (configElement) {
    configElement.style.display = enabled ? 'block' : 'none';
  }
  
  if (cardElement) {
    if (enabled) {
      cardElement.classList.add('enabled');
    } else {
      cardElement.classList.remove('enabled');
    }
  }
}

// ✅ ФУНКЦИИ ДЛЯ TESTING

function renderTesting() {
  const testingTab = document.getElementById('testing-tab');
  if (!testingTab) return;
  
  testingTab.innerHTML = `
    <div class="card testing-section">
      <h3 style="margin-bottom: 1rem;">🎯 Тестирование с диагностикой проблем</h3>
      <p style="color: var(--text-gray); margin-bottom: 2rem;">
        Исправленная версия с локальным VAD и диагностикой ElevenLabs соединения.
        <strong>База знаний и инструменты работают через API.</strong>
      </p>
      
      <!-- СТАТУС СОЕДИНЕНИЯ -->
      <div class="testing-status">
        <div class="status-item" id="connection-status">
          <div class="status-indicator disconnected"></div>
          <span>WebSocket: Отключен</span>
        </div>
        <div class="status-item" id="agent-status">
          <div class="status-indicator disconnected"></div>
          <span>Агент: Готов</span>
        </div>
        <div class="status-item" id="microphone-status">
          <i class="fas fa-microphone"></i>
          <span>Микрофон: Готов</span>
        </div>
        <div class="status-item" id="voice-status">
          <i class="fas fa-volume-up"></i>
          <span>Голос: <span id="selected-voice-name">-</span></span>
        </div>
      </div>
      
      <!-- ✅ УЛУЧШЕННЫЕ АУДИО ИНДИКАТОРЫ -->
      <div class="audio-indicators" id="audio-indicators" style="display: none;">
        <div class="audio-indicator">
          <span style="font-weight: 500;">Серверный VAD</span>
          <div class="volume-bar-container">
            <div class="volume-bar" id="server-vad-bar"></div>
          </div>
          <span id="server-vad-score">0.00</span>
        </div>
        <div class="audio-indicator">
          <span style="font-weight: 500;">Локальный VAD</span>
          <div class="volume-bar-container">
            <div class="volume-bar" id="local-vad-bar"></div>
          </div>
          <span id="local-vad-score">0.00</span>
        </div>
        <div class="audio-indicator">
          <span style="font-weight: 500;">Уровень входа</span>
          <div class="volume-bar-container">
            <div class="volume-bar" id="input-volume-bar"></div>
          </div>
          <span id="input-volume">0%</span>
        </div>
        <div class="user-speaking-indicator" id="user-speaking-indicator">
          <i class="fas fa-microphone"></i>
          <span id="user-speaking-text">Молчание</span>
        </div>
      </div>
      
      <!-- ✅ ДИАГНОСТИЧЕСКАЯ ПАНЕЛЬ -->
      <div id="diagnostic-panel" class="diagnostic-panel" style="display: none;">
        <h4><i class="fas fa-exclamation-triangle"></i> Диагностика проблем</h4>
        <div id="diagnostic-items">
          <!-- Диагностические сообщения будут добавляться сюда -->
        </div>
      </div>
      
      <!-- КНОПКИ УПРАВЛЕНИЯ -->
      <div id="testing-controls">
        <button class="btn btn-primary" id="start-test-btn">
          <i class="fas fa-play"></i> Начать тестирование
        </button>
        <button class="btn btn-outline" id="stop-test-btn" style="display: none;">
          <i class="fas fa-stop"></i> Остановить
        </button>
        <button class="btn btn-secondary" id="retry-connection-btn" style="display: none;">
          <i class="fas fa-redo"></i> Повторить подключение
        </button>
        <button class="btn btn-warning" id="test-microphone-btn">
          <i class="fas fa-microphone-alt"></i> Проверить микрофон
        </button>
      </div>
      
      <!-- МЕТРИКИ ПРОИЗВОДИТЕЛЬНОСТИ -->
      <div id="performance-metrics" class="performance-metrics" style="display: none;">
        <h4><i class="fas fa-chart-line"></i> Метрики производительности</h4>
        <div class="metrics-grid">
          <div class="metric-item">
            <div class="metric-label">Время подключения</div>
            <div class="metric-value" id="connection-time">0с</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Прерываний</div>
            <div class="metric-value" id="interruptions-count">0</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Аудио чанков</div>
            <div class="metric-value" id="audio-chunks-count">0</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">RTT</div>
            <div class="metric-value" id="rtt-value">0мс</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Время сессии</div>
            <div class="metric-value" id="session-duration">0с</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">VAD события</div>
            <div class="metric-value" id="vad-events-count">0</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Транскрипции</div>
            <div class="metric-value" id="transcript-events-count">0</div>
          </div>
          <div class="metric-item">
            <div class="metric-label">Качество буфера</div>
            <div class="metric-value" id="buffer-health">100%</div>
          </div>
        </div>
      </div>
      
      <div style="margin-top: 2rem; color: var(--text-gray); font-size: 0.875rem;">
        <p><i class="fas fa-info-circle"></i> <strong>Реальная интеграция с ElevenLabs API:</strong></p>
        <ul style="margin: 0.5rem 0 0 1.5rem; line-height: 1.6;">
          <li>✅ База знаний автоматически индексируется для RAG поиска</li>
          <li>✅ Динамические переменные передаются при инициализации</li>
          <li>✅ Внешние API интегрированы через Function Calling</li>
          <li>✅ Системные инструменты встроены в платформу</li>
          <li>✅ Локальный VAD для визуализации активности</li>
          <li>✅ Диагностика проблем с соединением</li>
        </ul>
      </div>
    </div>
  `;
}

// ✅ ФУНКЦИИ ДЛЯ EMBED

function renderEmbed() {
  const embedTab = document.getElementById('embed-tab');
  if (!embedTab) return;
  
  embedTab.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom: 1rem;">Код для встраивания</h3>
      <p>Скопируйте этот код и вставьте его на свой сайт, чтобы добавить голосового ассистента с полной функциональностью.</p>
      
      <div class="embed-container">
        <div class="embed-code" id="embed-code">
          <!-- Код будет загружен динамически -->
        </div>
        <div style="display: flex; justify-content: flex-end; margin-top: 1rem;">
          <button class="btn btn-primary" id="copy-embed-code">
            <i class="fas fa-copy"></i> Копировать код
          </button>
        </div>
      </div>
      
      <div style="margin-top: 1.5rem; padding: 1rem; background-color: var(--bg-blue-light); border-radius: var(--radius-md);">
        <h5 style="color: var(--primary-blue); margin-bottom: 0.5rem;">
          <i class="fas fa-info-circle"></i> Что включено в виджет:
        </h5>
        <ul style="margin: 0; padding-left: 1.5rem; color: var(--text-gray); font-size: 0.875rem;">
          <li>📚 База знаний для контекстных ответов</li>
          <li>🎛️ Динамические переменные для персонализации</li>
          <li>🔧 Интеграция с внешними API</li>
          <li>🤖 Системные инструменты управления</li>
          <li>🎵 Настроенный голос и поведение</li>
        </ul>
      </div>
    </div>
    
    <div class="card">
      <h3 style="margin-bottom: 1rem;">Предпросмотр</h3>
      <p>Так будет выглядеть ваш ассистент на сайте:</p>
      
      <div style="margin-top: 1.5rem; text-align: center;">
        <div style="display: inline-block; position: relative;">
          <div style="width: 400px; height: 300px; background-color: #f3f4f6; border: 1px dashed #d1d5db; border-radius: 0.5rem; display: flex; justify-content: center; align-items: center;">
            <div style="position: absolute; bottom: 20px; right: 20px; width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); display: flex; justify-content: center; align-items: center; color: white; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);">
              <i class="fas fa-microphone" style="font-size: 1.5rem;"></i>
            </div>
          </div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: var(--text-gray);">Пример вашего сайта с виджетом голосового ассистента</div>
        </div>
      </div>
    </div>
  `;
}

// ============= ЭКСПОРТ ФУНКЦИЙ =============

// Экспортируем функции в глобальную область видимости
window.renderKnowledgeBase = renderKnowledgeBase;
window.updateKnowledgeStats = updateKnowledgeStats;
window.renderKnowledgeFiles = renderKnowledgeFiles;
window.renderKnowledgeUrls = renderKnowledgeUrls;
window.renderKnowledgeTexts = renderKnowledgeTexts;
window.formatFileSize = formatFileSize;
window.getFileIcon = getFileIcon;

window.renderDynamicVariables = renderDynamicVariables;
window.renderVariablesList = renderVariablesList;
window.addVariableToDOM = addVariableToDOM;

window.renderTools = renderTools;
window.renderServerTools = renderServerTools;
window.renderClientTools = renderClientTools;
window.addServerToolToDOM = addServerToolToDOM;
window.addClientToolToDOM = addClientToolToDOM;

window.renderSystemTools = renderSystemTools;
window.updateSystemToolsState = updateSystemToolsState;
window.toggleSystemToolConfig = toggleSystemToolConfig;

window.renderTesting = renderTesting;
window.renderEmbed = renderEmbed;
