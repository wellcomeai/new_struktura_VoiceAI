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
  const [active, setActive] = useState('');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Подсветка раздела, который сейчас на экране
  useEffect(() => {
    const ids = LINKS.filter((l) => l.href.startsWith('#')).map((l) => l.href.slice(1));
    const sections = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!sections.length) return undefined;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit) setActive('#' + hit.target.id);
    }, { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.1, 0.5] });
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const links = LINKS.map((l) => (
    <a
      key={l.href}
      href={l.href}
      className={`lp-nav-link${active === l.href ? ' on' : ''}`}
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
