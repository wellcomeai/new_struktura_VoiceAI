import React from 'react';
import { motion, useReducedMotion } from 'motion/react';

// Обёртки для анимаций появления на Motion. Уважают prefers-reduced-motion.
const EASE = [0.2, 0.7, 0.2, 1];
const VIEWPORT = { once: true, amount: 0.2, margin: '0px 0px -60px 0px' };

function pick(as) {
  return motion[as] || motion.div;
}

// Одиночный блок: всплывает снизу, когда попадает в экран
export function Reveal({ children, className, as = 'div', delay = 0, y = 24, x = 0, ...rest }) {
  const reduce = useReducedMotion();
  const M = pick(as);
  return (
    <M
      className={className}
      initial={reduce ? false : { opacity: 0, y, x }}
      whileInView={{ opacity: 1, y: 0, x: 0 }}
      viewport={VIEWPORT}
      transition={{ duration: 0.6, ease: EASE, delay }}
      {...rest}
    >
      {children}
    </M>
  );
}

// Контейнер каскада: дети-Item появляются по очереди
export function Stagger({ children, className, as = 'div', stagger = 0.08, delay = 0, amount = 0.15, ...rest }) {
  const reduce = useReducedMotion();
  const M = pick(as);
  return (
    <M
      className={className}
      initial={reduce ? false : 'hidden'}
      whileInView="show"
      viewport={{ once: true, amount, margin: '0px 0px -40px 0px' }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: stagger, delayChildren: delay } } }}
      {...rest}
    >
      {children}
    </M>
  );
}

export function Item({ children, className, as = 'div', y = 26, x = 0, scale = 1, rotate = 0, duration = 0.6, ...rest }) {
  const M = pick(as);
  return (
    <M
      className={className}
      variants={{
        hidden: { opacity: 0, y, x, scale, rotate },
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
