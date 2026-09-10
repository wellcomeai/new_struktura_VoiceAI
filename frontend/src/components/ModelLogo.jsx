import React from 'react';

// Логотипы моделей: те же файлы, что в кабинете (/static/icons/models)
export const MODELS = {
  openai:  { file: 'openai.svg',          name: 'OpenAI' },
  gemini:  { file: 'gemini-color.svg',    name: 'Gemini' },
  yandex:  { file: 'yandex-color.svg',    name: 'Яндекс' },
  fish:    { file: 'fishaudio-color.svg', name: 'Fish Audio' },
  cascade: { file: 'cascade-color.svg',   name: 'Каскад' },
};

export const MODEL_ORDER = ['openai', 'gemini', 'yandex', 'fish', 'cascade'];

function ModelLogo({ code, size = 22, wrap = true }) {
  const m = MODELS[code];
  if (!m) return null;
  const img = (
    <img
      className={`logo${/-color\.svg$/.test(m.file) ? ' logo-color' : ''}`}
      src={`/static/icons/models/${m.file}`}
      alt={m.name}
      style={{ width: size, height: size }}
    />
  );
  if (!wrap) return img;
  return (
    <span className="logo-wrap" style={{ width: size + 14, height: size + 14 }}>{img}</span>
  );
}

export default ModelLogo;
