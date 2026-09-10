import React, { useState } from 'react';
import Icon from './Icon';
import CallCard from './CallCard';

export const PHONE = '+79311071031';
export const PHONE_DISPLAY = '+7 931 10-710-31';

const isMobile = () =>
  window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function Hero({ onOpenModal }) {
  const [popover, setPopover] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCallClick = (e) => {
    if (isMobile()) return;
    e.preventDefault();
    setPopover(true);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(PHONE_DISPLAY); } catch (err) { /* буфер недоступен */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="lp-hero" id="top">
      <div className="lp-container lp-hero-inner">
        <div className="lp-hero-copy">
          <div className="lp-eyebrow"><span className="lp-eyebrow-dot"></span>Платформа голосовых ИИ-ассистентов</div>
          <h1>Голосовой ИИ, который отвечает на звонки и сам обзванивает клиентов</h1>
          <p className="lp-lead">
            Соберите ассистента за десять минут, позвоните ему на тестовый номер и подключите
            к своему. Ключи провайдеров уже подключены: вы платите только за минуты разговора.
          </p>
          <div className="lp-hero-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>
              <Icon name="plus" />Создать ассистента
            </button>
            <div className="lp-pop-wrap">
              <a href={`tel:${PHONE}`} className="btn btn-lg" onClick={handleCallClick}>
                <Icon name="phone" />Позвонить ИИ
              </a>
              {popover && (
                <>
                  <div className="lp-pop-backdrop" onClick={() => setPopover(false)} />
                  <div className="lp-pop card card-raised" role="dialog" aria-label="Тестовый номер">
                    <div className="lp-pop-num">{PHONE_DISPLAY}</div>
                    <div className="lp-pop-hint">Наш агент на линии · работает на Каскаде · 24/7</div>
                    <button type="button" className="btn btn-primary" onClick={copy}>
                      <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Скопировано' : 'Скопировать номер'}
                    </button>
                    <div className="lp-pop-or">или откройте сайт на телефоне и нажмите «Позвонить ИИ»</div>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="lp-hero-trust">
            <span><Icon name="circle-check" className="ic-sm" />3 дня бесплатно</span>
            <span><Icon name="circle-check" className="ic-sm" />Тестовый номер на 10 минут</span>
            <span><Icon name="circle-check" className="ic-sm" />Без своих ключей API</span>
          </div>
        </div>
        <div className="lp-hero-visual">
          <CallCard />
        </div>
      </div>
    </section>
  );
}

export default Hero;
