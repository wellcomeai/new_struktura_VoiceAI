import React, { useState, useEffect, useRef } from 'react';

const CODE_LINES = [
  { text: '<!-- WellcomeAI Gemini Voice Assistant -->', type: 'comment' },
  { text: '<script>', type: 'tag' },
  { text: '    (function() {', type: 'keyword' },
  { text: "        var script = document.createElement('script');", type: 'code' },
  { text: "        script.src = 'https://voicyfy.ru/static/gemini-widget.js';", type: 'code' },
  { text: "        script.dataset.assistantId = 'YOUR_ASSISTANT_ID';", type: 'code' },
  { text: "        script.dataset.server = 'https://voicyfy.ru';", type: 'code' },
  { text: "        script.dataset.position = 'bottom-right';", type: 'code' },
  { text: '        script.async = true;', type: 'code' },
  { text: '        document.head.appendChild(script);', type: 'code' },
  { text: '    })();', type: 'keyword' },
  { text: '</script>', type: 'tag' },
];

const RAW_CODE = CODE_LINES.map(l => l.text).join('\n');

function colorize(text, type) {
  if (type === 'comment') return `<span class="code-comment">${text}</span>`;
  if (type === 'tag') return `<span class="code-tag">${text}</span>`;

  return text
    .replace(/(var |document\.|true)/g, '<span class="code-keyword">$1</span>')
    .replace(/(createElement|appendChild|createElement)/g, '<span class="code-func">$1</span>')
    .replace(/(script\.src|script\.dataset\.\w+|script\.async)/g, '<span class="code-var">$1</span>')
    .replace(/('[^']*')/g, '<span class="code-string">$1</span>');
}

function WidgetSection() {
  const [displayedLines, setDisplayedLines] = useState([]);
  const [typing, setTyping] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !startedRef.current) {
          startedRef.current = true;
          startTypewriter();
        }
      },
      { threshold: 0.3 }
    );

    if (codeRef.current) observer.observe(codeRef.current);
    return () => observer.disconnect();
  }, []);

  const startTypewriter = () => {
    setTyping(true);
    let lineIndex = 0;

    const typeLine = () => {
      if (lineIndex >= CODE_LINES.length) {
        setTyping(false);
        return;
      }

      const line = CODE_LINES[lineIndex];
      setDisplayedLines((prev) => [...prev, colorize(line.text, line.type)]);
      lineIndex++;
      setTimeout(typeLine, 120);
    };

    setTimeout(typeLine, 300);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(RAW_CODE).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section className="widget-section" id="widget">
      <div className="section-container">
        <div className="section-header" data-animate="fade-up">
          <h2 className="section-title section-title--light">
            Виджет на ваш сайт за 6 строк кода
          </h2>
          <p className="section-subtitle section-subtitle--light">
            Просто вставьте скрипт — голосовой ассистент появится на вашем сайте
            автоматически. Никаких бэкенд-интеграций.
          </p>
        </div>

        <div className="widget-grid">
          {/* Steps */}
          <div className="widget-steps">
            <div className="widget-step" data-animate="fade-right" data-delay="100">
              <span className="widget-step-number">01</span>
              <div className="widget-step-content">
                <h4>Создайте ассистента</h4>
                <p>Настройте голос, промпт, базу знаний в личном кабинете.</p>
              </div>
            </div>
            <div className="widget-step" data-animate="fade-right" data-delay="200">
              <span className="widget-step-number">02</span>
              <div className="widget-step-content">
                <h4>Скопируйте скрипт</h4>
                <p>6 строк HTML. Никакого бэкенда.</p>
              </div>
            </div>
            <div className="widget-step" data-animate="fade-right" data-delay="300">
              <span className="widget-step-number">03</span>
              <div className="widget-step-content">
                <h4>Вставьте на сайт</h4>
                <p>В &lt;head&gt; или перед &lt;/body&gt; — работает везде.</p>
              </div>
            </div>

            {/* Widget preview */}
            <div className="widget-preview" data-animate="fade-right" data-delay="400">
              <div className="widget-preview-mockup">
                <i className="fas fa-microphone"></i>
              </div>
              <span className="widget-preview-text">
                Так выглядит кнопка виджета на вашем сайте
              </span>
            </div>
          </div>

          {/* Code block */}
          <div className="widget-code-wrapper" data-animate="fade-left" data-delay="200" ref={codeRef}>
            <div className="widget-code-block">
              <div className="widget-code-header">
                <div className="widget-code-dot widget-code-dot--red" />
                <div className="widget-code-dot widget-code-dot--yellow" />
                <div className="widget-code-dot widget-code-dot--green" />
                <span className="widget-code-filename">voicyfy-widget.html</span>
              </div>
              <div className="widget-code-body">
                <pre>
                  {displayedLines.map((line, i) => (
                    <span key={i} dangerouslySetInnerHTML={{ __html: line + '\n' }} />
                  ))}
                  {typing && <span className="typewriter-cursor" />}
                </pre>
              </div>
            </div>
            <button
              className={`widget-copy-btn${copied ? ' copied' : ''}`}
              onClick={handleCopy}
            >
              <i className={copied ? 'fas fa-check' : 'fas fa-copy'}></i>
              {copied ? 'Скопировано!' : 'Скопировать'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default WidgetSection;
