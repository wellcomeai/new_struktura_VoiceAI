import React, { useState } from 'react';
import SphereAnimation from './SphereAnimation';

const PHONE = '+79014170600';
const PHONE_DISPLAY = '+7 901 417-06-00';

const isMobile = () =>
  window.innerWidth < 768 ||
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function HeroSection({ onOpenModal }) {
  const [showPhonePopover, setShowPhonePopover] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCallClick = (e) => {
    if (isMobile()) return;
    e.preventDefault();
    setShowPhonePopover(true);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(PHONE_DISPLAY);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section style={{ position: 'relative', zIndex: 1 }}>
      <div className="hero">
        <div>
          <div className="hero-badge">
            <span className="badge-dot"></span>
            Голосовой ИИ нового поколения
          </div>

          <h1>
            Голосовые <span className="gt">ИИ‑агенты</span>
            <br />для вашего бизнеса
          </h1>

          <p className="hero-sub">
            Создавайте голосовых ИИ-агентов на базе OpenAI,
            Gemini и Cartesia. Принимают звонки, общаются
            с клиентами и закрывают задачи — без участия человека.
          </p>

          <div className="stats-strip">
            {[
              { num: "300мс", label: "Время ответа" },
              { num: "24/7",  label: "Без выходных" },
              { num: "3",     label: "AI‑провайдера" },
              { num: "98%",   label: "Точность речи" },
            ].map((s, i) => (
              <div className="stat-item" key={i}>
                <span className="stat-num">{s.num}</span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>

          <div className="hero-btns">
            <button className="btn-primary-hero" onClick={() => onOpenModal('register')}>
              <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z" />
                <path d="M19 10v1a7 7 0 01-14 0v-1" />
              </svg>
              Создать ассистента
            </button>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <a href={`tel:${PHONE}`}
                className="btn-secondary-hero"
                onClick={handleCallClick}>
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 15a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 4.22h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 11.8a16 16 0 006.29 6.29l1.87-1.87a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 18.92z" />
                </svg>
                Позвонить ИИ
              </a>

              {showPhonePopover && (
                <>
                  <div className="popover-backdrop"
                    onClick={() => setShowPhonePopover(false)}/>
                  <div className="phone-popover">
                    <div className="pp-num">{PHONE_DISPLAY}</div>
                    <div className="pp-hint">Gemini Live · Работает 24/7</div>
                    <button className="pp-copy" onClick={handleCopy}>
                      {copied ? '✓ Скопировано' : 'Скопировать номер'}
                    </button>
                    <div className="pp-or">или откройте на мобильном</div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="hero-trust">
            <span className="ti"><i className="fas fa-circle-check"></i> WebSocket стриминг</span>
            <span className="ti"><i className="fas fa-circle-check"></i> VAD детекция речи</span>
            <span className="ti"><i className="fas fa-circle-check"></i> Function calling</span>
            <span className="ti"><i className="fas fa-circle-check"></i> Поддержка прерываний</span>
          </div>
        </div>

        <SphereAnimation />
      </div>
    </section>
  );
}

export default HeroSection;
