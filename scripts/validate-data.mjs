#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const URL_FIELDS = ['coverImg', 'yfspCoverImg', 'primaryUrl', 'url', 'yfspUrl', 'tmdbUrl', 'doubanUrl', 'wikipediaUrl', 'imdbUrl'];
const ALLOWED_HOSTS = new Set([
  'image.tmdb.org', 'www.themoviedb.org', 'movie.douban.com', 'www.imdb.com',
  'www.yfsp.tv', 'static.yfsp.tv', 'rankv21.yfsp.tv',
  'zh.wikipedia.org', 'en.wikipedia.org', 'ko.wikipedia.org',
]);

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (error) {
    errors.push(`${path}: invalid JSON (${error.message})`);
    return null;
  }
}

function validateUrl(value, label) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_HOSTS.has(url.hostname)) {
      errors.push(`${label}: unsafe URL`);
    }
  } catch {
    errors.push(`${label}: malformed URL`);
  }
}

function isTMDBOriginalCover(value) {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' &&
      url.hostname === 'image.tmdb.org' &&
      /^\/t\/p\/original\//u.test(url.pathname);
  } catch {
    return false;
  }
}

function validateShows(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('data/shows.json: root must be an object');
    return;
  }
  const seenIds = new Set();
  for (const category of ['koreanDramas', 'chineseVariety', 'otherDramas']) {
    const shows = data[category];
    if (!Array.isArray(shows)) {
      errors.push(`data/shows.json: ${category} must be an array`);
      continue;
    }
    for (const [index, show] of shows.entries()) {
      const label = `${category}[${index}]`;
      if (!show || typeof show !== 'object' || Array.isArray(show)) {
        errors.push(`${label}: must be an object`);
        continue;
      }
      if (typeof show.id !== 'string' || !show.id.trim()) errors.push(`${label}: missing id`);
      if (typeof show.title !== 'string' || !show.title.trim() || show.title.length > 200) errors.push(`${label}: invalid title`);
      const identity = show.id;
      if (seenIds.has(identity)) errors.push(`${label}: duplicate id ${show.id}`);
      seenIds.add(identity);
      if (!show.coverImg || !show.primaryUrl) errors.push(`${label}: missing renderable cover/link`);
      if (category === 'koreanDramas' && !isTMDBOriginalCover(show.coverImg)) {
        errors.push(`${label}: Korean drama requires a TMDB original cover`);
      }
      for (const field of URL_FIELDS) validateUrl(show[field], `${label}.${field}`);
      for (const field of ['score', 'playCount', 'recommendScore', 'year']) {
        if (Object.hasOwn(show, field) && !Number.isFinite(show[field])) errors.push(`${label}.${field}: must be finite`);
      }
      if (show.score < 0 || show.score > 10) errors.push(`${label}.score: must be from 0 to 10`);
      if (show.aiScore != null && (!Number.isFinite(show.aiScore) || show.aiScore < 0 || show.aiScore > 100)) errors.push(`${label}.aiScore: must be from 0 to 100`);
      if (!Number.isInteger(show.year) || show.year < 1900 || show.year > new Date().getFullYear() + 1) errors.push(`${label}.year: outside supported range`);
      if (show.playCount < 0 || show.playCount > 1e12) errors.push(`${label}.playCount: outside supported range`);
      if (show.recommendScore < 0 || show.recommendScore > 1000) errors.push(`${label}.recommendScore: outside supported range`);
      for (const field of ['currentEpisode', 'totalEpisodes']) {
        const value = show[field] ?? 0;
        if (!Number.isInteger(value) || value < 0 || value > 999) errors.push(`${label}.${field}: must be an integer from 0 to 999`);
      }
      if (/集全|全集|(?<!未)完结|收官/u.test(show.updateStatus || '') && show.isComplete !== true) {
        errors.push(`${label}: completion status contradicts isComplete`);
      }
      if (show.isComplete === true && show.isSerial === true) {
        errors.push(`${label}: isComplete and isSerial cannot both be true`);
      }
    }
    const expected = data.stats?.[category];
    if (Number.isFinite(expected) && expected !== shows.length) errors.push(`stats.${category}: expected ${shows.length}, got ${expected}`);
  }
  const updated = Date.parse(data.lastUpdated || '');
  if (!Number.isFinite(updated)) errors.push('data/shows.json: invalid lastUpdated');
  else if (Date.now() - updated > 7 * 24 * 60 * 60 * 1000) errors.push('data/shows.json: recommendation data is older than 7 days');
  else if (updated - Date.now() > 24 * 60 * 60 * 1000) errors.push('data/shows.json: lastUpdated is unexpectedly in the future');
}

function validateSnapshot(path) {
  const data = readJSON(path);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${path}: root must be an object`);
    return;
  }
  if (!Array.isArray(data.shows)) errors.push(`${path}: shows must be an array`);
  const updated = Date.parse(data.lastUpdated || '');
  if (!Number.isFinite(updated)) errors.push(`${path}: invalid lastUpdated`);
  else if (Date.now() - updated > 14 * 24 * 60 * 60 * 1000) warnings.push(`${path}: snapshot is older than 14 days; UI must label it as stale`);
}

function validateObjectFile(path) {
  const data = readJSON(path);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${path}: root must be an object`);
  }
}

validateShows(readJSON('data/shows.json'));
validateSnapshot('data/trakt_shows.json');
validateSnapshot('data/mdl_shows.json');
validateObjectFile('data/image_cache.json');
validateObjectFile('data/discovery.json');

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Data validation passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`);
}
