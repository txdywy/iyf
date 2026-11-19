import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateHealth, formatAge, parseScrapedThisRun, renderSummary, runHealthCheck } from './check-health.mjs';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();

function snapshot(overrides = {}) {
  return {
    lastUpdated: iso(NOW - 2 * HOUR),
    generatedAt: iso(NOW - 2 * HOUR),
    sourceStatus: 'healthy',
    sourceKind: 'homepage',
    sourcePagesSucceeded: 30,
    sourcePagesMeaningful: 28,
    stats: { koreanDramas: 70, chineseVariety: 110, otherDramas: 12, totalScraped: 400 },
    koreanDramas: [],
    chineseVariety: [],
    ...overrides,
  };
}

test('healthy homepage and catalog snapshots produce no annotations', () => {
  for (const sourceKind of ['homepage', 'catalog']) {
    const result = evaluateHealth(snapshot({ sourceKind, aiRunStatus: { stopReason: '', requested: 4, scored: 40 } }), { now: NOW });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  }
});

test('a missing aiRunStatus is tolerated', () => {
  const result = evaluateHealth(snapshot(), { now: NOW });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.match(renderSummary(snapshot(), result), /\| AI 状态 \| 未记录 \|/u);
});

test('search fallback and unknown source kinds only warn', () => {
  for (const sourceKind of ['search', undefined, 'other']) {
    const result = evaluateHealth(snapshot({ sourceKind }), { now: NOW });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1, String(sourceKind));
  }
  assert.match(evaluateHealth(snapshot({ sourceKind: 'search' }), { now: NOW }).warnings[0], /search/u);
});

test('a degraded source is an error only after the snapshot is older than 48 hours', () => {
  const recent = evaluateHealth(snapshot({ sourceStatus: 'degraded', lastUpdated: iso(NOW - 47 * HOUR) }), { now: NOW });
  assert.deepEqual(recent.errors, []);
  assert.equal(recent.warnings.length, 1);

  const stale = evaluateHealth(snapshot({ sourceStatus: 'degraded', lastUpdated: iso(NOW - 49 * HOUR) }), { now: NOW });
  assert.equal(stale.errors.length, 1);
  assert.match(stale.errors[0], /超过 48 小时/u);

  const invalid = evaluateHealth(snapshot({ sourceStatus: 'degraded', lastUpdated: 'not a date' }), { now: NOW });
  assert.equal(invalid.errors.length, 1);

  const staleHealthy = evaluateHealth(snapshot({ lastUpdated: iso(NOW - 10 * 24 * HOUR) }), { now: NOW });
  assert.match(staleHealthy.errors[0], /超过 48 小时/u);
});

test('AI auth and credit stops are errors while quota, failures and budget only warn', () => {
  for (const stopReason of ['auth', 'credit']) {
    const result = evaluateHealth(snapshot({ aiRunStatus: { stopReason, requested: 1, scored: 0 } }), { now: NOW });
    assert.equal(result.errors.length, 1, stopReason);
    assert.match(result.errors[0], new RegExp(`\\(${stopReason}\\)`, 'u'));
  }
  for (const stopReason of ['quota', 'failures', 'budget']) {
    const result = evaluateHealth(snapshot({ aiRunStatus: { stopReason, requested: 9, scored: 50 } }), { now: NOW });
    assert.deepEqual(result.errors, [], stopReason);
    assert.equal(result.warnings.length, 1, stopReason);
  }
  const malformed = evaluateHealth(snapshot({ aiRunStatus: 'auth' }), { now: NOW });
  assert.deepEqual(malformed.errors, [], 'a malformed status is left to data validation');
});

test('non-object snapshots are reported as errors', () => {
  for (const value of [null, [], 'text']) assert.equal(evaluateHealth(value, { now: NOW }).errors.length, 1);
});

test('summary lists source, pages, counts, AI status and snapshot ages', () => {
  const data = snapshot({ sourceKind: 'catalog', sourceCatalogPages: 4, aiRunStatus: { stopReason: 'quota', requested: 6, scored: 33 } });
  const summary = renderSummary(data, evaluateHealth(data, { now: NOW }));
  assert.match(summary, /\| sourceStatus \| healthy \|/u);
  assert.match(summary, /\| sourceKind \| catalog \|/u);
  assert.match(summary, /30 \/ 28/u);
  assert.match(summary, /目录（成功页数） \| 4/u);
  assert.match(summary, /70 \/ 110 \/ 12/u);
  assert.match(summary, /停止原因 quota，请求 6，成功批次 33/u);
  assert.match(summary, /2\.0 小时前/u);
  assert.match(summary, /### 警告/u);
  assert.doesNotMatch(summary, /### 错误/u);
});

test('summary cells cannot break the markdown table', () => {
  const data = snapshot({ sourceKind: 'a|b\nc' });
  const summary = renderSummary(data, evaluateHealth(data, { now: NOW }));
  assert.match(summary, /\| sourceKind \| a b c \|/u);
});

test('ages are formatted in minutes, hours or days', () => {
  assert.equal(formatAge(NaN), '未知');
  assert.equal(formatAge(5 * 60 * 1000), '5 分钟');
  assert.equal(formatAge(3 * HOUR), '3.0 小时');
  assert.equal(formatAge(72 * HOUR), '3.0 天');
});

test('CLI runner writes the step summary and exits 1 only on errors', t => {
  const directory = mkdtempSync(join(tmpdir(), 'iyf-health-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'shows.json');
  const summaryPath = join(directory, 'summary.md');
  const run = data => {
    writeFileSync(path, JSON.stringify(data));
    writeFileSync(summaryPath, '');
    const out = [];
    const err = [];
    const code = runHealthCheck({ path, now: NOW, env: { GITHUB_STEP_SUMMARY: summaryPath },
      log: line => out.push(line), error: line => err.push(line) });
    return { code, out, err, summary: readFileSync(summaryPath, 'utf8') };
  };

  const warned = run(snapshot({ sourceKind: 'search' }));
  assert.equal(warned.code, 0);
  assert.ok(warned.out.some(line => line.startsWith('::warning::')));
  assert.deepEqual(warned.err, []);
  assert.match(warned.summary, /## 数据健康检查/u);

  const failed = run(snapshot({ aiRunStatus: { stopReason: 'credit', requested: 1, scored: 0 } }));
  assert.equal(failed.code, 1);
  assert.ok(failed.err.some(line => line.startsWith('::error::')));
  assert.match(failed.summary, /### 错误/u);

  writeFileSync(path, '{broken');
  const errors = [];
  assert.equal(runHealthCheck({ path, now: NOW, env: {}, log() {}, error: line => errors.push(line) }), 1);
  assert.match(errors[0], /^::error::/u);
});

test('AI coverage collapse warns only above half of at least four due shows', () => {
  const ai = extra => snapshot({ aiRunStatus: { stopReason: '', requested: 4, scored: 3, ...extra } });
  for (const [due, missed] of [[4, 3], [10, 6], [100, 51]]) {
    const result = evaluateHealth(ai({ due, missed }), { now: NOW, scrapedThisRun: true });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1, `${missed}/${due}`);
    assert.match(result.warnings[0], new RegExp(`应评分 ${due} 个节目，其中 ${missed} 个`, 'u'));
  }
  for (const extra of [{ due: 4, missed: 2 }, { due: 10, missed: 5 }, { due: 3, missed: 3 }, { due: 0, missed: 0 },
    { due: 10 }, { missed: 9 }, {}, { due: '10', missed: '9' }, { due: -4, missed: -3 }]) {
    const result = evaluateHealth(ai(extra), { now: NOW, scrapedThisRun: true });
    assert.deepEqual(result.warnings, [], JSON.stringify(extra));
    assert.deepEqual(result.errors, [], JSON.stringify(extra));
  }
  const data = ai({ due: 8, missed: 6 });
  const summary = renderSummary(data, evaluateHealth(data, { now: NOW, scrapedThisRun: true }));
  assert.match(summary, /\| AI 覆盖（未获新评分 \/ 应评分） \| 6 \/ 8 \|/u);
  assert.match(renderSummary(snapshot(), evaluateHealth(snapshot(), { now: NOW })), /\| AI 覆盖（未获新评分 \/ 应评分） \| — \/ — \|/u);
});

test('runs that did not scrape keep the staleness check but do not re-report the previous AI run', () => {
  const data = snapshot({ aiRunStatus: { stopReason: 'auth', requested: 1, scored: 0, due: 20, missed: 20 } });
  const skipped = evaluateHealth(data, { now: NOW, scrapedThisRun: false });
  assert.deepEqual(skipped.errors, []);
  assert.deepEqual(skipped.warnings, []);
  assert.match(renderSummary(data, skipped), /本轮未抓取，不评估/u);

  const scraped = evaluateHealth(data, { now: NOW, scrapedThisRun: true });
  assert.equal(scraped.errors.length, 1);
  assert.equal(scraped.warnings.length, 1, 'coverage collapse is reported alongside the stop reason');
  assert.equal(evaluateHealth(data, { now: NOW }).errors.length, 1, 'a local run without the workflow signal still evaluates AI');

  const stale = evaluateHealth({ ...data, sourceStatus: 'degraded', lastUpdated: iso(NOW - 72 * HOUR) }, { now: NOW, scrapedThisRun: false });
  assert.equal(stale.errors.length, 1);
  assert.match(stale.errors[0], /超过 48 小时/u);
});

test('the workflow scrape signal is parsed strictly', () => {
  assert.equal(parseScrapedThisRun(undefined), undefined);
  assert.equal(parseScrapedThisRun('true'), true);
  for (const value of ['false', '', 'TRUE', '1']) assert.equal(parseScrapedThisRun(value), false, value);
});

test('CLI runner reads the scrape signal from the environment', t => {
  const directory = mkdtempSync(join(tmpdir(), 'iyf-health-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'shows.json');
  writeFileSync(path, JSON.stringify(snapshot({ aiRunStatus: { stopReason: 'credit', requested: 1, scored: 0 } })));
  const quiet = { log() {}, error() {} };
  assert.equal(runHealthCheck({ path, now: NOW, env: { IYF_SCRAPED_THIS_RUN: 'false' }, ...quiet }), 0);
  assert.equal(runHealthCheck({ path, now: NOW, env: { IYF_SCRAPED_THIS_RUN: 'true' }, ...quiet }), 1);
  assert.equal(runHealthCheck({ path, now: NOW, env: {}, ...quiet }), 1);
});
