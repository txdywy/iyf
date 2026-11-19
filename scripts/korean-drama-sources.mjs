import { readFileSync } from 'node:fs';

// 爱壹帆站点域名按优先级尝试：kubb.tv 是 2026 年 11 月起的网页版新域名；yfsp.tv 已无法解析，iyf.tv 拒绝 Runner。
// 各域名沿用同一套子域约定：api.（首页接口）、rankv21.（搜索）、www.（播放页）、static.（图片）。
export const YFSP_SITE_DOMAINS = Object.freeze(['kubb.tv', 'yfsp.tv', 'iyf.tv']);

export function yfspDomainOfHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  return YFSP_SITE_DOMAINS.find(domain => host === domain || host.endsWith(`.${domain}`)) || '';
}

// 已知站点任一域名下的播放页（www.<域名>/play/<ID>）；返回 ID，非播放页返回空。
export function yfspPlayKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname !== `www.${yfspDomainOfHost(parsed.hostname)}`) return '';
    const match = parsed.pathname.match(/^\/play\/([^/?#]+)\/?$/u);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

const DAY = 86_400_000;
const KOREA_OFFSET = 9 * 60 * 60 * 1000;
const MAX_AIRINGS = 80;
const MAX_PLAYS = 120;
const MAX_RESPONSE_BYTES = 2_000_000;
const NETFLIX_TSV = 'https://www.netflix.com/tudum/top10/data/all-weeks-global.tsv';
const EVIDENCE_FILE = new URL('../data/korean-drama-evidence.json', import.meta.url);
const STATUS = new Set(['airing', 'ended', 'upcoming', 'unknown']);
const CHARTS = Object.freeze({
  fundex: { label: 'FUNdex 话题榜', host: 'racoi.s3.ap-northeast-2.amazonaws.com', group: 'fundex' },
  'netflix-kr': { label: 'Netflix 韩国榜', host: 'www.netflix.com', group: 'netflix' },
  'netflix-global': { label: 'Netflix 全球非英语榜', host: 'www.netflix.com', group: 'netflix' },
  tving: { label: 'TVING 综合榜', host: 'cjnews.cj.net', group: 'tving' },
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max &&
  value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const episodeNumber = value => positiveInt(value) && value <= 999;
const rankNumber = value => positiveInt(value) && value <= 10;
const keyOf = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '') : '';
const namesOf = item => [item?.title, ...(Array.isArray(item?.aliases) ? item.aliases : [])].map(keyOf).filter(Boolean);

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && dateKey(Date.parse(value)) === value;
}

function safeHttps(value, host) {
  if (!text(value, 1800) || /["<>]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (!host || url.hostname === host);
  } catch { return false; }
}

function validBroadcast(value) {
  return record(value) && STATUS.has(value.status) && validDay(value.checkedOn) && safeHttps(value.sourceUrl) &&
    (value.premiereDate === undefined || validDay(value.premiereDate)) &&
    (value.airedEpisodes === undefined || episodeNumber(value.airedEpisodes)) &&
    (value.totalEpisodes === undefined || episodeNumber(value.totalEpisodes)) &&
    !(value.airedEpisodes > value.totalEpisodes) &&
    (value.status !== 'ended' || value.airedEpisodes === value.totalEpisodes);
}

export function projectKoreanBroadcast(value) {
  if (!validBroadcast(value)) return null;
  return Object.fromEntries(['premiereDate', 'status', 'airedEpisodes', 'totalEpisodes', 'checkedOn', 'sourceUrl']
    .filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}

export function loadKoreanDramaEvidence() {
  const data = JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8'));
  if (!record(data?.titles) || !Array.isArray(data.charts)) throw new Error('Invalid Korean drama evidence file');
  for (const [id, item] of Object.entries(data.titles)) {
    if (!/^[a-z0-9-]+$/u.test(id) || !record(item) || !text(item.title) || !Number.isInteger(item.year) ||
      !Array.isArray(item.aliases) || item.aliases.length > 12 || !item.aliases.every(alias => text(alias)) ||
      (item.tmdbId !== undefined && !positiveInt(item.tmdbId)) || (item.tvmazeId !== undefined && !positiveInt(item.tvmazeId)) ||
      (item.seedId !== undefined && !text(item.seedId)) || (item.excluded !== undefined && !text(item.excluded)) ||
      (item.broadcast !== undefined && !validBroadcast(item.broadcast)) ||
      (item.description !== undefined && !text(item.description, 1200)) ||
      (item.contentType !== undefined && !text(item.contentType)) ||
      (item.card !== undefined && (!record(item.card) || !validBroadcast(item.broadcast) ||
        !safeHttps(item.card.coverImg, 'static.tvmaze.com') || !safeHttps(item.card.primaryUrl) ||
        !text(item.card.description, 1200) || !text(item.card.contentType) ||
        (item.card.actor !== undefined && !text(item.card.actor, 500))))) {
      throw new Error(`Invalid Korean drama evidence: ${id}`);
    }
  }
  for (const chart of data.charts) {
    const ranks = record(chart?.ranks) ? Object.entries(chart.ranks) : [];
    if (!Object.hasOwn(CHARTS, chart?.source) || !validDay(chart.weekEnd) ||
      !safeHttps(chart.url, CHARTS[chart.source].host) || !ranks.length ||
      !ranks.every(([id, rank]) => Object.hasOwn(data.titles, id) && rankNumber(rank)) ||
      new Set(ranks.map(([, rank]) => rank)).size !== ranks.length) {
      throw new Error('Invalid verified Korean drama chart');
    }
  }
  return data;
}

export function isYearPlaceholder(value) {
  // 源站这个不带时区的格式曾把整年的日期填成同一天。真正的 1 月 1 日首播可由播出来源确认。
  return typeof value === 'string' && /^\d{4}-01-01T00:00:00(?:\.0+)?$/u.test(value);
}

function showSeason(show) {
  const titleSeason = /第\s*(\d+)\s*季|\bseason\s*(\d+)\b/iu.exec(show?.title || '');
  const tmdbSeason = /\/season\/(\d+)(?:[/?#]|$)/u.exec(show?.tmdbUrl || '');
  return Number(tmdbSeason?.[1] ?? show?.tmdbSeasonNumber ?? titleSeason?.[1] ?? titleSeason?.[2] ?? 1);
}

function imdbOf(show) {
  return /\/title\/(tt\d+)(?:[/?#]|$)/u.exec(show?.imdbUrl || '')?.[1];
}

function matchesReference(show, item) {
  if (show?.year !== item.year || showSeason(show) !== 1) return false;
  const tmdbId = Number(/\/tv\/(\d+)(?:[/?#-]|$)/u.exec(show.tmdbUrl || '')?.[1] || show.tmdbSeriesId || show.tmdbId);
  if (item.tmdbId && positiveInt(tmdbId)) return tmdbId === item.tmdbId;
  const aliases = new Set([show.title, ...(Array.isArray(show.titleAliases) ? show.titleAliases : [])].map(keyOf));
  const matchesName = namesOf(item).some(alias => aliases.has(alias));
  if (item.seedId) return matchesName && (show.seedId === item.seedId || show.id === item.seedId);
  return !!item.card && matchesName && keyOf(show.title) === keyOf(item.title);
}

function matchAiring(show, rows, item) {
  const season = showSeason(show);
  const imdb = imdbOf(show);
  return rows.find(row => row.season === season && (item?.tvmazeId === row.id ||
    (imdb && imdb === row.imdb && row.premiereDate?.startsWith(`${show.year}-`))));
}

function broadcastFor(item, row) {
  const verified = item?.broadcast;
  if (!row || verified?.status === 'ended' || (verified && row.airedOn <= verified.checkedOn)) return verified;
  if (verified?.airedEpisodes && row.episode < verified.airedEpisodes) return verified;
  if (verified?.totalEpisodes && row.episode > verified.totalEpisodes) return verified;
  return {
    ...(verified || {}),
    ...(row.premiereDate ? { premiereDate: verified?.premiereDate || row.premiereDate } : {}),
    // 排期证明这一集已播。只有当前仍显示 Running 且集数未达已知总数时标为连载。
    status: row.running && row.episode !== verified?.totalEpisodes ? 'airing' : 'unknown',
    airedEpisodes: row.episode, checkedOn: row.airedOn, sourceUrl: `https://www.tvmaze.com/shows/${row.id}`,
  };
}

export function applyVerifiedKoreanDrama(show, evidence, signals) {
  const item = Object.values(evidence.titles).find(candidate => matchesReference(show, candidate));
  const row = matchAiring(show, validAirings(signals?.airings), item);
  const broadcast = broadcastFor(item, row);
  if (!item && !broadcast) return show;
  return {
    ...show,
    ...(item ? { titleAliases: [...new Set([...(Array.isArray(show.titleAliases) ? show.titleAliases : []), ...item.aliases])].slice(0, 20) } : {}),
    ...(item?.description ? { description: item.description, descriptionSource: 'verified' } : {}),
    ...(item?.contentType ? { contentType: item.contentType } : {}),
    ...(broadcast ? { broadcast } : {}),
  };
}

function validAirings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_AIRINGS).filter(row => record(row) && positiveInt(row.id) && episodeNumber(row.season) &&
    text(row.title) && episodeNumber(row.episode) && validDay(row.airedOn) && typeof row.running === 'boolean' &&
    typeof row.horror === 'boolean' && (row.imdb === undefined || /^tt\d+$/u.test(row.imdb)) &&
    (row.premiereDate === undefined || validDay(row.premiereDate) && row.premiereDate <= row.airedOn));
}

function readAiring(entry, date, now) {
  const show = entry?.show ?? entry?._embedded?.show;
  const airstamp = typeof entry?.airstamp === 'string' ? Date.parse(entry.airstamp) : NaN;
  const country = show?.network?.country?.code || show?.webChannel?.country?.code;
  if (show?.type !== 'Scripted' || show.language !== 'Korean' || (country && country !== 'KR') ||
    !positiveInt(show.id) || !text(show.name) || !episodeNumber(entry.season) || !episodeNumber(entry.number) ||
    entry.airdate !== date || !Number.isFinite(airstamp) || airstamp > now) return null;
  const premiereDate = entry.number === 1 ? date : entry.season === 1 && validDay(show.premiered) &&
    show.premiered <= date ? show.premiered : undefined;
  const imdb = typeof show.externals?.imdb === 'string' && /^tt\d+$/u.test(show.externals.imdb) ? show.externals.imdb : undefined;
  return {
    id: show.id, season: entry.season, title: show.name, ...(imdb ? { imdb } : {}),
    episode: entry.number, airedOn: date, ...(premiereDate ? { premiereDate } : {}),
    running: show.status === 'Running', horror: Array.isArray(show.genres) && show.genres.includes('Horror'),
  };
}

function mergeAirings(previous, fresh, today) {
  const merged = new Map();
  for (const row of [...validAirings(previous), ...fresh]) {
    if (row.airedOn > today || Date.parse(today) - Date.parse(row.airedOn) > 35 * DAY) continue;
    const key = `${row.id}:${row.season}`;
    const before = merged.get(key);
    if (!before) merged.set(key, row);
    else {
      const latest = row.airedOn > before.airedOn || (row.airedOn === before.airedOn && row.episode >= before.episode) ? row : before;
      const premiereDate = [before.premiereDate, row.premiereDate].filter(Boolean).sort()[0];
      merged.set(key, { ...latest, ...(premiereDate ? { premiereDate } : {}) });
    }
  }
  return [...merged.values()].sort((a, b) => b.airedOn.localeCompare(a.airedOn) || a.id - b.id || a.season - b.season).slice(0, MAX_AIRINGS);
}

function validNetflix(value) {
  return record(value) && validDay(value.weekEnd) && Array.isArray(value.rows) && value.rows.length === 10 &&
    new Set(value.rows.map(row => row?.rank)).size === 10 && value.rows.every(row => record(row) && rankNumber(row.rank) &&
      text(row.title) && (row.season === null || episodeNumber(row.season)));
}

export function parseNetflixWeeklyTsv(body, today) {
  const [header, ...lines] = body.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const fields = header.split('\t');
  const indices = ['week', 'category', 'weekly_rank', 'show_title', 'season_title'].map(name => fields.indexOf(name));
  if (indices.some(index => index < 0)) throw new Error('Invalid Netflix chart columns');
  let weekEnd = '';
  let rows = [];
  for (const line of lines) {
    const cells = line.split('\t');
    const [week, category, rank, title, seasonTitle] = indices.map(index => cells[index]);
    if (category !== 'TV (Non-English)' || !validDay(week) || week > today || week < weekEnd) continue;
    if (week > weekEnd) { weekEnd = week; rows = []; }
    const season = /\bSeason (\d+)$/iu.exec(seasonTitle || '');
    rows.push({ title, rank: Number(rank), season: season ? Number(season[1]) : /\bLimited Series$/iu.test(seasonTitle || '') ? 1 : null });
  }
  const result = { weekEnd, rows: rows.sort((a, b) => a.rank - b.rank) };
  if (!validNetflix(result)) throw new Error('Incomplete Netflix chart');
  return result;
}

async function readResponse(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid or oversized source response');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('Oversized source response');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function refreshKoreanDramaSignals(previous = {}, { fetchImpl = fetch, now = Date.now(), log = console.log } = {}) {
  const today = dateKey(now + KOREA_OFFSET);
  const days = Array.from({ length: 7 }, (_, offset) => dateKey(now + KOREA_OFFSET - offset * DAY));
  const requests = days.map(date => [date, `https://api.tvmaze.com/schedule?country=KR&date=${date}`]);
  for (const date of days.slice(0, 3)) requests.push([date, `https://api.tvmaze.com/schedule/web?country=&date=${date}`]);
  const canReuseNetflix = validNetflix(previous?.netflix) && validDay(previous.netflixCheckedOn) && previous.netflixCheckedOn === today;
  const netflixRequest = canReuseNetflix ? Promise.resolve(previous.netflix) :
    readResponse(NETFLIX_TSV, fetchImpl).then(body => parseNetflixWeeklyTsv(body, today)).catch(() => null);
  const [results, netflix] = await Promise.all([
    Promise.allSettled(requests.map(async ([date, url]) => {
      const rows = JSON.parse(await readResponse(url, fetchImpl));
      if (!Array.isArray(rows)) throw new Error('Invalid TVmaze schedule');
      return rows.map(entry => readAiring(entry, date, now)).filter(Boolean);
    })),
    netflixRequest,
  ]);
  const good = results.filter(result => result.status === 'fulfilled');
  const airings = mergeAirings(previous?.airings, good.flatMap(result => result.value), today);
  const oldNetflix = validNetflix(previous?.netflix) ? previous.netflix : null;
  const latestNetflix = netflix && (!oldNetflix || netflix.weekEnd >= oldNetflix.weekEnd) ? netflix : oldNetflix;
  log(`  [韩剧独立来源] TVmaze ${good.length}/${requests.length} 个排期响应，已验证播出 ${airings.length} 季；Netflix ${latestNetflix?.weekEnd || '暂无周榜'}${netflix ? '' : '（本轮未取到）'}`);
  return {
    airings,
    ...(latestNetflix ? { netflix: latestNetflix } : {}),
    ...(netflix ? { netflixCheckedOn: today } : validDay(previous?.netflixCheckedOn) ? { netflixCheckedOn: previous.netflixCheckedOn } : {}),
  };
}

export function koreanDiscoveryQueue(signals, evidence, catalog, now = Date.now()) {
  const cutoff = dateKey(now + KOREA_OFFSET - 28 * DAY);
  const today = dateKey(now + KOREA_OFFSET);
  const candidates = new Map();
  for (const row of validAirings(signals?.airings).filter(row => row.premiereDate && row.premiereDate >= cutoff && row.premiereDate <= today)) {
    const item = Object.values(evidence.titles).find(entry => row.season === 1 && entry.tvmazeId === row.id);
    const catalogMatch = catalog.some(show => (item && matchesReference(show, item)) || matchAiring(show, [row]));
    candidates.set(`${row.id}:${row.season}`, {
      id: `tvmaze:${row.id}:${row.season}`,
      title: item?.title || row.title,
      titleAliases: [...new Set([row.title, ...(item?.aliases || [])])],
      year: Number(row.premiereDate.slice(0, 4)), season: row.season,
      premiereDate: row.premiereDate, sourceUrl: `https://www.tvmaze.com/shows/${row.id}`,
      state: row.horror || item?.excluded ? 'excluded' : catalogMatch ? 'catalog' : 'pending',
    });
  }
  for (const [id, item] of Object.entries(evidence.titles)) {
    const premiereDate = item.broadcast?.premiereDate;
    const key = item.tvmazeId ? `${item.tvmazeId}:1` : id;
    if (!item.card || !premiereDate || premiereDate < cutoff || premiereDate > today || candidates.has(key)) continue;
    candidates.set(key, { id: `verified:${id}`, title: item.title, titleAliases: item.aliases,
      year: item.year, season: 1, premiereDate, sourceUrl: item.broadcast.sourceUrl,
      state: item.excluded ? 'excluded' : catalog.some(show => matchesReference(show, item)) ? 'catalog' : 'pending' });
  }
  return [...candidates.values()].sort((a, b) => b.premiereDate.localeCompare(a.premiereDate));
}

export function koreanPlayIdentity(show) {
  return JSON.stringify([keyOf(show.title), show.year, showSeason(show)]);
}

function validSamples(value) {
  return Array.isArray(value) && value.length <= 2 && value.every(sample => record(sample) &&
    Number.isFinite(Date.parse(sample.at)) && Number.isSafeInteger(sample.count) && sample.count >= 0);
}

export function updateKoreanPlayObservations(previous, observations, now) {
  const history = new Map(Object.entries(record(previous) ? previous : {}).filter(([id, samples]) =>
    /^[\w-]{1,100}$/u.test(id) && validSamples(samples) && samples.every(sample => Date.parse(sample.at) <= now)));
  for (const { id, identity, count, at } of observations) {
    const time = Date.parse(at);
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/u.test(id) || !Number.isSafeInteger(count) || count < 0 ||
      !Number.isFinite(time) || time > now || now - time > DAY) continue;
    const samples = history.get(id) || [];
    const latest = samples.at(-1);
    if (latest && time <= Date.parse(latest.at)) continue;
    const base = latest && identity && latest.identity === identity && count >= latest.count && samples.find(sample => time - Date.parse(sample.at) <= 7 * DAY);
    history.set(id, [...(base ? [base] : []), { at, count, identity }]);
  }
  return Object.fromEntries([...history].filter(([, samples]) => samples.length && now - Date.parse(samples.at(-1).at) <= 7 * DAY)
    .sort((a, b) => Date.parse(b[1].at(-1).at) - Date.parse(a[1].at(-1).at)).slice(0, MAX_PLAYS));
}

function recentPlaysFor(show, observations, generatedAt) {
  const id = yfspPlayKey(show.yfspUrl);
  const samples = id && record(observations) ? observations[id] : null;
  if (!validSamples(samples) || samples.length !== 2) return null;
  const [start, end] = samples;
  const identity = koreanPlayIdentity(show);
  if (start.identity !== identity || end.identity !== identity) return null;
  const endTime = Date.parse(end.at);
  const hours = (endTime - Date.parse(start.at)) / 3_600_000;
  const age = Date.parse(generatedAt) - endTime;
  if (!Number.isFinite(age) || age < 0 || age > 2 * DAY || hours < 12 || hours > 168 || end.count < start.count) return null;
  return { count: end.count - start.count, from: start.at, to: end.at, perDay: (end.count - start.count) * 24 / hours };
}

export function buildKoreanHotList(catalog, evidence, signals, generatedAt) {
  const titleEntries = Object.entries(evidence.titles);
  const chartKey = chart => `${chart.source}:${chart.weekEnd}`;
  const charts = new Map(evidence.charts.map(chart => [chartKey(chart), chart]));
  if (validNetflix(signals?.netflix)) {
    const { weekEnd, rows } = signals.netflix;
    const ranks = {};
    for (const row of rows) {
      if (row.season !== 1) continue;
      const matches = titleEntries.filter(([, item]) => namesOf(item).includes(keyOf(row.title)));
      if (matches.length === 1) {
        const [id, item] = matches[0];
        if (item.broadcast?.premiereDate && item.broadcast.premiereDate > weekEnd) continue;
        ranks[id] = Math.min(ranks[id] ?? 10, row.rank);
      }
    }
    // 接受完整的最新一期，即使该周没有可核实韩剧。旧榜仍按原日期呈现。
    const chart = { source: 'netflix-global', weekEnd, ranks,
      url: `https://www.netflix.com/tudum/top10/tv-non-english?week=${weekEnd}` };
    charts.set(chartKey(chart), chart);
  }
  const rows = [];
  for (const [id, item] of titleEntries) {
    if (item.excluded) continue;
    const matches = catalog.filter(show => matchesReference(show, item));
    // 只在榜单出现时，前端按 hot: 卡片的片名+年份记录标记；进入目录后带上这些旧键，标记跟着节目走。
    const hotMarkKeys = [`id:hot:${id}`, `${item.title}|${item.year || ''}`];
    const show = matches.length === 1 ? { ...matches[0],
      legacyMarkKeys: [...new Set([...hotMarkKeys, ...(matches[0].legacyMarkKeys || [])])].slice(0, 32) } : item.card && {
      ...item.card, id: `hot:${id}`, title: item.title, titleAliases: item.aliases,
      year: item.year, mediaType: '电视剧', regional: '韩国', lang: '韩语', primaryUrlSource: 'official',
      broadcast: broadcastFor(item, validAirings(signals?.airings).find(row => row.id === item.tvmazeId && row.season === 1)),
    };
    if (!show) continue;
    const evidenceRows = [...charts.values()].filter(chart => Object.hasOwn(chart.ranks, id)).map(chart => ({
      source: CHARTS[chart.source].label, group: CHARTS[chart.source].group, weekEnd: chart.weekEnd, url: chart.url, rank: chart.ranks[id],
    }));
    if (evidenceRows.length) rows.push({ show, evidence: evidenceRows });
  }
  const weekEnd = rows.flatMap(row => row.evidence.map(entry => entry.weekEnd)).sort().at(-1);
  if (!weekEnd) return null;
  const ranked = rows.map(({ show, evidence: entries }) => {
    const current = entries.filter(entry => entry.weekEnd === weekEnd).sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source, 'en'));
    if (!current.length) return null;
    return { show, current, rank: current[0].rank, sources: new Set(current.map(entry => entry.group)).size,
      recent: recentPlaysFor(show, signals?.plays, generatedAt) };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || b.sources - a.sources ||
    (b.recent?.perDay ?? 0) - (a.recent?.perDay ?? 0) || a.show.id.localeCompare(b.show.id, 'en'));
  return {
    weekEnd, weekStart: dateKey(Date.parse(weekEnd) - 6 * DAY),
    shows: ranked.slice(0, 24).map(({ show, current, recent }) => ({ ...show,
      hotEvidence: current.map(({ source, url, rank }) => ({ source, url, rank })),
      ...(recent ? { recentPlays: { count: recent.count, from: recent.from, to: recent.to } } : {}),
    })),
  };
}
