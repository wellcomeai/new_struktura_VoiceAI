import React from 'react';

function Footer() {
  return (
    <footer className="footer">
      <div className="section-container">
        <div className="footer-top">
          <div className="footer-brand">
            <div className="footer-logo">
              <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" />
              <span className="footer-logo-text">Voicyfy</span>
            </div>
            <p className="footer-desc">
              Платформа для создания голосовых ИИ-ассистентов
              на базе OpenAI и Google Gemini.
            </p>
          </div>

          <div className="footer-links-group">
            <div className="footer-links-col">
              <span className="footer-links-col-title">Продукт</span>
              <a href="#providers" className="footer-link">Возможности</a>
              <a href="#telephony" className="footer-link">Телефония</a>
              <a href="#pricing" className="footer-link">Тарифы</a>
            </div>
            <div className="footer-links-col">
              <span className="footer-links-col-title">Поддержка</span>
              <a href="https://t.me/voicyfy_support" target="_blank" rel="noopener noreferrer" className="footer-link">Поддержка</a>
              <a href="https://t.me/voicyfy" target="_blank" rel="noopener noreferrer" className="footer-link">Telegram</a>
              <a href="mailto:well96well@gmail.com" className="footer-link">Email</a>
            </div>
          </div>
        </div>

        <div className="footer-divider" />

        <div className="footer-bottom">
          <span className="footer-copy">&copy; 2025-2026 Voicyfy</span>
          <div className="footer-legal">
            <a href="/static/privacy-policy.html">Политика конфиденциальности</a>
            <a href="/static/public-offer.html">Публичная оферта</a>
            <a href="/static/terms-of-service.html">Условия использования</a>
            <a href="/static/payment-terms.html">Условия оплаты</a>
          </div>
          <div className="footer-company">
            ИП Шишкин Валерий Сергеевич &middot; ИНН: 385101159652 &middot; well96well@gmail.com
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
