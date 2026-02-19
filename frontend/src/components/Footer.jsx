import React from 'react';

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-content">
        <div className="footer-main">
          <div className="footer-logo">
            <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" />
            <span className="footer-logo-text">Voicyfy</span>
          </div>
          <div className="footer-links">
            <a href="/static/privacy-policy.html" className="footer-link">Политика конфиденциальности</a>
            <a href="/static/terms-of-service.html" className="footer-link">Пользовательское соглашение</a>
            <a href="/static/public-offer.html" className="footer-link">Публичная оферта</a>
            <a href="/static/payment-terms.html" className="footer-link">Условия оплаты и использования</a>
            <a href="/static/api-docs.html" className="footer-link">API документация</a>
          </div>
        </div>

        <div className="footer-divider"></div>

        <div className="footer-bottom">
          <div className="footer-copy">&copy; 2025-2026 Voicyfy. Все права защищены.</div>
          <div className="footer-contact">
            ИП Шишкин Валерий Сергеевич | ИНН: 385101159652 | well96well@gmail.com
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
