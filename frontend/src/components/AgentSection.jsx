import React from 'react';
import Icon from './Icon';
import SectionHead from './SectionHead';
import { Reveal, Stagger, Item, Parallax } from './Reveal';
import { MockAgent } from './Mockups';

const DAY = [
  ['10:05', 'Недозвон', 'Марина не ответила. Перезвон поставлен на завтра, в карточке пометка: утром не берёт трубку.'],
  ['14:30', 'Перезвонила сама', 'Агент узнал номер и начал с сути. Марине интересны платья 44 размера, ближе к выходным.'],
  ['14:33', 'После разговора', 'Карточка обновлена, стадия «в работе». Подборка ушла в Telegram, задача: в пятницу напомнить о примерке.'],
  ['15:10', 'Переписка', '«А синее есть в наличии?» Агент отвечает по базе знаний и договаривается на субботу, 12:00.'],
  ['Вечер', 'Отчёт', 'Вы спрашиваете в чате, как прошёл обзвон. Дозвонился до 61, заинтересовались 23, записал 9.'],
];

function AgentSection({ onOpenModal }) {
  return (
    <section className="sec sec-tint tint-lavender" id="agent">
      <div className="lp-container">
        <SectionHead index="02" title="Агент. Сотрудник, который звонит сам, всё помнит и доводит до результата" lead="Вы описываете бизнес пятью полями обычными словами и загружаете базу контактов. Дальше агент звонит, пишет, перезванивает и отчитывается вам в чате. Он не болеет, не уходит в отпуск и не забывает." />

        <Parallax className="agent-mock" amount={30}><Reveal className="stack" y={28}><MockAgent /></Reveal></Parallax>

        <div className="agent-grid">
          <Reveal className="agent-split" x={-16} y={0}>
            <div className="split-col">
              <h3>Вы, один раз</h3>
              <ul className="rule-list">
                <li>Заполняете пять полей: кто вы, кому звоните, как говорите, что предлагаете, что считать успехом</li>
                <li>Загружаете базу контактов файлом xlsx или csv</li>
                <li>Подключаете номер и, если нужно, Telegram или MAX</li>
                <li>Отвечаете на уведомления о горячих клиентах</li>
              </ul>
            </div>
            <div className="split-col">
              <h3>Агент, каждый день</h3>
              <ul className="rule-list">
                <li>Звонит по базе и принимает входящие живым голосом</li>
                <li>Готовится к каждому звонку по карточке клиента</li>
                <li>После разговора записывает выводы и ставит следующий шаг</li>
                <li>Перезванивает недозвонам, пишет в Telegram, MAX и SMS</li>
                <li>Ведёт воронку: новый, в работе, успех, отказ, не звонить</li>
                <li>Отвечает на ваши вопросы по данным своей CRM</li>
              </ul>
            </div>
          </Reveal>
          <div className="agent-day">
            <Reveal y={12}><h3>Один день агента с одной клиенткой</h3><p className="muted">Шоурум одежды сообщает базе о новой коллекции.</p></Reveal>
            <Stagger as="ol" className="day" stagger={0.1}>
              {DAY.map(([t, title, text]) => (
                <Item as="li" key={t} x={16} y={0}>
                  <span className="day-time">{t}</span>
                  <div><b>{title}.</b> {text}</div>
                </Item>
              ))}
            </Stagger>
          </div>
        </div>

        <Reveal className="brains" y={16}>
          <div className="brains-head">
            <h3>Как устроен внутри</h3>
            <p className="muted">Две модели, у каждой своя инструкция. В живом звонке нельзя думать секундами: пауза, и клиент вешает трубку. Поэтому всё долгое мышление вынесено до и после звонка.</p>
          </div>
          <div className="brains-flow">
            <div className="flow-step"><span className="flow-who orch"><Icon name="brain" className="ic-sm" />Оркестратор</span><b>До звонка</b><p>Читает задачу, карточку и прошлые разговоры. Пишет первую фразу, тактику и факты.</p></div>
            <div className="flow-step"><span className="flow-who voice"><Icon name="audio-lines" className="ic-sm" />Голосовой агент</span><b>Звонок</b><p>Говорит на выбранной модели по плану, ищет ответы в базе знаний, вызывает функции.</p></div>
            <div className="flow-step"><span className="flow-who orch"><Icon name="brain" className="ic-sm" />Оркестратор</span><b>После звонка</b><p>Читает транскрипт, обновляет карточку, двигает по воронке, ставит перезвон или сообщение.</p></div>
          </div>
        </Reveal>

        <Reveal className="sec-actions" y={12}>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>Подключить агента<Icon name="arrow-right" /></button>
          <span className="muted">Тариф Agent: 5 490 ₽ в месяц, до трёх агентов, 20 000 кредитов. Один звонок около 20 кредитов.</span>
        </Reveal>
      </div>
    </section>
  );
}

export default AgentSection;
