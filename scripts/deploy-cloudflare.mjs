import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const pagesOrigin = 'https://iyf-5l7.pages.dev';
const productionOrigins = [pagesOrigin, 'https://iyf.hackx64.eu.org'];

function validateHook(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('CLOUDFLARE_DEPLOY_HOOK is missing or invalid'); }
  if (url.origin !== 'https://api.cloudflare.com' || url.username || url.password || url.search || url.hash
    || !/^\/client\/v4\/pages\/webhooks\/deploy_hooks\/[\w-]+$/.test(url.pathname)) {
    throw new Error('CLOUDFLARE_DEPLOY_HOOK must be a Cloudflare Pages deploy hook');
  }
  return url.href;
}

export async function deployCloudflare({
  hookUrl, outputRoot = 'site', fetchImpl = fetch,
  delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)),
  now = Date.now, timeoutMs = 600_000, pollIntervalMs = 10_000, log = console.log,
} = {}) {
  const hook = validateHook(hookUrl);
  const read = file => readFileSync(resolve(outputRoot, file), 'utf8');
  const index = read('index.html');
  const assetUrls = new Map([...index.matchAll(/(?:href|src)="((css\/style\.css|js\/app\.js)\?v=[a-f0-9]+)"/g)].map(m => [m[2], `/${m[1]}`]));
  if (assetUrls.size !== 2) throw new Error('Validated artifact is missing versioned CSS/JS URLs');
  const expected = ['index.html', 'css/style.css', 'js/app.js', 'data/shows.json', 'robots.txt', '404.html'].map(file => ({
    file, digest: hash(read(file)),
    path: file === 'index.html' ? '/' : file === '404.html' ? '/__deployment_404_check__' : assetUrls.get(file) || `/${file}`,
    status: file === '404.html' ? 404 : 200,
  }));
  const lastUpdated = JSON.parse(read('data/shows.json')).lastUpdated;
  let trigger;
  try { trigger = await fetchImpl(hook, { method: 'POST', signal: AbortSignal.timeout(25_000) }); }
  catch { throw new Error('Cloudflare deployment trigger could not be reached'); }
  if (!trigger.ok) throw new Error(`Cloudflare deployment trigger returned HTTP ${trigger.status}`);
  const result = await trigger.json().catch(() => null);
  if (result?.success === false) throw new Error('Cloudflare rejected the deployment trigger');
  log('Cloudflare build requested; waiting for the published files to match the validated artifact.');

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const matches = await Promise.all(productionOrigins.flatMap(origin => expected.map(async item => {
      try {
        const remaining = deadline - now();
        if (remaining <= 0) return false;
        const response = await fetchImpl(`${origin}${item.path}`, { signal: AbortSignal.timeout(Math.min(25_000, Math.ceil(remaining))), cache: 'no-store' });
        if (response.status !== item.status || hash(await response.text()) !== item.digest) return false;
        if (item.file === 'index.html') {
          if (response.headers.get('x-content-type-options') !== 'nosniff'
            || response.headers.get('x-frame-options') !== 'DENY'
            || !response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")) return false;
        }
        if (['index.html', 'data/shows.json'].includes(item.file)
          && !response.headers.get('cache-control')?.includes('no-cache')) return false;
        return true;
      } catch { return false; }
    })));
    if (now() >= deadline) break;
    if (matches.every(Boolean)) {
      log(`Cloudflare production matches the validated artifact (lastUpdated: ${lastUpdated}).`);
      return { lastUpdated, files: expected.length, origin: pagesOrigin, verifiedOrigins: [...productionOrigins] };
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Cloudflare production did not match the validated artifact before the deployment timeout (${productionOrigins.join(', ')})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployCloudflare({ hookUrl: process.env.CLOUDFLARE_DEPLOY_HOOK }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
