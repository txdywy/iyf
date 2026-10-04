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

TVmaze works independently of the recommendation JSON, defaults to date/time ordering, and labels Korean-local airtimes. A failed current-day request with empty historical results retains the error/retry state or the previous schedule rather than caching an unconfirmed empty day. A timeout during historical backfill preserves completed results, labels the partial schedule, and caches it for only one minute; leaving the tab still cancels all writes from that request. Before the initial recommendation response arrives, filtering preserves the loading state. Ongoing filters/statistics require an explicit running status rather than treating unknown/upcoming shows as running. Progressive loading has both automatic observation and a keyboard-accessible button. The public payload retains first-seen timestamps, update messages and description provenance; regression tests exercise the actual public builder to catch projection omissions.

**Deployment** (`.github/workflows/scrape-and-deploy.yml`): Runs 2x/day (00:00/12:00 UTC), validates and commits data changes, builds the validated `site/` artifact via `scripts/build-site.mjs`, then publishes GitHub Pages and Cloudflare Pages in independent least-privilege jobs. Cloudflare retains the Git source but has automatic production/preview builds disabled. The Cloudflare job downloads this run's artifact and calls `scripts/deploy-cloudflare.mjs` with the deploy hook for main. Pages rebuilds with `node --test && node scripts/build-site.mjs`; the job verifies all six public file hashes, the actual 404 status, and cache/security headers on both the custom and Pages domains against the validated artifact. Polling has a 10-minute deadline; individual network requests also have timeouts. Hook credentials are never logged. A Cloudflare failure does not prevent the GitHub Pages backup from publishing.

The shared builder validates render-field types, projects only public fields, hashes CSS/JS URLs, includes a real 404 and Cloudflare cache/security headers, and rejects unexpected files, symlinks and hard links in output. Protected source directories are checked through parent aliases and filesystem identities before any writes. `.github/workflows/validate.yml` runs the read-only quality gate on pull requests. Action references are pinned to immutable SHAs and updated by Dependabot.

GitHub Actions secrets: `OPENROUTER_API_KEY` (AI scoring), `TMDB_TOKEN` (TMDB API v4 Read Access Token for high-res poster images), and `CLOUDFLARE_DEPLOY_HOOK` (the full Pages deploy hook URL for main). `OPENROUTER_MODEL` is an optional Actions variable; when unset the scraper uses `openrouter/free`.

## Key Data Flow

Show object fields include `id`, `title`, `titleAliases`, `year`, `score`, `playCount`, `publishTime`, `actor`, `description`, `mediaType`, `regional`, `category`, `recommendScore`, `coverImg`, `primaryUrl`, enrichment URLs, YFSP hotness metadata and versioned AI cache metadata. The deployed JSON contains only fields consumed by the frontend and omits `otherDramas`.

Link priority: `tmdbUrl > doubanUrl > wikipediaUrl > imdbUrl > yfspUrl` → `primaryUrl`.

Seed fallback must preserve previously observed dynamic facts and source descriptions when upstream fields are absent; explicit source values such as `0` and `false` still replace old values. Known erroneous legacy seed metadata is migrated before merging or recalculation so the old snapshot cannot restore that error. Positive YFSP page verification refreshes `lastLiveAt`, while failed or inconclusive checks do not. Same-day discovery history accumulates by title/year identity across runs. Discovery must not promote an existing media ID again under a title alias or an older premiere year.

Season-specific TMDB covers require observed series identity and the matching season number. A title copied from the input or a previously published URL is insufficient evidence for an unverified series. Rejected identities must remain rejected across negative-cache retries; confirmed mismatches clear associated cached external links and sourced descriptions as well as the TMDB link and poster. Independently verified metadata and transient failures preserve reliable media. Season descriptions use the matching season endpoint and never substitute the whole-series Wikipedia description. Legacy series descriptions are rechecked even when long, and a confirmed season synopsis can replace a longer series synopsis. `descriptionTmdbSeasonUrl` records that verification in the private source snapshot so a confirmed short synopsis survives merging without repeated requests; the public projection omits this bookkeeping.

## Recommendation Scoring

`scoreKDrama()`: Genre boost (comedy +25, romance +20, horror -30; military/cooking/growth subtopics also receive positive weight) + negative content penalty (-40/keyword) + quality score + YFSP hotness + freshness bonus + classic bonus.

`scoreVariety()`: Similar, using the same YFSP hotness metric, with `VarietyExclude` blacklist (returns -1 to exclude entirely).

YFSP hotness is capped at 20 points: cumulative play volume contributes 0–8 logarithmic points, while average plays per day since `publishTime` contributes 0–12. If only `year` is available, the inferred release date is marked as `year` and the velocity component is discounted to 45%; this keeps old seed cards usable without treating an estimated date as exact. Live/search matches replace stale seed play counts and publish times before scoring.

AI blending is category-aware: variety receives a mild adjustment, while low Korean-drama scores receive a stronger penalty. Only an AI score matching the current prompt version and stable input hash participates.

## Title Matching

`normalizeTitle()` strips punctuation and a trailing year while preserving season markers. `TITLE_ALIAS_MAP` maps known variants into symmetric groups. Matching uses exact/alias identity and conservative edit distance for longer names; substring matching is intentionally excluded to avoid merging specials or similarly named programs. Cache reuse also checks this stricter identity when live/seed IDs change.

## Conventions

- Chinese comments, Chinese UI strings, Chinese log messages
- Scraper section headers: `// ═══════════════════`
- Frontend section headers: `// ── Section Name ──`
- Seed ID format: `seed_kd_YYYY_NN`, `seed_var_YYYY_NN`, `seed_kd_cNN` (classics)
- Constants UPPER_SNAKE_CASE, functions camelCase
- Enrichment cache: `data/image_cache.json`, keyed by show ID, `COVER_CACHE_VERSION` for invalidation
- TMDB cache keeps `original` source URLs; the frontend renders responsive `w342/w500` variants
- TMDB API token: `TMDB_TOKEN` env var (GitHub Actions secret)
