import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

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

// Виджет-демо подгружается, когда секция попадает в экран (как раньше)
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
    <section className="lp-section" id="integration" ref={ref}>
      <div className="lp-container lp-integration">
        <div className="lp-code card rev">
          <div className="lp-code-head">
            <span className="lp-code-file"><Icon name="code" className="ic-sm" />index.html</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} className="ic-sm" />{copied ? 'Скопировано' : 'Скопировать'}
            </button>
          </div>
          <pre><code>{CODE}</code></pre>
        </div>
        <div className="lp-integration-copy rev d1">
          <span className="lp-eyebrow">Интеграция</span>
          <h2>Одна строка кода, и ассистент на вашем сайте</h2>
          <p className="lp-lead">Вставьте код перед закрывающим тегом body. Голосовой виджет появится в углу страницы и будет разговаривать с посетителями. Попробуйте его прямо здесь, он в правом нижнем углу.</p>
          <ol className="lp-mini-steps">
            <li><span>1</span>Создайте ассистента в кабинете на OpenAI или Gemini</li>
            <li><span>2</span>Напишите промпт и загрузите базу знаний</li>
            <li><span>3</span>Скопируйте код виджета на вкладке «Встраивание»</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

export default Integration;
