import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import SectionHead from './SectionHead';
import { Reveal } from './Reveal';

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

// Демо-виджет подгружается, когда секция попадает в экран
function Integration() {
  const ref = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!ref.current || loaded) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loaded) {
        setLoaded(true);
        observer.disconnect();
        const script = document.createElement('script');
        script.src = 'https://voicyfy.ru/static/gemini-widget.js';
        script.dataset.assistantId = '991b2b45-b52b-43be-9e59-81eaf7ea980a';
        script.dataset.server = 'https://voicyfy.ru';
        script.dataset.position = 'bottom-right';
        script.async = true;
        document.head.appendChild(script);
      }
    }, { threshold: 0.25 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [loaded]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(CODE); } catch (err) { /* буфер недоступен */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="sec sec-alt" id="integration" ref={ref}>
      <div className="lp-container">
        <SectionHead index="04" title="Виджет на сайт одной строкой" lead="Вставьте код перед закрывающим тегом body. Голосовой виджет появится в углу и будет разговаривать с посетителями. Такой же работает на этой странице, справа внизу." />
        <div className="integ">
          <Reveal className="code" y={20}>
            <div className="code-head">
              <span className="code-file"><Icon name="code" className="ic-sm" />index.html</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={copy}>
                <Icon name={copied ? 'check' : 'copy'} className="ic-sm" />{copied ? 'Скопировано' : 'Скопировать'}
              </button>
            </div>
            <pre><code>{CODE}</code></pre>
          </Reveal>
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
