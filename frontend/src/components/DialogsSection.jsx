import React from 'react';

function DialogsSection() {
  return (
    <section className="dialogs" id="dialogs">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--dark">
            Каждый разговор у вас под рукой
          </h2>
          <p className="section-subtitle section-subtitle--dark">
            Встроенная система диалогов сохраняет каждую коммуникацию
            с вашим голосовым ИИ — слушайте, читайте, анализируйте.
          </p>
        </div>

        {/* Dialog UI Mockup */}
        <div className="dialogs-mockup" data-animate="fade-up" data-delay="100">
          <div className="dialogs-mockup-header">
            <span className="dialogs-mockup-title">Диалоги</span>
            <div className="dialogs-mockup-search">
              <i className="fas fa-search"></i> Поиск
            </div>
          </div>

          <div className="dialogs-mockup-body">
            {/* Call row */}
            <div className="dialogs-call-row">
              <div className="dialogs-call-icon">
                <i className="fas fa-phone-alt"></i>
              </div>
              <div className="dialogs-call-info">
                <div className="dialogs-call-phone">+7 925 123-45-67</div>
                <div className="dialogs-call-meta">
                  <span>2 мин 34 сек</span>
                  <span>сегодня 14:32</span>
                </div>
              </div>
              <div className="dialogs-call-listen">
                <i className="fas fa-headphones"></i>
              </div>
            </div>

            {/* Audio player */}
            <div className="dialogs-player">
              <div className="dialogs-player-btn">
                <i className="fas fa-play"></i>
              </div>
              <div className="dialogs-player-bar">
                <div className="dialogs-player-bar-fill" />
              </div>
              <span className="dialogs-player-time">1:23</span>
            </div>

            {/* Transcript */}
            <div className="dialogs-transcript">
              <div className="dialogs-transcript-label">Транскрипция:</div>
              <div className="dialogs-message">
                <span className="dialogs-message-icon dialogs-message-icon--user">
                  <i className="fas fa-user"></i>
                </span>
                <span>Здравствуйте, хочу узнать о тарифах</span>
              </div>
              <div className="dialogs-message">
                <span className="dialogs-message-icon dialogs-message-icon--ai">
                  <i className="fas fa-robot"></i>
                </span>
                <span>Привет! Расскажу о наших тарифах. У нас есть 4 плана...</span>
              </div>
              <div className="dialogs-message">
                <span className="dialogs-message-icon dialogs-message-icon--user">
                  <i className="fas fa-user"></i>
                </span>
                <span>А есть бесплатный период?</span>
              </div>
              <div className="dialogs-message">
                <span className="dialogs-message-icon dialogs-message-icon--ai">
                  <i className="fas fa-robot"></i>
                </span>
                <span>Да, 3 дня бесплатно, все функции включены!</span>
              </div>
              <div className="dialogs-message">
                <span className="dialogs-message-icon dialogs-message-icon--user">
                  <i className="fas fa-user"></i>
                </span>
                <span>Отлично, тогда давайте попробуем!</span>
              </div>
              <div className="dialogs-message">
                <span className="dialogs-message-icon dialogs-message-icon--ai">
                  <i className="fas fa-robot"></i>
                </span>
                <span>Конечно! Сейчас помогу настроить. Как вас зовут?</span>
              </div>
            </div>
          </div>
        </div>

        {/* Features grid */}
        <div className="dialogs-features" data-animate="fade-up" data-delay="200">
          <div className="dialogs-feature">
            <div className="dialogs-feature-icon">
              <i className="fas fa-headphones" style={{ color: 'var(--blue-500)' }}></i>
            </div>
            <div className="dialogs-feature-title">Аудио-плеер</div>
            <div className="dialogs-feature-desc">Встроен прямо в диалог</div>
          </div>
          <div className="dialogs-feature">
            <div className="dialogs-feature-icon">
              <i className="fas fa-file-alt" style={{ color: 'var(--blue-500)' }}></i>
            </div>
            <div className="dialogs-feature-title">Транскрипция</div>
            <div className="dialogs-feature-desc">Полная запись разговора</div>
          </div>
          <div className="dialogs-feature">
            <div className="dialogs-feature-icon">
              <i className="fas fa-chart-bar" style={{ color: 'var(--blue-500)' }}></i>
            </div>
            <div className="dialogs-feature-title">Аналитика</div>
            <div className="dialogs-feature-desc">Длина, тема, результат</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default DialogsSection;
