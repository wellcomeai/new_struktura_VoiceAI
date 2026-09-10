import React from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';

// CSS-макеты экранов кабинета: те же карточки, чипы и логотипы, что в ЛК
function MockAssistants() {
  return (
    <div className="mk">
      <div className="mk-row"><ModelLogo code="gemini" size={14} /><span className="mk-name">Менеджер по записи</span><span className="chip chip-success"><span className="dot dot-success"></span>активен</span></div>
      <div className="mk-row"><ModelLogo code="openai" size={14} /><span className="mk-name">Консультант на сайте</span><span className="chip">виджет</span></div>
      <div className="mk-row"><ModelLogo code="yandex" size={14} /><span className="mk-name">Приём заказов</span><span className="chip">телефония</span></div>
    </div>
  );
}

function MockTelephony() {
  return (
    <div className="mk">
      <div className="mk-row"><span className="mk-ic"><Icon name="phone" className="ic-sm" /></span><span className="mk-name mono">+7 495 ••• 12-40</span><span className="chip chip-success">отвечает «Менеджер»</span></div>
      <div className="mk-prices">
        <div><span className="mk-price-label"><Icon name="phone-incoming" className="ic-sm" />входящий</span><b>1,7 ₽/мин</b></div>
        <div><span className="mk-price-label"><Icon name="phone-outgoing" className="ic-sm" />исходящий</span><b>2,7 ₽/мин</b></div>
      </div>
    </div>
  );
}

function MockDialogs() {
  return (
    <div className="mk">
      <div className="mk-line"><span className="mk-ava">К</span><span>Есть свободное время на пятницу?</span></div>
      <div className="mk-line mk-line-bot"><span className="mk-ava mk-ava-bot"><Icon name="bot" className="ic-sm" /></span><span>Да, в 11:00 и 15:30. Какое удобнее?</span></div>
      <div className="mk-meta"><span className="chip"><Icon name="clock" className="ic-sm" />02:14</span><span className="chip"><Icon name="play" className="ic-sm" />запись</span><span className="chip chip-accent">запись создана</span></div>
    </div>
  );
}

function MockCrm() {
  return (
    <div className="mk">
      <div className="mk-row"><span className="mk-ava">М</span><div className="mk-col"><span className="mk-name">Марина Соколова</span><span className="mk-sub mono">+7 921 ••• 44-10</span></div><span className="chip chip-accent">в работе</span></div>
      <div className="mk-facts"><span className="chip chip-outline">платья, 44 размер</span><span className="chip chip-outline">удобно в субботу</span><span className="chip chip-outline">не звонить утром</span></div>
    </div>
  );
}

function MockKnowledge() {
  return (
    <div className="mk">
      <div className="mk-row"><span className="mk-ic"><Icon name="file-text" className="ic-sm" /></span><span className="mk-name">Прайс-лист 2026.pdf</span><span className="chip chip-success">проиндексирован</span></div>
      <div className="mk-row"><span className="mk-ic"><Icon name="file-text" className="ic-sm" /></span><span className="mk-name">Ответы на частые вопросы.docx</span><span className="chip chip-success">проиндексирован</span></div>
      <div className="mk-row mk-row-dash"><span className="mk-ic"><Icon name="upload" className="ic-sm" /></span><span className="mk-name muted">Перетащите файлы сюда</span></div>
    </div>
  );
}

function MockWallet() {
  return (
    <div className="mk">
      <div className="mk-balance"><span className="mk-sub">Кошелёк Voicyfy</span><b>1 240 ₽</b></div>
      <div className="mk-row"><span className="mk-ic"><Icon name="phone-call" className="ic-sm" /></span><span className="mk-name">Звонок · Gemini · 2:14</span><span className="mk-amt">−13,40 ₽</span></div>
      <div className="mk-row"><span className="mk-ic"><Icon name="plus" className="ic-sm" /></span><span className="mk-name">Пополнение</span><span className="mk-amt mk-amt-plus">+1 000 ₽</span></div>
    </div>
  );
}

const FEATURES = [
  { icon: 'audio-lines', title: 'Голосовые ассистенты', text: 'Пять моделей в одном конструкторе. Промпт, голос, функции и база знаний на одной странице.', mock: <MockAssistants /> },
  { icon: 'phone', title: 'Телефония', text: 'Купите номер в кабинете и привяжите ассистента. Входящие и исходящие, запись и логи каждого звонка.', mock: <MockTelephony /> },
  { icon: 'messages-square', title: 'Диалоги', text: 'Все разговоры сохраняются: расшифровка, запись, длительность и результат. Фильтры по дате и источнику.', mock: <MockDialogs /> },
  { icon: 'contact-round', title: 'CRM', text: 'Карточки клиентов создаются из разговоров сами: контакты, факты, стадия воронки и история общения.', mock: <MockCrm /> },
  { icon: 'book-open', title: 'База знаний', text: 'Загрузите прайсы и инструкции в любом формате. Ассистент находит нужный факт прямо во время разговора.', mock: <MockKnowledge /> },
  { icon: 'wallet', title: 'Кошелёк', text: 'Посекундная оплата минут по тарифу модели. Со своим ключом провайдера разговоры бесплатны.', mock: <MockWallet /> },
];

function Platform() {
  return (
    <section className="lp-section" id="platform">
      <div className="lp-container">
        <div className="lp-head rev">
          <span className="lp-eyebrow">Платформа</span>
          <h2>Всё для голосового ИИ в одном кабинете</h2>
          <p className="lp-lead">Ассистенты, телефония, диалоги, CRM, база знаний и кошелёк. Никаких сторонних сервисов и интеграций для старта.</p>
        </div>
        <div className="lp-features">
          {FEATURES.map((f, i) => (
            <article key={f.title} className={`card lp-feature rev d${i % 3}`}>
              <div className="lp-feature-mock">{f.mock}</div>
              <div className="lp-feature-body">
                <span className="lp-icon-box lp-icon-box-sm"><Icon name={f.icon} /></span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default Platform;
