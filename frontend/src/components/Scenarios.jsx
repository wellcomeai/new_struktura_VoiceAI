import React from 'react';
import Icon from './Icon';

const CASES = [
  { icon: 'phone-incoming', title: 'Входящие без администратора', who: 'Салон, клиника, сервис', text: 'Отвечает круглосуточно, называет свободное время по базе знаний, записывает, подтверждает SMS и напоминает накануне. Постоянных клиентов узнаёт.', tool: 'Ассистент' },
  { icon: 'phone-outgoing', title: 'Уведомить базу', who: 'Магазин, шоурум, школа', text: 'Обзванивает клиентов о поступлении, акции или новой услуге. Заинтересованным отправляет подборку в мессенджер и ведёт переписку до записи.', tool: 'Агент' },
  { icon: 'refresh-cw', title: 'Вернуть уснувших', who: 'Любой бизнес с базой', text: 'Напоминает о себе тем, кто давно не приходил, предлагает повод вернуться и отмечает в воронке, кто откликнулся.', tool: 'Агент' },
  { icon: 'globe', title: 'Консультант на сайте', who: 'Интернет-магазин, услуги', text: 'Голосовой виджет отвечает на вопросы посетителей по вашим материалам и передаёт контакты в CRM.', tool: 'Ассистент' },
];

function Scenarios() {
  return (
    <section className="lp-section lp-section-alt" id="cases">
      <div className="lp-container">
        <div className="lp-head rev">
          <span className="lp-eyebrow">Сценарии</span>
          <h2>Где это приносит результат</h2>
          <p className="lp-lead">Четыре типовых задачи, с которых обычно начинают. Каждая настраивается словами, без программирования.</p>
        </div>
        <div className="lp-cases">
          {CASES.map((c, i) => (
            <article key={c.title} className={`card lp-case rev d${i}`}>
              <span className="lp-icon-box lp-icon-box-sm"><Icon name={c.icon} /></span>
              <h3>{c.title}</h3>
              <p className="lp-case-who">{c.who}</p>
              <p>{c.text}</p>
              <span className={`chip${c.tool === 'Агент' ? ' chip-accent' : ''}`}>{c.tool}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default Scenarios;
