#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutput } from './build-output-path.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolveBuildOutput(root, process.argv.slice(2), 'site/data/shows.json', 'build-public-data.mjs');

const source = JSON.parse(readFileSync(join(root, 'data', 'shows.json'), 'utf8'));
const PUBLIC_SHOW_FIELDS = [
  'id', 'title', 'titleAliases', 'mediaType', 'regional', 'lang', 'year',
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
  return projected;
}

if (!Array.isArray(source.koreanDramas) || !Array.isArray(source.chineseVariety)) {
  throw new Error('data/shows.json is missing public recommendation arrays');
}

const publicData = {
  lastUpdated: source.lastUpdated,
  generatedAt: source.generatedAt,
  sourceStatus: source.sourceStatus,
  stats: {
    koreanDramas: source.koreanDramas.length,
    chineseVariety: source.chineseVariety.length,
  },
  koreanDramas: source.koreanDramas.map(projectShow),
  chineseVariety: source.chineseVariety.map(projectShow),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(publicData)}\n`, 'utf8');
console.log(`Built public data: ${outputPath} (${Buffer.byteLength(JSON.stringify(publicData))} bytes)`);
