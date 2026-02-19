import React, { useEffect, useRef } from 'react';

function TelephonySection() {
  const pricingRef = useRef(null);
  const animatedRef = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !animatedRef.current) {
          animatedRef.current = true;
          animateNumbers();
        }
      },
      { threshold: 0.3 }
    );

    if (pricingRef.current) observer.observe(pricingRef.current);
    return () => observer.disconnect();
  }, []);

  const animateNumbers = () => {
    const counters = pricingRef.current?.querySelectorAll('.telephony-price');
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

        const formatted = isDecimal ? current.toFixed(1) : Math.floor(current);
        counter.innerHTML = formatted + '<span class="telephony-price-suffix">' + suffix + '</span>';

        if (progress < 1) {
          requestAnimationFrame(update);
        }
      };

      requestAnimationFrame(update);
    });
  };

  return (
    <section className="telephony" id="telephony">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--dark">
            Самые низкие тарифы на связь
          </h2>
          <p className="section-subtitle section-subtitle--dark">
            Входящие и исходящие звонки. Подключите номер —
            ваш ИИ начнёт принимать звонки немедленно.
          </p>
        </div>

        <div className="telephony-grid" ref={pricingRef}>
          {/* Column 1: Pricing */}
          <div className="telephony-pricing" data-animate="fade-up" data-delay="100">
            <div className="telephony-pricing-block">
              <div className="telephony-pricing-label">Входящие</div>
              <div className="telephony-pricing-divider" />
              <div className="telephony-price" data-target="2" data-suffix="₽">0</div>
              <div className="telephony-price-note">за минуту</div>
            </div>
            <div className="telephony-pricing-block">
              <div className="telephony-pricing-label">Исходящие</div>
              <div className="telephony-pricing-divider" />
              <div className="telephony-price" data-target="2.7" data-suffix="₽">0</div>
              <div className="telephony-price-note">за минуту</div>
            </div>
          </div>

          {/* Column 2: Inbound */}
          <div className="telephony-feature-card" data-animate="fade-up" data-delay="200">
            <div className="telephony-feature-icon">
              <i className="fas fa-phone-alt" style={{ color: 'var(--blue-400)' }}></i>
            </div>
            <h3 className="telephony-feature-title">Входящие звонки</h3>
            <div className="telephony-feature-list">
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Мгновенный подъём трубки</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>ИИ отвечает 24/7 без перерывов</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Обработка очереди звонков</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Переадресация при необходимости</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Каждый звонок → в CRM</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Запись разговора</span>
              </div>
            </div>
          </div>

          {/* Column 3: Outbound */}
          <div className="telephony-feature-card" data-animate="fade-up" data-delay="300">
            <div className="telephony-feature-icon">
              <i className="fas fa-paper-plane" style={{ color: 'var(--blue-400)' }}></i>
            </div>
            <h3 className="telephony-feature-title">Исходящие звонки</h3>
            <div className="telephony-feature-list">
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>ИИ сам совершает обзвон</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Запланированные задачи из CRM</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Персонализированное приветствие</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Повторный звонок при недозвоне</span>
              </div>
              <div className="telephony-feature-item">
                <i className="fas fa-check"></i>
                <span>Результат → автоматически в CRM</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="telephony-bottom" data-animate="fade-up" data-delay="400">
          <div className="telephony-wave-decoration">
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
          </div>
          <span className="telephony-bottom-text">
            Подключение за 5 минут
          </span>
          <div className="telephony-wave-decoration">
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
            <div className="telephony-wave-bar" />
          </div>
        </div>
      </div>
    </section>
  );
}

export default TelephonySection;
