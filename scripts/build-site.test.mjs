import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = output => spawnSync(process.execPath, [join(root, 'scripts/build-site.mjs'), '--output', output], { encoding: 'utf8', timeout: 15000 });
const read = path => readFileSync(path, 'utf8');

test('the real deployment build is repeatable and publishes only validated public files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-test-'));
  try {
    const output = join(temporary, 'site');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = build(output);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    const paths = readdirSync(output, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(output.length + 1)).sort();
    assert.deepEqual(paths, ['404.html', '_headers', 'css/style.css', 'data/shows.json', 'index.html', 'js/app.js', 'robots.txt']);
    for (const [path, attribute] of [['css/style.css', 'href'], ['js/app.js', 'src']]) {
      const source = readFileSync(join(root, path));
      assert.deepEqual(readFileSync(join(output, path)), source);
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
      assert.ok(read(join(output, 'index.html')).includes(`${attribute}="${path}?v=${hash}"`));
      if (attribute === 'href') assert.ok(read(join(output, '404.html')).includes(`href="/${path}?v=${hash}"`));
    }
    const source = JSON.parse(read(join(root, 'data/shows.json')));
    const published = JSON.parse(read(join(output, 'data/shows.json')));
    assert.equal(published.lastUpdated, source.lastUpdated);
    assert.deepEqual(published.koreanDramas.map(show => show.id), source.koreanDramas.map(show => show.id));
    assert.deepEqual(published.chineseVariety.map(show => show.id), source.chineseVariety.map(show => show.id));
    assert.equal(Object.hasOwn(published, 'otherDramas'), false);
    assert.match(read(join(output, '_headers')), /\/data\/shows\.json\n  Cache-Control: no-cache/);
    assert.match(read(join(output, '404.html')), /href="\/">返回推荐首页/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('deployment build refuses private leftovers in its output', () => {
  const output = mkdtempSync(join(tmpdir(), 'iyf-build-leftover-'));
  try {
    mkdirSync(join(output, 'data'));
    writeFileSync(join(output, 'data/image_cache.json'), '{}');
    const result = build(output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected file in deployment output: data\/image_cache\.json/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('deployment build refuses repository source directories', () => {
  for (const output of [root, dirname(root), join(root, 'css'), join(root, 'data'), join(root, '.git')]) {
    const result = build(output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not overwrite the repository or its source directories/);
  }
});

test('deployment build refuses symbolic links', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-symlink-'));
  try {
    const target = join(temporary, 'target');
    mkdirSync(target);
    const output = join(temporary, 'site');
    symlinkSync(target, output, 'dir');
    const result = build(output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not follow a symbolic link/);
    assert.deepEqual(readdirSync(target), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
