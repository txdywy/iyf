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
    setTimeout(fn, delay) { if (delay <= 1000) fn(); return 0; }, clearTimeout() {},
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
        applyLiveFields, mergePreviousShowState, sameShowIdentity, main,
        enrichDescriptions, enrichCoversFromTMDB, isReusableTMDBCoverCache,
        discoverNewKDramas, assertOutputContinuity, normalizeOutputShow, SEED_KDRAMAS,
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
    { id: 'wrong', title: '酒鬼都市女人们第1季', year: '2021' },
    { id: 'same', title: '酒鬼都市女人们第二季', year: '2022' },
  ]) });
  const found = await helpers.searchDoubanSubject({ title: '酒鬼都市女人们第2季', year: 2022, mediaType: '电视剧' });
  assert.equal(found?.doubanId, 'same');
  const unknownYear = await helpers.searchDoubanSubject({ title: '酒鬼都市女人们第2季', year: 0, mediaType: '电视剧' });
  assert.equal(unknownYear?.doubanId, 'same', 'unknown-year fallback must enforce the same season boundary');
});

test('Douban season identity also checks an explicit English subtitle', async () => {
  const { helpers } = loadHelpers({ fetchImpl: async () => response([
    { id: 'wrong', title: '杀人者的购物中心', sub_title: 'A Shop for Killers Season 1', year: '2024' },
    { id: 'same', title: '杀人者的购物中心2', sub_title: 'A Shop for Killers Season 2', year: '2026' },
  ]) });
  const found = await helpers.searchDoubanSubject({ title: '杀人者的购物中心2', year: 0, mediaType: '电视剧' });
  assert.equal(found?.doubanId, 'same');
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

test('transient series failures preserve historical links, IDs, cover and description evidence', async () => {
  const { helpers } = loadHelpers({ env: { TMDB_TOKEN: 'test-token' }, fetchImpl: async () => response(null, { status: 503 }) });
  const seasonUrl = 'https://www.themoviedb.org/tv/220074/season/2';
  const show = {
    id: 'show', title: '财阀X刑警第2季', year: 2026, mediaType: '电视剧', regional: '韩国',
    tmdbId: 220074, tmdbSeriesId: 220074, tmdbSeasonNumber: 2, tmdbUrl: seasonUrl, primaryUrl: seasonUrl,
    coverImg: 'https://image.tmdb.org/t/p/original/reliable.jpg', description: '已有本季可靠简介', descriptionSource: 'tmdb',
    descriptionTmdbSeasonUrl: seasonUrl,
  };
  const snapshot = { ...show };
  assert.equal((await helpers.searchTMDBImage(show)).lookupState, 'unknown');
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
