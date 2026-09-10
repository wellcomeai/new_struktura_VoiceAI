import { useEffect, useState } from 'react';
import { MODELS, MODEL_ORDER } from '../components/ModelLogo';

export function fmtPrice(t) {
  const v = Number(t.price_rub_per_min || 0);
  if (!v) return 'бесплатно';
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  return `${s.replace('.', ',')} ₽/мин`;
}

let cache = null;
let pending = null;

// Витрина моделей с ценой за минуту из публичного эндпоинта кабинета.
// Без ответа отдаём список моделей без цен.
export function useTariffs() {
  const [tariffs, setTariffs] = useState(cache);

  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    if (!pending) {
      pending = fetch('/api/wallet/tariffs')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && Array.isArray(d.tariffs) ? d.tariffs : null))
        .catch(() => null);
    }
    pending.then((list) => { if (list) cache = list; if (alive) setTariffs(list); });
    return () => { alive = false; };
  }, []);

  if (tariffs && tariffs.length) {
    return tariffs.filter((t) => MODELS[t.code]).map((t) => ({ code: t.code, name: MODELS[t.code].name, price: fmtPrice(t), rub: Number(t.price_rub_per_min || 0) }));
  }
  return MODEL_ORDER.map((code) => ({ code, name: MODELS[code].name, price: null, rub: null }));
}
