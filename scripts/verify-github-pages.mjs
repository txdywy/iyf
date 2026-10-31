import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://txdywy.github.io/iyf/';
const hash = value => createHash('sha256').update(value).digest('hex');

export async function verifyGitHubPages({
  outputRoot = 'site', fetchImpl = fetch,
  delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)),
  now = Date.now, timeoutMs = 300_000, pollIntervalMs = 10_000, log = console.log,
} = {}) {
  const read = file => readFileSync(resolve(outputRoot, file));
  const index = read('index.html').toString('utf8');
  const assetPaths = new Map([...index.matchAll(/(?:href|src)="((css\/style|js\/app)\.([a-f0-9]{12})\.(css|js))"/gu)]
    .map(match => [`${match[2]}.${match[4]}`, match[1]]));
  if (assetPaths.size !== 2) throw new Error('Validated artifact is missing versioned CSS/JS URLs');
  for (const [file, path] of assetPaths) {
    if (!['css/style.css', 'js/app.js'].includes(file) || !path.includes(`.${hash(read(path)).slice(0, 12)}.`)) {
      throw new Error('Validated artifact asset filename does not match its contents');
    }
  }
  const items = [
    // 显式 index 地址不受 GitHub CDN 对旧目录 301 的缓存影响。
    ['index.html', 'index.html', 200, ['text/html']],
    ['css/style.css', assetPaths.get('css/style.css'), 200, ['text/css']],
    ['js/app.js', assetPaths.get('js/app.js'), 200, ['text/javascript', 'application/javascript']],
    ['data/shows.json', 'data/shows.json', 200, ['application/json']],
    ['robots.txt', 'robots.txt', 200, ['text/plain']],
    ['404.html', '404.html', 200, ['text/html']],
    // 检查真实深层缺失路径也返回本站的 404，避免误落到账号级错误页。
    ['missing route', '__deployment_404_check__/nested', 404, ['text/html']],
  ].map(([file, path, status, contentTypes]) => ({
    file, path, status, contentTypes, digest: hash(read(file === 'missing route' ? '404.html' : assetPaths.get(file) || file)),
  }));
  const lastUpdated = JSON.parse(read('data/shows.json').toString('utf8')).lastUpdated;
  const deadline = now() + timeoutMs;
  let lastFailures = ['verification deadline expired before a complete polling round'];
  let previousSummary = '';
  while (now() < deadline) {
    const check = async item => {
      const label = `${item.file}`;
      let signal;
      try {
        const remaining = deadline - now();
        if (remaining <= 0) return `${label}: verification deadline expired`;
        signal = AbortSignal.timeout(Math.min(25_000, Math.ceil(remaining)));
        const response = await fetchImpl(new URL(item.path, BASE_URL).href, { signal, cache: 'no-store', redirect: 'manual' });
        if (response.status !== item.status) {
          await response.body?.cancel?.().catch(() => {});
          return `${label}: HTTP ${response.status} (expected ${item.status})`;
        }
        const type = response.headers.get('content-type')?.split(';', 1)[0].replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '').toLowerCase();
        if (!item.contentTypes.includes(type)) {
          await response.body?.cancel?.().catch(() => {});
          return `${label}: invalid content-type`;
        }
        const actual = hash(Buffer.from(await response.arrayBuffer()));
        if (actual !== item.digest) return `${label}: content hash mismatch (expected ${item.digest.slice(0, 12)}, received ${actual.slice(0, 12)})`;
        return null;
      } catch (error) {
        return `${label}: ${signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'request timed out' : 'request failed'}`;
      }
    };
    const failures = (await Promise.all(items.map(check))).filter(Boolean);
    if (now() >= deadline) { lastFailures = ['verification deadline expired']; break; }
    if (!failures.length) {
      log(`GitHub Pages backup matches the validated artifact (lastUpdated: ${lastUpdated}).`);
      return { lastUpdated, files: 6, url: new URL('index.html', BASE_URL).href };
    }
    lastFailures = failures;
    const summary = failures.join('; ');
    if (summary !== previousSummary) log(`GitHub Pages verification pending: ${summary}`);
    previousSummary = summary;
    const remaining = deadline - now();
    if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining));
  }
  throw new Error(`GitHub Pages backup did not match the validated artifact before the verification deadline. Last differences: ${lastFailures.join('; ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyGitHubPages().catch(error => { console.error(error.message); process.exitCode = 1; });
}
