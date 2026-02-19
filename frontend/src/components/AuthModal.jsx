import React, { useEffect } from 'react';
import LoginForm from './AuthSection/LoginForm';
import RegisterForm from './AuthSection/RegisterForm';

function AuthModal({ isOpen, activeTab, onTabChange, onClose }) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-container">
        <button className="modal-close" onClick={onClose}>
          <i className="fas fa-times"></i>
        </button>

        <div className="modal-logo">
          <img src="/static/images/IMG_2820.PNG" alt="Voicyfy" />
          <span className="modal-logo-text">Voicyfy</span>
        </div>

        <div className="modal-tabs">
          <button
            className={`modal-tab${activeTab === 'login' ? ' active' : ''}`}
            onClick={() => onTabChange('login')}
          >
            Вход
          </button>
          <button
            className={`modal-tab${activeTab === 'register' ? ' active' : ''}`}
            onClick={() => onTabChange('register')}
          >
            Регистрация
          </button>
        </div>

        {activeTab === 'login' && (
          <LoginForm onSwitchToRegister={() => onTabChange('register')} />
        )}
        {activeTab === 'register' && (
          <RegisterForm onSwitchToLogin={() => onTabChange('login')} />
        )}

        <div className="modal-footer-text">
          Бесплатно 3 дня &middot; Без карты
        </div>
      </div>
    </div>
  );
}

export default AuthModal;
