import React, { useEffect } from 'react';
import Icon from './Icon';
import LoginForm from './AuthSection/LoginForm';
import RegisterForm from './AuthSection/RegisterForm';

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

  return (
    <div className="lp-auth-backdrop" onClick={onClose}>
      <div className="lp-auth card card-raised" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn btn-ghost btn-icon lp-auth-close" aria-label="Закрыть" onClick={onClose}>
          <Icon name="x" />
        </button>
        <div className="vf-logo lp-logo lp-auth-logo"><img src="/static/images/IMG_2820.PNG" alt="" /><span className="wordmark">Voicyfy</span></div>
        <h2 className="lp-auth-title">{activeTab === 'login' ? 'С возвращением' : 'Начните бесплатно'}</h2>
        <p className="lp-auth-sub">{activeTab === 'login' ? 'Войдите в кабинет' : '3 дня полного доступа без карты'}</p>
        <div className="tabs lp-auth-tabs" role="tablist">
          <button type="button" role="tab" className={`tab${activeTab === 'login' ? ' active' : ''}`} onClick={() => setActiveTab('login')}>Вход</button>
          <button type="button" role="tab" className={`tab${activeTab === 'register' ? ' active' : ''}`} onClick={() => setActiveTab('register')}>Регистрация</button>
        </div>
        {activeTab === 'login'
          ? <LoginForm onSwitchToRegister={() => setActiveTab('register')} />
          : <RegisterForm onSwitchToLogin={() => setActiveTab('login')} />}
      </div>
    </div>
  );
}

export default AuthModal;
