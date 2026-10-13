#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildOutputPath, resolveBuildOutput } from './build-output-path.mjs';
import { readSiteAssets, renderVersionedAssets } from './build-site-index.mjs';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const output = resolveBuildOutput(root, process.argv.slice(2), 'site', 'build-site.mjs');

const assets = readSiteAssets(root);
const files = new Set(['index.html', '404.html', '_headers', 'robots.txt', 'data/shows.json', ...assets.map(asset => asset.outputPath)]);
const directories = new Set(['css', 'js', 'data']);
const isOwnedAsset = path => ['css/style.css', 'js/app.js'].includes(path) ||
  /^css\/style\.[a-f0-9]{12}\.css$/u.test(path) || /^js\/app\.[a-f0-9]{12}\.js$/u.test(path);
function assertPublicFiles(directory, prefix = '', allowObsolete = false) {
  const obsolete = [];
  if (!existsSync(directory)) return obsolete;
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Build output must not follow a symbolic link');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && directories.has(path)) obsolete.push(...assertPublicFiles(join(directory, entry.name), path, allowObsolete));
    else {
      if (!entry.isFile() || (!files.has(path) && !(allowObsolete && isOwnedAsset(path)))) {
        throw new Error(`Unexpected file in deployment output: ${path}`);
      }
      if (lstatSync(join(directory, entry.name)).nlink > 1) throw new Error(`Build output must not overwrite a hard-linked file: ${path}`);
      if (!files.has(path)) obsolete.push(join(directory, entry.name));
    }
  }
  return obsolete;
}

// 只允许明确的公开文件，拒绝把旧缓存、凭据或源码遗留在部署目录。
const obsoleteAssets = assertPublicFiles(output, '', true);
execFileSync(process.execPath, [join(root, 'scripts/validate-data.mjs')], { stdio: 'inherit' });
const index = renderVersionedAssets(readFileSync(join(root, 'index.html'), 'utf8'), assets);
const notFound = renderVersionedAssets(readFileSync(join(root, '404.html'), 'utf8'), assets.filter(asset => asset.attribute === 'href'), {
  rootRelative: true, documentName: '404.html',
});
for (const file of files) assertBuildOutputPath(root, join(output, file));
for (const directory of directories) mkdirSync(join(output, directory), { recursive: true });
for (const { outputPath, content } of assets) writeFileSync(join(output, outputPath), content);
for (const file of ['_headers', 'robots.txt']) copyFileSync(join(root, file), join(output, file));
writeFileSync(join(output, 'index.html'), index, 'utf8');
execFileSync(process.execPath, [join(root, 'scripts/build-public-data.mjs'), '--output', join(output, 'data/shows.json')], { stdio: 'inherit' });
writeFileSync(join(output, '404.html'), notFound, 'utf8');
// 只删除预检过的历史构建资产；未知文件或任何链接都会在写入前拒绝。
for (const path of obsoleteAssets) unlinkSync(path);
assertPublicFiles(output);
console.log(`Built deployment site: ${output}`);
