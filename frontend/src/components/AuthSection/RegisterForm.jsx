import React, { useState } from 'react';
import api from '../../utils/api';
import { useReferralTracker } from '../../hooks/useReferralTracker';
import InlineNotification from '../InlineNotification';
import EmailVerificationSection from './EmailVerificationSection';

function RegisterForm({ onSwitchToLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [notification, setNotification] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showVerification, setShowVerification] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState(null);

  const { getReferralData, clearReferralData } = useReferralTracker();

  const handleSubmit = async (e) => {
    e.preventDefault();

    setNotification({ type: 'loading', message: 'Отправляем код верификации на email...' });
    setIsLoading(true);

    try {
      const referralData = getReferralData();

      const userData = {
        email: email,
        password: password,
        first_name: firstName || null,
        last_name: null,
        company_name: companyName || null,
        referral_code: referralData?.referral_code || null,
        utm_data: referralData?.utm_data || null
      };

      const data = await api.register(userData);

      setNotification({ type: 'success', message: 'Код отправлен! Проверьте email.' });

      if (data.message && data.message.includes('exists but not verified')) {
        setVerificationMessage('Аккаунт уже существует. Новый код верификации отправлен на email!');
        setShowVerification(true);
        return;
      }

      if (data.verification_required && data.verification_sent) {
        setShowVerification(true);
        clearReferralData();
      } else if (data.token) {
        localStorage.setItem('auth_token', data.token);
        window.location.href = '/static/dashboard.html';
      }

    } catch (error) {
      setIsLoading(false);

      if (error.message.includes('already registered')) {
        setNotification({ type: 'error', message: 'Email уже зарегистрирован и подтверждён. Войдите в аккаунт.' });
        setTimeout(() => onSwitchToLogin(), 2000);
      } else {
        setNotification({ type: 'error', message: error.message || 'Ошибка регистрации' });
      }
    }
  };

  return (
    <form className="auth-form active" onSubmit={handleSubmit}>
      <h2 className="auth-title">Создайте аккаунт</h2>

      <InlineNotification notification={notification} />

      <div className="form-group">
        <label htmlFor="register-email">Email</label>
        <input
          type="email"
          id="register-email"
          className="form-control"
          placeholder="your@email.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label htmlFor="register-password">Пароль</label>
        <input
          type="password"
          id="register-password"
          className="form-control"
          placeholder="Минимум 8 символов"
          required
          minLength="8"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label htmlFor="register-name">Имя</label>
        <input
          type="text"
          id="register-name"
          className="form-control"
          placeholder="Введите ваше имя"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label htmlFor="register-company">Компания (опционально)</label>
        <input
          type="text"
          id="register-company"
          className="form-control"
          placeholder="Название вашей компании"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        />
      </div>

      {showVerification && (
        <EmailVerificationSection
          email={email}
          message={verificationMessage}
          onVerified={() => {
            window.location.href = '/static/dashboard.html';
          }}
        />
      )}

      {!showVerification && (
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={isLoading}
        >
          {isLoading ? (
            <><div className="spinner"></div> Отправка...</>
          ) : (
            'Зарегистрироваться'
          )}
        </button>
      )}

      <div className="auth-footer">
        <p>Уже есть аккаунт?{' '}
          <a
            href="#login"
            className="switch-auth"
            onClick={(e) => {
              e.preventDefault();
              onSwitchToLogin();
            }}
          >
            Войти
          </a>
        </p>
      </div>
    </form>
  );
}

export default RegisterForm;
