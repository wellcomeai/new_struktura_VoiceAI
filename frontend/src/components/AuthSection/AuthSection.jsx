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
    <div className="auth-section">
      <div className="auth-tabs">
        <div
          className={`auth-tab${activeTab === 'login' ? ' active' : ''}`}
          onClick={switchToLogin}
        >
          Вход
        </div>
        <div
          className={`auth-tab${activeTab === 'register' ? ' active' : ''}`}
          onClick={switchToRegister}
        >
          Регистрация
        </div>
      </div>

      {activeTab === 'login' && (
        <LoginForm onSwitchToRegister={switchToRegister} />
      )}
      {activeTab === 'register' && (
        <RegisterForm onSwitchToLogin={switchToLogin} />
      )}
    </div>
  );
}

export default AuthSection;
