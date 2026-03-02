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
