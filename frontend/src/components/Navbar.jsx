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
        <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" className="nav-logo-img" />
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
