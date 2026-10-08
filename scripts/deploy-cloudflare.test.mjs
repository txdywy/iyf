import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { deployCloudflare } from './deploy-cloudflare.mjs';

const HOOK_URL = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/unit-test-secret-token';
const PAGES_ORIGIN = 'https://iyf-5l7.pages.dev';
const CANONICAL_ORIGIN = 'https://iyf.hackx64.eu.org';
const VERIFIED_ORIGINS = [PAGES_ORIGIN, CANONICAL_ORIGIN];
const LAST_UPDATED = '2026-09-30T03:46:36.204Z';
const digest = body => createHash('sha256').update(body).digest('hex').slice(0, 12);

function createHarness(t, {
  publicReply,
  triggerReply = () => new Response(JSON.stringify({ success: true }), { status: 200 }),
  timeoutMs = 25,
  pollIntervalMs = 10,
} = {}) {
  const outputRoot = mkdtempSync(join(tmpdir(), 'iyf-cloudflare-test-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const files = new Map([
    ['css/style.css', '.fixture { color: #123456; }\n'],
    ['js/app.js', 'console.log("部署测试");\n'],
    ['data/shows.json', JSON.stringify({ lastUpdated: LAST_UPDATED, stats: { koreanDramas: 0, chineseVariety: 0 }, koreanDramas: [], chineseVariety: [] }) + '\n'],
    ['robots.txt', 'User-agent: *\nAllow: /\nDisallow: /data/\n'],
    ['404.html', '<!doctype html><title>页面未找到</title><a href="/">返回首页</a>\n'],
  ]);
  const cssPath = `/css/style.css?v=${digest(files.get('css/style.css'))}`;
  const jsPath = `/js/app.js?v=${digest(files.get('js/app.js'))}`;
  files.set('index.html', `<!doctype html><link href="${cssPath.slice(1)}" rel="stylesheet"><script src="${jsPath.slice(1)}"></script>\n`);
  for (const [file, body] of files) {
    const path = join(outputRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const routes = new Map([
    ['/', 'index.html'],
    [cssPath, 'css/style.css'],
    [jsPath, 'js/app.js'],
    ['/data/shows.json', 'data/shows.json'],
    ['/robots.txt', 'robots.txt'],
    ['/__deployment_404_check__', '404.html'],
  ]);
  const calls = [];
  const waits = [];
  const logs = [];
  let elapsed = 0;
  let poll = -1;
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    calls.push({ address, options });
    assert.ok(options.signal instanceof AbortSignal, 'every request must have an abort deadline');
    if (options.method === 'POST') {
      assert.equal(address, HOOK_URL);
      return triggerReply();
    }
    assert.ok(VERIFIED_ORIGINS.includes(url.origin));
    assert.equal(options.cache, 'no-store');
    const file = routes.get(url.pathname + url.search);
    assert.ok(file, `unexpected deployment verification URL: ${address}`);
    if (file === 'index.html' && url.origin === PAGES_ORIGIN) poll++;
    const response = {
      origin: url.origin,
      file,
      poll,
      body: files.get(file),
      status: file === '404.html' ? 404 : 200,
      headers: {
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'cache-control': ['css/style.css', 'js/app.js'].includes(file) ? 'public, max-age=86400' : 'no-cache',
      },
    };
    const override = publicReply?.(response) || {};
    if (override.error) throw override.error;
    return new Response(override.body ?? response.body, {
      status: override.status ?? response.status,
      headers: override.headers ?? response.headers,
    });
  };
  const run = overrides => deployCloudflare({
    hookUrl: HOOK_URL,
    outputRoot,
    fetchImpl,
    delay: async ms => { waits.push(ms); elapsed += ms; },
    now: () => elapsed,
    timeoutMs,
    pollIntervalMs,
    log: message => logs.push(message),
    ...overrides,
  });
  return { run, calls, waits, logs, files, outputRoot, routes };
}

test('Cloudflare deployment verifies every artifact file with versioned asset URLs', async t => {
  const h = createHarness(t);
  assert.deepEqual(await h.run(), { lastUpdated: LAST_UPDATED, files: 6, origin: PAGES_ORIGIN, verifiedOrigins: VERIFIED_ORIGINS });
  assert.equal(h.calls[0].options.method, 'POST');
  assert.deepEqual(h.calls.slice(1).map(call => call.address).sort(), VERIFIED_ORIGINS.flatMap(origin => [...h.routes.keys()].map(path => `${origin}${path}`)).sort());
  assert.deepEqual(h.waits, []);
  assert.match(h.logs.at(-1), /production matches the validated artifact/);
});

test('Cloudflare deployment rejects invalid hook addresses before sending requests', async t => {
  const h = createHarness(t);
  for (const hookUrl of [
    undefined, '', 'not a URL',
    HOOK_URL.replace('https:', 'http:'),
    HOOK_URL.replace('api.cloudflare.com', 'api.cloudflare.com.evil.example'),
    HOOK_URL.replace('api.cloudflare.com', 'name:password@api.cloudflare.com'),
    HOOK_URL.replace('api.cloudflare.com', 'api.cloudflare.com:8443'),
    'https://api.cloudflare.com/client/v4/accounts/unit-test-secret-token',
    `${HOOK_URL}?secret=unit-test-secret-token`, `${HOOK_URL}#unit-test-secret-token`,
  ]) {
    await assert.rejects(h.run({ hookUrl }), error => {
      assert.match(error.message, /CLOUDFLARE_DEPLOY_HOOK/);
      assert.ok(!error.message.includes('unit-test-secret-token'));
      return true;
    });
  }
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.logs, []);
});

for (const [name, triggerReply, expectedMessage] of [
  ['unreachable hook', () => { throw new Error(`request failed: ${HOOK_URL}`); }, /trigger could not be reached/],
  ['HTTP failure', () => new Response(HOOK_URL, { status: 503 }), /trigger returned HTTP 503/],
  ['provider rejection', () => new Response(JSON.stringify({ success: false, errors: [{ message: HOOK_URL }] })), /rejected the deployment trigger/],
]) {
  test(`Cloudflare ${name} fails without disclosing the deploy hook`, async t => {
    const h = createHarness(t, { triggerReply });
    await assert.rejects(h.run(), error => {
      assert.match(error.message, expectedMessage);
      assert.ok(!String(error).includes(HOOK_URL));
      assert.ok(!String(error).includes('unit-test-secret-token'));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(h.calls.length, 1, 'a rejected trigger must not start public polling');
    assert.deepEqual(h.logs, []);
  });
}

test('Cloudflare deployment refuses an artifact with unversioned assets before triggering', async t => {
  const h = createHarness(t);
  writeFileSync(join(h.outputRoot, 'index.html'), '<link href="css/style.css"><script src="js/app.js"></script>');
  await assert.rejects(h.run(), /missing versioned CSS\/JS URLs/);
  assert.equal(h.calls.length, 0);
});

test('Cloudflare deployment waits until data and both assets match in the same poll', async t => {
  const h = createHarness(t, {
    timeoutMs: 100,
    publicReply: ({ file, poll, body }) => {
      if ((poll === 0 && file === 'data/shows.json')
        || (poll === 1 && file === 'js/app.js')
        || (poll === 2 && file === 'css/style.css')) return { body: `${body}\n旧版本` };
    },
  });
  assert.deepEqual(await h.run(), { lastUpdated: LAST_UPDATED, files: 6, origin: PAGES_ORIGIN, verifiedOrigins: VERIFIED_ORIGINS });
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.calls.length, 1 + 4 * 12);
  assert.deepEqual(h.waits, [10, 10, 10]);
});

test('Cloudflare deployment recovers from a transient verification request failure', async t => {
  const h = createHarness(t, {
    publicReply: ({ file, poll }) => poll === 0 && file === 'data/shows.json' ? { error: new Error('temporary outage') } : {},
  });
  assert.equal((await h.run()).files, 6);
  assert.deepEqual(h.waits, [10]);
});

for (const [name, publicReply] of [
  ['SPA success status at the missing-page route', ({ file }) => file === '404.html' ? { status: 200 } : {}],
  ['generic 404 body', ({ file }) => file === '404.html' ? { body: '<h1>Not Found</h1>' } : {}],
]) {
  test(`Cloudflare deployment rejects ${name}`, async t => {
    const h = createHarness(t, { publicReply });
    await assert.rejects(h.run(), /did not match.*deployment timeout/);
    assert.deepEqual(h.waits, [10, 10, 5]);
  });
}

for (const header of ['x-content-type-options', 'x-frame-options', 'content-security-policy']) {
  test(`Cloudflare deployment rejects missing ${header} on the homepage`, async t => {
    const h = createHarness(t, {
      publicReply: ({ file, headers }) => {
        if (file !== 'index.html') return {};
        delete headers[header];
        return { headers };
      },
    });
    await assert.rejects(h.run(), /did not match.*deployment timeout/);
  });
}

test('Cloudflare deployment rejects a CSP that does not prevent framing', async t => {
  const h = createHarness(t, {
    publicReply: ({ file, headers }) => file === 'index.html'
      ? { headers: { ...headers, 'content-security-policy': "default-src 'self'" } } : {},
  });
  await assert.rejects(h.run(), /did not match.*deployment timeout/);
});

for (const target of ['index.html', 'data/shows.json']) {
  test(`Cloudflare deployment requires revalidation cache headers for ${target}`, async t => {
    for (const cacheControl of [undefined, 'public, max-age=86400']) {
      const h = createHarness(t, {
        publicReply: ({ file, headers }) => {
          if (file !== target) return {};
          if (cacheControl === undefined) delete headers['cache-control'];
          else headers['cache-control'] = cacheControl;
          return { headers };
        },
      });
      await assert.rejects(h.run(), /did not match.*deployment timeout/);
    }
  });
}

test('Cloudflare deployment times out with stale files and bounds the final polling delay', async t => {
  const h = createHarness(t, { publicReply: ({ file }) => file === 'data/shows.json' ? { body: '{}' } : {} });
  await assert.rejects(h.run(), /did not match.*deployment timeout/);
  assert.deepEqual(h.waits, [10, 10, 5]);
  assert.equal(h.calls.length, 1 + 3 * 12);
  assert.ok(h.logs.every(message => !message.includes('production matches')));
  assert.ok(h.logs.every(message => !message.includes(HOOK_URL)));
});

test('Cloudflare deployment cannot report success after matching requests exceed the polling deadline', async t => {
  const h = createHarness(t);
  let elapsed = 0;
  const result = h.run({
    timeoutMs: 10,
    now: () => elapsed,
    fetchImpl: async (address, options) => {
      if (options.method === 'POST') return new Response('{"success":true}');
      const url = new URL(address);
      const file = h.routes.get(url.pathname + url.search);
      const response = new Response(h.files.get(file), {
        status: file === '404.html' ? 404 : 200,
        headers: {
          'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'", 'cache-control': 'no-cache',
        },
      });
      const read = response.text.bind(response);
      response.text = async () => { elapsed = 100; return read(); };
      return response;
    },
  });
  await assert.rejects(result, /deployment timeout/);
  assert.ok(h.logs.every(message => !message.includes('production matches')));
  assert.deepEqual(h.waits, []);
});

test('Cloudflare deployment cannot succeed while only the Pages domain is healthy', async t => {
  const h = createHarness(t, {
    publicReply: ({ origin }) => origin === CANONICAL_ORIGIN ? { status: 503, body: 'Domain unavailable' } : {},
  });
  await assert.rejects(h.run(), /deployment timeout.*iyf\.hackx64\.eu\.org/);
  assert.deepEqual(h.waits, [10, 10, 5]);
});

test('Cloudflare deployment waits for fresh data and security headers on the custom domain', async t => {
  const h = createHarness(t, {
    timeoutMs: 100,
    publicReply: ({ origin, file, poll, body, headers }) => {
      if (origin !== CANONICAL_ORIGIN) return {};
      if (poll === 0 && file === 'data/shows.json') return { body: `${body}\n旧版本` };
      if (poll === 1 && file === 'index.html') return { headers: { ...headers, 'x-frame-options': 'SAMEORIGIN' } };
      return {};
    },
  });
  assert.deepEqual(await h.run(), { lastUpdated: LAST_UPDATED, files: 6, origin: PAGES_ORIGIN, verifiedOrigins: VERIFIED_ORIGINS });
  assert.deepEqual(h.waits, [10, 10]);
});

test('Cloudflare deployment rejects a custom-domain TLS or network failure', async t => {
  const h = createHarness(t, {
    publicReply: ({ origin }) => origin === CANONICAL_ORIGIN ? { error: new Error('TLS verification failed') } : {},
  });
  await assert.rejects(h.run(), /deployment timeout/);
  assert.ok(!h.logs.some(message => message.includes('production matches')));
});
