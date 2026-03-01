import React from 'react';

function ShowcaseSection() {
  return (
    <section className="section showcase-section" id="showcase">
      <div className="section-inner">
        <div className="s-head rev">
          <span className="s-label">Платформа</span>
          <h2 className="s-title">Всё для голосового ИИ<br /><span className="gt">в одном месте</span></h2>
          <p className="s-desc">Телефония, история диалогов, CRM — управляйте ассистентами из удобной панели</p>
        </div>

        <div className="showcase-grid">
          {/* 1. TELEPHONY */}
          <div className="showcase-item rev" id="telephony">
            <div className="show-text">
              <div className="icon-box ib-blue">
                <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 15a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 4.22h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 11.8a16 16 0 006.29 6.29l1.87-1.87a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 18.92z" />
                </svg>
              </div>
              <h3>Телефония</h3>
              <p>Подключите голосового ассистента к реальному телефонному номеру — он будет принимать и совершать звонки 24/7 без участия человека.</p>
              <ul className="show-feats">
                <li><i className="fas fa-check-circle"></i> <span><strong>Купите номер</strong> прямо в личном кабинете</span></li>
                <li><i className="fas fa-check-circle"></i> <span><strong>Выберите ассистента</strong> и напишите промт</span></li>
                <li><i className="fas fa-check-circle"></i> <span><strong>Готово</strong> — ИИ принимает звонки</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Запись и аналитика всех разговоров</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Автоматические исходящие звонки</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Интеграция с CRM — задачи из звонков</span></li>
              </ul>
            </div>
            <div className="mockup-wrap rev">
              <div className="mockup-frame">
                <div className="mock-topbar">
                  <div className="d r"></div><div className="d y"></div><div className="d g"></div>
                  <div className="url"><span>voicyfy.ru/dashboard/telephony</span></div>
                </div>
                <div className="mock-img-wrap">
                  <img src="https://pub-b1e3de631e544c69b0ad6587f740e140.r2.dev/telephony_screenshot.webp" alt="Телефония Voicyfy" loading="lazy" />
                </div>
              </div>
            </div>
          </div>

          {/* 2. DIALOGS */}
          <div className="showcase-item">
            <div className="show-text">
              <div className="icon-box ib-green">
                <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              </div>
              <h3>Диалоги</h3>
              <p>Все разговоры с ассистентом автоматически сохраняются — анализируйте, слушайте записи и улучшайте качество на основе данных.</p>
              <ul className="show-feats">
                <li><i className="fas fa-check-circle"></i> <span>Аналитика: длительность, темы, настроения</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Прослушивание записей разговоров</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Полная текстовая расшифровка</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Фильтрация по дате, источнику, статусу</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Экспорт для отчётов</span></li>
              </ul>
            </div>
            <div className="mockup-wrap">
              <div className="mockup-frame">
                <div className="mock-topbar">
                  <div className="d r"></div><div className="d y"></div><div className="d g"></div>
                  <div className="url"><span>voicyfy.ru/dashboard/dialogs</span></div>
                </div>
                <div className="mock-img-wrap">
                  <img src="https://pub-b1e3de631e544c69b0ad6587f740e140.r2.dev/conversations_screenshot.webp" alt="Диалоги Voicyfy" loading="lazy" />
                </div>
              </div>
            </div>
          </div>

          {/* 3. CRM */}
          <div className="showcase-item rev">
            <div className="show-text">
              <div className="icon-box ib-amber">
                <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                </svg>
              </div>
              <h3>CRM-система</h3>
              <p>Карточки клиентов создаются автоматически — с полной историей общения, задачами и контактными данными из разговоров.</p>
              <ul className="show-feats">
                <li><i className="fas fa-check-circle"></i> <span>Карточки клиентов с историей обращений</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Автосоздание задач из разговоров</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Контактные данные и заметки</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Статусы и этапы воронки продаж</span></li>
                <li><i className="fas fa-check-circle"></i> <span>Привязка диалогов к карточке клиента</span></li>
              </ul>
            </div>
            <div className="mockup-wrap rev">
              <div className="mockup-frame">
                <div className="mock-topbar">
                  <div className="d r"></div><div className="d y"></div><div className="d g"></div>
                  <div className="url"><span>voicyfy.ru/dashboard/crm</span></div>
                </div>
                <div className="mock-img-wrap">
                  <img src="https://pub-b1e3de631e544c69b0ad6587f740e140.r2.dev/crm_screenshot.webp" alt="CRM Voicyfy" loading="lazy" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default ShowcaseSection;
