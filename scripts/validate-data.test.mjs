import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

function showFixture(id) {
  return {
    id,
    title: '校验节目',
    year: 2020,
    score: 8.5,
    playCount: 100,
    recommendScore: 125,
    coverImg: 'https://image.tmdb.org/t/p/original/poster.jpg',
    primaryUrl: 'https://www.yfsp.tv/play/demo',
  };
}

function dataFixture(counts = {}) {
  const data = { lastUpdated: new Date().toISOString(), stats: {} };
  for (const category of ['koreanDramas', 'chineseVariety', 'otherDramas']) {
    const count = counts[category] ?? 1;
    data[category] = Array.from({ length: count }, (_, index) => showFixture(`${category}-${index}`));
    data.stats[category] = count;
  }
  return data;
}

// 执行真实 CLI，临时根目录保持它的 scripts/../data 文件定位契约。
function runValidation(data) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'iyf-validator-test-'));
  try {
    const fixtureScripts = join(fixtureRoot, 'scripts');
    const fixtureData = join(fixtureRoot, 'data');
    mkdirSync(fixtureScripts);
    mkdirSync(fixtureData);
    const validator = join(fixtureScripts, 'validate-data.mjs');
    copyFileSync(join(scriptsDir, 'validate-data.mjs'), validator);
    writeFileSync(join(fixtureData, 'shows.json'), typeof data === 'string' ? data : JSON.stringify(data));
    for (const file of ['image_cache.json', 'discovery.json']) {
      writeFileSync(join(fixtureData, file), '{}');
    }
    const result = spawnSync(process.execPath, [validator], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test('validator accepts the public category limit without limiting unpublished shows', () => {
  const result = runValidation(dataFixture({ koreanDramas: 1000, chineseVariety: 1000, otherDramas: 1001 }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Data validation passed/u);
});

for (const category of ['koreanDramas', 'chineseVariety']) {
  test(`validator rejects ${category} above the frontend limit`, () => {
    const result = runValidation(dataFixture({ [category]: 1001 }));
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`${category} must contain at most 1000 shows`), result.stderr);
  });
}

test('validator accepts absent optional flags and zero numeric sentinels', () => {
  const data = dataFixture();
  Object.assign(data.chineseVariety[0], { score: 0, playCount: 0, recommendScore: 0, year: 0 });
  const result = runValidation(data);
  assert.equal(result.status, 0, result.stderr);
});

test('validator accepts true and false for every public boolean flag', () => {
  const data = dataFixture({ chineseVariety: 2 });
  for (const field of ['isComplete', 'isSerial', 'isClassic', 'isAutoDiscovered', 'isNew', 'tmdbCoverPending']) {
    data.chineseVariety[0][field] = false;
    data.chineseVariety[1][field] = true;
  }
  data.chineseVariety[1].isSerial = false;
  data.chineseVariety[0].isSerial = true;
  const result = runValidation(data);
  assert.equal(result.status, 0, result.stderr);
});

for (const field of ['isComplete', 'isSerial', 'isClassic', 'isAutoDiscovered', 'isNew', 'tmdbCoverPending']) {
  test(`validator rejects non-boolean ${field}`, () => {
    for (const value of ['false', 0, null]) {
      const data = dataFixture();
      data.chineseVariety[0][field] = value;
      const result = runValidation(data);
      assert.equal(result.status, 1, `${field}=${JSON.stringify(value)}: ${result.stdout}`);
      assert.ok(result.stderr.includes(`chineseVariety[0].${field}: must be boolean`), result.stderr);
    }
  });
}

for (const field of ['score', 'playCount', 'recommendScore', 'year']) {
  test(`validator requires a finite numeric ${field}`, () => {
    for (const value of [undefined, null, '8', true]) {
      const data = dataFixture();
      if (value === undefined) delete data.chineseVariety[0][field];
      else data.chineseVariety[0][field] = value;
      const result = runValidation(data);
      assert.equal(result.status, 1, `${field}=${String(value)}: ${result.stdout}`);
      assert.ok(result.stderr.includes(`chineseVariety[0].${field}: must be finite`), result.stderr);
    }

    // 1e999 是合法 JSON 数值，但 JSON.parse 将其转成 Infinity；不能只拦 null。
    const data = dataFixture();
    data.chineseVariety[0][field] = 1;
    const nonFiniteJSON = JSON.stringify(data).replace(`"${field}":1,`, `"${field}":1e999,`);
    const result = runValidation(nonFiniteJSON);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`chineseVariety[0].${field}: must be finite`), result.stderr);
  });
}
