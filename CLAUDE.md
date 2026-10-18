# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

剧荒救星 — Korean drama & Chinese variety show recommendation static site. Scrapes YFSP (爱壹帆), enriches with TMDB/Wikidata/Douban/Wikipedia metadata, applies multi-factor recommendation scoring, deploys the same validated artifact to Cloudflare Pages and GitHub Pages.

No package.json or third-party runtime dependencies. The site is pure vanilla JS;
small dependency-free Node scripts validate and project the deployment payload.

## Commands

```bash
# Run scraper (Node.js 22; see .node-version)
node scripts/scrape.mjs

# Recalculate the published recommendation scores without network calls
node scripts/scrape.mjs --recalculate-existing

# AI scoring — runs automatically when an OpenRouter key is present
OPENROUTER_API_KEY=sk-or-xxx node scripts/scrape.mjs
# Optional explicit model override; the default is OpenRouter's dynamic free router
OPENROUTER_API_KEY=sk-or-xxx OPENROUTER_MODEL=openrouter/free node scripts/scrape.mjs

# Serve frontend locally (must use HTTP, not file://)
npx serve .
python3 -m http.server

# Full local quality gate
node --test
node scripts/validate-data.mjs

# Build the minimized public recommendation payload
node scripts/build-public-data.mjs --output /tmp/shows.json

# Build the complete validated deployment artifact for both hosts
node scripts/build-site.mjs
```

The test suite is dependency-free and uses Node's built-in test runner. `scripts/regression-tests.mjs` can also be run directly while debugging.

## Architecture

**Single-file scraper** (`scripts/scrape.mjs`): ES module, runs the entire pipeline in `main()`:

1. Scrape YFSP API (30 pages) → `Map<mediaKey, show>`
2. Split into KDramas / Variety / Other, merge with hardcoded seed libraries (SEED_KDRAMAS, SEED_VARIETY); title aliases and last-published enrichment are used to keep accepted cards stable when YFSP IDs/pages change
3. Discover new shows via dynamic current-year keyword search
4. Enrich from TMDB/Wikidata/YFSP/Douban/Wikipedia, with bounded concurrency, tri-state link verification, negative caches and time budgets
5. Reconcile status fields and compute final rule scores only after trusted-source enrichment
6. AI scoring via `callModelsAPI()`: category-specific Korean-drama/variety prompts, batched 10/batch, versioned input-hash cache with staggered expiry
   - Uses OpenRouter's official `openrouter/free` dynamic route by default; `OPENROUTER_MODEL` can select an explicit model
   - Requests use strict JSON Schema and a shared eight-minute budget with a 60-second per-request deadline, sized for free-router latency
   - LLM IDs are constrained to the current batch and IDs, scores, booleans, reasons and descriptions are validated again before use
   - Inputs use `sourceRating10` (null when unrated), while outputs require `recommendationScore100` and a consistent `recommendationLevel`: strong ≥70, moderate ≥40 and <70, weak <40. Genuine low scores remain on the 0–100 scale; ambiguous old responses are rejected. New drama admission requires both `ok=true` and a score of at least 40
   - Generated descriptions are labeled in the UI and excluded from scoring facts; reliable short source descriptions are preserved. Prompt/cache version 4 invalidates the earlier ambiguous scoring contract
7. Normalize output fields/URL hosts, drop non-renderable shows, and run continuity + schema guards before the atomic write

**Frontend** (`js/app.js`): IIFE, conditionally fetches `data/shows.json`, renders the card grid and the optional live TVmaze schedule tab. The primary data request and remote-tab requests are bounded, abortable, versioned against stale responses and cached where appropriate. Current-year tab labels follow the dataset year, old tab aliases remain bookmark-compatible, and progressive rendering appends only newly requested cards. External links and numeric fields are validated before rendering.

The HTML preloads the same recommendation fetch with anonymous CORS and preconnects to the used TMDB image origin. Initial recommendation cards and statistics appear immediately; entrance/counting animations remain available for later tab changes. Year selection runs once per category/filter pass or rendered batch, never once per show. Treat loaded data as immutable snapshots: equal background responses keep the prior snapshot object, and identical visible object prefixes can retain card DOM. Card reuse is invalidated by dataset identity, tab, computed year, recommendation maximum or a changed visible prefix; skeleton/error writes explicitly reset render tracking. Hashed CSS/JS use one-year immutable caching, while HTML/JSON continue revalidation. Deployment verification requires the immutable CSS/JS policy as well as HTML/JSON revalidation.

Delivery-policy changes must also migrate an unchanged asset's URL when old response headers remain cached. Update that asset's delivery-version comment so its full-byte content hash changes, then verify both public domains. Do not relax the cache/header gate or replace the content hash with an unrelated version string.

When a changed background snapshot rebuilds cached cards, retain the focused programme/link and reading offset by programme ID. Make a retained card visible even if it moves beyond the current batch; provide a reachable card/main-content fallback when a programme, link or focused pagination button disappears. Explicit tab/filter actions retain their usual focus behavior.

Before hiding a focused action, move its focus to a reachable continuation: clearing filters returns to search, recommendation/TVmaze retries retain main-content focus, and automatic final-batch loading focuses the first appended card only when the focused pagination button disappears. Measure the sticky tabs into `--tabs-scroll-offset` at initialization and via ResizeObserver (resize fallback), with root scroll padding protecting content jumps and focus rings. Badge/button colors must remain readable over bright and dark posters, including hover states.

TVmaze works independently of the recommendation JSON, defaults to date/time ordering, and labels Korean-local airtimes. Cache reuse requires the same Korea-local date as the request, including empty and partial results. A failed current-day request with empty historical results retains the error/retry state or the previous schedule rather than caching an unconfirmed empty day. HTTP/JSON failures and timeouts during historical backfill preserve completed results, label the partial schedule, and cache it for only one minute; leaving the tab still cancels all writes from that request. Summary entities are decoded before final text escaping. Before the initial recommendation response arrives, filtering preserves the loading state. Ongoing filters/statistics require an explicit running status rather than treating unknown/upcoming shows as running. Progressive loading has both automatic observation and a keyboard-accessible button; manual loading focuses the first appended card while automatic loading preserves focus. Recommendation cache notices persist across local tabs, and an initial failure retries in place without losing filters. TVmaze validates consumed row fields before caching and rendering; malformed rows produce a brief partial cache rather than hiding valid programmes. The public payload retains first-seen timestamps, update messages and description provenance; regression tests exercise the actual public builder to catch projection omissions.

**Deployment** (`.github/workflows/scrape-and-deploy.yml`): Runs 2x/day (00:00/12:00 UTC), validates and commits data changes, builds the validated `site/` artifact via `scripts/build-site.mjs`, then publishes GitHub Pages and Cloudflare Pages in independent least-privilege jobs. Cloudflare retains the Git source but has automatic production/preview builds disabled. The Cloudflare job downloads this run's artifact and calls `scripts/deploy-cloudflare.mjs` with the deploy hook for main. Pages rebuilds with `node --test && node scripts/build-site.mjs`; the job waits for both homepages to match before requesting assets, then verifies all six public file hashes, the actual 404 status, and cache/security headers on both the custom and Pages domains against the validated artifact. Polling has a 10-minute deadline; individual network requests also have timeouts. Controlled diagnostics identify each failing domain/file, HTTP status, hash prefix, header name or allowlisted transport error; hook credentials, response bodies, header values and raw exceptions are never logged. A Cloudflare failure does not prevent the GitHub Pages backup from publishing.

The shared builder validates render-field types, projects only public fields, emits CSS/JS with content hashes in their filenames, includes a real 404 and Cloudflare cache/security headers, and rejects unexpected files, symlinks and hard links in output. Protected source directories are checked through parent aliases and filesystem identities before any writes. `.github/workflows/validate.yml` runs the read-only quality gate on pull requests. Action references are pinned to immutable SHAs and updated by Dependabot.

All three build CLIs use `scripts/build-output-path.mjs` for strict argument parsing and output protection. Source files/directories and `.env` variants cannot be overwritten directly or through aliases/inodes; normal `site/` and temporary outputs are allowed. Deployment verification requests are limited by the remaining polling budget and cannot report success after its deadline. The production scrape job runs only for `refs/heads/main`; non-main manual dispatches skip it before making external requests.

Deployment verification also checks each file's Content-Type essence, accepting optional charset parameters and both standard JavaScript types. Correct bytes served with an unusable MIME type must fail verification, especially with `nosniff`; diagnostics expose the header name only.

GitHub Actions secrets: `OPENROUTER_API_KEY` (AI scoring), `TMDB_TOKEN` (TMDB API v4 Read Access Token for high-res poster images), and `CLOUDFLARE_DEPLOY_HOOK` (the full Pages deploy hook URL for main). `OPENROUTER_MODEL` is an optional Actions variable; when unset the scraper uses `openrouter/free`.

## Key Data Flow

Show object fields include `id`, `title`, `titleAliases`, `year`, `score`, `playCount`, `publishTime`, `actor`, `description`, `mediaType`, `regional`, `category`, `recommendScore`, `coverImg`, `primaryUrl`, enrichment URLs, YFSP hotness metadata and versioned AI cache metadata. The deployed JSON contains only fields consumed by the frontend and omits `otherDramas`.

Link priority: `tmdbUrl > doubanUrl > wikipediaUrl > imdbUrl > yfspUrl` → `primaryUrl`.

Seed fallback must preserve previously observed dynamic facts and source descriptions when upstream fields are absent; explicit source values such as `0` and `false` still replace old values. Known erroneous legacy seed metadata is migrated before merging or recalculation so the old snapshot cannot restore that error. Positive YFSP page verification refreshes `lastLiveAt`, while failed or inconclusive checks do not. Same-day discovery history accumulates by title/year identity across runs. Discovery must not promote an existing media ID again under a title alias or an older premiere year. First-seen dates use the same identity checks as source matching, reject invalid/future timestamps and preserve the original date across source ID changes. Optional YFSP searches and verification fit both stage and global remaining budgets and reject late success. Structured numeric input and malformed discovery/metadata rows must not interrupt later valid observations.

The same partial-field merge applies to live `otherDramas` observations. Seed/live and title-based snapshot matching require compatible regions. Offline recalculation drops negative rule scores before applying AI adjustments, so excluded variety cannot reappear through a high AI score. Discovery monitoring compares homepage observations against identities known before the run, rather than the already-populated recommendation maps. Drama and variety logs share same-day accumulation by media type, region, title and year; legacy untyped drama records remain compatible, and final admission rejection does not erase an observation.

Trusted description upgrades preserve any hard content exclusion already established during the current run, using non-enumerable derived state before final admission. Retiring an unverified whole-series synopsis does not establish season facts; wrong-entity cleanup occurs before description enrichment. AI display copy remains excluded from source evidence. YFSP search validates usable candidate URLs before ranking, and malformed-only responses remain `unknown` rather than establishing a long negative cache. Free-text limits preserve complete Unicode characters; malformed or overlong source identifiers are rejected per row rather than repaired into a different identity.

Long AI display copy must not suppress later TMDB/Wikipedia source prose, even when the reliable synopsis is shorter. External metadata has an independent state/timestamp from the positive cover cache: unknown results retry after 18 hours and complete results after 30 days. Refresh only reusable entities in the current run, grouped by media kind and TMDB ID; cap at six entities, concurrency three and 40 seconds within the global enrichment deadline. Migrate old entries gradually in oldest-first order; retain independently verified season subjects and reliable existing links, and reject malformed or late results. These cache fields stay private; public projection also omits the unused `coverSource` field.

Season-specific TMDB covers require observed series identity and the matching season number. A title copied from the input or a previously published URL is insufficient evidence for an unverified series. Rejected identities must remain rejected across negative-cache retries; confirmed mismatches clear associated cached external links and sourced descriptions as well as the TMDB link and poster. Independently verified metadata and transient failures preserve reliable media. Season descriptions use the matching season endpoint and never substitute the whole-series Wikipedia description. Legacy series descriptions are rechecked even when long, and a confirmed season synopsis can replace a longer series synopsis. `descriptionTmdbSeasonUrl` records that verification in the private source snapshot so a confirmed short synopsis survives merging without repeated requests; the public projection omits this bookkeeping.

A missing series poster does not disqualify a matching season poster. Series-level Wikidata Douban links do not establish a season subject; cover enrichment and cache reuse prefer independently verified URL/subject ID/title/season evidence, and discard mismatched evidence together. `doubanMatchedSeasonNumber` preserves season evidence present only in a suggestion's English subtitle; it remains private along with the other matching metadata. Series Wiki/IMDb links remain available.

## Recommendation Scoring

`scoreKDrama()`: Genre boost (comedy +25, romance +20, horror -30; military/cooking/growth subtopics also receive positive weight) + negative content penalty (-40/keyword) + quality score + YFSP hotness + freshness bonus + classic bonus.

`scoreVariety()`: Similar, using the same YFSP hotness metric, with `VarietyExclude` blacklist (returns -1 to exclude entirely).

YFSP hotness is capped at 20 points: cumulative play volume contributes 0–8 logarithmic points, while average plays per day since `publishTime` contributes 0–12. If only `year` is available, the inferred release date is marked as `year` and the velocity component is discounted to 45%; this keeps old seed cards usable without treating an estimated date as exact. Live/search matches replace stale seed play counts and publish times before scoring.

AI blending is category-aware: variety receives a mild adjustment, while low Korean-drama scores receive a stronger penalty. Only an AI score matching the current prompt version and stable input hash participates.

## Title Matching

`normalizeTitle()` strips punctuation and a trailing year while preserving season markers. `TITLE_ALIAS_MAP` maps known variants into symmetric groups. Matching uses exact/alias identity and conservative edit distance for longer names; substring matching is intentionally excluded to avoid merging specials or similarly named programs. When both titles have an explicit season, compare normalized season numbers and base titles so equivalent suffix spellings match while different seasons remain distinct. Cache reuse also checks this stricter identity when live/seed IDs change.

## Conventions

- Chinese comments, Chinese UI strings, Chinese log messages
- Scraper section headers: `// ═══════════════════`
- Frontend section headers: `// ── Section Name ──`
- Seed ID format: `seed_kd_YYYY_NN`, `seed_var_YYYY_NN`, `seed_kd_cNN` (classics)
- Constants UPPER_SNAKE_CASE, functions camelCase
- Enrichment cache: `data/image_cache.json`, keyed by show ID, `COVER_CACHE_VERSION` for invalidation
- TMDB cache keeps `original` source URLs; the frontend renders responsive `w342/w500` variants
- TMDB API token: `TMDB_TOKEN` env var (GitHub Actions secret)
