import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const pagesOrigin = 'https://iyf-5l7.pages.dev';
const productionOrigins = [pagesOrigin, 'https://iyf.hackx64.eu.org'];
const TRANSPORT_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function requestFailure(error, signal) {
  if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'request timed out';
  const code = error?.cause?.code ?? error?.code;
  return `request failed${TRANSPORT_ERROR_CODES.has(code) ? ` (${code})` : ''}`;
}

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
  const read = file => readFileSync(resolve(outputRoot, file));
  const index = read('index.html').toString('utf8');
  const assetUrls = new Map([...index.matchAll(/(?:href|src)="((css\/style|js\/app)\.([a-f0-9]{12})\.(css|js))"/g)]
    .map(m => [`${m[2]}.${m[4]}`, `/${m[1]}`]));
  if (assetUrls.size !== 2) throw new Error('Validated artifact is missing versioned CSS/JS URLs');
  for (const [file, path] of assetUrls) {
    if (!['css/style.css', 'js/app.js'].includes(file) ||
      !path.includes(`.${hash(read(path.slice(1))).slice(0, 12)}.`)) {
      throw new Error('Validated artifact asset filename does not match its contents');
    }
  }
  const expected = [
    ['index.html', ['text/html']],
    ['css/style.css', ['text/css']],
    ['js/app.js', ['text/javascript', 'application/javascript']],
    ['data/shows.json', ['application/json']],
    ['robots.txt', ['text/plain']],
    ['404.html', ['text/html']],
  ].map(([file, contentTypes]) => ({
    file, contentTypes, digest: hash(read(assetUrls.get(file)?.slice(1) || file)),
    path: file === 'index.html' ? '/' : file === '404.html' ? '/__deployment_404_check__' : assetUrls.get(file) || `/${file}`,
    status: file === '404.html' ? 404 : 200,
  }));
  const lastUpdated = JSON.parse(read('data/shows.json').toString('utf8')).lastUpdated;
  let trigger;
  try { trigger = await fetchImpl(hook, { method: 'POST', signal: AbortSignal.timeout(25_000) }); }
  catch { throw new Error('Cloudflare deployment trigger could not be reached'); }
  if (!trigger.ok) throw new Error(`Cloudflare deployment trigger returned HTTP ${trigger.status}`);
  const result = await trigger.json().catch(() => null);
  if (result?.success === false) throw new Error('Cloudflare rejected the deployment trigger');
  log('Cloudflare build requested; waiting for the published files to match the validated artifact.');

  const deadline = now() + timeoutMs;
  let lastFailures = ['verification deadline expired before a complete polling round'];
  let previousFailureSummary = '';
  while (now() < deadline) {
    const readyOrigins = new Set();
    const check = async (origin, item) => {
      const label = `${origin} ${item.file}`;
      let signal;
      try {
        const remaining = deadline - now();
        if (remaining <= 0) return `${label}: verification deadline expired`;
        signal = AbortSignal.timeout(Math.min(25_000, Math.ceil(remaining)));
        const response = await fetchImpl(`${origin}${item.path}`, { signal, cache: 'no-store' });
        if (response.status !== item.status) return `${label}: HTTP ${response.status} (expected ${item.status})`;
        const digest = hash(Buffer.from(await response.arrayBuffer()));
        if (digest !== item.digest) return `${label}: content hash mismatch (expected ${item.digest.slice(0, 12)}, received ${digest.slice(0, 12)})`;
        if (item.file === 'index.html') readyOrigins.add(origin);
        const failedHeaders = [];
        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (!item.contentTypes.includes(contentType)) failedHeaders.push('content-type');
        if (item.file === 'index.html') {
          if (response.headers.get('x-content-type-options') !== 'nosniff') failedHeaders.push('x-content-type-options');
          if (response.headers.get('x-frame-options') !== 'DENY') failedHeaders.push('x-frame-options');
          if (!response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")) failedHeaders.push('content-security-policy');
        }
        if (['index.html', 'data/shows.json'].includes(item.file)
          && !response.headers.get('cache-control')?.includes('no-cache')) failedHeaders.push('cache-control');
        if (['css/style.css', 'js/app.js'].includes(item.file)) {
          const directives = (response.headers.get('cache-control') || '').toLowerCase().split(',').map(value => value.trim());
          const maxAges = directives.map(value => value.match(/^max-age\s*=\s*(\d+)$/u)).filter(Boolean);
          if (!directives.includes('public') || !directives.includes('immutable') ||
            maxAges.length !== 1 || Number(maxAges[0][1]) < 31536000 ||
            directives.some(value => /^(?:no-cache|no-store|private)(?:\s*=|$)/u.test(value))) {
            failedHeaders.push('cache-control');
          }
        }
        return failedHeaders.length ? `${label}: missing or invalid headers (${failedHeaders.join(', ')})` : null;
      } catch (error) { return `${label}: ${requestFailure(error, signal)}`; }
    };
    // 先确认两个域名的首页都已切到本次版本，避免在旧部署上提前请求未来的资源地址。
    const homepage = expected.find(item => item.file === 'index.html');
    const homeChecks = await Promise.all(productionOrigins.map(origin => check(origin, homepage)));
    const checks = readyOrigins.size !== productionOrigins.length ? homeChecks : [
      ...homeChecks,
      ...await Promise.all(productionOrigins.flatMap(origin => expected.filter(item => item !== homepage).map(item => check(origin, item)))),
    ];
    lastFailures = checks.filter(Boolean);
    if (now() >= deadline) {
      if (!lastFailures.length) lastFailures = ['matching files arrived after the verification deadline'];
      break;
    }
    if (!lastFailures.length) {
      log(`Cloudflare production matches the validated artifact (lastUpdated: ${lastUpdated}).`);
      return { lastUpdated, files: expected.length, origin: pagesOrigin, verifiedOrigins: [...productionOrigins] };
    }
    // 仅记录受控状态、摘要和头名称；正文、头值与原始异常可能包含凭据。
    const summary = lastFailures.join('; ');
    if (summary !== previousFailureSummary) {
      log(`Cloudflare verification pending: ${summary}`);
      previousFailureSummary = summary;
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Cloudflare production did not match the validated artifact before the deployment timeout (${productionOrigins.join(', ')}). Last verification differences: ${lastFailures.join('; ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployCloudflare({ hookUrl: process.env.CLOUDFLARE_DEPLOY_HOOK }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
