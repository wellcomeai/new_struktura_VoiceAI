import React, { useEffect, useState } from 'react';
import Icon from './Icon';

// Реплики печатаются по очереди, теги действий появляются по ходу разговора
const SCRIPT = [
  { who: 'user', text: 'Здравствуйте, хочу записаться на завтра' },
  { who: 'bot', text: 'Конечно! На завтра свободно в 12:00 и 16:30. Какое время удобнее?' },
  { who: 'user', text: 'Давайте в 16:30' },
  { who: 'bot', text: 'Записал вас на 16:30. Напомню за час до визита.', tags: ['crm', 'calendar', 'bell'] },
];

const TAGS = {
  crm: { icon: 'square-check', label: 'Запись в CRM' },
  calendar: { icon: 'calendar', label: 'Календарь' },
  bell: { icon: 'bell', label: 'Уведомление' },
};

function pad(n) { return String(n).padStart(2, '0'); }

function CallCard() {
  const [shown, setShown] = useState(1);
  const [typing, setTyping] = useState(false);
  const [seconds, setSeconds] = useState(42);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timers = [];
    const step = () => {
      if (cancelled) return;
      if (shown >= SCRIPT.length) {
        timers.push(setTimeout(() => { if (!cancelled) { setShown(1); setTyping(false); } }, 6000));
        return;
      }
      setTyping(true);
      timers.push(setTimeout(() => {
        if (cancelled) return;
        setTyping(false);
        setShown((n) => n + 1);
      }, SCRIPT[shown].who === 'bot' ? 1500 : 1100));
    };
    timers.push(setTimeout(step, 700));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [shown]);

  const tags = SCRIPT.slice(0, shown).flatMap((m) => m.tags || []);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;

  return (
    <div className="cc" aria-hidden="true">
      <div className="cc-head">
        <div className="cc-avatar"><span className="vf-wave"><i></i><i></i><i></i><i></i><i></i></span></div>
        <div className="cc-who">
          <div className="cc-name">Ассистент «Менеджер»</div>
          <div className="cc-sub"><span className="cc-live"></span>Входящий звонок · {pad(mm)}:{pad(ss)}</div>
        </div>
        <span className="chip chip-success"><Icon name="phone-incoming" className="ic-sm" />На линии</span>
      </div>
      <div className="cc-msgs">
        {SCRIPT.slice(0, shown).map((m, i) => (
          <div key={i} className={`cc-msg cc-msg-${m.who}`}><span>{m.text}</span></div>
        ))}
        {typing && (
          <div className={`cc-msg cc-msg-${SCRIPT[shown].who} cc-typing`}><span><i></i><i></i><i></i></span></div>
        )}
      </div>
      <div className="cc-foot">
        {['crm', 'calendar', 'bell'].map((k) => (
          <span key={k} className={`cc-tag${tags.includes(k) ? ' on' : ''}`}>
            <Icon name={TAGS[k].icon} className="ic-sm" />{TAGS[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default CallCard;
