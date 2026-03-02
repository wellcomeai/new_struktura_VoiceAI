import React from 'react';

function SphereAnimation() {
  return (
    <div className="hero-sphere-wrap">
      <div className="sphere-container">
        <div className="sphere-el">
          <div className="sphere-wave">
            <span></span><span></span><span></span><span></span>
            <span></span><span></span><span></span><span></span><span></span>
          </div>
        </div>
        <div className="wave-container">
          <div className="wave"></div>
          <div className="wave"></div>
          <div className="wave"></div>
          <div className="wave"></div>
        </div>
      </div>

      <div className="s-chip c1">
        <span className="chip-dot"></span>
        +1 234 звонка сегодня
      </div>

      <div className="s-chip c2">
        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 15a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 4.22h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 11.8a16 16 0 006.29 6.29l1.87-1.87a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 18.92z" />
        </svg>
        98% точность речи
      </div>

      <div className="s-chip c3">
        <svg width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="#ffffff" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        Активен 24/7
      </div>
    </div>
  );
}

export default SphereAnimation;
