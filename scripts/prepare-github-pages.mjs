#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutput } from './build-output-path.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolveBuildOutput(root, process.argv.slice(2), 'site/404.html', 'prepare-github-pages.mjs');
const html = readFileSync(output, 'utf8');
const cssLinks = [...html.matchAll(/href="(\/css\/style\.[a-f0-9]{12}\.css)"/gu)];
const homeMarker = 'href="/">返回推荐首页</a>';
if (cssLinks.length !== 1 || html.split(homeMarker).length !== 2) {
  throw new Error('Expected exactly one versioned stylesheet and home link in 404.html');
}
const adapted = html.replace(`href="${cssLinks[0][1]}"`, `href="/iyf${cssLinks[0][1]}"`)
  .replace(homeMarker, 'href="/iyf/index.html">返回推荐首页</a>');
writeFileSync(output, adapted, 'utf8');
console.log(`Prepared GitHub Pages 404: ${output}`);
