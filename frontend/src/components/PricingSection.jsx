import React from 'react';

const plans = [
  {
    name: 'Пробный',
    desc: 'Попробуйте все функции',
    price: '0 ₽',
    period: '3 дня',
    badge: 'Бесплатно',
    badgeClass: 'free',
    featured: false,
    features: [
      { text: '1 ассистент', highlight: true, enabled: true },
      { text: 'Виджет на сайт', enabled: true },
      { text: 'CRM-система', enabled: true },
      { text: 'Телефония', enabled: true },
      { text: 'База знаний', enabled: true },
      { text: 'Диалоги', enabled: true },
      { text: 'AI Jarvis', enabled: true },
      { text: 'Реферальная программа', enabled: true },
    ],
  },
  {
    name: 'AI Voice',
    desc: 'Голосовой бот для сайта',
    price: '1 490 ₽',
    period: '/мес',
    badge: 'Базовый',
    badgeClass: 'basic',
    featured: false,
    features: [
      { text: 'до 3 ассистентов', highlight: true, enabled: true },
      { text: 'Виджет на сайт', enabled: true },
      { text: 'CRM-система', enabled: false },
      { text: 'Телефония', enabled: false },
      { text: 'База знаний', enabled: true },
      { text: 'Диалоги', enabled: true },
      { text: 'AI Jarvis', enabled: true },
      { text: 'Реферальная программа', enabled: true },
    ],
  },
  {
    name: 'Старт',
    desc: 'Полный функционал',
    price: '2 990 ₽',
    period: '/мес',
    badge: 'Популярный',
    badgeClass: 'popular',
    featured: true,
    features: [
      { text: 'до 5 ассистентов', highlight: true, enabled: true },
      { text: 'Виджет на сайт', enabled: true },
      { text: 'CRM-система', enabled: true },
      { text: 'Телефония', enabled: true },
      { text: 'База знаний', enabled: true },
      { text: 'Диалоги', enabled: true },
      { text: 'AI Jarvis', enabled: true },
      { text: 'Реферальная программа', enabled: true },
      { text: 'Приоритетная поддержка', enabled: true },
    ],
  },
  {
    name: 'Profi',
    desc: 'Для серьёзного бизнеса',
    price: '5 990 ₽',
    period: '/мес',
    badge: 'Максимум',
    badgeClass: 'premium',
    featured: false,
    features: [
      { text: 'до 10 ассистентов', highlight: true, enabled: true },
      { text: 'Виджет на сайт', enabled: true },
      { text: 'CRM-система', enabled: true },
      { text: 'Телефония', enabled: true },
      { text: 'База знаний', enabled: true },
      { text: 'Диалоги', enabled: true },
      { text: 'AI Jarvis', enabled: true },
      { text: 'Реферальная программа', enabled: true },
      { text: 'VIP поддержка', enabled: true },
    ],
  },
];

function PricingSection({ onOpenRegister }) {
  return (
    <section className="pricing" id="pricing">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--dark">
            Тарифы без скрытых условий
          </h2>
          <p className="section-subtitle section-subtitle--dark">
            Начните бесплатно на 3 дня. Карта не нужна.
          </p>
        </div>

        <div className="pricing-grid">
          {plans.map((plan, index) => (
            <div
              key={plan.name}
              className={`pricing-card${plan.featured ? ' pricing-card--featured' : ''}`}
              data-animate="fade-up"
              data-delay={String((index + 1) * 100)}
            >
              <div className={`pricing-badge pricing-badge--${plan.badgeClass}`}>
                {plan.badge}
              </div>

              <div className="pricing-card-name">{plan.name}</div>
              <div className="pricing-card-desc">{plan.desc}</div>

              <div className="pricing-price-row">
                <span className={`pricing-amount${plan.featured ? ' pricing-amount--featured' : ''}`}>
                  {plan.price}
                </span>
                <span className="pricing-period">{plan.period}</span>
              </div>

              <div className="pricing-features-list">
                {plan.features.map((f, fi) => (
                  <div
                    key={fi}
                    className={`pricing-feature-item${!f.enabled ? ' pricing-feature-item--disabled' : ''}${f.highlight ? ' pricing-feature-item--highlight' : ''}`}
                  >
                    <i className={f.enabled ? 'fas fa-check' : 'fas fa-times'}></i>
                    <span>{f.text}</span>
                  </div>
                ))}
              </div>

              <button
                className={`pricing-cta ${plan.featured ? 'pricing-cta--primary' : 'pricing-cta--outline'}`}
                onClick={onOpenRegister}
              >
                Начать &rarr;
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default PricingSection;
