import React from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';
import SectionHead from './SectionHead';
import { Reveal } from './Reveal';
import { useTariffs, useWelcomeGrant } from '../hooks/useTariffs';

// Тарифы таблицей, как в кабинете. Кнопки открывают регистрацию.
const PLANS = [
  { key: 'trial', name: 'Trial', desc: 'Все функции, карта не нужна', price: '0 ₽', period: '3 дня', cta: 'Начать бесплатно', primary: true, note: 'с него начинают' },
  { key: 'voice', name: 'AI Voice', desc: 'Голосовой консультант на сайте', price: '1 490 ₽', period: 'в месяц', cta: 'Выбрать' },
  { key: 'start', name: 'Start', desc: 'Ассистенты на телефоне и на сайте', price: '2 990 ₽', period: 'в месяц', cta: 'Выбрать', hot: true, note: 'популярный' },
  { key: 'profi', name: 'Profi', desc: 'Несколько направлений и номеров', price: '5 990 ₽', period: 'в месяц', cta: 'Выбрать' },
  { key: 'agent', name: 'Agent', desc: 'Сотрудник, который звонит сам', price: '5 490 ₽', period: 'в месяц', cta: 'Выбрать', agent: true, note: 'автономный' },
];

const YES = true;
const NO = false;

// Строки сравнения: [название, ячейки]
const ROWS = [
  ['Голосовые ассистенты', ['1', 'до 3', 'до 5', 'до 10', 'через агента']],
  ['Автономные агенты', [NO, NO, NO, NO, 'до 3']],
  ['Телефония и номера', [YES, NO, YES, YES, YES]],
  ['Виджет на сайт', [YES, YES, YES, YES, YES]],
  ['Тестовый номер на 10 минут', [YES, YES, YES, YES, YES]],
  ['CRM и воронка', [YES, NO, YES, YES, YES]],
  ['База знаний', [YES, YES, YES, YES, YES]],
  ['Функции, вебхуки, Google Sheets', [YES, YES, YES, YES, YES]],
  ['Telegram, MAX и SMS от агента', [NO, NO, NO, NO, YES]],
  ['Кредиты агента', [NO, NO, NO, NO, '20 000 в месяц']],
  ['Подарочные рубли на кошельке', ['welcome', NO, NO, NO, NO]],
  ['Поддержка', ['чат', 'чат', 'приоритетная', 'VIP', 'приоритетная']],
];

function Cell({ v, welcome }) {
  if (v === YES) return <span className="cell-yes"><Icon name="check" className="ic-sm" /></span>;
  if (v === NO) return <span className="cell-no">—</span>;
  if (v === 'welcome') return <span>{welcome} ₽</span>;
  return <span>{v}</span>;
}

const colClass = (p) => `${p.hot ? 'hot' : ''}${p.agent ? ' agent' : ''}`.trim();

function Pricing({ onOpenModal }) {
  const models = useTariffs();
  const welcome = useWelcomeGrant();
  return (
    <section className="sec sec-tint tint-blue" id="pricing">
      <div className="lp-container">
        <SectionHead index="06" title="Тарифы" lead="Подписка открывает функции и лимит ассистентов. Минуты голоса, связь и кредиты агента считаются отдельно на любом тарифе, ниже видно как." />
        <Reveal className="plans-card" y={20}>
          <div className="table-wrap plans-wrap">
            <table className="plans">
              <thead>
                <tr>
                  <th className="plans-feature" />
                  {PLANS.map((p) => (
                    <th key={p.key} className={colClass(p)}>
                      <div className="plan-head">
                        <span className={`chip ${p.hot ? 'chip-accent' : p.agent ? 'chip-violet' : p.primary ? 'chip-success' : 'chip-ghost'}`}>{p.note || ' '}</span>
                        <b>{p.name}</b>
                        <span className="plan-desc">{p.desc}</span>
                        <span className="plans-price">{p.price}<small>{p.period === '3 дня' ? '/ 3 дня' : '/ мес'}</small></span>
                        <button type="button" className={`btn${p.primary || p.hot ? ' btn-primary' : ''}`} onClick={() => onOpenModal('register')}>{p.cta}</button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([label, cells]) => (
                  <tr key={label}>
                    <td className="plans-feature">{label}</td>
                    {cells.map((v, i) => <td key={PLANS[i].key} className={colClass(PLANS[i])}><Cell v={v} welcome={welcome} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
