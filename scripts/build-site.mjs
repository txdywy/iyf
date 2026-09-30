#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
  throw new Error('Usage: node scripts/build-site.mjs [--output directory]');
}
const output = resolve(args[1] || join(root, 'site'));
const toRoot = relative(output, root);
const fromRoot = relative(root, output).split(sep)[0];
if ((!toRoot.startsWith(`..${sep}`) && toRoot !== '..') ||
    new Set(['.git', '.github', '.agents', '.codex', 'data', 'scripts', 'css', 'js']).has(fromRoot)) {
  throw new Error('Build output must not overwrite the repository or its source directories');
}

const files = new Set(['index.html', '404.html', '_headers', 'robots.txt', 'css/style.css', 'js/app.js', 'data/shows.json']);
const directories = new Set(['css', 'js', 'data']);
function assertPublicFiles(directory, prefix = '') {
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Build output must not follow a symbolic link');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && directories.has(path)) assertPublicFiles(join(directory, entry.name), path);
    else if (!entry.isFile() || !files.has(path)) throw new Error(`Unexpected file in deployment output: ${path}`);
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
