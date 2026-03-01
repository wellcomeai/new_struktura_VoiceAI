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
    <form onSubmit={handleSubmit}>
      <InlineNotification notification={notification} />

      <div className="fg">
        <label htmlFor="login-email">Email</label>
        <input
          type="email"
          id="login-email"
          className="fi"
          placeholder="your@email.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="fg">
        <label htmlFor="login-password">Пароль</label>
        <input
          type="password"
          id="login-password"
          className="fi"
          placeholder="••••••••"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <button
        type="submit"
        className="btn-submit"
        disabled={isLoading}
      >
        {isLoading ? 'Входим...' : 'Войти'}
      </button>

      <p className="auth-hint">
        Нет аккаунта?{' '}
        <a
          onClick={(e) => {
            e.preventDefault();
            onSwitchToRegister();
          }}
        >
          Зарегистрироваться
        </a>
      </p>
    </form>
  );
}

export default LoginForm;
