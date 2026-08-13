import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');

const app = read('js/app.js');
const scrape = read('scripts/scrape.mjs');
const workflow = read('.github/workflows/scrape-and-deploy.yml');
const index = read('index.html');
const css = read('css/style.css');

function fixedDate(year) {
  return class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [`${year}-01-01T00:00:00Z`]));
    }
    static now() {
      return new Date(`${year}-01-01T00:00:00Z`).getTime();
    }
  };
}

function instantSetTimeout(fn) {
  fn();
  return 0;
}

function loadScrapeHelpers({ env = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); }, dateImpl = Date, initialFiles = {} } = {}) {
  const writes = new Map(Object.entries(initialFiles).map(([path, content]) => [String(path), String(content)]));
  const context = {
    console: { log() {}, warn() {}, error() {} },
    process: { env },
    fetch: fetchImpl,
    URL,
    AbortController,
    setTimeout: instantSetTimeout,
    clearTimeout() {},
    Date: dateImpl,
    Math,
    JSON,
    Promise,
    writeFileSync: (path, content) => writes.set(String(path), content),
    readFileSync: path => {
      const content = writes.get(String(path));
      if (content == null) throw new Error(`missing test file: ${path}`);
      return content;
    },
    existsSync: path => writes.has(String(path)),
    mkdirSync() {},
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirname: path => path.replace(/\/[^/]*$/, '') || '/',
    fileURLToPath: value => value,
  };

  const executable = scrape
    .replace(/^import .*$/gm, '')
    .replace(/const __dirname = dirname\(fileURLToPath\(import\.meta\.url\)\);/, "const __dirname = '/tmp/iyf-test/scripts';")
    .replace(/const run = process\.argv\.includes\('--recalculate-existing'\)[\s\S]*$/m, '') + `
      globalThis.__helpers = {
        normalizeItem,
        boundedScore,
        boundedPlayCount,
        boundedYear,
        parseUpdateStatus,
        reconcileShowStatus,
        mergeLiveSnapshots,
        findLiveTitleMatch,
        applyLiveFields,
        scoreYfspCandidate,
        searchYfspTitle,
        verifyYfspUrl,
        hasFreshYfspLookup,
        markYfspLookup,
        calculateYfspHotness,
        applyYfspHotness,
        scoreKDrama,
        scoreVariety,
        passesKDramaDiscoveryThreshold,
        aiScoreInputHash,
        AI_SCORE_CACHE_VERSION,
        aiScoreShows,
        aiEvaluateDiscovery,
        isRenderableShow,
        dedupByTitle,
        titleMatches,
        restorePreviousCategory,
        mergePreviousShowState,
        loadPreviousShows,
        findReusableTMDBCache,
        normalizeOutputShow,
        repairKnownIdentityCorruption,
        assertOutputContinuity,
        SEED_KDRAMAS,
        enrichCoversFromTMDB,
        applyYfspSearchFields,
        searchDoubanSubject,
      };
    `;

  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return { helpers: context.__helpers, writes };
}

function loadAppHelpers({
  dateImpl = Date,
  documentImpl,
  fetchImpl = async () => { throw new Error('unexpected fetch'); },
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const context = {
    console,
    Date: dateImpl,
    URL,
    AbortController,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval,
    clearInterval,
    history: { replaceState() {} },
    location: { hash: '', slice(n) { return this.hash.slice(n); } },
    document: documentImpl || {
      addEventListener() {},
      querySelectorAll: () => [],
      getElementById: () => ({
        style: {},
        classList: { toggle() {} },
        setAttribute() {},
        addEventListener() {},
        value: '',
        textContent: '0',
        innerHTML: '',
      }),
    },
  };
  const executable = app.replace(/\}\)\(\);\s*$/m, `
    globalThis.__helpers = {
      renderCardActions,
      renderCard,
      renderTraktCard,
      renderMDLCard,
      escapeHtml,
      safeExternalUrl,
      switchTab,
      setAllData: value => { allData = value; },
      getCurrentShows: () => currentShows,
    };
  })();`);
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return context.__helpers;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDomElement({ id = '', value = '', textContent = '', dataset = {} } = {}) {
  const attributes = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    value,
    textContent,
    dataset,
    style: {},
    innerHTML: '',
    tabIndex: -1,
    classList: {
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    focus() {},
  };
}

function createAppDocument() {
  const elements = {
    showGrid: createDomElement({ id: 'showGrid' }),
    loading: createDomElement({ id: 'loading' }),
    empty: createDomElement({ id: 'empty' }),
    updateInfo: createDomElement({ id: 'updateInfo' }),
    sortBy: createDomElement({ id: 'sortBy', value: 'recommend' }),
    filterStatus: createDomElement({ id: 'filterStatus', value: 'all' }),
    filterScore: createDomElement({ id: 'filterScore', value: '0' }),
    searchInput: createDomElement({ id: 'searchInput', value: '' }),
  };
  const tabNames = ['korean', 'year2026', 'variety2026', 'variety', 'new', 'classic', 'tvmaze', 'trakt', 'mdl'];
  const tabs = tabNames.map(name => createDomElement({ id: `tab-${name}`, dataset: { tab: name } }));
  return {
    elements,
    document: {
      addEventListener() {},
      querySelectorAll: selector => selector === '.tab' ? tabs : [],
      getElementById: id => elements[id] || tabs.find(tab => tab.id === id) || null,
      createElement: () => createDomElement(),
    },
  };
}

function abortedFetch(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function aiFetchWithContent(content, counter = { count: 0 }) {
  return async () => {
    counter.count++;
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

function mockResponse({ status = 200, text = '', json = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    text: async () => text,
    json: async () => json,
  };
}

// ── Frontend behavior regressions ──────────────────────────
{
  const { renderCardActions, renderCard, renderTraktCard, renderMDLCard, safeExternalUrl } = loadAppHelpers();
  const yfspOnly = renderCardActions({
    primaryUrl: 'https://www.yfsp.tv/play/rkNc61MMTE0',
    primaryUrlSource: 'yfsp',
    yfspUrl: 'https://www.yfsp.tv/play/rkNc61MMTE0',
  });
  assert.match(yfspOnly, /href="https:\/\/www\.yfsp\.tv\/play\/rkNc61MMTE0"/, 'YFSP-only cards should render an actionable primary link');
  assert.doesNotMatch(yfspOnly, /待匹配链接/, 'YFSP-only cards should not render the disabled fallback');

  const metadataAndYfsp = renderCardActions({
    tmdbUrl: 'https://www.themoviedb.org/tv/1',
    doubanUrl: 'https://movie.douban.com/subject/1/',
    yfspUrl: 'https://www.yfsp.tv/play/live',
  });
  assert.match(metadataAndYfsp, /TMDB资料/, 'metadata links should still render when present');
  assert.match(metadataAndYfsp, /href="https:\/\/www\.yfsp\.tv\/play\/live"/, 'cards with metadata should also expose the playable YFSP link');
  assert.match(metadataAndYfsp, /观看\/详情/, 'YFSP action should keep the watch/detail label');

  const metadataNoYfsp = renderCardActions({
    tmdbUrl: 'https://www.themoviedb.org/tv/1',
    doubanUrl: 'https://movie.douban.com/subject/1/',
    yfspUrl: '',
  });
  assert.match(metadataNoYfsp, /TMDB资料/, 'cards with metadata but no YFSP should still show metadata links');
  assert.match(metadataNoYfsp, /暂无观看链接/, 'cards with metadata but no YFSP should show a disabled watch hint');
  assert.doesNotMatch(metadataNoYfsp, /待匹配链接/, 'cards with metadata should not show the generic fallback');

  const unsafeActions = renderCardActions({
    primaryUrl: 'javascript:alert(1)',
    primaryUrlSource: 'yfsp',
    yfspUrl: 'data:text/html,<script>alert(1)</script>',
    tmdbUrl: 'ftp://example.com/not-web',
  });
  assert.doesNotMatch(unsafeActions, /javascript:|data:|ftp:/, 'non-http external URLs should not render into card actions');
  assert.match(unsafeActions, /待匹配链接/, 'unsafe-only cards should fall back to the disabled action');
  assert.equal(safeExternalUrl(' https://example.com/path '), 'https://example.com/path', 'safe URL helper should trim valid web URLs');
  assert.equal(safeExternalUrl('javascript:alert(1)'), '', 'safe URL helper should reject javascript URLs');
  assert.equal(safeExternalUrl('https://evil.com/"onload=alert(1)'), '', 'safe URL helper should reject URLs containing quotes');
  assert.equal(safeExternalUrl("https://evil.com/'onload=alert(1)"), '', 'safe URL helper should reject URLs containing single quotes');
  assert.equal(safeExternalUrl('https://evil.com/<script>'), '', 'safe URL helper should reject URLs containing angle brackets');

  const zeroBadge = renderCard({ title: '零分测试', aiScore: 0, score: 0, coverImg: '', recommendScore: 0 }, 0);
  assert.match(zeroBadge, /🤖 0\/100/, 'AI score badge should render valid score 0');
  const unsafeCover = renderCard({ title: '坏图测试', coverImg: 'javascript:alert(1)', score: 0, recommendScore: 0 }, 0);
  assert.doesNotMatch(unsafeCover, /src="javascript:/, 'non-http cover URLs should render a placeholder instead of an image');
  assert.doesNotMatch(
    renderTraktCard({ title: '恶意 Trakt', traktUrl: 'https://evil.example/phish', tmdbId: 'bad', watchers: 'NaN' }, 0),
    /evil\.example|themoviedb\.org\/tv\/bad/u,
    'Trakt renderer should reject off-domain links and malformed numeric IDs'
  );
  assert.doesNotMatch(
    renderMDLCard({ title: '恶意 MDL', mdlUrl: 'data:text/html,bad', mdlRating: 'bad', watchers: {}, episodes: [] }, 0),
    /data:text\/html|NaN/u,
    'MDL renderer should tolerate malformed snapshot fields without unsafe output'
  );

  const staleYearHelpers = loadAppHelpers({ dateImpl: fixedDate(2027) });
  staleYearHelpers.setAllData({
    lastUpdated: '2026-12-31T23:30:00Z',
    stats: { koreanDramas: 2, chineseVariety: 0 },
    koreanDramas: [
      { title: '快照内新剧', year: 2026 },
      { title: '旧剧', year: 2025 },
    ],
    chineseVariety: [],
  });
  staleYearHelpers.switchTab('year2026');
  assert.deepEqual(
    staleYearHelpers.getCurrentShows().map(s => s.title),
    ['快照内新剧'],
    'current-year tab should follow the dataset year instead of a newer client clock'
  );

  const previewHelpers = loadAppHelpers({ dateImpl: fixedDate(2026) });
  previewHelpers.setAllData({
    lastUpdated: '2026-08-13T00:00:00Z', stats: {}, chineseVariety: [],
    koreanDramas: [{ title: '当年剧', year: 2026 }, { title: '明年预告', year: 2027 }],
  });
  previewHelpers.switchTab('year2026');
  assert.deepEqual(previewHelpers.getCurrentShows().map(s => s.title), ['当年剧'], 'a future preview must not hijack the current-year tab');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setAllData({
    lastUpdated: '2026-08-13T00:00:00Z', stats: {}, chineseVariety: [],
    koreanDramas: [
      { id: 'older', title: '较早更新', year: 2026, publishTime: '2026-01-01', coverImg: '', primaryUrl: '' },
      { id: 'newer', title: '最新更新', year: 2026, publishTime: '2026-08-01', coverImg: '', primaryUrl: '' },
    ],
  });
  helpers.switchTab('new');
  assert.equal(elements.sortBy.value, 'newest', 'latest tab should select newest sorting by default');
  assert.ok(elements.showGrid.innerHTML.indexOf('最新更新') < elements.showGrid.innerHTML.indexOf('较早更新'), 'latest tab should render newest publish time first');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({
    documentImpl: document,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'data/trakt_shows.json', 'Trakt tab should request its local snapshot');
      return abortedFetch(options?.signal);
    },
  });
  helpers.setAllData({
    lastUpdated: '2026-08-11T00:00:00Z',
    stats: { koreanDramas: 1, chineseVariety: 0 },
    koreanDramas: [{ id: 'main-1', title: '主列表节目', year: 2026, coverImg: '', primaryUrl: '' }],
    chineseVariety: [],
  });
  helpers.switchTab('korean');
  const pendingTrakt = helpers.switchTab('trakt');
  helpers.switchTab('korean');
  await pendingTrakt;
  assert.match(elements.showGrid.innerHTML, /主列表节目/, 'a cancelled remote response must not overwrite the active local tab');
  assert.doesNotMatch(elements.showGrid.innerHTML, /source-trakt/, 'cancelled Trakt content must stay out of the grid');
  assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false', 'switching away should clear the remote loading state');
  assert.equal(elements.loading.style.display, 'none', 'switching away should hide the remote spinner');
}

{
  const { document, elements } = createAppDocument();
  let fetchCount = 0;
  const helpers = loadAppHelpers({
    documentImpl: document,
    fetchImpl: async url => {
      fetchCount++;
      assert.equal(url, 'data/trakt_shows.json');
      return {
        ok: true,
        json: async () => ({
          lastUpdated: '2026-06-25T00:00:00Z',
          shows: [{ title: '快照节目', year: 2026, status: 'ended', watchers: 10 }],
        }),
      };
    },
  });
  helpers.setAllData({
    lastUpdated: '2026-08-11T00:00:00Z',
    stats: { koreanDramas: 0, chineseVariety: 0 },
    koreanDramas: [],
    chineseVariety: [],
  });
  await helpers.switchTab('trakt');
  assert.match(elements.showGrid.innerHTML, /快照节目/, 'Trakt snapshot rows should render after a valid response');
  assert.match(elements.updateInfo.textContent, /数据较旧/, 'old snapshot data should be clearly labeled stale');
  assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false', 'successful remote rendering should clear aria-busy');
  helpers.switchTab('korean');
  await helpers.switchTab('trakt');
  assert.equal(fetchCount, 1, 'revisiting Trakt within the cache TTL should reuse the validated snapshot');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({
    documentImpl: document,
    fetchImpl: async (url, options) => abortedFetch(options?.signal),
    setTimeoutImpl: (fn, delay) => setTimeout(fn, delay === 12000 ? 0 : delay),
  });
  helpers.setAllData({
    lastUpdated: '2026-08-11T00:00:00Z',
    stats: { koreanDramas: 0, chineseVariety: 0 },
    koreanDramas: [],
    chineseVariety: [],
  });
  await helpers.switchTab('trakt');
  assert.match(elements.empty.innerHTML, /请求超时/, 'an active remote timeout should show a retryable timeout message');
  assert.equal(elements.empty.style.display, 'block', 'an active remote timeout should reveal the error state');
  assert.equal(elements.loading.style.display, 'none', 'an active remote timeout should not leave the spinner running');
  assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false', 'an active remote timeout should clear aria-busy');
}

// ── Scraper status parsing and matching regressions ──────────────────────────
{
  const { helpers } = loadScrapeHelpers();
  assert.deepEqual(plain(helpers.parseUpdateStatus('16集全')), { totalEpisodes: 16, currentEpisode: 16, isComplete: true });
  assert.deepEqual(plain(helpers.parseUpdateStatus('20170707集全')), { totalEpisodes: 0, currentEpisode: 0, isComplete: true }, 'date-like 集全 values should not become episode counts');
  assert.equal(helpers.parseUpdateStatus('20220825(下班了编剧部)集全').isComplete, true, 'parenthesized 集全 values should count as complete');
  assert.equal(helpers.parseUpdateStatus('颁奖典礼集全').isComplete, true, 'non-numeric 集全 values should count as complete');
  assert.equal(helpers.parseUpdateStatus('未完结').isComplete, false, 'negative completion statuses should not be marked complete');
  assert.equal(helpers.parseUpdateStatus('12').currentEpisode, 12, 'bare episode numbers should parse as the current episode');
  assert.equal(helpers.parseUpdateStatus('更新到20260809').currentEpisode, 0, 'date-like update markers should not become episode numbers');

  const liveShows = new Map([
    ['old-running-man', { id: 'old-running-man', title: '奔跑吧', mediaType: '综艺', regional: '大陆', year: 2025, publishTime: '2025-01-01T00:00:00', score: 9.0 }],
  ]);
  const match = helpers.findLiveTitleMatch({ title: '奔跑吧', year: 2026, isSerial: true }, liveShows, '综艺', show => ['大陆', '韩国'].includes(show.regional));
  assert.equal(match, null, 'current-year variety seeds should not attach old-season live pages');

  const { helpers: rolloverHelpers } = loadScrapeHelpers({ dateImpl: fixedDate(2027) });
  const rolloverMatch = rolloverHelpers.findLiveTitleMatch({ title: '奔跑吧', year: 2026, isSerial: true }, liveShows, '综艺', show => ['大陆', '韩国'].includes(show.regional));
  assert.equal(rolloverMatch, null, 'dated variety seeds should not attach older live pages after a year rollover');

  const longRunningShows = new Map([
    ['hello-saturday', { id: 'hello-saturday', title: '你好星期六', mediaType: '综艺', regional: '大陆', year: 2022, publishTime: '2022-01-01T00:00:00', updateStatus: '20260524(特别企划)', score: 8.0 }],
  ]);
  const longRunningMatch = helpers.findLiveTitleMatch({ title: '你好星期六', year: 2026, mediaType: '综艺', isSerial: true }, longRunningShows, '综艺', show => show.regional === '大陆');
  assert.equal(longRunningMatch?.id, 'hello-saturday', 'long-running variety pages updated in the seed year should remain year-compatible');

  assert.equal(
    helpers.scoreYfspCandidate(
      { title: '奔跑吧', year: 2026, mediaType: '综艺', regional: '大陆' },
      { title: '奔跑吧第十二季', postTime: '2024', atypeName: '综艺', regional: '大陆', hot: 900000, isIndex: true }
    ),
    -1,
    'YFSP search candidates from incompatible older seasons should be rejected'
  );

  assert.notEqual(
    helpers.scoreYfspCandidate(
      { title: '你好星期六', year: 2026, mediaType: '综艺', regional: '大陆' },
      { title: '你好星期六', postTime: '2022', lastName: '20260524(特别企划)', atypeName: '综艺', regional: '大陆', hot: 900000, isIndex: true }
    ),
    -1,
    'YFSP search should keep long-running variety pages whose update status references the seed year'
  );

  assert.equal(
    helpers.scoreYfspCandidate(
      { title: '奔跑吧', year: 2026, mediaType: '综艺', regional: '大陆' },
      { title: '奔跑吧', postTime: '2026', lastName: '20170707集全', atypeName: '综艺', regional: '大陆', hot: 900000, isIndex: true }
    ),
    -1,
    'YFSP search should reject stale variety pages with old dated completion status even when publish year is current'
  );
  assert.equal(
    helpers.scoreYfspCandidate(
      { title: '信号', year: 2016, mediaType: '电视剧', regional: '韩国' },
      { title: '信号', postTime: '2016', atypeName: '电影', regional: '大陆', hot: 999999 }
    ),
    -1,
    'same-title candidates with a different media type or region must be rejected'
  );
}

// ── Durable catalog and identity regressions ──────────────────────────
{
  const { helpers } = loadScrapeHelpers();
  const now = Date.parse('2026-08-05T00:00:00Z');
  const recentHot = helpers.calculateYfspHotness({
    playCount: 100000,
    publishTime: '2026-08-01T00:00:00Z',
    year: 2026,
  }, now);
  const oldHot = helpers.calculateYfspHotness({
    playCount: 100000,
    publishTime: '2025-01-01T00:00:00Z',
    year: 2025,
  }, now);
  const yearFallbackHot = helpers.calculateYfspHotness({ playCount: 100000, year: 2026 }, now);
  assert.equal(recentHot.releaseDateSource, 'publishTime', 'exact YFSP publish time should be the release-time source');
  assert.equal(yearFallbackHot.releaseDateSource, 'year', 'year should be an explicit fallback release-time source');
  assert.ok(recentHot.hotnessScore > oldHot.hotnessScore, 'recent releases with the same plays should have higher hotness');
  assert.ok(recentHot.playsPerDay > oldHot.playsPerDay, 'hotness should expose the release-time-adjusted daily play rate');
  assert.ok(recentHot.hotnessScore > yearFallbackHot.hotnessScore, 'year-only fallback should be discounted versus an exact recent publish time');

  const hotnessShow = { title: '普通剧情', year: 2026, score: 8, contentType: '剧情', playCount: 100000, publishTime: '2026-08-01T00:00:00Z' };
  const hotnessBefore = helpers.calculateYfspHotness(hotnessShow, now).hotnessScore;
  assert.equal(helpers.applyYfspHotness(hotnessShow, now), hotnessBefore, 'applying YFSP hotness should return the calculated score');
  assert.equal(hotnessShow.yfspHotness, hotnessBefore, 'YFSP hotness should be persisted on the show');
  assert.ok(hotnessShow.yfspPlayRate > 0 && hotnessShow.yfspAgeDays > 0, 'YFSP play rate and age should be persisted');
  assert.ok(
    helpers.scoreKDrama({ ...hotnessShow, playCount: 1000000 }, now) > helpers.scoreKDrama({ ...hotnessShow, playCount: 1000 }, now),
    'recommendation scoring should include the release-time-adjusted YFSP hotness'
  );
  const futureHotness = helpers.calculateYfspHotness({
    playCount: 1000000, publishTime: '2026-12-01', year: 2026,
  }, Date.parse('2026-08-13T00:00:00Z'));
  assert.equal(futureHotness.playsPerDay, 0, 'future premieres must not receive release velocity via a year fallback');

  const liveApplied = helpers.applyLiveFields(
    { title: '热度测试', score: 7, playCount: 100, publishTime: '' },
    { id: 'live-id', title: '热度测试', score: 8.5, playCount: 99999, publishTime: '2026-08-01T00:00:00Z', yfspUrl: 'https://www.yfsp.tv/play/live-id' }
  );
  assert.equal(liveApplied.playCount, 99999, 'live YFSP play count should replace a stale seed estimate');
  assert.equal(liveApplied.publishTime, '2026-08-01T00:00:00Z', 'live YFSP publish time should flow into seed-backed shows');

  const partial = helpers.normalizeItem({ mediaKey: 'partial', title: '种子更新', mediaType: '综艺', regional: '大陆' });
  const partialApplied = helpers.applyLiveFields({
    title: '种子更新', year: 2026, score: 7, playCount: 100,
    actor: '新演员', contentType: '搞笑', description: '新版种子描述足够长，应优先于上一版。', regional: '大陆', lang: '国语',
  }, partial);
  assert.equal(partialApplied.score, 7, 'a missing live score must preserve the curated seed score');
  assert.equal(partialApplied.playCount, 100, 'a missing live play count must preserve the curated seed count');
  const partialWithPrevious = helpers.mergePreviousShowState(partialApplied, {
    ...partialApplied, actor: '旧演员', description: '上一版描述很长但已经过期。',
  });
  assert.equal(partialWithPrevious.actor, '新演员', 'curated seed text should win over stale previous text');
  assert.equal(partialWithPrevious.description, '新版种子描述足够长，应优先于上一版。');

  const numericFallback = helpers.normalizeItem({
    mediaKey: 'numeric-fallback', title: '数值回退', mediaType: '综艺', playCount: 'bad', hot: 12345,
  });
  assert.equal(numericFallback.playCount, 12345, 'malformed playCount should fall back to a valid hot field');
  const malformedNumericShape = helpers.normalizeItem({ mediaKey: 'numeric-shape', title: '类型错误', mediaType: '综艺', score: false, hot: [] });
  assert.equal(malformedNumericShape._sourceFields.has('score'), false, 'booleans and arrays are not numeric source fields');
  assert.equal(malformedNumericShape._sourceFields.has('playCount'), false, 'arrays are not numeric source fields');

  const page1 = helpers.normalizeItem({ mediaKey: 'duplicate-live', title: '重复节目', mediaType: '综艺', hot: 100, score: 7, updateStatus: '更新到01' });
  const page2 = helpers.normalizeItem({ mediaKey: 'duplicate-live', title: '重复节目', mediaType: '综艺', hot: 200, score: 8, updateStatus: '更新到02', actor: '更完整演员表' });
  const forward = helpers.mergeLiveSnapshots(page1, page2);
  const reverse = helpers.mergeLiveSnapshots(page2, page1);
  assert.deepEqual(plain(forward), plain(reverse), 'duplicate live-page merging should not depend on page order');
  assert.equal(forward.currentEpisode, 2);
  assert.equal(forward.playCount, 200);

  const explicitSerial = helpers.normalizeItem({ mediaKey: 'status-priority', title: '状态优先', mediaType: '电视剧', isSerial: true, hot: 10 });
  const descriptiveOnly = helpers.normalizeItem({ mediaKey: 'status-priority', title: '状态优先', mediaType: '电视剧', updateStatus: '每周六', hot: 100 });
  const statusMerged = helpers.mergeLiveSnapshots(descriptiveOnly, explicitSerial);
  assert.equal(statusMerged.isSerial, true, 'authoritative boolean status should beat descriptive-only text');
  assert.equal(statusMerged.isComplete, false);

  assert.equal(helpers.passesKDramaDiscoveryThreshold({ year: 2026, score: 1, playCount: 100 }), false, 'low-quality homepage discoveries must not bypass the discovery threshold');
  assert.equal(helpers.passesKDramaDiscoveryThreshold({ year: 2026, score: 8, playCount: 100 }), true, 'high-score homepage discoveries should pass the common threshold');

  const ongoingApplied = helpers.applyLiveFields(
    { title: '连载测试', totalEpisodes: 12, currentEpisode: 5, isComplete: false, isSerial: true },
    { id: 'ongoing-live', title: '连载测试', updateStatus: '更新到06' }
  );
  assert.equal(ongoingApplied.currentEpisode, 6, 'live status should advance the current episode');
  assert.equal(ongoingApplied.totalEpisodes, 12, 'a partial live status should preserve the known episode total');

  const completedDateApplied = helpers.applyLiveFields(
    { title: '日期状态测试', totalEpisodes: 20170707, currentEpisode: 20170707, isComplete: false, isSerial: true },
    { id: 'completed-live', title: '日期状态测试', updateStatus: '20170707集全' }
  );
  assert.deepEqual(
    plain({ totalEpisodes: completedDateApplied.totalEpisodes, currentEpisode: completedDateApplied.currentEpisode, isComplete: completedDateApplied.isComplete, isSerial: completedDateApplied.isSerial }),
    { totalEpisodes: 0, currentEpisode: 0, isComplete: true, isSerial: false },
    'date-like completion statuses should clear legacy YYYYMMDD episode pollution'
  );

  const nonNumericCompletion = helpers.applyLiveFields(
    { title: '非数字完结测试', totalEpisodes: 12, currentEpisode: 12, isComplete: false, isSerial: true },
    { id: 'non-numeric-complete', title: '非数字完结测试', updateStatus: '颁奖典礼集全' }
  );
  assert.deepEqual(
    plain({ totalEpisodes: nonNumericCompletion.totalEpisodes, currentEpisode: nonNumericCompletion.currentEpisode, isComplete: nonNumericCompletion.isComplete, isSerial: nonNumericCompletion.isSerial }),
    { totalEpisodes: 12, currentEpisode: 12, isComplete: true, isSerial: false },
    'non-numeric completion text should preserve reasonable known episode counts'
  );

  const freshSerial = helpers.normalizeItem({
    mediaKey: 'fresh-serial', title: '状态覆盖测试', mediaType: '电视剧', isSerial: true,
  });
  const reconciledSerial = helpers.reconcileShowStatus(helpers.mergePreviousShowState(freshSerial, {
    id: 'fresh-serial', title: '状态覆盖测试', mediaType: '电视剧', updateStatus: '16集全',
    totalEpisodes: 16, currentEpisode: 16, isComplete: true, isSerial: false,
  }));
  assert.equal(reconciledSerial.updateStatus, '', 'an explicit fresh serial flag should clear stale completion text');
  assert.equal(reconciledSerial.isSerial, true, 'an explicit fresh serial flag should survive normalize, merge and reconcile');
  assert.equal(reconciledSerial.isComplete, false, 'an explicit fresh serial flag should override a stale completed snapshot');

  const liveShows = new Map([
    ['RyHxZP9EKpL', {
      id: 'RyHxZP9EKpL',
      title: '菜鸟炊事兵',
      mediaType: '电视剧',
      regional: '韩国',
      year: 2026,
      score: 8.9,
    }],
  ]);
  const aliasMatch = helpers.findLiveTitleMatch(
    { title: '菜鸟伙房兵', mediaType: '电视剧', regional: '韩国', year: 2026, isSerial: true },
    liveShows,
    '电视剧',
    show => show.regional === '韩国'
  );
  assert.equal(aliasMatch?.id, 'RyHxZP9EKpL', '菜鸟伙房兵 should match the canonical 菜鸟炊事兵 entry');
  assert.equal(helpers.titleMatches('The Legend of Kitchen Soldier', '菜鸟炊事兵'), true, 'English and Chinese titles should share one identity');

  const seed = helpers.SEED_KDRAMAS.find(show => show.title === '菜鸟炊事兵');
  assert.ok(seed, 'strongly recommended discovered dramas should have a durable seed entry');
  assert.ok(seed.titleAliases?.includes('菜鸟伙房兵'), 'durable seed should preserve the user-facing title alias');
  const genericComedyScore = helpers.scoreKDrama({
    title: '普通喜剧', year: 2026, score: 8.9, playCount: 53208,
    contentType: '喜剧·奇幻', description: '改编自漫画的轻松故事。',
  });
  assert.ok(helpers.scoreKDrama(seed) > genericComedyScore, 'recommendation scoring should recognize the user-confirmed military/cooking growth angle');

  const cached = {
    title: '菜鸟炊事兵',
    url: 'https://image.tmdb.org/t/p/original/kitchen-soldier.jpg',
    source: 'tmdb',
    version: 14,
    tmdbId: 295509,
  };
  const recovered = helpers.findReusableTMDBCache(
    { RyHxZP9EKpL: cached },
    { id: 'seed_kd_2026_kitchen', title: '菜鸟伙房兵' }
  );
  assert.equal(recovered?.tmdbId, 295509, 'TMDB cache should survive a title alias and seed/live ID change');

  const cachePath = '/tmp/iyf-test/scripts/../data/image_cache.json';
  const { helpers: cacheHelpers } = loadScrapeHelpers({
    initialFiles: { [cachePath]: JSON.stringify({ RyHxZP9EKpL: cached }) },
  });
  const sourceLessSeed = {
    id: 'seed_kd_2026_kitchen',
    seedId: 'seed_kd_2026_kitchen',
    title: '菜鸟伙房兵',
    mediaType: '电视剧',
    regional: '韩国',
    coverImg: '',
  };
  await cacheHelpers.enrichCoversFromTMDB([sourceLessSeed]);
  assert.equal(sourceLessSeed.coverImg, cached.url, 'a source-less seed should recover its last TMDB cover from the title-indexed cache');
  assert.equal(sourceLessSeed.coverSource, 'tmdb', 'title-indexed cache recovery should retain the TMDB source marker');

  const previous = {
    id: 'RyHxZP9EKpL',
    title: '菜鸟炊事兵',
    coverImg: cached.url,
    coverSource: 'tmdb',
    primaryUrl: 'https://www.themoviedb.org/tv/295509',
    primaryUrlSource: 'tmdb',
    tmdbUrl: 'https://www.themoviedb.org/tv/295509',
    doubanUrl: 'https://movie.douban.com/subject/37194459/',
  };
  const current = {
    id: 'new-live-id',
    title: '菜鸟伙房兵',
    coverImg: 'https://static.yfsp.tv/poster.gif',
    coverSource: 'yfsp',
    primaryUrl: 'https://www.yfsp.tv/play/new-live-id',
    primaryUrlSource: 'yfsp',
  };
  const merged = helpers.mergePreviousShowState(current, previous);
  assert.equal(merged.coverImg, previous.coverImg, 'a transient low-quality refresh should not replace the last published TMDB cover');
  assert.equal(merged.tmdbUrl, previous.tmdbUrl, 'stable enrichment links should survive a live ID/title refresh');

  const targetMap = new Map([['new-live-id', current]]);
  helpers.restorePreviousCategory(targetMap, [previous], 'korean_drama', '电视剧', () => 100, 'disc_kd');
  assert.equal(targetMap.get('new-live-id')?.coverImg, previous.coverImg, 'previously published cards should be merged when the source returns an alias');

  assert.doesNotThrow(
    () => helpers.assertOutputContinuity({ koreanDramas: Array(40).fill({}), chineseVariety: Array(40).fill({}) }, { koreanDramas: Array(50).fill({}), chineseVariety: Array(50).fill({}) }),
    'normal output variation should pass the continuity guard'
  );
  assert.throws(
    () => helpers.assertOutputContinuity({ koreanDramas: Array(4).fill({}), chineseVariety: Array(40).fill({}) }, { koreanDramas: Array(50).fill({}), chineseVariety: Array(50).fill({}) }),
    /DATA_GUARD/,
    'a catastrophic category drop should stop the scraper before it overwrites the previous output'
  );
}

{
  const showsPath = '/tmp/iyf-test/scripts/../data/shows.json';
  const { helpers } = loadScrapeHelpers({
    initialFiles: { [showsPath]: JSON.stringify({
      lastUpdated: '2026-08-13T00:00:00Z', koreanDramas: {}, chineseVariety: [], otherDramas: [],
    }) },
  });
  assert.throws(() => helpers.loadPreviousShows(), /DATA_GUARD/u, 'valid JSON with an invalid previous-data schema must fail closed');

  const corrupted = helpers.repairKnownIdentityCorruption({
    id: 'seed_var_c01', title: '奔跑吧兄弟', regional: '大陆',
    tmdbId: 33238, tmdbUrl: 'https://www.themoviedb.org/tv/33238',
    doubanUrl: 'https://movie.douban.com/subject/10509888/',
    wikipediaUrl: 'https://zh.wikipedia.org/wiki/Running_Man', imdbUrl: 'https://www.imdb.com/title/tt2185037/',
  });
  assert.equal(corrupted.tmdbUrl, '');
  assert.equal(corrupted.doubanUrl, 'https://movie.douban.com/subject/25899362/');
  assert.doesNotMatch(JSON.stringify(corrupted), /33238|10509888|Running_Man|tt2185037/u, 'mainland Running Man must not inherit the Korean SBS entity');
}

// ── YFSP verification and lookup-cache regressions ──────────────────────────
{
  const show = { title: '测试节目' };
  const valid = loadScrapeHelpers({
    fetchImpl: async () => mockResponse({ text: '<title>测试节目-免费在线观看</title>' }),
  }).helpers;
  assert.equal(await valid.verifyYfspUrl(show, 'https://www.yfsp.tv/play/valid'), 'valid');

  const missing = loadScrapeHelpers({ fetchImpl: async () => mockResponse({ status: 404 }) }).helpers;
  assert.equal(await missing.verifyYfspUrl(show, 'https://www.yfsp.tv/play/missing'), 'invalid');

  const transient = loadScrapeHelpers({ fetchImpl: async () => mockResponse({ status: 503 }) }).helpers;
  assert.equal(await transient.verifyYfspUrl(show, 'https://www.yfsp.tv/play/transient'), 'unknown');

  const timeout = loadScrapeHelpers({ fetchImpl: async () => { throw new Error('timeout'); } }).helpers;
  assert.equal(await timeout.verifyYfspUrl(show, 'https://www.yfsp.tv/play/timeout'), 'unknown');

  const cached = { yfspUrl: 'https://www.yfsp.tv/play/one' };
  valid.markYfspLookup(cached, 'valid', cached.yfspUrl);
  const checkedAt = Date.parse(cached.yfspLookupCheckedAt);
  assert.equal(valid.hasFreshYfspLookup(cached, checkedAt + 1000), true, 'valid lookup cache should bind to the verified URL');
  cached.yfspUrl = 'https://www.yfsp.tv/play/two';
  assert.equal(valid.hasFreshYfspLookup(cached, checkedAt + 1000), false, 'a changed URL must be reverified');

  const noLinkUnknown = { yfspUrl: '' };
  valid.markYfspLookup(noLinkUnknown, 'unknown', 'https://www.yfsp.tv/play/candidate');
  assert.equal(
    valid.hasFreshYfspLookup(noLinkUnknown, Date.parse(noLinkUnknown.yfspLookupCheckedAt) + 1000),
    true,
    'unknown candidate verification should rotate out of the no-link queue for its TTL'
  );

  const partialSearch = loadScrapeHelpers({
    fetchImpl: async () => mockResponse({ json: { data: { info: [{ result: [{
      title: '测试节目', contxt: 'candidate', atypeName: '电视剧', regional: '韩国', postTime: '2026-01-01',
    }] }] } } }),
  }).helpers;
  const partialFound = await partialSearch.searchYfspTitle({ title: '测试节目', mediaType: '电视剧', regional: '韩国', year: 2026 });
  assert.equal(Object.hasOwn(partialFound, 'score'), false, 'a partial YFSP match must preserve missing score provenance');
  assert.equal(Object.hasOwn(partialFound, 'playCount'), false, 'a partial YFSP match must preserve missing play-count provenance');
  const reliable = { title: '测试节目', score: 8, playCount: 12345 };
  partialSearch.applyYfspSearchFields(reliable, partialFound);
  assert.equal(reliable.score, 8);
  assert.equal(reliable.playCount, 12345);

  const explicitZeroSearch = loadScrapeHelpers({
    fetchImpl: async () => mockResponse({ json: { data: { info: [{ result: [{
      title: '测试节目', contxt: 'zero', atypeName: '电视剧', regional: '韩国', postTime: '2026-01-01', score: 0, hot: 0,
    }] }] } } }),
  }).helpers;
  const zeroFound = await explicitZeroSearch.searchYfspTitle({ title: '测试节目', mediaType: '电视剧', regional: '韩国', year: 2026 });
  explicitZeroSearch.applyYfspSearchFields(reliable, zeroFound);
  assert.equal(reliable.score, 0, 'an explicit numeric zero should remain an authoritative YFSP update');
  assert.equal(reliable.playCount, 0);
}

// ── AI regressions ──────────────────────────
{
  const openRouterCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('评分结果 [仅供参考]: [{"id":"drama-1","s":88,"r":"合适"}]', openRouterCounter),
  });
  const show = { id: 'drama-1', title: '浪漫律师', year: 2026, score: 8, playCount: 10000 };
  const scores = await helpers.aiScoreShows([show]);
  assert.equal(scores.get('drama-1')?.score, 88, 'OpenRouter-only AI runs should parse bracketed-prose JSON arrays');
  assert.equal(scores.get('drama-1')?.version, helpers.AI_SCORE_CACHE_VERSION, 'new AI results should carry the current cache version');
  assert.equal(scores.get('drama-1')?.inputHash, helpers.aiScoreInputHash(show), 'new AI results should be bound to the scored input');
  assert.equal(openRouterCounter.count, 1, 'OpenRouter-only AI runs should call the configured provider');
}

{
  let messages = [];
  const { helpers } = loadScrapeHelpers({
    env: { GITHUB_TOKEN: 'gh-test-key' },
    fetchImpl: async (_url, options) => {
      messages = JSON.parse(options.body).messages;
      return mockResponse({ json: { choices: [{ message: { content: '[{"id":"variety-1","s":82,"r":"轻松下饭"}]' } }] } });
    },
  });
  const show = { id: 'variety-1', title: '旅行喜剧', category: 'variety', mediaType: '综艺', year: 2026, score: 8, playCount: 10000 };
  const scores = await helpers.aiScoreShows([show]);
  assert.equal(scores.get('variety-1')?.score, 82);
  assert.match(messages[0].content, /综艺推荐助手/u, 'variety scoring must use the variety-specific system prompt');
  assert.match(messages[0].content, /绝不能因为节目不是韩剧而扣分/u);
  assert.match(messages[0].content, /不可信节目数据/u, 'AI system prompts must isolate untrusted source text from instructions');

  const smallChange = { ...show, playCount: 19999 };
  const magnitudeChange = { ...show, playCount: 100000 };
  assert.equal(helpers.aiScoreInputHash(show), helpers.aiScoreInputHash(smallChange), 'small play-count changes should not invalidate the AI cache');
  assert.notEqual(helpers.aiScoreInputHash(show), helpers.aiScoreInputHash(magnitudeChange), 'a new play-count magnitude should invalidate the AI cache');
}

{
  const prettyCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { GITHUB_TOKEN: 'gh-test-key' },
    fetchImpl: aiFetchWithContent('评分结果:\n```json\n[\n  {"id":"pretty-1","s":77,"r":"格式化 JSON"}\n]\n```', prettyCounter),
  });
  const scores = await helpers.aiScoreShows([{ id: 'pretty-1', title: '格式化测试', year: 2026, score: 8, playCount: 10000 }]);
  assert.equal(scores.get('pretty-1')?.score, 77, 'AI parsing should accept prose-wrapped pretty-printed JSON arrays');
}

{
  const objectCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { GITHUB_TOKEN: 'gh-test-key' },
    fetchImpl: aiFetchWithContent('{"results":[{"id":"object-1","s":66,"r":"对象包装"}]}', objectCounter),
  });
  const scores = await helpers.aiScoreShows([{ id: 'object-1', title: '对象包装测试', year: 2026, score: 8, playCount: 10000 }]);
  assert.equal(scores.get('object-1')?.score, 66, 'AI parsing should extract arrays from valid JSON object wrappers');
}

{
  const githubCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { GITHUB_TOKEN: 'gh-test-key' },
    fetchImpl: aiFetchWithContent('[]', githubCounter),
  });
  const cachedZero = { id: 'zero', title: '低分测试', aiScore: 0, aiScoredAt: new Date().toISOString(), year: 2026 };
  cachedZero.aiScoreVersion = helpers.AI_SCORE_CACHE_VERSION;
  cachedZero.aiScoreInputHash = helpers.aiScoreInputHash(cachedZero);
  const scores = await helpers.aiScoreShows([cachedZero]);
  assert.equal(scores.size, 0, 'fresh cached AI score 0 should not need rescoring');
  assert.equal(githubCounter.count, 0, 'fresh cached AI score 0 should not call AI providers');
}

{
  const githubCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { GITHUB_TOKEN: 'gh-test-key' },
    fetchImpl: aiFetchWithContent('[{"id":"changed","s":55,"r":"输入已变化"}]', githubCounter),
  });
  const changed = {
    id: 'changed', title: '缓存输入变化', year: 2026, score: 8, playCount: 10000,
    aiScore: 0, aiScoredAt: new Date().toISOString(), aiScoreVersion: helpers.AI_SCORE_CACHE_VERSION,
    aiScoreInputHash: 'stale-input-hash',
  };
  const scores = await helpers.aiScoreShows([changed]);
  assert.equal(githubCounter.count, 1, 'a current-version cache entry with a stale input hash should be rescored');
  assert.equal(scores.get('changed')?.score, 55, 'rescoring should replace the stale cached value, including a previous score of 0');
  assert.equal(scores.get('changed')?.inputHash, helpers.aiScoreInputHash(changed), 'the replacement score should carry the current input hash');
}

// ── Output filtering and de-duplication regressions ──────────────────────────
{
  const { helpers } = loadScrapeHelpers();
  const hostile = helpers.normalizeOutputShow({
    id: 'hostile', title: '异常输出', year: 2200, score: 1e300, playCount: -10,
    aiScore: 999, recommendScore: Infinity, totalEpisodes: 20260813, currentEpisode: -1,
    coverImg: 'https://evil.example/poster.jpg', yfspUrl: 'javascript:alert(1)',
    doubanUrl: 'https://movie.douban.com/subject/1/',
  });
  assert.equal(hostile.year, 0);
  assert.equal(hostile.score, 10);
  assert.equal(hostile.playCount, 0);
  assert.equal(hostile.aiScore, 100);
  assert.equal(hostile.recommendScore, 0);
  assert.equal(hostile.totalEpisodes, 0);
  assert.equal(hostile.coverImg, '');
  assert.equal(hostile.yfspUrl, '');

  assert.equal(helpers.isRenderableShow({ seedId: 'seed_x', category: 'korean_drama', coverImg: '', primaryUrl: '' }), false, 'seed cards should still need a cover and primary link');
  assert.equal(helpers.isRenderableShow({ id: 'fallback', title: '兜底节目', category: 'korean_drama', coverImg: 'https://static.yfsp.tv/poster.jpg', coverSource: 'yfsp', primaryUrl: 'https://www.yfsp.tv/play/x' }), true, 'recommendations with valid identity, fallback covers and links should remain renderable');

  const deduped = helpers.dedupByTitle([
    { title: '非常律师禹英禑', tmdbUrl: 'https://www.themoviedb.org/tv/197067', recommendScore: 95 },
    { title: '奇怪的律师禹英禑', tmdbUrl: 'https://www.themoviedb.org/tv/197067', recommendScore: 80 },
  ]);
  assert.equal(deduped.length, 1, 'final output should collapse alias cards with the same external ID');

  const seasons = helpers.dedupByTitle([
    { title: '黑暗荣耀第2季', tmdbUrl: 'https://www.themoviedb.org/tv/136283', recommendScore: 90 },
    { title: '黑暗荣耀', tmdbUrl: 'https://www.themoviedb.org/tv/136283', recommendScore: 70 },
  ]);
  assert.equal(seasons.length, 2, 'final output should preserve distinct seasons even when they share a series-level external URL');

  const seasonThenAliases = helpers.dedupByTitle([
    { title: '黑暗荣耀第2季', tmdbUrl: 'https://www.themoviedb.org/tv/136283', recommendScore: 90 },
    { title: '黑暗荣耀', tmdbUrl: 'https://www.themoviedb.org/tv/136283', recommendScore: 80 },
    { title: 'The Glory', tmdbUrl: 'https://www.themoviedb.org/tv/136283', recommendScore: 70 },
  ]);
  assert.deepEqual(seasonThenAliases.map(s => s.title), ['黑暗荣耀第2季', '黑暗荣耀'], 'external-ID de-dup should compare later aliases against kept non-season entries, not only the first external entry');

  const sharedSecondaryId = helpers.dedupByTitle([
    { title: '非常律师禹英禑', tmdbUrl: 'https://www.themoviedb.org/tv/197067', doubanUrl: 'https://movie.douban.com/subject/35524446/', recommendScore: 95 },
    { title: '奇怪的律师禹英禑', doubanUrl: 'https://movie.douban.com/subject/35524446/', recommendScore: 80 },
  ]);
  assert.equal(sharedSecondaryId.length, 1, 'external-ID de-dup should compare all shared source IDs, not only the preferred primary link');

  const sameSeasonDifferentNumerals = helpers.dedupByTitle([
    { title: '极限挑战第一季', tmdbUrl: 'https://www.themoviedb.org/tv/88888', recommendScore: 95 },
    { title: '极限挑战第1季', tmdbUrl: 'https://www.themoviedb.org/tv/88888', recommendScore: 80 },
  ]);
  assert.equal(sameSeasonDifferentNumerals.length, 1, 'external-ID de-dup should collapse same-season titles even when season numerals use Chinese vs Arabic forms');

  const blankThenValid = helpers.dedupByTitle([
    { title: '', tmdbUrl: 'https://www.themoviedb.org/tv/blank', recommendScore: 100 },
    { title: '有效节目', tmdbUrl: 'https://www.themoviedb.org/tv/blank', recommendScore: 80 },
  ]);
  assert.deepEqual(blankThenValid.map(s => s.title), ['有效节目'], 'blank-title rows should not poison external-ID de-duplication');
}

// ── TMDB and Douban cache regressions ──────────────────────────
{
  const { helpers, writes } = loadScrapeHelpers({ env: {} });
  await helpers.enrichCoversFromTMDB([{
    id: 'tmdb-unavailable',
    title: '订阅男友',
    year: 2026,
    mediaType: '电视剧',
    regional: '韩国',
    category: 'korean_drama',
    coverImg: 'https://www.yfsp.tv/poster.jpg',
    primaryUrl: 'https://www.yfsp.tv/play/demo',
  }]);
  const savedCache = JSON.parse([...writes.values()].at(-1) || '{}');
  assert.notEqual(savedCache['tmdb-unavailable']?.notFound, true, 'missing TMDB token should not write a negative notFound cache entry');
}

{
  const { helpers, writes } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async () => mockResponse({ status: 503 }),
  });
  await helpers.enrichCoversFromTMDB([{
    id: 'tmdb-transient', title: 'TMDB瞬时错误', year: 2026,
    mediaType: '电视剧', regional: '韩国', category: 'korean_drama',
    coverImg: 'https://static.yfsp.tv/poster.jpg', yfspCoverImg: 'https://static.yfsp.tv/poster.jpg',
    primaryUrl: 'https://www.yfsp.tv/play/demo',
  }]);
  const savedCache = JSON.parse([...writes.values()].at(-1) || '{}');
  assert.notEqual(savedCache['tmdb-transient']?.notFound, true, 'TMDB 5xx responses must not poison the negative cover cache');
}

{
  const { helpers } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return {
          ok: true,
          json: async () => ({
            results: [{
              id: 12345,
              name: 'TMDB高清优先测试',
              original_name: 'TMDB高清优先测试',
              poster_path: '/poster-original.jpg',
              origin_country: ['CN'],
            }],
          }),
        };
      }
      if (textUrl.includes('/tv/12345/external_ids')) {
        return { ok: true, json: async () => ({}) };
      }
      if (textUrl.includes('wikidata.org')) {
        return { ok: false, json: async () => ({}) };
      }
      throw new Error(`unexpected TMDB mock URL: ${textUrl}`);
    },
  });

  const show = {
    id: 'tmdb-priority',
    title: 'TMDB高清优先测试',
    year: 2026,
    mediaType: '综艺',
    regional: '大陆',
    category: 'variety',
    coverImg: 'https://static.yfsp.tv/low-quality.gif',
    primaryUrl: 'https://www.yfsp.tv/play/demo',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/poster-original.jpg', 'TMDB original poster should replace an existing YFSP cover');
  assert.equal(show.coverSource, 'tmdb', 'TMDB matches should be marked as the cover source');
  assert.equal(show.yfspCoverImg, 'https://static.yfsp.tv/low-quality.gif', 'YFSP cover should be kept only as fallback after TMDB wins');

  helpers.applyYfspSearchFields(show, {
    coverImg: 'https://static.yfsp.tv/another-low-quality.jpg',
    updateStatus: '更新到3',
  });
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/poster-original.jpg', 'later YFSP refreshes should not overwrite a TMDB cover');
  assert.equal(show.coverSource, 'tmdb', 'later YFSP refreshes should preserve TMDB cover source');
}

{
  const { helpers } = loadScrapeHelpers({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'old', title: '同名剧', year: '2016' },
        { id: 'new', title: '同名剧', year: '2026' },
      ],
    }),
  });
  const found = await helpers.searchDoubanSubject({ title: '同名剧', year: 2026, mediaType: '电视剧' });
  assert.equal(found?.doubanId, 'new', 'Douban search should prefer year-compatible title matches');
}

{
  const { helpers } = loadScrapeHelpers({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'near', title: '同名季播', year: '2025' },
        { id: 'exact', title: '同名季播', year: '2026' },
      ],
    }),
  });
  const found = await helpers.searchDoubanSubject({ title: '同名季播', year: 2026, mediaType: '电视剧' });
  assert.equal(found?.doubanId, 'exact', 'Douban search should prefer exact-year matches over nearby-year matches');
}

{
  const { helpers } = loadScrapeHelpers({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'long-running-variety', title: '你好星期六', year: '2022' },
      ],
    }),
  });
  const found = await helpers.searchDoubanSubject({ title: '你好星期六', year: 2026, mediaType: '综艺' });
  assert.equal(found?.doubanId, 'long-running-variety', 'Douban search should allow exact-title fallback for long-running variety subjects');
}

{
  const { helpers } = loadScrapeHelpers({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'old-season', title: '你好星期六第3季', year: '2022' },
        { id: 'long-running-variety', title: '你好星期六', year: '2022' },
      ],
    }),
  });
  const found = await helpers.searchDoubanSubject({ title: '你好星期六', year: 2026, mediaType: '综艺' });
  assert.equal(found?.doubanId, 'long-running-variety', 'Douban fallback should skip incompatible season candidates and keep searching for a valid long-running variety subject');
}

{
  const { helpers } = loadScrapeHelpers({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'base-variety', title: '无限超越班', year: '2022' },
      ],
    }),
  });
  const found = await helpers.searchDoubanSubject({ title: '无限超越班第4季', year: 2026, mediaType: '综艺' });
  assert.equal(found, null, 'Douban search should not fallback from a season-specific variety title to an incompatible base subject');
}

{
  const { helpers } = loadScrapeHelpers({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'previous-season', title: '无限超越班第3季', year: '2025' },
      ],
    }),
  });
  const found = await helpers.searchDoubanSubject({ title: '无限超越班第4季', year: 2026, mediaType: '综艺' });
  assert.equal(found, null, 'Douban search should not accept a nearby-year match from a different variety season');
}

// ── Source contract smoke checks ──────────────────────────
assert.match(app, /escapeHtml\(String\(show\.aiScore\)\)/, 'AI score badge should escape stringified output');
assert.match(app, /escapeHtml\(String\(show\.score\)\)/, 'score badge should escape stringified output');
assert.match(app, /escapeHtml\(String\(show\.score\)\)/, 'floating score should escape stringified output');
assert.match(app, /toText\(s\.title\)\.toLowerCase\(\)\.includes\(query\)/, 'search should tolerate missing titles');
assert.match(app, /function getValidTime\(/, 'date sorting should use a valid-time helper');
assert.doesNotMatch(app, /s\.year === 2026/, 'current-year tab should not hardcode 2026');
assert.doesNotMatch(index, /2026新剧|2026新综艺|2026新综/, 'HTML copy should not hardcode one calendar year');
assert.doesNotMatch(app, /new Date\([^\n]+\) - new Date\(/, 'date sorting should not subtract Date objects directly');

assert.match(scrape, /const TMDB_TOKEN = process\.env\.TMDB_TOKEN \|\| '';/, 'TMDB token should come from environment');
assert.match(scrape, /if \(!TMDB_TOKEN\)/, 'TMDB fetch should skip clearly when token is missing');
assert.match(scrape, /const refreshTargets = shows\s*\.filter\(s => s\.yfspUrl && s\.title && !s\.isComplete/, 'ongoing shows with existing YFSP links should refresh status on each scrape');
assert.match(scrape, /applyYfspSearchFields\(show, found\);/, 'YFSP search results should refresh existing show fields, not only fill blanks');
assert.match(scrape, /if \(parsed\.totalEpisodes\) show\.totalEpisodes = parsed\.totalEpisodes;/, 'YFSP status refresh should not erase known total episode counts');
assert.match(scrape, /cached && typeof cached === 'object' && cached\.version === COVER_CACHE_VERSION/, 'TMDB cache fallback should guard null cached entries');
assert.match(scrape, /'订阅男友': 'Boyfriend on Demand'/, 'TMDB English title for 订阅男友 should be corrected');
assert.match(scrape, /'大叔再出招': \['Fifties Professionals', '오십프로', '五十专家', '五十專家'\]/, '大叔再出招 should have TMDB search aliases');
assert.match(scrape, /'大叔再出招': 'Fifties Professionals'/, '大叔再出招 should use its TMDB English title');
assert.match(scrape, /'最后一排的男孩': 'Notes from the Last Row'/, '最后一排的男孩 should use its TMDB English title');
assert.match(scrape, /function stableDiscoveredId\(/, 'discovered shows without YFSP IDs should get stable title-based IDs');
assert.match(scrape, /restorePreviousRecommendations\(kdramaMap, varietyMap, prevShows\)/, 'previously accepted recommendations should be restored before each fresh discovery run');
assert.match(scrape, /titleMatches\(cached\.title, show\.title\)/, 'TMDB cover cache reuse should tolerate cleaned season titles');
assert.match(scrape, /菜鸟炊事兵.*菜鸟伙房兵/s, 'the 菜鸟炊事兵 seed should preserve the user-facing alias 菜鸟伙房兵');
assert.match(app, /Array\.isArray\(s\.titleAliases\)/, 'frontend search should include alternate show titles');
assert.match(scrape, /id: mediaKey \|\| episodeKey \|\| stableDiscoveredId\(/, 'API items without media IDs should not collapse into an empty liveShows key');
assert.match(scrape, /isTMDBImageUrl\(show\.coverImg\)[\s\S]*?show\.coverSource = 'tmdb'[\s\S]*?else if \(show\.coverImg\)/, 'restored TMDB covers should keep TMDB source while enriching covers');
assert.doesNotMatch(scrape, /if \(show\.coverImg\) show\.yfspCoverImg = show\.coverImg;/, 'restored TMDB covers should not be treated as YFSP fallbacks');

assert.doesNotMatch(scrape, /seed_var_2026_0(1b|2b|4b)|seed_var_2026_10b|seed_var_2026_23/, 'pseudo-variant/duplicate seeds should be removed to avoid repeating cards');
assert.doesNotMatch(scrape, /seed_var_2026_17/, '待定版地球超新鲜 seed should be removed (duplicate of seed_var_2026_28)');
assert.doesNotMatch(scrape, /seed_kd_s03/, 'duplicate 奇怪的律师禹英禑 seed should be removed (covered by seed_kd_c15 非常律师禹英禑)');
assert.match(scrape, /function dedupByTitle\(/, 'final output should dedup duplicate cards');
assert.match(scrape, /koreanDramas = dedupByTitle\(/, 'korean drama output should be de-duplicated');
assert.match(scrape, /chineseVariety = dedupByTitle\(/, 'variety output should be de-duplicated');

assert.match(workflow, /data\/history\.json/, 'workflow should include history.json in data commit handling');
assert.match(workflow, /TMDB_TOKEN: \$\{\{ secrets\.TMDB_TOKEN \}\}/, 'workflow should pass TMDB_TOKEN from secrets');
assert.match(workflow, /paths-ignore:\n\s+- 'data\/\*\*'/, 'data-only bot commits should not retrigger the scraper workflow');
assert.match(workflow, /pushed=false/, 'workflow should track whether data push actually succeeded');
assert.match(workflow, /exit 1/, 'workflow should stop before deploy if data push fails');
assert.doesNotMatch(workflow, /git rebase --continue \|\| true/, 'workflow should not swallow failed rebase continuation');
assert.match(workflow, /base_sha="\$GITHUB_SHA"/, 'workflow should bind scraped data to the code revision that produced it');
assert.doesNotMatch(workflow, /git pull --rebase/, 'workflow should not rebase data generated by an older scraper onto newer main code');
assert.match(workflow, /mkdir -p site/, 'workflow should build an explicit Pages artifact directory');
assert.match(workflow, /path: 'site'/, 'workflow should upload only the explicit site artifact');
assert.doesNotMatch(workflow, /path: '\.'/, 'workflow should not upload the repository root');
assert.doesNotMatch(workflow, /cp -R css js data site\//, 'workflow should not publish data files by broad directory copy');
assert.match(workflow, /mkdir -p site\/data/, 'workflow should create an explicit public data artifact directory');
assert.match(workflow, /node scripts\/build-public-data\.mjs --output site\/data\/shows\.json/, 'workflow should build a field-minimized public shows payload');

assert.doesNotMatch(css, /\.show-card:nth-child\(\d+\) \{ animation-delay:/, 'CSS nth-child animation delays should not duplicate inline delay');

console.log('Regression checks passed');
