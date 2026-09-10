import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Icon from './Icon';
import ModelLogo, { MODELS } from './ModelLogo';

// Четыре сценария: входящие у ассистента, исходящие у агента. Каждый
// проигрывается один раз, порядок при загрузке случайный. Размер карточки
// фиксирован, реплики появляются внутри без прыжков раскладки.
const SCENES = [
  {
    key: 'salon', label: 'Входящий · салон', dir: 'in', name: 'Администратор салона', model: 'gemini',
    msgs: [
      { who: 'user', text: 'Здравствуйте, хочу записаться на стрижку в субботу' },
      { who: 'bot', text: 'Конечно! В субботу свободно 11:00 и 15:30. Какое время удобнее?' },
      { who: 'user', text: 'Давайте 15:30, к Ольге' },
      { who: 'bot', text: 'Записала к Ольге на 15:30. Пришлю SMS с адресом.', tags: ['crm', 'calendar', 'sms'] },
    ],
  },
  {
    key: 'clinic', label: 'Входящий · клиника', dir: 'in', name: 'Регистратура клиники', model: 'yandex',
    msgs: [
      { who: 'user', text: 'Мне нужно перенести приём с четверга' },
      { who: 'bot', text: 'Вижу запись к терапевту на четверг, 10:00. Подойдёт пятница в то же время?' },
      { who: 'user', text: 'Да, пятница подходит' },
      { who: 'bot', text: 'Перенесла на пятницу, 10:00. Напомню за день.', tags: ['calendar', 'bell', 'crm'] },
    ],
  },
  {
    key: 'showroom', label: 'Исходящий · агент', dir: 'out', name: 'Агент шоурума', model: 'openai',
    msgs: [
      { who: 'bot', text: 'Марина, добрый день! Шоурум «Лея». Пришла новая коллекция, хотела рассказать.' },
      { who: 'user', text: 'Интересно. Платья 44 размера есть?' },
      { who: 'bot', text: 'Шесть моделей. Отправлю подборку в Telegram и запишу на примерку в субботу?', tags: ['telegram'] },
      { who: 'user', text: 'Да, давайте', tags: ['crm', 'calendar'] },
    ],
  },
  {
    key: 'service', label: 'Напоминание · агент', dir: 'out', name: 'Агент автосервиса', model: 'fish',
    msgs: [
      { who: 'bot', text: 'Игорь, добрый день, автосервис «Мотор». Напоминаю: завтра в 9:00 замена масла.' },
      { who: 'user', text: 'А можно перенести на 11?' },
      { who: 'bot', text: 'В 11:00 свободно, перенёс. Пришлю SMS с подтверждением. Ждём вас!', tags: ['calendar', 'sms', 'crm'] },
    ],
  },
];

const TAGS = {
  crm: { icon: 'square-check', label: 'Запись в CRM' },
  calendar: { icon: 'calendar', label: 'Календарь' },
  bell: { icon: 'bell', label: 'Уведомление' },
  sms: { icon: 'message-square', label: 'SMS' },
  telegram: { icon: 'send', label: 'Telegram' },
};

const pad = (n) => String(n).padStart(2, '0');

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function CallCard() {
  const order = useMemo(() => shuffle(SCENES.map((s) => s.key)), []);
  const [pos, setPos] = useState(0);
  const [sceneKey, setSceneKey] = useState(order[0]);
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [run, setRun] = useState(0); // перезапуск сцены по клику
  const reduce = useReducedMotion();
  const timers = useRef([]);

  const scene = SCENES.find((s) => s.key === sceneKey) || SCENES[0];

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)); };

  // Таймер звонка
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Прогон сцены: реплики по очереди, один раз, затем следующая сцена
  useEffect(() => {
    clear();
    setShown(0);
    setTyping(false);
    setSeconds(0);
    if (reduce) { setShown(scene.msgs.length); return clear; }
    let i = 0;
    const step = () => {
      if (i >= scene.msgs.length) {
        later(() => {
          const next = (pos + 1) % order.length;
          setPos(next);
          setSceneKey(order[next]);
        }, 4500);
        return;
      }
      const m = scene.msgs[i];
      setTyping(true);
      later(() => {
        setTyping(false);
        i += 1;
        setShown(i);
        later(step, 700);
      }, m.who === 'bot' ? 1400 : 1000);
    };
    later(step, 600);
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey, run]);

  const pickScene = (key) => {
    const idx = order.indexOf(key);
    setPos(idx < 0 ? 0 : idx);
    if (key === sceneKey) setRun((r) => r + 1); else setSceneKey(key);
  };

  const tags = scene.msgs.slice(0, shown).flatMap((m) => m.tags || []);
  const nextWho = shown < scene.msgs.length ? scene.msgs[shown].who : 'bot';

  return (
    <div className="cc-wrap">
      <div className="cc-scenes" role="tablist" aria-label="Сценарии звонка">
        {SCENES.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={s.key === sceneKey}
            className={`cc-scene${s.key === sceneKey ? ' on' : ''}`}
            onClick={() => pickScene(s.key)}
          >
            <Icon name={s.dir === 'in' ? 'phone-incoming' : 'phone-outgoing'} className="ic-sm" />{s.label}
          </button>
        ))}
      </div>
      <div className="cc" aria-hidden="true">
        <div className="cc-head">
          <div className="cc-avatar"><span className="vf-wave"><i></i><i></i><i></i><i></i><i></i></span></div>
          <div className="cc-who">
            <div className="cc-name">{scene.name}</div>
            <div className="cc-sub">
              <span className="cc-live"></span>
              {scene.dir === 'in' ? 'Входящий звонок' : 'Исходящий звонок'} · {pad(Math.floor(seconds / 60))}:{pad(seconds % 60)}
            </div>
          </div>
          <span className="chip chip-success"><Icon name={scene.dir === 'in' ? 'phone-incoming' : 'phone-outgoing'} className="ic-sm" />На линии</span>
        </div>
        <div className="cc-msgs">
          <AnimatePresence initial={false}>
            {scene.msgs.slice(0, shown).map((m, i) => (
              <motion.div
                key={`${scene.key}-${run}-${i}`}
                className={`cc-msg cc-msg-${m.who}`}
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
              >
                <span>{m.text}</span>
              </motion.div>
            ))}
            {typing && (
              <motion.div
                key={`${scene.key}-${run}-typing-${shown}`}
                className={`cc-msg cc-msg-${nextWho} cc-typing`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
              >
                <span><i></i><i></i><i></i></span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="cc-foot">
          <span className="cc-model"><ModelLogo code={scene.model} size={14} wrap={false} />{MODELS[scene.model].name}</span>
          <div className="cc-tags">
            {Object.keys(TAGS).filter((k) => scene.msgs.some((m) => (m.tags || []).includes(k))).map((k) => (
              <span key={k} className={`cc-tag${tags.includes(k) ? ' on' : ''}`}>
                <Icon name={TAGS[k].icon} className="ic-sm" />{TAGS[k].label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CallCard;
