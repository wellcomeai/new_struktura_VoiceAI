import React from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';

// Обёртки для анимаций появления на Motion. Уважают prefers-reduced-motion.
// Анимация повторяется при каждом входе в экран: блок уходит в скрытое
// состояние, когда его пролистали, и появляется снова с той стороны,
// с которой в него вернулись (сверху при прокрутке вверх, снизу при вниз).
const EASE = [0.2, 0.7, 0.2, 1];
const VIEWPORT = { once: false, amount: 0.15, margin: '-32px 0px -32px 0px' };

// С какой стороны блок ушёл с экрана: -1 через верх (прокрутка вниз),
// 1 через низ (прокрутка вверх). Состояние обновляется в самом событии
// выхода вместе с флагом видимости, поэтому скрытое положение всегда
// считается с правильной стороны.
const SideContext = React.createContext(1);
const sideOf = (entry) => (entry && entry.boundingClientRect && entry.boundingClientRect.top < 0 ? -1 : 1);

function useInView() {
  const [st, setSt] = React.useState({ inView: false, side: 1 });
  const onEnter = React.useCallback(() => setSt((p) => (p.inView ? p : { ...p, inView: true })), []);
  const onLeave = React.useCallback((entry) => setSt({ inView: false, side: sideOf(entry) }), []);
  return [st, onEnter, onLeave];
}

function pick(as) {
  return motion[as] || motion.div;
}

export function Reveal({ children, className, as = 'div', delay = 0, y = 24, x = 0, ...rest }) {
  const reduce = useReducedMotion();
  const [st, onEnter, onLeave] = useInView();
  const M = pick(as);
  return (
    <M
      className={className}
      variants={{
        hidden: (side) => ({ opacity: 0, y: (side || 1) * y, x }),
        show: { opacity: 1, y: 0, x: 0, transition: { duration: 0.6, ease: EASE, delay } },
      }}
      custom={st.side}
      initial={reduce ? false : 'hidden'}
      animate={reduce || st.inView ? 'show' : 'hidden'}
      viewport={VIEWPORT}
      onViewportEnter={onEnter}
      onViewportLeave={onLeave}
      {...rest}
    >
      {children}
    </M>
  );
}

// Контейнер каскада: дети-Item появляются по очереди
export function Stagger({ children, className, as = 'div', stagger = 0.08, delay = 0, amount = 0.15, ...rest }) {
  const reduce = useReducedMotion();
  const [st, onEnter, onLeave] = useInView();
  const M = pick(as);
  return (
    <SideContext.Provider value={st.side}>
      <M
        className={className}
        initial={reduce ? false : 'hidden'}
        animate={reduce || st.inView ? 'show' : 'hidden'}
        viewport={{ once: false, amount, margin: '-32px 0px -32px 0px' }}
        onViewportEnter={onEnter}
        onViewportLeave={onLeave}
        variants={{ hidden: {}, show: { transition: { staggerChildren: stagger, delayChildren: delay } } }}
        {...rest}
      >
        {children}
      </M>
    </SideContext.Provider>
  );
}

export function Item({ children, className, as = 'div', y = 26, x = 0, scale = 1, rotate = 0, duration = 0.6, ...rest }) {
  const M = pick(as);
  const side = React.useContext(SideContext);
  return (
    <M
      className={className}
      custom={side}
      variants={{
        hidden: (s) => ({ opacity: 0, y: (s || 1) * y, x, scale, rotate }),
        show: { opacity: 1, y: 0, x: 0, scale: 1, rotate: 0, transition: { duration, ease: EASE } },
      }}
      {...rest}
    >
      {children}
    </M>
  );
}

// Число, которое отсчитывается от нуля при появлении
export function CountUp({ value, suffix = '', duration = 1.2 }) {
  const ref = React.useRef(null);
  const reduce = useReducedMotion();
  const [shown, setShown] = React.useState(reduce ? value : 0);
  React.useEffect(() => {
    if (reduce || !ref.current) return undefined;
    const el = ref.current;
    let raf = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - start) / (duration * 1000));
        const e = 1 - Math.pow(1 - p, 3);
        setShown(Math.round(value * e));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, duration, reduce]);
  return <span ref={ref}>{shown.toLocaleString('ru-RU')}{suffix}</span>;
}

// Параллакс: блок едет чуть медленнее прокрутки, пока проходит через экран
export function Parallax({ children, className, amount = 40 }) {
  const ref = React.useRef(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [amount, -amount]);
  return (
    <motion.div ref={ref} className={className} style={reduce ? undefined : { y }}>
      {children}
    </motion.div>
  );
}
