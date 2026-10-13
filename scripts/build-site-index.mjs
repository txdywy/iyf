#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutput } from './build-output-path.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readSiteAssets(sourceRoot = root) {
  return [['css/style.css', 'href'], ['js/app.js', 'src']].map(([sourcePath, attribute]) => {
    const content = readFileSync(join(sourceRoot, sourcePath));
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
    return { sourcePath, attribute, content, outputPath: sourcePath.replace(/\.(css|js)$/u, `.${digest}.$1`) };
  });
}

export function renderVersionedAssets(html, assets, { rootRelative = false, documentName = 'index.html' } = {}) {
  for (const { sourcePath, outputPath, attribute } of assets) {
    const marker = `${attribute}="${sourcePath}"`;
    if (html.split(marker).length !== 2) throw new Error(`Expected exactly one ${marker} in ${documentName}`);
    html = html.replace(marker, `${attribute}="${rootRelative ? '/' : ''}${outputPath}"`);
  }
  return html;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = resolveBuildOutput(root, process.argv.slice(2), 'site/index.html', 'build-site-index.mjs');
  const html = renderVersionedAssets(readFileSync(join(root, 'index.html'), 'utf8'), readSiteAssets());
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf8');
  console.log(`Built versioned index: ${outputPath}`);
}
