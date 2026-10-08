#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutput } from './build-output-path.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolveBuildOutput(root, process.argv.slice(2), 'site/index.html', 'build-site-index.mjs');

let html = readFileSync(join(root, 'index.html'), 'utf8');
for (const [asset, attribute] of [
  ['css/style.css', 'href'],
  ['js/app.js', 'src'],
]) {
  const marker = `${attribute}="${asset}"`;
  if (html.split(marker).length !== 2) throw new Error(`Expected exactly one ${marker} in index.html`);
  const digest = createHash('sha256').update(readFileSync(join(root, asset))).digest('hex').slice(0, 12);
  html = html.replace(marker, `${attribute}="${asset}?v=${digest}"`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, html, 'utf8');
console.log(`Built versioned index: ${outputPath}`);
