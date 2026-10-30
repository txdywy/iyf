import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyGitHubPages } from './verify-github-pages.mjs';

const BASE = 'https://txdywy.github.io/iyf/';
const LAST_UPDATED = '2026-10-30T07:44:07.255Z';
const digest = body => createHash('sha256').update(body).digest('hex').slice(0, 12);
const contentTypes = { 'index.html': 'text/html', 'css/style.css': 'text/css',
  'js/app.js': 'application/javascript', 'data/shows.json': 'application/json',
  'robots.txt': 'text/plain', '404.html': 'text/html', missing: 'text/html' };

function createHarness(t, { publicReply, timeoutMs = 25, pollIntervalMs = 10 } = {}) {
  const outputRoot = mkdtempSync(join(tmpdir(), 'iyf-github-pages-test-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const files = new Map([
    ['css/style.css', '.fixture { color: #123456; }\n'],
    ['js/app.js', 'console.log("备用站测试");\n'],
    ['data/shows.json', JSON.stringify({ lastUpdated: LAST_UPDATED, koreanDramas: [], chineseVariety: [] }) + '\n'],
    ['robots.txt', 'User-agent: *\nAllow: /\n'],
  ]);
  const css = `css/style.${digest(files.get('css/style.css'))}.css`;
  const js = `js/app.${digest(files.get('js/app.js'))}.js`;
  files.set('index.html', `<!doctype html><link href="${css}" rel="stylesheet"><script src="${js}"></script>\n`);
  files.set('404.html', `<!doctype html><link href="/iyf/${css}" rel="stylesheet"><a href="/iyf/index.html">返回推荐首页</a>\n`);
  for (const [file, body] of files) {
    const path = join(outputRoot, file === 'css/style.css' ? css : file === 'js/app.js' ? js : file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const routes = new Map([
    ['/iyf/index.html', 'index.html'], [`/iyf/${css}`, 'css/style.css'], [`/iyf/${js}`, 'js/app.js'],
    ['/iyf/data/shows.json', 'data/shows.json'], ['/iyf/robots.txt', 'robots.txt'],
    ['/iyf/404.html', '404.html'], ['/iyf/__deployment_404_check__/nested', 'missing'],
  ]);
  let elapsed = 0;
  let poll = -1;
  const calls = [];
  const waits = [];
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    const file = routes.get(url.pathname);
    assert.equal(url.origin, new URL(BASE).origin);
    assert.equal(options.redirect, 'manual', 'a redirect back to the primary site must be visible');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(file, `unexpected verification URL: ${address}`);
    calls.push(address);
    if (file === 'index.html') poll++;
    const reply = { file, poll, status: file === 'missing' ? 404 : 200,
      body: file === 'missing' ? files.get('404.html') : files.get(file),
      headers: { 'content-type': contentTypes[file] } };
    const override = publicReply?.(reply) || {};
    if (override.error) throw override.error;
    if (override.advance) elapsed += override.advance;
    return new Response(override.body ?? reply.body, { status: override.status ?? reply.status, headers: override.headers ?? reply.headers });
  };
  const run = () => verifyGitHubPages({ outputRoot, fetchImpl, now: () => elapsed,
    delay: async ms => { waits.push(ms); elapsed += ms; }, timeoutMs, pollIntervalMs, log() {} });
  return { run, calls, waits, files, outputRoot, routes };
}

test('GitHub Pages backup verifies independent homepage, assets, data and 404 routes', async t => {
  const h = createHarness(t);
  assert.deepEqual(await h.run(), { lastUpdated: LAST_UPDATED, files: 6, url: `${BASE}index.html` });
  assert.deepEqual(h.calls.sort(), [...h.routes.keys()].map(path => `https://txdywy.github.io${path}`).sort());
  assert.deepEqual(h.waits, []);
});

test('GitHub Pages backup rejects redirects to a custom domain', async t => {
  const h = createHarness(t, { publicReply: ({ file }) => file === 'index.html'
    ? { status: 301, headers: { location: 'https://iyf.hackx64.eu.org/' }, body: '' } : {} });
  await assert.rejects(h.run(), /index\.html: HTTP 301/u);
});

test('GitHub Pages backup retries until the new data matches the artifact', async t => {
  const h = createHarness(t, { publicReply: ({ file, poll }) => file === 'data/shows.json' && poll === 0 ? { body: '{}' } : {} });
  assert.equal((await h.run()).lastUpdated, LAST_UPDATED);
  assert.deepEqual(h.waits, [10]);
});

test('GitHub Pages backup rejects a missing or stale custom 404 file', async t => {
  for (const reply of [{ status: 404 }, { body: '<!doctype html>stale 404' }]) {
    const h = createHarness(t, { publicReply: ({ file }) => file === '404.html' ? reply : {} });
    await assert.rejects(h.run(), /404\.html: (?:HTTP 404|content hash mismatch)/u);
  }
});

test('GitHub Pages backup requires a real 404 for nested missing routes', async t => {
  const h = createHarness(t, { publicReply: ({ file }) => file === 'missing' ? { status: 200 } : {} });
  await assert.rejects(h.run(), /missing route: HTTP 200/u);
});

test('GitHub Pages backup rejects a generic or account-level 404 for nested missing routes', async t => {
  const h = createHarness(t, { publicReply: ({ file }) => file === 'missing' ? { body: 'generic account 404' } : {} });
  await assert.rejects(h.run(), /missing route: content hash mismatch/u);
});

test('GitHub Pages backup accepts both standard JavaScript MIME types and rejects wrong ones', async t => {
  for (const [type, ok] of [['text/javascript; charset=utf-8', true], ['application/javascript', true], ['text/plain', false]]) {
    const h = createHarness(t, { publicReply: ({ file, headers }) => file === 'js/app.js'
      ? { headers: { ...headers, 'content-type': type } } : {} });
    if (ok) await assert.doesNotReject(h.run());
    else await assert.rejects(h.run(), /js\/app\.js: invalid content-type/u);
  }
});

test('GitHub Pages backup cannot report success after the polling deadline', async t => {
  const h = createHarness(t, { publicReply: ({ file }) => file === 'index.html' ? { advance: 30 } : {} });
  await assert.rejects(h.run(), /verification deadline/u);
  assert.deepEqual(h.waits, []);
});

test('GitHub Pages backup rejects invalid versioned asset references before making requests', async t => {
  const h = createHarness(t);
  writeFileSync(join(h.outputRoot, 'index.html'), '<link href="css/style.css"><script src="js/app.js"></script>');
  await assert.rejects(h.run(), /versioned CSS\/JS/u);
  assert.deepEqual(h.calls, []);
});
