#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--output');
const outputPath = resolve(outputFlag >= 0 && process.argv[outputFlag + 1]
  ? process.argv[outputFlag + 1]
  : join(root, 'site', 'index.html'));

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
