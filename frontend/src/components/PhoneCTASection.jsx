import React from 'react';

function PhoneCTASection() {
  const bars = Array.from({ length: 20 });

  return (
    <div className="phone-cta-outer" id="phone-demo">
      <div className="phone-cta">
        <div className="eq-bg">
          {bars.map((_, i) => (
            <div key={i} className="eq-bar"></div>
          ))}
        </div>

        <h2>Попробуйте прямо сейчас</h2>
        <p>Позвоните по номеру ниже и поговорите с голосовым ИИ-ассистентом на базе Google Gemini Live. Ответит мгновенно.</p>

        <a href="tel:+79014170600" className="phone-num">
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 15a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 4.22h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 11.8a16 16 0 006.29 6.29l1.87-1.87a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 18.92z" />
          </svg>
          +7 901 417-06-00
        </a>

        <p className="phone-hint">Бесплатный тестовый звонок · Gemini Live API · Работает 24/7</p>
      </div>
    </div>
  );
}

export default PhoneCTASection;
