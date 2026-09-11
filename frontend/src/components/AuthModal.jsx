import React, { useEffect } from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';
import LoginForm from './AuthSection/LoginForm';
import RegisterForm from './AuthSection/RegisterForm';
import { getRememberedFirstName } from '../utils/rememberedName';

const REGISTER_STEPS = [
  'Зарегистрируйтесь',
  'Введите код, присланный на почту',
  'Создайте ассистента',
  'Подключите тестовый номер на 10 минут',
];

const LOGIN_POINTS = [
  { icon: 'bot', text: 'Ассистенты и их настройки' },
  { icon: 'phone-call', text: 'Звонки, номера и история диалогов' },
  { icon: 'wallet', text: 'Кошелёк и тарифы моделей' },
];

const MODELS = ['openai', 'gemini', 'yandex', 'fish', 'cascade'];
const MODEL_NAMES = { openai: 'OpenAI', gemini: 'Gemini', yandex: 'Яндекс', fish: 'Fish Audio', cascade: 'Каскад' };

function BrandRegister() {
  return (
    <div className="lp-auth-brand-main">
      <h3 className="lp-auth-brand-title">
        Первый звонок <span>за 10 минут</span>
      </h3>
      <ol className="lp-auth-steps">
        {REGISTER_STEPS.map((text, i) => (
          <li key={text}>
            <span className="lp-auth-step-n">{i + 1}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <div className="lp-auth-ready">
        <Icon name="phone-call" className="ic-sm" />
        <span>Готово! Можно звонить</span>
      </div>
    </div>
  );
}

function BrandLogin({ name }) {
  return (
    <div className="lp-auth-brand-main">
      <h3 className="lp-auth-brand-title">
        С возвращением{name ? <>, <span>{name}</span></> : null}
      </h3>
      <p className="lp-auth-brand-text">
        Войдите в кабинет — всё, что вы настроили, на месте.
      </p>
      <ul className="lp-auth-steps lp-auth-points">
        {LOGIN_POINTS.map((p) => (
          <li key={p.icon}>
            <span className="lp-auth-step-n"><Icon name={p.icon} /></span>
            <span>{p.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AuthModal({ isOpen, onClose, activeTab, setActiveTab }) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  const isLogin = activeTab === 'login';
  const rememberedName = isLogin ? getRememberedFirstName() : '';

  return (
    <div className="lp-auth-backdrop" onClick={onClose}>
      <div
        className={`lp-auth lp-auth-${activeTab}`}
        role="dialog"
        aria-modal="true"
        aria-label={isLogin ? 'Вход' : 'Регистрация'}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Левая брендовая панель: задаёт высоту, поэтому вход и регистрация одинаковые */}
        <aside className="lp-auth-brand">
          <div className="lp-auth-brand-top">
            <div className="vf-logo lp-auth-logo">
              <img src="/static/images/IMG_2820.PNG" alt="" />
              <span>Voicyfy</span>
            </div>
            <span className="lp-auth-badge">
              <span className="lp-auth-dot" />
              {isLogin ? 'Все сервисы работают' : '3 дня бесплатно · без карты'}
            </span>
          </div>

          {isLogin && rememberedName && (
            <div className="lp-auth-brand-greet">С возвращением, <span>{rememberedName}</span></div>
          )}

          <div className="lp-auth-brand-switch" key={activeTab}>
            {isLogin ? <BrandLogin name={rememberedName} /> : <BrandRegister />}
          </div>

          <div className="lp-auth-models">
            <span className="lp-auth-models-label">Работает на голосовых моделях</span>
            <div className="lp-auth-models-row">
              {MODELS.map((code) => (
                <span className={`lp-auth-model lp-auth-model-${code}`} key={code}>
                  <ModelLogo code={code} size={16} wrap={false} />
                  {MODEL_NAMES[code]}
                </span>
              ))}
            </div>
          </div>
        </aside>

        {/* Правая панель с формой */}
        <section className="lp-auth-pane">
          <button type="button" className="btn btn-icon lp-auth-close" aria-label="Закрыть" onClick={onClose}>
            <Icon name="x" />
          </button>

          <div className="lp-auth-switch" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={isLogin}
              className={`lp-auth-switch-btn${isLogin ? ' active' : ''}`}
              onClick={() => setActiveTab('login')}
            >
              Вход
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isLogin}
              className={`lp-auth-switch-btn${!isLogin ? ' active' : ''}`}
              onClick={() => setActiveTab('register')}
            >
              Регистрация
            </button>
          </div>

          <div className="lp-auth-body" key={activeTab}>
            {isLogin
              ? <LoginForm onSwitchToRegister={() => setActiveTab('register')} />
              : <RegisterForm onSwitchToLogin={() => setActiveTab('login')} />}
          </div>
        </section>
      </div>
    </div>
  );
}

export default AuthModal;
