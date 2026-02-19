import React from 'react';

function IntegrationsSection() {
  return (
    <section className="integrations" id="integrations">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--dark">
            Интеграции за 2 минуты
          </h2>
          <p className="section-subtitle section-subtitle--dark">
            Подключите Telegram для мгновенных уведомлений,
            или отправляйте данные в любую систему через webhook.
          </p>
        </div>

        <div className="integrations-grid">
          {/* Telegram card */}
          <div className="integration-card" data-animate="fade-up" data-delay="100">
            <div className="integration-card-icon integration-card-icon--telegram">
              <i className="fab fa-telegram"></i>
            </div>
            <h3 className="integration-card-title">Telegram уведомления</h3>
            <p className="integration-card-desc">
              Подключите бота — и при каждом звонке
              вы получите в Telegram:
            </p>
            <div className="integration-card-list">
              <div className="integration-card-list-item">Номер звонившего</div>
              <div className="integration-card-list-item">Длительность разговора</div>
              <div className="integration-card-list-item">Ссылку на запись</div>
              <div className="integration-card-list-item">Краткое резюме</div>
            </div>
            <div className="integration-card-time">
              <i className="fas fa-clock"></i> Время подключения: ~2 минуты
            </div>

            {/* Telegram mockup */}
            <div className="integration-telegram-mockup">
              <div className="integration-telegram-msg">
                <div className="integration-telegram-avatar">
                  <i className="fas fa-robot"></i>
                </div>
                <div className="integration-telegram-bubble">
                  <strong>Voicyfy Bot</strong>
                  Новый звонок: +7 925 ***<br />
                  Длительность: 2м 34с<br />
                  Резюме: Клиент интересовался тарифами
                </div>
              </div>
            </div>
          </div>

          {/* Webhook card */}
          <div className="integration-card" data-animate="fade-up" data-delay="200">
            <div className="integration-card-icon integration-card-icon--webhook">
              <i className="fas fa-plug"></i>
            </div>
            <h3 className="integration-card-title">Webhook &amp; Автоматизации</h3>
            <p className="integration-card-desc">
              Отправляйте данные в любую систему: вашу CRM, n8n, Make.com, Zapier —
              или используйте встроенную CRM Voicyfy.
            </p>
            <p className="integration-card-desc" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Данные каждого звонка:
            </p>

            {/* JSON mockup */}
            <div className="integration-json">
              <pre>{`{
  `}<span className="json-key">"phone"</span>{`: `}<span className="json-string">"+7 925 123-45-67"</span>{`,
  `}<span className="json-key">"duration"</span>{`: `}<span className="json-number">154</span>{`,
  `}<span className="json-key">"transcript"</span>{`: `}<span className="json-string">"..."</span>{`,
  `}<span className="json-key">"assistant"</span>{`: `}<span className="json-string">"Консультант"</span>{`
}`}</pre>
            </div>

            {/* Tool logos */}
            <div className="integration-logos">
              <span className="integration-logo-chip">Voicyfy CRM</span>
              <span className="integration-logo-chip">n8n</span>
              <span className="integration-logo-chip">Make</span>
              <span className="integration-logo-chip">Zapier</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default IntegrationsSection;
