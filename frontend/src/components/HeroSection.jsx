import React from 'react';
import SphereAnimation from './SphereAnimation';

function HeroSection() {
  return (
    <section style={{ position: 'relative', zIndex: 1 }}>
      <div className="hero">
        <div>
          <div className="hero-badge">
            <span className="badge-dot"></span>
            Голосовой ИИ нового поколения
          </div>

          <h1>
            Ваш бизнес говорит<br />голосом <span className="gt">будущего</span>
          </h1>

          <p className="hero-sub">
            Создавайте голосовых ИИ-ассистентов на базе OpenAI, Gemini и Cartesia. Телефония, CRM, виджет на сайт — всё в одной платформе.
          </p>

          <div className="hero-stats">
            <div className="hstat">
              <span className="hstat-num">300мс</span>
              <span className="hstat-label">Время ответа</span>
            </div>
            <div className="hstat">
              <span className="hstat-num">24/7</span>
              <span className="hstat-label">Без выходных</span>
            </div>
            <div className="hstat">
              <span className="hstat-num">3</span>
              <span className="hstat-label">AI-провайдера</span>
            </div>
            <div className="hstat">
              <span className="hstat-num">98%</span>
              <span className="hstat-label">Точность речи</span>
            </div>
          </div>

          <div className="hero-btns">
            <a href="#auth" className="btn-primary-hero">
              <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z" />
                <path d="M19 10v1a7 7 0 01-14 0v-1" />
              </svg>
              Создать ассистента
            </a>
            <a href="tel:+79014170600" className="btn-secondary-hero">
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 15a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 4.22h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 11.8a16 16 0 006.29 6.29l1.87-1.87a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 18.92z" />
              </svg>
              Позвонить ИИ
            </a>
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
