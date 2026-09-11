import React, { useState } from 'react';
import api from '../../utils/api';
import InlineNotification from '../InlineNotification';
import Icon from '../Icon';
import PasswordField from './PasswordField';

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
      setTimeout(() => { window.location.href = '/static/dashboard.html'; }, 500);
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
    <form onSubmit={handleSubmit} className="lp-form">
      <div className="lp-auth-head">
        <h2 className="lp-auth-title">Вход в кабинет</h2>
        <p className="lp-auth-sub">Войдите, чтобы продолжить работу с ассистентами</p>
      </div>

      <div className="lp-auth-fields">
        <div className="field">
          <label className="label" htmlFor="login-email">Email</label>
          <div className="input-wrap lp-auth-input">
            <Icon name="mail" className="ic-sm" />
            <input type="email" id="login-email" className="input" placeholder="you@company.com" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="login-password">Пароль</label>
          <PasswordField
            id="login-password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <InlineNotification notification={notification} />

        <button type="submit" className="btn btn-primary btn-lg lp-form-submit" disabled={isLoading}>
          {isLoading
            ? <><span className="spin" /> Входим...</>
            : <>Войти <Icon name="arrow-right" /></>}
        </button>
      </div>

      <p className="lp-form-hint">
        Нет аккаунта?{' '}
        <a href="#register" onClick={(e) => { e.preventDefault(); onSwitchToRegister(); }}>Создать бесплатно</a>
      </p>
    </form>
  );
}

export default LoginForm;
