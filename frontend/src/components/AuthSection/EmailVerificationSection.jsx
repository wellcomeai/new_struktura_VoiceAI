import React, { useState, useRef } from 'react';
import { useEmailVerification } from '../../hooks/useEmailVerification';
import InlineNotification from '../InlineNotification';
import Icon from '../Icon';

function EmailVerificationSection({ email, message, onVerified }) {
  const [code, setCode] = useState('');
  const codeInputRef = useRef(null);

  const {
    attempts, secondsLeft, isTimerActive, notification, isVerifying, isResending, codeDisabled, verifyCode, resendCode,
  } = useEmailVerification(email, onVerified);

  const handleVerify = () => {
    verifyCode(code);
    if (attempts > 1) {
      setCode('');
      if (codeInputRef.current) codeInputRef.current.focus();
    }
  };

  const handleResend = () => {
    resendCode();
    setCode('');
    if (codeInputRef.current) codeInputRef.current.focus();
  };

  const attemptsClass = attempts === 2 ? 'chip-warning' : attempts === 1 ? 'chip-danger' : '';

  return (
    <div className="lp-form lp-verify">
      <div className="lp-auth-head">
        <div className={`lp-verify-icon${message ? ' warning' : ''}`}>
          <Icon name={message ? 'info' : 'mail'} />
        </div>
        <h2 className="lp-auth-title">Подтвердите почту</h2>
        <p className="lp-auth-sub">
          {message || <>Мы отправили 6-значный код на <b>{email}</b></>}
        </p>
      </div>

      <div className="lp-auth-fields">
        <div className="field">
          <label className="label" htmlFor="verification-code">Код из письма</label>
          <input
            type="text"
            id="verification-code"
            ref={codeInputRef}
            className="input lp-code-input"
            placeholder="000000"
            maxLength="6"
            pattern="[0-9]{6}"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleVerify(); } }}
            disabled={codeDisabled}
            autoFocus
          />
        </div>
        <div className="lp-verify-info">
          <span className={`chip ${attemptsClass}`.trim()}>Осталось попыток: {attempts}</span>
          {isTimerActive && <span className="muted">Повторная отправка через <b>{secondsLeft}</b> с</span>}
        </div>

        <InlineNotification notification={notification} />

        <button type="button" className="btn btn-primary btn-lg lp-form-submit" onClick={handleVerify} disabled={isVerifying || codeDisabled}>
          {isVerifying
            ? <><span className="spin" /> Проверяем...</>
            : <>Подтвердить <Icon name="arrow-right" /></>}
        </button>
        {!isTimerActive && (
          <button type="button" className="btn btn-lg lp-form-submit" onClick={handleResend} disabled={isResending}>
            {isResending ? <><span className="spin" /> Отправка...</> : <><Icon name="refresh-cw" />Отправить код повторно</>}
          </button>
        )}
      </div>
    </div>
  );
}

export default EmailVerificationSection;
