import React from 'react';

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
              <li><i className="fas fa-circle"></i> Бидирекционный стриминг</li>
              <li><i className="fas fa-circle"></i> Нативный аудио без пайплайна</li>
              <li><i className="fas fa-circle"></i> Поддержка прерываний</li>
              <li><i className="fas fa-circle"></i> Function calling</li>
              <li><i className="fas fa-circle"></i> Мультимодальность</li>
            </ul>
          </div>

          <div className="prov-card rev d1">
            <div className="prov-icon pi-o"><i className="fas fa-robot"></i></div>
            <h4>OpenAI Realtime</h4>
            <p>Голосовой ИИ на базе OpenAI с нативной речью, ультранизкой задержкой и вызовом функций в реальном времени.</p>
            <ul className="prov-feats">
              <li><i className="fas fa-circle"></i> Нативный голос</li>
              <li><i className="fas fa-circle"></i> WebSocket стриминг</li>
              <li><i className="fas fa-circle"></i> Function calling</li>
              <li><i className="fas fa-circle"></i> VAD (определение речи)</li>
              <li><i className="fas fa-circle"></i> Сверхнизкая латенция</li>
            </ul>
          </div>

          <div className="prov-card rev d2">
            <div className="prov-icon pi-c"><i className="fas fa-wave-square"></i></div>
            <h4>ChatGPT + Cartesia TTS</h4>
            <p>Интеллект ChatGPT + самый выразительный голосовой движок Cartesia Sonic с эмоциями и интонациями.</p>
            <ul className="prov-feats">
              <li><i className="fas fa-circle"></i> Выразительная речь с эмоциями</li>
              <li><i className="fas fa-circle"></i> Смех, паузы, интонации</li>
              <li><i className="fas fa-circle"></i> Стриминг в реальном времени</li>
              <li><i className="fas fa-circle"></i> ChatGPT для интеллекта</li>
              <li><i className="fas fa-circle"></i> Идеально для обслуживания</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export default ProvidersSection;
