// /static/conversations/index.js
/**
 * Модуль для работы с карточками диалогов
 * Загружает и отображает историю диалогов с ассистентами
 * 
 * ИСПРАВЛЕНИЯ:
 * - Правильный редирект на /static/index.html вместо несуществующего login.html
 * - Добавлена проверка подписки
 * - Обработка 401/403 ошибок (протухший токен)
 * - Показ предупреждения об истекшей подписке
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const API_BASE = window.location.origin;
const CONVERSATIONS_PER_PAGE = 20;

// ============================================================================
// STATE
// ============================================================================

let currentPage = 0;
let totalConversations = 0;
let currentFilters = {
  assistant_id: null,
  source: null,
  date_from: null,
  date_to: null
};
let subscriptionStatus = null; // 🆕 Добавлено: статус подписки

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Получить токен из localStorage
 */
function getToken() {
  return localStorage.getItem('access_token');
}

/**
 * Проверка авторизации
 * 🆕 ИСПРАВЛЕНО: Редирект на правильный файл
 */
function checkAuth() {
  const token = getToken();
  if (!token) {
    // Перенаправляем на главную страницу (там форма входа)
    window.location.href = '/static/index.html';
    return false;
  }
  return true;
}

/**
 * 🆕 ДОБАВЛЕНО: Обработка ошибок API
 */
function handleApiError(response) {
  if (response.status === 401 || response.status === 403) {
    // Токен протух или невалиден
    console.log('Token expired or invalid, redirecting to login');
    localStorage.removeItem('access_token');
    window.location.href = '/static/index.html';
    return true;
  }
  return false;
}

/**
 * 🆕 ДОБАВЛЕНО: Проверка статуса подписки
 */
async function checkSubscription() {
  const token = getToken();
  
  try {
    const response = await fetch(`${API_BASE}/api/subscriptions/my-subscription`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) {
      if (handleApiError(response)) return null;
      throw new Error('Failed to check subscription');
    }
    
    const data = await response.json();
    subscriptionStatus = data;
    
    // Показываем предупреждение если подписка неактивна
    if (!data.active && !data.is_trial) {
      showSubscriptionWarning();
    }
    
    return data;
  } catch (error) {
    console.error('Error checking subscription:', error);
    return null;
  }
}

/**
 * 🆕 ДОБАВЛЕНО: Показать предупреждение о подписке
 */
function showSubscriptionWarning() {
  const warningHtml = `
    <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 1rem; margin-bottom: 1.5rem; border-radius: 0.5rem;">
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <i class="fas fa-exclamation-triangle" style="color: #f59e0b; font-size: 1.25rem;"></i>
        <div>
          <strong style="color: #92400e;">Подписка истекла</strong>
          <p style="color: #92400e; margin: 0.25rem 0 0 0; font-size: 0.875rem;">
            Для продолжения работы с ассистентами необходимо продлить подписку.
            <a href="/static/settings.html" style="color: #2563eb; text-decoration: underline;">Перейти к настройкам</a>
          </p>
        </div>
      </div>
    </div>
  `;
  
  const container = document.querySelector('.content-container');
  if (container && container.firstChild) {
    container.insertAdjacentHTML('afterbegin', warningHtml);
  }
}

/**
 * Получить список диалогов
 * 🆕 ИСПРАВЛЕНО: Добавлена обработка ошибок
 */
async function fetchConversations(offset = 0) {
  const token = getToken();
  
  // Формируем URL с параметрами
  const params = new URLSearchParams({
    limit: CONVERSATIONS_PER_PAGE,
    offset: offset
  });
  
  // Добавляем фильтры если есть
  if (currentFilters.assistant_id) {
    params.append('assistant_id', currentFilters.assistant_id);
  }
  
  if (currentFilters.date_from) {
    params.append('date_from', new Date(currentFilters.date_from).toISOString());
  }
  
  if (currentFilters.date_to) {
    params.append('date_to', new Date(currentFilters.date_to).toISOString());
  }
  
  // Фильтр по номеру телефона (если источник = phone)
  if (currentFilters.source === 'phone') {
    // Получаем только со звонков (caller_number не пустой)
    // Это нужно будет обработать на бэкенде или фильтровать после получения
  }
  
  const response = await fetch(`${API_BASE}/api/conversations?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  // 🆕 ДОБАВЛЕНО: Обработка ошибок авторизации
  if (!response.ok) {
    if (handleApiError(response)) {
      throw new Error('Unauthorized');
    }
    throw new Error('Failed to fetch conversations');
  }
  
  return await response.json();
}

/**
 * Получить детали диалога
 * 🆕 ИСПРАВЛЕНО: Добавлена обработка ошибок
 */
async function fetchConversationDetail(conversationId) {
  const token = getToken();
  
  const response = await fetch(`${API_BASE}/api/conversations/${conversationId}?include_functions=true`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  // 🆕 ДОБАВЛЕНО: Обработка ошибок авторизации
  if (!response.ok) {
    if (handleApiError(response)) {
      throw new Error('Unauthorized');
    }
    throw new Error('Failed to fetch conversation detail');
  }
  
  return await response.json();
}

/**
 * Получить список ассистентов для фильтра
 * 🆕 ИСПРАВЛЕНО: Добавлена обработка ошибок
 */
async function fetchAssistants() {
  const token = getToken();
  
  const response = await fetch(`${API_BASE}/api/assistants`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  // 🆕 ДОБАВЛЕНО: Обработка ошибок авторизации
  if (!response.ok) {
    if (handleApiError(response)) {
      throw new Error('Unauthorized');
    }
    throw new Error('Failed to fetch assistants');
  }
  
  return await response.json();
}

// ============================================================================
// UI RENDERING
// ============================================================================

/**
 * Отобразить карточки диалогов
 */
function renderConversations(data) {
  const grid = document.getElementById('conversations-grid');
  const countEl = document.getElementById('conversations-count');
  
  totalConversations = data.total;
  
  // Обновляем счетчик
  countEl.textContent = `Найдено: ${data.total} диалогов`;
  
  // Очищаем сетку
  grid.innerHTML = '';
  
  // Если нет диалогов
  if (data.conversations.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <i class="fas fa-comments"></i>
        </div>
        <h3 class="empty-title">Диалогов пока нет</h3>
        <p class="empty-description">
          Здесь будет отображаться история всех разговоров с вашими голосовыми ассистентами.
        </p>
      </div>
    `;
    document.getElementById('pagination').style.display = 'none';
    return;
  }
  
  // Рендерим карточки
  data.conversations.forEach(conv => {
    const card = createConversationCard(conv);
    grid.appendChild(card);
  });
  
  // Обновляем пагинацию
  updatePagination(data);
}

/**
 * Создать карточку диалога
 */
function createConversationCard(conv) {
  const card = document.createElement('div');
  card.className = 'conversation-card';
  card.onclick = () => openConversationDetail(conv.id);
  
  // Определяем источник (звонок или виджет)
  const isPhone = conv.caller_number && conv.caller_number.trim() !== '';
  const iconClass = isPhone ? 'phone' : 'widget';
  const iconSymbol = isPhone ? 'fa-phone' : 'fa-robot';
  
  // Форматируем источник
  let sourceText = isPhone ? formatPhoneNumber(conv.caller_number) : 'Виджет';
  
  // Форматируем время
  const timeText = formatDateTime(conv.created_at);
  
  // Превью сообщения (берем из user_message или assistant_message)
  let previewText = conv.user_message || conv.assistant_message || 'Нет текста';
  if (previewText.length > 150) {
    previewText = previewText.substring(0, 150) + '...';
  }
  
  // Формируем HTML
  card.innerHTML = `
    <div class="conversation-icon ${iconClass}">
      <i class="fas ${iconSymbol}"></i>
    </div>
    
    <div class="conversation-content">
      <div class="conversation-header-row">
        <div class="conversation-source">
          ${sourceText}
        </div>
        <div class="conversation-time">${timeText}</div>
      </div>
      
      <div class="conversation-preview">
        ${escapeHtml(previewText)}
      </div>
      
      <div class="conversation-meta">
        ${conv.duration_seconds ? `
          <div class="meta-item">
            <i class="fas fa-clock"></i>
            <span>${formatDuration(conv.duration_seconds)}</span>
          </div>
        ` : ''}
        
        ${conv.tokens_used > 0 ? `
          <div class="meta-item">
            <i class="fas fa-microchip"></i>
            <span>${conv.tokens_used} токенов</span>
          </div>
        ` : ''}
        
        <div class="meta-item">
          <i class="fas fa-calendar"></i>
          <span>${formatDate(conv.created_at)}</span>
        </div>
      </div>
    </div>
    
    <div class="conversation-actions">
      ${conv.function_calls && conv.function_calls.length > 0 ? `
        <div class="action-badge functions">
          <i class="fas fa-code"></i>
          ${conv.function_calls.length} функций
        </div>
      ` : ''}
    </div>
  `;
  
  return card;
}

/**
 * Открыть детали диалога в модальном окне
 */
async function openConversationDetail(conversationId) {
  const overlay = document.getElementById('modal-overlay');
  const body = document.getElementById('modal-body');
  const loading = document.getElementById('loading-overlay');
  
  try {
    // Показываем загрузку
    loading.style.display = 'flex';
    
    // Загружаем данные
    const conv = await fetchConversationDetail(conversationId);
    
    // Определяем источник
    const isPhone = conv.caller_number && conv.caller_number.trim() !== '';
    const sourceText = isPhone ? formatPhoneNumber(conv.caller_number) : 'Виджет';
    
    // Формируем HTML
    body.innerHTML = `
      <!-- Основная информация -->
      <div class="detail-section">
        <h4 class="detail-section-title">Информация о диалоге</h4>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">Источник</div>
            <div class="detail-value">
              <i class="fas ${isPhone ? 'fa-phone' : 'fa-robot'}"></i>
              ${sourceText}
            </div>
          </div>
          
          <div class="detail-item">
            <div class="detail-label">Время</div>
            <div class="detail-value">${formatDateTime(conv.created_at)}</div>
          </div>
          
          ${conv.duration_seconds ? `
            <div class="detail-item">
              <div class="detail-label">Длительность</div>
              <div class="detail-value">${formatDuration(conv.duration_seconds)}</div>
            </div>
          ` : ''}
          
          ${conv.tokens_used > 0 ? `
            <div class="detail-item">
              <div class="detail-label">Токенов использовано</div>
              <div class="detail-value">${conv.tokens_used}</div>
            </div>
          ` : ''}
        </div>
      </div>
      
      <!-- Сообщения -->
      <div class="detail-section">
        <h4 class="detail-section-title">Диалог</h4>
        
        ${conv.user_message ? `
          <div class="message-box">
            <div class="message-box-header user">
              <i class="fas fa-user"></i>
              Пользователь
            </div>
            <div class="message-box-content">${escapeHtml(conv.user_message)}</div>
          </div>
        ` : ''}
        
        ${conv.assistant_message ? `
          <div class="message-box">
            <div class="message-box-header assistant">
              <i class="fas fa-robot"></i>
              Ассистент
            </div>
            <div class="message-box-content">${escapeHtml(conv.assistant_message)}</div>
          </div>
        ` : ''}
      </div>
      
      <!-- Вызовы функций -->
      ${conv.function_calls && conv.function_calls.length > 0 ? `
        <div class="detail-section">
          <h4 class="detail-section-title">Вызовы функций (${conv.function_calls.length})</h4>
          <div class="function-list">
            ${conv.function_calls.map(fn => `
              <div class="function-item">
                <div class="function-header">
                  <div class="function-name">
                    <i class="fas fa-code"></i>
                    ${fn.function_name}
                  </div>
                  <div class="function-status ${fn.status === 'success' ? 'success' : 'error'}">
                    ${fn.status === 'success' ? '✓ Успешно' : '✗ Ошибка'}
                  </div>
                </div>
                
                ${fn.arguments ? `
                  <div class="function-details">
                    <strong>Аргументы:</strong>
                    <div class="function-code">${JSON.stringify(fn.arguments, null, 2)}</div>
                  </div>
                ` : ''}
                
                ${fn.result ? `
                  <div class="function-details">
                    <strong>Результат:</strong>
                    <div class="function-code">${JSON.stringify(fn.result, null, 2)}</div>
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;
    
    // Показываем модалку
    overlay.style.display = 'flex';
    
  } catch (error) {
    console.error('Error loading conversation detail:', error);
    // 🆕 УЛУЧШЕНО: Не показываем alert если редирект на login
    if (error.message !== 'Unauthorized') {
      alert('Ошибка загрузки деталей диалога');
    }
  } finally {
    loading.style.display = 'none';
  }
}

/**
 * Обновить пагинацию
 */
function updatePagination(data) {
  const pagination = document.getElementById('pagination');
  const prevBtn = document.getElementById('prev-page');
  const nextBtn = document.getElementById('next-page');
  const info = document.getElementById('pagination-info');
  
  const totalPages = Math.ceil(data.total / CONVERSATIONS_PER_PAGE);
  const currentPageNum = data.page + 1;
  
  // Показываем пагинацию только если больше 1 страницы
  if (totalPages <= 1) {
    pagination.style.display = 'none';
    return;
  }
  
  pagination.style.display = 'flex';
  
  // Обновляем кнопки
  prevBtn.disabled = currentPageNum === 1;
  nextBtn.disabled = currentPageNum === totalPages;
  
  // Обновляем инфо
  info.textContent = `Страница ${currentPageNum} из ${totalPages}`;
}

/**
 * Обновить статистику
 */
function updateStats(conversations) {
  // Подсчет статистики
  const total = conversations.length;
  
  // Диалоги за сегодня
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = conversations.filter(c => {
    const convDate = new Date(c.created_at);
    return convDate >= today;
  }).length;
  
  // Диалоги со звонков
  const phoneCount = conversations.filter(c => 
    c.caller_number && c.caller_number.trim() !== ''
  ).length;
  
  // Диалоги с виджета
  const widgetCount = total - phoneCount;
  
  // Обновляем UI
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-today').textContent = todayCount;
  document.getElementById('stat-phone').textContent = phoneCount;
  document.getElementById('stat-widget').textContent = widgetCount;
}

/**
 * Загрузить список ассистентов в фильтр
 */
async function loadAssistantFilter() {
  try {
    const assistants = await fetchAssistants();
    const select = document.getElementById('filter-assistant');
    
    // Очищаем старые опции (кроме первой)
    while (select.options.length > 1) {
      select.remove(1);
    }
    
    // Добавляем ассистентов
    assistants.forEach(assistant => {
      const option = document.createElement('option');
      option.value = assistant.id;
      option.textContent = assistant.name;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading assistants:', error);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Форматировать номер телефона
 */
function formatPhoneNumber(phone) {
  if (!phone) return 'Неизвестно';
  
  // Убираем "INBOUND: " если есть
  phone = phone.replace('INBOUND:', '').trim();
  
  // Форматируем номер
  if (phone.startsWith('+7') || phone.startsWith('7')) {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11) {
      return `+7 (${cleaned.substring(1, 4)}) ${cleaned.substring(4, 7)}-${cleaned.substring(7, 9)}-${cleaned.substring(9)}`;
    }
  }
  
  return phone;
}

/**
 * Форматировать дату и время
 */
function formatDateTime(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Форматировать только дату
 */
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/**
 * Форматировать длительность
 */
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0 сек';
  
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  
  if (mins > 0) {
    return `${mins} мин ${secs} сек`;
  }
  return `${secs} сек`;
}

/**
 * Экранирование HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Применить фильтры
 */
async function applyFilters() {
  const assistantId = document.getElementById('filter-assistant').value;
  const source = document.getElementById('filter-source').value;
  const dateFrom = document.getElementById('filter-date-from').value;
  const dateTo = document.getElementById('filter-date-to').value;
  
  currentFilters = {
    assistant_id: assistantId || null,
    source: source || null,
    date_from: dateFrom || null,
    date_to: dateTo || null
  };
  
  currentPage = 0;
  await loadConversations();
}

/**
 * Сбросить фильтры
 */
async function clearFilters() {
  document.getElementById('filter-assistant').value = '';
  document.getElementById('filter-source').value = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value = '';
  
  currentFilters = {
    assistant_id: null,
    source: null,
    date_from: null,
    date_to: null
  };
  
  currentPage = 0;
  await loadConversations();
}

/**
 * Переключение страниц
 */
async function goToPage(direction) {
  if (direction === 'prev') {
    currentPage = Math.max(0, currentPage - 1);
  } else {
    currentPage += 1;
  }
  
  await loadConversations();
}

/**
 * Закрыть модальное окно
 */
function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}

// ============================================================================
// MAIN LOAD FUNCTION
// ============================================================================

/**
 * Загрузить диалоги
 */
async function loadConversations() {
  const loading = document.getElementById('loading-overlay');
  
  try {
    loading.style.display = 'flex';
    
    const offset = currentPage * CONVERSATIONS_PER_PAGE;
    const data = await fetchConversations(offset);
    
    renderConversations(data);
    
    // Обновляем статистику (на основе всех загруженных данных)
    // В реальности нужен отдельный API endpoint для статистики
    updateStats(data.conversations);
    
  } catch (error) {
    console.error('Error loading conversations:', error);
    // 🆕 УЛУЧШЕНО: Не показываем alert если редирект на login
    if (error.message !== 'Unauthorized') {
      alert('Ошибка загрузки диалогов');
    }
  } finally {
    loading.style.display = 'none';
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Проверка авторизации
  if (!checkAuth()) {
    return;
  }
  
  // 🆕 ДОБАВЛЕНО: Проверка подписки
  await checkSubscription();
  
  // Загрузка данных
  await loadAssistantFilter();
  await loadConversations();
  
  // Обработчики событий
  document.getElementById('apply-filters').addEventListener('click', applyFilters);
  document.getElementById('clear-filters').addEventListener('click', clearFilters);
  document.getElementById('prev-page').addEventListener('click', () => goToPage('prev'));
  document.getElementById('next-page').addEventListener('click', () => goToPage('next'));
  
  // Модальное окно
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeModal();
    }
  });
});

// ============================================================================
// LOGOUT FUNCTION
// ============================================================================

/**
 * 🆕 ДОБАВЛЕНО: Выход из системы
 */
function logout() {
  // Удаляем токен
  localStorage.removeItem('access_token');
  
  // Перенаправляем на главную страницу
  window.location.href = '/static/index.html';
}

// Экспортируем для использования в HTML (onclick="logout()")
window.logout = logout;
