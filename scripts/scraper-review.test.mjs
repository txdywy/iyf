import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'scripts/scrape.mjs'), 'utf8');

function loadHelpers({ env = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); } } = {}) {
  let now = Date.parse('2026-09-30T04:00:00Z');
  const files = new Map();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    console: { log() {}, warn() {}, error() {} },
    process: { env }, fetch: fetchImpl, URL, AbortController, Date: FixedDate,
    setTimeout(fn, delay) { if (delay <= 1000) fn(); return 0; }, clearTimeout() {},
    existsSync: path => files.has(path), readFileSync: path => files.get(path),
    writeFileSync: (path, value) => files.set(path, value), mkdirSync() {}, join,
  };
  const executable = source
    .replace(/^import .*$/gm, '')
    .replace(/const __dirname = dirname\(fileURLToPath\(import\.meta\.url\)\);/, "const __dirname = '/tmp/iyf-scraper-review/scripts';")
    .replace(/const run = process\.argv[\s\S]*$/m, '') + `
      globalThis.helpers = {
        scoreKDrama, scoreVariety, isEligibleKDrama, removeHardExcludedKDrama,
        aiEnhanceDescriptions, findLiveTitleMatch, scoreYfspCandidate,
        searchYfspTitle, verifyYfspUrl, searchDoubanSubject, searchTMDBImage,
        enrichMissingYfspLinks, restorePreviousCategory,
      };
    `;
  vm.createContext(context);
  vm.runInContext(executable, context, { timeout: 1000 });
  return { helpers: context.helpers, setNow: iso => { now = Date.parse(iso); } };
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
