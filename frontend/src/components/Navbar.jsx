import React, { useState, useEffect } from 'react';

function Navbar({ onOpenLogin, onOpenRegister }) {
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollTo = (id) => {
    setDrawerOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <>
      <nav className={`navbar${scrolled ? ' scrolled' : ''}`}>
        <a href="/" className="navbar-logo">
          <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" />
          <span className="navbar-logo-text">Voicyfy</span>
        </a>

        <div className="navbar-nav">
          <span className="navbar-nav-link" onClick={() => scrollTo('providers')}>
            Возможности
          </span>
          <span className="navbar-nav-link" onClick={() => scrollTo('telephony')}>
            Телефония
          </span>
          <span className="navbar-nav-link" onClick={() => scrollTo('pricing')}>
            Тарифы
          </span>
        </div>

        <div className="navbar-right">
          <a
            href="https://t.me/voicyfy"
            target="_blank"
            rel="noopener noreferrer"
            className="navbar-icon"
          >
            <i className="fab fa-telegram"></i>
          </a>
          <a
            href="https://t.me/voicyfy_support"
            target="_blank"
            rel="noopener noreferrer"
            className="navbar-icon"
          >
            <i className="fas fa-headset"></i>
          </a>
          <button className="navbar-btn-login" onClick={onOpenLogin}>
            Войти
          </button>
          <button className="navbar-btn-start" onClick={onOpenRegister}>
            Начать бесплатно
          </button>
        </div>

        <button
          className={`navbar-hamburger${drawerOpen ? ' open' : ''}`}
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
      </nav>

      {/* Mobile drawer */}
      <div className={`navbar-drawer-overlay${drawerOpen ? ' open' : ''}`} onClick={() => setDrawerOpen(false)} />
      <div className={`navbar-drawer${drawerOpen ? ' open' : ''}`}>
        <span className="navbar-drawer-link" onClick={() => scrollTo('providers')}>
          Возможности
        </span>
        <span className="navbar-drawer-link" onClick={() => scrollTo('telephony')}>
          Телефония
        </span>
        <span className="navbar-drawer-link" onClick={() => scrollTo('pricing')}>
          Тарифы
        </span>
        <div className="navbar-drawer-divider" />
        <a href="https://t.me/voicyfy" target="_blank" rel="noopener noreferrer" className="navbar-drawer-link">
          <i className="fab fa-telegram" style={{ marginRight: 8 }}></i> Telegram канал
        </a>
        <a href="https://t.me/voicyfy_support" target="_blank" rel="noopener noreferrer" className="navbar-drawer-link">
          <i className="fas fa-headset" style={{ marginRight: 8 }}></i> Поддержка
        </a>
        <div className="navbar-drawer-divider" />
        <div className="navbar-drawer-buttons">
          <button className="navbar-btn-login" style={{ width: '100%' }} onClick={() => { setDrawerOpen(false); onOpenLogin(); }}>
            Войти
          </button>
          <button className="navbar-btn-start" style={{ width: '100%' }} onClick={() => { setDrawerOpen(false); onOpenRegister(); }}>
            Начать бесплатно
          </button>
        </div>
      </div>
    </>
  );
}

export default Navbar;
