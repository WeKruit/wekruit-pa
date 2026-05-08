# Phase 73: career-ops port (multi-source senior harvest) - Context

REQ-IDs: SENIOR-V2-01..06 (6, supersedes Phase 63 SENIOR-01..05)

**Status:** Shipped 2026-05-06 (macmini `2bbaa9a`; wekruit-pa `c3e786e`). Roll-up: [.planning/STATE.md](../../STATE.md#phase-73--career-ops-port-2026-05-06-add-on).

**Goal:** Port career-ops scraping logic into wekruit-matching as a nightly Playwright-based harvester. Sources: Greenhouse + Lever + Ashby + Wellfound + Workable + 45+ company portals. Targets senior+ + all-level postings. Source attribution + multi-source dedup. Runs alongside JobRight/SimplifyJobs (Phase 63 keeps junior coverage; Phase 73 adds senior+ depth).

**Reference:** https://github.com/santifer/career-ops (MIT-licensed, study scraping logic + 45-company list)

**In scope:**
- macmini Playwright install (pip install playwright + chromium)
- New scraper modules per provider:
  - `scraper/greenhouse_direct.py` — direct API for greenhouse boards (no JS needed; their /api/v1/boards/{slug}/jobs is public + free)
  - `scraper/lever_direct.py` — direct API (api.lever.co/v0/postings/{company} public + free)
  - `scraper/ashby_direct.py` — direct API (api.ashbyhq.com/posting-api/job-board/{company} public)
  - `scraper/wellfound_playwright.py` — Playwright SSR (anti-bot wall, needs real browser)
- Company list: 45 from career-ops + extend with Adam's target set (~80 total)
  - Big tech: Anthropic, OpenAI, Google, Meta, Apple, Amazon, Microsoft, Netflix, Stripe, Databricks, Snowflake
  - AI scaleups: ElevenLabs, Cohere, Mistral, Together, Modal, LangChain, Hugging Face, Replicate, AssemblyAI, Anyscale
  - Dev tools: Vercel, Linear, Notion, Figma, Retool, Webflow, Hashicorp
  - Fintech: Plaid, Brex, Mercury, Ramp
  - 45+ via career-ops list
- Pipeline integration: Stage 1.6 in `pipeline/daily.py` after Stage 1.5
- Multi-source dedup extends Phase 63 logic
- Per-source feature flags via .env-secrets
- Tests
- Macmini commit + wekruit-pa side: source attribution backfill catch-up

**Out of scope:**
- Career-ops's A-F LLM scoring layer (we use V16)
- Career-ops's tailored CV generation (separate concern)
- LinkedIn API path (still token-gated, deferred)

