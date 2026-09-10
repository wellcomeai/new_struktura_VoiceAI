import React, { useState } from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';
import { PHONE, PHONE_DISPLAY } from './Hero';

function TestCall() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(PHONE_DISPLAY); } catch (err) { /* буфер недоступен */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="lp-section lp-section-tight" id="call">
      <div className="lp-container">
        <div className="card card-raised lp-call rev">
          <div className="lp-call-copy">
            <span className="lp-eyebrow"><span className="lp-eyebrow-dot"></span>Попробуйте прямо сейчас</span>
            <h2>Позвоните нашему агенту</h2>
            <p className="lp-lead">Он ответит мгновенно и расскажет о платформе. Бесплатный тестовый звонок, работает круглосуточно.</p>
            <div className="lp-call-tags">
              <span className="chip"><ModelLogo code="cascade" size={14} wrap={false} />Работает на Каскаде</span>
              <span className="chip"><Icon name="clock" className="ic-sm" />24/7</span>
              <span className="chip"><Icon name="mic" className="ic-sm" />Живой голос</span>
            </div>
          </div>
          <div className="lp-call-num">
            <a href={`tel:${PHONE}`} className="lp-call-phone">{PHONE_DISPLAY}</a>
            <div className="lp-call-actions">
              <a href={`tel:${PHONE}`} className="btn btn-primary btn-lg"><Icon name="phone" />Позвонить</a>
              <button type="button" className="btn btn-lg" onClick={copy}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Скопировано' : 'Скопировать'}</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default TestCall;
