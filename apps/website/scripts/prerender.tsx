import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { App } from '../src/App';

const pages = [
  { route: '/', file: 'index.html' },
  { route: '/support', file: 'support/index.html' },
  { route: '/privacy', file: 'privacy/index.html' },
] as const;

const distDirectory = resolve(import.meta.dirname, '../dist');

for (const page of pages) {
  const outputPath = resolve(distDirectory, page.file);
  const template = await readFile(outputPath, 'utf8');
  const markup = renderToString(
    <StaticRouter location={page.route}>
      <App />
    </StaticRouter>,
  );

  if (!template.includes('<div id="root"></div>')) {
    throw new Error(`Unable to find the root element in ${page.file}`);
  }

  await writeFile(
    outputPath,
    template.replace('<div id="root"></div>', `<div id="root">${markup}</div>`),
  );
}
