import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKoreanHotList, koreanPlayIdentity, loadKoreanDramaEvidence, updateKoreanPlayObservations } from './korean-drama-sources.mjs';

test('same-week Netflix evidence appears once when the complete feed replaces a pinned chart', () => {
  const evidence = loadKoreanDramaEvidence();
  const weekEnd = '2026-11-01';
  const show = { id: 'series', title: '百日谎言', year: 2026, tmdbUrl: 'https://www.themoviedb.org/tv/293607' };
  evidence.charts.push({ source: 'netflix-global', weekEnd, ranks: { '100-days': 9 }, url: 'https://www.netflix.com/tudum/top10/' });
  const rows = Array.from({ length: 10 }, (_, index) => ({ rank: index + 1, season: 1, title: index ? `Fixture ${index}` : '100 Days of Deception' }));
  const hot = buildKoreanHotList([show], evidence, { netflix: { weekEnd, rows } }, '2026-11-02T00:00:00Z');
  const chart = hot.shows.find(item => item.id === show.id).hotEvidence;
  assert.equal(chart.length, 4);
  assert.equal(chart.find(item => item.source.includes('全球')).rank, 1);
});

test('a reused play ID resets the cumulative baseline when its season changes', () => {
  const id = 'fixture';
  const first = { id, identity: koreanPlayIdentity({ title: '节目第1季', year: 2026 }), count: 5000, at: '2026-11-01T00:00:00Z' };
  const second = { id, identity: koreanPlayIdentity({ title: '节目第2季', year: 2026 }), count: 17000, at: '2026-11-02T00:00:00Z' };
  const prior = updateKoreanPlayObservations({}, [first], Date.parse(first.at));
  const current = updateKoreanPlayObservations(prior, [second], Date.parse(second.at));
  assert.deepEqual(current[id], [{ at: second.at, count: second.count, identity: second.identity }]);
});

test('weekly charts show paired observations for a current Kubb playback link', () => {
  const evidence = loadKoreanDramaEvidence();
  const show = { id: 'series', title: '百日谎言', year: 2026, tmdbUrl: 'https://www.themoviedb.org/tv/293607',
    yfspUrl: 'https://www.kubb.tv/play/series?from=fixture' };
  const from = '2026-11-01T00:00:00Z';
  const to = '2026-11-02T00:00:00Z';
  const identity = koreanPlayIdentity(show);
  const signals = { plays: { series: [{ at: from, count: 10, identity }, { at: to, count: 40, identity }] } };
  const chart = buildKoreanHotList([show], evidence, signals, to);
  assert.deepEqual(chart.shows.find(item => item.id === show.id).recentPlays, { count: 30, from, to });
});
