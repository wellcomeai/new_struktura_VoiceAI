// Пререндер лендинга: запускается после `vite build` (см. package.json).
// Собирает серверный бандл во временную папку, рендерит App в HTML и
// вставляет его в backend/static/landing/index.html вместо пустого #root.
// В браузере React гидрирует готовую разметку (src/main.jsx).
import { build } from 'vite';
import { rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outFile = path.resolve(root, '../backend/static/landing/index.html');
// Серверный бандл кладём внутрь node_modules: он не попадает в git, а Node
// находит react и motion по обычному пути поиска пакетов.
const tmp = path.join(root, 'node_modules', '.voicyfy-ssr');

try {
  await build({
    root,
    logLevel: 'warn',
    build: {
      ssr: 'src/entry-server.jsx',
      outDir: tmp,
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'entry-server.mjs' } },
    },
  });

  const mod = await import(pathToFileURL(path.join(tmp, 'entry-server.mjs')).href);
  const appHtml = mod.render();
  const faq = mod.faqJsonLd();

  let html = await readFile(outFile, 'utf8');
  const mount = '<div id="root"></div>';
  if (!html.includes(mount)) throw new Error('В index.html не найден пустой <div id="root"></div>');
  html = html.replace(mount, `<div id="root">${appHtml}</div>`);
  html = html.replace('</head>', `  <script type="application/ld+json">${faq}</script>\n</head>`);
  await writeFile(outFile, html);

  const words = appHtml.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  console.log(`prerender: ${outFile} — ${words} слов текста в HTML, FAQ: ${mod.faqJsonLd().length} байт JSON-LD`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
