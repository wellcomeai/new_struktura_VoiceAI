import React from 'react';
import { Reveal } from './Reveal';

// Заголовок раздела: индекс моноширинным, заголовок и подводка слева
function SectionHead({ index, title, lead, children }) {
  return (
    <Reveal className="sh" y={16}>
      <span className="sh-index">{index}</span>
      <div className="sh-text">
        <h2>{title}</h2>
        {lead && <p className="lp-lead">{lead}</p>}
        {children}
      </div>
    </Reveal>
  );
}

export default SectionHead;
