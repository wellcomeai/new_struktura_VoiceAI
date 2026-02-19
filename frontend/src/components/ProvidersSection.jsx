import React from 'react';

function ProvidersSection() {
  return (
    <section className="providers" id="providers">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--dark">
            Два провайдера. Один стандарт.
          </h2>
          <p className="section-subtitle section-subtitle--dark">
            Выбирайте между OpenAI Realtime API и Google Gemini Live —
            оба работают внутри Voicyfy. Переключайтесь в один клик.
          </p>
        </div>

        <div className="providers-grid">
          {/* OpenAI Card */}
          <div className="provider-card" data-animate="fade-up" data-delay="100">
            <div className="provider-card-header">
              <div className="provider-icon provider-icon--openai">
                <i className="fas fa-brain"></i>
              </div>
              <div>
                <div className="provider-card-title">OpenAI Realtime API</div>
                <div className="provider-card-subtitle">gpt-4o-realtime</div>
              </div>
            </div>

            <p className="provider-card-quote">
              &laquo;Минимальная задержка. Голос как человек.&raquo;
            </p>

            <div className="provider-features">
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>10 профессиональных голосов</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Сверхнизкая латентность &lt; 500мс</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Встроенное управление диалогом</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Function calling в реальном времени</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Шёпот, эмоции, интонации</span>
              </div>
            </div>

            <div className="provider-chips">
              <span className="provider-chip">Alloy</span>
              <span className="provider-chip">Echo</span>
              <span className="provider-chip">Fable</span>
              <span className="provider-chip">Onyx</span>
              <span className="provider-chip">Nova</span>
              <span className="provider-chip">Shimmer</span>
            </div>
          </div>

          {/* Gemini Card */}
          <div className="provider-card" data-animate="fade-up" data-delay="200">
            <div className="provider-popular-badge">
              <i className="fas fa-fire" style={{ fontSize: 11 }}></i> POPULAR
            </div>
            <div className="provider-card-header">
              <div className="provider-icon provider-icon--gemini">
                <i className="fas fa-sparkles"></i>
              </div>
              <div>
                <div className="provider-card-title">Google Gemini Live</div>
                <div className="provider-card-subtitle">gemini-2.0-flash</div>
              </div>
            </div>

            <p className="provider-card-quote">
              &laquo;30 HD-голосов. Энциклопедический интеллект.&raquo;
            </p>

            <div className="provider-features">
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>30 HD голосов высокого качества</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Многоязычная поддержка</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Глубокие знания Google-экосистемы</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Мультимодальность</span>
              </div>
              <div className="provider-feature">
                <i className="fas fa-check"></i>
                <span>Расширенный контекст 1M токенов</span>
              </div>
            </div>

            <div className="provider-chips">
              <span className="provider-chip">Puck</span>
              <span className="provider-chip">Charon</span>
              <span className="provider-chip">Kore</span>
              <span className="provider-chip">Fenrir</span>
              <span className="provider-chip">Aoede</span>
              <span className="provider-chip">+25</span>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

export default ProvidersSection;
