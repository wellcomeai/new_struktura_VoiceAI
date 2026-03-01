import React, { useState, useEffect } from 'react';

function Navbar() {
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
        <div className="nav-logo-icon">
          <svg viewBox="0 0 24 24">
            <path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z" />
            <path d="M19 10v1a7 7 0 01-14 0v-1M12 18v4M8 22h8" />
          </svg>
        </div>
        <span className="nav-logo-text">Voicyfy</span>
      </a>

      <div className="nav-center">
        <a href="#features" className="nav-link">Возможности</a>
        <a href="#telephony" className="nav-link">Телефония</a>
        <a href="#showcase" className="nav-link">Платформа</a>
        <a href="#providers" className="nav-link">Технологии</a>
        <a href="#pricing" className="nav-link">Тарифы</a>
      </div>

      <div className="nav-right">
        <a href="#auth" className="nav-login">Войти</a>
        <a href="#auth" className="nav-cta">Начать бесплатно</a>
      </div>
    </nav>
  );
}

export default Navbar;
