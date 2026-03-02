import React, { useEffect, useRef, useState } from 'react';

function CodeSection() {
  const sectionRef = useRef(null);
  const [widgetLoaded, setWidgetLoaded] = useState(false);

  useEffect(() => {
    if (!sectionRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !widgetLoaded) {
            setWidgetLoaded(true);
            observer.disconnect();

            const script = document.createElement('script');
            script.src = 'https://voicyfy.ru/static/gemini-widget.js';
            script.dataset.assistantId = '991b2b45-b52b-43be-9e59-81eaf7ea980a';
            script.dataset.server = 'https://voicyfy.ru';
            script.dataset.position = 'bottom-right';
            script.async = true;
            document.head.appendChild(script);
          }
        });
      },
      { threshold: 0.25 }
    );

    observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, [widgetLoaded]);

  return (
    <section className="section code-section" id="features" ref={sectionRef}>
      <div className="section-inner">
        <div className="code-wrap">
          <div className="code-block rev">
            <div className="code-bar">
              <div className="cdot r"></div>
              <div className="cdot y"></div>
              <div className="cdot g"></div>
              <span className="ctitle">index.html</span>
            </div>
            <pre dangerouslySetInnerHTML={{ __html: `<span class="cc">&lt;!-- Voicyfy Voice Assistant --&gt;</span>
<span class="ct">&lt;script&gt;</span>
  (<span class="ck">function</span>() {
    <span class="ck">var</span> script = document.<span class="cf">createElement</span>(<span class="cs">'script'</span>);
    script.src = <span class="cs">'https://voicyfy.ru/static/gemini-widget.js'</span>;
    script.dataset.<span class="ca">assistantId</span> = <span class="cs">'ВАШ_ASSISTANT_ID'</span>;
    script.dataset.<span class="ca">server</span> = <span class="cs">'https://voicyfy.ru'</span>;
    script.dataset.<span class="ca">position</span> = <span class="cs">'bottom-right'</span>;
    script.async = <span class="ck">true</span>;
    document.head.<span class="cf">appendChild</span>(script);
  })();
<span class="ct">&lt;/script&gt;</span>
<span class="cc">&lt;!-- End Voicyfy Widget --&gt;</span>` }} />
          </div>

          <div className="code-text rev d1">
            <span className="s-label">Интеграция</span>
            <h3>Одна строка кода —<br />и ассистент на вашем сайте</h3>
            <p>Скопируйте HTML-код и вставьте перед закрывающим тегом body. Голосовой ассистент появится как виджет в углу страницы.</p>
            <ul className="steps-list">
              <li>
                <span className="sn">1</span>
                <span>Создайте ассистента в личном кабинете</span>
              </li>
              <li>
                <span className="sn">2</span>
                <span>Напишите промт и загрузите базу знаний</span>
              </li>
              <li>
                <span className="sn">3</span>
                <span>Скопируйте код виджета на ваш сайт</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export default CodeSection;
