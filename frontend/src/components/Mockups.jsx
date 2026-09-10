import React from 'react';
import Icon from './Icon';
import ModelLogo from './ModelLogo';
import { Stagger, Item } from './Reveal';

// Экраны кабинета, собранные из компонентов дизайн-системы ЛК.
// Текст, которого нет смысла показывать, заменён серыми полосами (.m-bar).

const NAV = [
  { icon: 'house', label: 'Дашборд' },
  { icon: 'headset', label: 'Агент' },
  { icon: 'audio-lines', label: 'Голосовые ассистенты' },
  { icon: 'messages-square', label: 'Диалоги' },
  { icon: 'phone', label: 'Телефония' },
  { icon: 'contact-round', label: 'CRM' },
];

export function Frame({ active, title, children, wide }) {
  return (
    <div className={`frame${wide ? ' frame-wide' : ''}`} aria-hidden="true">
      <div className="frame-side">
        <div className="frame-logo"><img src="/static/images/IMG_2820.PNG" alt="" /><span>Voicyfy</span></div>
        <div className="frame-nav">
          {NAV.map((n) => (
            <span key={n.label} className={`frame-nav-item${n.label === active ? ' on' : ''}`}><Icon name={n.icon} className="ic-sm" />{n.label}</span>
          ))}
        </div>
        <div className="frame-wallet"><span>Кошелёк</span><b>1 240 ₽</b></div>
      </div>
      <div className="frame-main">
        <div className="frame-top"><b>{title}</b><span className="frame-ava">АП</span></div>
        <div className="frame-body">{children}</div>
      </div>
    </div>
  );
}

const Bar = ({ w = '100%', h = 8 }) => <span className="m-bar" style={{ width: w, height: h }} />;

export function MockAssistant() {
  return (
    <Frame active="Голосовые ассистенты" title="Голосовые ассистенты">
      <Stagger className="m-editor" stagger={0.07} amount={0.3}>
        <Item className="m-editor-head" y={8}>
          <ModelLogo code="gemini" size={14} />
          <b>Менеджер по записи</b>
          <span className="chip chip-success"><span className="dot dot-success" />активен</span>
        </Item>
        <Item className="m-tabs" y={8}><span className="on">Настройки</span><span>Функции</span><span>База знаний</span><span>Тестирование</span><span>Встраивание</span></Item>
        <Item className="m-field" y={8}><label>Первая фраза</label><div className="m-input">Здравствуйте! Салон «Лея», чем могу помочь?</div></Item>
        <Item className="m-field" y={8}><label>Системный промпт</label><div className="m-input m-textarea"><Bar w="92%" /><Bar w="78%" /><Bar w="85%" /><Bar w="40%" /></div></Item>
        <Item className="m-field" y={8}>
          <label>Голосовая модель</label>
          <div className="m-models">
            {[['cascade', 'Каскад', 'бесплатно'], ['gemini', 'Gemini', '6 ₽/мин', true], ['openai', 'OpenAI', '9 ₽/мин'], ['yandex', 'Яндекс', '4,5 ₽/мин']].map(([c, n, p, on]) => (
              <div key={c} className={`m-model${on ? ' on' : ''}`}><ModelLogo code={c} size={14} /><div><b>{n}</b><span>{p}</span></div>{on && <Icon name="circle-check" className="ic-sm" />}</div>
            ))}
          </div>
        </Item>
      </Stagger>
    </Frame>
  );
}

export function MockTelephony() {
  return (
    <Frame active="Телефония" title="Телефония">
      <Stagger stagger={0.08} amount={0.3}>
        <Item className="m-card m-test" y={10}>
          <div className="m-card-head"><b>Тестовый номер</b><span className="chip chip-success">Включён</span></div>
          <div className="m-test-body">
            <div><span className="m-label">Позвоните на номер</span><b className="m-phone">+7 933 091-64-41</b><span className="m-sub">Отвечает: Менеджер по записи · Gemini</span></div>
            <div className="m-timer"><b>07:42</b><span>до отключения</span><i><em style={{ width: '77%' }} /></i></div>
          </div>
        </Item>
        <Item className="m-card" y={10}>
          <div className="m-card-head"><b>Мои номера</b><span className="btn btn-sm btn-primary"><Icon name="plus" className="ic-sm" />Купить номер</span></div>
          <table className="m-table">
            <tbody>
              <tr><td className="mono">+7 495 ••• 12-40</td><td>Москва</td><td><span className="chip chip-accent">Менеджер по записи</span></td></tr>
              <tr><td className="mono">+7 812 ••• 07-15</td><td>Санкт-Петербург</td><td><span className="chip">без привязки</span></td></tr>
            </tbody>
          </table>
        </Item>
        <Item className="m-prices" y={10}>
          <div><span className="m-label"><Icon name="phone-incoming" className="ic-sm" />Входящий</span><b>1,7 ₽/мин</b></div>
          <div><span className="m-label"><Icon name="phone-outgoing" className="ic-sm" />Исходящий</span><b>2,7 ₽/мин</b></div>
          <div><span className="m-label"><Icon name="message-square" className="ic-sm" />SMS</span><b>по тарифу оператора</b></div>
        </Item>
      </Stagger>
    </Frame>
  );
}

export function MockDialogs() {
  return (
    <Frame active="Диалоги" title="Диалоги">
      <Stagger className="m-dialogs" stagger={0.08} amount={0.3}>
        <Item className="m-card m-list" y={10}>
          {[['Сегодня, 14:30', 'Входящий · +7 921 ••• 44-10', '02:14', 'запись', 'success'], ['Сегодня, 12:05', 'Исходящий · агент шоурума', '01:48', 'в работе', 'accent'], ['Вчера, 19:40', 'Виджет на сайте', '00:52', 'вопрос', '']].map((r) => (
            <div key={r[0]} className="m-row"><span className="m-sub">{r[0]}</span><b>{r[1]}</b><span className="muted mono">{r[2]}</span><span className={`chip${r[4] ? ' chip-' + r[4] : ''}`}>{r[3]}</span></div>
          ))}
        </Item>
        <Item className="m-card m-transcript" y={10}>
          <div className="m-card-head"><b>Расшифровка</b><span className="chip"><Icon name="play" className="ic-sm" />Запись</span></div>
          <div className="m-line"><span className="m-ava">К</span><span>Есть свободное время на пятницу?</span></div>
          <div className="m-line bot"><span className="m-ava bot"><Icon name="bot" className="ic-sm" /></span><span>Да, в 11:00 и 15:30. Какое удобнее?</span></div>
          <div className="m-line"><span className="m-ava">К</span><span>В 11 подойдёт</span></div>
          <div className="m-line bot"><span className="m-ava bot"><Icon name="bot" className="ic-sm" /></span><span>Записала на пятницу, 11:00. Пришлю SMS с адресом.</span></div>
          <div className="m-result"><Icon name="square-check" className="ic-sm" />Итог: запись создана, контакт добавлен в CRM</div>
        </Item>
      </Stagger>
    </Frame>
  );
}

export function MockCrm() {
  const cols = [
    ['Новые', ['Алексей П.', 'Ирина К.']],
    ['В работе', ['Марина С.', 'Игорь Д.', 'Ольга В.']],
    ['Успех', ['Дмитрий Р.', 'Анна Л.']],
    ['Отказ', ['Сергей М.']],
  ];
  return (
    <Frame active="CRM" title="CRM">
      <Stagger className="m-kanban" stagger={0.08} amount={0.3}>
        {cols.map(([name, cards]) => (
          <Item key={name} className="m-col" y={12}>
            <div className="m-col-head"><b>{name}</b><span>{cards.length}</span></div>
            {cards.map((c) => (
              <div key={c} className={`m-contact${c === 'Марина С.' ? ' on' : ''}`}>
                <b>{c}</b>
                <span className="mono muted">+7 9•• ••• ••-••</span>
                {c === 'Марина С.' && <div className="m-facts"><span className="chip chip-outline">платья, 44</span><span className="chip chip-outline">суббота</span></div>}
              </div>
            ))}
          </Item>
        ))}
      </Stagger>
    </Frame>
  );
}

export function MockKnowledge() {
  return (
    <Frame active="Голосовые ассистенты" title="База знаний">
      <Stagger className="m-kb" stagger={0.08} amount={0.3}>
        <Item className="m-card m-list" y={10}>
          {[['Прайс-лист 2026.pdf', '48 фрагментов'], ['Ответы на частые вопросы.docx', '21 фрагмент'], ['Адреса и часы работы.txt', '3 фрагмента']].map((f) => (
            <div key={f[0]} className="m-row"><Icon name="file-text" className="ic-sm" /><b>{f[0]}</b><span className="muted">{f[1]}</span><span className="chip chip-success">проиндексирован</span></div>
          ))}
          <div className="m-row m-drop"><Icon name="upload" className="ic-sm" /><span className="muted">Перетащите файлы или вставьте текст</span></div>
        </Item>
        <Item className="m-card" y={10}>
          <div className="m-card-head"><b>Проверка ответа</b></div>
          <div className="m-line"><span className="m-ava">?</span><span>Сколько стоит окрашивание в один тон?</span></div>
          <div className="m-line bot"><span className="m-ava bot"><Icon name="bot" className="ic-sm" /></span><span>Окрашивание в один тон от 3 500 ₽, длинные волосы от 4 200 ₽. Источник: Прайс-лист 2026, стр. 2.</span></div>
        </Item>
      </Stagger>
    </Frame>
  );
}

export function MockAgent() {
  return (
    <Frame active="Агент" title="Агент шоурума" wide>
      <Stagger className="m-agent" stagger={0.08} amount={0.25}>
        <Item className="m-card m-chat" y={10}>
          <div className="m-card-head"><b>Чат с агентом</b><span className="chip"><Icon name="send" className="ic-sm" />Telegram</span></div>
          <div className="m-line"><span className="m-ava">Вы</span><span>Обзвони всех из «в работе», расскажи о новой коллекции. Кому интересно, отправь подборку и запиши на примерку</span></div>
          <div className="m-line bot"><span className="m-ava bot"><Icon name="headset" className="ic-sm" /></span><span>Поставил 87 звонков по стадии «в работе». Стартую в 10:00 по вашим рабочим часам. Подборку отправлю в Telegram тем, кто ответит «интересно».</span></div>
          <div className="m-line"><span className="m-ava">Вы</span><span>Как прошёл обзвон?</span></div>
          <div className="m-line bot"><span className="m-ava bot"><Icon name="headset" className="ic-sm" /></span><span>Дозвонился до 61, заинтересовались 23, записал на примерку 9. Недозвонам перезвоню завтра, 4 просили не звонить.</span></div>
        </Item>
        <Item className="m-agent-side" y={10}>
          <div className="m-card">
            <div className="m-card-head"><b>Задачи агента</b><span className="chip chip-accent">завтра</span></div>
            {[['10:00', 'Перезвонить: 26 недозвонов'], ['12:00', 'Напомнить Марине о примерке'], ['15:30', 'Написать Ирине: подборка'], ['18:00', 'Отчёт за день']].map((t) => (
              <div key={t[0]} className="m-task"><span className="mono">{t[0]}</span><span>{t[1]}</span></div>
            ))}
          </div>
          <div className="m-card m-memory">
            <div className="m-card-head"><b>Карточка: Марина С.</b><span className="chip chip-accent">в работе</span></div>
            <p><b>Сводка.</b> Интересуют платья 44 размера, удобно в субботу, подборка отправлена.</p>
            <p><b>Лучшее время.</b> После 14:00, утром не берёт трубку.</p>
          </div>
        </Item>
      </Stagger>
    </Frame>
  );
}
