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

// Публичная витрина кабинета: цены моделей за минуту и приветственное
// начисление на кошелёк. Один запрос на страницу.
function useTariffPayload() {
  const [data, setData] = useState(cache);
  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    if (!pending) {
      pending = fetch('/api/wallet/tariffs')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && Array.isArray(d.tariffs) ? d : null))
        .catch(() => null);
    }
    pending.then((d) => { if (d) cache = d; if (alive) setData(d); });
    return () => { alive = false; };
  }, []);
  return data;
}

export function useTariffs() {
  const data = useTariffPayload();
  const tariffs = data && data.tariffs;
  if (tariffs && tariffs.length) {
    return tariffs.filter((t) => MODELS[t.code]).map((t) => ({ code: t.code, name: MODELS[t.code].name, price: fmtPrice(t), rub: Number(t.price_rub_per_min || 0) }));
  }
  return MODEL_ORDER.map((code) => ({ code, name: MODELS[code].name, price: null, rub: null }));
}

// Приветственные рубли на кошельке; пока ответа нет, показываем 65
export function useWelcomeGrant() {
  const data = useTariffPayload();
  const v = data && Number(data.welcome_grant_rub);
  return v && v > 0 ? v : 65;
}
