// Серверный вход для пререндера лендинга (scripts/prerender.mjs).
// Рендерит App в строку, чтобы index.html содержал готовый текст:
// его читают роботы Яндекса, Google и ИИ-поиска, не выполняющие JS.
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './App';
import { QA } from './components/Faq';

export function render() {
  return renderToString(<App />);
}

// FAQPage из того же списка вопросов, что и секция FAQ, чтобы разметка
// не расходилась с текстом на странице.
export function faqJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: QA.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  });
}
