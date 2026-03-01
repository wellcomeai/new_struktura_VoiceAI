import React from 'react';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

function AuthSection({ activeTab, setActiveTab }) {
  const switchToLogin = () => {
    setActiveTab('login');
  };

  const switchToRegister = () => {
    setActiveTab('register');
  };

  return (
    <section className="auth-section" id="auth">
      <div className="auth-header rev">
        <h2 className="s-title">Начните бесплатно</h2>
        <p className="s-desc" style={{ margin: '0 auto' }}>3 дня полного доступа ко всем функциям без ограничений</p>
      </div>

      <div className="auth-box rev d1">
        <div className="auth-tabs">
          <button
            className={`auth-tab${activeTab === 'login' ? ' active' : ''}`}
            onClick={switchToLogin}
          >
            Вход
          </button>
          <button
            className={`auth-tab${activeTab === 'register' ? ' active' : ''}`}
            onClick={switchToRegister}
          >
            Регистрация
          </button>
        </div>

        {activeTab === 'login' && (
          <LoginForm onSwitchToRegister={switchToRegister} />
        )}
        {activeTab === 'register' && (
          <RegisterForm onSwitchToLogin={switchToLogin} />
        )}
      </div>
    </section>
  );
}

export default AuthSection;
