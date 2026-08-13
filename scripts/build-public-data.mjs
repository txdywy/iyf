#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--output');
const outputPath = resolve(outputFlag >= 0 && process.argv[outputFlag + 1]
  ? process.argv[outputFlag + 1]
  : join(root, 'site', 'data', 'shows.json'));

const source = JSON.parse(readFileSync(join(root, 'data', 'shows.json'), 'utf8'));
const PUBLIC_SHOW_FIELDS = [
  'id', 'title', 'titleAliases', 'mediaType', 'regional', 'lang', 'year',
  'score', 'playCount', 'recommendScore', 'aiScore', 'aiReason',
  'contentType', 'actor', 'description', 'coverImg', 'publishTime',
  'updateStatus', 'totalEpisodes', 'currentEpisode', 'isComplete', 'isSerial',
  'isClassic', 'isAutoDiscovered', 'isNew', 'primaryUrl', 'primaryUrlSource',
  'yfspUrl', 'tmdbUrl', 'doubanUrl', 'wikipediaUrl', 'imdbUrl',
];

function projectShow(show) {
  const projected = {};
  for (const field of PUBLIC_SHOW_FIELDS) {
    if (Object.hasOwn(show, field)) projected[field] = show[field];
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
