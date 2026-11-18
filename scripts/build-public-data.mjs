#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutput } from './build-output-path.mjs';
import { applyVerifiedKoreanDrama, buildKoreanHotList, loadKoreanDramaEvidence, projectKoreanBroadcast } from './korean-drama-sources.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { isShowDataset } = createRequire(import.meta.url)('../js/app.js');
const outputPath = resolveBuildOutput(root, process.argv.slice(2), 'site/data/shows.json', 'build-public-data.mjs');

const source = JSON.parse(readFileSync(join(root, 'data', 'shows.json'), 'utf8'));
const PUBLIC_SHOW_FIELDS = [
  'id', 'seedId', 'publicId', 'legacyIds', 'legacyMarkKeys', 'title', 'titleAliases', 'mediaType', 'regional', 'lang', 'year',
  'score', 'tmdbRating', 'playCount', 'recommendScore', 'aiScore', 'aiReason',
  'contentType', 'actor', 'description', 'descriptionSource', 'coverImg', 'publishTime',
  'firstSeenAt', 'scrapedAt', 'lastLiveAt', 'updateMsg',
  'updateStatus', 'totalEpisodes', 'currentEpisode', 'isComplete', 'isSerial',
  'isClassic', 'isNew', 'primaryUrl', 'primaryUrlSource',
  'yfspUrl', 'tmdbUrl', 'doubanUrl', 'wikipediaUrl', 'imdbUrl',
  'tmdbCoverPending',
];
// 前端把缺省、null、空字符串、空数组和 false 标记视为同一含义；这些值不必逐条下发。
// 首次发现时间、观测时间、更新信息与简介来源按原值保留，维持公开字段的既有语义。
const VERBATIM_FIELDS = new Set(['id', 'title', 'firstSeenAt', 'scrapedAt', 'updateMsg', 'descriptionSource']);
const FLAG_FIELDS = new Set(['isComplete', 'isSerial', 'isClassic', 'isNew', 'tmdbCoverPending']);

function isEmptyOptional(field, value) {
  if (VERBATIM_FIELDS.has(field)) return false;
  if (value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return FLAG_FIELDS.has(field) && value === false;
}

function projectShow(show) {
  const projected = {};
  for (const field of PUBLIC_SHOW_FIELDS) {
    if (Object.hasOwn(show, field) && !isEmptyOptional(field, show[field])) projected[field] = show[field];
  }
  const broadcast = projectKoreanBroadcast(show.broadcast);
  if (broadcast) projected.broadcast = broadcast;
  return projected;
}

if (!Array.isArray(source.koreanDramas) || !Array.isArray(source.chineseVariety)) {
  throw new Error('data/shows.json is missing public recommendation arrays');
}

const koreanEvidence = loadKoreanDramaEvidence();
const koreanDramas = source.koreanDramas.map(show => applyVerifiedKoreanDrama(show, koreanEvidence, source.koreanSignals));
// Actions 与 Cloudflare 分别构建。榜周和播放观测以已提交数据为准，构建时钟不能改变文件字节。
const hot = buildKoreanHotList(koreanDramas, koreanEvidence, source.koreanSignals, source.generatedAt);
const publicData = {
  lastUpdated: source.lastUpdated,
  generatedAt: source.generatedAt,
  sourceStatus: source.sourceStatus,
  stats: {
    koreanDramas: source.koreanDramas.length,
    chineseVariety: source.chineseVariety.length,
  },
  koreanDramas: koreanDramas.map(projectShow),
  chineseVariety: source.chineseVariety.map(projectShow),
  ...(hot ? { koreanHot: { weekStart: hot.weekStart, weekEnd: hot.weekEnd, shows: hot.shows.map(show => ({
    ...projectShow(show), hotEvidence: show.hotEvidence, ...(show.recentPlays ? { recentPlays: show.recentPlays } : {}),
  })) } } : {}),
};

const payload = JSON.stringify(publicData);
if (!isShowDataset(JSON.parse(payload))) throw new Error('Invalid public recommendation payload');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${payload}\n`, 'utf8');
console.log(`Built public data: ${outputPath} (${Buffer.byteLength(payload)} bytes)`);
