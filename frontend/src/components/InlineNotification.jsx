import React from 'react';
import Icon from './Icon';

const ICONS = {
  success: 'circle-check',
  error: 'circle-alert',
  warning: 'triangle-alert',
  info: 'info',
};

function InlineNotification({ notification }) {
  if (!notification) return null;
  const type = notification.type || 'info';
  return (
    <div className={`note lp-inote lp-inote-${type}`} role="status">
      {type === 'loading' ? <span className="spin" /> : <Icon name={ICONS[type] || ICONS.info} className="ic-sm" />}
      <span>{notification.message}</span>
    </div>
  );
}

export default InlineNotification;
