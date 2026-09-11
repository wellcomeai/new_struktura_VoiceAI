import React, { useState } from 'react';
import api from '../../utils/api';
import { useReferralTracker } from '../../hooks/useReferralTracker';
import InlineNotification from '../InlineNotification';
import Icon from '../Icon';
import EmailVerificationSection from './EmailVerificationSection';
import PasswordField from './PasswordField';
import { rememberFirstName } from '../../utils/rememberedName';

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
    setNotification({ type: 'loading', message: 'Отправляем код подтверждения на email...' });
    setIsLoading(true);
    try {
      const referralData = getReferralData();
      const userData = {
        email,
        password,
        first_name: firstName || null,
        last_name: null,
        company_name: companyName || null,
        referral_code: referralData?.referral_code || null,
        utm_data: referralData?.utm_data || null,
      };
      const data = await api.register(userData);
      rememberFirstName(firstName);
      setNotification({ type: 'success', message: 'Код отправлен! Проверьте email.' });

      if (data.message && data.message.includes('exists but not verified')) {
        setVerificationMessage('Аккаунт уже существует. Новый код подтверждения отправлен на email.');
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

  if (showVerification) {
    return (
      <EmailVerificationSection
        email={email}
        message={verificationMessage}
        onVerified={() => { window.location.href = '/static/dashboard.html'; }}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="lp-form">
      <div className="lp-auth-head">
        <h2 className="lp-auth-title">Создайте аккаунт</h2>
        <p className="lp-auth-sub">3 дня полного доступа ко всем функциям</p>
      </div>

      <div className="lp-auth-fields">
        <div className="lp-auth-row">
          <div className="field">
            <label className="label" htmlFor="register-name">Имя</label>
            <input type="text" id="register-name" className="input" placeholder="Как к вам обращаться" autoComplete="given-name"
              value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="register-company">Компания <span className="muted">необязательно</span></label>
            <input type="text" id="register-company" className="input" placeholder="Название компании" autoComplete="organization"
              value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="register-email">Email</label>
          <div className="input-wrap lp-auth-input">
            <Icon name="mail" className="ic-sm" />
            <input type="email" id="register-email" className="input" placeholder="you@company.com" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="register-password">Пароль <span className="muted">минимум 8 символов</span></label>
          <PasswordField
            id="register-password"
            placeholder="••••••••"
            minLength="8"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <InlineNotification notification={notification} />

        <button type="submit" className="btn btn-primary btn-lg lp-form-submit" disabled={isLoading}>
          {isLoading
            ? <><span className="spin" /> Регистрируем...</>
            : <>Создать аккаунт <Icon name="arrow-right" /></>}
        </button>
        <p className="lp-form-legal">
          Нажимая кнопку, вы принимаете <a href="/static/terms-of-service.html" target="_blank" rel="noopener">соглашение</a> и{' '}
          <a href="/static/privacy-policy.html" target="_blank" rel="noopener">политику конфиденциальности</a>.
        </p>
      </div>

      <p className="lp-form-hint">
        Уже есть аккаунт?{' '}
        <a href="#login" onClick={(e) => { e.preventDefault(); onSwitchToLogin(); }}>Войти</a>
      </p>
    </form>
  );
}

export default RegisterForm;
