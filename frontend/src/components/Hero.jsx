import React, { useState } from 'react';
import Icon from './Icon';
import CallCard from './CallCard';
import ModelLogo from './ModelLogo';
import { Stagger, Item } from './Reveal';
import { useTariffs } from '../hooks/useTariffs';

export const PHONE = '+79311071031';
export const PHONE_DISPLAY = '+7 931 10-710-31';

const isMobile = () =>
  window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function Hero({ onOpenModal }) {
  const [popover, setPopover] = useState(false);
  const [copied, setCopied] = useState(false);
  const models = useTariffs();

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
    <section className="hero sec-grid" id="top">
      <div className="lp-container">
        <div className="hero-grid">
          <Stagger className="hero-copy" stagger={0.09} amount={0.1}>
            <Item as="p" className="hero-kicker" y={10}>Voicyfy · голосовой ИИ, который создаёте вы</Item>
            <Item as="h1" y={22}>Платформа голосовых ИИ‑ассистентов и агентов для бизнеса</Item>
            <Item as="p" className="hero-lead">
              Ассистент отвечает на звонки и разговаривает на сайте. Агент сам обзванивает клиентов,
              пишет в мессенджеры и помнит каждого. Собираются за десять минут, без программирования.
            </Item>
            <Item className="hero-actions">
              <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenModal('register')}>
                Создать ассистента<Icon name="arrow-right" />
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
            </Item>
            <Item as="dl" className="hero-facts" y={12}>
              <div><dt>Пробный период</dt><dd>3 дня, без карты</dd></div>
              <div><dt>Первый звонок</dt><dd>тестовый номер на 10 минут</dd></div>
              <div><dt>Оплата</dt><dd>посекундно, по тарифу модели</dd></div>
            </Item>
          </Stagger>
          <Stagger className="hero-visual" delay={0.3} amount={0.1}>
            <Item x={40} y={0} rotate={1.5} duration={0.8}><CallCard /></Item>
          </Stagger>
        </div>

        <Stagger className="models" stagger={0.06} delay={0.45} amount={0.3}>
          <Item as="span" className="models-label" x={-8} y={0}>Голосовые модели</Item>
          {models.map((m) => (
            <Item as="span" key={m.code} className="models-item" y={8}>
              <ModelLogo code={m.code} size={18} wrap={false} />
              <span>{m.name}</span>
              {m.price && <b>{m.price}</b>}
            </Item>
          ))}
          <Item as="span" className="models-note" y={0}>Со своим ключом провайдера минуты бесплатны</Item>
        </Stagger>
      </div>
    </section>
  );
}

export default Hero;
