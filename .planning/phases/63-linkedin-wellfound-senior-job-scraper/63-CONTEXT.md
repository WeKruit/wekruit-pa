# Phase 63: LinkedIn / Wellfound senior-job scraper - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Decisions locked: per-source feature flags, source attribution, dedup with JobRight

<domain>
## Phase Boundary

Add LinkedIn / Wellfound / Otta scrapers to `wekruit-scraping/src/wekruit_matching/scraper/` (Python, runs on macmini via launchd). Daily ingestion 100+ senior+staff SWE jobs/day. Per-source feature flag, source attribution, dedup with JobRight corpus.

**REQ-IDs:** SENIOR-01..05 (5)

**In scope:**
- New scraper files: `linkedin.py`, `wellfound.py`, `otta.py` under `wekruit-scraping/src/wekruit_matching/scraper/`
- Per-source feature flags via `.env-secrets` toggles (`ENABLE_LINKEDIN_SCRAPE`, `ENABLE_WELLFOUND_SCRAPE`, `ENABLE_OTTA_SCRAPE`)
- Source attribution: `sources: ['jobright', 'linkedin', ...]` array on each matching-jobs doc
- Dedup logic: same job from multiple sources collapse via `(company_normalized, title_normalized, applyUrl_canonical)` 3-tuple
- Updates wekruit-matching `pipeline/daily.py` to invoke new scrapers
- Tests for each scraper (mock HTTP)
- Adam-callable status: confirms scrapers run successfully on next daily ingestion

**Out of scope:**
- LinkedIn API token provisioning (Phase 69 SECRETS-03)
- Cross-repo Python tag port (deferred v2.0)
- Match query consumption (already handles via Phase 56 V16)

</domain>

<decisions>
## Implementation Decisions

### LinkedIn scraper
- Use LinkedIn's public job search via official API (limited but free) OR public search-page scraping (rate-limit aware, 3req/sec max)
- Filter: SWE roles, US remote OR US-based, posted last 7 days, seniority `senior+`
- Parse: title, company, location, apply URL (extract from "easy apply" or external link), salary if listed, JD body
- Output: matching-jobs row with `sources: ['linkedin']`, seniorityLevel inferred from title regex
- Rate-limit: 100 jobs/day cap initially (avoid LinkedIn block)
- Auth: `LINKEDIN_ACCESS_TOKEN` env (Phase 69 SECRETS-03 will provision)

### Wellfound (formerly AngelList) scraper
- No auth required for public listings
- Focus: startup/scale-up senior+ SWE roles (Wellfound's core audience)
- Use their public job RSS/JSON endpoint OR HTML scrape with rate-limit
- Output: `sources: ['wellfound']`

### Otta scraper
- Otta has a public job feed (some pages CSR-rendered, may need playwright)
- Skip if too brittle — focus LinkedIn + Wellfound first
- Output: `sources: ['otta']`

### Dedup logic
- Existing `wekruit-scraping/src/wekruit_matching/scraper/dedup.py` does URL canonicalization (utm_*) — reuse
- Add fuzzy company match: `company.lower().replace(/[^a-z0-9]/g, '')` strict
- Add fuzzy title match: tokenize + intersect, ≥80% overlap → same job
- 3-tuple key: `f"{company_norm}|{title_norm}|{apply_url_canonical}"` → if existing, merge `sources` array; else new doc

### Source attribution
- `matching-jobs.{id}.sources: string[]` — append-only on dedup hit
- Existing JobRight rows: backfill `sources: ['jobright']` for all docs missing this field

### Feature flags (.env-secrets)
- `ENABLE_LINKEDIN_SCRAPE=1|0` (default 0 until LinkedIn API token provisioned)
- `ENABLE_WELLFOUND_SCRAPE=1|0` (default 1)
- `ENABLE_OTTA_SCRAPE=1|0` (default 0 until tested)

### Tests
- Unit tests for each scraper using mock HTTP fixtures (tests/test_scraper_linkedin.py etc)
- Integration test: full pipeline with mocked endpoints, verify dedup + source attribution

</decisions>

<code_context>
## Existing Code Insights

### Files to add (all on macmini wekruit-scraping repo via SSH)
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/linkedin.py`
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/wellfound.py`
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/otta.py`
- `~/Desktop/WeKruit/wekruit-matching/tests/test_scraper_linkedin.py`
- `~/Desktop/WeKruit/wekruit-matching/tests/test_scraper_wellfound.py`

### Files to modify (macmini)
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/pipeline/daily.py` — add new scraper invocations Stage 1.5
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/dedup.py` — extend with multi-source dedup

### Reusable
- `wekruit-matching/src/wekruit_matching/scraper/jobright_github.py` — model for new scrapers
- `wekruit-matching/src/wekruit_matching/scraper/parser.py` — markdown parser (reuse if HTML-similar)
- `wekruit-matching/src/wekruit_matching/scraper/upsert.py` — Firebase write logic
- Existing `dedup.py` URL canonicalization

### wekruit-pa side
- `apps/functions/scripts/backfill-sources-attribution.mjs` (NEW) — for existing JobRight rows lacking `sources` field, backfill `sources: ['jobright']`

</code_context>

<specifics>
## Specific Ideas

- Wellfound has a public sitemap.xml indexable; could parse that for fresh jobs without auth
- LinkedIn rate-limit aware: 100 jobs/day, exponential backoff on 429
- Re-use playwright if HTML scraping needed (already pinned in scraping repo)
- Sources array enables future filtering: "show me only LinkedIn-sourced senior roles" admin query

</specifics>

<deferred>
## Deferred Ideas

- LinkedIn API token provisioning → Phase 69
- Otta scraper if too brittle → defer to v1.8
- Cross-repo Python tag port → v2.0

</deferred>
