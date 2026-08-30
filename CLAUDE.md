# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

剧荒救星 — Korean drama & Chinese variety show recommendation static site. Scrapes YFSP (爱壹帆), enriches with TMDB/Wikidata/Douban/Wikipedia metadata, applies multi-factor recommendation scoring, deploys to GitHub Pages.

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
7. Normalize output fields/URL hosts, drop non-renderable shows, and run continuity + schema guards before the atomic write

**Frontend** (`js/app.js`): IIFE, conditionally fetches `data/shows.json`, renders the card grid and the optional live TVmaze schedule tab. The primary data request and remote-tab requests are bounded, abortable, versioned against stale responses and cached where appropriate. Current-year tab labels follow the dataset year, old tab aliases remain bookmark-compatible, and progressive rendering appends only newly requested cards. External links and numeric fields are validated before rendering.

**Deployment** (`.github/workflows/scrape-and-deploy.yml`): Runs 2x/day (00:00/12:00 UTC), validates and commits data changes, builds a field-minimized Pages payload, then deploys in a separate least-privilege job. `.github/workflows/validate.yml` runs the read-only quality gate on pull requests. Action references are pinned to immutable SHAs and updated by Dependabot.

GitHub Actions secrets: `OPENROUTER_API_KEY` (AI scoring) and `TMDB_TOKEN` (TMDB API v4 Read Access Token for high-res poster images). `OPENROUTER_MODEL` is an optional Actions variable; when unset the scraper uses `openrouter/free`.

## Key Data Flow

Show object fields include `id`, `title`, `titleAliases`, `year`, `score`, `playCount`, `publishTime`, `actor`, `description`, `mediaType`, `regional`, `category`, `recommendScore`, `coverImg`, `primaryUrl`, enrichment URLs, YFSP hotness metadata and versioned AI cache metadata. The deployed JSON contains only fields consumed by the frontend and omits `otherDramas`.

Link priority: `tmdbUrl > doubanUrl > wikipediaUrl > imdbUrl > yfspUrl` → `primaryUrl`.

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
