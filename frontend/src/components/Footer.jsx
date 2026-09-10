import React from 'react';

function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-container lp-footer-inner">
        <div className="lp-footer-brand">
          <a href="#top" className="vf-logo lp-logo"><img src="/static/images/IMG_2820.PNG" alt="" /><span className="wordmark">Voicyfy</span></a>
          <p>Платформа голосовых ИИ-ассистентов и агента для бизнеса. OpenAI, Gemini, Яндекс, Fish Audio и Каскад в одном кабинете.</p>
        </div>
        <div className="lp-footer-col">
          <h4>Продукт</h4>
          <a href="#platform">Возможности</a>
          <a href="#agent">Агент</a>
          <a href="#pricing">Тарифы</a>
          <a href="/static/api-docs.html">API</a>
          <a href="/static/prompts-wiki.html">База знаний</a>
        </div>
        <div className="lp-footer-col">
          <h4>Документы</h4>
          <a href="/static/privacy-policy.html">Конфиденциальность</a>
          <a href="/static/terms-of-service.html">Соглашение</a>
          <a href="/static/public-offer.html">Оферта</a>
        </div>
        <div className="lp-footer-col">
          <h4>Контакты</h4>
          <a href="https://t.me/voicyfy" target="_blank" rel="noopener">Telegram</a>
          <a href="https://t.me/voicyfy_support" target="_blank" rel="noopener">Поддержка</a>
          <a href="mailto:info@voicyfy.ru">info@voicyfy.ru</a>
        </div>
      </div>
      <div className="lp-container lp-footer-bottom">
        <span>© 2025–2026 Voicyfy. Все права защищены.</span>
        <span>ИП Шишкин Валерий Сергеевич · ИНН 385101159652</span>
      </div>
    </footer>
  );
}

export default Footer;
