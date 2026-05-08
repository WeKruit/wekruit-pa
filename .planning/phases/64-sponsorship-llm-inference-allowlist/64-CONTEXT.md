# Phase 64: Sponsorship LLM inference + company allowlist - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (combined commits; see audit). Verified: [.planning/v1.7-MILESTONE-AUDIT.md](../../v1.7-MILESTONE-AUDIT.md).

<domain>
LLM (gpt-5.4-nano OR Qwen-7B free) infers `sponsorship: boolean` from JD text when scraper raw is null. Maintain `pa-sponsorship-allowlist` Firestore collection seeded from h1bdata.info + manual curation. V16 hard filter respects null vs false correctly.

**REQ-IDs:** SPONSOR-01..05 (5)

**In scope:**
- LLM JD-text → sponsorship inference helper `apps/functions/src/lib/sponsorship-inference.ts`
- Firestore `pa-sponsorship-allowlist` collection (200+ known-sponsoring companies seeded)
- Backfill script `apps/functions/scripts/backfill-sponsorship.mjs` (DRY-RUN + --apply)
- V16 filter audit: `sponsor_needed × sponsorship === false` drops; `sponsor_needed × null` keeps (graceful)
- Tests
</domain>

<decisions>
- LLM prompt: "Does this JD explicitly state visa sponsorship is offered/required? Return JSON `{sponsorship: true|false|null, reasoning: string}`. Only true if explicit (`H-1B sponsorship available`, `sponsors visas`, etc); only false if explicit denial (`no visa sponsorship`); else null"
- Provider chain: gpt-5.4-nano (primary) → Qwen-7B (fallback free)
- Allowlist seed: 200 manually-curated big tech + scale-ups known to sponsor (Google, Meta, Amazon, Stripe, Anthropic, Databricks, etc)
- Source field on sponsorship: `sponsorshipSource: 'jd_inference' | 'allowlist' | 'scraper'` for audit
- Confidence: `sponsorshipConfidence: 0..1` (1.0 for allowlist hit, LLM-returned for inference)
- V16 hard filter: only DROP when `sponsor_needed × sponsorship === false`; null/undefined → KEEP (don't underrecommend)
</decisions>

<code_context>
- `apps/functions/src/lib/llm-rerank.ts` — existing Qwen-7B JSON pattern to mirror
- `apps/functions/src/lib/jd-relative-weights.ts` — Phase 58 LLM helper, mirror pattern for fallback chain
- `apps/job-rec/src/tools/query-matching-jobs-v16.ts` line ~387 — visa filter to audit (currently drops `sponsor_needed × sponsorship !== true`?)
- `matching-jobs.sponsorship` field — many null in production (verified: 87/500 active have explicit true)
- Phase 53 Anthropic provider available for LLM tier
</code_context>

<specifics>
- Allowlist JSON seed in repo `apps/functions/data/sponsorship-allowlist.json`
- Companies derived from: h1bdata.info top H-1B sponsors 2024 + scale-ups from First Round / a16z portfolio
- Backfill script processes 1944 active jobs; cost ~$0.02/job × 1944 = $40 one-time (gpt-5.4-nano)
- Re-runs only on null sponsorship (idempotent)
</specifics>

<deferred>
- Real-time sponsorship inference per-scrape (currently batch only)
- Allowlist auto-update from h1bdata API (manual curation v1.7)
</deferred>
