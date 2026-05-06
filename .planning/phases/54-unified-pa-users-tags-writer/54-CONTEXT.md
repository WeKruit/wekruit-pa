# Phase 54: Unified pa-users.tags writer - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Auto-generated (decisions D8, D12 locked, smart-discuss skipped)

<domain>
## Phase Boundary

Every user has unified `pa-users/{userId}.tags` document with full canonical schema (Phase 52 schema). cv-ingest already partially writes (Phase 53). Phase 54 finishes:
1. Onboarding chat answer hooks write `tags.targetRole` / `tags.yoeRange` / `tags.visaStatus` / `tags.prefersStartup` / `tags.targetLocations` / `tags.preferredLang` / `tags.lastUpdatedFromChat`
2. Migration script ports 100+ existing users from fragmented data
3. Verify `mergeUserTags()` is sole writer (no direct writes elsewhere)
4. CV-confirm reply parser updates tags on user correction

**REQ-IDs:** USER-TAG-01..USER-TAG-05 (5)

**In scope:**
- Onboarding chat tag writers — hooks into existing onboarding.ts answer collection
- CV-confirm reply parser (Phase 53 left this for Phase 54): when user replies to `out-cvconfirm-{resumeId}`, parse correction text, call mergeUserTags
- Migration script `apps/functions/scripts/migrate-pa-users-tags.mjs` (or `tools/migration/`) — ports existing user fragments into `pa-users.tags`
- Audit: grep for any direct `pa-users.tags` writes outside `mergeUserTags`, refactor or fail-test
- Tests + dry-run migration on production data (read-only audit)

**Out of scope:**
- Apply migration to production (Adam-decision; subagent runs DRY-RUN, posts summary, Adam approves write)
- Match query consumer (Phase 56)
- Dashboard tag-view page (Phase 59)

</domain>

<decisions>
## Implementation Decisions

### Onboarding chat hooks (USER-TAG-03)
- Existing `packages/pa-orchestrator/src/onboarding.ts` collects answers to onboarding questions
- Add tag-writer hooks at answer-completion points:
  - `targetRole` from "What role are you targeting?" (free-text → soft normalize via roleFunction enum match)
  - `yoeRange` from "How many years of experience?" (number → bucket: `0-1` / `2-3` / `4-6` / `7-10` / `10+`)
  - `visaStatus` from "What's your work auth?" (4-enum mapping with abbreviation collapse)
  - `prefersStartup` from "Big co or startup?" (boolean)
  - `targetLocations` from "Where do you want to work?" (intersect with location enum)
  - `preferredLang` from detected reply lang (zh|en|mixed)
- Each hook calls `mergeUserTags(db, userId, { targetRole: ..., yoeRange: ..., ..., lastUpdatedFromChat: now })`
- Fail-open: tag write error must not block onboarding continuation

### CV-confirm reply parser (extends Phase 53 PARSE-07)
- New file `apps/functions/src/cv-ingest/cv-confirm-reply.ts`
- Triggered by sendblue webhook detecting `replyToMessageId` matching pattern `out-cvconfirm-{resumeId}`
- Parses correction text via gpt-5.4-nano (or gpt-4.1-mini fallback) with schema:
  ```ts
  z.object({
    correctedSkills: z.array(z.string()).optional(),
    correctedIndustries: z.array(z.string()).optional(),
    correctedRoles: z.array(z.string()).optional(),
    confirmAccepted: z.boolean(),  // user said "对" / "yes" / variant
    correctionFreeform: z.string().nullable(),
  })
  ```
- If `confirmAccepted === false`, calls `mergeUserTags` with corrected fields
- If `confirmAccepted === true` (no corrections), no-op tag write but logs `cv_confirm.accepted` for telemetry

### Migration script (USER-TAG-04)
- Path: `apps/functions/scripts/migrate-pa-users-tags.mjs`
- Reads existing `pa-users` collection, for each user:
  - Read `parsedCandidateResumes` latest doc → extract skills, industries, etc
  - Read `pa-users.statedPreferences` (legacy field if present) → extract targetRole, yoeRange
  - Read `pa-users.industryTags` (legacy) → map to `industrySector` via canonical Phase 52
  - Compose `UserTagsCvInput` + `UserTagsChatInput`
  - Call `mergeUserTags(db, userId, ...)` — IDEMPOTENT (running twice produces same result)
- Default mode: DRY-RUN (writes to `pa-users-tags-migration-audit/{userId}` audit collection, NOT pa-users)
- `--apply` flag actually writes to `pa-users.tags`
- `--user <uid>` flag for single-user testing
- `--limit N` for testing
- Output: per-user diff, total count, pass/fail breakdown

### Sole-writer audit (USER-TAG-05)
- Run `grep -rn "pa-users.*\.tags\|pa-users.*tags\." apps/functions/src/ packages/pa-orchestrator/src/`
- Any direct `.update({ tags: ... })` or `.set({ tags: ... }, { merge: true })` to pa-users that ISN'T inside `mergeUserTags()` → refactor to use mergeUserTags
- Add lint rule or runtime guard: mergeUserTags throws if called with empty input (sanity)
- Add ts-eslint rule (if eslint configured) or test asserting only mergeUserTags writes

### USER-TAG-01: every user has tags doc
- Migration script (USER-TAG-04) ensures this
- New cv-ingest run ensures this for new users (Phase 53)
- Onboarding hooks ensure this for users without CV (Phase 54)
- Audit: count `pa-users` docs vs `pa-users` docs with `tags` field present — surface gaps to admin via `/admin/users` page (Phase 59 scope) or migration audit collection

</decisions>

<code_context>
## Existing Code Insights

### Sole writer pattern (already established)
- `packages/pa-orchestrator/src/tags/user-tags-merger.ts` — `mergeUserTags()` lib (commit `253ce87`)
- Phase 53 extended `UserTagsSchema` + `UserTagsCvInput` with relevantIndustry/relevantSpecialization/proposedTags/embedding

### Files to extend
- `packages/pa-orchestrator/src/onboarding.ts` — add tag-writer hooks (read first to find answer-completion callsite)
- `apps/functions/src/sendblue/webhook.ts` — add reply detection for cv-confirm pattern (read first to find inbound message handler)

### Migration sources to read
- `pa-users.statedPreferences` (legacy, contains targetRole + yoeRange + work_auth)
- `pa-users.industryTags` (legacy 10-bucket)
- `parsedCandidateResumes/{auto-id}` latest per userId
- `pa-onboarding-answers/{userId}` (if exists)

### Reusable Phase 52 helpers
- `INDUSTRY_SECTOR_VOCAB` for industry mapping
- `ROLE_FUNCTION_VOCAB` for role-function intersect
- `VISA_VOCAB` for 4-enum visa
- `validateCanonicalToken` for runtime validation

### Existing cv-ingest call (Phase 53)
- `mergeUserTags` already wired post-parse with correct field set (USER-TAG-02 done)

</code_context>

<specifics>
## Specific Ideas

- Migration script must be IDEMPOTENT — running twice on same data produces same `pa-users.tags`
- DRY-RUN must produce a diff report so Adam can audit before `--apply`
- yoeRange buckets: `0-1`, `2-3`, `4-6`, `7-10`, `10+` (literal strings)
- preferredLang detection: count zh chars vs ascii words in last 5 user messages, threshold 50% zh → `zh`, mixed → `mixed`
- targetLocations parsing: regex extract city names + match against LOCATION_VOCAB Phase 52, soft fuzzy (e.g., "SF" → "san_francisco_bay_area")

</specifics>

<deferred>
## Deferred Ideas

- Multi-resume per user (REQUIREMENTS line 111 — v2.0)
- UK/EU/non-NA visa types (REQUIREMENTS line 117 — out of scope)
- Real-time tag-event stream to Mem0 (existing iter30 WS2 already handles)
- Apply migration in production (Adam decides; this phase ships dry-run only)

</deferred>
