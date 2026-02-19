import React from 'react';

function UseCasesSection() {
  return (
    <section className="use-cases-section">
      <div className="use-cases-container">
        <div className="use-cases-header">
          <h2 className="use-cases-title">Для чего использовать Voicyfy?</h2>
          <p className="use-cases-subtitle">
            Интегрируйте голосовых ИИ-ассистентов в любые каналы коммуникации для автоматизации общения с клиентами
          </p>
        </div>

        <div className="use-cases-grid">
          <div className="use-case-card">
            <div className="use-case-icon">
              <i className="fas fa-globe"></i>
            </div>
            <h3 className="use-case-title">Встроить на сайт</h3>
            <p className="use-case-description">
              Добавьте голосового ассистента на ваш сайт одной строкой кода. Ассистент будет общаться с посетителями голосом в режиме реального времени.
            </p>
            <ul className="use-case-features">
              <li><i className="fas fa-check"></i> Простая интеграция через HTML-код</li>
              <li><i className="fas fa-check"></i> Настраиваемый внешний вид виджета</li>
              <li><i className="fas fa-check"></i> Работа на любых платформах</li>
              <li><i className="fas fa-check"></i> Мгновенные ответы на вопросы 24/7</li>
            </ul>
          </div>

          <div className="use-case-card">
            <div className="use-case-icon">
              <i className="fas fa-phone"></i>
            </div>
            <h3 className="use-case-title">Подключить к телефонии</h3>
            <p className="use-case-description">
              Интегрируйте ИИ-ассистента с вашей телефонной системой для автоматизации входящих и исходящих звонков.
            </p>
            <ul className="use-case-features">
              <li><i className="fas fa-check"></i> Интеграция с SIP/VoIP системами</li>
              <li><i className="fas fa-check"></i> Обработка входящих звонков</li>
              <li><i className="fas fa-check"></i> Автоматические исходящие звонки</li>
              <li><i className="fas fa-check"></i> Запись и аналитика разговоров</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export default UseCasesSection;
