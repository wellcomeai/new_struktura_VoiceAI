import React, { useState, useEffect } from 'react';
import Icon from './Icon';

const LINKS = [
  { href: '#platform', label: 'Кабинет' },
  { href: '#agent', label: 'Агент' },
  { href: '#how', label: 'Как начать' },
  { href: '#integration', label: 'Виджет' },
  { href: '#pricing', label: 'Тарифы' },
  { href: '/static/prompts-wiki.html', label: 'База знаний' },
  { href: '/static/api-docs.html', label: 'API' },
  { href: 'https://t.me/voicyfy_support', label: 'Поддержка', external: true },
];

function Navbar({ onOpenModal }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const links = LINKS.map((l) => (
    <a
      key={l.href}
      href={l.href}
      className="lp-nav-link"
      target={l.external ? '_blank' : undefined}
      rel={l.external ? 'noopener' : undefined}
      onClick={() => setOpen(false)}
    >
      {l.label}
    </a>
  ));

  return (
    <header className={`lp-nav${scrolled ? ' scrolled' : ''}`}>
      <div className="lp-container lp-nav-inner">
        <a href="#top" className="vf-logo lp-logo" aria-label="Voicyfy">
          <img src="/static/images/IMG_2820.PNG" alt="" />
          <span className="wordmark">Voicyfy</span>
        </a>
        <nav className="lp-nav-links">{links}</nav>
        <div className="lp-nav-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onOpenModal('login')}>Войти</button>
          <button type="button" className="btn btn-primary" onClick={() => onOpenModal('register')}>Начать бесплатно</button>
          <button
            type="button"
            className="btn btn-icon lp-burger"
            aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? 'x' : 'menu'} />
          </button>
        </div>
      </div>
      {open && (
        <div className="lp-nav-mobile">
          {links}
          <div className="lp-nav-mobile-actions">
            <button type="button" className="btn btn-lg" onClick={() => { setOpen(false); onOpenModal('login'); }}>Войти</button>
            <button type="button" className="btn btn-primary btn-lg" onClick={() => { setOpen(false); onOpenModal('register'); }}>Начать бесплатно</button>
          </div>
        </div>
      )}
    </header>
  );
}

export default Navbar;
