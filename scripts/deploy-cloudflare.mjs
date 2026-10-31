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

// HTTP 列表里的 quoted-string 可含逗号和转义引号，扩展参数不能伪造其他指令。
function splitHeaderList(value) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') { parts.push(value.slice(start, index)); start = index + 1; }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
}

// RFC 9111 §5.2：名字大小写不敏感；bare no-cache 才要求整份响应重新验证。
// https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2
function parseCacheControl(value) {
  const parts = splitHeaderList(value || '');
  if (!parts) return null;
  const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
  const trim = text => text.replace(/^[\t ]+|[\t ]+$/gu, '');
  const directives = [];
  for (const part of parts) {
    const text = trim(part);
    if (!text) continue;
    const separator = text.indexOf('=');
    const name = trim(separator < 0 ? text : text.slice(0, separator));
    if (!token.test(name)) return null;
    let argument = separator < 0 ? null : trim(text.slice(separator + 1));
    if (argument !== null && !token.test(argument)) {
      if (!/^"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"$/u.test(argument)) return null;
      argument = argument.slice(1, -1).replace(/\\(.)/gu, '$1');
    }
    directives.push({ name: name.toLowerCase(), argument });
  }
  return directives;
}

function preventsFraming(value) {
  // CSP 的逗号总是分隔策略（引号也不例外）；每个策略只认首条同名指令。
  // 首条值含非 ASCII 时也占用名称，不能跳过后再采信重复指令。
  // https://www.w3.org/TR/CSP3/#parse-serialized-policy
  return (value || '').split(',').some(policy => {
    for (const part of policy.split(';')) {
      const tokens = part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '').split(/[\t\n\f\r ]+/u);
      if (tokens[0].toLowerCase() === 'frame-ancestors') {
        return tokens.length === 2 && tokens[1].toLowerCase() === "'none'";
      }
    }
    return false;
  }) || false;
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
        const contentType = response.headers.get('content-type')?.split(';', 1)[0].replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '').toLowerCase();
        const cacheDirectives = parseCacheControl(response.headers.get('cache-control'));
        if (!item.contentTypes.includes(contentType)) failedHeaders.push('content-type');
        if (item.file === 'index.html') {
          if (response.headers.get('x-content-type-options') !== 'nosniff') failedHeaders.push('x-content-type-options');
          if (response.headers.get('x-frame-options') !== 'DENY') failedHeaders.push('x-frame-options');
          if (!preventsFraming(response.headers.get('content-security-policy'))) failedHeaders.push('content-security-policy');
        }
        if (['index.html', 'data/shows.json'].includes(item.file)
          && !cacheDirectives?.some(directive => directive.name === 'no-cache' && directive.argument === null)) failedHeaders.push('cache-control');
        if (['css/style.css', 'js/app.js'].includes(item.file)) {
          const bare = name => cacheDirectives?.some(directive => directive.name === name && directive.argument === null);
          const maxAges = cacheDirectives?.filter(directive => directive.name === 'max-age') || [];
          if (!bare('public') || !bare('immutable') || maxAges.length !== 1 ||
            !/^\d+$/u.test(maxAges[0].argument || '') || Number(maxAges[0].argument) < 31536000 ||
            cacheDirectives?.some(directive => ['no-cache', 'no-store', 'private'].includes(directive.name))) {
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
