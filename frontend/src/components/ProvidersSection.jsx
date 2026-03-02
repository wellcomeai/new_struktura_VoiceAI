import React from 'react';

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="8" fill="#eff6ff"/>
    <path d="M5 8l2 2 4-4"
      stroke="#2563eb" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

function ProvidersSection() {
  return (
    <section className="section providers-section" id="providers">
      <div className="section-inner">
        <div className="s-head rev">
          <span className="s-label">Технологии</span>
          <h2 className="s-title">Три движка — <span className="gt">один интерфейс</span></h2>
          <p className="s-desc">Выбирайте провайдера под задачу или комбинируйте для максимального результата</p>
        </div>

        <div className="prov-grid">
          <div className="prov-card rev">
            <div className="prov-icon pi-g"><i className="fab fa-google"></i></div>
            <h4>Google Gemini Live</h4>
            <p>Нативная обработка голоса — без промежуточного STT/TTS. Мультимодальный: аудио, видео, текст одновременно.</p>
            <ul className="prov-feats">
              <li><CheckIcon /> Бидирекционный стриминг</li>
              <li><CheckIcon /> Нативный аудио без пайплайна</li>
              <li><CheckIcon /> Поддержка прерываний</li>
              <li><CheckIcon /> Function calling</li>
              <li><CheckIcon /> Мультимодальность</li>
            </ul>
          </div>

          <div className="prov-card rev d1">
            <div className="prov-icon pi-o"><i className="fas fa-robot"></i></div>
            <h4>OpenAI Realtime</h4>
            <p>Голосовой ИИ на базе OpenAI с нативной речью, ультранизкой задержкой и вызовом функций в реальном времени.</p>
            <ul className="prov-feats">
              <li><CheckIcon /> Нативный голос</li>
              <li><CheckIcon /> WebSocket стриминг</li>
              <li><CheckIcon /> Function calling</li>
              <li><CheckIcon /> VAD (определение речи)</li>
              <li><CheckIcon /> Сверхнизкая латенция</li>
            </ul>
          </div>

          <div className="prov-card rev d2">
            <div className="prov-icon pi-c"><i className="fas fa-wave-square"></i></div>
            <h4>ChatGPT + Cartesia TTS</h4>
            <p>Интеллект ChatGPT + самый выразительный голосовой движок Cartesia Sonic с эмоциями и интонациями.</p>
            <ul className="prov-feats">
              <li><CheckIcon /> Выразительная речь с эмоциями</li>
              <li><CheckIcon /> Смех, паузы, интонации</li>
              <li><CheckIcon /> Стриминг в реальном времени</li>
              <li><CheckIcon /> ChatGPT для интеллекта</li>
              <li><CheckIcon /> Идеально для обслуживания</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export default ProvidersSection;
