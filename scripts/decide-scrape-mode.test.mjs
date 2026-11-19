import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decideScrapeMode, FRESH_DATA_MS, generatedAgeMs, readRemoteMainSha, runDecideScrapeMode } from './decide-scrape-mode.mjs';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const shows = generatedAt => JSON.stringify({ generatedAt, lastUpdated: generatedAt });
const ago = ms => new Date(NOW - ms).toISOString();

function decide(overrides = {}) {
  let reads = 0;
  const readMainSha = overrides.readMainSha ?? (async () => HEAD);
  return decideScrapeMode({
    eventName: 'schedule', showsText: shows(ago(12 * HOUR)), now: NOW, headSha: HEAD,
    ...overrides,
    readMainSha: async () => { reads++; return readMainSha(); },
  }).then(result => ({ ...result, reads }));
}

test('push runs never scrape and never read the remote', async () => {
  const result = await decide({ eventName: 'push', showsText: shows(ago(48 * HOUR)) });
  assert.equal(result.scrape, false);
  assert.equal(result.reason, 'push');
  assert.equal(result.reads, 0);
  assert.deepEqual(result.notices, []);
});

test('scheduled runs skip scraping while committed data is under 8 hours old', async () => {
  const fresh = await decide({ showsText: shows(ago(7.9 * HOUR)) });
  assert.equal(fresh.scrape, false);
  assert.equal(fresh.reason, 'fresh');
  assert.equal(fresh.reads, 0, 'a fresh skip needs no network request');
  assert.match(fresh.notices[0], /7\.9 小时前生成（不足 8 小时）/u);

  assert.equal((await decide({ showsText: shows(ago(0)) })).scrape, false, 'zero age is fresh');
  const exact = await decide({ showsText: shows(ago(FRESH_DATA_MS)) });
  assert.equal(exact.scrape, true, 'exactly 8 hours old is due for a scrape');
  assert.equal(exact.reason, 'scrape');
  assert.equal((await decide({ showsText: shows(ago(FRESH_DATA_MS - 1)) })).scrape, false);
});

test('manual dispatch scrapes even with fresh data', async () => {
  const result = await decide({ eventName: 'workflow_dispatch', showsText: shows(ago(HOUR)) });
  assert.equal(result.scrape, true);
  assert.equal(result.reads, 1);
});

test('future, missing, invalid or malformed generatedAt values fall back to scraping', async () => {
  for (const showsText of [shows(new Date(NOW + HOUR).toISOString()), '{broken', '', 'null', '[]',
    JSON.stringify({}), JSON.stringify({ generatedAt: 'yesterday' }), JSON.stringify({ generatedAt: 1763553600000 })]) {
    const result = await decide({ showsText });
    assert.equal(result.scrape, true, showsText);
    assert.deepEqual(result.notices, [], showsText);
  }
  assert.equal(generatedAgeMs(shows(new Date(NOW + 1).toISOString()), NOW), null);
  assert.equal(generatedAgeMs(shows(ago(HOUR)), NOW), HOUR);
});

test('a run whose commit is no longer main does not scrape', async () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const result = await decide({ eventName, readMainSha: async () => OTHER });
    assert.equal(result.scrape, false, eventName);
    assert.equal(result.reason, 'main-advanced');
    assert.ok(result.notices[0].includes(`${HEAD} 前进到 ${OTHER}`));
  }
});

test('an unconfirmed origin/main keeps scraping as before', async () => {
  for (const readMainSha of [async () => null, async () => { throw new Error('ECONNRESET'); }, async () => 'not-a-sha', async () => OTHER.slice(1)]) {
    const result = await decide({ readMainSha });
    assert.equal(result.scrape, true);
    assert.equal(result.reason, 'main-unknown');
    assert.deepEqual(result.notices, []);
    assert.match(result.logs[0], /无法确认 origin\/main/u);
  }
  const missingHead = await decide({ headSha: undefined });
  assert.equal(missingHead.scrape, true);
  assert.equal(missingHead.reason, 'main-unknown');
});

test('remote reads retry once without prompting and never throw', async () => {
  const calls = [];
  const sleeps = [];
  const sha = await readRemoteMainSha({
    sleep: async ms => { sleeps.push(ms); },
    run: async (command, args, options) => {
      calls.push({ command, args, prompt: options.env.GIT_TERMINAL_PROMPT, timeout: options.timeout });
      if (calls.length === 1) throw Object.assign(new Error('network'), { code: 128 });
      return { stdout: `${OTHER}\trefs/heads/main\n` };
    },
  });
  assert.equal(sha, OTHER);
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(calls[0], { command: 'git', args: ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], prompt: '0', timeout: 15000 });

  assert.equal(await readRemoteMainSha({ sleep: async () => {}, run: async () => { throw new Error('down'); } }), null);
  assert.equal(await readRemoteMainSha({ sleep: async () => {}, run: async () => ({ stdout: 'garbage' }) }), null);
});

test('the CLI runner writes the step output and notices', async t => {
  const root = mkdtempSync(join(tmpdir(), 'iyf-decide-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  const output = join(root, 'output.txt');
  const run = async (env, readMainSha = async () => HEAD) => {
    writeFileSync(output, '');
    const lines = [];
    const result = await runDecideScrapeMode({ root, now: NOW, readMainSha, log: line => lines.push(line),
      env: { GITHUB_OUTPUT: output, GITHUB_SHA: HEAD, ...env } });
    return { result, lines, output: readFileSync(output, 'utf8') };
  };

  const missingFile = await run({ EVENT_NAME: 'schedule' });
  assert.equal(missingFile.output, 'scrape=true\n', 'a missing snapshot scrapes');

  writeFileSync(join(root, 'data', 'shows.json'), shows(ago(2 * HOUR)));
  const fresh = await run({ EVENT_NAME: 'schedule' });
  assert.equal(fresh.output, 'scrape=false\n');
  assert.ok(fresh.lines.some(line => line.startsWith('::notice::')));
  assert.equal(fresh.lines.at(-1), 'Scrape this run: false');

  const advanced = await run({ EVENT_NAME: 'workflow_dispatch' }, async () => OTHER);
  assert.equal(advanced.output, 'scrape=false\n');
  assert.equal((await run({ EVENT_NAME: 'push' })).output, 'scrape=false\n');
  assert.equal((await run({ EVENT_NAME: 'workflow_dispatch' })).output, 'scrape=true\n');
});
