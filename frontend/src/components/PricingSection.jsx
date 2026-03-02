import React from 'react';

function PricingSection({ onOpenModal }) {
  return (
    <section className="section pricing-section" id="pricing">
      <div className="section-inner">
        <div className="s-head rev">
          <span className="s-label">Тарифы</span>
          <h2 className="s-title">Простые и <span className="gt">честные цены</span></h2>
          <p className="s-desc">Начните бесплатно, масштабируйтесь по мере роста бизнеса</p>
        </div>

        <div className="price-grid">
          {/* FREE */}
          <div className="price-card rev">
            <span className="pbadge pb-free">Бесплатно</span>
            <h4>Пробный</h4>
            <p className="price-desc">Попробуйте все функции</p>
            <div className="price-amount"><span className="pamt">0 ₽</span> <small>/ 3 дня</small></div>
            <ul className="pf-list">
              <li className="pf-item"><i className="fas fa-check"></i> <span className="hl">1 ассистент</span></li>
              <li className="pf-item"><i className="fas fa-check"></i> Виджет на сайт</li>
              <li className="pf-item"><i className="fas fa-check"></i> CRM-система</li>
              <li className="pf-item"><i className="fas fa-check"></i> Телефония</li>
              <li className="pf-item"><i className="fas fa-check"></i> База знаний</li>
              <li className="pf-item"><i className="fas fa-check"></i> AI Jarvis</li>
            </ul>
            <button className="price-btn pb-ghost" onClick={() => onOpenModal('register')}>Начать бесплатно</button>
          </div>

          {/* AI VOICE */}
          <div className="price-card rev d1">
            <span className="pbadge pb-basic">Базовый</span>
            <h4>AI Voice</h4>
            <p className="price-desc">Голосовой бот для сайта</p>
            <div className="price-amount"><span className="pamt">1 490 ₽</span> <small>/мес</small></div>
            <ul className="pf-list">
              <li className="pf-item"><i className="fas fa-check"></i> <span className="hl">до 3 ассистентов</span></li>
              <li className="pf-item"><i className="fas fa-check"></i> Виджет на сайт</li>
              <li className="pf-item disabled"><i className="fas fa-times"></i> CRM-система</li>
              <li className="pf-item disabled"><i className="fas fa-times"></i> Телефония</li>
              <li className="pf-item"><i className="fas fa-check"></i> База знаний</li>
              <li className="pf-item"><i className="fas fa-check"></i> AI Jarvis</li>
            </ul>
            <button className="price-btn pb-ghost" onClick={() => onOpenModal('register')}>Выбрать</button>
          </div>

          {/* START (POPULAR) */}
          <div className="price-card hot rev d2">
            <span className="pbadge pb-pop">Популярный</span>
            <h4>Старт</h4>
            <p className="price-desc">Полный функционал</p>
            <div className="price-amount"><span className="pamt">2 990 ₽</span> <small>/мес</small></div>
            <ul className="pf-list">
              <li className="pf-item"><i className="fas fa-check"></i> <span className="hl">до 5 ассистентов</span></li>
              <li className="pf-item"><i className="fas fa-check"></i> Виджет на сайт</li>
              <li className="pf-item"><i className="fas fa-check"></i> CRM-система</li>
              <li className="pf-item"><i className="fas fa-check"></i> Телефония</li>
              <li className="pf-item"><i className="fas fa-check"></i> База знаний</li>
              <li className="pf-item"><i className="fas fa-check"></i> Приоритетная поддержка</li>
            </ul>
            <button className="price-btn pb-solid" onClick={() => onOpenModal('register')}>Начать</button>
          </div>

          {/* PROFI */}
          <div className="price-card rev d3">
            <span className="pbadge pb-prem">Максимум</span>
            <h4>Profi</h4>
            <p className="price-desc">Для серьёзного бизнеса</p>
            <div className="price-amount"><span className="pamt">5 990 ₽</span> <small>/мес</small></div>
            <ul className="pf-list">
              <li className="pf-item"><i className="fas fa-check"></i> <span className="hl">до 10 ассистентов</span></li>
              <li className="pf-item"><i className="fas fa-check"></i> Виджет на сайт</li>
              <li className="pf-item"><i className="fas fa-check"></i> CRM-система</li>
              <li className="pf-item"><i className="fas fa-check"></i> Телефония</li>
              <li className="pf-item"><i className="fas fa-check"></i> База знаний</li>
              <li className="pf-item"><i className="fas fa-check"></i> VIP поддержка</li>
            </ul>
            <button className="price-btn pb-ghost" onClick={() => onOpenModal('register')}>Выбрать</button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default PricingSection;
