import React from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';
import SectionHead from './SectionHead';
import { Reveal } from './Reveal';
import { useTariffs } from '../hooks/useTariffs';

// Тарифы таблицей, как в кабинете. Кнопки открывают регистрацию.
const PLANS = [
  { key: 'trial', name: 'Trial', price: '0 ₽', period: '3 дня', cta: 'Начать бесплатно', primary: true, note: 'с него начинают' },
  { key: 'voice', name: 'AI Voice', price: '1 490 ₽', period: 'в месяц', cta: 'Выбрать' },
  { key: 'start', name: 'Start', price: '2 990 ₽', period: 'в месяц', cta: 'Выбрать', hot: true, note: 'популярный' },
  { key: 'profi', name: 'Profi', price: '5 990 ₽', period: 'в месяц', cta: 'Выбрать' },
  { key: 'agent', name: 'Agent', price: '5 490 ₽', period: 'в месяц', cta: 'Выбрать', agent: true, note: 'автономный' },
];

const YES = true;
const NO = false;
const ROWS = [
  ['Голосовые ассистенты', ['1', 'до 3', 'до 5', 'до 10', 'через агента']],
  ['Автономные агенты', [NO, NO, NO, NO, 'до 3']],
  ['Виджет на сайт', [YES, YES, YES, YES, YES]],
  ['Телефония и номера', [YES, NO, YES, YES, YES]],
  ['Тестовый номер на 10 минут', [YES, YES, YES, YES, YES]],
  ['CRM и воронка', [YES, NO, YES, YES, YES]],
  ['База знаний', [YES, YES, YES, YES, YES]],
  ['Функции, вебхуки, Google Sheets', [YES, YES, YES, YES, YES]],
  ['Telegram, MAX и SMS от агента', [NO, NO, NO, NO, YES]],
  ['Кредиты агента', [NO, NO, NO, NO, '20 000 в месяц']],
  ['Поддержка', ['чат', 'чат', 'приоритетная', 'VIP', 'приоритетная']],
];

function Cell({ v }) {
  if (v === YES) return <Icon name="check" className="ic-sm cell-yes" />;
  if (v === NO) return <span className="cell-no">—</span>;
  return <span>{v}</span>;
}

function Pricing({ onOpenModal }) {
  const models = useTariffs();
  return (
    <section className="sec sec-alt" id="pricing">
      <div className="lp-container">
        <SectionHead index="06" title="Тарифы" lead="Подписка открывает функции и лимит ассистентов. Минуты голоса, связь и кредиты агента считаются отдельно на любом тарифе, ниже видно как." />
        <Reveal className="table-wrap plans-wrap" y={20}>
          <table className="plans">
            <thead>
              <tr>
                <th className="plans-feature"></th>
                {PLANS.map((p) => (
                  <th key={p.key} className={`${p.hot ? 'hot' : ''}${p.agent ? ' agent' : ''}`.trim()}>
                    {p.note && <span className={`chip ${p.hot ? 'chip-accent' : p.agent ? 'chip-violet' : 'chip-success'}`}>{p.note}</span>}
                    <b>{p.name}</b>
                    <span className="plans-price">{p.price}<small>{p.period}</small></span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, cells]) => (
                <tr key={label}>
                  <td className="plans-feature">{label}</td>
                  {cells.map((v, i) => <td key={PLANS[i].key} className={`${PLANS[i].hot ? 'hot' : ''}${PLANS[i].agent ? ' agent' : ''}`.trim()}><Cell v={v} /></td>)}
                </tr>
              ))}
              <tr className="plans-cta">
                <td className="plans-feature"></td>
                {PLANS.map((p) => (
                  <td key={p.key} className={`${p.hot ? 'hot' : ''}${p.agent ? ' agent' : ''}`.trim()}>
                    <button type="button" className={`btn${p.primary || p.hot ? ' btn-primary' : ''}`} onClick={() => onOpenModal('register')}>{p.cta}</button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </Reveal>

        <div className="extra">
          <Reveal className="extra-col" y={16}>
            <h3>Минуты голоса</h3>
            <p className="muted">Списываются с кошелька посекундно по тарифу модели, минимум 10 секунд за разговор. Со своим ключом провайдера бесплатно.</p>
            <ul className="rate-list">
              {models.map((m) => (
                <li key={m.code}><ModelLogo code={m.code} size={16} wrap={false} /><span>{m.name}</span><b>{m.price || '—'}</b></li>
              ))}
            </ul>
          </Reveal>
          <Reveal className="extra-col" y={16} delay={0.08}>
            <h3>Связь</h3>
            <p className="muted">Отдельный баланс телефонии: аренда номеров, минуты оператора, SMS.</p>
            <ul className="rate-list">
              <li><Icon name="phone-incoming" className="ic-sm" /><span>Входящий звонок</span><b>1,7 ₽/мин</b></li>
              <li><Icon name="phone-outgoing" className="ic-sm" /><span>Исходящий звонок</span><b>2,7 ₽/мин</b></li>
              <li><Icon name="message-square" className="ic-sm" /><span>SMS</span><b>по тарифу оператора</b></li>
              <li><Icon name="phone" className="ic-sm" /><span>Аренда номера</span><b>от 190 ₽/мес</b></li>
            </ul>
          </Reveal>
          <Reveal className="extra-col" y={16} delay={0.16}>
            <h3>Кредиты агента</h3>
            <p className="muted">Оплачивают мышление агента: подготовку к звонку, разбор результата, ответы в чате и мессенджерах.</p>
            <ul className="rate-list">
              <li><Icon name="brain" className="ic-sm" /><span>Один звонок</span><b>около 20 кредитов</b></li>
              <li><Icon name="refresh-cw" className="ic-sm" /><span>В тарифе Agent</span><b>20 000 в месяц</b></li>
              <li><Icon name="plus" className="ic-sm" /><span>Пакеты</span><b>докупаются в кабинете</b></li>
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

export default Pricing;
