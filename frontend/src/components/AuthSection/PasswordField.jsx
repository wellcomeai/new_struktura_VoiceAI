import React, { useState } from 'react';
import Icon from '../Icon';

/**
 * Поле пароля с иконкой замка и кнопкой «показать / скрыть».
 * Чистый UI: значение и валидация остаются у родительской формы.
 */
function PasswordField({ id, value, onChange, placeholder, minLength, autoComplete }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="input-wrap lp-auth-input">
      <Icon name="lock" className="ic-sm" />
      <input
        type={visible ? 'text' : 'password'}
        id={id}
        className="input lp-auth-input-action"
        placeholder={placeholder}
        required
        minLength={minLength}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
      />
      <button
        type="button"
        className="lp-auth-eye"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
        tabIndex={-1}
      >
        <Icon name={visible ? 'eye-off' : 'eye'} className="ic-sm" />
      </button>
    </div>
  );
}

export default PasswordField;
