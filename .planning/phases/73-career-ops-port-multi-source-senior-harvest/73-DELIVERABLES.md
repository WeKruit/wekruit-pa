# Phase 73 Deliverables — career-ops port (multi-source senior harvest)

REQ-IDs satisfied: SENIOR-V2-01..06 (6/6).

## Code (macmini — `wekruit-matching`)

- `src/wekruit_matching/scraper/greenhouse_direct.py` — Greenhouse Boards API direct scraper (~270 LOC). Public endpoint `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`, no auth, no JS. 31 verified company slugs (Anthropic, Stripe, Databricks, Figma, Vercel, Discord, Datadog, Cloudflare, Robinhood, Airbnb, etc).
- `src/wekruit_matching/scraper/lever_direct.py` — Lever Postings API direct scraper (~220 LOC). Public endpoint `api.lever.co/v0/postings/{slug}?mode=json`. 9 verified slugs (Spotify, Palantir, Clari, Highspot, Voltus, Olo, Livefront, Ledger, Kraken).
- `src/wekruit_matching/scraper/ashby_direct.py` — Ashby job-board API direct scraper (~270 LOC). Public endpoint `api.ashbyhq.com/posting-api/job-board/{slug}`, tolerates both flat and nested JSON shapes. 26 verified slugs (OpenAI, Linear, Notion, Modal, Supabase, Cohere, Perplexity, Ramp, Deel, etc).
- `src/wekruit_matching/scraper/dedup.py` — extended `SOURCE_PRIORITY` with greenhouse/lever/ashby tier; new `_priority_for_repo()` and `_canonical_source()` helpers strip `:slug` suffix when computing priority + sources merge.
- `src/wekruit_matching/pipeline/daily.py` — Stage 1.6 inserted after Stage 1.5 (otta), runs all three direct-API scrapers under their own ENABLE_*_DIRECT flags. Output joins `senior_jobs` and feeds `dedup_multi_source` then per-`source_repo` upsert/stale-mark flow.

## Tests (macmini — `wekruit-matching/tests`)

- `tests/test_scraper_greenhouse_direct.py` — 22 tests
- `tests/test_scraper_lever_direct.py` — 17 tests
- `tests/test_scraper_ashby_direct.py` — 24 tests
- Total Phase 73: **63 new** tests, all green.
- Regression: `test_scraper_dedup_multi.py` (16), `test_scraper_linkedin.py` (12), `test_scraper_wellfound.py` (14) all still green; `test_pipeline_daily.py` 4 passed + 1 skipped.

## Configuration

- `/Users/Shared/wekruit/.env-secrets` — appended:
  ```
  ENABLE_GREENHOUSE_DIRECT=1
  ENABLE_LEVER_DIRECT=1
  ENABLE_ASHBY_DIRECT=1
  ```
  Default-on because all three are public unauthenticated APIs.

## Live smoke test (2026-05-06)

Full sweep across all configured slugs:
- Greenhouse: 4943 jobs across 31 companies
- Lever: 439 jobs across 9 companies
- Ashby: 1552 jobs across 26 companies
- Combined: 6934 → 6696 after `dedup_multi_source` (collapsed 238 dupes)
- Senior+ tier (senior/staff/principal/director): **1734** jobs
- Cross-provider multi-source matches: 141

Anthropic Greenhouse alone: 200 jobs, full role mix from mid_level through director.

## Wellfound Playwright

Deferred to v1.8. Greenhouse/Lever/Ashby direct APIs already deliver 6700+ jobs with no install footprint. Adding Playwright (Chromium download ~150MB, headless render time, anti-bot risk) for an incremental Wellfound ~100/day was not worth it under the current launchd budget. Phase 63 LinkedIn/Wellfound scrapers remain wired (Stage 1.5) for that source.

## Anti-pattern guard rails

- No regex over JD content for seniority (D15) — title-only inference, identical to Phase 63 linkedin/wellfound regex set.
- No abbreviations in slugs (D5).
- Multi-source dedup at Stage 1.5/1.6 collapses (company, title, url) tuple before upsert — single Firestore write per real job, not per provider hit.
- Per-source ENABLE flags so a single dead provider can be flipped off without redeploy.

## Pipeline scheduling

No launchd schedule change needed. Existing 06:00 PT daily pipeline now picks up Stage 1.6 automatically because the new code is in `pipeline/daily.py` and the env flags default-on.
