import React, { useState, useRef } from 'react';
import { useEmailVerification } from '../../hooks/useEmailVerification';
import InlineNotification from '../InlineNotification';

function EmailVerificationSection({ email, message, onVerified }) {
  const [code, setCode] = useState('');
  const codeInputRef = useRef(null);

  const {
    attempts,
    secondsLeft,
    isTimerActive,
    notification,
    isVerifying,
    isResending,
    codeDisabled,
    verifyCode,
    resendCode
  } = useEmailVerification(email, onVerified);

  const handleVerify = () => {
    verifyCode(code);
    if (attempts > 1) {
      setCode('');
      if (codeInputRef.current) {
        codeInputRef.current.focus();
      }
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleVerify();
    }
  };

  const handleResend = () => {
    resendCode();
    setCode('');
    if (codeInputRef.current) {
      codeInputRef.current.focus();
    }
  };

  const attemptsClass = attempts === 2 ? 'warning' : attempts === 1 ? 'danger' : '';

  return (
    <div className="verification-section">
      <div className={`verification-notice${message ? ' warning' : ''}`}>
        <i className={message ? 'fas fa-info-circle' : 'fas fa-envelope'}></i>
        {message || (
          <>Код подтверждения отправлен на <strong>{email}</strong></>
        )}
      </div>

      <InlineNotification notification={notification} />

      <div className="code-input-container">
        <label htmlFor="verification-code">Введите 6-значный код</label>
        <input
          type="text"
          id="verification-code"
          ref={codeInputRef}
          className="form-control verification-code-input"
          placeholder="000000"
          maxLength="6"
          pattern="[0-9]{6}"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          onKeyPress={handleKeyPress}
          disabled={codeDisabled}
          autoFocus
        />
      </div>

      <div className="verification-info">
        <span className={`attempts-left ${attemptsClass}`}>
          Осталось попыток: {attempts}
        </span>
        {isTimerActive && (
          <span className="resend-timer">
            Повторная отправка через <strong>{secondsLeft}</strong>с
          </span>
        )}
      </div>

      <button
        type="button"
        className="btn btn-primary"
        style={{ width: '100%' }}
        onClick={handleVerify}
        disabled={isVerifying || codeDisabled}
      >
        {isVerifying ? (
          <><div className="spinner"></div> Проверяем...</>
        ) : (
          'Подтвердить email'
        )}
      </button>

      {!isTimerActive && (
        <button
          type="button"
          className="btn btn-resend"
          style={{ width: '100%' }}
          onClick={handleResend}
          disabled={isResending}
        >
          {isResending ? (
            <><div className="spinner"></div> Отправка...</>
          ) : (
            <><i className="fas fa-redo"></i> Отправить код повторно</>
          )}
        </button>
      )}
    </div>
  );
}

export default EmailVerificationSection;
