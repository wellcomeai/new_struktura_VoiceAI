import React from 'react';

function Navbar() {
  return (
    <div className="navbar">
      <a href="/" className="logo">
        <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" />
        <span className="logo-text">Voicyfy</span>
      </a>
      <div className="nav-icons">
        <a
          href="https://t.me/voicyfy"
          target="_blank"
          rel="noopener noreferrer"
          className="nav-icon-link nav-icon-telegram"
          data-tooltip="Новостной канал Voicyfy"
        >
          <i className="fab fa-telegram"></i>
        </a>
        <a
          href="https://t.me/voicyfy_support"
          className="nav-icon-link nav-icon-support"
          data-tooltip="Обратиться в Техническую поддержку"
        >
          <i className="fas fa-headset"></i>
        </a>
      </div>
    </div>
  );
}

export default Navbar;
