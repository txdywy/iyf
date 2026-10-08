import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = (output, sourceRoot = root) => spawnSync(process.execPath, [join(sourceRoot, 'scripts/build-site.mjs'), '--output', output], { cwd: sourceRoot, encoding: 'utf8', timeout: 15000 });
const read = path => readFileSync(path, 'utf8');

// 保留真实构建脚本和资产，仅刷新隔离副本的快照时间，避免陈旧数据挡住抓取前的测试。
function createBuildFixture(directory, sourceData = JSON.parse(read(join(root, 'data/shows.json')))) {
  for (const path of [
    'scripts/build-site.mjs', 'scripts/build-site-index.mjs', 'scripts/build-public-data.mjs', 'scripts/build-output-path.mjs', 'scripts/validate-data.mjs',
    'index.html', 'css/style.css', 'js/app.js', '404.html', '_headers', 'robots.txt',
  ]) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  mkdirSync(join(directory, 'data'));
  writeFileSync(join(directory, 'data/shows.json'), JSON.stringify({ ...sourceData, lastUpdated: new Date().toISOString() }));
  for (const file of ['image_cache.json', 'discovery.json']) {
    writeFileSync(join(directory, 'data', file), '{}');
  }
  return directory;
}

for (const [script, sourceFile] of [
  ['build-public-data.mjs', 'data/shows.json'],
  ['build-site-index.mjs', 'index.html'],
]) {
  const generate = (sourceRoot, args) => spawnSync(process.execPath, [join(sourceRoot, 'scripts', script), ...args], {
    cwd: sourceRoot, encoding: 'utf8', timeout: 15000,
  });

  test(`${script} rejects source outputs and malformed arguments before changing inputs`, t => {
    const temporary = mkdtempSync(join(tmpdir(), 'iyf-generator-source-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    const original = read(join(sourceRoot, sourceFile));
    writeFileSync(join(sourceRoot, '.env.local'), 'TEST_CONFIGURATION=keep\n');
    for (const args of [
      ['--output', sourceFile], ['--output', 'js/app.js'], ['--output', '.'], ['--output', '.env.local'],
      ['--output'], ['--unknown', join(temporary, 'output')], ['--output', join(temporary, 'output'), 'extra'],
    ]) {
      const result = generate(sourceRoot, args);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /Build output must not overwrite|Usage:/);
      assert.equal(read(join(sourceRoot, sourceFile)), original, 'rejected generation must preserve the input byte for byte');
      assert.equal(read(join(sourceRoot, '.env.local')), 'TEST_CONFIGURATION=keep\n');
    }
    assert.equal(existsSync(join(sourceRoot, 'site')), false);
    for (const output of [join(sourceRoot, 'site', 'output'), join(temporary, 'output')]) {
      const result = generate(sourceRoot, ['--output', output]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(read(output).length);
      assert.equal(read(join(sourceRoot, sourceFile)), original);
    }
  });

  test(`${script} rejects symbolic and hard-linked outputs and source parent aliases`, t => {
    const temporary = mkdtempSync(join(tmpdir(), 'iyf-generator-alias-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    const originalPath = join(sourceRoot, sourceFile);
    const original = read(originalPath);
    const symbolic = join(temporary, 'symbolic');
    const hard = join(temporary, 'hard');
    const sourceAlias = join(temporary, 'data-alias');
    const envPath = join(sourceRoot, '.env.local');
    const envAlias = join(temporary, 'env-alias');
    writeFileSync(envPath, 'TEST_CONFIGURATION=keep\n');
    linkSync(envPath, envAlias);
    symlinkSync(originalPath, symbolic);
    linkSync(originalPath, hard);
    symlinkSync(join(sourceRoot, 'data'), sourceAlias);
    for (const output of [symbolic, hard, envAlias, join(sourceAlias, 'generated.json')]) {
      const result = generate(sourceRoot, ['--output', output]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /Build output must not overwrite|symbolic link|hard-linked/);
      assert.equal(read(originalPath), original);
      assert.equal(read(envPath), 'TEST_CONFIGURATION=keep\n');
    }
    assert.equal(existsSync(join(sourceRoot, 'data', 'generated.json')), false);
  });
}

test('the real deployment build is repeatable and publishes only validated public files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-test-'));
  try {
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    const output = join(temporary, 'site');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = build(output, sourceRoot);
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
    const source = JSON.parse(read(join(sourceRoot, 'data/shows.json')));
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

test('deployment build tests recover from stale source snapshots by refreshing only fixture time', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-stale-test-'));
  try {
    const source = JSON.parse(read(join(root, 'data/shows.json')));
    const staleTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const staleSource = { ...source, lastUpdated: staleTimestamp };
    const sourceRoot = createBuildFixture(join(temporary, 'source'), staleSource);
    const fixture = JSON.parse(read(join(sourceRoot, 'data/shows.json')));
    assert.deepEqual({ ...fixture, lastUpdated: staleTimestamp }, staleSource);
    assert.equal(staleSource.lastUpdated, staleTimestamp);
    assert.ok(Date.parse(fixture.lastUpdated) > Date.parse(staleTimestamp));
    const output = join(temporary, 'site');
    const result = build(output, sourceRoot);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(read(join(output, 'data/shows.json'))).lastUpdated, fixture.lastUpdated);
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

test('deployment build resolves symbolic-link ancestors before checking protected directories', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-ancestor-'));
  try {
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    const showsPath = join(sourceRoot, 'data/shows.json');
    const before = read(showsPath);
    const alias = join(temporary, 'source-alias');
    symlinkSync(sourceRoot, alias, 'dir');
    for (const directory of ['.git', 'data', 'scripts', 'css']) {
      const output = join(alias, directory, 'nested', 'site');
      const result = build(output, alias);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must not overwrite the repository or its source directories/);
      assert.equal(existsSync(join(sourceRoot, directory, 'nested')), false);
      assert.equal(read(showsPath), before, 'a rejected aliased path must not change source data');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('deployment build recognizes source directories through filesystem case aliases', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-case-alias-'));
  try {
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    mkdirSync(join(sourceRoot, '.git'));
    const alias = join(temporary, 'SOURCE');
    if (!existsSync(alias)) {
      t.skip('this filesystem has no case aliases');
      return;
    }
    const before = read(join(sourceRoot, 'data/shows.json'));
    for (const directory of ['.GIT', 'DATA', 'CSS', 'SCRIPTS']) {
      const output = join(alias, directory, 'case-site');
      const result = build(output, sourceRoot);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must not overwrite the repository or its source directories/);
      assert.equal(existsSync(join(sourceRoot, directory.toLowerCase(), 'case-site')), false);
      assert.equal(read(join(sourceRoot, 'data/shows.json')), before);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('deployment build allows harmless parent aliases such as system temporary-directory aliases', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-safe-ancestor-'));
  try {
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    const before = read(join(sourceRoot, 'data/shows.json'));
    const target = join(temporary, 'target');
    mkdirSync(target);
    const alias = join(temporary, 'target-alias');
    symlinkSync(target, alias, 'dir');
    const result = build(join(alias, 'nested', 'site'), sourceRoot);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(target, 'nested/site/data/shows.json')));
    assert.equal(read(join(sourceRoot, 'data/shows.json')), before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('deployment build refuses hard-linked public files before overwriting a source inode', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-hardlink-'));
  try {
    const sourceRoot = createBuildFixture(join(temporary, 'source'));
    const showsPath = join(sourceRoot, 'data/shows.json');
    const before = read(showsPath);
    for (const path of ['index.html', 'data/shows.json']) {
      const output = join(temporary, path === 'index.html' ? 'html-site' : 'json-site');
      const target = join(output, path);
      mkdirSync(dirname(target), { recursive: true });
      linkSync(showsPath, target);
      const result = build(output, sourceRoot);
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`must not overwrite a hard-linked file: ${path}`), result.stderr);
      assert.equal(read(showsPath), before, 'the source JSON must remain intact after rejecting a hard link');
      assert.equal(read(target), before, 'the aliased output file must remain intact too');
      assert.equal(existsSync(join(output, 'js/app.js')), false, 'rejection must precede all build writes');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('deployment build rejects structured render text without changing source data or creating output', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iyf-build-invalid-text-'));
  try {
    const data = JSON.parse(read(join(root, 'data/shows.json')));
    data.koreanDramas[0].aiReason = { toString: 'broken' };
    const sourceRoot = createBuildFixture(join(temporary, 'source'), data);
    const showsPath = join(sourceRoot, 'data/shows.json');
    const before = read(showsPath);
    const output = join(temporary, 'site');
    const result = build(output, sourceRoot);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /koreanDramas\[0\]\.aiReason: must be a string or null/);
    assert.equal(existsSync(output), false);
    assert.equal(read(showsPath), before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
