import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './landing.css';

const container = document.getElementById('root');
const app = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// index.html собирается с готовой разметкой (scripts/prerender.mjs):
// тогда React гидрирует её, а не рисует заново. Пустой #root (dev-сервер)
// рендерится как раньше.
if (container.hasChildNodes()) {
  ReactDOM.hydrateRoot(container, app);
} else {
  ReactDOM.createRoot(container).render(app);
}
