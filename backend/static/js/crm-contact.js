// backend/static/js/crm-contact.js
/**
 * Contact Detail Page для Voicyfy CRM
 * Детальный просмотр контакта с историей диалогов, заметками и задачами
 * Version: 3.8 - PRODUCTION READY with Unified Timeline & Task Editing
 * ✅ OpenAI + Gemini assistants support
 * ✅ Tasks with auto-calls
 * ✅ Notes feed
 * ✅ Conversations history with call direction (INBOUND/OUTBOUND)
 * ✅ v3.6: Custom greeting support
 * ✅ v3.7: Call direction indicators
 * ✅ v3.8: Unified timeline (tasks + conversations) + Task editing modal
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
  
  // Timeline (unified)
  const timelineContainer = document.getElementById('timeline-container');
  const createTaskBtn = document.getElementById('create-task-btn');
  
  // Task Create Modal
  const taskCreateModal = document.getElementById('task-create-modal');
  const taskCreateForm = document.getElementById('task-create-form');
  const taskCreateAssistant = document.getElementById('task-create-assistant');
  const taskCreateDatetime = document.getElementById('task-create-datetime');
  const taskCreateTitle = document.getElementById('task-create-title');
  const taskCreateDescription = document.getElementById('task-create-description');
  const taskCreateGreeting = document.getElementById('task-create-greeting');
  const taskCreateCancelBtn = document.getElementById('task-create-cancel-btn');
  
  // Task View/Edit Modal
  const taskViewModal = document.getElementById('task-view-modal');
  const taskViewMode = document.getElementById('task-view-mode');
  const taskEditForm = document.getElementById('task-edit-form');
  const taskViewCloseBtn = document.getElementById('task-view-close-btn');
  const taskViewEditBtn = document.getElementById('task-view-edit-btn');
  const taskEditCancelBtn = document.getElementById('task-edit-cancel-btn');
  const taskModalTitle = document.getElementById('task-modal-title');
  
  // Task View Mode Elements
  const taskViewStatus = document.getElementById('task-view-status');
  const taskViewTitle = document.getElementById('task-view-title');
  const taskViewDatetime = document.getElementById('task-view-datetime');
  const taskViewAssistant = document.getElementById('task-view-assistant');
  const taskViewDescription = document.getElementById('task-view-description');
  const taskViewGreeting = document.getElementById('task-view-greeting');
  const taskViewDescriptionSection = document.getElementById('task-view-description-section');
  const taskViewGreetingSection = document.getElementById('task-view-greeting-section');
  
  // Task Edit Mode Elements
  const taskEditAssistant = document.getElementById('task-edit-assistant');
  const taskEditDatetime = document.getElementById('task-edit-datetime');
  const taskEditTitle = document.getElementById('task-edit-title');
  const taskEditDescription = document.getElementById('task-edit-description');
  const taskEditGreeting = document.getElementById('task-edit-greeting');
  
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
  let timelineItems = []; // Unified: tasks + conversations
  let assistants = [];
  let currentTaskId = null;
  let currentTaskData = null;
  
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
  
  function getTaskStatusInfo(status) {
    const statusMap = {
      'scheduled': { icon: '📅', label: 'Запланирована' },
      'pending': { icon: '⏳', label: 'Ожидает' },
      'calling': { icon: '📞', label: 'Звонок...' },
      'completed': { icon: '✅', label: 'Выполнена' },
      'failed': { icon: '❌', label: 'Ошибка' },
      'cancelled': { icon: '🚫', label: 'Отменена' }
    };
    return statusMap[status] || { icon: '❓', label: status };
  }
  
  function getCallDirectionInfo(direction) {
    const directionMap = {
      'inbound': { icon: '📞', label: 'Входящий звонок' },
      'outbound': { icon: '📱', label: 'Исходящий звонок' },
      'chat': { icon: '💬', label: 'Диалог' }
    };
    return directionMap[direction] || { icon: '💬', label: 'Диалог' };
  }
  
  function getMessageEnding(count) {
    if (count % 10 === 1 && count % 100 !== 11) return 'е';
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'я';
    return 'й';
  }
  
  // ==================== Load Contact ====================
  async function loadContact() {
    try {
      setLoading(true);
      
      const contact = await api.get(`/contacts/${contactId}`);
      currentContact = contact;
      
      // Update left panel
      const initials = getInitials(contact.name, contact.phone);
      contactAvatar.textContent = initials;
      nameInput.value = contact.name || '';
      nameInput.placeholder = contact.name ? 'Введите имя контакта...' : 'Без имени';
      contactPhone.textContent = formatPhoneNumber(contact.phone);
      statusDropdown.value = contact.status || 'new';
      
      // Load notes
      await loadNotes();
      
      // Load assistants (for task creation)
      await loadAssistants();
      
      // Load unified timeline
      await loadTimeline();
      
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
  
  // ==================== Load Assistants (OpenAI + Gemini) ====================
  async function loadAssistants() {
    try {
      assistants = [];
      
      console.log('[ASSISTANTS] Loading assistants...');
      
      // 1. Загружаем OpenAI ассистентов
      try {
        const openaiData = await api.get('/assistants');
        console.log('[ASSISTANTS] OpenAI API response:', openaiData);
        
        const openaiList = Array.isArray(openaiData) ? openaiData : (openaiData.assistants || []);
        
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
        
        const geminiList = Array.isArray(geminiData) ? geminiData : [];
        
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
      
      renderAssistantSelects();
      
    } catch (error) {
      console.error('[ASSISTANTS] ❌ Fatal error loading assistants:', error);
      assistants = [];
      renderAssistantSelects();
    }
  }
  
  function renderAssistantSelects() {
    // Render for both create and edit modals
    [taskCreateAssistant, taskEditAssistant].forEach(selectElement => {
      selectElement.innerHTML = '';
      
      if (assistants.length === 0) {
        selectElement.innerHTML = '<option value="">Нет доступных ассистентов</option>';
        createTaskBtn.disabled = true;
        return;
      }
      
      createTaskBtn.disabled = false;
      
      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = 'Выберите ассистента...';
      selectElement.appendChild(placeholderOption);
      
      const openaiAssistants = assistants.filter(a => a.type === 'openai');
      const geminiAssistants = assistants.filter(a => a.type === 'gemini');
      
      // OpenAI group
      if (openaiAssistants.length > 0) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = '🤖 OpenAI Assistants';
        
        openaiAssistants.forEach(assistant => {
          const option = document.createElement('option');
          option.value = `${assistant.id}|openai`;
          option.textContent = assistant.name;
          optgroup.appendChild(option);
        });
        
        selectElement.appendChild(optgroup);
      }
      
      // Gemini group
      if (geminiAssistants.length > 0) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = '✨ Gemini Assistants';
        
        geminiAssistants.forEach(assistant => {
          const option = document.createElement('option');
          option.value = `${assistant.id}|gemini`;
          option.textContent = assistant.name;
          optgroup.appendChild(option);
        });
        
        selectElement.appendChild(optgroup);
      }
    });
    
    console.log('[ASSISTANTS] ✅ Assistant selects rendered');
  }
  
  // ==================== Load Unified Timeline ====================
  async function loadTimeline() {
    try {
      // Load tasks
      const tasksResponse = await api.get(`/contacts/${contactId}/tasks`);
      const tasks = tasksResponse.tasks || [];
      
      // Load conversations
      const conversationsResponse = await api.get(`/contacts/${contactId}?include_conversations=true`);
      const conversations = conversationsResponse.conversations || [];
      
      // Combine into unified timeline
      timelineItems = [
        ...tasks.map(task => ({ ...task, type: 'task' })),
        ...conversations.map(conv => ({ ...conv, type: 'conversation', expanded: false }))
      ];
      
      // Sort by date (newest first)
      timelineItems.sort((a, b) => {
        const dateA = new Date(a.scheduled_time || a.created_at);
        const dateB = new Date(b.scheduled_time || b.created_at);
        return dateB - dateA;
      });
      
      renderTimeline();
      
      // Update conversations count for delete modal
      deleteConversationsCount.textContent = conversations.length;
      
    } catch (error) {
      console.error('Error loading timeline:', error);
      timelineContainer.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-exclamation-circle"></i>
          <div>Ошибка загрузки истории</div>
        </div>
      `;
    }
  }
  
  // ==================== Render Unified Timeline ====================
  function renderTimeline() {
    if (timelineItems.length === 0) {
      timelineContainer.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-clock"></i>
          <div>История взаимодействий пуста</div>
          <p style="margin-top: 0.5rem; font-size: 0.875rem;">Создайте первую задачу или начните диалог</p>
        </div>
      `;
      return;
    }
    
    timelineContainer.innerHTML = '';
    
    timelineItems.forEach((item, index) => {
      if (item.type === 'task') {
        timelineContainer.appendChild(renderTaskItem(item));
      } else {
        timelineContainer.appendChild(renderConversationItem(item, index));
      }
    });
  }
  
  // ==================== Render Task Item ====================
  function renderTaskItem(task) {
    const statusInfo = getTaskStatusInfo(task.status);
    const scheduledTime = new Date(task.scheduled_time);
    const isOverdue = scheduledTime < new Date() && task.status === 'scheduled';
    
    const item = document.createElement('div');
    item.className = 'timeline-item task-item';
    item.dataset.taskId = task.id;
    
    item.innerHTML = `
      <div class="timeline-item-header">
        <div class="timeline-item-info">
          <div class="timeline-item-type">
            📅 ${escapeHtml(task.title)}
          </div>
          <div class="timeline-item-meta">
            <span><span class="task-status-badge status-${task.status}">${statusInfo.icon} ${statusInfo.label}</span></span>
            <span>${formatDateTime(task.scheduled_time)}${isOverdue ? ' <span style="color: var(--error-red); font-weight: 600;">⚠️ Просрочено</span>' : ''}</span>
            <span>${task.assistant_name || 'Ассистент не указан'}</span>
          </div>
        </div>
        <div class="timeline-item-toggle">
          <i class="fas fa-chevron-right"></i>
        </div>
      </div>
    `;
    
    // Click to open task view modal
    item.addEventListener('click', () => openTaskViewModal(task.id));
    
    return item;
  }
  
  // ==================== Render Conversation Item ====================
  function renderConversationItem(conversation, index) {
    const callDirection = getCallDirectionInfo(conversation.call_direction);
    const messageCount = conversation.messages_count || 0;
    
    const item = document.createElement('div');
    item.className = `timeline-item conversation-item ${conversation.expanded ? 'expanded' : ''}`;
    item.dataset.conversationId = conversation.id;
    item.dataset.index = index;
    
    item.innerHTML = `
      <div class="timeline-item-header">
        <div class="timeline-item-info">
          <div class="timeline-item-type">
            ${callDirection.icon} ${callDirection.label}
            ${conversation.task_id ? '<span style="font-size: 0.75rem; color: var(--text-light);">(по задаче)</span>' : ''}
          </div>
          <div class="timeline-item-meta">
            <span>${formatDate(conversation.created_at)}</span>
            <span>${messageCount} сообщени${getMessageEnding(messageCount)}</span>
          </div>
        </div>
        <div class="timeline-item-toggle">
          <i class="fas fa-chevron-down"></i>
        </div>
      </div>
      <div class="timeline-item-body">
        <div class="timeline-item-content" id="conversation-content-${index}">
          <div style="text-align: center; padding: 1rem; color: var(--text-light);">
            <i class="fas fa-spinner fa-spin"></i> Загрузка сообщений...
          </div>
        </div>
      </div>
    `;
    
    // Click to toggle conversation
    const header = item.querySelector('.timeline-item-header');
    header.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a')) return;
      toggleConversation(conversation.id, index);
    });
    
    return item;
  }
  
  // ==================== Toggle Conversation ====================
  async function toggleConversation(conversationId, index) {
    const item = timelineItems.find(i => i.id === conversationId && i.type === 'conversation');
    if (!item) return;
    
    const element = document.querySelector(`[data-conversation-id="${conversationId}"]`);
    if (!element) return;
    
    const wasExpanded = item.expanded;
    
    // Close all conversations
    timelineItems.forEach(i => {
      if (i.type === 'conversation') {
        i.expanded = false;
      }
    });
    document.querySelectorAll('.conversation-item').forEach(el => {
      el.classList.remove('expanded');
    });
    
    // Toggle current
    if (!wasExpanded) {
      item.expanded = true;
      element.classList.add('expanded');
      
      // Load messages if not loaded
      const contentContainer = document.getElementById(`conversation-content-${index}`);
      if (contentContainer && contentContainer.querySelector('.fa-spinner')) {
        await loadConversationMessages(item.session_id, contentContainer);
      }
    }
  }
  
  // ==================== Load Conversation Messages ====================
  async function loadConversationMessages(sessionId, container) {
    try {
      const data = await api.get(`/conversations/${sessionId}?include_functions=false`);
      
      if (!data.messages || data.messages.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 1rem; color: var(--text-light);">
            Нет сообщений
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
        <div style="text-align: center; padding: 1rem; color: var(--error-red);">
          <i class="fas fa-exclamation-circle"></i>
          Ошибка загрузки сообщений
        </div>
      `;
    }
  }
  
  // ==================== Task Operations ====================
  
  // Open Task Create Modal
  function openTaskCreateModal() {
    const defaultTime = new Date();
    defaultTime.setHours(defaultTime.getHours() + 1);
    taskCreateDatetime.value = defaultTime.toISOString().slice(0, 16);
    
    taskCreateForm.reset();
    taskCreateDatetime.value = defaultTime.toISOString().slice(0, 16);
    
    taskCreateModal.classList.add('show');
  }
  
  function closeTaskCreateModal() {
    taskCreateModal.classList.remove('show');
    taskCreateForm.reset();
  }
  
  // Create Task
  async function createTask(e) {
    e.preventDefault();
    
    const assistantValue = taskCreateAssistant.value;
    if (!assistantValue) {
      showNotification('Выберите ассистента', 'error');
      return;
    }
    
    const [assistantId, assistantType] = assistantValue.split('|');
    const scheduledTime = taskCreateDatetime.value;
    const title = taskCreateTitle.value.trim();
    const description = taskCreateDescription.value.trim();
    const customGreeting = taskCreateGreeting.value.trim();
    
    if (!title) {
      showNotification('Введите название задачи', 'error');
      return;
    }
    
    try {
      setLoading(true);
      
      const body = {
        scheduled_time: new Date(scheduledTime).toISOString(),
        title: title,
        description: description || null,
        custom_greeting: customGreeting || null
      };
      
      if (assistantType === 'openai') {
        body.assistant_id = assistantId;
      } else {
        body.gemini_assistant_id = assistantId;
      }
      
      await api.post(`/contacts/${contactId}/tasks`, body);
      
      closeTaskCreateModal();
      await loadTimeline();
      
      showNotification('Задача создана успешно', 'success');
      
    } catch (error) {
      console.error('Error creating task:', error);
      showNotification(error.message || 'Ошибка создания задачи', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // Open Task View Modal
  async function openTaskViewModal(taskId) {
    try {
      setLoading(true);
      currentTaskId = taskId;
      
      const response = await api.get(`/contacts/tasks/${taskId}`);
      currentTaskData = response;
      
      populateTaskViewMode();
      
      taskViewMode.style.display = 'block';
      taskEditForm.style.display = 'none';
      taskModalTitle.innerHTML = '<i class="fas fa-calendar-alt"></i> Детали задачи';
      
      taskViewModal.classList.add('show');
      
      setLoading(false);
      
    } catch (error) {
      console.error('Error loading task:', error);
      showNotification('Ошибка загрузки задачи', 'error');
      setLoading(false);
    }
  }
  
  function populateTaskViewMode() {
    const task = currentTaskData;
    const statusInfo = getTaskStatusInfo(task.status);
    
    // Status
    taskViewStatus.innerHTML = `
      <span class="task-status-badge status-${task.status}">
        ${statusInfo.icon} ${statusInfo.label}
      </span>
    `;
    
    // Title
    taskViewTitle.textContent = task.title;
    
    // DateTime
    const scheduledTime = new Date(task.scheduled_time);
    const isOverdue = scheduledTime < new Date() && task.status === 'scheduled';
    taskViewDatetime.innerHTML = 
      formatDateTime(task.scheduled_time) + 
      (isOverdue ? ' <span style="color: var(--error-red); font-weight: 600;">⚠️ Просрочено</span>' : '');
    
    // Assistant
    const assistantIcon = task.assistant_type === 'openai' ? '🤖' : '✨';
    taskViewAssistant.textContent = `${assistantIcon} ${task.assistant_name}`;
    
    // Description
    if (task.description) {
      taskViewDescriptionSection.style.display = 'block';
      taskViewDescription.textContent = task.description;
    } else {
      taskViewDescriptionSection.style.display = 'none';
    }
    
    // Custom greeting
    if (task.custom_greeting) {
      taskViewGreetingSection.style.display = 'block';
      taskViewGreeting.textContent = task.custom_greeting;
    } else {
      taskViewGreetingSection.style.display = 'none';
    }
    
    // Show/hide edit button
    if (task.status === 'scheduled' || task.status === 'pending') {
      taskViewEditBtn.style.display = 'inline-flex';
    } else {
      taskViewEditBtn.style.display = 'none';
    }
  }
  
  function switchToEditMode() {
    const task = currentTaskData;
    
    // Populate edit form
    const assistantValue = task.assistant_type === 'openai' 
      ? `${task.assistant_id}|openai` 
      : `${task.gemini_assistant_id}|gemini`;
    
    taskEditAssistant.value = assistantValue;
    
    const scheduledTime = new Date(task.scheduled_time);
    taskEditDatetime.value = scheduledTime.toISOString().slice(0, 16);
    
    taskEditTitle.value = task.title;
    taskEditDescription.value = task.description || '';
    taskEditGreeting.value = task.custom_greeting || '';
    
    // Switch views
    taskViewMode.style.display = 'none';
    taskEditForm.style.display = 'block';
    taskModalTitle.innerHTML = '<i class="fas fa-edit"></i> Редактирование задачи';
  }
  
  function switchToViewMode() {
    taskViewMode.style.display = 'block';
    taskEditForm.style.display = 'none';
    taskModalTitle.innerHTML = '<i class="fas fa-calendar-alt"></i> Детали задачи';
  }
  
  async function updateTask(e) {
    e.preventDefault();
    
    const assistantValue = taskEditAssistant.value;
    if (!assistantValue) {
      showNotification('Выберите ассистента', 'error');
      return;
    }
    
    const [assistantId, assistantType] = assistantValue.split('|');
    const scheduledTime = taskEditDatetime.value;
    const title = taskEditTitle.value.trim();
    const description = taskEditDescription.value.trim();
    const customGreeting = taskEditGreeting.value.trim();
    
    if (!title) {
      showNotification('Введите название задачи', 'error');
      return;
    }
    
    try {
      setLoading(true);
      
      const body = {
        scheduled_time: new Date(scheduledTime).toISOString(),
        title: title,
        description: description || null,
        custom_greeting: customGreeting || null
      };
      
      // Backend will determine type by assistant_id
      body.assistant_id = assistantId;
      
      const response = await api.put(`/contacts/tasks/${currentTaskId}`, body);
      currentTaskData = response;
      
      showNotification('Задача обновлена успешно', 'success');
      
      await loadTimeline();
      closeTaskViewModal();
      
      setLoading(false);
      
    } catch (error) {
      console.error('Error updating task:', error);
      showNotification(error.message || 'Ошибка обновления задачи', 'error');
      setLoading(false);
    }
  }
  
  function closeTaskViewModal() {
    taskViewModal.classList.remove('show');
    currentTaskId = null;
    currentTaskData = null;
  }
  
  // ==================== Contact Operations ====================
  
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
      statusDropdown.value = currentContact.status;
    } finally {
      setLoading(false);
    }
  }
  
  async function saveName() {
    try {
      const newName = nameInput.value.trim();
      
      setLoading(true);
      
      const response = await api.put(`/contacts/${contactId}`, {
        name: newName || null
      });
      
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
  
  // Name
  saveNameBtn.addEventListener('click', saveName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName();
    }
  });
  
  // Notes
  addNoteBtn.addEventListener('click', addNote);
  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      addNote();
    }
  });
  
  // Status
  statusDropdown.addEventListener('change', (e) => {
    updateStatus(e.target.value);
  });
  
  // Task Create Modal
  createTaskBtn.addEventListener('click', openTaskCreateModal);
  taskCreateCancelBtn.addEventListener('click', closeTaskCreateModal);
  taskCreateForm.addEventListener('submit', createTask);
  taskCreateModal.addEventListener('click', (e) => {
    if (e.target === taskCreateModal) {
      closeTaskCreateModal();
    }
  });
  
  // Task View/Edit Modal
  taskViewCloseBtn.addEventListener('click', closeTaskViewModal);
  taskViewEditBtn.addEventListener('click', switchToEditMode);
  taskEditCancelBtn.addEventListener('click', switchToViewMode);
  taskEditForm.addEventListener('submit', updateTask);
  taskViewModal.addEventListener('click', (e) => {
    if (e.target === taskViewModal) {
      closeTaskViewModal();
    }
  });
  
  // Delete Contact
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
  
  // Notification
  notificationClose.addEventListener('click', hideNotification);
  
  // ==================== Initialization ====================
  if (!api.isAuthenticated()) {
    window.location.href = '/static/login.html';
  } else {
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
