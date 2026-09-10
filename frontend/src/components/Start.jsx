import React, { useState } from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';
import SectionHead from './SectionHead';
import { Reveal, Stagger, Item } from './Reveal';
import { PHONE, PHONE_DISPLAY } from './Hero';

const STEPS = [
  ['Создайте ассистента', 'Имя, модель, голос и промпт: роль, компания, как вести разговор. База знаний и функции, если нужно отвечать по фактам и записывать клиентов.'],
  ['Позвоните ему', 'Тестовый номер на 10 минут, звонок с любого телефона. Пока идёт тест, меняйте модель: номер перепривяжется сам, и вы послушаете все голоса.'],
  ['Подключите свой номер', 'Верификация онлайн, по закону РФ без неё нельзя держать номера. Купите номер, привяжите ассистента, он начнёт отвечать на входящие.'],
];

// Как начать плюс тестовый звонок нашему агенту
function Start({ onOpenModal }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(PHONE_DISPLAY); } catch (err) { /* буфер недоступен */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="sec" id="how">
      <div className="lp-container">
        <SectionHead index="03" title="Три шага до первого разговора" lead="Обычно на это уходит меньше десяти минут. Те же три шага встретят вас на дашборде после регистрации." />
        <Stagger as="ol" className="steps" stagger={0.12}>
          {STEPS.map(([title, text], i) => (
            <Item as="li" key={title} y={20}>
              <span className="steps-n">{String(i + 1).padStart(2, '0')}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </Item>
          ))}
        </Stagger>
        <Reveal className="sec-actions" y={12}>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>Начать бесплатно<Icon name="arrow-right" /></button>
          <span className="muted">Три дня со всеми функциями, карта не нужна.</span>
        </Reveal>

        <Reveal className="call" y={20}>
          <div className="call-copy">
            <span className="call-kicker">Или позвоните нашему агенту прямо сейчас</span>
            <p>Он ответит мгновенно, расскажет о платформе и запишет ваш вопрос. Бесплатно, круглосуточно.</p>
            <div className="call-tags">
              <span className="chip"><ModelLogo code="cascade" size={14} wrap={false} />Работает на Каскаде</span>
              <span className="chip"><Icon name="mic" className="ic-sm" />Живой голос</span>
              <span className="chip"><Icon name="clock" className="ic-sm" />24/7</span>
            </div>
          </div>
          <div className="call-num">
            <a href={`tel:${PHONE}`} className="call-phone">{PHONE_DISPLAY}</a>
            <div className="call-actions">
              <a href={`tel:${PHONE}`} className="btn btn-primary"><Icon name="phone" />Позвонить</a>
              <button type="button" className="btn" onClick={copy}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Скопировано' : 'Скопировать'}</button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default Start;
