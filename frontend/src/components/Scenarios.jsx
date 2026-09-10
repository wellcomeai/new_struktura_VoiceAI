import React from 'react';
import SectionHead from './SectionHead';
import { Stagger, Item } from './Reveal';

const CASES = [
  ['Салон красоты', 'Входящие без администратора', 'Отвечает в 21:40, когда администратор ушёл. Называет свободное время по базе знаний, записывает, подтверждает SMS, накануне напоминает. Постоянных клиентов узнаёт.', 'Ассистент'],
  ['Шоурум', 'Уведомить базу о поступлении', 'Обзванивает 400 покупательниц о новой коллекции. Заинтересованным отправляет подборку в Telegram, ведёт переписку и записывает на примерку.', 'Агент'],
  ['Автосервис', 'Подтверждение и перенос записи', 'Накануне звонит с напоминанием, переносит по просьбе клиента, отправляет SMS с новым временем и обновляет календарь.', 'Агент'],
  ['Клиника', 'Регистратура и реактивация', 'Принимает записи и переносы круглосуточно. Пациентам, которые не были больше полугода, напоминает о профилактическом осмотре.', 'Ассистент и агент'],
];

function Scenarios() {
  return (
    <section className="sec sec-tint tint-sand" id="cases">
      <div className="lp-container">
        <SectionHead index="05" title="Где это работает" lead="Четыре задачи, с которых обычно начинают. Каждая настраивается словами в промпте, без программирования." />
        <Stagger as="ul" className="cases" stagger={0.1}>
          {CASES.map(([who, title, text, tool]) => (
            <Item as="li" key={title} y={18}>
              <span className="cases-who">{who}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
              <span className={`chip${tool.startsWith('Агент') ? ' chip-accent' : ''}`}>{tool}</span>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

export default Scenarios;
