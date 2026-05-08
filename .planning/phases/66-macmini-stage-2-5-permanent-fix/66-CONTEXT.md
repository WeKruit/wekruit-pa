# Phase 66: Macmini Stage 2.5 permanent fix - Context

REQ-IDs: MACMINI-01..03 (3)

**Status:** Shipped 2026-05-06 (`6caee56` + macmini `b81ecaf`). Verified: [.planning/v1.7-MILESTONE-AUDIT.md](../../v1.7-MILESTONE-AUDIT.md).

**Goal:** Diagnose Supabase pooler hang in `wekruit-matching/src/wekruit_matching/pipeline/url_resolver.py`. Either fix connection-pool config OR migrate URL-resolution stage to wekruit-pa CF (already deployed). Remove `SKIP_URL_RESOLUTION=1` hotfix. Fix Stage 2c LLM "connection lost" failures.

**Decision:** Migrate to wekruit-pa CF path. macmini Stage 4 will call CF after sync (no in-pipeline blocker). The CF batch (Phase 65) handles backfill on hourly cadence — this is the v1.7 architecture going forward. macmini Stage 2.5 url_resolver.py becomes deprecated dead code → delete in phase, document.

Stage 2c LLM "connection lost" — investigate firecrawl/openai timeout settings, raise + retry.
