import React from 'react';

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="8" fill="#eff6ff"/>
    <path d="M5 8l2 2 4-4"
      stroke="#2563eb" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ChipIcon = () => (
  <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="10" y="10" width="4" height="4" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </svg>
);

const PhoneIcon = () => (
  <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 15a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 4.22h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 11.8a16 16 0 006.29 6.29l1.87-1.87a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 18.92z" />
  </svg>
);

function AgentSection({ onOpenModal }) {
  return (
    <section className="section agent-section" id="agent">
      <div className="section-inner">
        <div className="s-head rev">
          <span className="s-label">Уникальная разработка Voicyfy</span>
          <h2 className="s-title">Voicyfy Agent — <span className="gt">сотрудник, который звонит сам</span></h2>
          <p className="s-desc">Автономный AI-агент сам совершает исходящие, принимает входящие, помнит каждого клиента и планирует следующий шаг — без участия человека</p>
        </div>

        {/* Два мозга */}
        <div className="agent-brains">
          <div className="agent-brain rev">
            <div className="icon-box ib-blue"><ChipIcon /></div>
            <h3>ИИ-оркестратор</h3>
            <p className="agent-brain-role">Руководитель. Никогда не говорит с клиентом — только управляет</p>
            <ul className="show-feats">
              <li><CheckIcon /> <span>Изучает клиента перед звонком</span></li>
              <li><CheckIcon /> <span>Готовит стратегию разговора</span></li>
              <li><CheckIcon /> <span>Анализирует итоги после звонка</span></li>
              <li><CheckIcon /> <span>Сам ставит следующие задачи</span></li>
            </ul>
          </div>
          <div className="agent-brain rev d1">
            <div className="icon-box ib-green"><PhoneIcon /></div>
            <h3>Голосовой ИИ-агент</h3>
            <p className="agent-brain-role">Сотрудник. Работает только во время звонка</p>
            <ul className="show-feats">
              <li><CheckIcon /> <span>Ведёт живой разговор без сценария</span></li>
              <li><CheckIcon /> <span>Отвечает и задаёт вопросы</span></li>
              <li><CheckIcon /> <span>Находит ответы прямо во время звонка</span></li>
              <li><CheckIcon /> <span>Передаёт итоги оркестратору</span></li>
            </ul>
          </div>
        </div>
        <p className="agent-note rev">Вместе они работают как один сотрудник</p>

        {/* Три фазы звонка */}
        <div className="agent-subhead rev">
          <h3>Каждый звонок проходит три фазы</h3>
          <p>Оркестратор работает до и после, голосовой агент — во время</p>
        </div>
        <div className="agent-phases rev">
          <div className="agent-phase">
            <span className="agent-phase-num">1</span>
            <h4>Precall — подготовка</h4>
            <ul>
              <li>Подтягивает историю клиента</li>
              <li>Читает память прошлых разговоров</li>
              <li>Берёт данные из CRM</li>
              <li>Готовит план и стратегию</li>
            </ul>
          </div>
          <div className="agent-phase-arrow">→</div>
          <div className="agent-phase">
            <span className="agent-phase-num">2</span>
            <h4>Разговор</h4>
            <ul>
              <li>Живой диалог без сценария</li>
              <li>Отвечает и задаёт вопросы</li>
              <li>Находит ответы в базе знаний</li>
              <li>Работает по своему промпту</li>
            </ul>
          </div>
          <div className="agent-phase-arrow">→</div>
          <div className="agent-phase">
            <span className="agent-phase-num">3</span>
            <h4>Postcall — выводы</h4>
            <ul>
              <li>Читает итоги разговора</li>
              <li>Обновляет память о клиенте</li>
              <li>Отправляет письма и SMS</li>
              <li>Сам ставит следующую задачу</li>
            </ul>
          </div>
        </div>

        {/* Исходящие и входящие */}
        <div className="agent-directions">
          <div className="agent-dir rev">
            <div className="agent-dir-head">
              <span className="agent-dir-arrow out">↑</span>
              <h4>Исходящие: полный цикл без человека</h4>
            </div>
            <ul className="show-feats">
              <li><CheckIcon /> <span>Задача приходит из CRM, чата или API</span></li>
              <li><CheckIcon /> <span>Оркестратор изучает клиента и готовит стратегию</span></li>
              <li><CheckIcon /> <span>Голосовой агент звонит и ведёт живой диалог</span></li>
              <li><CheckIcon /> <span>Итоги фиксируются, память обновляется</span></li>
              <li><CheckIcon /> <span>Сам планирует повторный звонок или следующий шаг</span></li>
            </ul>
          </div>
          <div className="agent-dir rev d1">
            <div className="agent-dir-head">
              <span className="agent-dir-arrow in">↓</span>
              <h4>Входящие: узнаёт клиента до первой фразы</h4>
            </div>
            <ul className="show-feats">
              <li><CheckIcon /> <span>Принимает звонок мгновенно, без ожидания и очереди</span></li>
              <li><CheckIcon /> <span>За доли секунды находит клиента в базе по номеру</span></li>
              <li><CheckIcon /> <span>Получает досье: имя, компания, история разговоров</span></li>
              <li><CheckIcon /> <span>Приветствует по имени — как знакомый менеджер</span></li>
              <li><CheckIcon /> <span>Запоминает данные о контакте после разговора</span></li>
            </ul>
          </div>
        </div>

        {/* Чипы про память */}
        <div className="agent-chips rev">
          <span className="agent-chip">Помнит все прошлые разговоры</span>
          <span className="agent-chip">Узнаёт клиента до первой фразы</span>
          <span className="agent-chip">Каждый звонок умнее предыдущего</span>
        </div>

        {/* CTA */}
        <div className="agent-cta rev">
          <button className="btn-primary-hero" onClick={() => onOpenModal('register')}>Попробовать бесплатно</button>
          <a
            className="btn-secondary-hero agent-video-btn"
            href="https://www.youtube.com/watch?v=NI_UMGrWt9E"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Смотреть обзор
          </a>
        </div>
      </div>
    </section>
  );
}

export default AgentSection;
