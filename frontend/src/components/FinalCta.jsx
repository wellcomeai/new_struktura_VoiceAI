import React from 'react';
import Icon from './Icon';
import { Reveal } from './Reveal';

function FinalCta({ onOpenModal }) {
  return (
    <section className="sec final">
      <div className="lp-container">
        <Reveal className="final-inner" y={20}>
          <div>
            <h2>Соберите первого ассистента за десять минут</h2>
            <p className="lp-lead">Три дня бесплатно и без карты. Позвоните ассистенту на тестовый номер и решите, подходит ли он вам.</p>
          </div>
          <div className="final-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>Создать ассистента<Icon name="arrow-right" /></button>
            <a href="https://t.me/voicyfy_support" target="_blank" rel="noopener" className="btn btn-lg"><Icon name="send" />Задать вопрос</a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default FinalCta;
