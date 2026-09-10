import React from 'react';

// Иконки Lucide из спрайта кабинета /static/icons/ui.svg
function Icon({ name, className = '' }) {
  return (
    <svg className={`ic ${className}`.trim()} aria-hidden="true">
      <use href={`/static/icons/ui.svg#i-${name}`} />
    </svg>
  );
}

export default Icon;
