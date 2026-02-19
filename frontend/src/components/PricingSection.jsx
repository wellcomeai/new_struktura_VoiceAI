import React from 'react';

function PricingSection() {
  return (
    <section className="pricing-section">
      <div className="pricing-container">
        <div className="pricing-header">
          <h2 className="pricing-title">Тарифы и стоимость</h2>
          <p className="pricing-subtitle">
            Выберите подходящий план для создания голосовых ИИ-ассистентов
          </p>
        </div>

        <div className="pricing-plans">
          {/* FREE */}
          <div className="pricing-card">
            <div className="pricing-badge free">Бесплатно</div>
            <div className="pricing-card-header">
              <h3>Пробный</h3>
              <p className="pricing-card-description">Попробуйте все функции</p>
            </div>
            <div className="pricing-price">
              <span className="price-amount">0 &#8381;</span>
              <span className="price-period">3 дня</span>
            </div>
            <div className="pricing-features">
              <ul>
                <li><i className="fas fa-check"></i> <span className="highlight">1 ассистент</span></li>
                <li><i className="fas fa-check"></i> Виджет на сайт</li>
                <li><i className="fas fa-check"></i> CRM-система</li>
                <li><i className="fas fa-check"></i> Телефония</li>
                <li><i className="fas fa-check"></i> База знаний</li>
                <li><i className="fas fa-check"></i> Диалоги</li>
                <li><i className="fas fa-check"></i> AI Jarvis</li>
                <li><i className="fas fa-check"></i> Реферальная программа</li>
              </ul>
            </div>
          </div>

          {/* AI VOICE */}
          <div className="pricing-card">
            <div className="pricing-badge basic">Базовый</div>
            <div className="pricing-card-header">
              <h3>AI Voice</h3>
              <p className="pricing-card-description">Голосовой бот для сайта</p>
            </div>
            <div className="pricing-price">
              <span className="price-amount">1 490 &#8381;</span>
              <span className="price-period">/мес</span>
            </div>
            <div className="pricing-features">
              <ul>
                <li><i className="fas fa-check"></i> <span className="highlight">до 3 ассистентов</span></li>
                <li><i className="fas fa-check"></i> Виджет на сайт</li>
                <li className="feature-disabled"><i className="fas fa-times"></i> CRM-система</li>
                <li className="feature-disabled"><i className="fas fa-times"></i> Телефония</li>
                <li><i className="fas fa-check"></i> База знаний</li>
                <li><i className="fas fa-check"></i> Диалоги</li>
                <li><i className="fas fa-check"></i> AI Jarvis</li>
                <li><i className="fas fa-check"></i> Реферальная программа</li>
              </ul>
            </div>
          </div>

          {/* START (POPULAR) */}
          <div className="pricing-card featured">
            <div className="pricing-badge popular">Популярный</div>
            <div className="pricing-card-header">
              <h3>Старт</h3>
              <p className="pricing-card-description">Полный функционал</p>
            </div>
            <div className="pricing-price">
              <span className="price-amount">2 990 &#8381;</span>
              <span className="price-period">/мес</span>
            </div>
            <div className="pricing-features">
              <ul>
                <li><i className="fas fa-check"></i> <span className="highlight">до 5 ассистентов</span></li>
                <li><i className="fas fa-check"></i> Виджет на сайт</li>
                <li><i className="fas fa-check"></i> CRM-система</li>
                <li><i className="fas fa-check"></i> Телефония</li>
                <li><i className="fas fa-check"></i> База знаний</li>
                <li><i className="fas fa-check"></i> Диалоги</li>
                <li><i className="fas fa-check"></i> AI Jarvis</li>
                <li><i className="fas fa-check"></i> Реферальная программа</li>
                <li><i className="fas fa-check"></i> Приоритетная поддержка</li>
              </ul>
            </div>
          </div>

          {/* PROFI */}
          <div className="pricing-card">
            <div className="pricing-badge premium">Максимум</div>
            <div className="pricing-card-header">
              <h3>Profi</h3>
              <p className="pricing-card-description">Для серьёзного бизнеса</p>
            </div>
            <div className="pricing-price">
              <span className="price-amount">5 990 &#8381;</span>
              <span className="price-period">/мес</span>
            </div>
            <div className="pricing-features">
              <ul>
                <li><i className="fas fa-check"></i> <span className="highlight">до 10 ассистентов</span></li>
                <li><i className="fas fa-check"></i> Виджет на сайт</li>
                <li><i className="fas fa-check"></i> CRM-система</li>
                <li><i className="fas fa-check"></i> Телефония</li>
                <li><i className="fas fa-check"></i> База знаний</li>
                <li><i className="fas fa-check"></i> Диалоги</li>
                <li><i className="fas fa-check"></i> AI Jarvis</li>
                <li><i className="fas fa-check"></i> Реферальная программа</li>
                <li><i className="fas fa-check"></i> VIP поддержка</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default PricingSection;
