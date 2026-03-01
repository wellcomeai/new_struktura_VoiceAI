import React from 'react';

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="foot-top">
          <div className="foot-brand">
            <span className="foot-logo">Voicyfy</span>
            <p>Платформа голосовых ИИ-ассистентов для бизнеса. OpenAI, Google Gemini, Cartesia.</p>
          </div>
          <div className="foot-col">
            <h5>Продукт</h5>
            <a href="#features">Возможности</a>
            <a href="#pricing">Тарифы</a>
            <a href="/static/api-docs.html">API</a>
          </div>
          <div className="foot-col">
            <h5>Документы</h5>
            <a href="/static/privacy-policy.html">Конфиденциальность</a>
            <a href="/static/terms-of-service.html">Соглашение</a>
            <a href="/static/public-offer.html">Оферта</a>
          </div>
          <div className="foot-col">
            <h5>Контакты</h5>
            <a href="https://t.me/voicyfy" target="_blank" rel="noopener noreferrer">Telegram</a>
            <a href="https://t.me/voicyfy_support">Поддержка</a>
            <a href="mailto:info@voicyfy.ru">Email</a>
          </div>
        </div>
        <div className="foot-bottom">
          <span>&copy; 2025–2026 Voicyfy. Все права защищены.</span>
          <span>ИП Шишкин Валерий Сергеевич · ИНН: 385101159652</span>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
