import React from 'react';
import Icon from './Icon';

const DAY = [
  { t: '10:05', title: 'Недозвон.', text: 'Марина не ответила. Агент ставит перезвон на завтра и помечает в карточке: утром не берёт трубку.' },
  { t: '14:30', title: 'Перезвонила сама.', text: 'Агент узнаёт номер и начинает с сути. Марине интересны платья, 44 размер, ближе к выходным.' },
  { t: '14:33', title: 'После разговора.', text: 'Карточка обновлена, стадия «в работе». Подборка ушла в Telegram, задача: в пятницу напомнить о примерке.' },
  { t: '15:10', title: 'Переписка.', text: '«А синее есть в наличии?» Агент отвечает по базе знаний и договаривается на субботу в 12:00.' },
  { t: 'Вечер', title: 'Отчёт.', text: '«Как прошёл обзвон?» Дозвонился до 312, заинтересовались 87, записались 23. Недозвоны перезвонит завтра.' },
];

function AgentSection({ onOpenModal }) {
  return (
    <section className="lp-section lp-section-alt" id="agent">
      <div className="lp-container">
        <div className="lp-head rev">
          <span className="lp-eyebrow lp-eyebrow-violet">Агент</span>
          <h2>Сотрудник, который сам звонит, всё помнит и доводит до результата</h2>
          <p className="lp-lead">
            Представьте менеджера, который обзванивает базу, отвечает на входящие, помнит каждого клиента,
            сам перезванивает, пишет в мессенджеры и вечером присылает отчёт. Он не болеет и не забывает.
            Вы описываете бизнес обычными словами, загружаете контакты, дальше он работает сам.
          </p>
        </div>

        <div className="lp-cols">
          <div className="card lp-col rev">
            <div className="lp-col-head"><Icon name="user-round" />Вы, один раз</div>
            <ul className="lp-checks">
              <li><Icon name="check" className="ic-sm" />Заполняете пять полей: кто вы, кому звоните, как говорите, что предлагаете, что считать успехом</li>
              <li><Icon name="check" className="ic-sm" />Загружаете базу контактов файлом xlsx или csv</li>
              <li><Icon name="check" className="ic-sm" />Подключаете номер и, если нужно, Telegram или MAX</li>
              <li><Icon name="check" className="ic-sm" />Отвечаете на уведомления о горячих клиентах</li>
            </ul>
          </div>
          <div className="card lp-col lp-col-agent rev d1">
            <div className="lp-col-head"><Icon name="headset" />Агент, каждый день</div>
            <ul className="lp-checks">
              <li><Icon name="check" className="ic-sm" />Звонит по базе и принимает входящие живым голосом</li>
              <li><Icon name="check" className="ic-sm" />Готовится к каждому звонку по карточке клиента</li>
              <li><Icon name="check" className="ic-sm" />После разговора записывает выводы и ставит следующий шаг</li>
              <li><Icon name="check" className="ic-sm" />Перезванивает недозвонам, пишет в Telegram, MAX и SMS</li>
              <li><Icon name="check" className="ic-sm" />Ведёт воронку: новый, в работе, успех, отказ, не звонить</li>
            </ul>
          </div>
        </div>

        <div className="lp-agent-day rev">
          <div className="lp-agent-day-copy">
            <h3>Один день агента</h3>
            <p>В шоурум пришла новая коллекция. Владелица загрузила базу из 400 покупательниц и написала агенту: «Обзвони всех, расскажи о коллекции, кому интересно, отправь подборку и запиши на примерку». Вот его день с одной клиенткой.</p>
            <p>Тот же агент принимает входящие: в салоне красоты отвечает в 21:40, когда администратор ушёл, записывает, шлёт SMS с адресом и накануне напоминает о визите.</p>
          </div>
          <div className="card lp-day">
            {DAY.map((r) => (
              <div key={r.t} className="lp-day-row">
                <span className="lp-day-time">{r.t}</span>
                <div><b>{r.title}</b> {r.text}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="lp-brains rev">
          <div className="card lp-brain lp-brain-orch">
            <div className="lp-brain-head"><Icon name="brain" />Оркестратор</div>
            <p>Думает между звонками. Видит CRM, карточку клиента и историю, перед звонком пишет план, после звонка обновляет карточку и ставит задачи.</p>
          </div>
          <div className="lp-brains-link"><Icon name="arrow-right" /><span>передаёт план и первую фразу</span></div>
          <div className="card lp-brain lp-brain-voice">
            <div className="lp-brain-head"><Icon name="audio-lines" />Голосовой агент</div>
            <p>Говорит в живом звонке на выбранной модели. Отвечает мгновенно, ведёт разговор по плану и ищет ответы в базе знаний.</p>
          </div>
        </div>
        <p className="lp-note-text rev">
          Почему две модели? В живом разговоре нельзя думать секундами: пауза, и клиент вешает трубку.
          Всё долгое мышление вынесено до и после звонка, как бриф от руководителя менеджеру.
        </p>

        <div className="lp-center rev">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>
            Подключить агента<Icon name="arrow-right" />
          </button>
          <a href="#pricing" className="btn btn-lg">Тариф Agent</a>
        </div>
      </div>
    </section>
  );
}

export default AgentSection;
