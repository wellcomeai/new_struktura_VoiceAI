import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import SectionHead from './SectionHead';
import { Reveal, Parallax } from './Reveal';

const CODE = `<!-- Voicyfy Voice Assistant -->
<script>
  (function () {
    var script = document.createElement('script');
    script.src = 'https://voicyfy.ru/static/gemini-widget.js';
    script.dataset.assistantId = 'ВАШ_ASSISTANT_ID';
    script.dataset.server = 'https://voicyfy.ru';
    script.dataset.position = 'bottom-right';
    script.async = true;
    document.head.appendChild(script);
  })();
</script>
<!-- End Voicyfy Widget -->`;

const WIDGET_ID = 'wellcomeai-widget-container';
const HIDDEN_CLASS = 'lp-widget-hidden';

// Демо-виджет грузится заранее, а виден только пока эта секция на экране.
// Открытый виджет (идёт разговор) не прячем.
function Integration() {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add(HIDDEN_CLASS);
    const load = setTimeout(() => {
      if (document.querySelector('script[data-lp-widget]')) return;
      const script = document.createElement('script');
      script.src = 'https://voicyfy.ru/static/gemini-widget.js';
      script.dataset.assistantId = '991b2b45-b52b-43be-9e59-81eaf7ea980a';
      script.dataset.server = 'https://voicyfy.ru';
      script.dataset.position = 'bottom-right';
      script.dataset.lpWidget = '1';
      script.async = true;
      document.head.appendChild(script);
    }, 1500);

    const isOpen = () => {
      const c = document.getElementById(WIDGET_ID);
      if (!c) return false;
      const exp = c.querySelector('.wellcomeai-widget-expanded');
      return /\b(active|open|expanded|show)\b/.test((c.className || '') + ' ' + (exp ? exp.className : ''));
    };
    let visible = false;
    const apply = () => {
      const hide = !visible && !isOpen();
      document.documentElement.classList.toggle(HIDDEN_CLASS, hide);
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      apply();
    }, { threshold: 0.12 });
    if (ref.current) io.observe(ref.current);
    const tick = setInterval(apply, 800);

    return () => { clearTimeout(load); io.disconnect(); clearInterval(tick); document.documentElement.classList.remove(HIDDEN_CLASS); };
  }, []);

  const copy = async () => {
    try { await navigator.clipboard.writeText(CODE); } catch (err) { /* буфер недоступен */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="sec sec-alt sec-grid" id="integration" ref={ref}>
      <div className="lp-container">
        <SectionHead index="04" title="Виджет на сайт одной строкой" lead="Вставьте код перед закрывающим тегом body. Голосовой виджет появится в углу и будет разговаривать с посетителями. Такой же работает на этой странице, справа внизу." />
        <div className="integ">
          <Parallax amount={24}>
            <Reveal className="code" y={20}>
              <div className="code-head">
                <span className="code-file"><Icon name="code" className="ic-sm" />index.html</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={copy}>
                  <Icon name={copied ? 'check' : 'copy'} className="ic-sm" />{copied ? 'Скопировано' : 'Скопировать'}
                </button>
              </div>
              <pre><code>{CODE}</code></pre>
            </Reveal>
          </Parallax>
          <Reveal className="integ-text" x={16} y={0} delay={0.1}>
            <dl className="facts">
              <div><dt>Модели для виджета</dt><dd>OpenAI и Gemini, с прерываниями и вызовом функций</dd></div>
              <div><dt>Где взять код</dt><dd>вкладка «Встраивание» у ассистента</dd></div>
              <div><dt>Исходящие по событию</dt><dd>вызов API из вашей системы, документация в кабинете</dd></div>
              <div><dt>Интеграции</dt><dd>Google Sheets, вебхуки, Telegram, свои функции</dd></div>
            </dl>
            <a href="/static/api-docs.html" className="lp-link">Документация API<Icon name="arrow-right" className="ic-sm" /></a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

export default Integration;
