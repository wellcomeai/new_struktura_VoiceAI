import React, { useState } from 'react';
import api from '../../utils/api';
import InlineNotification from '../InlineNotification';

function LoginForm({ onSwitchToRegister }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notification, setNotification] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    setNotification({ type: 'loading', message: 'Выполняется вход...' });
    setIsLoading(true);

    try {
      const data = await api.login({ email, password });

      localStorage.setItem('auth_token', data.token);

      setNotification({ type: 'success', message: 'Успешный вход! Переходим...' });

      setTimeout(() => {
        window.location.href = '/static/dashboard.html';
      }, 500);

    } catch (error) {
      setIsLoading(false);

      if (error.message.includes('not verified') || error.message.includes('не подтвержден')) {
        setNotification({ type: 'warning', message: 'Email не подтверждён! Проверьте почту для кода верификации.' });
      } else if (error.message.includes('Invalid') || error.message.includes('password')) {
        setNotification({ type: 'error', message: 'Неверный email или пароль' });
      } else {
        setNotification({ type: 'error', message: error.message || 'Ошибка входа' });
      }
    }
  };

  return (
    <form className="auth-form active" onSubmit={handleSubmit}>
      <h2 className="auth-title">Вход в аккаунт</h2>

      <InlineNotification notification={notification} />

      <div className="form-group">
        <label htmlFor="login-email">Email</label>
        <input
          type="email"
          id="login-email"
          className="form-control"
          placeholder="your@email.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label htmlFor="login-password">Пароль</label>
        <input
          type="password"
          id="login-password"
          className="form-control"
          placeholder="••••••••"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <button
        type="submit"
        className="btn btn-primary"
        style={{ width: '100%' }}
        disabled={isLoading}
      >
        {isLoading ? (
          <><div className="spinner"></div> Вход...</>
        ) : (
          'Войти'
        )}
      </button>

      <div className="auth-footer">
        <p>Еще нет аккаунта?{' '}
          <a
            href="#register"
            className="switch-auth"
            onClick={(e) => {
              e.preventDefault();
              onSwitchToRegister();
            }}
          >
            Зарегистрироваться
          </a>
        </p>
      </div>
    </form>
  );
}

export default LoginForm;
