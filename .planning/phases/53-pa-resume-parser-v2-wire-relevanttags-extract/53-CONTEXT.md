# Phase 53: pa-resume-parser v2 wire + relevantTags extract - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Auto-generated (decisions D6, D11, D12, D15 locked, smart-discuss skipped)

<domain>
## Phase Boundary

`cv-ingest` Cloud Function uses `packages/pa-resume-parser` v2 `parseResumeText` — removes inline single-shot nano call. LLM chain `gpt-5.4-nano (primary) → claude-sonnet-4-6 (fallback) → gpt-4.1-mini (final)` with Sonnet-4-6 reintroduced. Schema extended with `relevantIndustry`, `relevantSpecialization`, `proposedTags` (max 12). Post-parse Claire dialogue confirms understanding. Industry classification reduces regex (D15) — when LLM emits `["other"]`, Sonnet-4-6 second-pass with reasoning. cv-ingest idempotent on sha256.

**In scope:**
- Add Anthropic provider to pa-resume-parser
- Update TIER_CHAIN to `gpt-5.4-nano → claude-sonnet-4-6 → gpt-4.1-mini`
- Extend pa-resume-parser zod schema with `relevantIndustry: string[]`, `relevantSpecialization: string[]`, `proposedTags: string[]`
- Update parseResume prompt to extract these
- Wire cv-ingest CF to call `parseResumeText` instead of inline LLM
- Idempotency: cv-ingest checks sha256 before re-parsing
- Sonnet-4-6 second-pass for `["other"]` industry classification
- Post-parse Claire confirm dialogue (queues to pa-outbound)
- Tests + build green

**Out of scope:**
- Match query consumer (Phase 56)
- Onboarding chat answer hooks (Phase 54)
- Migration script (Phase 54)
- Dashboard (Phase 59)

</domain>

<decisions>
## Implementation Decisions

### LLM chain (D11, PARSE-02)
- TIER_CHAIN updated to: `gpt-5.4-nano (primary)` → `claude-sonnet-4-6 (fallback)` → `gpt-4.1-mini (final)`
- Anthropic SDK: `@anthropic-ai/sdk` (latest)
- Provider abstraction: `providers/anthropic-messages.ts` mirrors `providers/openai-responses.ts` interface
- Sonnet-4-6 uses `tool_use` API for structured output (Anthropic equivalent of OpenAI Responses + JSON Schema)
- ANTHROPIC_API_KEY: Firebase Secret (not yet provisioned — code falls back to next tier if undefined at runtime)
- Each tier gets max 2 SDK retries

### Schema Extensions (PARSE-03, PARSE-04, PARSE-05)
- `relevantIndustry: string[]` — derived from work-history industries (per-job inferred sectors), max 6
- `relevantSpecialization: string[]` — sub-domain expertise (e.g., `frontend_development`, `mlops`, `infrastructure_security`), max 6
- `proposedTags: string[]` — sandbox open-vocab, max 12, lowercase + underscore pattern, validated against `KNOWN_ABBREVIATIONS` reject list from shared-tags Phase 52
- All extracted parse-time in single LLM call (no separate enrichment pass)

### cv-ingest wire (PARSE-01, PARSE-06, PARSE-09)
- Replace inline `callOpenAIResponses` in cv-ingest.ts with `parseResumeText` from `@pa/pa-resume-parser`
- Same Firestore write target: `parsedCandidateResumes/{auto-id}` (existing 44 docs schema preserved + new fields appended)
- Chain to `mergeUserTags()` write to `pa-users/{userId}.tags` in same execution (already partially wired iter34 H.3b commit `ad99a2`, finish + verify)
- Idempotency: sha256(pdf bytes) → check `parsedCandidateResumes` query `where sha256 == X`, skip re-parse if found
- Tag merge fail-open: parsedCandidateResumes write must succeed even if mergeUserTags errors

### Industry second-pass (PARSE-08, D15)
- After parse: if `industryTags === ['other']` OR `parsed.industries === []`, run Sonnet-4-6 second-pass
- Second-pass prompt: explicit reasoning per industry decision, picks from canonical INDUSTRY_SECTOR_VOCAB (Phase 52)
- Result merged back to `parsed.industries` before mergeUserTags
- No regex token-match (D15 — explicit reduce regex reliance)

### Claire confirm dialogue (PARSE-07, D12)
- Post-parse, after Firestore write, enqueue Claire message to `pa-outbound/out-cvconfirm-{resumeId}`
- Message template: `"看了你的简历——你做过 {top 2 roles}, 用过 {top 5 skills}, 最近在 {industries}。对吗？" (zh) / "Read your resume — you've done {top 2 roles}, used {top 5 skills}, recent industries: {industries}. Sound right?" (en)`
- User correction handler: parses response, calls `mergeUserTags` to update tags
- Reply analysis is deferred to Phase 54's onboarding chat hooks (not Phase 53 scope)

### Idempotency (PARSE-09)
- Compute sha256 of fetched PDF bytes
- Query `parsedCandidateResumes` by `where sha256 == X AND userId == Y` — if exists, return existing resumeId, skip parse
- Write `sha256` field on every new parsedCandidateResumes doc

</decisions>

<code_context>
## Existing Code Insights

### Current state (must be preserved as fallback path)
- `packages/pa-resume-parser/src/router.ts` — has 3-tier chain `gpt-5.4-nano → gpt-4.1-mini → gpt-4.1-nano` (line 29-33)
- `packages/pa-resume-parser/src/schema.ts` — 19-field parsedResumeData zod schema, `inferredAnswers` is qaBank source
- `packages/pa-resume-parser/src/providers/openai-responses.ts` — OpenAI Structured Output provider
- `packages/pa-resume-parser/src/parser.ts` — main `parseResumeText` entrypoint
- `packages/pa-resume-parser/src/prompt.ts` — system prompt
- `apps/functions/src/cv-ingest/cv-ingest.ts` — CF entrypoint, currently does inline LLM, partially wired to `mergeUserTags` (commit `ad99a2`)
- `apps/functions/src/cv-ingest/industry-tags.ts` — INDUSTRY_TAGS legacy enum + fallback (will be replaced by Phase 52 INDUSTRY_SECTOR_VOCAB)

### Reusable Assets
- Phase 52: `INDUSTRY_SECTOR_VOCAB` from `@pa/shared-tags/canonical/industry-sector` — 42 spelled-out values
- Phase 52: `validateCanonicalToken` for `proposedTags` validation
- Phase 52: `validateRelevantTag` + `KNOWN_ABBREVIATIONS` 
- Phase 52: `mergeUserTags` already commits (iter34 H.3b)
- `apps/functions/src/cv-ingest/cv-gate.ts` — gate check (preserve as-is)
- `apps/functions/src/cv-ingest/cv-quota.ts` — quota check (preserve as-is)
- `apps/functions/src/lib/embeddings.ts` — embedding compute (preserve)

### Established Patterns
- Provider interface: `{ apiKey, baseURL?, model, systemPrompt, userText, schemaName, schema, maxRetries, clientFactory? }` → returns `{ rawJson, usage }`
- Zod schemas: import from `zod`, both schema + inferred type exported
- Provider tests: factory injection so tests can mock without booting SDK

### Integration Points
- Phase 53 deps: `@pa/shared-tags` (Phase 52), `@pa/pa-orchestrator` (mergeUserTags lib)
- Phase 53 produces: extended `pa-resume-parser` schema + new Anthropic provider; consumed by cv-ingest CF
- Phase 53 → Phase 54: cv-ingest writes `pa-users.tags` with new fields, Phase 54 adds onboarding-chat hooks for the same fields

</code_context>

<specifics>
## Specific Ideas

- ANTHROPIC_API_KEY: declare via `defineSecret('ANTHROPIC_API_KEY')` in cv-ingest CF; provider gracefully throws retryable error if key undefined (chain proceeds to next tier)
- Tier fallback log: emit `pa.cv_ingest.tier_fallback` event with `{tier, model, retryable, error}` (already pattern in router.ts line 107)
- Sonnet-4-6 model id: `claude-sonnet-4-6` (no date suffix; the alias resolves to current snapshot)
- Anthropic provider uses `messages.create` with `tools` array for structured output (not `messages.create` with raw JSON — proven brittle)
- Streaming NOT enabled (cv-ingest is fire-and-forget, latency tolerant)

</specifics>

<deferred>
## Deferred Ideas

- Multi-language CV parse (out of scope per REQUIREMENTS line 118)
- Per-job CV variant rewriting (REQUIREMENTS line 111 — v2.0)
- Real-time match notifications (REQUIREMENTS line 120 — out of scope)
- Onboarding-chat tag writers (Phase 54)
- Migration script for legacy parsedCandidateResumes (Phase 54)

</deferred>
