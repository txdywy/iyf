# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

剧荒救星 — Korean drama & Chinese variety show recommendation static site. Scrapes YFSP (爱壹帆), enriches with TMDB/Wikidata/Douban/Wikipedia metadata, applies multi-factor recommendation scoring, deploys to GitHub Pages.

No package.json, no dependencies, no build tools. Pure vanilla JS.

## Commands

```bash
# Run scraper (requires Node.js 20+)
node scripts/scrape.mjs

# AI scoring is optional — requires GITHUB_TOKEN or MODELS_TOKEN env var
GITHUB_TOKEN=ghp_xxx node scripts/scrape.mjs

# Serve frontend locally (must use HTTP, not file://)
npx serve .
python3 -m http.server
```

No test suite exists.

## Architecture

**Single-file scraper** (`scripts/scrape.mjs`, ~1460 lines): ES module, runs the entire pipeline in `main()`:

1. Scrape YFSP API (30 pages) → `Map<mediaKey, show>`
2. Split into KDramas / Variety / Other, merge with hardcoded seed libraries (SEED_KDRAMAS, SEED_VARIETY)
3. Discover new shows via keyword search → `discoverNewKDramas()` with AI screening
4. Enrichment chain (sequential): TMDB posters → Wikidata links → YFSP URL verification → Douban links → TMDB/Wikipedia descriptions → AI descriptions
5. AI scoring via GitHub Models (`openai/gpt-4.1-mini`, batched 15/batch, 7-day cache)
6. Drop shows missing `coverImg` or `primaryUrl` → write `data/shows.json`

**Frontend** (`js/app.js`, ~290 lines): IIFE, fetches `data/shows.json` at runtime, renders card grid with tabs (Korean / 2026 / Variety / Latest / Classic), filters (status/score/search), and sorting (recommend/score/newest/popular).

**Deployment** (`.github/workflows/scrape-and-deploy.yml`): Runs 2x/day (00:00/12:00 UTC), commits data changes, deploys to GitHub Pages. Non-site files stripped before upload.

## Key Data Flow

Show object fields: `id`, `title`, `year`, `score`, `playCount`, `actor`, `description`, `mediaType` ('电视剧'/'综艺'), `regional` ('韩国'/'大陆'), `category`, `recommendScore`, `coverImg`, `primaryUrl`, plus enrichment URLs (tmdbUrl, doubanUrl, wikipediaUrl, imdbUrl, yfspUrl) and AI fields (aiScore, aiReason, aiScoredAt).

Link priority: `tmdbUrl > doubanUrl > wikipediaUrl > imdbUrl > yfspUrl` → `primaryUrl`.

## Recommendation Scoring

`scoreKDrama()`: Genre boost (comedy +30, romance +25, horror -30) + negative content penalty (-40/keyword) + `sourceScore*5` + play count tiers + freshness bonus + classic bonus.

`scoreVariety()`: Similar but with `VarietyExclude` blacklist (returns -1 to exclude entirely).

AI blending: `recommendScore += (aiScore - 50) * 0.5` (max ±25 adjustment).

## Title Matching

`normalizeTitle()` strips non-CJK/non-letter chars, removes season/year suffixes. `TITLE_ALIAS_MAP` maps known variants. Matching: exact → edit distance ≤ 1 (for len ≥ 5) → substring containment (len ≥ 4).

## Conventions

- Chinese comments, Chinese UI strings, Chinese log messages
- Scraper section headers: `// ═══════════════════`
- Frontend section headers: `// ── Section Name ──`
- Seed ID format: `seed_kd_YYYY_NN`, `seed_var_YYYY_NN`, `seed_kd_cNN` (classics)
- Constants UPPER_SNAKE_CASE, functions camelCase
- Enrichment cache: `data/image_cache.json`, keyed by show ID, `COVER_CACHE_VERSION` for invalidation
- TMDB API token is hardcoded in source (not env var)
