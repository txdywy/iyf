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

function loadScrapeHelpers({ env = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); }, dateImpl = Date } = {}) {
  const writes = new Map();
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
    .replace(/main\(\)\.catch[\s\S]*$/m, '') + `
      globalThis.__helpers = {
        parseUpdateStatus,
        findLiveTitleMatch,
        scoreYfspCandidate,
        scoreVariety,
        aiScoreShows,
        aiEvaluateDiscovery,
        isRenderableShow,
        dedupByTitle,
        enrichCoversFromTMDB,
        searchDoubanSubject,
      };
    `;

  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return { helpers: context.__helpers, writes };
}

function loadAppHelpers({ dateImpl = Date } = {}) {
  const context = {
    console,
    Date: dateImpl,
    setInterval,
    clearInterval,
    document: {
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
      escapeHtml,
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

// ── Frontend behavior regressions ──────────────────────────
{
  const { renderCardActions, renderCard } = loadAppHelpers();
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

  const zeroBadge = renderCard({ title: '零分测试', aiScore: 0, score: 0, coverImg: '', recommendScore: 0 }, 0);
  assert.match(zeroBadge, /🤖 0\/100/, 'AI score badge should render valid score 0');

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
}

// ── Scraper status parsing and matching regressions ──────────────────────────
{
  const { helpers } = loadScrapeHelpers();
  assert.deepEqual(plain(helpers.parseUpdateStatus('16集全')), { totalEpisodes: 16, currentEpisode: 16, isComplete: true });
  assert.deepEqual(plain(helpers.parseUpdateStatus('20170707集全')), { totalEpisodes: 0, currentEpisode: 0, isComplete: true }, 'date-like 集全 values should not become episode counts');
  assert.equal(helpers.parseUpdateStatus('20220825(下班了编剧部)集全').isComplete, true, 'parenthesized 集全 values should count as complete');
  assert.equal(helpers.parseUpdateStatus('颁奖典礼集全').isComplete, true, 'non-numeric 集全 values should count as complete');
  assert.equal(helpers.parseUpdateStatus('未完结').isComplete, false, 'negative completion statuses should not be marked complete');

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
}

// ── AI regressions ──────────────────────────
{
  const openRouterCounter = { count: 0 };
  const { helpers } = loadScrapeHelpers({
    env: { OPENROUTER_API_KEY: 'or-test-key' },
    fetchImpl: aiFetchWithContent('评分结果 [仅供参考]: [{"id":"drama-1","s":88,"r":"合适"}]', openRouterCounter),
  });
  const scores = await helpers.aiScoreShows([{ id: 'drama-1', title: '浪漫律师', year: 2026, score: 8, playCount: 10000 }]);
  assert.equal(scores.get('drama-1')?.score, 88, 'OpenRouter-only AI runs should parse bracketed-prose JSON arrays');
  assert.equal(openRouterCounter.count, 1, 'OpenRouter-only AI runs should call the configured provider');
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
  const scores = await helpers.aiScoreShows([{ id: 'zero', title: '低分测试', aiScore: 0, aiScoredAt: new Date().toISOString(), year: 2026 }]);
  assert.equal(scores.size, 0, 'fresh cached AI score 0 should not need rescoring');
  assert.equal(githubCounter.count, 0, 'fresh cached AI score 0 should not call AI providers');
}

// ── Output filtering and de-duplication regressions ──────────────────────────
{
  const { helpers } = loadScrapeHelpers();
  assert.equal(helpers.isRenderableShow({ seedId: 'seed_x', category: 'korean_drama', coverImg: '', primaryUrl: '' }), false, 'seed cards should still need a cover and primary link');
  assert.equal(helpers.isRenderableShow({ category: 'korean_drama', coverImg: 'https://static.yfsp.tv/poster.jpg', coverSource: 'yfsp', primaryUrl: 'https://www.yfsp.tv/play/x' }), true, 'recommendations with valid fallback covers and links should remain renderable');

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
assert.match(app, /\(s\.title \|\| ''\)\.toLowerCase\(\)\.includes\(query\)/, 'search should tolerate missing titles');
assert.match(app, /function getValidTime\(/, 'date sorting should use a valid-time helper');
assert.doesNotMatch(app, /s\.year === 2026/, 'current-year tab should not hardcode 2026');
assert.doesNotMatch(index, /2026新剧|2026新综艺|2026新综/, 'HTML copy should not hardcode one calendar year');
assert.doesNotMatch(app, /new Date\([^\n]+\) - new Date\(/, 'date sorting should not subtract Date objects directly');

assert.match(scrape, /const TMDB_TOKEN = process\.env\.TMDB_TOKEN \|\| '';/, 'TMDB token should come from environment');
assert.match(scrape, /if \(!TMDB_TOKEN\)/, 'TMDB fetch should skip clearly when token is missing');
assert.match(scrape, /const liveStatus = parseUpdateStatus\(liveMatch\.updateStatus \|\| ''\);/, 'live updateStatus should be parsed when applying live fields');
assert.match(scrape, /\.\.\.liveStatus,/, 'parsed live status fields should override seed status fields');
assert.match(scrape, /const bareEpisode = s\.match\(\/\^\\d\+\$\/\);/, 'bare numeric YFSP statuses should parse as current episodes');
assert.match(scrape, /const refreshTargets = shows\.filter\(s => s\.yfspUrl && s\.title && !s\.isComplete\);/, 'ongoing shows with existing YFSP links should refresh status on each scrape');
assert.match(scrape, /applyYfspSearchFields\(show, found\);/, 'YFSP search results should refresh existing show fields, not only fill blanks');
assert.match(scrape, /if \(parsed\.totalEpisodes\) show\.totalEpisodes = parsed\.totalEpisodes;/, 'YFSP status refresh should not erase known total episode counts');
assert.match(scrape, /cached && typeof cached === 'object' && cached\.version === COVER_CACHE_VERSION/, 'TMDB cache fallback should guard null cached entries');
assert.match(scrape, /'订阅男友': 'Boyfriend on Demand'/, 'TMDB English title for 订阅男友 should be corrected');
assert.match(scrape, /'大叔再出招': \['Fifties Professionals', '오십프로', '五十专家', '五十專家'\]/, '大叔再出招 should have TMDB search aliases');
assert.match(scrape, /'大叔再出招': 'Fifties Professionals'/, '大叔再出招 should use its TMDB English title');
assert.match(scrape, /function stableDiscoveredId\(/, 'discovered shows without YFSP IDs should get stable title-based IDs');
assert.match(scrape, /restorePreviousRecommendations\(kdramaMap, varietyMap, prevShows\)/, 'previously accepted recommendations should be restored before each fresh discovery run');
assert.match(scrape, /titleMatches\(cached\.title, show\.title\)/, 'TMDB cover cache reuse should tolerate cleaned season titles');
assert.match(scrape, /id: it\.mediaKey \|\| it\.episodeKey \|\| stableDiscoveredId\(/, 'API items without media IDs should not collapse into an empty liveShows key');
assert.match(scrape, /isTMDBImageUrl\(show\.coverImg\)[\s\S]*?show\.coverSource = 'tmdb'[\s\S]*?else if \(show\.coverImg\)/, 'restored TMDB covers should keep TMDB source while enriching covers');
assert.doesNotMatch(scrape, /if \(show\.coverImg\) show\.yfspCoverImg = show\.coverImg;/, 'restored TMDB covers should not be treated as YFSP fallbacks');

assert.doesNotMatch(scrape, /seed_var_2026_0(1b|2b|4b)|seed_var_2026_10b|seed_var_2026_23/, 'pseudo-variant/duplicate seeds should be removed to avoid repeating cards');
assert.match(scrape, /function dedupByTitle\(/, 'final output should dedup duplicate cards');
assert.match(scrape, /koreanDramas = dedupByTitle\(/, 'korean drama output should be de-duplicated');
assert.match(scrape, /chineseVariety = dedupByTitle\(/, 'variety output should be de-duplicated');

assert.match(workflow, /data\/history\.json/, 'workflow should include history.json in data commit handling');
assert.match(workflow, /TMDB_TOKEN: \$\{\{ secrets\.TMDB_TOKEN \}\}/, 'workflow should pass TMDB_TOKEN from secrets');
assert.match(workflow, /paths-ignore:\n\s+- 'data\/\*\*'/, 'data-only bot commits should not retrigger the scraper workflow');
assert.match(workflow, /pushed=false/, 'workflow should track whether data push actually succeeded');
assert.match(workflow, /exit 1/, 'workflow should stop before deploy if data push fails');
assert.doesNotMatch(workflow, /git rebase --continue \|\| true/, 'workflow should not swallow failed rebase continuation');
assert.match(workflow, /mkdir -p site/, 'workflow should build an explicit Pages artifact directory');
assert.match(workflow, /path: 'site'/, 'workflow should upload only the explicit site artifact');
assert.doesNotMatch(workflow, /path: '\.'/, 'workflow should not upload the repository root');
assert.doesNotMatch(workflow, /cp -R css js data site\//, 'workflow should not publish data files by broad directory copy');
assert.match(workflow, /mkdir -p site\/data/, 'workflow should create an explicit public data artifact directory');
assert.match(workflow, /cp data\/shows\.json site\/data\//, 'workflow should publish only the public shows data file');

assert.doesNotMatch(css, /\.show-card:nth-child\(\d+\) \{ animation-delay:/, 'CSS nth-child animation delays should not duplicate inline delay');

console.log('Regression checks passed');
