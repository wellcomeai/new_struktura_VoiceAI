// backend/static/js/crm.js
/**
 * CRM Interface для Voicyfy
 * Управление контактами (клиентами)
 * Version: 1.0
 */

document.addEventListener('DOMContentLoaded', function() {
  // ==================== Элементы ====================
  const contactsGrid = document.getElementById('contacts-grid');
  const searchInput = document.getElementById('search-input');
  const refreshBtn = document.getElementById('refresh-btn');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const paginationInfo = document.getElementById('pagination-info');
  const pagination = document.getElementById('pagination');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalSubtitle = document.getElementById('modal-subtitle');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalSave = document.getElementById('modal-save');
  const notification = document.getElementById('notification');
  const notificationMessage = document.getElementById('notification-message');
  const notificationClose = document.getElementById('notification-close');
  const loadingOverlay = document.getElementById('loading-overlay');
  const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const userMenuButton = document.getElementById('user-menu-button');
  const userDropdown = document.getElementById('user-dropdown');
  const userEmailDisplay = document.getElementById('user-name');
  const userAvatar = document.getElementById('user-avatar');
  const statusBadges = document.querySelectorAll('.status-badge');
  
  // ==================== Состояние ====================
  let currentPage = 0;
  let totalPages = 1;
  let totalContacts = 0;
  let currentStatus = '';
  let searchQuery = '';
  let currentContact = null;
  const perPage = 20;
  
  // Таймер для debounce поиска
  let searchTimeout = null;
  
  // ==================== API функции ====================
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
  
  // ==================== UI функции ====================
  function setLoading(loading) {
    loadingOverlay.style.display = loading ? 'flex' : 'none';
  }
  
  function showNotification(message, type = 'success') {
    notification.classList.remove('notification-success', 'notification-error', 'notification-info');
    notification.classList.add(`notification-${type}`);
    
    const iconElement = notification.querySelector('.notification-icon i');
    iconElement.className = type === 'success' ? 'fas fa-check-circle' : 
                         type === 'error' ? 'fas fa-exclamation-circle' : 
                         'fas fa-info-circle';
    
    notificationMessage.textContent = message;
    notification.style.display = 'flex';
    
    setTimeout(() => {
      notification.classList.add('show');
    }, 10);
    
    setTimeout(() => {
      hideNotification();
    }, 5000);
  }
  
  function hideNotification() {
    notification.classList.remove('show');
    setTimeout(() => {
      notification.style.display = 'none';
    }, 300);
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
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
  }
  
  function formatPhoneNumber(phone) {
    // Форматирование номера телефона
    if (!phone) return '';
    
    // Убираем все нецифровые символы
    const cleaned = phone.replace(/\D/g, '');
    
    // Форматируем как +7 (XXX) XXX-XX-XX
    if (cleaned.startsWith('7') && cleaned.length === 11) {
      return `+7 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7, 9)}-${cleaned.slice(9)}`;
    }
    
    // Возвращаем как есть если не подходит
    return phone;
  }
  
  function getStatusLabel(status) {
    const labels = {
      'new': 'Новый',
      'active': 'Активный',
      'client': 'Клиент',
      'archived': 'Архив'
    };
    return labels[status] || status;
  }
  
  function getInitials(name, phone) {
    if (name) {
      const words = name.trim().split(' ');
      if (words.length >= 2) {
        return words[0][0].toUpperCase() + words[1][0].toUpperCase();
      }
      return name.substring(0, 2).toUpperCase();
    }
    
    // Если имени нет, используем последние 2 цифры номера
    if (phone) {
      const cleaned = phone.replace(/\D/g, '');
      return cleaned.slice(-2);
    }
    
    return '??';
  }
  
  // ==================== Рендер карточек ====================
  function createContactCard(contact) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    card.onclick = () => openContactDetail(contact.id);
    
    const displayName = contact.name || 'Без имени';
    const initials = getInitials(contact.name, contact.phone);
    const formattedPhone = formatPhoneNumber(contact.phone);
    
    const notesPreview = contact.notes 
      ? contact.notes.substring(0, 100) + (contact.notes.length > 100 ? '...' : '')
      : 'Нет заметок';
    
    card.innerHTML = `
      <div class="card-status ${contact.status}">${getStatusLabel(contact.status)}</div>
      
      <div class="card-header">
        <div class="contact-avatar">${initials}</div>
        <div class="card-info">
          <div class="contact-name">${displayName}</div>
          <div class="contact-phone">${formattedPhone}</div>
        </div>
      </div>
      
      <div class="card-notes">${notesPreview}</div>
      
      <div class="card-footer">
        <div class="card-meta">
          <div class="meta-item">
            <i class="fas fa-comments"></i>
            ${contact.total_conversations || 0} диалогов
          </div>
          ${contact.last_interaction ? `
            <div class="meta-item">
              <i class="fas fa-clock"></i>
              ${formatDate(contact.last_interaction)}
            </div>
          ` : ''}
        </div>
      </div>
    `;
    
    return card;
  }
  
  function showEmptyState() {
    contactsGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <i class="fas fa-address-book"></i>
        <h3>Нет контактов</h3>
        <p>Контакты автоматически создаются при звонках с новых номеров</p>
      </div>
    `;
    pagination.style.display = 'none';
  }
  
  // ==================== Загрузка контактов ====================
  async function loadContacts() {
    try {
      setLoading(true);
      
      const offset = currentPage * perPage;
      
      let url = `/contacts?limit=${perPage}&offset=${offset}`;
      
      if (currentStatus) {
        url += `&status=${currentStatus}`;
      }
      
      if (searchQuery) {
        url += `&search=${encodeURIComponent(searchQuery)}`;
      }
      
      const response = await api.get(url);
      
      totalContacts = response.total;
      totalPages = Math.ceil(totalContacts / perPage);
      
      contactsGrid.innerHTML = '';
      
      if (response.contacts.length === 0) {
        showEmptyState();
        return;
      }
      
      response.contacts.forEach(contact => {
        const card = createContactCard(contact);
        contactsGrid.appendChild(card);
      });
      
      updatePagination();
      
    } catch (error) {
      console.error('Error loading contacts:', error);
      showNotification(error.message || 'Ошибка при загрузке контактов', 'error');
      showEmptyState();
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Обновление пагинации ====================
  function updatePagination() {
    if (totalPages <= 1) {
      pagination.style.display = 'none';
      return;
    }
    
    pagination.style.display = 'flex';
    paginationInfo.textContent = `Страница ${currentPage + 1} из ${totalPages}`;
    
    prevBtn.disabled = currentPage === 0;
    nextBtn.disabled = currentPage >= totalPages - 1;
  }
  
  // ==================== Детальный просмотр контакта ====================
  async function openContactDetail(contactId) {
    try {
      setLoading(true);
      
      const contact = await api.get(`/contacts/${contactId}?include_conversations=true`);
      currentContact = contact;
      
      // Заголовок
      const displayName = contact.name || 'Без имени';
      modalTitle.innerHTML = `
        <i class="fas fa-user-circle"></i>
        ${displayName}
      `;
      
      // Подзаголовок
      const formattedPhone = formatPhoneNumber(contact.phone);
      modalSubtitle.innerHTML = `
        <span style="font-family: 'Consolas', 'Monaco', monospace; font-weight: 600;">
          <i class="fas fa-phone"></i> ${formattedPhone}
        </span>
        ${contact.total_conversations ? `
          <span style="color: var(--text-gray);">
            <i class="fas fa-comments"></i> ${contact.stats.total_conversations} диалогов
          </span>
        ` : ''}
      `;
      
      // Тело модалки
      modalBody.innerHTML = `
        <!-- Редактирование контакта -->
        <div class="modal-section">
          <div class="section-title">Информация о контакте</div>
          
          <div class="form-group">
            <label class="form-label">Имя</label>
            <input 
              type="text" 
              id="contact-name-input" 
              class="form-input" 
              placeholder="Введите имя контакта..."
              value="${contact.name || ''}"
            >
          </div>
          
          <div class="form-group">
            <label class="form-label">Статус</label>
            <div class="status-selector" id="status-selector">
              <div class="status-option status-new ${contact.status === 'new' ? 'selected' : ''}" data-status="new">
                Новый
              </div>
              <div class="status-option status-active ${contact.status === 'active' ? 'selected' : ''}" data-status="active">
                Активный
              </div>
              <div class="status-option status-client ${contact.status === 'client' ? 'selected' : ''}" data-status="client">
                Клиент
              </div>
              <div class="status-option status-archived ${contact.status === 'archived' ? 'selected' : ''}" data-status="archived">
                Архив
              </div>
            </div>
          </div>
          
          <div class="form-group">
            <label class="form-label">Заметки</label>
            <textarea 
              id="contact-notes-input" 
              class="form-textarea" 
              placeholder="Добавьте заметки о контакте..."
            >${contact.notes || ''}</textarea>
          </div>
        </div>
        
        <!-- История диалогов -->
        ${contact.conversations && contact.conversations.length > 0 ? `
          <div class="modal-section">
            <div class="section-title">История диалогов (${contact.conversations.length})</div>
            <div class="conversations-list" id="conversations-list">
              ${contact.conversations.map(conv => `
                <div class="conversation-item" onclick="window.open('/static/conversations.html?session=${conv.session_id}', '_blank')">
                  <div class="conversation-header">
                    <div class="conversation-assistant">
                      <i class="fas fa-robot"></i> ${conv.assistant_name || 'Неизвестный ассистент'}
                    </div>
                    <div class="conversation-date">${formatDate(conv.created_at)}</div>
                  </div>
                  <div class="conversation-stats">
                    <span><i class="fas fa-comments"></i> ${conv.messages_count} сообщений</span>
                    ${conv.total_duration ? `<span><i class="fas fa-clock"></i> ${Math.floor(conv.total_duration / 60)} мин</span>` : ''}
                    <span><i class="fas fa-brain"></i> ${conv.total_tokens} токенов</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : `
          <div class="modal-section">
            <div class="section-title">История диалогов</div>
            <p style="color: var(--text-gray); text-align: center; padding: 2rem;">
              Пока не было диалогов с этим контактом
            </p>
          </div>
        `}
      `;
      
      // Обработчики для статусов
      const statusOptions = modalBody.querySelectorAll('.status-option');
      statusOptions.forEach(option => {
        option.addEventListener('click', function() {
          statusOptions.forEach(opt => opt.classList.remove('selected'));
          this.classList.add('selected');
        });
      });
      
      modalOverlay.classList.add('show');
      
    } catch (error) {
      console.error('Error loading contact detail:', error);
      showNotification(error.message || 'Ошибка при загрузке контакта', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Сохранение контакта ====================
  async function saveContact() {
    if (!currentContact) return;
    
    try {
      setLoading(true);
      
      const name = document.getElementById('contact-name-input').value.trim();
      const notes = document.getElementById('contact-notes-input').value.trim();
      const selectedStatus = modalBody.querySelector('.status-option.selected');
      const status = selectedStatus ? selectedStatus.dataset.status : currentContact.status;
      
      const updateData = {
        name: name || null,
        notes: notes || null,
        status: status
      };
      
      await api.put(`/contacts/${currentContact.id}`, updateData);
      
      showNotification('Контакт успешно обновлен', 'success');
      
      closeModal();
      loadContacts(); // Перезагрузить список
      
    } catch (error) {
      console.error('Error saving contact:', error);
      showNotification(error.message || 'Ошибка при сохранении контакта', 'error');
    } finally {
      setLoading(false);
    }
  }
  
  // ==================== Закрытие модального окна ====================
  function closeModal() {
    modalOverlay.classList.remove('show');
    currentContact = null;
  }
  
  // ==================== Фильтры ====================
  statusBadges.forEach(badge => {
    badge.addEventListener('click', function() {
      statusBadges.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      
      currentStatus = this.dataset.status;
      currentPage = 0;
      loadContacts();
    });
  });
  
  // ==================== Поиск ====================
  searchInput.addEventListener('input', function() {
    clearTimeout(searchTimeout);
    
    searchTimeout = setTimeout(() => {
      searchQuery = this.value.trim();
      currentPage = 0;
      loadContacts();
    }, 500); // Debounce 500ms
  });
  
  // ==================== Пагинация ====================
  prevBtn.addEventListener('click', () => {
    if (currentPage > 0) {
      currentPage--;
      loadContacts();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  
  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages - 1) {
      currentPage++;
      loadContacts();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  
  // ==================== Обновление ====================
  refreshBtn.addEventListener('click', () => {
    loadContacts();
    showNotification('Данные обновлены', 'info');
  });
  
  // ==================== Модальное окно ====================
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalSave.addEventListener('click', saveContact);
  
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });
  
  // ==================== Мобильное меню ====================
  mobileMenuToggle.addEventListener('click', function() {
    sidebar.classList.toggle('mobile-open');
    sidebarOverlay.classList.toggle('show');
  });
  
  sidebarOverlay.addEventListener('click', function() {
    sidebar.classList.remove('mobile-open');
    sidebarOverlay.classList.remove('show');
  });
  
  // ==================== Выпадающее меню пользователя ====================
  userMenuButton.addEventListener('click', function(e) {
    e.stopPropagation();
    userDropdown.classList.toggle('show');
  });
  
  document.addEventListener('click', function(e) {
    if (userDropdown.classList.contains('show') && !userDropdown.contains(e.target) && !userMenuButton.contains(e.target)) {
      userDropdown.classList.remove('show');
    }
  });
  
  // ==================== Закрытие уведомления ====================
  notificationClose.addEventListener('click', hideNotification);
  
  // ==================== Загрузка информации о пользователе ====================
  async function loadUserInfo() {
    try {
      const userInfo = await api.get('/users/me');
      
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
    } catch (error) {
      console.error('Ошибка загрузки информации о пользователе:', error);
    }
  }
  
  // ==================== Проверка авторизации ====================
  if (!api.isAuthenticated()) {
    window.location.href = '/static/login.html';
    return;
  }
  
  // ==================== Инициализация ====================
  loadUserInfo();
  loadContacts();
});
