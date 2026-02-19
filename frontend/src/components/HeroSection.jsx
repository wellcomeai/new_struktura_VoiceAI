import React, { useEffect, useRef } from 'react';

function HeroSection({ onOpenRegister }) {
  const countersRef = useRef(null);
  const animatedRef = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !animatedRef.current) {
            animatedRef.current = true;
            animateCounters();
          }
        });
      },
      { threshold: 0.3 }
    );

    if (countersRef.current) {
      observer.observe(countersRef.current);
    }

    return () => observer.disconnect();
  }, []);

  const animateCounters = () => {
    const counters = countersRef.current?.querySelectorAll('.hero-counter-value');
    if (!counters) return;

    counters.forEach((counter) => {
      const target = parseFloat(counter.dataset.target);
      const suffix = counter.dataset.suffix || '';
      const isDecimal = String(target).includes('.');
      const duration = 1500;
      const startTime = performance.now();

      const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

      const update = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeOutExpo(progress);
        const current = target * easedProgress;

        counter.textContent = (isDecimal ? current.toFixed(1) : Math.floor(current)) + suffix;

        if (progress < 1) {
          requestAnimationFrame(update);
        }
      };

      requestAnimationFrame(update);
    });
  };

  const handleDemoClick = (e) => {
    e.preventDefault();
    const el = document.getElementById('widget');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  // Generate particles
  const particles = Array.from({ length: 35 }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 100,
    duration: 6 + Math.random() * 8,
    delay: Math.random() * 5,
    tx: (Math.random() - 0.5) * 150,
    ty: (Math.random() - 0.5) * 150,
  }));

  return (
    <section className="hero">
      {/* Animated mesh gradient */}
      <div className="hero-mesh">
        <div className="hero-mesh-3" />
      </div>

      {/* Floating particles */}
      <div className="hero-particles">
        {particles.map((p) => (
          <div
            key={p.id}
            className="particle"
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              '--duration': `${p.duration}s`,
              '--delay': `${p.delay}s`,
              '--tx': `${p.tx}px`,
              '--ty': `${p.ty}px`,
            }}
          />
        ))}
      </div>

      {/* Bottom glow line */}
      <div className="hero-glow-line" />

      {/* Content */}
      <div className="hero-content">
        {/* Left: Text */}
        <div className="hero-text">
          <div className="hero-badge" data-animate="fade-up">
            <span className="hero-badge-dot">&#10022;</span>
            OpenAI &middot; Gemini &middot; Voximplant
          </div>

          <h1 className="hero-title" data-animate="fade-up" data-delay="100">
            Голосовой ИИ<br />
            <span>нового поколения</span>
          </h1>

          <p className="hero-subtitle" data-animate="fade-up" data-delay="200">
            Лучшие решения на рынке — OpenAI Realtime и&nbsp;Google Gemini.
            Создайте ассистента за минуты, разверните на сайте или&nbsp;в&nbsp;телефонии.
          </p>

          <div className="hero-counters" ref={countersRef} data-animate="fade-up" data-delay="300">
            <div className="hero-counter">
              <span className="hero-counter-value" data-target="40" data-suffix="+">0</span>
              <span className="hero-counter-label">голосов</span>
            </div>
            <div className="hero-counter">
              <span className="hero-counter-value" data-target="2.7" data-suffix="₽">0</span>
              <span className="hero-counter-label">за минуту</span>
            </div>
            <div className="hero-counter">
              <span className="hero-counter-value" data-target="3" data-suffix=" мин">0</span>
              <span className="hero-counter-label">до запуска</span>
            </div>
          </div>

          <div className="hero-buttons" data-animate="fade-up" data-delay="400">
            <button className="btn-primary" onClick={onOpenRegister}>
              Начать бесплатно <i className="fas fa-arrow-right" style={{ fontSize: 13 }}></i>
            </button>
            <button className="btn-outline" onClick={handleDemoClick}>
              <i className="fas fa-play" style={{ fontSize: 12 }}></i> Смотреть демо
            </button>
          </div>
        </div>

        {/* Right: Sphere */}
        <div className="hero-sphere-wrapper" data-animate="scale" data-delay="200">
          <div className="hero-sphere-container">
            {/* Waves */}
            <div className="hero-waves">
              <div className="hero-wave" />
              <div className="hero-wave" />
              <div className="hero-wave" />
              <div className="hero-wave" />
              <div className="hero-wave" />
              <div className="hero-wave" />
            </div>

            {/* Orbit ring 1 */}
            <div className="orbit-ring orbit-ring-1">
              <div className="orbit-badge">OpenAI</div>
            </div>

            {/* Orbit ring 2 */}
            <div className="orbit-ring orbit-ring-2">
              <div className="orbit-badge orbit-badge-2">Gemini</div>
            </div>

            {/* Sphere */}
            <div className="hero-sphere" />

            {/* Floating badge */}
            <div className="hero-floating-badge">
              Говорит. Слушает. Понимает.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default HeroSection;
