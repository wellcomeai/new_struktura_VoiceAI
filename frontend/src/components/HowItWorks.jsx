import React from 'react';
import Icon from './Icon';

const STEPS = [
  {
    title: 'Создайте ассистента',
    text: 'Дайте имя, выберите модель и голос. В промпте опишите роль, компанию и как вести разговор. База знаний и функции нужны, чтобы он отвечал по фактам и записывал клиентов.',
  },
  {
    title: 'Позвоните ему',
    text: 'Арендуйте тестовый номер на 10 минут и позвоните с любого телефона. Пока идёт тест, меняйте модель: номер перепривяжется сам, и вы послушаете все голоса.',
  },
  {
    title: 'Подключите свой номер',
    text: 'Пройдите верификацию, по закону РФ без неё нельзя держать номера, купите номер и привяжите ассистента. Он начнёт отвечать на входящие.',
  },
];

function HowItWorks({ onOpenModal }) {
  return (
    <section className="lp-section" id="how">
      <div className="lp-container">
        <div className="lp-head rev">
          <span className="lp-eyebrow">Как это работает</span>
          <h2>Три шага до первого разговора</h2>
          <p className="lp-lead">Обычно на это уходит меньше десяти минут. Ровно те же шаги ждут вас в кабинете.</p>
        </div>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={i} className={`lp-step rev d${i}`}>
              <div className="lp-step-num">{i + 1}</div>
              <div className="lp-step-body">
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="lp-center rev">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>
            Начать бесплатно<Icon name="arrow-right" />
          </button>
        </div>
      </div>
    </section>
  );
}

export default HowItWorks;
