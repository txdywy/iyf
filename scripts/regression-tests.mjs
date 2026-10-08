import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');

const app = read('js/app.js');
const scrape = read('scripts/scrape.mjs');
const publicBuild = read('scripts/build-public-data.mjs');
const workflow = read('.github/workflows/scrape-and-deploy.yml');
const validateData = read('scripts/validate-data.mjs');
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

function fixedInstant(iso) {
  const timestamp = Date.parse(iso);
  return class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [iso]));
    }
    static now() {
      return timestamp;
    }
  };
}

function instantSetTimeout(fn) {
  fn();
  return 0;
}

function loadScrapeHelpers({ env = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); }, dateImpl = Date, initialFiles = {}, setTimeoutImpl = instantSetTimeout, clearTimeoutImpl = () => {} } = {}) {
  const writes = new Map(Object.entries(initialFiles).map(([path, content]) => [String(path), String(content)]));
  const context = {
    console: { log() {}, warn() {}, error() {} },
    process: { env },
    fetch: fetchImpl,
    URL,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
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
        isEligibleKDrama,
        removeHardExcludedKDrama,
        passesKDramaDiscoveryThreshold,
        aiScoreInputHash,
        AI_SCORE_CACHE_VERSION,
        aiScoreShows,
        aiEvaluateDiscovery,
        aiEnhanceDescriptions,
        enrichDescriptions,
        discoverNewKDramas,
        discoverNewVariety,
        isRenderableShow,
        dedupByTitle,
        titleMatches,
        restorePreviousCategory,
        mergePreviousShowState,
        loadPreviousShows,
        findReusableTMDBCache,
        isReusableTMDBCoverCache,
        normalizeOutputShow,
        searchTMDBImage,
        seasonKey,
        seasonNumberFromTitle,
        simplifyTitleForSearch,
        extractTMDBSeriesId,
        extractTMDBSeasonNumber,
        isTMDBResultSeasonCompatible,
        isTMDBResultYearCompatible,
        repairKnownIdentityCorruption,
        assertOutputContinuity,
        assertOutputSchema,
        countIdentityOverlap,
        SEED_KDRAMAS,
        enrichCoversFromTMDB,
        syncTMDBCoverStatus,
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
  locationImpl,
  fetchImpl = async () => { throw new Error('unexpected fetch'); },
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  localStorageImpl,
  windowImpl = { addEventListener() {}, matchMedia: () => ({ matches: false }) },
} = {}) {
  const context = {
    console,
    Date: dateImpl,
    URL,
    URLSearchParams,
    AbortController,
    fetch: fetchImpl,
    localStorage: localStorageImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval: setIntervalImpl,
    clearInterval: clearIntervalImpl,
    window: windowImpl,
    history: { replaceState() {} },
    location: locationImpl || { hash: '', slice(n) { return this.hash.slice(n); } },
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
      init,
      animateNum,
      loadData,
      isShowDataset,
      renderCardActions,
      renderCard,
      fetchJSONWithTimeout,
      escapeHtml,
      safeExternalUrl,
      switchTab,
      handleUrlStateChange,
      bindFilters,
      bindContentNavigation,
      bindLoadMore,
      loadMoreShows,
      getScheduleDateKey,
      buildScheduleDateKeys,
      sortTVmazeShows,
      isTVmazeDrama,
      normalizeAIScore,
      getDataFreshness,
      setAllData: value => { allData = value; },
      setTVmazeCache: (shows, cachedAt = Date.now()) => {
        _tvmazeCache = shows;
        _tvmazeCachedAt = cachedAt;
        _tvmazeCacheDate = getScheduleDateKey(cachedAt);
      },
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
    hidden: false,
    tabIndex: -1,
    classList: {
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    dispatch(name, event = {}) { return listeners.get(name)?.(event); },
    focus() {},
  };
}

function createAppDocument() {
  const elements = {
    showGrid: createDomElement({ id: 'showGrid' }),
    loading: createDomElement({ id: 'loading' }),
    empty: createDomElement({ id: 'empty' }),
    emptyMessage: createDomElement({ id: 'emptyMessage' }),
    emptyAction: createDomElement({ id: 'emptyAction' }),
    loadMore: createDomElement({ id: 'loadMore' }),
    loadMoreButton: createDomElement({ id: 'loadMoreButton' }),
    loadMoreStatus: createDomElement({ id: 'loadMoreStatus' }),
    resetFilters: createDomElement({ id: 'resetFilters' }),
    statTotal: createDomElement({ id: 'statTotal', textContent: '0' }),
    statOngoing: createDomElement({ id: 'statOngoing', textContent: '0' }),
    statComplete: createDomElement({ id: 'statComplete', textContent: '0' }),
    statHighScore: createDomElement({ id: 'statHighScore', textContent: '0' }),
    updateInfo: createDomElement({ id: 'updateInfo' }),
    resultSummary: createDomElement({ id: 'resultSummary' }),
    sortBy: createDomElement({ id: 'sortBy', value: 'recommend' }),
    filterStatus: createDomElement({ id: 'filterStatus', value: 'all' }),
    filterScore: createDomElement({ id: 'filterScore', value: '0' }),
    searchInput: createDomElement({ id: 'searchInput', value: '' }),
    skipLink: createDomElement({ id: 'skipLink' }),
    mainContent: createDomElement({ id: 'mainContent' }),
  };
  const tabNames = ['korean', 'year', 'varietyYear', 'variety', 'new', 'classic', 'tvmaze'];
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
  const { document, elements } = createAppDocument();
  const location = { hash: '#variety', search: '', href: 'http://localhost/#variety' };
  const helpers = loadAppHelpers({ documentImpl: document, locationImpl: location });
  helpers.setAllData({ lastUpdated: '2026-09-30', koreanDramas: [], chineseVariety: [{ title: '综艺节目' }] });
  helpers.switchTab('variety', { syncUrl: false, animate: false });
  helpers.bindContentNavigation();
  let focused = false;
  let scrolled = false;
  let prevented = false;
  elements.mainContent.focus = () => { focused = true; };
  elements.mainContent.scrollIntoView = () => { scrolled = true; };
  elements.skipLink.dispatch('click', { preventDefault() { prevented = true; } });
  assert.ok(focused && scrolled && prevented, 'skip navigation should move focus to the content without changing the tab URL');
  assert.equal(location.hash, '#variety');
  location.hash = '#mainContent';
  helpers.handleUrlStateChange();
  assert.equal(elements.showGrid.getAttribute('aria-labelledby'), 'tab-variety', 'content anchors must not reroute to Korean recommendations');
  assert.equal(helpers.getCurrentShows()[0].title, '综艺节目');
}

for (const changed of [false, true]) {
  const { document, elements } = createAppDocument();
  const cached = {
    lastUpdated: '2026-09-30T00:00:00Z',
    koreanDramas: Array.from({ length: 60 }, (_, i) => ({ id: `refresh-${i}`, title: `刷新节目${i}`, recommendScore: 100 - i })),
    chineseVariety: [],
  };
  let finishFetch;
  const helpers = loadAppHelpers({
    documentImpl: document,
    localStorageImpl: { getItem: () => JSON.stringify({ version: 3, cachedAt: Date.now(), data: cached }), setItem() {} },
    fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }),
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
  });
  const pending = helpers.loadData();
  helpers.loadMoreShows();
  const before = elements.showGrid.innerHTML;
  assert.match(elements.resultSummary.textContent, /48 \/ 60/);
  const refreshed = structuredClone(cached);
  if (changed) refreshed.koreanDramas[0].title = '本轮已更新';
  finishFetch({ ok: true, json: async () => refreshed });
  await pending;
  assert.match(elements.resultSummary.textContent, /48 \/ 60/, 'a background refresh should preserve expanded results');
  assert.equal((elements.showGrid.innerHTML.match(/<article class="show-card"/g) || []).length, 48);
  if (changed) assert.match(elements.showGrid.innerHTML, /本轮已更新/, 'changed data should still update the visible cards');
  else assert.equal(elements.showGrid.innerHTML, before, 'an unchanged snapshot should preserve the rendered cards');
}

for (const succeeds of [true, false]) {
  const { document, elements } = createAppDocument();
  let finishFetch;
  let applySearch;
  const helpers = loadAppHelpers({
    documentImpl: document,
    fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }),
    setTimeoutImpl: (callback, delay) => {
      if (delay === 300) applySearch = callback;
      return 0;
    },
    clearTimeoutImpl() {},
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
  });
  const pending = helpers.init();
  const assertLoading = () => {
    assert.match(elements.showGrid.innerHTML, /skeleton-card/, 'filters must preserve the first-load skeleton until the data settles');
    assert.equal(elements.showGrid.getAttribute('aria-busy'), 'true');
    assert.equal(elements.loading.style.display, 'block');
    assert.notEqual(elements.empty.style.display, 'block', 'pending data must not be announced as an empty result');
  };
  assertLoading();
  for (const [control, value] of [['filterStatus', 'ongoing'], ['filterScore', '8'], ['sortBy', 'score']]) {
    elements[control].value = value;
    elements[control].dispatch('change');
    assertLoading();
  }
  elements.searchInput.value = '加载';
  elements.searchInput.dispatch('input');
  applySearch();
  assertLoading();
  elements.resetFilters.dispatch('click');
  assertLoading();
  elements.filterStatus.value = 'ongoing';
  elements.filterStatus.dispatch('change');
  finishFetch({ ok: succeeds, json: async () => ({
    lastUpdated: '2026-10-03',
    koreanDramas: [
      { id: 'running', title: '加载完成的连载剧', isSerial: true },
      { id: 'complete', title: '加载完成的完结剧', isComplete: true },
    ],
    chineseVariety: [],
  }) });
  await pending;
  assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false');
  assert.equal(elements.loading.style.display, 'none');
  if (succeeds) {
    assert.match(elements.showGrid.innerHTML, /加载完成的连载剧/, 'settled data must apply the filters chosen during loading');
    assert.doesNotMatch(elements.showGrid.innerHTML, /加载完成的完结剧/);
  } else {
    assert.match(elements.emptyMessage.textContent, /推荐数据加载失败/);
    assert.equal(elements.emptyAction.hidden, false, 'a failed first load must replace the skeleton with its recovery action');
  }
}

{
  const { document, elements } = createAppDocument();
  let finishFetch;
  const helpers = loadAppHelpers({
    documentImpl: document,
    fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }),
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
  });
  const pending = helpers.init();
  helpers.setTVmazeCache([{ id: 1, name: '独立加载的时间表', status: 'Running', rating: { average: 9 } }]);
  await helpers.switchTab('tvmaze');
  elements.filterScore.value = '8';
  elements.filterScore.dispatch('change');
  assert.match(elements.showGrid.innerHTML, /独立加载的时间表/, 'pending recommendation data must not block independent TVmaze filters');
  assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false');
  finishFetch({ ok: true, json: async () => ({ lastUpdated: '2026-10-03', koreanDramas: [], chineseVariety: [] }) });
  await pending;
  assert.match(elements.showGrid.innerHTML, /独立加载的时间表/, 'settled recommendation data must not overwrite the active schedule');
}

for (const resultIsToday of [true, false]) {
  const { document, elements } = createAppDocument();
  const dateImpl = fixedInstant('2026-10-03T01:00:00Z');
  let now = dateImpl.now();
  dateImpl.now = () => now;
  let expireRequest;
  let recovered = false;
  const calls = [];
  const row = (id, name) => ({ show: { id, name, type: 'Scripted', status: 'Running' }, season: 1, number: 4, airtime: '22:00' });
  const helpers = loadAppHelpers({
    documentImpl: document,
    dateImpl,
    setTimeoutImpl: (callback, delay) => {
      if (delay === 12000) expireRequest = callback;
      return 0;
    },
    clearTimeoutImpl() {},
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
    fetchImpl: async (url, { signal }) => {
      const date = new URL(url).searchParams.get('date');
      calls.push(date);
      if (recovered) return { ok: true, json: async () => Array.from({ length: 5 }, (_, i) => row(i + 10, `重新加载成功${i}`)) };
      if (date === '2026-10-03') return { ok: true, json: async () => resultIsToday ? [row(1, '已收到的当天节目')] : [] };
      if (!resultIsToday && date === '2026-10-02') return { ok: true, json: async () => [row(2, '已收到的历史节目')] };
      return abortedFetch(signal);
    },
  });
  if (!resultIsToday) helpers.setTVmazeCache([{ id: 3, name: '过期旧时间表', status: 'Running' }], now - 24 * 60 * 60 * 1000);
  const pending = helpers.switchTab('tvmaze');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3, 'the timeout should occur while the first history batch is pending');
  expireRequest();
  await pending;
  assert.equal(helpers.getCurrentShows().length, 1, 'a history timeout must preserve the already fetched schedule');
  assert.match(elements.showGrid.innerHTML, resultIsToday ? /已收到的当天节目/ : /已收到的历史节目/, 'a completed history request must survive a timed-out sibling');
  assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false');
  assert.notEqual(elements.empty.style.display, 'block');
  assert.match(elements.updateInfo.textContent, /部分日期暂不可用/, 'partial schedules should disclose the incomplete refresh');
  const requestCount = calls.length;
  now += 30000;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, requestCount, 'partial schedules should remain briefly available from cache');
  assert.match(elements.updateInfo.textContent, /部分日期暂不可用/, 'cache reuse must retain the partial-result notice');
  now += 31000;
  recovered = true;
  await helpers.switchTab('tvmaze');
  assert.ok(calls.length > requestCount, 'partial schedules should retry after a minute instead of waiting for the normal fifteen-minute cache');
  assert.match(elements.showGrid.innerHTML, /重新加载成功/);
  assert.doesNotMatch(elements.updateInfo.textContent, /部分日期暂不可用/);
  const recoveredRequestCount = calls.length;
  now += 2 * 60000;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, recoveredRequestCount, 'a complete refresh should restore the normal cache lifetime');
}

{
  const { document, elements } = createAppDocument();
  let finishHistory;
  let recovered = false;
  let calls = 0;
  const row = (id, name) => ({ show: { id, name, type: 'Scripted', status: 'Running' } });
  const helpers = loadAppHelpers({
    documentImpl: document,
    dateImpl: fixedInstant('2026-10-03T01:00:00Z'),
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
    fetchImpl: async (url, { signal }) => {
      calls++;
      const date = new URL(url).searchParams.get('date');
      if (recovered) return { ok: true, json: async () => Array.from({ length: 5 }, (_, i) => row(i + 10, `新时间表${i}`)) };
      if (date === '2026-10-03') return { ok: true, json: async () => [row(1, '已取消的当天结果')] };
      if (date === '2026-10-02') return new Promise(resolve => { finishHistory = resolve; });
      return abortedFetch(signal);
    },
  });
  helpers.setAllData({ lastUpdated: '2026-10-03', koreanDramas: [{ title: '本地列表' }], chineseVariety: [] });
  const cancelled = helpers.switchTab('tvmaze');
  await new Promise(resolve => setImmediate(resolve));
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.showGrid.innerHTML, /本地列表/);
  recovered = true;
  await helpers.switchTab('tvmaze');
  finishHistory({ ok: true, json: async () => [row(2, '已取消的历史结果')] });
  await cancelled;
  assert.match(elements.showGrid.innerHTML, /新时间表/);
  assert.doesNotMatch(elements.showGrid.innerHTML, /已取消的/);
  assert.doesNotMatch(elements.updateInfo.textContent, /部分日期暂不可用/, 'cancelled requests must not mark a newer complete cache as partial');
  const requestCount = calls;
  await helpers.switchTab('tvmaze');
  assert.equal(calls, requestCount);
  assert.doesNotMatch(elements.showGrid.innerHTML, /已取消的/, 'cancelled partial results must never replace the newer cache');
}

for (const failure of ['http', 'json']) {
  const { document, elements } = createAppDocument();
  const dateImpl = fixedInstant('2026-10-03T01:00:00Z');
  let now = dateImpl.now();
  dateImpl.now = () => now;
  let recovered = false;
  const calls = [];
  const row = (id, name) => ({ show: { id, name, type: 'Scripted', status: 'Running' } });
  const helpers = loadAppHelpers({
    documentImpl: document, dateImpl,
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
    fetchImpl: async url => {
      const date = new URL(url).searchParams.get('date');
      calls.push(date);
      if (recovered) return { ok: true, json: async () => Array.from({ length: 5 }, (_, i) => row(i + 10, `恢复的节目${i}`)) };
      if (date === '2026-10-03') return { ok: true, json: async () => [row(1, '已收到的节目')] };
      return failure === 'http' ? { ok: false, status: 503 } : { ok: true, json: async () => ({ error: 'invalid schedule' }) };
    },
  });
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, 7);
  assert.match(elements.showGrid.innerHTML, /已收到的节目/);
  assert.match(elements.updateInfo.textContent, /部分日期暂不可用/, `${failure} failures must disclose partial schedules`);
  now += 30000;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, 7, 'partial schedules should be available for a short retry interval');
  recovered = true;
  now += 31000;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, 8, 'ordinary failures must retry after one minute');
  assert.match(elements.showGrid.innerHTML, /恢复的节目/);
  assert.doesNotMatch(elements.updateInfo.textContent, /部分日期暂不可用/);
}

for (const cacheKind of ['empty', 'complete', 'partial']) {
  const { document, elements } = createAppDocument();
  const dateImpl = fixedInstant('2026-10-03T14:59:50Z');
  let now = dateImpl.now();
  dateImpl.now = () => now;
  const calls = [];
  const row = (id, name) => ({ show: { id, name, type: 'Scripted', status: 'Running' } });
  const helpers = loadAppHelpers({
    documentImpl: document, dateImpl,
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
    fetchImpl: async url => {
      const date = new URL(url).searchParams.get('date');
      calls.push(date);
      if (now >= Date.parse('2026-10-03T15:00:00Z')) return { ok: true, json: async () => Array.from({ length: 5 }, (_, i) => row(i + 10, `新一天的节目${i}`)) };
      if (cacheKind === 'partial' && date !== '2026-10-03') return { ok: false, status: 503 };
      return { ok: true, json: async () => cacheKind === 'empty' ? [] : Array.from({ length: cacheKind === 'partial' ? 1 : 5 }, (_, i) => row(i + 1, `前一天的节目${i}`)) };
    },
  });
  await helpers.switchTab('tvmaze');
  const count = calls.length;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, count, 'the same Korea-local day may reuse a fresh cache');
  now += 20000;
  await helpers.switchTab('tvmaze');
  assert.equal(calls[count], '2026-10-04', `${cacheKind} caches must expire at Korea-local midnight, before their TTL`);
  assert.match(elements.showGrid.innerHTML, /新一天的节目/);
  assert.doesNotMatch(elements.showGrid.innerHTML, /前一天的节目/);
  assert.notEqual(elements.empty.style.display, 'block');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setTVmazeCache([{ id: 1, name: '实体测试', summary: '<p>Jack &amp; Jane&#39;s &quot;return&quot; &#x1f3ac;</p>' }]);
  await helpers.switchTab('tvmaze');
  assert.ok(elements.showGrid.innerHTML.includes('<p class="card-desc">Jack &amp; Jane&#39;s &quot;return&quot; 🎬</p>'), 'HTML entities should be decoded before final text escaping');
  helpers.setTVmazeCache([{ id: 2, name: '安全文本', summary: '<img src=x onerror=alert(1)>&lt;script&gt;alert(2)&lt;/script&gt; &#x110000; &#xD800;' }]);
  await helpers.switchTab('tvmaze');
  assert.doesNotMatch(elements.showGrid.innerHTML, /<script|<img[^>]*onerror/);
  assert.match(elements.showGrid.innerHTML, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(elements.showGrid.innerHTML, /&amp;#x110000; &amp;#xD800;/, 'invalid Unicode entities should remain text rather than throwing');
  helpers.setTVmazeCache([{ id: 3, name: '标点测试', summary: '<p>It&rsquo;s &ldquo;Seoul&rdquo; &mdash; a caf&eacute;.</p>' }]);
  await helpers.switchTab('tvmaze');
  assert.ok(elements.showGrid.innerHTML.includes('<p class="card-desc">It’s “Seoul” — a café.</p>'));
}

for (const tab of ['korean', 'tvmaze']) {
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, fetchImpl: async () => { throw new Error('offline'); } });
  helpers.bindFilters();
  if (tab === 'tvmaze') await helpers.switchTab('tvmaze');
  else await helpers.loadData();
  const error = elements.emptyMessage.textContent;
  const action = elements.emptyAction.onclick;
  for (const [control, value] of [['filterStatus', 'ongoing'], ['filterScore', '8'], ['sortBy', 'score']]) {
    elements[control].value = value;
    elements[control].dispatch('change');
    assert.equal(elements.emptyMessage.textContent, error, 'filters must preserve the current loading error');
    assert.equal(elements.emptyAction.hidden, false, 'filters must preserve the recovery button');
    assert.equal(elements.emptyAction.onclick === action || tab === 'korean', true);
  }
  helpers.setAllData({ lastUpdated: '2026-09-30', koreanDramas: [{ title: '切换成功', score: 9, isSerial: true }], chineseVariety: [] });
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.showGrid.innerHTML, /切换成功/, 'switching to a loaded category should clear the old remote error');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({
    documentImpl: document,
    locationImpl: { hash: '#new', search: '', href: 'http://localhost/#new' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ lastUpdated: '2026-09-27', koreanDramas: [], chineseVariety: [] }) }),
  });
  await helpers.init();
  assert.equal(elements.sortBy.value, 'newest');
  helpers.switchTab('korean', { animate: false });
  assert.equal(elements.sortBy.value, 'recommend', 'the initial deep-link sort must not overwrite the Korean-tab preference');
}

{
  let stopped = 0;
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, setIntervalImpl: () => 1, clearIntervalImpl: () => stopped++ });
  helpers.animateNum('statTotal', 100);
  helpers.animateNum('statTotal', 0);
  assert.equal(stopped, 1, 'a new zero-result state must cancel a still-running counter even when the displayed number is already zero');
  assert.equal(elements.statTotal.textContent, '0');
}

{
  const candidate = { title: '待播节目', regional: '韩国', atypeName: '电视剧', score: 8, hot: 100000, postTime: '2026-09-27', lastName: '预告', contxt: 'upcoming' };
  const { helpers } = loadScrapeHelpers({ fetchImpl: async () => mockResponse({ json: { data: { info: [{ result: [candidate] }] } } }) });
  const discovered = await helpers.discoverNewKDramas(new Map(), new Map());
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].isSerial, false, 'discovery must not turn a trailer into a running drama');
  candidate.atypeName = '综艺';
  candidate.regional = '大陆';
  const variety = await helpers.discoverNewVariety(new Map(), new Map());
  assert.equal(variety.length, 1);
  assert.equal(variety[0].isSerial, false, 'the same status rule must apply to discovered variety programmes');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setAllData({ lastUpdated: '2026-09-27', chineseVariety: [], koreanDramas: [
    { id: 'running', title: '真正连载', isSerial: true, isComplete: false },
    { id: 'pending', title: '尚未开播', isSerial: false, isComplete: false },
    { id: 'unknown', title: '资料待定' },
  ] });
  elements.filterStatus.value = 'ongoing';
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.showGrid.innerHTML, /真正连载/);
  assert.doesNotMatch(elements.showGrid.innerHTML, /尚未开播|资料待定/);
  assert.equal(elements.statOngoing.textContent, 1, 'ongoing statistics must only count positively known running shows');
  assert.ok(!helpers.isShowDataset({ koreanDramas: [{}], chineseVariety: [] }), 'malformed datasets must not enter the cache');
  assert.ok(helpers.isShowDataset({ lastUpdated: '2026-09-27', koreanDramas: [{ id: 'valid', title: '有效节目' }], chineseVariety: [] }));
  assert.doesNotMatch(helpers.renderCard({ title: '缺少AI分', aiScore: null }, 0), /🤖 0\/100/, 'missing AI scores must not become zero-score badges');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, fetchImpl: async () => { throw new Error('local data offline'); } });
  helpers.setTVmazeCache([
    { id: 1, name: '今天早场', airDate: '2026-09-27', latestEpisode: { season: 1, number: null, airtime: '18:00' }, rating: { average: 6 } },
    { id: 2, name: '今天晚场', airDate: '2026-09-27', latestEpisode: { airtime: '22:00' }, rating: { average: 9 } },
    { id: 3, name: '昨日高分', airDate: '2026-09-26', rating: { average: 10 } },
  ]);
  await helpers.switchTab('tvmaze');
  await helpers.loadData();
  assert.equal(elements.sortBy.value, 'newest', 'the schedule should default to chronological sorting');
  assert.ok(elements.showGrid.innerHTML.indexOf('今天早场') < elements.showGrid.innerHTML.indexOf('今天晚场'));
  assert.ok(elements.showGrid.innerHTML.indexOf('今天晚场') < elements.showGrid.innerHTML.indexOf('昨日高分'));
  assert.match(elements.showGrid.innerHTML, /特别篇/);
  assert.doesNotMatch(elements.showGrid.innerHTML, /Enull|Eundefined/);
  assert.match(elements.showGrid.innerHTML, /韩国时间/);
  assert.notEqual(elements.empty.style.display, 'block', 'local data failure must not erase the independent schedule');
  helpers.switchTab('korean');
  assert.match(elements.emptyMessage.textContent, /加载失败/, 'returning to the failed local source should expose its retry state');
  assert.equal(helpers.loadMoreShows(), false, 'a queued auto-load callback must not revive remote cards in a failed local tab');
}

{
  let finishOldRequest;
  let calls = 0;
  const rows = prefix => Array.from({ length: 5 }, (_, i) => ({ show: { id: i + 1, name: `${prefix}${i}`, type: 'Scripted', status: 'Running' } }));
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, fetchImpl: async () => {
    calls++;
    if (calls === 1) return await new Promise(resolve => { finishOldRequest = resolve; });
    return { ok: true, json: async () => rows('新请求') };
  } });
  helpers.setAllData({ lastUpdated: '2026-09-27', koreanDramas: [], chineseVariety: [] });
  const oldRequest = helpers.switchTab('tvmaze');
  helpers.switchTab('korean');
  await helpers.switchTab('tvmaze');
  finishOldRequest({ ok: true, json: async () => rows('已取消请求') });
  await oldRequest;
  await helpers.switchTab('tvmaze');
  assert.match(elements.showGrid.innerHTML, /新请求/);
  assert.doesNotMatch(elements.showGrid.innerHTML, /已取消请求/, 'late responses must not overwrite the newer shared cache');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setAllData({ lastUpdated: '2026-09-27', koreanDramas: Array.from({ length: 30 }, (_, i) => ({ title: `键盘加载${i}` })), chineseVariety: [] });
  helpers.switchTab('korean', { animate: false });
  helpers.bindLoadMore();
  elements.loadMoreButton.dispatch('click');
  assert.equal((elements.showGrid.innerHTML.match(/<article class="show-card/g) || []).length, 30, 'manual keyboard-accessible loading must work alongside automatic loading');
  assert.equal(elements.loadMore.hidden, true);
}

// Verify the actual deployment projection, not only the full source dataset.
{
  const buildDir = mkdtempSync(join(tmpdir(), 'iyf-projection-test-'));
  try {
    const output = join(buildDir, 'shows.json');
    execFileSync(process.execPath, [join(root, 'scripts/build-public-data.mjs'), '--output', output]);
    const published = JSON.parse(readFileSync(output, 'utf8'));
    const source = JSON.parse(read('data/shows.json'));
    for (const category of ['koreanDramas', 'chineseVariety']) {
      assert.equal(published[category].length, source[category].length);
      for (const [i, show] of source[category].entries()) {
        for (const field of ['firstSeenAt', 'scrapedAt', 'updateMsg', 'descriptionSource']) {
          assert.deepEqual(published[category][i][field], show[field], `public projection must retain ${field} for ${show.title}`);
        }
        assert.equal(published[category][i].aiScoreInputHash, undefined, 'internal scoring metadata must not leak into the public payload');
      }
    }
    const helpers = loadAppHelpers();
    assert.ok(helpers.isShowDataset(published), 'the deployed artifact must satisfy the frontend contract');
  } finally {
    rmSync(buildDir, { recursive: true });
  }
}

{
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'test' },
    fetchImpl: aiFetchWithContent('{"results":[{"id":"low","ok":true,"recommendationScore100":39,"recommendationLevel":"weak","r":"不够推荐"},{"id":"threshold","ok":true,"recommendationScore100":40,"recommendationLevel":"moderate","r":"达到门槛"}]}'),
  });
  const accepted = await helpers.aiEvaluateDiscovery([{ id: 'low', title: '低分' }, { id: 'threshold', title: '门槛' }]);
  assert.deepEqual(plain(accepted.map(s => s.id)), ['threshold'], 'AI discovery must enforce the score threshold even if ok is true');
}

{
  let scoredPrompt = '';
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'test' },
    fetchImpl: async (_url, options) => {
      scoredPrompt = JSON.parse(options.body).messages[1].content;
      return mockResponse({ json: { choices: [{ message: { content: '{"results":[{"id":"ai-desc","recommendationScore100":9,"recommendationLevel":"weak","r":"资料有限"}]}' } }] } });
    },
  });
  await helpers.aiScoreShows([{ id: 'ai-desc', title: '生成文案', descriptionSource: 'ai', description: '模型虚构剧情' }]);
  assert.doesNotMatch(scoredPrompt, /模型虚构剧情/, 'generated descriptions must not become scoring facts');
  const live = helpers.normalizeItem({ mediaKey: 'source', title: '来源替换', description: '已验证来源剧情简介' });
  const merged = helpers.mergePreviousShowState(live, { descriptionSource: 'ai', description: '旧AI文案' });
  assert.equal(merged.descriptionSource, 'yfsp', 'replacing an AI description must replace its provenance too');
}

{
  let abortedBody = false;
  const { helpers } = loadScrapeHelpers({
    setTimeoutImpl: fn => setTimeout(fn, 15), clearTimeoutImpl: clearTimeout,
    fetchImpl: async (_url, { signal }) => ({ ok: true, json: async () => {
      try { return await abortedFetch(signal); } finally { abortedBody = signal.aborted; }
    } }),
  });
  await helpers.enrichDescriptions([{ id: 'wiki-only', title: '维基简介', wikipediaUrl: 'https://zh.wikipedia.org/wiki/Test', description: '' }]);
  assert.equal(abortedBody, true, 'Wikipedia-only enrichment must run and abort a stalled response body');
}

{
  let bodySignal;
  const helpers = loadAppHelpers({
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      json: () => {
        bodySignal = signal;
        return abortedFetch(signal);
      },
    }),
  });
  await assert.rejects(helpers.fetchJSONWithTimeout('data/shows.json', {}, 20), { name: 'AbortError' },
    'the data deadline should abort a stalled response body, not only the response headers');
  assert.equal(bodySignal.aborted, true);
}

{
  const { renderCardActions, renderCard, safeExternalUrl } = loadAppHelpers();
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
  assert.equal(safeExternalUrl("https://example.com/demo's"), 'https://example.com/demo%27s', 'valid apostrophes in URL paths should be encoded');
  assert.equal(safeExternalUrl('https://evil.com/<script>'), '', 'safe URL helper should reject URLs containing angle brackets');
  for (const control of ['\u0000', '\u0009', '\u000A', '\u000D', '\u001F', '\u007F']) {
    assert.equal(safeExternalUrl('https://example.com/demo' + control + 's'), '', 'URL control characters must still be rejected');
  }
  assert.equal(safeExternalUrl('https://user:password@example.com/path'), '', 'URLs containing credentials must still be rejected');
  assert.equal(safeExternalUrl('https://evil.com/path', new Set(['www.tvmaze.com'])), '', 'remote source host guards must still reject unrelated hosts');
  assert.equal(safeExternalUrl('https://www.tvmaze.com.evil.com/path', new Set(['www.tvmaze.com'])), '', 'remote host guards must reject hostname suffix tricks');
  assert.equal(safeExternalUrl("https://www.tvmaze.com/shows/demo's", new Set(['www.tvmaze.com'])), 'https://www.tvmaze.com/shows/demo%27s', 'allowed remote hosts should retain valid quoted paths');

  const zeroBadge = renderCard({ title: '零分测试', aiScore: 0, score: 0, coverImg: '', recommendScore: 0 }, 0);
  assert.match(zeroBadge, /🤖 0\/100/, 'AI score badge should render valid score 0');
  const responsivePoster = renderCard({ title: '响应式海报', coverImg: 'https://image.tmdb.org/t/p/original/poster.jpg', recommendScore: 0 }, 0);
  assert.match(responsivePoster, /w185\/poster\.jpg 185w/, 'poster srcset should include a mobile-sized image candidate');
  assert.match(responsivePoster, /sizes="\(max-width: 480px\) 112px/, 'poster sizes should match the compact mobile card width');
  assert.match(renderCard({ title: '延迟海报', coverImg: 'https://image.tmdb.org/t/p/original/poster.jpg', recommendScore: 0 }, 2), /loading="lazy"/, 'non-viewport posters should remain lazy');
  assert.match(renderCard({ title: '待升级封面', tmdbCoverPending: true, coverImg: '', recommendScore: 0 }, 0), /封面待升级/, 'pending TMDB cover status should be visible on recommendation cards');
  const unsafeCover = renderCard({ title: '坏图测试', coverImg: 'javascript:alert(1)', score: 0, recommendScore: 0 }, 0);
  assert.doesNotMatch(unsafeCover, /src="javascript:/, 'non-http cover URLs should render a placeholder instead of an image');
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

  const newVarietyHelpers = loadAppHelpers({ dateImpl: fixedDate(2026) });
  newVarietyHelpers.setAllData({
    lastUpdated: '2026-08-13T00:00:00Z', stats: {}, koreanDramas: [],
    chineseVariety: [
      { title: '今年综艺', year: 2026, isClassic: false },
      { title: '老牌经典', year: 2015, isClassic: true },
    ],
  });
  newVarietyHelpers.switchTab('variety2026');
  assert.deepEqual(
    newVarietyHelpers.getCurrentShows().map(s => s.title),
    ['今年综艺'],
    'new variety tab should not mix classic shows into current-year results'
  );
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setAllData({
    lastUpdated: '2026-08-29T00:00:00Z',
    koreanDramas: [{
      id: 'apostrophe-path',
      title: "Editor's 韩剧",
      mediaType: '电视剧',
      year: 2026,
      coverImg: "https://image.tmdb.org/t/p/original/demo's.jpg",
      primaryUrl: "https://www.yfsp.tv/play/demo's",
      primaryUrlSource: 'yfsp',
      yfspUrl: "https://www.yfsp.tv/play/demo's",
    }],
    chineseVariety: [],
  });
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.showGrid.innerHTML, /src="https:\/\/image\.tmdb\.org\/t\/p\/original\/demo%27s\.jpg"/, 'valid quoted poster paths must render an image');
  assert.match(elements.showGrid.innerHTML, /w185\/demo%27s\.jpg 185w/, 'responsive poster candidates must preserve the encoded quoted path');
  assert.match(elements.showGrid.innerHTML, /href="https:\/\/www\.yfsp\.tv\/play\/demo%27s"/, 'valid quoted primary paths must remain actionable');
  assert.match(elements.showGrid.innerHTML, /观看 \/ 详情/);
  assert.match(elements.showGrid.innerHTML, /Editor&#39;s 韩剧/, 'the real card must keep HTML text escaped');
  assert.doesNotMatch(elements.showGrid.innerHTML, /class="placeholder"/);

  for (const url of [
    'https://example.com/" onerror="alert(1)',
    'https://example.com/<script>alert(1)</script>',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/poster.jpg',
    'https://user:password@example.com/path',
    'https://example.com/demo\u0000s',
  ]) {
    const card = helpers.renderCard({ title: '不安全来源', coverImg: url, primaryUrl: url, yfspUrl: url }, 0);
    assert.doesNotMatch(card, /<img |<a /, 'unsafe source URLs must not become poster or action attributes');
  }
}

{
  let intersectionCallback;
  const { document, elements } = createAppDocument();
  const windowImpl = {
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    IntersectionObserver: class {
      constructor(callback) {
        intersectionCallback = callback;
      }
      observe() {}
    },
  };
  const helpers = loadAppHelpers({ documentImpl: document, windowImpl });
  helpers.setAllData({
    lastUpdated: '2026-08-13T00:00:00Z',
    stats: {},
    chineseVariety: [],
    koreanDramas: Array.from({ length: 30 }, (_, index) => ({
      title: `自动加载测试${index}`,
      year: 2026,
    })),
  });
  helpers.switchTab('korean');
  helpers.bindLoadMore();
  assert.equal(elements.loadMore.hidden, false, 'the auto-load sentinel should remain active while more results exist');
  assert.equal(typeof intersectionCallback, 'function', 'loading more should register an intersection callback');
  intersectionCallback([{ isIntersecting: true }]);
  assert.equal(
    (elements.showGrid.innerHTML.match(/<article class="show-card/g) || []).length,
    30,
    'approaching the bottom should append the next batch without a click'
  );
  assert.equal(elements.loadMore.hidden, true, 'the auto-load sentinel should hide after all results are rendered');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setAllData({
    lastUpdated: '2026-08-13T00:00:00Z', stats: {}, chineseVariety: [],
    koreanDramas: [
      { id: 'older', title: '较早更新', year: 2026, isNew: true, firstSeenAt: '2026-01-01', publishTime: '2026-01-01', coverImg: '', primaryUrl: '' },
      { id: 'newer', title: '最新更新', year: 2026, isNew: true, firstSeenAt: '2026-08-01', publishTime: '2026-08-01', coverImg: '', primaryUrl: '' },
      { id: 'current-but-not-new', title: '当年但非新加入', year: 2026, isNew: false, firstSeenAt: '2026-08-15', publishTime: '2026-08-15', coverImg: '', primaryUrl: '' },
    ],
  });
  helpers.switchTab('new');
  assert.equal(elements.sortBy.value, 'newest', 'latest tab should select newest sorting by default');
  assert.ok(elements.showGrid.innerHTML.indexOf('最新更新') < elements.showGrid.innerHTML.indexOf('较早更新'), 'latest tab should render newest publish time first');
  assert.doesNotMatch(elements.showGrid.innerHTML, /当年但非新加入/, 'new tab should require an explicit recently-added marker instead of the calendar year');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, dateImpl: fixedInstant('2026-08-29T16:00:00Z') });
  helpers.setAllData({
    lastUpdated: '2026-08-29T00:00:00Z', stats: {}, chineseVariety: [],
    koreanDramas: [
      { id: 'classic', title: '明确经典', year: 2015, isClassic: true, score: 7.8, coverImg: '', primaryUrl: '' },
      { id: 'high-score', title: '高分但非经典', year: 2026, isClassic: false, score: 9.5, coverImg: '', primaryUrl: '' },
    ],
  });
  helpers.switchTab('classic');
  assert.match(elements.showGrid.innerHTML, /明确经典/, 'classic tab should include explicitly curated classics');
  assert.doesNotMatch(elements.showGrid.innerHTML, /高分但非经典/, 'classic tab should not turn every high-score or new show into a classic');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, dateImpl: fixedInstant('2026-08-29T16:00:00Z') });
  helpers.setAllData({
    lastUpdated: '2026-08-29T00:00:00Z', stats: {}, chineseVariety: [],
    koreanDramas: [
      { id: 'high-recommend', title: '高推荐', year: 2026, recommendScore: 200, aiScore: 9, score: 8.5, coverImg: '', primaryUrl: '' },
      { id: 'low-recommend', title: '低推荐', year: 2026, recommendScore: 100, aiScore: 8.3, score: 7.5, coverImg: '', primaryUrl: '' },
    ],
  });
  helpers.switchTab('korean');
  assert.match(elements.showGrid.innerHTML, /相对推荐度 100%/, 'the strongest recommendation should fill the relative recommendation bar');
  assert.match(elements.showGrid.innerHTML, /相对推荐度 50%/, 'relative recommendation bars should preserve differences between cards');
  assert.match(elements.showGrid.innerHTML, /🤖 9\/100/, 'valid low AI scores must not be inflated by guessing their scale');
  assert.match(elements.showGrid.innerHTML, /🤖 8.3\/100/, 'decimal AI scores must retain the declared 0-100 scale');
  assert.doesNotMatch(elements.showGrid.innerHTML, /card-score-float/, 'score should not be duplicated as a poster overlay');
}

{
  const helpers = loadAppHelpers({ dateImpl: fixedInstant('2026-08-29T16:00:00Z') });
  assert.deepEqual(plain(helpers.getDataFreshness('2026-08-29T15:30:00Z', Date.parse('2026-08-29T16:00:00Z'))), { label: '刚刚更新', stale: false });
  assert.deepEqual(plain(helpers.getDataFreshness('2026-08-27T15:30:00Z', Date.parse('2026-08-29T16:00:00Z'))), { label: '约2天前更新', stale: true }, 'stale data should be called out after the freshness threshold');
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, dateImpl: fixedInstant('2026-08-29T16:00:00Z') });
  helpers.setAllData({
    lastUpdated: '2026-08-29T00:00:00Z', stats: {},
    koreanDramas: [{ id: 'drama', title: '汉江警察', year: 2026, coverImg: '', primaryUrl: '' }],
    chineseVariety: [{ id: 'variety', title: '奔跑吧', mediaType: '综艺', year: 2026, updateMsg: '周五', coverImg: '', primaryUrl: '' }],
  });
  elements.searchInput.value = '奔跑吧';
  helpers.switchTab('korean');
  assert.match(elements.emptyMessage.textContent, /暂无符合/u, 'search should stay within the currently selected category');
  helpers.switchTab('variety');
  assert.match(elements.showGrid.innerHTML, /周五/u, 'variety cards should show the source update message when status text is absent');
}

{
  const { document, elements } = createAppDocument();
  const location = {
    search: '?status=all',
    hash: '#korean',
    href: 'http://localhost/?status=all#korean',
    slice(n) { return this.hash.slice(n); },
  };
  const helpers = loadAppHelpers({ documentImpl: document, dateImpl: fixedDate(2026), locationImpl: location });
  helpers.setAllData({
    lastUpdated: '2026-08-13T00:00:00Z', stats: {}, chineseVariety: [],
    koreanDramas: [
      { title: '连载新剧', year: 2026, isComplete: false, isSerial: true, coverImg: '', primaryUrl: '' },
      { title: '完结新剧', year: 2026, isComplete: true, isSerial: false, coverImg: '', primaryUrl: '' },
    ],
  });
  helpers.switchTab('korean');

  location.search = '?status=ongoing';
  location.hash = '#korean';
  location.href = 'http://localhost/?status=ongoing#korean';
  helpers.handleUrlStateChange();
  assert.match(elements.showGrid.innerHTML, /连载新剧/, 'URL state should apply the ongoing filter on the active tab');

  location.search = '?status=complete';
  location.hash = '#year2026';
  location.href = 'http://localhost/?status=complete#year2026';
  helpers.handleUrlStateChange();
  assert.equal(elements.filterStatus.value, 'complete', 'URL navigation should restore the filter control');
  assert.match(elements.showGrid.innerHTML, /完结新剧/, 'URL navigation should render the new tab with URL filters');
  assert.doesNotMatch(elements.showGrid.innerHTML, /连载新剧/, 'URL navigation should not leave the previous tab filter applied');
}

{
  const helpers = loadAppHelpers({ dateImpl: fixedInstant('2026-08-29T16:00:00Z') });
  assert.equal(helpers.getScheduleDateKey(Date.parse('2026-08-29T16:00:00Z')), '2026-08-30', 'TVmaze should use the Korea-local calendar date');
  assert.deepEqual(
    plain(helpers.buildScheduleDateKeys(Date.parse('2026-08-29T16:00:00Z'), 3)),
    ['2026-08-30', '2026-08-29', '2026-08-28'],
    'TVmaze history should walk back across Korea-local dates'
  );
  const sorted = helpers.sortTVmazeShows([
    { name: '昨日', airDate: '2026-08-29', latestEpisode: { airtime: '21:00' }, rating: { average: 9.9 } },
    { name: '今日晚', airDate: '2026-08-30', latestEpisode: { airtime: '22:00' }, rating: { average: 9.9 } },
    { name: '今日早', airDate: '2026-08-30', latestEpisode: { airtime: '19:00' }, rating: { average: 7.0 } },
  ]);
  assert.deepEqual(plain(sorted.map(show => show.name)), ['今日早', '今日晚', '昨日'], 'TVmaze cards should follow air date and airtime rather than rating alone');
}

for (const hasStaleCache of [false, true]) {
  const { document, elements } = createAppDocument();
  const cachedAt = Date.parse('2026-08-20T00:00:00Z');
  const calls = [];
  const helpers = loadAppHelpers({
    documentImpl: document,
    dateImpl: fixedInstant('2026-08-29T16:00:00Z'),
    windowImpl: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
    fetchImpl: async url => {
      const date = new URL(url).searchParams.get('date');
      calls.push(date);
      return { ok: date !== '2026-08-30', status: date === '2026-08-30' ? 503 : 200, json: async () => [] };
    },
  });
  if (hasStaleCache) {
    helpers.setTVmazeCache([{
      id: 3, name: '仍可阅读的旧时间表', status: 'Running', airDate: '2026-08-20',
      latestEpisode: { season: 1, number: 4, airtime: '20:00' },
    }], cachedAt);
  }
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, 7, 'a failed current day should still try recent history');
  if (hasStaleCache) {
    assert.match(elements.showGrid.innerHTML, /仍可阅读的旧时间表/, 'empty history must not erase the last useful schedule when today failed');
    assert.match(elements.updateInfo.textContent, /缓存可能已过期/, 'the preserved schedule must remain marked as stale');
    assert.ok(elements.updateInfo.textContent.endsWith(new Date(cachedAt).toLocaleDateString('zh-CN')), 'failed empty refreshes must preserve the old cache timestamp');
    assert.notEqual(elements.empty.style.display, 'block');
    await helpers.switchTab('tvmaze');
    assert.match(elements.showGrid.innerHTML, /仍可阅读的旧时间表/, 'subsequent failures must retain the same useful cache');
  } else {
    assert.match(elements.emptyMessage.textContent, /TVmaze 数据加载失败/, 'failed today plus empty history must remain an error without a cache');
    assert.equal(elements.emptyAction.hidden, false, 'an unknown current schedule must offer retry');
    assert.equal(typeof elements.emptyAction.onclick, 'function');
    assert.match(elements.updateInfo.textContent, /加载失败/);
    await elements.emptyAction.onclick();
  }
  assert.equal(calls.length, 14, 'failed empty refreshes must not create or refresh the fifteen-minute cache');
}

{
  const { document, elements } = createAppDocument();
  const calls = [];
  const now = Date.parse('2026-08-29T16:00:00Z');
  const helpers = loadAppHelpers({
    documentImpl: document,
    dateImpl: fixedInstant('2026-08-29T16:00:00Z'),
    fetchImpl: async url => {
      calls.push(new URL(url).searchParams.get('date'));
      return { ok: true, json: async () => [] };
    },
  });
  helpers.setTVmazeCache([{ id: 4, name: '已过期的节目', status: 'Running' }], now - 24 * 60 * 60 * 1000);
  await helpers.switchTab('tvmaze');
  assert.equal(calls[0], '2026-08-30');
  assert.equal(helpers.getCurrentShows().length, 0, 'a confirmed empty day may replace the old schedule');
  assert.match(elements.emptyMessage.textContent, /今日暂无韩国电视剧播出/, 'a successful empty day must keep the normal empty state');
  assert.equal(elements.emptyAction.hidden, true);
  assert.match(elements.updateInfo.textContent, /^TVmaze 韩剧时间表:/);
  const firstRequestCount = calls.length;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, firstRequestCount, 'confirmed empty schedules should still use the normal cache TTL');
}

{
  const { document, elements } = createAppDocument();
  const calls = [];
  const now = Date.parse('2026-08-29T16:00:00Z');
  const helpers = loadAppHelpers({
    documentImpl: document,
    dateImpl: fixedInstant('2026-08-29T16:00:00Z'),
    fetchImpl: async url => {
      const date = new URL(url).searchParams.get('date');
      calls.push(date);
      if (date === '2026-08-30') return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => date === '2026-08-29'
          ? [
            { show: { id: 2, name: 'Ask Us Anything', type: 'Reality', status: 'Running', rating: { average: 9.1 }, genres: [], network: null, image: null, url: 'https://www.tvmaze.com/shows/2/reality', summary: '' }, season: 1, number: 2, airtime: '19:00' },
            { show: { id: 1, name: '回退剧', type: 'Scripted', status: 'Running', rating: { average: 7.5 }, genres: [], network: null, image: null, url: 'https://www.tvmaze.com/shows/1/fallback', summary: '' }, season: 1, number: 2, airtime: '20:00' },
          ]
          : [],
      };
    },
  });
  helpers.setAllData({ lastUpdated: '2026-08-29T00:00:00Z', stats: {}, koreanDramas: [], chineseVariety: [] });
  helpers.setTVmazeCache([{ id: 3, name: '应该替换的旧节目', status: 'Running' }], now - 24 * 60 * 60 * 1000);
  await helpers.switchTab('tvmaze');
  assert.equal(calls[0], '2026-08-30', 'TVmaze should request the Korea-local current date first');
  assert.match(elements.showGrid.innerHTML, /回退剧/, 'a failed current-day request should fall back to recent successful days');
  assert.doesNotMatch(elements.showGrid.innerHTML, /Ask Us Anything/, 'TVmaze Korean drama schedule should exclude reality and variety programmes');
  assert.match(elements.showGrid.innerHTML, /8月29日/, 'TVmaze cards should show the actual schedule date');
  assert.doesNotMatch(elements.showGrid.innerHTML, /应该替换的旧节目/, 'real historical results should replace the stale fallback');
  assert.match(elements.updateInfo.textContent, /部分日期暂不可用/, 'a failed current day must disclose the partial historical fallback');
  const firstRequestCount = calls.length;
  await helpers.switchTab('tvmaze');
  assert.equal(calls.length, firstRequestCount, 'successful history fallback should remain cacheable');
  assert.match(elements.showGrid.innerHTML, /回退剧/);
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document, fetchImpl: async (_url, { signal }) => abortedFetch(signal) });
  helpers.setAllData({ lastUpdated: '2026-08-29T00:00:00Z', stats: {}, koreanDramas: [], chineseVariety: [] });
  const pending = helpers.switchTab('tvmaze');
  assert.match(elements.resultSummary.textContent, /正在加载/, 'loading the remote tab should not announce an empty result');
  helpers.switchTab('korean');
  await pending;
}

{
  const { document, elements } = createAppDocument();
  const helpers = loadAppHelpers({ documentImpl: document });
  helpers.setAllData({ lastUpdated: '2026-08-29T00:00:00Z', stats: {}, koreanDramas: [], chineseVariety: [] });
  helpers.setTVmazeCache([{
    id: 4, name: '未评分韩剧', status: 'Running', rating: { average: 0 },
    genres: [], image: null, url: 'https://www.tvmaze.com/shows/4/unrated', summary: '',
    latestEpisode: { season: 1, number: 1, airtime: '21:00' }, airDate: '2026-08-29',
  }]);
  await helpers.switchTab('tvmaze');
  assert.match(elements.showGrid.innerHTML, /未评分韩剧/, 'unrated remote cards should still appear');
  assert.doesNotMatch(elements.showGrid.innerHTML, /⭐ 0\.0/, 'missing ratings must not display as a zero-star score');
}

{
  const { document, elements } = createAppDocument();
  const cachedAt = Date.parse('2026-08-20T00:00:00Z');
  const helpers = loadAppHelpers({
    documentImpl: document,
    dateImpl: fixedInstant('2026-08-29T16:00:00Z'),
    fetchImpl: async () => { throw new Error('TVmaze unavailable'); },
  });
  helpers.setAllData({ lastUpdated: '2026-08-29T00:00:00Z', stats: {}, koreanDramas: [], chineseVariety: [] });
  helpers.setTVmazeCache([{
    id: 3,
    name: '缓存韩剧',
    type: 'Scripted',
    status: 'Running',
    rating: { average: 8.2 },
    genres: ['Drama'],
    network: null,
    image: null,
    url: 'https://www.tvmaze.com/shows/3/cached',
    summary: '',
    latestEpisode: { season: 1, number: 4, airtime: '20:00' },
    airDate: '2026-08-20',
  }], cachedAt);
  await helpers.switchTab('tvmaze');
  assert.match(elements.showGrid.innerHTML, /缓存韩剧/, 'TVmaze should reuse the last successful schedule when the remote request fails');
  assert.match(elements.updateInfo.textContent, /缓存可能已过期/, 'stale TVmaze fallback should be disclosed in the source status');
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
    actor: '新演员', contentType: '搞笑', description: '种子简介足够长，但是缺少本轮来源。', regional: '大陆', lang: '国语',
  }, partial);
  assert.equal(partialApplied.score, 7, 'a missing live score must preserve the curated seed score');
  assert.equal(partialApplied.playCount, 100, 'a missing live play count must preserve the curated seed count');
  const partialWithPrevious = helpers.mergePreviousShowState(partialApplied, {
    ...partialApplied, actor: '旧演员', description: '上一版由真实来源确认的节目简介。', descriptionSource: 'yfsp',
  });
  assert.equal(partialWithPrevious.actor, '新演员', 'curated seed text should win over stale previous text');
  assert.equal(partialWithPrevious.description, '上一版由真实来源确认的节目简介。', 'an unobserved seed description must not replace a previously verified source description');
  assert.equal(partialWithPrevious.descriptionSource, 'yfsp');

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
    version: 16,
    matchedTitle: '菜鸟炊事兵',
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
    scrapedAt: '2026-08-22T00:00:00Z',
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

  const expiredMap = new Map();
  const expiredResult = helpers.restorePreviousCategory(expiredMap, [{
    id: 'expired', title: '已下架推荐', year: 2026, scrapedAt: '2026-06-01T00:00:00Z',
    coverImg: 'https://image.tmdb.org/t/p/original/expired.jpg',
    primaryUrl: 'https://www.yfsp.tv/play/expired',
  }], 'korean_drama', '电视剧', () => 100, 'disc_kd');
  assert.equal(expiredMap.size, 0, 'recommendations absent from the source beyond the retention window should retire');
  assert.equal(expiredResult.expired, 1, 'retired recommendations should be counted for observability');

  assert.doesNotThrow(
    () => helpers.assertOutputContinuity({ koreanDramas: Array(40).fill({}), chineseVariety: Array(40).fill({}) }, { koreanDramas: Array(50).fill({}), chineseVariety: Array(50).fill({}) }),
    'normal output variation should pass the continuity guard'
  );
  assert.throws(
    () => helpers.assertOutputContinuity({ koreanDramas: Array(4).fill({}), chineseVariety: Array(40).fill({}) }, { koreanDramas: Array(50).fill({}), chineseVariety: Array(50).fill({}) }),
    /DATA_GUARD/,
    'a catastrophic category drop should stop the scraper before it overwrites the previous output'
  );

  const previousStable = Array.from({ length: 20 }, (_, index) => ({ id: `stable-${index}`, title: `稳定节目${index}` }));
  const replacement = Array.from({ length: 20 }, (_, index) => ({ id: `replacement-${index}`, title: `替换节目${index}` }));
  assert.throws(
    () => helpers.assertOutputContinuity({ koreanDramas: replacement, chineseVariety: [] }, { koreanDramas: previousStable, chineseVariety: [] }),
    /身份重合度异常/u,
    'a same-sized replacement catalog with no identity overlap should stop the scraper'
  );

  const duplicate = { id: 'duplicate-id', title: '重复节目', category: 'variety', coverImg: 'https://static.yfsp.tv/poster.jpg', primaryUrl: 'https://www.yfsp.tv/play/duplicate' };
  assert.throws(
    () => helpers.assertOutputSchema({ koreanDramas: [], chineseVariety: [duplicate], otherDramas: [{ ...duplicate, title: '重复节目副本' }] }),
    /重复节目 ID/u,
    'output schema should reject IDs duplicated across recommendation categories'
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

  let verifyOptions;
  const redirectGuard = loadScrapeHelpers({
    fetchImpl: async (_url, options) => {
      verifyOptions = options;
      return mockResponse({ status: 503 });
    },
  }).helpers;
  assert.equal(await redirectGuard.verifyYfspUrl(show, 'https://www.yfsp.tv/play/redirect'), 'unknown');
  assert.equal(verifyOptions.redirect, 'error', 'YFSP verification should reject redirects instead of following an untrusted host');

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
  let requestUrl = '';
  let requestBody = null;
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: async (url, options) => {
      openRouterCounter.count++;
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      return mockResponse({ json: { choices: [{ message: { content: '{"results":[{"id":"drama-1","recommendationScore100":88,"recommendationLevel":"strong","r":"合适"}]}' } }] } });
    },
  });
  const show = { id: 'drama-1', title: '浪漫律师', year: 2026, score: 8, playCount: 10000 };
  const scores = await helpers.aiScoreShows([show]);
  assert.equal(scores.get('drama-1')?.score, 88, 'OpenRouter-only AI runs should parse structured result objects');
  assert.equal(scores.get('drama-1')?.version, helpers.AI_SCORE_CACHE_VERSION, 'new AI results should carry the current cache version');
  assert.equal(scores.get('drama-1')?.inputHash, helpers.aiScoreInputHash(show), 'new AI results should be bound to the scored input');
  assert.equal(openRouterCounter.count, 1, 'OpenRouter-only AI runs should call the configured provider');
  assert.equal(requestUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requestBody.model, 'openrouter/free', 'AI scoring should use OpenRouter\'s maintained free router by default');
  assert.equal(requestBody.response_format?.type, 'json_schema', 'AI calls should request strict structured output');
  assert.equal(requestBody.response_format?.json_schema?.strict, true);
  assert.deepEqual(requestBody.response_format?.json_schema?.schema?.properties?.results?.items?.properties?.id?.enum, ['drama-1'], 'the schema must constrain output IDs to the current batch');
  assert.equal(requestBody.provider?.require_parameters, true, 'the router should only select providers that support requested parameters');
  const input = JSON.parse(requestBody.messages[1].content.split('\n').slice(1).join('\n'))[0];
  assert.equal(input.sourceRating10, 8, 'the input rating must explicitly declare its ten-point scale');
  assert.equal(input.score, undefined, 'an ambiguous source score field must not encourage copying it as a recommendation');
  const fields = requestBody.response_format.json_schema.schema.properties.results.items;
  assert.ok(fields.required.includes('recommendationScore100'));
  assert.ok(fields.required.includes('recommendationLevel'));
}

{
  const invalidRows = [
    { id: 'unit-check', s: 9.7, r: '高度推荐' },
    { id: 'unit-check', recommendationScore100: 9.7, recommendationLevel: 'strong', r: '高度推荐' },
    { id: 'unit-check', recommendationScore100: 95, recommendationLevel: 'weak', r: '弱匹配' },
    { id: 'unit-check', recommendationScore100: 50, r: '未声明推荐档位' },
  ];
  for (const row of invalidRows) {
    const { helpers } = loadScrapeHelpers({
      env: { OPENROUTER_API_KEY: 'or-test-key' },
      fetchImpl: aiFetchWithContent(JSON.stringify({ results: [row] })),
    });
    const show = { id: row.id, title: '评分单位测试', score: 9.7, year: 2026 };
    assert.equal((await helpers.aiScoreShows([show])).size, 0, 'ambiguous or contradictory recommendation units must fall back to rule scoring');
    const discovery = loadScrapeHelpers({
      env: { OPENROUTER_API_KEY: 'or-test-key' },
      fetchImpl: aiFetchWithContent(JSON.stringify({ results: [{ ...row, ok: true }] })),
    }).helpers;
    assert.equal((await discovery.aiEvaluateDiscovery([show])).length, 0, 'discovery must enforce the same recommendation-unit contract');
  }
}

{
  let requestBody;
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return mockResponse({ json: { choices: [{ message: { content: '{"results":[]}' } }] } });
    },
  });
  await helpers.aiScoreShows([{ id: 'unrated', title: '暂无来源评分', score: 0 }]);
  const input = JSON.parse(requestBody.messages[1].content.split('\n').slice(1).join('\n'))[0];
  assert.equal(input.sourceRating10, null, 'an unrated show must not be described to the model as a zero-quality show');
  const previous = { id: 'old-scale', title: '旧单位缓存', year: 2026, aiScore: 9.7, aiScoreVersion: 3, aiScoredAt: new Date().toISOString() };
  previous.aiScoreInputHash = helpers.aiScoreInputHash(previous);
  requestBody = null;
  await helpers.aiScoreShows([previous]);
  assert.ok(requestBody, 'the previous ambiguous scoring contract must be invalidated regardless of matching input');
}

{
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: async () => mockResponse({ json: { choices: [{ message: { content: '[{"id":"legacy-ai","recommendationScore100":8.3,"recommendationLevel":"weak","r":"明确弱匹配"}]' } }] } }),
  });
  const scores = await helpers.aiScoreShows([{ id: 'legacy-ai', title: '旧量纲测试', year: 2026 }]);
  assert.equal(scores.get('legacy-ai')?.score, 8.3, 'the 0-100 response contract must preserve valid low scores');
}

{
  const batchSizes = [];
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const ids = body.response_format.json_schema.schema.properties.results.items.properties.id.enum;
      batchSizes.push(ids.length);
      return mockResponse({ json: { choices: [{ message: { content: JSON.stringify({
        results: ids.map(id => ({ id, recommendationScore100: 70, recommendationLevel: 'strong', r: '批次结果' })),
      }) } }] } });
    },
  });
  const shows = Array.from({ length: 11 }, (_, index) => ({
    id: `batch-${index}`,
    title: `批次测试${index}`,
    year: 2026,
    score: 8,
    playCount: 10000,
  }));
  const scores = await helpers.aiScoreShows(shows);
  assert.deepEqual(batchSizes, [10, 1], 'AI batches should stay small enough for the free router to finish structured output');
  assert.equal(scores.size, 11);
}

{
  let messages = [];
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: async (_url, options) => {
      messages = JSON.parse(options.body).messages;
      return mockResponse({ json: { choices: [{ message: { content: '[{"id":"variety-1","recommendationScore100":82,"recommendationLevel":"strong","r":"轻松下饭"}]' } }] } });
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
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('评分结果:\n```json\n[\n  {"id":"pretty-1","recommendationScore100":77,"recommendationLevel":"strong","r":"格式化 JSON"}\n]\n```', prettyCounter),
  });
  const scores = await helpers.aiScoreShows([{ id: 'pretty-1', title: '格式化测试', year: 2026, score: 8, playCount: 10000 }]);
  assert.equal(scores.get('pretty-1')?.score, 77, 'AI parsing should accept prose-wrapped pretty-printed JSON arrays');
}

{
  const objectCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('{"results":[{"id":"object-1","recommendationScore100":66,"recommendationLevel":"moderate","r":"对象包装"}]}', objectCounter),
  });
  const scores = await helpers.aiScoreShows([{ id: 'object-1', title: '对象包装测试', year: 2026, score: 8, playCount: 10000 }]);
  assert.equal(scores.get('object-1')?.score, 66, 'AI parsing should extract arrays from valid JSON object wrappers');
}

{
  const providerCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('[]', providerCounter),
  });
  const cachedZero = { id: 'zero', title: '低分测试', aiScore: 0, aiScoredAt: new Date().toISOString(), year: 2026 };
  cachedZero.aiScoreVersion = helpers.AI_SCORE_CACHE_VERSION;
  cachedZero.aiScoreInputHash = helpers.aiScoreInputHash(cachedZero);
  const scores = await helpers.aiScoreShows([cachedZero]);
  assert.equal(scores.size, 0, 'fresh cached AI score 0 should not need rescoring');
  assert.equal(providerCounter.count, 0, 'fresh cached AI score 0 should not call AI providers');
}

{
  const providerCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('[{"id":"changed","recommendationScore100":55,"recommendationLevel":"moderate","r":"输入已变化"}]', providerCounter),
  });
  const changed = {
    id: 'changed', title: '缓存输入变化', year: 2026, score: 8, playCount: 10000,
    aiScore: 0, aiScoredAt: new Date().toISOString(), aiScoreVersion: helpers.AI_SCORE_CACHE_VERSION,
    aiScoreInputHash: 'stale-input-hash',
  };
  const scores = await helpers.aiScoreShows([changed]);
  assert.equal(providerCounter.count, 1, 'a current-version cache entry with a stale input hash should be rescored');
  assert.equal(scores.get('changed')?.score, 55, 'rescoring should replace the stale cached value, including a previous score of 0');
  assert.equal(scores.get('changed')?.inputHash, helpers.aiScoreInputHash(changed), 'the replacement score should carry the current input hash');
}

{
  let fetchCount = 0;
  const { helpers } = loadScrapeHelpers({
    env: { GITHUB_TOKEN: 'retired-provider-token' },
    fetchImpl: async () => { fetchCount++; throw new Error('retired GitHub Models must not be called'); },
  });
  const scores = await helpers.aiScoreShows([{ id: 'no-provider', title: '无可用提供商', year: 2026 }]);
  assert.equal(scores.size, 0);
  assert.equal(fetchCount, 0, 'a GitHub token alone must not call the retired GitHub Models service');
}

{
  let requestedModel = '';
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key', OPENROUTER_MODEL: 'vendor/custom:free' },
    fetchImpl: async (_url, options) => {
      requestedModel = JSON.parse(options.body).model;
      return mockResponse({ json: { choices: [{ message: { content: '{"results":[{"id":"override","recommendationScore100":0,"recommendationLevel":"weak","r":"明确低分"}]}' } }] } });
    },
  });
  const scores = await helpers.aiScoreShows([{ id: 'override', title: '模型覆盖测试', year: 2026 }]);
  assert.equal(requestedModel, 'vendor/custom:free', 'OPENROUTER_MODEL should override the default router explicitly');
  assert.equal(scores.get('override')?.score, 0, 'a valid returned score of zero must not be mistaken for a missing result');
}

{
  const invalidCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('{"results":[{"id":"wrong-batch-id","recommendationScore100":99,"recommendationLevel":"strong","r":"不应接受"},{"id":"expected-id","recommendationScore100":"99","recommendationLevel":"strong","r":"类型错误"}]}', invalidCounter),
  });
  const scores = await helpers.aiScoreShows([{ id: 'expected-id', title: '批次边界测试', year: 2026 }]);
  assert.equal(invalidCounter.count, 1);
  assert.equal(scores.size, 0, 'HTTP 200 output with wrong IDs or schema types must be rejected');
}

{
  let schemaName = '';
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: async (_url, options) => {
      schemaName = JSON.parse(options.body).response_format?.json_schema?.name;
      return mockResponse({ json: { choices: [{ message: { content: '{"results":[{"id":"disc-1","ok":false,"recommendationScore100":12,"recommendationLevel":"weak","r":"内容风险"}]}' } }] } });
    },
  });
  const discovered = [{ id: 'disc-1', title: '新发现', year: 2026, mediaType: '电视剧', regional: '韩国', score: 8, playCount: 10000 }];
  const accepted = await helpers.aiEvaluateDiscovery(discovered);
  assert.equal(schemaName, 'iyf_discovery');
  assert.equal(accepted.length, 0, 'validated discovery decisions should filter explicitly rejected candidates');
  assert.equal(discovered[0].aiDiscoveryScore, 12);
}

{
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('{"results":[]}'),
  });
  const discovered = [{ id: 'disc-empty', title: '空结果新发现', year: 2026, mediaType: '电视剧', regional: '韩国', score: 8, playCount: 10000 }];
  const accepted = await helpers.aiEvaluateDiscovery(discovered);
  assert.equal(accepted.length, 0, 'an empty AI discovery response must fail closed instead of accepting every candidate');
}

{
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('{"results":[{"id":"desc-1","d":"这是一段经过结构校验、适合展示的中文推荐文案。"}]}'),
  });
  const shows = [{ id: 'desc-1', title: '文案测试', year: 2026, description: '' }];
  assert.equal(await helpers.aiEnhanceDescriptions(shows), 1);
  assert.equal(shows[0].descriptionSource, 'ai');
  assert.match(shows[0].description, /结构校验/u);
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
  assert.equal(helpers.isRenderableShow({ id: 'fallback', title: '兜底节目', category: 'korean_drama', coverImg: 'https://static.yfsp.tv/poster.jpg', coverSource: 'yfsp', primaryUrl: 'https://www.yfsp.tv/play/x' }), false, 'Korean fallback covers must carry the pending TMDB marker');
  assert.equal(helpers.isRenderableShow({ id: 'fallback-marked', title: '已标记兜底节目', category: 'korean_drama', coverImg: 'https://static.yfsp.tv/poster.jpg', coverSource: 'yfsp', tmdbCoverPending: true, primaryUrl: 'https://www.yfsp.tv/play/x' }), true, 'marked Korean fallback covers should remain renderable');
  assert.equal(helpers.isRenderableShow({ id: 'variety-fallback', title: '综艺兜底', category: 'variety', coverImg: 'https://static.yfsp.tv/poster.jpg', coverSource: 'yfsp', primaryUrl: 'https://www.yfsp.tv/play/x' }), true, 'non-Korean categories may still use a valid fallback cover');
  assert.equal(helpers.isRenderableShow({ id: 'wrong-season-link', title: '黑暗荣耀第2季', category: 'korean_drama', coverImg: 'https://image.tmdb.org/t/p/original/glory.jpg', coverSource: 'tmdb', tmdbUrl: 'https://www.themoviedb.org/tv/136283', primaryUrl: 'https://www.themoviedb.org/tv/136283' }), false, 'season-specific cards must not render with a series-level TMDB link');

  const hardExcluded = new Map([
    ['bad', { id: 'bad', title: '恐怖测试', description: '恐怖丧尸题材', category: 'korean_drama' }],
    ['good', { id: 'good', title: '轻松测试', description: '轻松喜剧', category: 'korean_drama' }],
  ]);
  assert.equal(helpers.removeHardExcludedKDrama(hardExcluded), 1, 'hard Korean drama exclusions should apply to every ingestion path');
  assert.equal(hardExcluded.has('good'), true, 'eligible Korean dramas should survive the final exclusion pass');

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
  const show = {
    id: 'tmdb-unavailable',
    title: '订阅男友',
    year: 2026,
    mediaType: '电视剧',
    regional: '韩国',
    category: 'korean_drama',
    coverImg: 'https://www.yfsp.tv/poster.jpg',
    yfspUrl: 'https://www.yfsp.tv/play/demo',
    primaryUrl: 'https://www.yfsp.tv/play/demo',
  };
  await helpers.enrichCoversFromTMDB([show]);
  const savedCache = JSON.parse([...writes.values()].at(-1) || '{}');
  assert.notEqual(savedCache['tmdb-unavailable']?.notFound, true, 'missing TMDB token should not write a negative notFound cache entry');
  assert.equal(show.coverSource, 'yfsp', 'a Korean fallback should retain the YFSP source marker when TMDB is unavailable');
  assert.equal(show.tmdbCoverPending, true, 'a Korean fallback should be marked for later TMDB upgrade');
  assert.equal(helpers.isRenderableShow(show), true, 'a marked Korean fallback should remain renderable');
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
  assert.notEqual(show.tmdbCoverPending, true, 'TMDB success should clear the pending fallback marker');
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
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/tv/276470?language=zh-CN')) {
        return mockResponse({ json: { id: 276470, name: '好吧离婚吧', poster_path: '/divorce-original.jpg' } });
      }
      if (textUrl.includes('/tv/276470/external_ids')) return mockResponse({ json: {} });
      throw new Error(`unexpected TMDB direct lookup URL: ${textUrl}`);
    },
  });
  const show = {
    id: 'a8mnHC2VzyH',
    title: '好，我们离婚吧',
    year: 2026,
    mediaType: '电视剧',
    regional: '韩国',
    category: 'korean_drama',
    coverImg: 'https://static.yfsp.tv/upload/video/divorce.gif',
    primaryUrl: 'https://www.yfsp.tv/play/a8mnHC2VzyH',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/divorce-original.jpg', 'the new Korean drama should use its manually verified TMDB poster');
  assert.equal(show.coverSource, 'tmdb', 'manual TMDB ID matches should be marked as TMDB');
  assert.notEqual(show.tmdbCoverPending, true, 'manual TMDB matches should clear the pending fallback marker');
  assert.equal(show.tmdbUrl, 'https://www.themoviedb.org/tv/276470', 'manual TMDB ID matches should retain the canonical TMDB link');
}

{
  const requests = [];
  const { helpers } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async url => {
      const textUrl = String(url);
      requests.push(textUrl);
      if (textUrl.includes('/tv/220074?language=zh-CN')) {
        return mockResponse({ json: { id: 220074, name: '财阀X刑警', origin_country: ['KR'] } });
      }
      if (textUrl.includes('/tv/220074/season/2?language=zh-CN')) {
        return mockResponse({ json: {
          id: 401234, name: '第 2 季', season_number: 2,
          air_date: '2026-08-07', poster_path: '/flex-x-cop-season-2.jpg',
        } });
      }
      if (textUrl.includes('/tv/220074/external_ids')) return mockResponse({ json: {} });
      throw new Error(`unexpected TMDB season-direct URL: ${textUrl}`);
    },
  });
  const found = await helpers.searchTMDBImage({
    title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
    tmdbUrl: 'https://www.themoviedb.org/tv/220074',
  });
  assert.equal(requests[0], 'https://api.themoviedb.org/3/tv/220074?language=zh-CN', 'a published link must prove its series identity before providing a season poster');
  assert.equal(found.url, 'https://image.tmdb.org/t/p/original/flex-x-cop-season-2.jpg', 'known TMDB series IDs should resolve the exact season poster');
  assert.equal(found.tmdbUrl, 'https://www.themoviedb.org/tv/220074/season/2', 'season matches should link to the TMDB season page');
  assert.equal(found.tmdbId, 220074, 'season matches should retain the parent TMDB series ID');
  assert.equal(found.tmdbSeasonNumber, 2, 'season matches should persist the numeric season for cache validation');
  assert.equal(helpers.titleMatches(found.matchedTitle, '财阀X刑警第2季'), true, 'season matches should retain a cache-valid matched title');
}

{
  const { helpers, writes } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    initialFiles: {
      ['/tmp/iyf-test/scripts/../data/image_cache.json']: JSON.stringify({ flex: {
        title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', source: 'tmdb',
        version: 15, negativeLookupVersion: 2, notFound: true,
      } }),
    },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return mockResponse({ json: {
          results: [{
            id: 220074, name: '财阀X刑警', original_name: 'Flex X Cop',
            first_air_date: '2024-01-26', poster_path: '/series-poster.jpg', origin_country: ['KR'],
          }],
        } });
      }
      if (textUrl.includes('/tv/220074/season/2')) {
        return mockResponse({ json: {
          id: 401234, name: '第 2 季', season_number: 2,
          air_date: '2026-08-07', poster_path: '/searched-season-2.jpg',
        } });
      }
      if (textUrl.includes('/tv/220074/external_ids')) return mockResponse({ json: {} });
      throw new Error(`unexpected TMDB season-search URL: ${textUrl}`);
    },
  });
  const show = {
    id: 'flex', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
    category: 'korean_drama', coverImg: 'https://static.yfsp.tv/flex.gif',
    yfspCoverImg: 'https://static.yfsp.tv/flex.gif', coverSource: 'yfsp',
    primaryUrl: 'https://www.yfsp.tv/play/flex',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/searched-season-2.jpg', 'a base-series search hit should be upgraded through its exact TMDB season endpoint');
  assert.equal(show.tmdbUrl, 'https://www.themoviedb.org/tv/220074/season/2', 'enrichment should publish the season-level TMDB URL');
  assert.equal(show.coverSource, 'tmdb', 'a successful season lookup should replace the YFSP fallback');
  const savedCache = JSON.parse([...writes.values()].at(-1) || '{}');
  assert.equal(savedCache.flex?.version, 16, 'season lookup should write the current cache version');
  assert.equal(savedCache.flex?.tmdbSeasonNumber, 2, 'season lookup should make the season identity durable in cache');
  assert.equal(savedCache.flex?.matchedSeriesTitle, '财阀X刑警', 'reusable season caches must retain the title observed from the matched TMDB entity');
  assert.equal(helpers.isReusableTMDBCoverCache(savedCache.flex, show), true, 'a season cache must be reusable only after both numeric and URL season validation pass');
}

{
  const cachePath = '/tmp/iyf-test/scripts/../data/image_cache.json';
  const retryNow = Date.parse('2026-08-21T12:00:00Z');
  const RetryDate = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-08-21T12:00:00Z']));
    }
    static now() {
      return retryNow;
    }
  };
  const { helpers } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    dateImpl: RetryDate,
    initialFiles: {
      [cachePath]: JSON.stringify({ pending: {
        title: '待补高清测试', year: 2026, mediaType: '电视剧', source: 'tmdb', version: 16,
        negativeLookupVersion: 2, notFound: true, cachedAt: '2026-08-21T00:00:00Z',
      } }),
    },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return mockResponse({ json: {
          results: [{
            id: 54321,
            name: '待补高清测试',
            original_name: '待补高清测试',
            poster_path: '/pending-original.jpg',
            origin_country: ['KR'],
          }],
        } });
      }
      if (textUrl.includes('/tv/54321/external_ids')) return mockResponse({ json: {} });
      throw new Error(`unexpected TMDB retry URL: ${textUrl}`);
    },
  });
  const show = {
    id: 'pending', title: '待补高清测试', year: 2026, mediaType: '电视剧', regional: '韩国',
    category: 'korean_drama', coverImg: 'https://static.yfsp.tv/pending.jpg',
    yfspCoverImg: 'https://static.yfsp.tv/pending.jpg', coverSource: 'yfsp', tmdbCoverPending: true,
    primaryUrl: 'https://www.yfsp.tv/play/pending',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/pending-original.jpg', 'the next scheduled refresh should retry a pending Korean fallback after the retry window');
  assert.equal(show.coverSource, 'tmdb', 'a successful scheduled retry should switch the source marker to TMDB');
  assert.notEqual(show.tmdbCoverPending, true, 'a successful scheduled retry should clear the pending marker');
}

{
  const cachePath = '/tmp/iyf-test/scripts/../data/image_cache.json';
  const { helpers } = loadScrapeHelpers({
    env: {},
    initialFiles: {
      [cachePath]: JSON.stringify({ lowres: {
        title: '低清缓存', url: 'https://image.tmdb.org/t/p/w500/poster.jpg', source: 'tmdb', version: 16,
        matchedTitle: '低清缓存',
      } }),
    },
  });
  const show = {
    id: 'lowres', title: '低清缓存', year: 2026, mediaType: '电视剧', regional: '韩国',
    category: 'korean_drama', coverImg: '', primaryUrl: 'https://www.themoviedb.org/tv/1',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/poster.jpg', 'cached TMDB w500 covers should be upgraded to original without another API call');
  assert.equal(helpers.isRenderableShow(show), true, 'an upgraded TMDB original cover should remain renderable');
}

{
  const { helpers } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return mockResponse({ json: {
          results: [{
            id: 9001, name: '同名韩剧', original_name: '同名韩剧', first_air_date: '2019-01-01',
            poster_path: '/wrong-remake.jpg', origin_country: ['KR'],
          }],
        } });
      }
      throw new Error(`unexpected TMDB mismatch URL: ${textUrl}`);
    },
  });
  const found = await helpers.searchTMDBImage({ title: '同名韩剧', year: 2026, mediaType: '电视剧', regional: '韩国' });
  assert.equal(found.lookupState, 'not_found', 'TMDB search should reject a same-title Korean drama from the wrong year');
}

{
  const { helpers } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return mockResponse({ json: {
          results: [
            { id: 9002, name: '同名韩剧', original_name: '同名韩剧', first_air_date: '2019-01-01', poster_path: '/old.jpg', origin_country: ['KR'] },
            { id: 9003, name: '同名韩剧', original_name: '同名韩剧', first_air_date: '2025-12-01', poster_path: '/near.jpg', origin_country: ['KR'] },
          ],
        } });
      }
      if (textUrl.includes('/tv/9003/external_ids')) return mockResponse({ json: {} });
      throw new Error(`unexpected TMDB year-compatible URL: ${textUrl}`);
    },
  });
  const found = await helpers.searchTMDBImage({ title: '同名韩剧', year: 2026, mediaType: '电视剧', regional: '韩国' });
  assert.equal(found.tmdbId, 9003, 'TMDB search should continue past an incompatible same-title result and accept a nearby year');
}

{
  const { helpers } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return mockResponse({ json: {
          results: [{
            id: 9004, name: '你好星期六', original_name: '你好星期六', first_air_date: '2022-01-01',
            poster_path: '/long-running.jpg', origin_country: ['CN'],
          }],
        } });
      }
      if (textUrl.includes('/tv/9004/external_ids')) return mockResponse({ json: {} });
      if (textUrl.includes('/tv/9004/season/4')) return mockResponse({ status: 404 });
      throw new Error(`unexpected TMDB long-running URL: ${textUrl}`);
    },
  });
  const longRunning = await helpers.searchTMDBImage({ title: '你好星期六', year: 2026, mediaType: '综艺', regional: '大陆' });
  assert.equal(longRunning.tmdbId, 9004, 'known long-running variety should allow its stable series year to differ from the current season');

  const season = await helpers.searchTMDBImage({ title: '你好星期六第4季', year: 2026, mediaType: '综艺', regional: '大陆' });
  assert.equal(season.lookupState, 'not_found', 'season-specific variety searches should not fall back to the base series entry');
}

{
  const { helpers } = loadScrapeHelpers();
  assert.equal(helpers.seasonKey('杀人者的购物中心2'), '第2季', 'a trailing Chinese title number should be treated as a season marker');
  assert.equal(helpers.seasonKey('杀人者的购物中心 S02'), '第2季', 'S02 should normalize to the canonical season key');
  assert.equal(helpers.seasonKey('杀人者的购物中心 Season 2'), '第2季', 'Season 2 should normalize to the canonical season key');
  assert.equal(helpers.seasonNumberFromTitle('财阀X刑警第2季'), 2, 'season titles should expose a numeric season for TMDB season endpoints');
  assert.equal(helpers.extractTMDBSeriesId('https://www.themoviedb.org/tv/220074/season/2'), 220074, 'TMDB season URLs should resolve to their parent series ID');
  assert.equal(helpers.extractTMDBSeasonNumber('https://www.themoviedb.org/tv/220074/season/2'), 2, 'TMDB season URLs should expose their numeric season');
  assert.equal(helpers.extractTMDBSeriesId('https://example.com/tv/220074'), 0, 'non-TMDB URLs must not be treated as TMDB series IDs');
  assert.equal(helpers.seasonKey('请回答1988'), '', 'a four-digit year must not be treated as a season marker');
  assert.equal(helpers.simplifyTitleForSearch('杀人者的购物中心2'), '杀人者的购物中心', 'season suffixes should be removed from TMDB search fallbacks');
  assert.equal(
    helpers.isTMDBResultYearCompatible(
      { title: '杀人者的购物中心2', year: 2026, mediaType: '电视剧' },
      { name: '杀人者的购物中心', first_air_date: '2024-01-01' }
    ),
    false,
    'a base-series TMDB result must not satisfy a season-specific Korean drama'
  );
}

{
  const { helpers } = loadScrapeHelpers();
  const mismatched = {
    title: '杀人者的购物中心2',
    url: 'https://image.tmdb.org/t/p/original/wrong-season.jpg',
    source: 'tmdb',
    version: 16,
    matchedTitle: '杀人者的购物中心',
    year: 2026,
    mediaType: '电视剧',
  };
  assert.equal(
    helpers.findReusableTMDBCache({ mismatched }, { id: 'mismatched', title: '杀人者的购物中心2', year: 2026, mediaType: '电视剧' }),
    null,
    'a current-version cache with a base-series matchedTitle must still be rejected'
  );
  const missingSeasonMetadata = {
    ...mismatched,
    matchedTitle: '杀人者的购物中心第2季',
    tmdbSeasonNumber: 2,
    tmdbUrl: 'https://www.themoviedb.org/tv/215072',
  };
  assert.equal(
    helpers.findReusableTMDBCache({ missingSeasonMetadata }, { id: 'missingSeasonMetadata', title: '杀人者的购物中心2', year: 2026, mediaType: '电视剧' }),
    null,
    'a season cache pointing to the series page must not be reused after the season resolver upgrade'
  );
}

{
  const cachePath = '/tmp/iyf-test/scripts/../data/image_cache.json';
  const { helpers, writes } = loadScrapeHelpers({
    initialFiles: {
      [cachePath]: JSON.stringify({ stale: {
        title: '杀人者的购物中心2',
        url: 'https://image.tmdb.org/t/p/w500/wrong-season.jpg',
        source: 'tmdb',
        version: 14,
        matchedTitle: '杀人者的购物中心',
      } }),
    },
  });
  const show = {
    id: 'stale', title: '杀人者的购物中心2', year: 2026, mediaType: '电视剧', regional: '韩国',
    category: 'korean_drama', coverImg: 'https://image.tmdb.org/t/p/original/wrong-season.jpg',
    yfspCoverImg: 'https://static.yfsp.tv/fallback.jpg', coverSource: 'tmdb',
    primaryUrl: 'https://www.yfsp.tv/play/stale',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://static.yfsp.tv/fallback.jpg', 'an invalidated TMDB cache should immediately fall back to the saved YFSP cover');
  assert.equal(show.coverSource, 'yfsp', 'an invalidated TMDB cache should be marked as a YFSP fallback');
  assert.equal(show.tmdbCoverPending, true, 'an invalidated Korean cover should remain eligible for scheduled TMDB refresh');
  const savedCache = JSON.parse([...writes.values()].at(-1) || '{}');
  assert.equal(savedCache.stale?.version, 14, 'URL resolution migration must not promote an old positive cache to the current version');
  assert.equal(savedCache.stale?.url, 'https://image.tmdb.org/t/p/original/wrong-season.jpg', 'old TMDB URLs may be normalized without making their match reusable');
}

{
  const cachePath = '/tmp/iyf-test/scripts/../data/image_cache.json';
  const { helpers, writes } = loadScrapeHelpers({
    env: { TMDB_TOKEN: 'tmdb-test-token' },
    initialFiles: {
      [cachePath]: JSON.stringify({ stale: {
        title: '杀人者的购物中心2',
        url: 'https://image.tmdb.org/t/p/original/wrong-season.jpg',
        source: 'tmdb',
        version: 14,
        matchedTitle: '杀人者的购物中心',
      } }),
    },
    fetchImpl: async url => {
      const textUrl = String(url);
      if (textUrl.includes('/search/tv?')) {
        return mockResponse({ json: {
          results: [{
            id: 215072,
            name: '杀人者的购物中心',
            original_name: '杀人者的购物中心',
            first_air_date: '2024-01-17',
            poster_path: '/wrong-season.jpg',
            origin_country: ['KR'],
          }],
        } });
      }
      if (textUrl.includes('/tv/215072/season/2')) return mockResponse({ status: 404 });
      throw new Error(`unexpected stale-cache TMDB URL: ${textUrl}`);
    },
  });
  const show = {
    id: 'stale', title: '杀人者的购物中心2', year: 2026, mediaType: '电视剧', regional: '韩国',
    category: 'korean_drama', coverImg: 'https://image.tmdb.org/t/p/original/wrong-season.jpg',
    yfspCoverImg: 'https://static.yfsp.tv/fallback.jpg', coverSource: 'tmdb',
    primaryUrl: 'https://www.yfsp.tv/play/stale',
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.coverImg, 'https://static.yfsp.tv/fallback.jpg', 'a rejected season match should keep the Korean fallback cover');
  const savedCache = JSON.parse([...writes.values()].at(-1) || '{}');
  assert.equal(savedCache.stale?.notFound, true, 'a rejected stale positive cache should become a negative cache entry');
  assert.equal(savedCache.stale?.version, 16, 'the replacement negative cache should use the current cache version');
  assert.equal('url' in (savedCache.stale || {}), false, 'a rejected stale positive cache must not retain its wrong TMDB URL');
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
assert.match(app, /escapeHtml\(String\(aiScore\)\)/, 'AI score badge should escape normalized output');
assert.match(app, /escapeHtml\(String\(show\.score\)\)/, 'score badge should escape stringified output');
assert.doesNotMatch(app, /card-score-float/, 'poster score overlays should not duplicate the score badge');
assert.match(app, /toText\(s\.title\)\.toLowerCase\(\)\.includes\(query\)/, 'search should tolerate missing titles');
assert.match(app, /function getValidTime\(/, 'date sorting should use a valid-time helper');
assert.match(app, /s\.isNew === true/, 'new tab should use the explicit recently-added marker');
assert.match(app, /s\.isClassic === true/, 'classic tab should use explicit curation markers');
assert.match(app, /function getRecommendationWidth\(/, 'recommendation bars should be relative to the current result set');
assert.match(app, /show\.updateStatus \|\| show\.updateMsg/, 'variety cards should expose their update message fallback');
assert.match(app, /function normalizeAIScore\(/, 'frontend should validate AI scores');
assert.match(app, /function getDataFreshness\(/, 'data freshness should be calculated for the update status');
assert.match(app, /const DATA_CACHE_VERSION = 3;/, 'front-end cache schema should be versioned for behavior changes');
assert.match(app, /fetchJSONWithTimeout\(DATA_URL/, 'the primary data request should have a bounded timeout');
assert.match(app, /function getScheduleDateKey\(/, 'TVmaze should derive dates in the source timezone');
assert.match(app, /function isTVmazeDrama\(/, 'TVmaze schedule should distinguish scripted dramas from variety and reality shows');
assert.match(app, /successfulDays/, 'TVmaze should tolerate a failed current-day request when history succeeds');
assert.match(app, /showRemoteTabStaleFallback/, 'remote tabs should reuse a stale cache when a refresh fails');
assert.match(app, /insertAdjacentHTML\('beforeend'/, 'loading more should append cards without replacing existing DOM nodes');
assert.match(app, /new window\.IntersectionObserver/, 'loading more should auto-trigger near the viewport bottom');
assert.match(app, /AUTO_LOAD_ROOT_MARGIN/, 'auto-loading should prefetch before the user reaches the exact bottom');
assert.doesNotMatch(app, /loadMore\.addEventListener\(['"]click/, 'loading more should not require a mouse click');
assert.match(app, /function renderSkeletons\(/, 'slow initial loads should show layout-preserving skeletons');
assert.match(app, /const INITIAL_RENDER_COUNT = 24;/, 'large result sets should render in bounded batches');
assert.match(index, /id="yearTabLabel"/, 'the current-year drama tab label should be data-driven');
assert.match(index, /id="varietyYearTabLabel"/, 'the current-year variety tab label should be data-driven');
assert.doesNotMatch(index, /id="tab-trakt"|id="tab-mdl"/u, 'retired snapshot tabs should not be exposed in the navigation');
assert.match(index, /id="loadMore"/, 'large result sets should expose a progressive loading control');
assert.match(index, /aria-live="polite"/, 'auto-load progress should be announced accessibly');
assert.match(index, /id="loadMoreStatus"[^>]*role="status"/, 'the auto-load status should remain a separate live region');
assert.doesNotMatch(index, /id="loadMore"[^>]*type="button"/, 'the auto-load sentinel should not advertise a click action');
assert.match(app, /继续下滑自动加载/, 'the fallback control should explain the auto-load behavior');
assert.doesNotMatch(index, /id="showGrid"[^>]*aria-live=/u, 'the full card grid should not be a large live region');
assert.doesNotMatch(app, /s\.year === 2026/, 'current-year tab should not hardcode 2026');
assert.doesNotMatch(index, /2026新剧|2026新综艺|2026新综/, 'HTML copy should not hardcode one calendar year');
assert.doesNotMatch(app, /new Date\([^\n]+\) - new Date\(/, 'date sorting should not subtract Date objects directly');

assert.match(scrape, /const TMDB_TOKEN = process\.env\.TMDB_TOKEN \|\| '';/, 'TMDB token should come from environment');
assert.match(scrape, /if \(!TMDB_TOKEN\)/, 'TMDB fetch should skip clearly when token is missing');
assert.match(scrape, /const OPTIONAL_ENRICHMENT_BUDGET_MS = 8 \* 60 \* 1000;/, 'optional enrichment should have a shared time budget');
assert.match(scrape, /getOptionalEnrichmentTimeout\(/, 'optional enrichment requests should honor the shared time budget');
assert.match(scrape, /redirect: 'error'/, 'YFSP verification should not follow redirects to an untrusted host');
assert.match(scrape, /const COVER_CACHE_VERSION = 16;/, 'TMDB matching-rule changes should invalidate prior positive cover caches');
assert.doesNotMatch(scrape, /entry\.version = COVER_CACHE_VERSION/, 'TMDB URL resolution migration must not promote stale cache entries');
assert.match(scrape, /isTMDBResultYearCompatible\(show, r, \{ yearParam \}\)/, 'TMDB search should validate result year and season before accepting a cover');
assert.match(scrape, /isTMDBResultSeasonCompatible\(show, \{ name: matchedTitle \}\)/, 'TMDB cache reuse should revalidate the stored matched title season');
assert.match(scrape, /tv\/\$\{seriesId\}\/season\/\$\{seasonNumber\}/, 'season-specific shows should resolve their TMDB season endpoint');
assert.match(scrape, /cachedSeasonNumber === expectedSeasonNumber/, 'season-specific TMDB caches should retain and validate their numeric season');
assert.match(scrape, /cachedSeasonUrlNumber === expectedSeasonNumber/, 'season-specific TMDB caches should point to the season page, not just carry a season flag');
assert.match(scrape, /PREVIOUS_RECOMMENDATION_RETENTION_DAYS = 45/, 'restored recommendations should have a bounded retirement window');
assert.match(scrape, /removeHardExcludedKDrama\(kdramaMap\)/, 'hard Korean drama exclusions should run after enrichment, not only on discovery');
assert.match(scrape, /const OPENROUTER_FREE_MODEL = 'openrouter\/free';/, 'AI scoring should use OpenRouter\'s maintained free router');
assert.match(scrape, /const AI_BATCH_SIZE = 10;/, 'AI batches should be bounded for free-router latency');
assert.match(scrape, /const AI_TOTAL_BUDGET_MS = 8 \* 60 \* 1000;/, 'AI work should have a bounded eight-minute shared budget');
assert.match(scrape, /timeout = 60000,/, 'individual free-router requests should allow a complete structured response');
assert.doesNotMatch(scrape, /models\.github\.ai|openai\/gpt-4\.1-mini|OPENROUTER_MODELS/, 'retired providers and static free-model lists must stay out of the runtime path');
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
assert.match(scrape, /normalizeTMDBOriginalUrl\(show\.coverImg\)[\s\S]*?show\.coverSource = 'tmdb'[\s\S]*?else if \(show\.coverImg\)/, 'restored TMDB covers should keep TMDB source while enriching covers');
assert.doesNotMatch(scrape, /if \(show\.coverImg\) show\.yfspCoverImg = show\.coverImg;/, 'restored TMDB covers should not be treated as YFSP fallbacks');
assert.match(scrape, /tmdbCoverPending/, 'Korean fallback covers should carry an explicit TMDB upgrade marker');
assert.match(publicBuild, /'coverSource', 'tmdbCoverPending'/, 'the public payload should preserve the Korean cover upgrade marker');
assert.match(validateData, /show\.year !== 0/, 'data validation should allow an explicit unknown year sentinel');
const committedData = JSON.parse(read('data/shows.json'));
assert.equal(committedData.stats.koreanDramas, committedData.koreanDramas.length, 'the Korean drama statistic should match the post-cleanup catalog');
assert.doesNotMatch(JSON.stringify(committedData), /黑暗荣耀第2季/u, 'the catalog should not retain the unsupported standalone Glory season card');
assert.match(app, /badge-cover-pending/, 'pending TMDB cover status should be visible to users');
assert.match(scrape, /身份重合度异常/, 'continuity checks should detect same-sized replacement catalogs');
assert.match(scrape, /输出包含重复节目 ID/, 'output validation should reject duplicate IDs across categories');
assert.match(scrape, /function hasValidTMDBSeasonLink\(/, 'season-specific output should validate its TMDB URL');
assert.match(validateData, /season-specific title must link to its TMDB season page/, 'data validation should reject series-level links for season titles');

assert.doesNotMatch(scrape, /seed_var_2026_0(1b|2b|4b)|seed_var_2026_10b|seed_var_2026_23/, 'pseudo-variant/duplicate seeds should be removed to avoid repeating cards');
assert.doesNotMatch(scrape, /seed_var_2026_17/, '待定版地球超新鲜 seed should be removed (duplicate of seed_var_2026_28)');
assert.doesNotMatch(scrape, /seed_kd_s03/, 'duplicate 奇怪的律师禹英禑 seed should be removed (covered by seed_kd_c15 非常律师禹英禑)');
assert.match(scrape, /function dedupByTitle\(/, 'final output should dedup duplicate cards');
assert.match(scrape, /koreanDramas = dedupByTitle\(/, 'korean drama output should be de-duplicated');
assert.match(scrape, /chineseVariety = dedupByTitle\(/, 'variety output should be de-duplicated');

assert.match(workflow, /git diff --quiet data\/shows\.json data\/image_cache\.json data\/discovery\.json data\/history\.json/, 'history-only changes should trigger the data commit step');
assert.match(workflow, /node-version-file: '\.node-version'/, 'scrape and validation workflows should share the repository Node version');
assert.doesNotMatch(workflow, /node-version: '22'/, 'scrape workflow should not drift from .node-version');
assert.match(workflow, /TMDB_TOKEN: \$\{\{ secrets\.TMDB_TOKEN \}\}/, 'workflow should pass TMDB_TOKEN from secrets');
assert.match(workflow, /OPENROUTER_MODEL: \$\{\{ vars\.OPENROUTER_MODEL \}\}/, 'workflow should support an optional explicit OpenRouter model');
const scrapeJobMinutes = Number(workflow.match(/name: 抓取数据 & 构建站点[\s\S]*?timeout-minutes: (\d+)/)?.[1]);
assert.ok(scrapeJobMinutes >= 8 * 2 + Math.ceil(47 * 15 / 60) + 5, 'the job timeout must cover source requests, both enrichment budgets, and build/push overhead');
assert.doesNotMatch(workflow, /models:\s*read|GITHUB_TOKEN:/, 'workflow should not grant or pass credentials for the retired GitHub Models service');
assert.match(workflow, /paths-ignore:\n\s+- 'data\/\*\*'/, 'data-only bot commits should not retrigger the scraper workflow');
assert.match(workflow, /pushed=false/, 'workflow should track whether data push actually succeeded');
assert.match(workflow, /exit 1/, 'workflow should stop before deploy if data push fails');
assert.doesNotMatch(workflow, /git rebase --continue \|\| true/, 'workflow should not swallow failed rebase continuation');
assert.match(workflow, /base_sha="\$GITHUB_SHA"/, 'workflow should bind scraped data to the code revision that produced it');
assert.doesNotMatch(workflow, /git pull --rebase/, 'workflow should not rebase data generated by an older scraper onto newer main code');
assert.match(workflow, /node scripts\/build-site\.mjs/, 'all deployments should use the validated site builder');
assert.match(workflow, /path: 'site'/, 'workflow should upload only the explicit site artifact');
assert.doesNotMatch(workflow, /path: '\.'/, 'workflow should not upload the repository root');
assert.doesNotMatch(workflow, /cp -R css js data site\//, 'workflow should not publish data files by broad directory copy');
assert.match(read('scripts/build-site.mjs'), /build-public-data\.mjs/, 'site builder should build a field-minimized public shows payload');
assert.doesNotMatch(workflow, /cp data\/(?:mdl|trakt)_shows\.json/, 'workflow should not publish retired snapshot files');

assert.doesNotMatch(css, /\.show-card:nth-child\(\d+\) \{ animation-delay:/, 'CSS nth-child animation delays should not duplicate inline delay');

console.log('Regression checks passed');
