import React from 'react';
import Icon from './Icon';

function Products({ onOpenModal }) {
  return (
    <section className="lp-section lp-section-alt" id="products">
      <div className="lp-container">
        <div className="lp-head rev">
          <span className="lp-eyebrow">Два инструмента</span>
          <h2>Ассистент отвечает. Агент звонит сам</h2>
          <p className="lp-lead">Выберите один или используйте оба: они работают в одном кабинете и на одной телефонии.</p>
        </div>
        <div className="lp-products">
          <div className="card lp-product rev">
            <div className="lp-product-head">
              <span className="lp-icon-box"><Icon name="audio-lines" /></span>
              <div>
                <h3>Голосовой ассистент</h3>
                <p className="lp-product-sub">Отвечает, когда к нему обращаются</p>
              </div>
            </div>
            <ul className="lp-checks">
              <li><Icon name="check" className="ic-sm" />Принимает входящие звонки круглосуточно</li>
              <li><Icon name="check" className="ic-sm" />Разговаривает с посетителями сайта через виджет</li>
              <li><Icon name="check" className="ic-sm" />Отвечает по базе знаний, записывает в CRM и таблицы</li>
              <li><Icon name="check" className="ic-sm" />Исходящие по вашему событию через API</li>
            </ul>
            <div className="lp-product-foot">
              <span className="chip">Минуты с кошелька</span>
              <a href="#how" className="lp-link">Собрать ассистента<Icon name="arrow-right" className="ic-sm" /></a>
            </div>
          </div>
          <div className="card lp-product lp-product-agent rev d1">
            <div className="lp-product-head">
              <span className="lp-icon-box lp-icon-box-violet"><Icon name="headset" /></span>
              <div>
                <h3>Агент</h3>
                <p className="lp-product-sub">Сотрудник, который сам ведёт клиентов</p>
              </div>
            </div>
            <ul className="lp-checks">
              <li><Icon name="check" className="ic-sm" />Сам звонит по базе, перезванивает, планирует следующий шаг</li>
              <li><Icon name="check" className="ic-sm" />Помнит каждого клиента и ведёт его по воронке</li>
              <li><Icon name="check" className="ic-sm" />Пишет в Telegram и MAX, отвечает на SMS</li>
              <li><Icon name="check" className="ic-sm" />Отчитывается вам в чате обычными словами</li>
            </ul>
            <div className="lp-product-foot">
              <span className="chip chip-accent">Тариф Agent</span>
              <a href="#agent" className="lp-link">Как он работает<Icon name="arrow-right" className="ic-sm" /></a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Products;
