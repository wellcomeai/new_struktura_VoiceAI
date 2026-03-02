import React, { useState, useEffect } from 'react';

function Navbar({ onOpenModal }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 10);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav
      className="nav"
      style={{ boxShadow: scrolled ? '0 2px 20px rgba(0,0,0,.07)' : 'none' }}
    >
      <a href="#" className="nav-logo">
        <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" className="nav-logo-img" />
        <span className="nav-logo-text">Voicyfy</span>
      </a>

      <div className="nav-center">
        <a href="#features" className="nav-link">Возможности</a>
        <a href="#telephony" className="nav-link">Телефония</a>
        <a href="#showcase" className="nav-link">Платформа</a>
        <a href="#providers" className="nav-link">Технологии</a>
        <a href="#pricing" className="nav-link">Тарифы</a>
        <a href="https://t.me/voicyfy_support" className="nav-link" target="_blank" rel="noopener noreferrer">Поддержка</a>
        <a href="/static/api-docs.html" className="nav-link">API</a>
      </div>

      <div className="nav-right">
        <button className="nav-login" onClick={() => onOpenModal('login')}>Войти</button>
        <button className="nav-cta" onClick={() => onOpenModal('register')}>Начать бесплатно</button>
      </div>
    </nav>
  );
}

export default Navbar;
