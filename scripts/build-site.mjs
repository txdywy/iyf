#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutput } from './build-output-path.mjs';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const output = resolveBuildOutput(root, process.argv.slice(2), 'site', 'build-site.mjs');

const files = new Set(['index.html', '404.html', '_headers', 'robots.txt', 'css/style.css', 'js/app.js', 'data/shows.json']);
const directories = new Set(['css', 'js', 'data']);
function assertPublicFiles(directory, prefix = '') {
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Build output must not follow a symbolic link');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && directories.has(path)) assertPublicFiles(join(directory, entry.name), path);
    else if (!entry.isFile() || !files.has(path)) throw new Error(`Unexpected file in deployment output: ${path}`);
    else if (lstatSync(join(directory, entry.name)).nlink > 1) throw new Error(`Build output must not overwrite a hard-linked file: ${path}`);
  }
}

// 只允许明确的公开文件，拒绝把旧缓存、凭据或源码遗留在部署目录。
assertPublicFiles(output);
execFileSync(process.execPath, [join(root, 'scripts/validate-data.mjs')], { stdio: 'inherit' });
for (const directory of directories) mkdirSync(join(output, directory), { recursive: true });
for (const file of ['css/style.css', 'js/app.js', '_headers', 'robots.txt']) {
  copyFileSync(join(root, file), join(output, file));
}
execFileSync(process.execPath, [join(root, 'scripts/build-site-index.mjs'), '--output', join(output, 'index.html')], { stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'scripts/build-public-data.mjs'), '--output', join(output, 'data/shows.json')], { stdio: 'inherit' });
const cssHash = createHash('sha256').update(readFileSync(join(root, 'css/style.css'))).digest('hex').slice(0, 12);
const notFound = readFileSync(join(root, '404.html'), 'utf8').replace('href="css/style.css"', `href="/css/style.css?v=${cssHash}"`);
writeFileSync(join(output, '404.html'), notFound, 'utf8');
assertPublicFiles(output);
console.log(`Built deployment site: ${output}`);
