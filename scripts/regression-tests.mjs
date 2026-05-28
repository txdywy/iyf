import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = path => readFileSync(join(root, path), 'utf8');

const app = read('js/app.js');
const scrape = read('scripts/scrape.mjs');
const updateVariety = read('scripts/update-variety.mjs');
const workflow = read('.github/workflows/scrape-and-deploy.yml');
const css = read('css/style.css');

assert.match(app, /escapeHtml\(String\(show\.aiScore\)\)/, 'AI score badge should escape stringified output');
assert.match(app, /escapeHtml\(String\(show\.score\)\)/, 'score badge should escape stringified output');
assert.match(app, /escapeHtml\(String\(show\.score\)\)/, 'floating score should escape stringified output');
assert.match(app, /\(s\.title \|\| ''\)\.toLowerCase\(\)\.includes\(query\)/, 'search should tolerate missing titles');
assert.match(app, /function getValidTime\(/, 'date sorting should use a valid-time helper');
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
assert.match(scrape, /isRecommendationCategory\(show\)[\s\S]*?isTMDBImageUrl\(show\.coverImg\)/, 'new Korean drama and variety recommendations should require TMDB image URLs');
assert.match(scrape, /cached\?\.notFound[\s\S]*?isRecommendationCategory\(s\)/, 'negative TMDB cache should not suppress retries for recommendation categories');
assert.match(scrape, /id: it\.mediaKey \|\| it\.episodeKey \|\| stableDiscoveredId\(/, 'API items without media IDs should not collapse into an empty liveShows key');
assert.match(scrape, /isTMDBImageUrl\(show\.coverImg\)[\s\S]*?show\.coverSource = 'tmdb'[\s\S]*?else if \(show\.coverImg\)/, 'restored TMDB covers should keep TMDB source while enriching covers');
assert.doesNotMatch(scrape, /if \(show\.coverImg\) show\.yfspCoverImg = show\.coverImg;/, 'restored TMDB covers should not be treated as YFSP fallbacks');

assert.match(updateVariety, /actor:'马东,黄渤,徐峥,于和伟'/, '喜人奇妙夜 actor typo should be corrected');

assert.match(workflow, /data\/history\.json/, 'workflow should include history.json in data commit handling');
assert.match(workflow, /TMDB_TOKEN: \$\{\{ secrets\.TMDB_TOKEN \}\}/, 'workflow should pass TMDB_TOKEN from secrets');
assert.match(workflow, /paths-ignore:\n\s+- 'data\/\*\*'/, 'data-only bot commits should not retrigger the scraper workflow');
assert.match(workflow, /pushed=false/, 'workflow should track whether data push actually succeeded');
assert.match(workflow, /exit 1/, 'workflow should stop before deploy if data push fails');
assert.doesNotMatch(workflow, /git rebase --continue \|\| true/, 'workflow should not swallow failed rebase continuation');

assert.doesNotMatch(css, /\.show-card:nth-child\(\d+\) \{ animation-delay:/, 'CSS nth-child animation delays should not duplicate inline delay');

console.log('Regression checks passed');
