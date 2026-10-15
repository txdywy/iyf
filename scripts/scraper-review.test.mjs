import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'scripts/scrape.mjs'), 'utf8');
const dataDir = '/tmp/iyf-scraper-review/data';

function loadHelpers({
  env = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); },
  date = '2026-09-30T04:00:00Z', initialFiles = {},
  setTimeoutImpl = (fn, delay) => { if (delay <= 1000) fn(); return 0; },
  clearTimeoutImpl = () => {},
} = {}) {
  let now = Date.parse(date);
  const files = new Map(Object.entries(initialFiles));
  const writes = [];
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    console: { log() {}, warn() {}, error() {} },
    process: { env }, fetch: fetchImpl, URL, AbortController, Date: FixedDate, Buffer,
    setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl,
    existsSync: path => files.has(path), readFileSync: path => files.get(path),
    writeFileSync: (path, value) => { files.set(path, value); writes.push(path); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync() {}, join,
  };
  const executable = source
    .replace(/^import .*$/gm, '')
    .replace(/const __dirname = dirname\(fileURLToPath\(import\.meta\.url\)\);/, "const __dirname = '/tmp/iyf-scraper-review/scripts';")
    .replace(/const run = process\.argv[\s\S]*$/m, '') + `
      globalThis.helpers = {
        scoreKDrama, scoreVariety, isEligibleKDrama, removeHardExcludedKDrama,
        aiEnhanceDescriptions, findLiveTitleMatch, scoreYfspCandidate,
        searchYfspTitle, verifyYfspUrl, searchDoubanSubject, searchTMDBImage,
        enrichMissingYfspLinks, restorePreviousCategory, normalizeItem,
        applyLiveFields, mergePreviousShowState, sameShowIdentity, main, loadPreviousShows, recalculateExistingData,
        enrichDescriptions, enrichCoversFromTMDB, enrichDoubanLinks, isReusableTMDBCoverCache, SEED_VARIETY,
        discoverNewKDramas, discoverNewVariety, assertOutputContinuity, normalizeOutputShow, isRenderableShow, SEED_KDRAMAS,
        aiScoreInputHash, isFreshAIScore, AI_SCORE_CACHE_VERSION,
        setEnrichmentDeadline: deadline => { _optionalEnrichmentDeadline = deadline; },
      };
    `;
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return { helpers: context.helpers, files, writes, setNow: iso => { now = Date.parse(iso); } };
}

function response(json, { status = 200, html = '' } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => json, text: async () => html,
    body: { cancel: async () => {} },
  };
}

test('first-seen dates follow show identity and expire after their own first observation', async () => {
  const observedAt = '2026-10-13T04:00:00.000Z';
  const oldFirstSeen = '2026-08-01T04:00:00.000Z';
  const changedIdFirstSeen = '2026-10-01T04:00:00.000Z';
  const previousShow = (id, title, extra = {}) => ({
    id, title, mediaType: '电视剧', category: 'korean_drama', regional: '韩国', year: 2026,
    score: 8, playCount: 100000, coverImg: 'https://image.tmdb.org/t/p/original/identity.jpg',
    primaryUrl: `https://www.yfsp.tv/play/${id}`, yfspUrl: `https://www.yfsp.tv/play/${id}`,
    firstSeenAt: oldFirstSeen, scrapedAt: '2026-10-12T04:00:00.000Z', ...extra,
  });
  const previous = {
    lastUpdated: '2026-10-12T04:00:00.000Z', stats: { totalScraped: 30 },
    koreanDramas: [
      previousShow('old-remake', '跨年翻拍测试剧', { year: 2023 }),
      previousShow('same-id', '旧名称测试剧'),
      previousShow('old-id', '换源身份测试剧', { firstSeenAt: changedIdFirstSeen }),
      previousShow('invalid-date', '无效日期测试剧', { firstSeenAt: 'invalid-date' }),
      previousShow('future-date', '未来日期测试剧', { firstSeenAt: '2027-01-01T00:00:00.000Z' }),
    ],
    chineseVariety: [previousShow('old-variety', '同名类型测试剧', { mediaType: '综艺', category: 'variety' })],
    otherDramas: [previousShow('old-region', '同名地区测试剧', { regional: '大陆', category: 'other_drama' })],
  };
  const current = [
    ['new-region', '同名地区测试剧'], ['new-type', '同名类型测试剧'], ['new-remake', '跨年翻拍测试剧'],
    ['same-id', '新名称测试剧'], ['new-id', '换源身份测试剧！'],
    ['invalid-date', '无效日期测试剧'], ['future-date', '未来日期测试剧'],
  ].map(([mediaKey, title]) => ({
    mediaKey, title, mediaType: '电视剧', regional: '韩国', publishTime: '2026-10-12T00:00:00Z',
    score: 8, playCount: 100000, coverImgUrl: 'https://static.yfsp.tv/identity.jpg',
  }));
  let homepageCalls = 0;
  const { helpers, files, setNow } = loadHelpers({
    date: observedAt,
    initialFiles: { [join(dataDir, 'shows.json')]: JSON.stringify(previous) },
    fetchImpl: async url => {
      if (url.includes('api.yfsp.tv/api/list/index') && ++homepageCalls === 1) {
        return response({ data: { list: [{ name: '电视剧', list: current }] } });
      }
      return response(null, { status: 503 });
    },
  });
  await helpers.main();
  const published = JSON.parse(files.get(join(dataDir, 'shows.json')));
  const byId = new Map(published.koreanDramas.map(show => [show.id, show]));
  for (const id of ['new-region', 'new-type', 'new-remake', 'invalid-date', 'future-date']) {
    assert.equal(byId.get(id)?.firstSeenAt, observedAt, id);
    assert.equal(byId.get(id)?.isNew, true, id);
  }
  assert.equal(byId.get('same-id')?.firstSeenAt, oldFirstSeen);
  assert.equal(byId.get('same-id')?.isNew, false);
  assert.equal(byId.get('new-id')?.firstSeenAt, changedIdFirstSeen);
  assert.equal(byId.get('new-id')?.isNew, true);

  setNow('2026-11-13T04:00:00.000Z');
  await helpers.main();
  const later = JSON.parse(files.get(join(dataDir, 'shows.json')));
  for (const id of ['invalid-date', 'future-date']) {
    const show = later.koreanDramas.find(show => show.id === id);
    assert.equal(show?.firstSeenAt, observedAt, id);
    assert.equal(show?.isNew, false, `${id}: a repaired timestamp must expire normally`);
  }
});

test('malformed discovery and metadata rows cannot hide later valid results', async () => {
  const variety = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [
    { title: {}, atypeName: '综艺', regional: '大陆' },
    { title: '容错旅行测试综艺', atypeName: '综艺', regional: '大陆', postTime: '2026-08-01', score: 8, hot: 100000, contxt: 'valid-variety' },
  ] }] } }) });
  const discovered = await variety.helpers.discoverNewVariety(new Map(), new Map());
  assert.deepEqual(Array.from(discovered, show => show.id), ['valid-variety']);

  const douban = loadHelpers({ fetchImpl: async () => response([null,
    { id: '123450', title: '容错元数据测试剧', year: { toString: 'invalid' } },
    { id: { toString: 'invalid' }, title: '容错元数据测试剧', year: '2026' },
    { id: '123456', title: '容错元数据测试剧', year: '2026' },
  ]) });
  assert.equal((await douban.helpers.searchDoubanSubject({ title: '容错元数据测试剧', year: 2026, mediaType: '电视剧' }))?.doubanId, '123456');

  const tmdb = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async url => {
    if (url.includes('/search/tv?')) return response({ results: [null,
      { id: { toString: 'invalid' }, name: '容错元数据测试剧', poster_path: '/bad.jpg' },
      { id: 123455, name: '容错元数据测试剧', poster_path: { toString: 'invalid' } },
      { id: 123456, name: '容错元数据测试剧', first_air_date: '2026-08-01', origin_country: ['KR'], poster_path: '/valid.jpg' },
    ] });
    if (url.includes('/tv/123456/external_ids')) return response({});
    assert.fail(`unexpected URL: ${url}`);
  } });
  assert.equal((await tmdb.helpers.searchTMDBImage({ title: '容错元数据测试剧', year: 2026, mediaType: '电视剧', regional: '韩国' }))?.tmdbId, 123456);

  const malformedOnly = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async () => response({ results: [null, { id: { toString: 'invalid' } }] }) });
  assert.equal((await malformedOnly.helpers.searchTMDBImage({ title: '错误响应测试剧', year: 2026, mediaType: '电视剧' })).lookupState, 'unknown', 'invalid rows cannot establish a negative cache entry');
});

test('YFSP search skips incomplete and malformed matching rows before ranking usable pages', async () => {
  const show = { title: '搜索坏行测试剧', year: 2026, mediaType: '电视剧', regional: '韩国' };
  const candidate = { title: show.title, atypeName: show.mediaType, regional: show.regional, postTime: '2026-08-01' };
  for (const badKey of [undefined, {}, 'bad\ud800']) {
    const { helpers } = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [
      { ...candidate, hot: 9000000, contxt: badKey },
      { ...candidate, hot: 100000, contxt: 'valid-search-row' },
    ] }] } }) });
    const found = await helpers.searchYfspTitle(show);
    assert.equal(found.url, 'https://www.yfsp.tv/play/valid-search-row', `invalid content key: ${typeof badKey}`);
  }
});

test('malformed-only YFSP responses remain retryable while a real empty search is negative-cached', async () => {
  const show = { id: 'bad-search', title: '搜索错误响应测试剧', year: 2026, mediaType: '电视剧', regional: '韩国', isComplete: true };
  let malformed = true;
  let searches = 0;
  const { helpers, setNow } = loadHelpers({ fetchImpl: async () => {
    searches++;
    return response({ data: { info: [{ result: malformed ? [null, { title: {}, contxt: 'bad-title' }] : [] }] } });
  } });
  await helpers.enrichMissingYfspLinks([show]);
  assert.equal(show.yfspLookupState, 'unknown', 'invalid rows cannot prove that the show does not exist');
  malformed = false;
  setNow('2026-10-01T04:00:00Z');
  await helpers.enrichMissingYfspLinks([show]);
  assert.equal(searches, 2, 'a recovered response must be retried after the shorter unknown TTL');
  assert.equal(show.yfspLookupState, 'not_found', 'a valid empty result still establishes a negative lookup');
});

test('Unicode text limits preserve complete characters and malformed titles cannot abort YFSP searches', async () => {
  const queries = [];
  const { helpers } = loadHelpers({ fetchImpl: async url => {
    queries.push(new URL(url).searchParams.get('tags'));
    return response({ data: { info: [{ result: [] }] } });
  } });
  const show = helpers.normalizeItem({
    mediaKey: 'unicode-title', title: `${'剧'.repeat(199)}🎬`, mediaType: '电视剧', regional: '韩国',
    description: `${'介'.repeat(1999)}🎬`,
  });
  assert.equal(show.title.isWellFormed(), true, 'a 200-unit title limit cannot leave half an emoji');
  assert.equal(show.description.isWellFormed(), true, 'synopsis truncation must also preserve complete characters');
  await helpers.searchYfspTitle(show);
  await helpers.searchYfspTitle({ ...show, title: '坏编码\ud800标题' });
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.isWellFormed()), 'free text must be repaired before it reaches URI encoding');
});

for (const kind of ['korean', 'variety']) {
  test(`a malformed ${kind} discovery identifier cannot hide later valid rows`, async () => {
    const korean = kind === 'korean';
    const candidate = {
      atypeName: korean ? '电视剧' : '综艺', regional: korean ? '韩国' : '大陆',
      postTime: '2026-08-01', score: 8, hot: 100000,
    };
    const { helpers } = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [
      { ...candidate, title: `损坏编码${kind}`, contxt: 'bad\ud800' },
      { ...candidate, title: `正常节目${kind}`, contxt: `valid-${kind}` },
    ] }] } }) });
    const discovered = korean
      ? await helpers.discoverNewKDramas(new Map(), new Map())
      : await helpers.discoverNewVariety(new Map(), new Map());
    assert.deepEqual(Array.from(discovered, show => show.id), [`valid-${kind}`]);
  });
}

for (const withAI of [false, true]) {
  test(`sourced hard exclusions survive longer TMDB descriptions ${withAI ? 'before AI discovery' : 'without AI'}`, async () => {
    const item = {
      mediaKey: 'sourced-risk', title: '来源风险测试剧', mediaType: '电视剧', regional: '韩国',
      publishTime: '2026-09-01', contentType: '悬疑', description: '血腥丧尸题材。',
      score: 8, playCount: 100000, coverImgUrl: 'https://static.yfsp.tv/risk.jpg',
    };
    const cached = {
      title: item.title, year: 2026, mediaType: '电视剧', source: 'tmdb', version: 16,
      url: 'https://image.tmdb.org/t/p/original/risk.jpg', matchedTitle: item.title,
      tmdbId: 123456, tmdbUrl: 'https://www.themoviedb.org/tv/123456',
    };
    let pages = 0;
    const discoveryIds = [];
    const { helpers, files } = loadHelpers({
      env: { TMDB_TOKEN: 'test-token', ...(withAI ? { OPENROUTER_API_KEY: 'test-token' } : {}) },
      initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ [item.mediaKey]: cached }) },
      fetchImpl: async (url, options) => {
        if (url.includes('api.yfsp.tv/api/list/index') && ++pages === 1) return response({ data: { list: [{ name: '电视剧', list: [item] }] } });
        if (url.includes('/tv/123456?language=')) return response({ overview: '一群昔日的好友在城市相遇，开始寻找失散已久的同伴。他们齐心协力破解难题，在冒险中重建信任，也经历了许多意想不到的转折。' });
        if (url.includes('/play/sourced-risk')) return response({}, { html: `<title>${item.title}-免费在线观看</title>` });
        if (url.includes('openrouter.ai')) {
          const request = JSON.parse(options.body);
          const schema = request.response_format.json_schema;
          const ids = schema.schema.properties.results.items.properties.id.enum;
          if (schema.name === 'iyf_discovery') discoveryIds.push(...ids);
          return response({ choices: [{ message: { content: JSON.stringify({ results: ids.map(id => ({
            id, ok: true, recommendationScore100: 80, recommendationLevel: 'strong', r: '适合', d: '更多资料待补充。',
          })) }) } }] });
        }
        return response(null, { status: 503 });
      },
    });
    await helpers.main();
    const published = JSON.parse(files.get(join(dataDir, 'shows.json')));
    assert.equal(published.koreanDramas.some(show => show.id === item.mediaKey), false, 'metadata prose cannot erase a sourced exclusion');
    assert.equal(discoveryIds.includes(item.mediaKey), false, 'a hard source rejection must not be delegated to AI');
  });
}

test('description upgrades retain sourced exclusion evidence without treating AI copy as facts', async () => {
  const sourceDescription = '血腥丧尸题材。';
  const sourceOverview = '几位好友踏上寻找旧日同伴的旅途，在城市间往返并解决许多难题，逐渐重建信任和友谊。';
  const wikiOverview = sourceOverview.repeat(3);
  const cached = id => ({
    title: `简介升级测试${id}`, year: 2026, mediaType: '电视剧', source: 'tmdb', version: 16,
    url: `https://image.tmdb.org/t/p/original/${id}.jpg`, matchedTitle: `简介升级测试${id}`,
    tmdbId: id, tmdbUrl: `https://www.themoviedb.org/tv/${id}`,
  });
  const { helpers } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({
      yfsp: cached(123451), tmdb: cached(123452), ai: cached(123453),
    }) },
    fetchImpl: async url => url.includes('wikipedia.org')
      ? response({ extract: wikiOverview })
      : response({ overview: url.includes('/123452?') ? sourceDescription : sourceOverview }),
  });
  const shows = ['yfsp', 'tmdb', 'ai'].map((descriptionSource, index) => ({
    id: descriptionSource, title: `简介升级测试${123451 + index}`, year: 2026, mediaType: '电视剧', regional: '韩国',
    description: descriptionSource === 'tmdb' ? '' : sourceDescription, descriptionSource,
    ...(descriptionSource === 'tmdb' ? { wikipediaUrl: 'https://zh.wikipedia.org/wiki/简介升级' } : {}),
  }));
  await helpers.enrichDescriptions(shows);
  assert.equal(shows[0].description, sourceOverview, 'a longer sourced synopsis may still improve display copy');
  assert.equal(shows[1].description, wikiOverview, 'Wikipedia may still replace a shorter TMDB synopsis');
  assert.equal(helpers.isEligibleKDrama(shows[0]), false, 'the original YFSP exclusion remains authoritative');
  assert.equal(helpers.isEligibleKDrama(shows[1]), false, 'a newly fetched TMDB exclusion survives the later Wikipedia upgrade');
  assert.equal(helpers.isEligibleKDrama(shows[2]), true, 'discarded AI copy must not create source exclusion evidence');
  assert.equal(JSON.stringify(shows).includes('_sourcedHardExclusion'), false, 'derived review evidence stays out of published records');
});

test('retiring an unverified series synopsis does not preserve its content as season evidence', async () => {
  for (const overview of ['第二季讲述伙伴重逢后的轻松日常。', '']) {
    const { helpers } = loadHelpers({
      env: { TMDB_TOKEN: 'test-token' },
      initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: seasonCache() }) },
      fetchImpl: async () => response({ season_number: 2, overview }),
    });
    const show = {
      id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
      description: '错误系列的血腥丧尸简介。', descriptionSource: 'tmdb',
    };
    await helpers.enrichDescriptions([show]);
    assert.equal(show.description, overview);
    assert.equal(helpers.isEligibleKDrama(show), true, 'retired text did not prove facts about the requested season');
  }
});

test('malformed numeric homepage fields cannot abort publication or replace previous source facts', async () => {
  const previous = {
    lastUpdated: '2026-10-12T04:00:00.000Z', stats: { totalScraped: 30 }, chineseVariety: [], otherDramas: [],
    koreanDramas: [{
      id: 'malformed-score', title: '坏分值测试韩剧', mediaType: '电视剧', category: 'korean_drama', regional: '韩国',
      year: 2026, score: 8.5, playCount: 200000, scrapedAt: '2026-10-12T04:00:00.000Z',
      coverImg: 'https://image.tmdb.org/t/p/original/numeric.jpg', primaryUrl: 'https://www.yfsp.tv/play/malformed-score',
    }],
  };
  const item = (mediaKey, title, extra) => ({
    mediaKey, title, mediaType: '电视剧', regional: '韩国', publishTime: '2026-10-12',
    score: 8, playCount: 100000, type: 4, coverImgUrl: 'https://static.yfsp.tv/numeric.jpg', ...extra,
  });
  const current = [
    item('bad\ud800', '无效编码标识测试韩剧', {}),
    item('malformed-score', '坏分值测试韩剧', { score: { toString: 'invalid' }, playCount: {} }),
    item('malformed-type', '坏类型测试韩剧', { type: { toString: 'invalid' } }),
    item('array-score', '数组分值测试韩剧', { score: [9], type: true }),
    item('valid-numbers', '正常数值测试韩剧', { score: '8.2', playCount: '120000', type: '4' }),
  ];
  let pages = 0;
  const { helpers, files } = loadHelpers({
    date: '2026-10-13T04:00:00.000Z', initialFiles: { [join(dataDir, 'shows.json')]: JSON.stringify(previous) },
    fetchImpl: async url => {
      if (url.includes('api.yfsp.tv/api/list/index') && ++pages === 1) {
        return response({ data: { list: [{ name: '电视剧', list: current }] } });
      }
      return response(null, { status: 503 });
    },
  });
  await helpers.main();
  const published = JSON.parse(files.get(join(dataDir, 'shows.json')));
  const byId = new Map(published.koreanDramas.map(show => [show.id, show]));
  assert.equal(byId.has('bad\ud800'), false, 'a malformed encoded identifier must be isolated to its row');
  assert.equal(byId.get('malformed-score')?.score, 8.5, 'invalid numbers are missing observations, not explicit zeroes');
  assert.equal(byId.get('malformed-score')?.playCount, 200000);
  assert.equal(byId.get('malformed-type')?.type, 0);
  assert.equal(byId.get('array-score')?.score, 0);
  assert.equal(byId.get('array-score')?.type, 0);
  assert.equal(byId.get('valid-numbers')?.score, 8.2, 'later valid rows and numeric strings remain usable');
  assert.equal(byId.get('valid-numbers')?.playCount, 120000);
  assert.equal(byId.get('valid-numbers')?.type, 4);
});

for (const operation of ['search', 'verify']) {
  for (const boundary of ['global', 'stage']) {
  test(`YFSP ${operation} ${boundary} deadlines constrain requests and discard late successful results`, async () => {
    const start = Date.parse('2026-09-30T04:00:00Z');
    const timers = [];
    let signal;
    const { helpers, setNow } = loadHelpers({
      setTimeoutImpl(fn, delay) { const timer = { fn, delay }; timers.push(timer); if (delay === 150 || delay === 0) fn(); return timer; },
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('budget exhausted')), { once: true }));
      },
    });
    const globalDeadline = start + (boundary === 'global' ? 50 : 500);
    const stageDeadline = start + (boundary === 'stage' ? 50 : 500);
    helpers.setEnrichmentDeadline(globalDeadline);
    const show = { title: '预算测试节目', mediaType: '电视剧', regional: '韩国', year: 2026 };
    const pending = operation === 'search'
      ? helpers.searchYfspTitle(show, { deadline: stageDeadline })
      : helpers.verifyYfspUrl(show, 'https://www.yfsp.tv/play/budget', { deadline: stageDeadline });
    assert.ok(signal, 'the test must observe the active request');
    const requestTimeout = timers[0].delay;
    setNow(new Date(start + 50).toISOString());
    timers[0].fn();
    const result = await pending;
    assert.equal(requestTimeout, 50, `the request timeout must fit the remaining ${boundary} budget`);
    assert.equal(operation === 'search' ? result.lookupState : result, 'unknown');

    let late;
    late = loadHelpers({ fetchImpl: async () => {
      late.setNow(new Date(start + 51).toISOString());
      return response({ data: { info: [{ result: [{ title: show.title, atypeName: '电视剧', regional: '韩国', contxt: 'late' }] }] } }, { html: `<title>${show.title}-免费在线观看</title>` });
    } });
    late.helpers.setEnrichmentDeadline(globalDeadline);
    const afterDeadline = operation === 'search'
      ? await late.helpers.searchYfspTitle(show, { deadline: stageDeadline })
      : await late.helpers.verifyYfspUrl(show, 'https://www.yfsp.tv/play/budget', { deadline: stageDeadline });
    assert.equal(operation === 'search' ? afterDeadline.lookupState : afterDeadline, 'unknown', 'late success cannot renew source continuity');
  });
  }
}

for (const explicit of [false, true]) {
  test(`partial other-drama homepage observations ${explicit ? 'apply explicit zeroes and status' : 'preserve missing source fields'}`, async () => {
    const old = {
      id: 'other-partial', title: '部分响应测试剧', mediaType: '电视剧', category: 'other_drama', regional: '大陆',
      year: 2026, score: 6.5, playCount: 2062086, actor: '来源演员', publishTime: '2026-08-01',
      description: '上一轮真实来源确认的节目简介，需要在来源暂时未返回该字段时保留。', descriptionSource: 'yfsp',
      updateStatus: '23集全', currentEpisode: 23, totalEpisodes: 23, isComplete: true, isSerial: false,
      coverImg: 'https://image.tmdb.org/t/p/original/other-poster.jpg', coverSource: 'tmdb',
      yfspCoverImg: 'https://static.yfsp.tv/other-poster.jpg', yfspUrl: 'https://www.yfsp.tv/play/other-partial',
      primaryUrl: 'https://www.yfsp.tv/play/other-partial', primaryUrlSource: 'yfsp', scrapedAt: '2026-10-03T00:00:00Z',
    };
    const previous = { lastUpdated: '2026-10-03T00:00:00Z', stats: { totalScraped: 30 }, koreanDramas: [], chineseVariety: [], otherDramas: [old] };
    const initialFiles = {
      [join(dataDir, 'shows.json')]: JSON.stringify(previous),
      [join(dataDir, 'image_cache.json')]: '{}', [join(dataDir, 'discovery.json')]: '{}',
    };
    let pages = 0;
    const { helpers, files } = loadHelpers({
      initialFiles, date: new Date(Date.parse(previous.lastUpdated) + 60000).toISOString(),
      env: { TMDB_TOKEN: 'test-token' },
      fetchImpl: async url => {
        if (url.includes('api.yfsp.tv/api/list/index') && ++pages === 1) return response({ data: { list: [{ name: '电视剧', list: [{
          mediaKey: old.id, title: old.title, mediaType: old.mediaType, regional: old.regional, coverImgUrl: old.yfspCoverImg,
          ...(explicit ? { score: 0, playCount: 0, isSerial: true, updateStatus: '更新到02' } : {}),
        }] }] } });
        return response(null, { status: 503 });
      },
    });
    await helpers.main();
    const published = JSON.parse(files.get(join(dataDir, 'shows.json')));
    const current = published.otherDramas.find(show => show.id === old.id);
    assert.equal(published.sourceStatus, 'degraded');
    assert.equal(published.lastUpdated, previous.lastUpdated);
    for (const field of ['description', 'descriptionSource', 'actor', 'publishTime', 'year', 'totalEpisodes']) assert.equal(current[field], old[field], field);
    if (explicit) {
      assert.equal(current.score, 0);
      assert.equal(current.playCount, 0);
      assert.equal(current.isComplete, false);
      assert.equal(current.isSerial, true);
      assert.equal(current.currentEpisode, 2);
      assert.equal(current.updateStatus, '更新到02');
    } else {
      for (const field of ['score', 'playCount', 'updateStatus', 'currentEpisode', 'isComplete', 'isSerial']) assert.equal(current[field], old[field], field);
    }
  });
}

test('variety seeds and title-based snapshot identity cannot combine different regions', () => {
  const { helpers } = loadHelpers();
  const seed = helpers.SEED_VARIETY.find(show => show.title === '密室大逃脱');
  assert.equal(seed.regional, '大陆');
  const foreign = { id: 'foreign', title: seed.title, year: seed.year, mediaType: '综艺', regional: '韩国', score: 10, actor: '其他地区演员' };
  assert.equal(helpers.findLiveTitleMatch(seed, new Map([[foreign.id, foreign]]), '综艺', show => ['大陆', '韩国'].includes(show.regional)), null);
  assert.equal(helpers.sameShowIdentity({ ...seed, mediaType: '综艺' }, foreign), false);
  const local = { ...foreign, id: 'local', regional: '大陆', score: 5, actor: '本地演员' };
  const found = helpers.findLiveTitleMatch(seed, new Map([[foreign.id, foreign], [local.id, local]]), '综艺', show => ['大陆', '韩国'].includes(show.regional));
  assert.equal(found.id, local.id);
  assert.equal(helpers.applyLiveFields(seed, found).actor, local.actor);
});

for (const withAI of [false, true]) {
  test(`offline recalculation excludes blacklisted variety before ${withAI ? 'fresh AI blending' : 'publication'}`, async () => {
    const show = {
      id: 'excluded', title: '乘风', year: 2026, category: 'variety', mediaType: '综艺', regional: '大陆',
      coverImg: 'https://image.tmdb.org/t/p/original/source.jpg', primaryUrl: 'https://www.yfsp.tv/play/excluded', score: 8, playCount: 100,
    };
    const safe = { ...show, id: 'safe', title: '普通搞笑综艺', primaryUrl: 'https://www.yfsp.tv/play/safe' };
    const { helpers, files } = loadHelpers();
    if (withAI) {
      show.aiScore = 100;
      show.aiScoreVersion = helpers.AI_SCORE_CACHE_VERSION;
      show.aiScoredAt = '2026-09-30T04:00:00Z';
      show.aiScoreInputHash = helpers.aiScoreInputHash(show);
      assert.equal(helpers.isFreshAIScore(show), true);
    }
    files.set(join(dataDir, 'shows.json'), JSON.stringify({ lastUpdated: '2026-09-30T04:00:00Z', stats: {}, koreanDramas: [], chineseVariety: [show, safe], otherDramas: [] }));
    await helpers.recalculateExistingData();
    const published = JSON.parse(files.get(join(dataDir, 'shows.json')));
    assert.deepEqual(published.chineseVariety.map(entry => entry.id), ['safe']);
    assert.equal(published.stats.chineseVariety, 1);
    assert.ok(published.chineseVariety[0].recommendScore >= 0);
  });
}

test('a series without a poster can still provide the matching season poster', async () => {
  const requests = [];
  const { helpers } = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async url => {
    requests.push(url);
    if (url.includes('/search/tv?')) return response({ results: [{ id: 220074, name: '财阀X刑警', first_air_date: '2024-01-26', origin_country: ['KR'], poster_path: null }] });
    if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, name: '第2季', season_number: 2, air_date: '2026-08-01', poster_path: '/season-only.jpg' });
    if (url.includes('/tv/220074/external_ids')) return response({});
    assert.fail(`unexpected URL: ${url}`);
  } });
  const found = await helpers.searchTMDBImage({ title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国' });
  assert.equal(found.url, 'https://image.tmdb.org/t/p/original/season-only.jpg');
  assert.equal(found.tmdbUrl, 'https://www.themoviedb.org/tv/220074/season/2');
  assert.ok(requests.some(url => url.includes('/season/2?')));
});

test('generated descriptions cannot alter rule scores or source content eligibility', () => {
  const { helpers } = loadHelpers();
  const show = { id: 'facts', title: '普通节目', year: 2026, score: 8, contentType: '剧情', description: '' };
  const generated = { ...show, descriptionSource: 'ai', description: '温馨治愈的浪漫喜剧，欢乐爆笑、轻松下饭。' };
  const sourced = { ...generated, descriptionSource: 'yfsp' };
  for (const scoreFn of [helpers.scoreKDrama, helpers.scoreVariety]) {
    assert.equal(scoreFn({ ...generated }), scoreFn({ ...show }));
    assert.ok(scoreFn({ ...sourced }) > scoreFn({ ...show }), 'trusted source facts must still affect scoring');
  }
  const riskCopy = { ...show, descriptionSource: 'ai', description: '适合不喜欢恐怖和血腥的观众。' };
  assert.equal(helpers.isEligibleKDrama(riskCopy), true);
  assert.equal(helpers.isEligibleKDrama({ ...riskCopy, descriptionSource: 'tmdb' }), false);
  const accepted = new Map([[riskCopy.id, riskCopy]]);
  assert.equal(helpers.removeHardExcludedKDrama(accepted), 0);
  assert.equal(accepted.size, 1);
});

test('unsafe AI copy is rejected without deleting a previously accepted show', async () => {
  const { helpers } = loadHelpers({
    env: { OPENROUTER_API_KEY: 'test-token' },
    fetchImpl: async () => response({ choices: [{ message: { content: JSON.stringify({ results: [
      { id: 'unsafe', d: '这是一部充满恐怖、血腥场面的剧集，值得体验。' },
      { id: 'safe', d: '资料有限，喜欢轻松喜剧的观众可以关注后续来源简介。' },
    ] }) } }] }),
  });
  const shows = [
    { id: 'unsafe', title: '可靠节目', description: '来源短简介', descriptionSource: 'yfsp' },
    { id: 'safe', title: '另一部节目', description: '' },
  ];
  assert.equal(await helpers.aiEnhanceDescriptions(shows), 1);
  assert.equal(shows[0].description, '来源短简介');
  assert.equal(shows[0].descriptionSource, 'yfsp');
  assert.equal(shows[1].descriptionSource, 'ai');
  const accepted = new Map(shows.map(show => [show.id, show]));
  assert.equal(helpers.removeHardExcludedKDrama(accepted), 0);
  assert.equal(accepted.size, 2);
});

test('short source descriptions retain scoring facts while AI fills only missing or generated copy', async () => {
  const requestedIds = [];
  const { helpers } = loadHelpers({
    env: { OPENROUTER_API_KEY: 'test-token' },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const ids = request.response_format.json_schema.schema.properties.results.items.properties.id.enum;
      requestedIds.push(...ids);
      return response({ choices: [{ message: { content: JSON.stringify({ results: ids.map(id => ({
        id, d: '喜欢轻松节奏的观众可以关注这部节目，更多可靠资料待后续来源补充。',
      })) }) } }] });
    },
  });
  const sourced = ['yfsp', 'tmdb', 'wikipedia', 'douban', 'seed', undefined].map((descriptionSource, index) => ({
    id: `sourced-${index}`, title: '普通韩剧', year: 2026, score: 8, contentType: '剧情',
    description: '律师职场喜剧', ...(descriptionSource ? { descriptionSource } : {}),
  }));
  for (const show of sourced) {
    show.aiScore = 80;
    show.aiScoreVersion = helpers.AI_SCORE_CACHE_VERSION;
    show.aiScoredAt = '2026-09-30T04:00:00Z';
    show.aiScoreInputHash = helpers.aiScoreInputHash(show);
  }
  const before = sourced.map(show => ({
    descriptionSource: show.descriptionSource, ruleScore: helpers.scoreKDrama({ ...show }), hash: helpers.aiScoreInputHash(show),
  }));
  const missing = { id: 'missing', title: '缺少简介', description: '' };
  const generated = { id: 'generated', title: '已有文案', description: '资料待补充', descriptionSource: 'ai' };
  assert.equal(await helpers.aiEnhanceDescriptions([...sourced, missing, generated]), 2);
  assert.deepEqual(requestedIds, ['missing', 'generated']);
  for (const [index, show] of sourced.entries()) {
    assert.equal(show.description, '律师职场喜剧');
    assert.equal(show.descriptionSource, before[index].descriptionSource);
    assert.equal(helpers.scoreKDrama({ ...show }), before[index].ruleScore);
    assert.equal(helpers.aiScoreInputHash(show), before[index].hash);
    assert.equal(helpers.isFreshAIScore(show), true);
  }
  assert.equal(missing.descriptionSource, 'ai');
  assert.equal(generated.descriptionSource, 'ai');
});

test('YFSP live matching rejects a higher scoring different season and retains aliases', () => {
  const { helpers } = loadHelpers();
  const seed = { title: '欢乐喜剧人第4季', year: 2018, mediaType: '综艺', regional: '大陆' };
  const wrong = { id: 'wrong', title: '欢乐喜剧人第5季', year: 2019, score: 9, mediaType: '综艺', regional: '大陆' };
  const same = { ...wrong, id: 'same', title: '欢乐喜剧人第四季', year: 2018, score: 7 };
  assert.equal(helpers.findLiveTitleMatch(seed, new Map([['wrong', wrong]]), '综艺'), null);
  assert.equal(helpers.findLiveTitleMatch(seed, new Map([['wrong', wrong], ['same', same]]), '综艺')?.id, 'same');
  const alias = { id: 'alias', title: '菜鸟炊事兵', year: 2026, mediaType: '电视剧', regional: '韩国' };
  assert.equal(helpers.findLiveTitleMatch({ title: '菜鸟伙房兵', year: 2026 }, new Map([['alias', alias]]), '电视剧')?.id, 'alias');
});

test('YFSP search skips an incompatible season before applying hotness ranking', async () => {
  const show = { title: '欢乐喜剧人第4季', year: 2018, mediaType: '综艺', regional: '大陆' };
  const wrong = { title: '欢乐喜剧人第5季', atypeName: '综艺', regional: '大陆', postTime: '2019-01-01', contxt: 'wrong', hot: 9999999 };
  const { helpers } = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [
    wrong, { ...wrong, title: '欢乐喜剧人第四季', postTime: '2018-01-01', contxt: 'same', hot: 10000 },
  ] }] } }) });
  assert.equal(helpers.scoreYfspCandidate(show, wrong), -1);
  assert.equal((await helpers.searchYfspTitle(show))?.url, 'https://www.yfsp.tv/play/same');
});

test('YFSP page verification rejects a different explicit season', async () => {
  let title = '欢乐喜剧人第5季';
  const { helpers } = loadHelpers({ fetchImpl: async () => response(null, { html: `<title>${title}-免费在线观看-爱壹帆国际版</title>` }) });
  const show = { title: '欢乐喜剧人第4季' };
  assert.equal(await helpers.verifyYfspUrl(show, 'https://www.yfsp.tv/play/show'), 'invalid');
  title = '欢乐喜剧人第四季';
  assert.equal(await helpers.verifyYfspUrl(show, 'https://www.yfsp.tv/play/show'), 'valid');
});

test('Douban Korean drama matching excludes another season despite a nearby year', async () => {
  const { helpers } = loadHelpers({ fetchImpl: async () => response([
    { id: '123455', title: '酒鬼都市女人们第1季', year: '2021' },
    { id: '123456', title: '酒鬼都市女人们第二季', year: '2022' },
  ]) });
  const found = await helpers.searchDoubanSubject({ title: '酒鬼都市女人们第2季', year: 2022, mediaType: '电视剧' });
  assert.equal(found?.doubanId, '123456');
  const unknownYear = await helpers.searchDoubanSubject({ title: '酒鬼都市女人们第2季', year: 0, mediaType: '电视剧' });
  assert.equal(unknownYear?.doubanId, '123456', 'unknown-year fallback must enforce the same season boundary');
});

test('Douban season identity also checks an explicit English subtitle', async () => {
  const { helpers } = loadHelpers({ fetchImpl: async () => response([
    { id: '123455', title: '杀人者的购物中心', sub_title: 'A Shop for Killers Season 1', year: '2024' },
    { id: '123456', title: '杀人者的购物中心2', sub_title: 'A Shop for Killers Season 2', year: '2026' },
  ]) });
  const found = await helpers.searchDoubanSubject({ title: '杀人者的购物中心2', year: 0, mediaType: '电视剧' });
  assert.equal(found?.doubanId, '123456');
});

test('TMDB can still find a base series and resolve the requested season', async () => {
  const { helpers } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    fetchImpl: async url => {
      if (url.includes('/search/tv?')) return response({ results: [{ id: 220074, name: '财阀X刑警', poster_path: '/base.jpg', origin_country: ['KR'] }] });
      if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, name: '第2季', season_number: 2, air_date: '2026-08-01', poster_path: '/season.jpg' });
      if (url.includes('/tv/220074/external_ids')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const found = await helpers.searchTMDBImage({ title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国' });
  assert.equal(found?.tmdbUrl, 'https://www.themoviedb.org/tv/220074/season/2');
  assert.equal(found?.url, 'https://image.tmdb.org/t/p/original/season.jpg');
});

function previouslySeenShow() {
  return {
    id: 'ongoing', title: '持续更新测试', year: 2026, mediaType: '综艺', regional: '大陆',
    score: 7, isSerial: true, isComplete: false, updateStatus: '更新到08',
    scrapedAt: '2026-08-18T00:00:00Z', yfspUrl: 'https://www.yfsp.tv/play/ongoing',
    yfspLookupState: 'valid', yfspLookupUrl: 'https://www.yfsp.tv/play/ongoing',
    yfspLookupCheckedAt: '2026-09-30T04:00:00Z',
  };
}

test('a successful partial YFSP search renews continuity beyond the old homepage timestamp', async () => {
  const { helpers, setNow } = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [{
    title: '持续更新测试', contxt: 'ongoing', atypeName: '综艺', regional: '大陆', postTime: '2026-08-01', hot: 100000,
  }] }] } }) });
  const show = previouslySeenShow();
  await helpers.enrichMissingYfspLinks([show]);
  assert.equal(show.lastLiveAt, '2026-09-30T04:00:00.000Z');
  assert.equal(show.updateStatus, '更新到08', 'a partial result must not erase previous episode status');
  setNow('2026-10-03T04:00:00Z');
  const retained = new Map();
  const result = helpers.restorePreviousCategory(retained, [show], 'variety', '综艺', () => 100, 'disc_var');
  assert.equal(retained.size, 1);
  assert.equal(result.expired, 0);
});

test('a newer homepage observation takes precedence over an older successful search', () => {
  const { helpers, setNow } = loadHelpers();
  setNow('2026-10-03T04:00:00Z');
  const retained = new Map();
  const show = { ...previouslySeenShow(), lastLiveAt: '2026-08-18T00:00:00Z', scrapedAt: '2026-10-02T04:00:00Z' };
  helpers.restorePreviousCategory(retained, [show], 'variety', '综艺', () => 100, 'disc_var');
  assert.equal(retained.size, 1);
});

test('failed YFSP searches do not renew source continuity', async () => {
  const { helpers, setNow } = loadHelpers({ fetchImpl: async () => response(null, { status: 503 }) });
  const show = previouslySeenShow();
  await helpers.enrichMissingYfspLinks([show]);
  assert.equal(show.lastLiveAt, undefined);
  assert.equal(show.scrapedAt, '2026-08-18T00:00:00Z');
  setNow('2026-10-03T04:00:00Z');
  const retained = new Map();
  const result = helpers.restorePreviousCategory(retained, [show], 'variety', '综艺', () => 100, 'disc_var');
  assert.equal(retained.size, 0);
  assert.equal(result.expired, 1);
});

test('seed fallbacks preserve sourced descriptions and dynamic facts until the source returns them', () => {
  const { helpers } = loadHelpers();
  const seed = helpers.SEED_KDRAMAS.find(show => show.title === '善意的竞争');
  const previous = {
    ...seed, id: 'published-live', seedId: seed.id,
    description: '来源确认的精英学校学生故事。', descriptionSource: 'tmdb',
    score: 8.4, playCount: 1971145, totalEpisodes: 10, currentEpisode: 10,
    isSerial: false, isComplete: true, publishTime: '2025-02-10',
    scrapedAt: '2026-09-29T00:00:00Z',
  };
  const fallback = helpers.applyLiveFields({ ...seed, seedId: seed.id, scrapedAt: '' }, null);
  const retained = helpers.mergePreviousShowState(fallback, previous);
  for (const field of ['description', 'descriptionSource', 'score', 'playCount', 'totalEpisodes', 'currentEpisode', 'isSerial', 'isComplete', 'publishTime', 'scrapedAt']) {
    assert.equal(retained[field], previous[field], `${field} must survive a source-less seed fallback`);
  }
  assert.equal(fallback.descriptionSource, 'seed');
  assert.equal(fallback._sourceFields.size, 0);

  const live = helpers.normalizeItem({
    mediaKey: 'published-live', title: seed.title, mediaType: '电视剧', regional: '韩国',
    score: 0, playCount: 0, isSerial: false,
  });
  const partial = helpers.applyLiveFields({ ...seed, seedId: seed.id }, live);
  assert.equal(partial._sourceFields.has('description'), false, 'curated seed copy is not a live source description');
  const updated = helpers.mergePreviousShowState(partial, previous);
  assert.equal(updated.description, previous.description);
  assert.equal(updated.descriptionSource, 'tmdb');
  assert.equal(updated.score, 0);
  assert.equal(updated.playCount, 0);
  assert.equal(updated.isSerial, false);
  assert.equal(updated.scrapedAt, '2026-09-30T04:00:00.000Z');

  const fresh = helpers.applyLiveFields({ ...seed, seedId: seed.id }, helpers.normalizeItem({
    mediaKey: 'published-live', title: seed.title, mediaType: '电视剧', regional: '韩国',
    description: '本轮来源确认的新简介。',
  }));
  const replaced = helpers.mergePreviousShowState(fresh, previous);
  assert.equal(replaced.description, '本轮来源确认的新简介。');
  assert.equal(replaced.descriptionSource, 'yfsp');
});

test('a complete all-503 run preserves published source descriptions and dynamic facts', async () => {
  const initialFiles = Object.fromEntries(['shows.json', 'image_cache.json', 'discovery.json', 'history.json']
    .map(file => [join(dataDir, file), readFileSync(join(root, 'data', file), 'utf8')]));
  const previous = JSON.parse(initialFiles[join(dataDir, 'shows.json')]);
  const date = new Date(Date.parse(previous.lastUpdated) + 60000).toISOString();
  const { helpers, files } = loadHelpers({ initialFiles, date, fetchImpl: async () => response(null, { status: 503 }) });
  await helpers.main();
  const published = JSON.parse(files.get(join(dataDir, 'shows.json')));
  assert.equal(published.sourceStatus, 'degraded');
  assert.equal(published.lastUpdated, previous.lastUpdated);
  let checked = 0;
  for (const category of ['koreanDramas', 'chineseVariety']) {
    for (const old of previous[category]) {
      const current = published[category].find(show => helpers.sameShowIdentity(show, old));
      if (!current) continue; // The existing retirement window still applies to old non-seed recommendations.
      if (old.description && ['yfsp', 'tmdb', 'wikipedia'].includes(old.descriptionSource)) {
        assert.equal(current.description, old.description, `${old.title}: preserve the sourced description`);
        assert.equal(current.descriptionSource, old.descriptionSource, `${old.title}: preserve provenance`);
        checked++;
      }
      for (const field of ['score', 'playCount', 'totalEpisodes', 'currentEpisode', 'isComplete', 'isSerial', 'updateStatus', 'updateMsg', 'publishTime', 'scrapedAt']) {
        if (Object.hasOwn(old, field)) assert.equal(current[field], old[field], `${old.title}: preserve ${field}`);
      }
    }
  }
  assert.ok(checked >= 20, 'the full pipeline fixture must exercise many real sourced descriptions');
});

test('known legacy seed metadata is repaired before snapshot merging and recommendation scoring', async () => {
  const old = {
    id: 'seed_kd_2025_07', seedId: 'seed_kd_2025_07', title: '善意的竞争', year: 2025,
    mediaType: '电视剧', regional: '韩国', category: 'korean_drama',
    contentType: '剧情·喜剧·职场', description: '来源确认的精英学校悬疑故事。', descriptionSource: 'tmdb',
    score: 8.4, playCount: 1971145, totalEpisodes: 16, currentEpisode: 16,
    isComplete: true, isSerial: false, scrapedAt: '',
    coverImg: 'https://image.tmdb.org/t/p/original/verified.jpg',
    tmdbUrl: 'https://www.themoviedb.org/tv/259288', primaryUrl: 'https://www.themoviedb.org/tv/259288',
  };
  const snapshot = { lastUpdated: '2026-09-30T04:00:00Z', stats: {}, koreanDramas: [old], chineseVariety: [], otherDramas: [] };
  const { helpers, files } = loadHelpers({ initialFiles: { [join(dataDir, 'shows.json')]: JSON.stringify(snapshot) } });
  const previous = helpers.loadPreviousShows().koreanDramas[0];
  const seed = helpers.SEED_KDRAMAS.find(show => show.id === old.seedId);
  const merged = helpers.mergePreviousShowState(helpers.applyLiveFields({ ...seed, seedId: seed.id }, null), previous);
  assert.equal(merged.contentType, seed.contentType, 'the known bad historical genre must not override its correction');
  for (const field of ['score', 'playCount', 'description', 'descriptionSource']) assert.equal(merged[field], old[field]);
  assert.ok(helpers.scoreKDrama(merged) < helpers.scoreKDrama({ ...merged, contentType: old.contentType }));
  await helpers.recalculateExistingData();
  const recalculated = JSON.parse(files.get(join(dataDir, 'shows.json')));
  assert.equal(recalculated.koreanDramas[0].contentType, seed.contentType);
  assert.equal(recalculated.lastUpdated, snapshot.lastUpdated);
});

test('valid completed YFSP pages renew continuity while invalid and unknown pages do not', async () => {
  const shows = ['valid', 'invalid', 'unknown'].map(id => ({
    ...previouslySeenShow(), id, title: `完结节目 ${id}`, isComplete: true, isSerial: false,
    updateStatus: '10集全', yfspUrl: `https://www.yfsp.tv/play/${id}`,
    yfspLookupCheckedAt: '2026-09-01T00:00:00Z', yfspLookupUrl: `https://www.yfsp.tv/play/${id}`,
  }));
  const { helpers, setNow } = loadHelpers({ fetchImpl: async url => {
    const id = url.split('/').at(-1);
    if (id === 'valid') return response(null, { html: '<title>完结节目 valid-免费在线观看-爱壹帆国际版</title>' });
    return response(null, { status: id === 'invalid' ? 404 : 503 });
  } });
  await helpers.enrichMissingYfspLinks(shows);
  assert.equal(shows[0].lastLiveAt, '2026-09-30T04:00:00.000Z');
  assert.equal(shows[1].lastLiveAt, undefined);
  assert.equal(shows[2].lastLiveAt, undefined);
  assert.equal(shows[2].yfspUrl, 'https://www.yfsp.tv/play/unknown');
  setNow('2026-10-03T04:00:00Z');
  const retained = new Map();
  helpers.restorePreviousCategory(retained, shows, 'variety', '综艺', () => 100, 'disc_var');
  assert.deepEqual([...retained.keys()], ['valid']);
});

function seasonCache(overrides = {}) {
  return {
    title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧',
    source: 'tmdb', version: 16, matchedTitle: '财阀X刑警第2季', matchedSeriesTitle: '财阀X刑警',
    url: 'https://image.tmdb.org/t/p/original/season.jpg',
    tmdbId: 220074, tmdbSeriesId: 220074, tmdbSeasonNumber: 2,
    tmdbUrl: 'https://www.themoviedb.org/tv/220074/season/2',
    ...overrides,
  };
}

for (const verified of [false, true]) {
  test(`TMDB series metadata ${verified ? 'preserves an independently verified season subject' : 'cannot certify a season Douban subject'}`, async () => {
    const requests = [];
    const { helpers, files } = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async url => {
      requests.push(url);
      if (url.includes('/tv/220074?')) return response({ id: 220074, name: '财阀X刑警', origin_country: ['KR'] });
      if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, season_number: 2, name: '第2季', air_date: '2026-08-01', poster_path: '/correct.jpg' });
      if (url.includes('/tv/220074/external_ids')) return response({ wikidata_id: 'Q123456' });
      if (url.includes('Special:EntityData/Q123456.json')) return response({ entities: { Q123456: { claims: { P4529: [{ mainsnak: { datavalue: { value: '999999' } } }] } } } });
      if (url.includes('movie.douban.com/j/subject_suggest')) return response([{ id: '222222', title: '财阀X刑警', sub_title: '财阀X刑警第2季', year: '2026' }]);
      assert.fail(`unexpected URL: ${url}`);
    } });
    const show = {
      id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国', tmdbSeriesId: 220074,
      coverImg: 'https://static.yfsp.tv/source.jpg',
      ...(verified ? { doubanUrl: 'https://movie.douban.com/subject/123456/', doubanId: '123456', doubanMatchedTitle: '财阀X刑警第2季' } : {}),
    };
    await helpers.enrichCoversFromTMDB([show]);
    assert.equal(show.doubanUrl, verified ? 'https://movie.douban.com/subject/123456/' : '');
    await helpers.enrichDoubanLinks([show]);
    assert.equal(show.doubanUrl, `https://movie.douban.com/subject/${verified ? '123456' : '222222'}/`);
    assert.equal(show.doubanMatchedTitle, show.title, 'season evidence in a subtitle must survive lookup and caching');
    const saved = JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show;
    for (const field of ['doubanUrl', 'doubanId', 'doubanMatchedTitle']) assert.equal(saved[field], show[field], field);
    const count = requests.length;
    await helpers.enrichCoversFromTMDB([show]);
    assert.equal(requests.length, count, 'verified subject evidence should survive the next reusable-cache pass');
    assert.equal(show.doubanMatchedTitle, show.title);
  });
}

test('reusable TMDB season caches cannot overwrite independent subject evidence', async () => {
  const cached = seasonCache({ doubanUrl: 'https://movie.douban.com/subject/999999/' });
  const { helpers, files } = loadHelpers({ initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) } });
  const show = {
    id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', coverImg: cached.url,
    doubanUrl: 'https://movie.douban.com/subject/123456/', doubanId: '123456', doubanMatchedTitle: cached.title,
  };
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(show.doubanUrl, 'https://movie.douban.com/subject/123456/');
  assert.equal(show.doubanId, '123456');
  assert.equal(show.doubanMatchedTitle, show.title);
  const saved = JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show;
  assert.equal(saved.doubanUrl, show.doubanUrl);
  assert.equal(saved.doubanId, show.doubanId);
});

test('season caches clear mismatched subject IDs and retain consistent cached verification', async () => {
  for (const consistent of [false, true]) {
    const cached = seasonCache({ doubanUrl: 'https://movie.douban.com/subject/123456/', doubanId: consistent ? '123456' : '999999', doubanMatchedTitle: '财阀X刑警第2季' });
    const { helpers, files } = loadHelpers({ initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) } });
    const show = { id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', coverImg: cached.url };
    await helpers.enrichCoversFromTMDB([show]);
    const saved = JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show;
    if (consistent) {
      assert.equal(show.doubanUrl, cached.doubanUrl);
      assert.equal(show.doubanId, cached.doubanId);
      assert.equal(show.doubanMatchedTitle, cached.doubanMatchedTitle);
    } else {
      for (const entry of [show, saved]) {
        assert.equal(entry.doubanUrl, '');
        assert.equal(Object.hasOwn(entry, 'doubanId'), false);
        assert.equal(Object.hasOwn(entry, 'doubanMatchedTitle'), false);
      }
    }
  }
});

test('Douban season evidence from an English subtitle survives the next TMDB cache pass', async () => {
  const cached = seasonCache({ title: '酒鬼都市女人们第1季', matchedTitle: '酒鬼都市女人们第1季', matchedSeriesTitle: '酒鬼都市女人们', year: 2021, tmdbSeasonNumber: 1, tmdbUrl: 'https://www.themoviedb.org/tv/220074/season/1' });
  let requests = 0;
  const { helpers, files } = loadHelpers({
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) },
    fetchImpl: async url => {
      requests++;
      assert.ok(url.includes('movie.douban.com/j/subject_suggest'));
      return response([{ id: '34849938', title: '酒鬼都市女人们', sub_title: 'Work Later Drink Now Season 1', year: '2021' }]);
    },
  });
  const show = { id: 'show', title: cached.title, year: 2021, mediaType: '电视剧', regional: '韩国', coverImg: cached.url };
  await helpers.enrichDoubanLinks([show]);
  assert.equal(show.doubanUrl, 'https://movie.douban.com/subject/34849938/');
  assert.equal(show.doubanMatchedTitle, '酒鬼都市女人们');
  assert.equal(show.doubanMatchedSeasonNumber, 1);
  const count = requests;
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(requests, count);
  assert.equal(show.doubanUrl, 'https://movie.douban.com/subject/34849938/');
  assert.equal(JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show.doubanMatchedSeasonNumber, 1);
});

test('season descriptions use the confirmed season endpoint and never a series Wikipedia fallback', async () => {
  for (const returnedSeason of [2, 1, null]) {
    const requests = [];
    const { helpers } = loadHelpers({
      env: { TMDB_TOKEN: 'test-token' },
      initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: seasonCache() }) },
      fetchImpl: async url => {
        requests.push(url);
        if (returnedSeason === null) return response(null, { status: 503 });
        return response({ season_number: returnedSeason, overview: '第二季独立的可靠剧情介绍，保留本季的故事和人物。' });
      },
    });
    const show = {
      id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
      description: '本季短简介', descriptionSource: 'yfsp', wikipediaUrl: 'https://zh.wikipedia.org/wiki/Series',
    };
    await helpers.enrichDescriptions([show]);
    assert.deepEqual(requests, ['https://api.themoviedb.org/3/tv/220074/season/2?language=zh-CN']);
    assert.equal(show.descriptionSource, returnedSeason === 2 ? 'tmdb' : 'yfsp');
    assert.equal(show.description, returnedSeason === 2 ? '第二季独立的可靠剧情介绍，保留本季的故事和人物。' : '本季短简介');
  }
  const { helpers } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: seasonCache({ version: 14, tmdbUrl: 'https://www.themoviedb.org/tv/220074' }) }) },
    fetchImpl: async () => { assert.fail('an unconfirmed series cache must not supply a season description'); },
  });
  const unconfirmed = { id: 'show', title: '财阀X刑警第2季', description: '已有本季介绍', wikipediaUrl: 'https://zh.wikipedia.org/wiki/Series' };
  await helpers.enrichDescriptions([unconfirmed]);
  assert.equal(unconfirmed.description, '已有本季介绍');
});

test('an unverified historical season link cannot supply a synopsis without entity evidence', async () => {
  for (const cache of [{}, { show: seasonCache({ matchedSeriesTitle: undefined }) }]) {
    const requests = [];
    const { helpers } = loadHelpers({
      env: { TMDB_TOKEN: 'test-token' },
      initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify(cache) },
      fetchImpl: async url => { requests.push(url); return response({ season_number: 2, overview: '错误系列的很长简介，不应进入该节目的来源事实。' }); },
    });
    const show = {
      id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
      description: '已有本季可靠介绍', descriptionSource: 'yfsp',
      tmdbUrl: 'https://www.themoviedb.org/tv/220074/season/2',
      wikipediaUrl: 'https://zh.wikipedia.org/wiki/Series',
    };
    await helpers.enrichDescriptions([show]);
    assert.deepEqual(requests, []);
    assert.equal(show.description, '已有本季可靠介绍');
    assert.equal(show.descriptionSource, 'yfsp');
  }
});

test('legacy long series synopses migrate to the real shorter season synopsis once', async () => {
  // Freeze the published 239-character first-season text so future data repairs cannot invalidate this regression.
  const previous = {
    id: 'historical-comedian-season4', title: '欢乐喜剧人第4季', year: 2018, mediaType: '综艺', regional: '大陆',
    description: '2015年4月，一档有东方卫视与欢乐传媒联合打造的明星喜剧经验真人秀节目《欢乐喜剧人》正式与全国观众界面。节目延请国内各界极具代表性的喜剧明星加盟，如在时尚都市男女中知名度颇高的开心麻花、东北军后起之秀宋小宝、心宽体胖的女汉子贾玲、相声领域的李菁和曹云金、邓超做老板的白眉工作室、爱笑兄弟乔杉、修睿，此外更有高晓攀、九孔、刘仪伟、吴君如等人的乱入，让节目精彩纷呈，笑果不断。除此之外，被万千女性视为男神的吴秀波担当主持，使这档节目平添了更多的看点。。最强喜剧人大混战，不容错过。',
    descriptionSource: 'tmdb', tmdbUrl: 'https://www.themoviedb.org/tv/104552/season/4',
  };
  assert.equal(previous.description.length, 239);
  const cache = seasonCache({
    title: previous.title, year: previous.year, mediaType: previous.mediaType, matchedTitle: '欢乐喜剧人第4季',
    matchedSeriesTitle: undefined, tmdbId: 104552, tmdbSeriesId: 104552, tmdbSeasonNumber: 4, tmdbUrl: previous.tmdbUrl,
  });
  const verified = { ...cache, matchedSeriesTitle: '欢乐喜剧人' };
  const requests = [];
  const { helpers } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ [previous.id]: verified }) },
    fetchImpl: async url => { requests.push(url); return response({ season_number: 4, overview: '第四季由郭德纲主持，新喜剧团队登上竞演舞台。' }); },
  });
  const show = { ...previous };
  await helpers.enrichDescriptions([show]);
  assert.equal(show.description, '第四季由郭德纲主持，新喜剧团队登上竞演舞台。');
  assert.equal(show.descriptionSource, 'tmdb');
  assert.equal(show.descriptionTmdbSeasonUrl, cache.tmdbUrl);
  assert.deepEqual(requests, ['https://api.themoviedb.org/3/tv/104552/season/4?language=zh-CN']);
  await helpers.enrichDescriptions([show]);
  assert.equal(requests.length, 1, 'a confirmed short season synopsis must not fetch again solely because it is short');
  const restored = helpers.mergePreviousShowState(helpers.applyLiveFields({ title: show.title, description: '本季种子兜底简介' }, null), show);
  await helpers.enrichDescriptions([restored]);
  assert.equal(restored.description, show.description);
  assert.equal(restored.descriptionTmdbSeasonUrl, show.descriptionTmdbSeasonUrl);
  assert.equal(requests.length, 1, 'description evidence must survive next-run seed merging');
});

test('empty confirmed season synopses retire legacy series text but transient failures preserve it', async () => {
  for (const scenario of ['empty', 'seed-fallback', 'failed', 'other-season']) {
    const previous = { id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国', description: '旧系列简介，只有第一季的剧情，不能冒充第二季的事实。'.repeat(5), descriptionSource: 'wikipedia' };
    const { helpers } = loadHelpers({
      env: { TMDB_TOKEN: 'test-token' },
      initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: seasonCache() }) },
      fetchImpl: async () => scenario === 'failed'
        ? response(null, { status: 503 })
        : response({ season_number: scenario === 'other-season' ? 1 : 2, overview: '' }),
    });
    const show = scenario === 'seed-fallback'
      ? helpers.mergePreviousShowState(helpers.applyLiveFields({ ...previous, description: '本季种子兜底简介', descriptionSource: 'seed' }, null), previous)
      : { ...previous };
    await helpers.enrichDescriptions([show]);
    if (scenario === 'empty') {
      assert.equal(show.description, '');
      assert.equal(show.descriptionSource, undefined);
    } else if (scenario === 'seed-fallback') {
      assert.equal(show.description, '本季种子兜底简介');
      assert.equal(show.descriptionSource, 'seed');
      assert.equal(JSON.stringify(show).includes('_seasonDescriptionFallback'), false, 'fallback bookkeeping must stay private');
    } else {
      assert.equal(show.description, previous.description);
      assert.equal(show.descriptionSource, previous.descriptionSource);
    }
    assert.equal(show.descriptionTmdbSeasonUrl, undefined);
  }
});

test('same-day discoveries accumulate by identity and survive later empty or failed scans', async () => {
  let searchResults = [{ title: '新韩剧第2季', regional: '韩国', atypeName: '电视剧', postTime: '2026-01-01', score: 8, hot: 100000, contxt: 'new2' }];
  let failed = false;
  const { helpers, files } = loadHelpers({ fetchImpl: async () => failed
    ? response(null, { status: 503 })
    : response({ data: { info: [{ result: searchResults }] } }) });
  const first = await helpers.discoverNewKDramas(new Map(), new Map());
  const readDay = () => JSON.parse(files.get(join(dataDir, 'discovery.json')))['2026-09-30'];
  assert.equal(readDay().totalFound, 1);
  searchResults = [searchResults[0], { ...searchResults[0], title: '新韩剧第3季', contxt: 'new3' }];
  const second = await helpers.discoverNewKDramas(new Map(), new Map(first.map(show => [show.id, show])));
  assert.equal(readDay().totalFound, 2);
  const known = new Map([...first, ...second].map(show => [show.id, show]));
  await helpers.discoverNewKDramas(new Map(), known);
  assert.equal(readDay().totalFound, 2);
  failed = true;
  await helpers.discoverNewKDramas(new Map(), known);
  assert.deepEqual(readDay().shows.map(show => show.title), ['新韩剧第2季', '新韩剧第3季']);
  assert.equal(readDay().totalFound, 2);
});

test('KDrama discovery preserves existing aliases and deduplicates candidates by media identity', async () => {
  const existing = {
    id: 'same-live-id', title: '菜鸟炊事兵', year: 2026, mediaType: '电视剧', seedId: 'seed_kd_2026_15',
    description: '先前可靠来源的军营成长剧情简介。', descriptionSource: 'tmdb',
    coverImg: 'https://image.tmdb.org/t/p/original/reliable.jpg', firstSeenAt: '2026-01-01T00:00:00Z',
  };
  const known = new Map([[existing.id, existing]]);
  const raw = { title: '菜鸟伙房兵', regional: '韩国', atypeName: '电视剧', postTime: '2026-05-11', score: 8.9, hot: 50000, contxt: existing.id };
  const newSeason = { ...raw, title: '菜鸟炊事兵第2季', contxt: 'new-season' };
  const { helpers, files } = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [
    raw, { ...raw, contxt: 'same-alias-other-id' }, newSeason, { ...newSeason, title: '菜鸟炊事兵第二季' },
  ] }] } }) });
  const live = new Map([['live-alias', { ...existing, id: 'live-alias', title: raw.title, score: 8.9, regional: '韩国' }]]);
  const discovered = await helpers.discoverNewKDramas(live, known);
  for (const show of discovered) known.set(show.id, show);
  assert.equal(known.get(existing.id), existing, 'search discovery must not replace the already merged object');
  assert.deepEqual(Array.from(discovered, show => show.id), ['new-season']);
  assert.equal(JSON.parse(files.get(join(dataDir, 'discovery.json')))['2026-09-30'].totalFound, 1);
});

test('variety discovery cannot overwrite a current-year seed with the same media premiere year', async () => {
  const existing = {
    id: 'hello-live-id', title: '你好星期六', year: 2026, mediaType: '综艺', seedId: 'seed_var_2026_07',
    description: '上轮可靠来源节目简介。', descriptionSource: 'tmdb', isSerial: true,
  };
  const known = new Map([[existing.id, existing]]);
  const raw = { title: existing.title, regional: '大陆', atypeName: '综艺', postTime: '2022-01-01', lastName: '更新到20261003', score: 8, hot: 200000, contxt: existing.id };
  const { helpers } = loadHelpers({ fetchImpl: async () => response({ data: { info: [{ result: [
    raw, { ...raw, title: '新综艺第2季', postTime: '2026-08-01', contxt: 'new-season' },
    { ...raw, title: '新综艺第二季', postTime: '2026-08-01', contxt: 'new-season' },
  ] }] } }) });
  const discovered = await helpers.discoverNewVariety(new Map(), known);
  for (const show of discovered) known.set(show.id, show);
  assert.equal(known.get(existing.id), existing);
  assert.equal(known.get(existing.id).year, 2026);
  assert.deepEqual(Array.from(discovered, show => show.id), ['new-season']);
});

test('other-drama pagination reorder is allowed while count and identity loss remain guarded', () => {
  const { helpers } = loadHelpers();
  const previous = Array.from({ length: 20 }, (_, index) => ({ id: `same-${index}`, title: `剧目 ${index}` }));
  const reordered = previous.slice(10).concat(previous.slice(0, 10));
  const dataset = (shows, category = 'otherDramas') => ({ koreanDramas: [], chineseVariety: [], otherDramas: [], [category]: shows });
  assert.doesNotThrow(() => helpers.assertOutputContinuity(dataset(reordered), dataset(previous)));
  assert.throws(() => helpers.assertOutputContinuity(dataset(previous.slice(0, 9)), dataset(previous)), /数量.*骤降/u);
  const replacement = previous.map((show, index) => ({ id: `new-${index}`, title: `替换 ${index}` }));
  assert.throws(() => helpers.assertOutputContinuity(dataset(replacement), dataset(previous)), /身份重合度异常/u);
  assert.throws(() => helpers.assertOutputContinuity(dataset(reordered, 'koreanDramas'), dataset(previous, 'koreanDramas')), /头部推荐.*重合度异常/u);
});

test('rejected cache IDs copied into show links must prove the series title and region before season lookup', async () => {
  for (const invalidSeries of [
    { id: 203694, name: '另一部电视剧', origin_country: ['KR'] },
    { id: 203694, name: '财阀X刑警', origin_country: ['CN'] },
  ]) {
    const requests = [];
    const cached = seasonCache({ version: 14, tmdbId: 203694, tmdbSeriesId: 203694, matchedTitle: '另一部电视剧', tmdbUrl: 'https://www.themoviedb.org/tv/203694' });
    const { helpers } = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async url => {
      requests.push(url);
      if (url.includes('/tv/203694?')) return response(invalidSeries);
      if (url.includes('/search/tv?')) return response({ results: [] });
      assert.fail(`an unverified entity must not query its season: ${url}`);
    } });
    const rejectedUrl = 'https://www.themoviedb.org/tv/203694/season/2';
    const show = {
      id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
      tmdbId: 203694, tmdbSeriesId: 203694, tmdbSeasonNumber: 2, tmdbUrl: rejectedUrl,
      primaryUrl: rejectedUrl, url: rejectedUrl, descriptionTmdbSeasonUrl: rejectedUrl,
      yfspUrl: 'https://www.yfsp.tv/play/show',
    };
    const found = await helpers.searchTMDBImage(show, { cacheEntry: cached });
    assert.equal(found.lookupState, 'not_found');
    assert.equal(requests[0], 'https://api.themoviedb.org/3/tv/203694?language=zh-CN');
    assert.equal(requests.some(url => url.includes('/season/')), false);
    for (const field of ['tmdbId', 'tmdbSeriesId', 'tmdbSeasonNumber', 'tmdbUrl', 'descriptionTmdbSeasonUrl']) assert.equal(show[field], undefined, `remove the explicitly disproved ${field}`);
    helpers.normalizeOutputShow(show);
    assert.equal(show.primaryUrl, show.yfspUrl);
    assert.equal(show.primaryUrlSource, 'yfsp');
  }
});

test('revalidated legacy caches retain an observed series title and become reusable', async () => {
  const cached = seasonCache({ version: 14, matchedTitle: '错误旧标题' });
  const requests = [];
  const { helpers, files } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) },
    fetchImpl: async url => {
      requests.push(url);
      if (url.includes('/tv/220074?')) return response({ id: 220074, name: 'Flex X Cop', origin_country: ['KR'] });
      if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, season_number: 2, name: '第2季', air_date: '2026-08-01', poster_path: '/confirmed.jpg' });
      if (url.includes('/tv/220074/external_ids')) return response({});
      assert.fail(`unexpected URL: ${url}`);
    },
  });
  const show = { id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国', category: 'korean_drama', coverImg: 'https://static.yfsp.tv/source.jpg', tmdbSeriesId: 220074, tmdbUrl: 'https://www.themoviedb.org/tv/220074/season/2' };
  await helpers.enrichCoversFromTMDB([show]);
  const saved = JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show;
  assert.equal(requests[0], 'https://api.themoviedb.org/3/tv/220074?language=zh-CN');
  assert.equal(saved.matchedSeriesTitle, 'Flex X Cop');
  assert.equal(saved.matchedTitle, 'Flex X Cop第2季');
  assert.equal(helpers.isReusableTMDBCoverCache(saved, show), true);
});

test('unverified series links require entity evidence once and verified caches keep the season fast path', async () => {
  const requests = [];
  const { helpers, files } = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async url => {
    requests.push(url);
    if (url.includes('/tv/220074?')) return response({ id: 220074, name: '财阀X刑警', origin_country: ['KR'] });
    if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, season_number: 2, name: '第2季', air_date: '2026-08-01', poster_path: '/confirmed.jpg' });
    if (url.includes('/tv/220074/external_ids')) return response({});
    assert.fail(`unexpected URL: ${url}`);
  } });
  const found = await helpers.searchTMDBImage({ title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国', tmdbUrl: 'https://www.themoviedb.org/tv/220074' });
  assert.equal(found.tmdbId, 220074);
  assert.equal(requests[0], 'https://api.themoviedb.org/3/tv/220074?language=zh-CN');
  assert.equal(found.matchedSeriesTitle, '财阀X刑警');
  assert.equal(files.has(join(dataDir, 'image_cache.json')), false);

  requests.length = 0;
  const verified = await helpers.searchTMDBImage({ title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国', tmdbUrl: 'https://www.themoviedb.org/tv/220074' }, { cacheEntry: seasonCache() });
  assert.equal(verified.tmdbId, 220074);
  assert.equal(requests[0], 'https://api.themoviedb.org/3/tv/220074/season/2?language=zh-CN');
  assert.equal(requests.some(url => url.includes('/tv/220074?')), false);

  const cached = seasonCache();
  const reliable = { id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', category: 'korean_drama', coverImg: cached.url, tmdbUrl: cached.tmdbUrl, yfspUrl: 'https://www.yfsp.tv/play/show' };
  const failed = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) }, fetchImpl: async () => response(null, { status: 503 }) });
  await failed.helpers.enrichCoversFromTMDB([reliable]);
  assert.equal(reliable.coverImg, cached.url);
  assert.equal(reliable.tmdbUrl, cached.tmdbUrl);
  assert.equal(reliable.yfspUrl, 'https://www.yfsp.tv/play/show');
  assert.equal(JSON.parse(failed.files.get(join(dataDir, 'image_cache.json'))).show.notFound, undefined);
});

test('a disproved series is removed before publication and cannot return after a negative-cache retry', async () => {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    if (url.includes('/tv/215072?')) return response({ id: 215072, name: '完全无关剧', origin_country: ['KR'] });
    if (url.includes('/search/tv?')) return response({ results: [] });
    if (url.includes('/tv/215072/season/2?')) return response({ id: 123, name: '第2季', season_number: 2, air_date: '2026-08-01', poster_path: '/wrong.jpg' });
    if (url.includes('/tv/215072/external_ids')) return response({});
    assert.fail(`unexpected URL: ${url}`);
  };
  const cached = seasonCache({
    version: 15, tmdbId: 215072, tmdbSeriesId: 215072, matchedTitle: '完全无关剧第2季', matchedSeriesTitle: undefined,
    tmdbUrl: 'https://www.themoviedb.org/tv/215072/season/2',
  });
  const show = {
    id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', category: 'korean_drama',
    coverImg: cached.url, yfspCoverImg: 'https://static.yfsp.tv/fallback.jpg', tmdbId: 215072, tmdbSeriesId: 215072,
    tmdbUrl: cached.tmdbUrl, primaryUrl: cached.tmdbUrl, url: cached.tmdbUrl,
    yfspUrl: 'https://www.yfsp.tv/play/show', descriptionTmdbSeasonUrl: cached.tmdbUrl,
  };
  const first = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl, initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) } });
  await first.helpers.enrichCoversFromTMDB([show]);
  assert.equal(JSON.parse(first.files.get(join(dataDir, 'image_cache.json'))).show.notFound, true);
  assert.equal(show.coverImg, 'https://static.yfsp.tv/fallback.jpg');
  first.helpers.normalizeOutputShow(show);
  assert.equal(show.tmdbUrl, undefined);
  assert.equal(show.tmdbId, undefined);
  assert.equal(show.tmdbSeriesId, undefined);
  assert.equal(show.descriptionTmdbSeasonUrl, undefined);
  assert.equal(show.primaryUrl, show.yfspUrl);
  const second = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl, initialFiles: Object.fromEntries(first.files), date: '2026-09-30T17:00:00Z' });
  await second.helpers.enrichCoversFromTMDB([show]);
  assert.equal(requests.filter(url => url.includes('/tv/215072?')).length, 1, 'the disproved ID must be absent from the next published snapshot');
  assert.equal(requests.some(url => url.includes('/season/')), false, 'a wrong series must never reach its season even when the prior cache lost its ID');
  assert.equal(show.coverImg, 'https://static.yfsp.tv/fallback.jpg');
  assert.equal(JSON.parse(second.files.get(join(dataDir, 'image_cache.json'))).show.notFound, true);
  second.helpers.normalizeOutputShow(show);
  assert.equal(show.primaryUrl, show.yfspUrl);
});

test('disproved series posters without a fallback cannot survive normalization or a process restart', async () => {
  for (const fallback of ['', 'https://static.yfsp.tv/fallback.jpg']) {
    const cached = seasonCache({
      tmdbId: 215072, tmdbSeriesId: 215072, matchedSeriesTitle: undefined,
      url: 'https://image.tmdb.org/t/p/original/wrong-entity.jpg',
      tmdbUrl: 'https://www.themoviedb.org/tv/215072/season/2',
    });
    const fetchImpl = async url => {
      if (url.includes('/tv/215072?')) return response({ id: 215072, name: '完全无关剧', origin_country: ['KR'] });
      if (url.includes('/search/tv?')) return response({ results: [] });
      assert.fail(`an explicitly rejected entity cannot supply its poster: ${url}`);
    };
    const first = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl, initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) } });
    const show = {
      id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', category: 'korean_drama',
      coverImg: cached.url, coverSource: 'tmdb', ...(fallback ? { yfspCoverImg: fallback } : {}),
      tmdbId: 215072, tmdbSeriesId: 215072, tmdbUrl: cached.tmdbUrl, yfspUrl: 'https://www.yfsp.tv/play/show',
    };
    await first.helpers.enrichCoversFromTMDB([show]);
    first.helpers.normalizeOutputShow(show);
    assert.equal(show.coverImg, fallback);
    assert.notEqual(show.coverSource, 'tmdb');
    assert.equal(show.primaryUrl, show.yfspUrl);
    assert.equal(first.helpers.isRenderableShow(show), Boolean(fallback), 'a confirmed wrong poster must be replaced or withheld');
    const second = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl, initialFiles: Object.fromEntries(first.files), date: '2026-09-30T17:00:00Z' });
    await second.helpers.enrichCoversFromTMDB([show]);
    second.helpers.normalizeOutputShow(show);
    assert.equal(show.coverImg, fallback);
    assert.equal(second.helpers.isRenderableShow(show), Boolean(fallback));
  }
});

test('a verified replacement series supersedes explicitly disproved historical links', async () => {
  const cached = seasonCache({ version: 15, tmdbId: 215072, tmdbSeriesId: 215072, matchedSeriesTitle: undefined, tmdbUrl: 'https://www.themoviedb.org/tv/215072/season/2' });
  const { helpers, files } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) },
    fetchImpl: async url => {
      if (url.includes('/tv/215072?')) return response({ id: 215072, name: '完全无关剧', origin_country: ['KR'] });
      if (url.includes('/search/tv?')) return response({ results: [{ id: 220074, name: '财阀X刑警', origin_country: ['KR'], poster_path: '/series.jpg' }] });
      if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, season_number: 2, name: '第2季', air_date: '2026-08-01', poster_path: '/correct.jpg' });
      if (url.includes('/tv/220074/external_ids')) return response({});
      assert.fail(`unexpected URL: ${url}`);
    },
  });
  const show = { id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', category: 'korean_drama', coverImg: cached.url, tmdbId: 215072, tmdbSeriesId: 215072, tmdbUrl: cached.tmdbUrl, primaryUrl: cached.tmdbUrl, yfspUrl: 'https://www.yfsp.tv/play/show' };
  await helpers.enrichCoversFromTMDB([show]);
  helpers.normalizeOutputShow(show);
  assert.equal(show.primaryUrl, 'https://www.themoviedb.org/tv/220074/season/2');
  assert.equal(show.tmdbId, 220074);
  assert.equal(show.tmdbSeriesId, 220074);
  assert.equal(show.coverImg, 'https://image.tmdb.org/t/p/original/correct.jpg');
  assert.equal(JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show.matchedSeriesTitle, '财阀X刑警');
});

test('disproved TMDB entities lose associated external links and sourced facts before publication', async () => {
  for (const descriptionSource of ['tmdb', 'wikipedia', 'douban']) {
    const cached = seasonCache({
      version: 15, tmdbId: 215072, tmdbSeriesId: 215072, matchedSeriesTitle: undefined,
      tmdbUrl: 'https://www.themoviedb.org/tv/215072/season/2',
      doubanUrl: 'https://movie.douban.com/subject/999999/', imdbUrl: 'https://www.imdb.com/title/tt999999/',
      wikipediaUrl: 'https://zh.wikipedia.org/wiki/Wrong_series', wikidataId: 'Q999999',
    });
    const show = {
      ...cached, id: 'show', category: 'korean_drama', regional: '韩国', coverImg: cached.url,
      yfspCoverImg: 'https://static.yfsp.tv/correct.jpg', yfspUrl: 'https://www.yfsp.tv/play/correct',
      primaryUrl: cached.doubanUrl, url: cached.doubanUrl, primaryUrlSource: 'douban',
      description: '无关剧的爱情、温馨、治愈、喜剧剧情。', descriptionSource,
    };
    const fetchImpl = async url => {
      if (url.includes('/tv/215072?')) return response({ id: 215072, name: '完全不同的剧', origin_country: ['KR'] });
      if (url.includes('/search/tv?')) return response({ results: [] });
      assert.fail(`a rejected entity must not supply other metadata: ${url}`);
    };
    const first = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) }, fetchImpl });
    await first.helpers.enrichCoversFromTMDB([show]);
    await first.helpers.enrichDescriptions([show]);
    first.helpers.normalizeOutputShow(show);
    for (const field of ['tmdbId', 'tmdbUrl', 'doubanUrl', 'imdbUrl', 'wikipediaUrl', 'wikidataId']) {
      assert.ok(!show[field], `${descriptionSource}: discard ${field} tied to the rejected cache entity`);
    }
    assert.equal(show.description, '');
    assert.equal(show.descriptionSource, undefined);
    assert.equal(show.primaryUrl, show.yfspUrl);
    assert.equal(first.helpers.scoreKDrama({ ...show }), first.helpers.scoreKDrama({ ...show, description: '' }));
    const second = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, initialFiles: Object.fromEntries(first.files), fetchImpl, date: '2026-09-30T17:00:00Z' });
    await second.helpers.enrichCoversFromTMDB([show]);
    await second.helpers.enrichDescriptions([show]);
    second.helpers.normalizeOutputShow(show);
    assert.equal(show.primaryUrl, show.yfspUrl);
    assert.equal(show.description, '');
  }
});

test('rejecting a TMDB entity preserves independent source facts and Douban verification', async () => {
  for (const replacement of [false, true]) {
    for (const descriptionSource of ['yfsp', 'douban', 'wikipedia']) {
      const cached = seasonCache({
        version: 15, tmdbId: 215072, tmdbSeriesId: 215072, matchedSeriesTitle: undefined,
        tmdbUrl: 'https://www.themoviedb.org/tv/215072/season/2',
        doubanUrl: 'https://movie.douban.com/subject/999999/', wikipediaUrl: 'https://zh.wikipedia.org/wiki/Wrong_series',
      });
      const show = {
        ...cached, id: 'show', category: 'korean_drama', regional: '韩国', coverImg: cached.url,
        yfspCoverImg: 'https://static.yfsp.tv/correct.jpg', yfspUrl: 'https://www.yfsp.tv/play/correct',
        doubanUrl: 'https://movie.douban.com/subject/123456/', doubanId: '123456', doubanMatchedTitle: cached.title,
        wikipediaUrl: 'https://zh.wikipedia.org/wiki/Correct_series',
        description: '来自独立来源的职场喜剧简介。', descriptionSource,
      };
      // enrichDoubanLinks also records an independently searched subject on an existing TMDB cache.
      if (descriptionSource === 'douban') Object.assign(cached, { doubanUrl: show.doubanUrl, doubanId: show.doubanId, doubanMatchedTitle: show.doubanMatchedTitle });
      const { helpers } = loadHelpers({
        env: { TMDB_TOKEN: 'test-token' }, initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) },
        fetchImpl: async url => {
          if (url.includes('/tv/215072?')) return response({ id: 215072, name: '完全不同的剧', origin_country: ['KR'] });
          if (url.includes('/search/tv?')) return response({ results: replacement ? [{ id: 220074, name: '财阀X刑警', origin_country: ['KR'], poster_path: '/series.jpg' }] : [] });
          if (url.includes('/tv/220074/season/2?')) return response({ id: 401234, season_number: 2, name: '第2季', air_date: '2026-08-01', poster_path: '/correct.jpg' });
          if (url.includes('/tv/220074/external_ids')) return response({});
          assert.fail(`unexpected URL: ${url}`);
        },
      });
      await helpers.enrichCoversFromTMDB([show]);
      helpers.normalizeOutputShow(show);
      assert.equal(show.description, '来自独立来源的职场喜剧简介。');
      assert.equal(show.descriptionSource, descriptionSource);
      assert.equal(show.doubanUrl, 'https://movie.douban.com/subject/123456/');
      assert.equal(show.doubanMatchedTitle, cached.title);
      assert.equal(show.wikipediaUrl, 'https://zh.wikipedia.org/wiki/Correct_series');
      assert.equal(show.yfspUrl, 'https://www.yfsp.tv/play/correct');
    }
  }
});

test('transient series failures preserve historical links, IDs, cover and description evidence', async () => {
  const { helpers } = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async () => response(null, { status: 503 }) });
  const seasonUrl = 'https://www.themoviedb.org/tv/220074/season/2';
  const show = {
    id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
    tmdbId: 220074, tmdbSeriesId: 220074, tmdbSeasonNumber: 2, tmdbUrl: seasonUrl, primaryUrl: seasonUrl,
    coverImg: 'https://image.tmdb.org/t/p/original/reliable.jpg', description: '已有本季可靠简介', descriptionSource: 'tmdb',
    descriptionTmdbSeasonUrl: seasonUrl,
    doubanUrl: 'https://movie.douban.com/subject/123456/', imdbUrl: 'https://www.imdb.com/title/tt123456/',
    wikipediaUrl: 'https://zh.wikipedia.org/wiki/Correct_series', wikidataId: 'Q123456',
  };
  const snapshot = { ...show };
  assert.equal((await helpers.searchTMDBImage(show, { cacheEntry: { ...show, source: 'tmdb', version: 15 } })).lookupState, 'unknown');
  for (const field of Object.keys(snapshot)) assert.equal(show[field], snapshot[field], `preserve ${field} during a temporary outage`);
  helpers.normalizeOutputShow(show);
  assert.equal(show.primaryUrl, seasonUrl);
});

test('old current-version season caches without an observed series title cannot certify themselves', async () => {
  const requests = [];
  const cached = seasonCache({ tmdbId: 215072, tmdbSeriesId: 215072, matchedSeriesTitle: undefined, tmdbUrl: 'https://www.themoviedb.org/tv/215072/season/2' });
  const { helpers, files } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) },
    fetchImpl: async url => {
      requests.push(url);
      if (url.includes('/tv/215072?')) return response({ id: 215072, name: '完全无关剧', origin_country: ['KR'] });
      if (url.includes('/search/tv?')) return response({ results: [] });
      assert.fail(`a manufactured matchedTitle must not reach its season: ${url}`);
    },
  });
  const show = { id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', category: 'korean_drama', coverImg: cached.url, yfspCoverImg: 'https://static.yfsp.tv/fallback.jpg', tmdbId: 215072, tmdbUrl: cached.tmdbUrl };
  assert.equal(helpers.isReusableTMDBCoverCache(cached, show), false);
  await helpers.enrichCoversFromTMDB([show]);
  assert.equal(requests[0], 'https://api.themoviedb.org/3/tv/215072?language=zh-CN');
  assert.equal(requests.some(url => url.includes('/season/')), false);
  assert.equal(show.coverImg, 'https://static.yfsp.tv/fallback.jpg');
  assert.equal(JSON.parse(files.get(join(dataDir, 'image_cache.json'))).show.notFound, true);
});

test('an exhausted optional-enrichment budget cannot query or alter reliable media and descriptions', async () => {
  const requests = [];
  const cached = seasonCache();
  const { helpers } = loadHelpers({
    env: { TMDB_TOKEN: 'test-token' },
    initialFiles: { [join(dataDir, 'image_cache.json')]: JSON.stringify({ show: cached }) },
    fetchImpl: async url => { requests.push(url); return response(null, { status: 503 }); },
  });
  helpers.setEnrichmentDeadline(Date.parse('2026-09-30T03:59:59Z'));
  const show = { id: 'show', title: cached.title, year: 2026, mediaType: '电视剧', regional: '韩国', coverImg: cached.url, tmdbUrl: cached.tmdbUrl, description: '已有本季可靠介绍', descriptionSource: 'yfsp' };
  assert.equal((await helpers.searchTMDBImage(show)).lookupState, 'unknown');
  await helpers.enrichCoversFromTMDB([show]);
  await helpers.enrichDescriptions([show]);
  assert.deepEqual(requests, []);
  assert.equal(show.coverImg, cached.url);
  assert.equal(show.tmdbUrl, cached.tmdbUrl);
  assert.equal(show.description, '已有本季可靠介绍');
  assert.equal(show.descriptionSource, 'yfsp');
});
