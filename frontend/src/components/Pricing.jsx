import React from 'react';
import Icon from './Icon';

// Тарифы. Кнопки открывают регистрацию, как и раньше.
const PLANS = [
  {
    key: 'trial', badge: 'Начните с него', badgeClass: 'chip-success', name: 'Пробный', desc: 'Все функции на 3 дня',
    price: '0 ₽', period: '/ 3 дня', cta: 'Начать бесплатно', primary: true,
    items: [
      { text: '1 ассистент', hl: true },
      { text: 'Тестовый номер на 10 минут' },
      { text: 'Виджет на сайт' },
      { text: 'CRM-система' },
      { text: 'Телефония' },
      { text: 'База знаний' },
    ],
  },
  {
    key: 'voice', badge: 'Базовый', name: 'AI Voice', desc: 'Голосовой бот для сайта',
    price: '1 490 ₽', period: '/мес', cta: 'Выбрать',
    items: [
      { text: 'до 3 ассистентов', hl: true },
      { text: 'Виджет на сайт' },
      { text: 'CRM-система', off: true },
      { text: 'Телефония', off: true },
      { text: 'База знаний' },
      { text: 'Функции и вебхуки' },
    ],
  },
  {
    key: 'start', badge: 'Популярный', badgeClass: 'chip-accent', name: 'Старт', desc: 'Полный функционал', hot: true,
    price: '2 990 ₽', period: '/мес', cta: 'Начать',
    items: [
      { text: 'до 5 ассистентов', hl: true },
      { text: 'Виджет на сайт' },
      { text: 'CRM-система' },
      { text: 'Телефония' },
      { text: 'База знаний' },
      { text: 'Приоритетная поддержка' },
    ],
  },
  {
    key: 'profi', badge: 'Максимум', badgeClass: 'chip-warning', name: 'Profi', desc: 'Для серьёзного бизнеса',
    price: '5 990 ₽', period: '/мес', cta: 'Выбрать',
    items: [
      { text: 'до 10 ассистентов', hl: true },
      { text: 'Виджет на сайт' },
      { text: 'CRM-система' },
      { text: 'Телефония' },
      { text: 'База знаний' },
      { text: 'VIP поддержка' },
    ],
  },
  {
    key: 'agent', badge: 'Автономный', badgeClass: 'chip-violet', name: 'Agent', desc: 'Сотрудник, который звонит сам', agent: true,
    price: '5 490 ₽', period: '/мес', cta: 'Выбрать',
    items: [
      { text: 'до 3 агентов', hl: true },
      { text: 'Сам звонит и ведёт клиентов' },
      { text: '20 000 кредитов в месяц' },
      { text: 'CRM и воронка продаж' },
      { text: 'Телефония' },
      { text: 'База знаний' },
    ],
  },
];

function Pricing({ onOpenModal }) {
  return (
    <section className="lp-section" id="pricing">
      <div className="lp-container">
        <div className="lp-head rev">
          <span className="lp-eyebrow">Тарифы</span>
          <h2>Простые и честные цены</h2>
          <p className="lp-lead">Начните с пробного периода: три дня со всеми функциями. Дальше выберите тариф по числу ассистентов.</p>
        </div>
        <div className="lp-plans">
          {PLANS.map((p, i) => (
            <article key={p.key} className={`card lp-plan${p.hot ? ' lp-plan-hot' : ''}${p.agent ? ' lp-plan-agent' : ''} rev d${i}`}>
              <span className={`chip ${p.badgeClass || ''}`.trim()}>{p.badge}</span>
              <h3>{p.name}</h3>
              <p className="lp-plan-desc">{p.desc}</p>
              <div className="lp-plan-price"><b>{p.price}</b><small>{p.period}</small></div>
              <ul className="lp-plan-list">
                {p.items.map((it) => (
                  <li key={it.text} className={it.off ? 'off' : ''}>
                    <Icon name={it.off ? 'x' : 'check'} className="ic-sm" />
                    {it.hl ? <b>{it.text}</b> : it.text}
                  </li>
                ))}
              </ul>
              {p.agent && <a href="#agent" className="lp-link lp-plan-more">Как это работает<Icon name="arrow-right" className="ic-sm" /></a>}
              <button
                type="button"
                className={`btn btn-lg${p.primary || p.hot ? ' btn-primary' : ''}`}
                onClick={() => onOpenModal('register')}
              >
                {p.cta}
              </button>
            </article>
          ))}
        </div>
        <p className="lp-plans-note rev">
          <Icon name="info" className="ic-sm" />
          Подписка оплачивает доступ к функциям и лимит ассистентов. Минуты голосовой модели, связь и кредиты агента
          в неё не входят и списываются отдельно на любом тарифе. Со своим ключом провайдера минуты бесплатны.
        </p>
      </div>
    </section>
  );
}

export default Pricing;
