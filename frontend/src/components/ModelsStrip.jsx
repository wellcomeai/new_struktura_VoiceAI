import React, { useEffect, useState } from 'react';
import ModelLogo, { MODELS, MODEL_ORDER } from './ModelLogo';

function fmtPrice(t) {
  const v = Number(t.price_rub_per_min || 0);
  if (!v) return 'бесплатно';
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  return `${s.replace('.', ',')} ₽/мин`;
}

// Витрина моделей с ценой за минуту: живые данные из публичного эндпоинта
// кабинета, без них показываем только названия.
function ModelsStrip() {
  const [tariffs, setTariffs] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/wallet/tariffs')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && Array.isArray(d.tariffs)) setTariffs(d.tariffs); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const items = tariffs && tariffs.length
    ? tariffs.filter((t) => MODELS[t.code]).map((t) => ({ code: t.code, name: MODELS[t.code].name, price: fmtPrice(t) }))
    : MODEL_ORDER.map((code) => ({ code, name: MODELS[code].name, price: null }));

  return (
    <section className="lp-models-strip">
      <div className="lp-container lp-models">
        <span className="lp-models-label">Работает на</span>
        <div className="lp-models-list">
          {items.map((m) => (
            <span key={m.code} className="lp-model">
              <ModelLogo code={m.code} size={16} wrap={false} />
              {m.name}
              {m.price && <b>{m.price}</b>}
            </span>
          ))}
        </div>
        <span className="lp-models-note">Свой ключ провайдера: минуты бесплатно</span>
      </div>
    </section>
  );
}

export default ModelsStrip;
