// backend/static/js/crm-contact.js
/**
 * Contact Detail Page для Voicyfy CRM
 * Детальный просмотр контакта с историей диалогов и лентой заметок
 * Version: 2.0 - Production Ready with Notes Feed
 */

document.addEventListener('DOMContentLoaded', function() {
  // ==================== Элементы ====================
  const contactAvatar = document.getElementById('contact-avatar');
  const contactName = document.getElementById('contact-name');
  const contactPhone = document.getElementById('contact-phone');
  const statusDropdown = document.getElementById('status-dropdown');
  const notesFeed = document.getElementById('notes-feed');
  const notesCount = document.getElementById('notes-count');
  const noteInput = document.getElementById('note-input');
  const addNoteBtn = document.getElementById('add-note-btn');
  const deleteContactBtn = document.getElementById('delete-contact-btn');
  const conversationsAccordion = document.getElementById('conversations-accordion');
  const conversationsCount = document.getElementById('conversations-count');
  const deleteModal = document.getElementById('delete-modal');
  const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
  const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
  const deleteConversationsCount = document.getElementById('delete-conversations-count');
  const notification = document.getElementById('notification');
  const notificationMessage = document.getElementById('notification-message');
  const notificationClose = document.getElementById('notification-close');
  const loadingOverlay = document.getElementById('loading-overlay');
  
  // ==================== Состояние ====================
  let currentContact = null;
  let contactId = null;
  let notes = [];
  
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
  
  // ==================== Load Contact ====================
  async function loadContact() {
    try {
      setLoading(true);
      
      const contact = await api.get(`/contacts/${contactId}?include_conversations=true`);
      currentContact = contact;
      
      // Update left panel
      const initials = getInitials(contact.name, contact.phone);
      contactAvatar.textContent = initials;
      contactName.textContent = contact.name || 'Без имени';
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
  
  // ==================== Render Conversations ====================
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
      
      item.innerHTML = `
        <div class="conversation-header">
          <div class="conversation-info">
            <div class="conversation-date">
              📞 ${createdDate}
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
  
  // ==================== Utility Functions ====================
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  // ==================== Event Listeners ====================
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
