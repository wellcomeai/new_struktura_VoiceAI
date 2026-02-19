import React from 'react';

function CrmSection() {
  return (
    <section className="crm" id="crm">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--dark">
            Встроенная CRM — ничего лишнего
          </h2>
          <p className="section-subtitle section-subtitle--dark">
            Каждый звонок автоматически создаёт или обновляет контакт.
            ИИ сам ставит задачи на перезвон — или вы делаете это вручную.
          </p>
        </div>

        <div className="crm-grid">
          {/* Left: Features */}
          <div className="crm-features">
            <div className="crm-feature" data-animate="fade-right" data-delay="100">
              <span className="crm-feature-number">01</span>
              <div className="crm-feature-content">
                <h4>Автоматические контакты</h4>
                <p>Каждый новый номер → новый контакт. История всех звонков сохраняется.</p>
              </div>
            </div>
            <div className="crm-feature" data-animate="fade-right" data-delay="200">
              <span className="crm-feature-number">02</span>
              <div className="crm-feature-content">
                <h4>Задачи от ИИ</h4>
                <p>Клиент просит перезвонить? ИИ сам ставит задачу в CRM через функцию.</p>
              </div>
            </div>
            <div className="crm-feature" data-animate="fade-right" data-delay="300">
              <span className="crm-feature-number">03</span>
              <div className="crm-feature-content">
                <h4>Ручное управление</h4>
                <p>Вы тоже можете поставить задачу: выберите контакт, ассистента, время.</p>
              </div>
            </div>
            <div className="crm-feature" data-animate="fade-right" data-delay="400">
              <span className="crm-feature-number">04</span>
              <div className="crm-feature-content">
                <h4>Исходящий по расписанию</h4>
                <p>В нужное время ИИ автоматически совершает звонок по задаче.</p>
              </div>
            </div>
          </div>

          {/* Right: CRM Mockup */}
          <div className="crm-mockup" data-animate="fade-left" data-delay="200">
            <div className="crm-mockup-header">
              <span className="crm-mockup-title">Контакты</span>
              <span className="crm-mockup-add">+ Новый</span>
            </div>
            <div className="crm-mockup-body">
              <div className="crm-contact">
                <div className="crm-contact-header">
                  <div className="crm-contact-avatar">
                    <i className="fas fa-user"></i>
                  </div>
                  <span className="crm-contact-name">Иван Петров</span>
                </div>
                <div className="crm-contact-details">
                  <span className="crm-contact-detail">+7 925 *** ****</span>
                  <span className="crm-contact-detail">Последний звонок: сегодня</span>
                  <span className="crm-contact-task">
                    <i className="fas fa-clock"></i> Задача: перезвонить в 15:00
                  </span>
                </div>
              </div>
              <div className="crm-contact">
                <div className="crm-contact-header">
                  <div className="crm-contact-avatar">
                    <i className="fas fa-user"></i>
                  </div>
                  <span className="crm-contact-name">Анна Смирнова</span>
                </div>
                <div className="crm-contact-details">
                  <span className="crm-contact-detail">+7 916 *** ****</span>
                  <span className="crm-contact-detail">Звонков: 3</span>
                  <span className="crm-contact-status crm-contact-status--client">
                    <i className="fas fa-circle" style={{ fontSize: 6 }}></i> Клиент
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default CrmSection;
