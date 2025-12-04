// backend/static/js/crm-contact.js
/**
 * Contact Detail Page для Voicyfy CRM
 * Детальный просмотр контакта с историей диалогов, заметками и задачами
 * Version: 3.7 - PRODUCTION READY with Call Direction Support
 * ✅ OpenAI + Gemini assistants support
 * ✅ Tasks with auto-calls
 * ✅ Notes feed
 * ✅ Conversations history
 * ✅ v3.6: Custom greeting support
 * ✅ v3.7: Call direction indicators (INBOUND/OUTBOUND)
 */

document.addEventListener('DOMContentLoaded', function() {
  // ==================== Элементы ====================
  const contactAvatar = document.getElementById('contact-avatar');
  const nameInput = document.getElementById('name-input');
  const saveNameBtn = document.getElementById('save-name-btn');
  const contactPhone = document.getElementById('contact-phone');
  const statusDropdown = document.getElementById('status-dropdown');
  
  // Notes
  const notesFeed = document.getElementById('notes-feed');
  const notesCount = document.getElementById('notes-count');
  const noteInput = document.getElementById('note-input');
  const addNoteBtn = document.getElementById('add-note-btn');
  
  // Tabs
  const tabBtns = document.querySelectorAll('.tab-btn');
  const conversationsTab = document.getElementById('conversations-tab');
  const tasksTab = document.getElementById('tasks-tab');
  
  // Conversations
  const conversationsAccordion = document.getElementById('conversations-accordion');
  const conversationsCount = document.getElementById('conversations-count');
  
  // Tasks
  const tasksList = document.getElementById('tasks-list');
  const tasksCount = document.getElementById('tasks-count');
  const createTaskBtn = document.getElementById('create-task-btn');
  const taskModal = document.getElementById('task-modal');
  const taskForm = document.getElementById('task-form');
  const taskAssistantSelect = document.getElementById('task-assistant');
  const taskDatetimeInput = document.getElementById('task-datetime');
  const taskTitleInput = document.getElementById('task-title');
  const taskDescriptionInput = document.getElementById('task-description');
  const taskCustomGreetingInput = document.getElementById('task-custom-greeting'); // ✅ v3.6
  const cancelTaskBtn = document.getElementById('cancel-task-btn');
  
  // Delete
  const deleteContactBtn = document.getElementById('delete-contact-btn');
  const deleteModal = document.getElementById('delete-modal');
  const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
  const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
  const deleteConversationsCount = document.getElementById('delete-conversations-count');
  
  // Notification
  const notification = document.getElementById('notification');
  const notificationMessage = document.getElementById('notification-message');
  const notificationClose = document.getElementById('notification-close');
  const loadingOverlay = document.getElementById('loading-overlay');
  
  // ==================== Состояние ====================
  let currentContact = null;
  let contactId = null;
  let notes = [];
  let tasks = [];
  let assistants = [];
  
  // ==================== API ====================
  const api = {
    baseUrl: '/api',
    
    getToken() {
      return localStorage.getItem('auth_token');
    },
    
    isAuthenticated() {
      return this.getToken() !== null;
    },
    
    async fetch(endpoint, options = {}) {
      if (this.isAuthenticated()) {
        options.headers = {
          ...options.headers,
          'Authorization': `Bearer ${this.getToken()}`
        };
      }
      
      if (options.body && typeof options.body !== 'string') {
        options.headers = {
          ...options.headers,
          'Content-Type': 'application/json'
        };
        options.body = JSON.stringify(options.body);
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
    },
    
    get(endpoint) {
      return this.fetch(endpoint, { method: 'GET' });
    },
    
    post(endpoint, body) {
      return this.fetch(endpoint, { method: 'POST', body });
    },
    
    put(endpoint, body) {
      return this.fetch(endpoint, { method: 'PUT', body });
    },
    
    patch(endpoint, body) {
      return this.fetch(endpoint, { method: 'PATCH', body });
    },
    
    delete(endpoint) {
      return this.fetch(endpoint, { method: 'DELETE' });
    }
  };
  
  // ==================== UI Functions ====================
  function setLoading(loading) {
    if (loading) {
      loadingOverlay.classList.add('show');
    } else {
      loadingOverlay.classList.remove('show');
    }
  }
  
  function showNotification(message, type = 'success') {
    notification.classList.remove('notification-success', 'notification-error');
    notification.classList.add(`notification-${type}`);
    
    const iconElement = notification.querySelector('.notification-icon i');
    iconElement.className = type === 'success' ? 'fas fa-check-circle' : 'fas fa-exclamation-circle';
    
    notificationMessage.textContent = message;
    notification.classList.add('show');
    
    setTimeout(() => {
      hideNotification();
    }, 5000);
  }
  
  function hideNotification() {
    notification.classList.remove('show');
  }
  
  function formatDate(dateString) {
    if (!dateString) return 'Нет данных';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) {
      return 'Сегодня ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Вчера ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (days < 7) {
      return days + ' дн. назад';
    } else {
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  }
  
  function formatDateTime(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    if (date.toDateString() === now.toDateString()) {
      return 'Сегодня ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return 'Завтра ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleString('ru-RU', { 
        day: '2-digit', 
        month: 'long',
        hour: '2-digit', 
        minute: '2-digit' 
      });
    }
  }
  
  function formatPhoneNumber(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('7') && cleaned.length === 11) {
      return `+7 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7, 9)}-${cleaned.slice(9)}`;
    }
    return phone;
  }
  
  function getInitials(name, phone) {
    if (name) {
      const words = name.trim().split(' ');
      if (words.length >= 2) {
        return words[0][0].toUpperCase() + words[1][0].toUpperCase();
      }
      return name.substring(0, 2).toUpperCase();
    }
    if (phone) {
      const cleaned = phone.replace(/\D/g, '');
      return cleaned.slice(-2);
    }
    return '??';
  }
  
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  // ==================== Tabs ====================
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      
      // Update buttons
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Update content
      conversationsTab.classList.remove('active');
      tasksTab.classList.remove('active');
      
      if (tabName === 'conversations') {
        conversationsTab.classList.add('active');
      } else if (tabName === 'tasks') {
        tasksTab.classList.add('active');
        // Load tasks when tab is opened
        if (tasks.length === 0) {
          loadTasks();
        }
      }
    });
  });
  
  // ==================== Load Contact ====================
  async function loadContact() {
    try {
      setLoading(true);
      
      const contact = await api.get(`/contacts/${contactId}?include_conversations=true`);
      currentContact = contact;
      
      // Update left panel
      const initials = getInitials(contact.name, contact.phone);
      contactAvatar.textContent = initials;
      nameInput.value = contact.name || '';
      nameInput.placeholder = contact.name ? 'Введите имя контакта...' : 'Без имени';
      contactPhone.textContent = formatPhoneNumber(contact.phone);
      statusDropdown.value = contact.status || 'new';
      
      // Update conversations count
      const totalConversations = contact.stats?.total_conversations || 0;
      conversationsCount.textContent = totalConversations;
      deleteConversationsCount.textContent = totalConversations;
      
      // Load notes
      await loadNotes();
      
      // Render conversations
      renderConversations(contact.conversations || []);
      
      // Load assistants (for task creation)
      await loadAssistants();
      
      // Load tasks
      await loadTasks();
      
    } catch (error) {
      console.error('Error loading contact:', error);
      showNotification(error.message || 'Ошибка загрузки контакта', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Load Notes ====================
  async function loadNotes() {
    try {
      const data = await api.get(`/contacts/${contactId}/notes`);
      notes = data.notes || [];
      renderNotes();
    } catch (error) {
      console.error('Error loading notes:', error);
      showNotification('Ошибка загрузки заметок', 'error');
    }
  }
  
  // ==================== Render Notes ====================
  function renderNotes() {
    notesCount.textContent = notes.length;
    
    if (notes.length === 0) {
      notesFeed.innerHTML = `
        <div class="notes-empty">
          <i class="fas fa-sticky-note"></i>
          <p>Нет заметок</p>
        </div>
      `;
      return;
    }
    
    notesFeed.innerHTML = '';
    
    notes.forEach(note => {
      const noteCard = document.createElement('div');
      noteCard.className = 'note-card';
      noteCard.dataset.noteId = note.id;
      
      noteCard.innerHTML = `
        <div class="note-card-header">
          <span class="note-date">${formatDate(note.created_at)}</span>
          <button class="note-delete-btn" data-note-id="${note.id}" title="Удалить заметку">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
        <div class="note-text">${escapeHtml(note.note_text)}</div>
      `;
      
      notesFeed.appendChild(noteCard);
      
      // Add delete listener
      const deleteBtn = noteCard.querySelector('.note-delete-btn');
      deleteBtn.addEventListener('click', () => deleteNote(note.id));
    });
  }
  
  // ==================== Add Note ====================
  async function addNote() {
    try {
      const noteText = noteInput.value.trim();
      
      if (!noteText) {
        showNotification('Введите текст заметки', 'error');
        return;
      }
      
      setLoading(true);
      
      await api.post(`/contacts/${contactId}/notes`, {
        note_text: noteText
      });
      
      // Clear input
      noteInput.value = '';
      
      // Reload notes
      await loadNotes();
      
      showNotification('Заметка добавлена', 'success');
      
    } catch (error) {
      console.error('Error adding note:', error);
      showNotification(error.message || 'Ошибка добавления заметки', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Delete Note ====================
  async function deleteNote(noteId) {
    try {
      if (!confirm('Удалить эту заметку?')) {
        return;
      }
      
      setLoading(true);
      
      await api.delete(`/contacts/notes/${noteId}`);
      
      // Reload notes
      await loadNotes();
      
      showNotification('Заметка удалена', 'success');
      
    } catch (error) {
      console.error('Error deleting note:', error);
      showNotification(error.message || 'Ошибка удаления заметки', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Render Conversations (✅ v3.7: Call Direction Support) ====================
  function renderConversations(conversations) {
    conversationsAccordion.innerHTML = '';
    
    if (conversations.length === 0) {
      conversationsAccordion.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-comments"></i>
          <p>Пока нет диалогов с этим контактом</p>
        </div>
      `;
      return;
    }
    
    conversations.forEach((conv, index) => {
      const item = document.createElement('div');
      item.className = 'conversation-item';
      item.dataset.sessionId = conv.session_id;
      
      const createdDate = formatDate(conv.created_at);
      const messagesCount = conv.messages_count || 0;
      const duration = conv.total_duration ? `${Math.floor(conv.total_duration / 60)} мин` : '';
      const tokens = conv.total_tokens || 0;
      
      // ✅ v3.7: Определяем иконку и метку по направлению звонка
      let callIcon = '💬';  // По умолчанию диалог
      let callLabel = 'Диалог';
      
      if (conv.call_direction === 'INBOUND') {
        callIcon = '📞';
        callLabel = 'Входящий';
      } else if (conv.call_direction === 'OUTBOUND') {
        callIcon = '📱';
        callLabel = 'Исходящий';
      }
      
      item.innerHTML = `
        <div class="conversation-header">
          <div class="conversation-info">
            <div class="conversation-date">
              ${callIcon} ${callLabel} • ${createdDate}
            </div>
            <div class="conversation-meta">
              <span><i class="fas fa-robot"></i> ${conv.assistant_name || 'Неизвестный'}</span>
              <span><i class="fas fa-comments"></i> ${messagesCount} сообщений</span>
              ${duration ? `<span><i class="fas fa-clock"></i> ${duration}</span>` : ''}
              <span><i class="fas fa-brain"></i> ${tokens} токенов</span>
            </div>
          </div>
          <div class="conversation-toggle">
            <i class="fas fa-chevron-down"></i>
          </div>
        </div>
        <div class="conversation-body">
          <div class="conversation-messages" id="messages-${index}">
            <div style="text-align: center; padding: 2rem; color: var(--text-gray);">
              <i class="fas fa-spinner fa-spin"></i> Загрузка сообщений...
            </div>
          </div>
        </div>
      `;
      
      conversationsAccordion.appendChild(item);
      
      // Accordion toggle
      const header = item.querySelector('.conversation-header');
      header.addEventListener('click', () => toggleConversation(item, conv.session_id, index));
    });
  }
  
  // ==================== Toggle Conversation ====================
  async function toggleConversation(item, sessionId, index) {
    const isExpanded = item.classList.contains('expanded');
    
    // Close all other conversations
    document.querySelectorAll('.conversation-item').forEach(el => {
      el.classList.remove('expanded');
    });
    
    if (!isExpanded) {
      item.classList.add('expanded');
      
      // Load messages if not loaded yet
      const messagesContainer = document.getElementById(`messages-${index}`);
      if (messagesContainer.querySelector('.fa-spinner')) {
        await loadConversationMessages(sessionId, messagesContainer);
      }
    }
  }
  
  // ==================== Load Conversation Messages ====================
  async function loadConversationMessages(sessionId, container) {
    try {
      const data = await api.get(`/conversations/${sessionId}?include_functions=false`);
      
      if (!data.messages || data.messages.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 2rem; color: var(--text-gray);">
            <i class="fas fa-comment-slash"></i>
            <p>Нет сообщений</p>
          </div>
        `;
        return;
      }
      
      container.innerHTML = '';
      
      data.messages.forEach(msg => {
        const messageDiv = document.createElement('div');
        messageDiv.className = msg.type === 'user' ? 'message message-user' : 'message message-assistant';
        
        messageDiv.innerHTML = `
          <div class="message-role">${msg.type === 'user' ? '👤 Клиент' : '🤖 Ассистент'}</div>
          <div class="message-text">${escapeHtml(msg.text)}</div>
        `;
        
        container.appendChild(messageDiv);
      });
      
    } catch (error) {
      console.error('Error loading messages:', error);
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--error-red);">
          <i class="fas fa-exclamation-circle"></i>
          <p>Ошибка загрузки сообщений</p>
        </div>
      `;
    }
  }
  
  // ==================== Load Assistants (OpenAI + Gemini) ====================
  async function loadAssistants() {
    try {
      assistants = [];
      
      console.log('[ASSISTANTS] Loading assistants...');
      
      // 1. Загружаем OpenAI ассистентов
      try {
        const openaiData = await api.get('/assistants');
        console.log('[ASSISTANTS] OpenAI API response:', openaiData);
        
        // API может вернуть массив или объект с полем assistants
        const openaiList = Array.isArray(openaiData) ? openaiData : (openaiData.assistants || []);
        
        // Добавляем тип для различения
        openaiList.forEach(a => {
          assistants.push({
            id: a.id,
            name: a.name,
            type: 'openai',
            displayName: a.name
          });
        });
        
        console.log(`[ASSISTANTS] ✅ Loaded ${openaiList.length} OpenAI assistants`);
      } catch (e) {
        console.warn('[ASSISTANTS] ⚠️ Error loading OpenAI assistants:', e.message);
      }
      
      // 2. Загружаем Gemini ассистентов
      try {
        const geminiData = await api.get('/gemini-assistants');
        console.log('[ASSISTANTS] Gemini API response:', geminiData);
        
        // API возвращает массив
        const geminiList = Array.isArray(geminiData) ? geminiData : [];
        
        // Добавляем тип для различения
        geminiList.forEach(a => {
          assistants.push({
            id: a.id,
            name: a.name,
            type: 'gemini',
            displayName: a.name
          });
        });
        
        console.log(`[ASSISTANTS] ✅ Loaded ${geminiList.length} Gemini assistants`);
      } catch (e) {
        console.warn('[ASSISTANTS] ⚠️ Error loading Gemini assistants:', e.message);
      }
      
      console.log(`[ASSISTANTS] 🎯 Total assistants: ${assistants.length}`);
      
      renderAssistantSelect();
      
    } catch (error) {
      console.error('[ASSISTANTS] ❌ Fatal error loading assistants:', error);
      assistants = [];
      renderAssistantSelect();
    }
  }
  
  function renderAssistantSelect() {
    taskAssistantSelect.innerHTML = '';
    
    if (assistants.length === 0) {
      taskAssistantSelect.innerHTML = '<option value="">Нет доступных ассистентов</option>';
      createTaskBtn.disabled = true;
      console.log('[ASSISTANTS] No assistants available - task creation disabled');
      return;
    }
    
    // Включаем кнопку создания задачи
    createTaskBtn.disabled = false;
    
    // Добавляем placeholder
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = 'Выберите ассистента...';
    taskAssistantSelect.appendChild(placeholderOption);
    
    // Группируем по типу
    const openaiAssistants = assistants.filter(a => a.type === 'openai');
    const geminiAssistants = assistants.filter(a => a.type === 'gemini');
    
    console.log(`[ASSISTANTS] Rendering: ${openaiAssistants.length} OpenAI, ${geminiAssistants.length} Gemini`);
    
    // Добавляем OpenAI ассистентов
    if (openaiAssistants.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = '🤖 OpenAI Assistants';
      
      openaiAssistants.forEach(assistant => {
        const option = document.createElement('option');
        option.value = assistant.id;
        option.textContent = assistant.name;
        option.dataset.type = 'openai';
        optgroup.appendChild(option);
      });
      
      taskAssistantSelect.appendChild(optgroup);
    }
    
    // Добавляем Gemini ассистентов
    if (geminiAssistants.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = '✨ Gemini Assistants';
      
      geminiAssistants.forEach(assistant => {
        const option = document.createElement('option');
        option.value = assistant.id;
        option.textContent = assistant.name;
        option.dataset.type = 'gemini';
        optgroup.appendChild(option);
      });
      
      taskAssistantSelect.appendChild(optgroup);
    }
    
    console.log('[ASSISTANTS] ✅ Assistant select rendered successfully');
  }
  
  // ==================== Load Tasks ====================
  async function loadTasks() {
    try {
      const data = await api.get(`/contacts/${contactId}/tasks`);
      tasks = data.tasks || [];
      tasksCount.textContent = data.pending_count || 0;
      renderTasks();
    } catch (error) {
      console.error('Error loading tasks:', error);
      showNotification('Ошибка загрузки задач', 'error');
    }
  }
  
  // ==================== Render Tasks ====================
  function renderTasks() {
    if (tasks.length === 0) {
      tasksList.innerHTML = `
        <div class="empty-state-small">
          <i class="fas fa-calendar-check"></i>
          <p>Нет задач</p>
          <p style="font-size: 0.75rem; margin-top: 0.5rem;">Создайте задачу для автоматического звонка</p>
        </div>
      `;
      return;
    }
    
    tasksList.innerHTML = '';
    
    // Группируем по статусу
    const pending = tasks.filter(t => t.status === 'scheduled' || t.status === 'pending');
    const completed = tasks.filter(t => t.status === 'completed');
    const failed = tasks.filter(t => t.status === 'failed');
    const cancelled = tasks.filter(t => t.status === 'cancelled');
    
    // Рендерим pending
    if (pending.length > 0) {
      const section = document.createElement('div');
      section.className = 'tasks-section';
      section.innerHTML = '<h4>📅 Запланированные</h4>';
      
      pending.forEach(task => {
        section.appendChild(createTaskCard(task));
      });
      
      tasksList.appendChild(section);
    }
    
    // Рендерим completed
    if (completed.length > 0) {
      const section = document.createElement('div');
      section.className = 'tasks-section';
      section.innerHTML = '<h4>✅ Выполненные</h4>';
      
      completed.forEach(task => {
        section.appendChild(createTaskCard(task));
      });
      
      tasksList.appendChild(section);
    }
    
    // Рендерим failed
    if (failed.length > 0) {
      const section = document.createElement('div');
      section.className = 'tasks-section';
      section.innerHTML = '<h4>❌ Ошибка</h4>';
      
      failed.forEach(task => {
        section.appendChild(createTaskCard(task));
      });
      
      tasksList.appendChild(section);
    }
    
    // Рендерим cancelled
    if (cancelled.length > 0) {
      const section = document.createElement('div');
      section.className = 'tasks-section';
      section.innerHTML = '<h4>🚫 Отменённые</h4>';
      
      cancelled.forEach(task => {
        section.appendChild(createTaskCard(task));
      });
      
      tasksList.appendChild(section);
    }
  }
  
  function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.taskId = task.id;
    
    const scheduledTime = new Date(task.scheduled_time);
    const now = new Date();
    const isPast = scheduledTime < now;
    const isScheduled = task.status === 'scheduled' || task.status === 'pending';
    
    card.innerHTML = `
      <div class="task-card-header">
        <div class="task-status status-${task.status}">
          ${getTaskStatusIcon(task.status)} ${getTaskStatusLabel(task.status)}
        </div>
        ${isScheduled ? `
          <button class="task-delete-btn" data-task-id="${task.id}" title="Отменить задачу">
            <i class="fas fa-times"></i>
          </button>
        ` : ''}
      </div>
      
      <div class="task-title">${escapeHtml(task.title)}</div>
      
      ${task.description ? `
        <div class="task-description">${escapeHtml(task.description)}</div>
      ` : ''}
      
      <div class="task-meta">
        <div class="task-time ${isPast && isScheduled ? 'task-overdue' : ''}">
          <i class="fas fa-clock"></i>
          ${formatDateTime(task.scheduled_time)}
        </div>
        <div class="task-assistant">
          <i class="fas fa-robot"></i>
          ${task.assistant_name || 'Unknown'}
        </div>
      </div>
      
      ${task.call_session_id ? `
        <div class="task-result">
          <i class="fas fa-phone"></i>
          Звонок выполнен (ID: ${task.call_session_id.substring(0, 8)}...)
        </div>
      ` : ''}
    `;
    
    // Add delete listener
    const deleteBtn = card.querySelector('.task-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTask(task.id);
      });
    }
    
    return card;
  }
  
  function getTaskStatusIcon(status) {
    const icons = {
      'scheduled': '📅',
      'pending': '⏳',
      'calling': '📞',
      'completed': '✅',
      'failed': '❌',
      'cancelled': '🚫'
    };
    return icons[status] || '❓';
  }
  
  function getTaskStatusLabel(status) {
    const labels = {
      'scheduled': 'Запланирована',
      'pending': 'Ожидает',
      'calling': 'Звоним',
      'completed': 'Выполнена',
      'failed': 'Ошибка',
      'cancelled': 'Отменена'
    };
    return labels[status] || status;
  }
  
  // ==================== Create Task ====================
  createTaskBtn.addEventListener('click', () => {
    // Set default datetime to 1 hour from now
    const defaultTime = new Date();
    defaultTime.setHours(defaultTime.getHours() + 1);
    taskDatetimeInput.value = defaultTime.toISOString().slice(0, 16);
    
    taskModal.classList.add('show');
  });
  
  cancelTaskBtn.addEventListener('click', () => {
    taskModal.classList.remove('show');
    taskForm.reset();
  });
  
  taskModal.addEventListener('click', (e) => {
    if (e.target === taskModal) {
      taskModal.classList.remove('show');
      taskForm.reset();
    }
  });
  
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const assistantId = taskAssistantSelect.value;
    const scheduledTime = taskDatetimeInput.value;
    const title = taskTitleInput.value.trim();
    const description = taskDescriptionInput.value.trim();
    const customGreeting = taskCustomGreetingInput.value.trim(); // ✅ v3.6
    
    if (!assistantId || !scheduledTime || !title) {
      showNotification('Заполните все обязательные поля', 'error');
      return;
    }
    
    try {
      setLoading(true);
      
      console.log('[TASK] Creating task with data:', {
        assistant_id: assistantId,
        scheduled_time: scheduledTime,
        title: title,
        description: description || null,
        custom_greeting: customGreeting || null  // ✅ v3.6
      });
      
      await api.post(`/contacts/${contactId}/tasks`, {
        assistant_id: assistantId,
        scheduled_time: scheduledTime,
        title: title,
        description: description || null,
        custom_greeting: customGreeting || null  // ✅ v3.6
      });
      
      taskModal.classList.remove('show');
      taskForm.reset();
      
      await loadTasks();
      
      showNotification('Задача создана', 'success');
      
    } catch (error) {
      console.error('Error creating task:', error);
      showNotification(error.message || 'Ошибка создания задачи', 'error');
    } finally {
      setLoading(false);
    }
  });
  
  // ==================== Delete Task ====================
  async function deleteTask(taskId) {
    if (!confirm('Отменить эту задачу?')) {
      return;
    }
    
    try {
      setLoading(true);
      
      await api.delete(`/contacts/tasks/${taskId}`);
      
      await loadTasks();
      
      showNotification('Задача отменена', 'success');
      
    } catch (error) {
      console.error('Error deleting task:', error);
      showNotification(error.message || 'Ошибка отмены задачи', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Update Status ====================
  async function updateStatus(newStatus) {
    try {
      setLoading(true);
      
      await api.patch(`/contacts/${contactId}/status`, {
        status: newStatus
      });
      
      showNotification('Статус обновлен', 'success');
      
    } catch (error) {
      console.error('Error updating status:', error);
      showNotification(error.message || 'Ошибка обновления статуса', 'error');
      // Revert status
      statusDropdown.value = currentContact.status;
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Save Name ====================
  async function saveName() {
    try {
      const newName = nameInput.value.trim();
      
      setLoading(true);
      
      const response = await api.put(`/contacts/${contactId}`, {
        name: newName || null
      });
      
      // Update current contact and avatar
      currentContact = response.contact;
      const initials = getInitials(newName, currentContact.phone);
      contactAvatar.textContent = initials;
      
      showNotification('Имя сохранено', 'success');
      
    } catch (error) {
      console.error('Error saving name:', error);
      showNotification(error.message || 'Ошибка сохранения имени', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Delete Contact ====================
  async function deleteContact() {
    try {
      setLoading(true);
      
      await api.delete(`/contacts/${contactId}`);
      
      showNotification('Контакт удален', 'success');
      
      setTimeout(() => {
        window.location.href = '/static/crm.html';
      }, 1500);
      
    } catch (error) {
      console.error('Error deleting contact:', error);
      showNotification(error.message || 'Ошибка удаления контакта', 'error');
      setLoading(false);
    }
  }
  
  // ==================== Event Listeners ====================
  saveNameBtn.addEventListener('click', saveName);
  
  // Allow Enter to save name
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName();
    }
  });
  
  addNoteBtn.addEventListener('click', addNote);
  
  // Allow Enter+Ctrl to add note
  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      addNote();
    }
  });
  
  statusDropdown.addEventListener('change', (e) => {
    updateStatus(e.target.value);
  });
  
  deleteContactBtn.addEventListener('click', () => {
    deleteModal.classList.add('show');
  });
  
  cancelDeleteBtn.addEventListener('click', () => {
    deleteModal.classList.remove('show');
  });
  
  confirmDeleteBtn.addEventListener('click', () => {
    deleteModal.classList.remove('show');
    deleteContact();
  });
  
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) {
      deleteModal.classList.remove('show');
    }
  });
  
  notificationClose.addEventListener('click', hideNotification);
  
  // ==================== Initialization ====================
  if (!api.isAuthenticated()) {
    window.location.href = '/static/login.html';
  } else {
    // Get contact ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    contactId = urlParams.get('id');
    
    if (!contactId) {
      showNotification('ID контакта не указан', 'error');
      setTimeout(() => {
        window.location.href = '/static/crm.html';
      }, 2000);
    } else {
      loadContact();
    }
  }
});
