# AGENT_PLAN — Experience Extractor (Phase EX1)

**Goal:** introduce a structured experience-extraction primitive that derives
`yearsPerSkill`, `skillRecency`, `titleTrajectory`, `seniorityCurrent`, and
`industryHistory` from existing `pa-users/{uid}.workHistory` so the matching
ranker can reward depth + recency rather than treating skills as a flat
membership set.

**Owner:** PA (this repo). Triggers from wekruit-matching are read-only.

**Status:** designed (this doc). Not yet implemented.

---

## 1. Why

`pa-users` today carries a self-reported `skills: string[]` and a raw
`workHistory: WorkHistoryEntry[]`, but nothing tells the ranker WHICH job
taught WHICH skill. Without that, `yearsPerSkill` collapses to "user
checked Python; show all Python jobs" — a recent grad with 6 months and a
staff engineer with 8 years look identical at retrieval time.

Industry pattern (LinkedIn / Indeed / CareerBuilder public papers): treat
each work-history entry as a structured object with extracted skills,
duration, and an industry guess, then aggregate per-skill years + recency
across entries. Tags stay for precision; experience model carries depth.

## 2. Data flow (顶层)

```
                 ┌─────────────────────────────────────┐
                 │ packages/pa-experience-extractor    │  NEW
                 │                                     │
                 │  extractWorkEntrySkills(input, deps)│   ← single LLM call per entry
                 │   → WorkEntryExtractionOutput       │
                 │                                     │
                 │  deriveExperienceModel(entries[],   │   ← pure function, no I/O
                 │                       claimedSkills)│
                 │   → DerivedExperienceModel          │
                 └────────────┬────────────────────────┘
                              │ called by both:
              ┌───────────────┴────────────────┐
              ▼                                ▼
   ENTRY 1: new resume upload          ENTRY 2: migrate existing pa-users
   (PR-C, separate phase)              (PR-B, this phase)
```

One primitive, two callers — never duplicate.

## 3. Interface contract (TypeScript)

```typescript
// packages/pa-experience-extractor/src/types.ts

export interface WorkEntryExtractionInput {
  entryId: string                 // sha256(uid + index + title + startDate) — idempotency key
  title: string
  company: string
  startDate: string | null        // ISO yyyy-mm-dd or null
  endDate: string | null          // null = current role
  description: string | null
  bullets: string[]
  achievements: string[]
  candidateSkills: string[]       // user.skills — given to LLM as candidate set, NOT enforced
}

export interface WorkEntryExtractionOutput {
  entryId: string                                // echoes input
  extractedSkills: string[]                      // canonical lowercase_snake_case
  durationMonths: number                         // computed pre-LLM; current role → NOW - startDate
  industryGuess: string | null                   // shared-tags industry-sector vocab; null if unsure
  responsibilityLevel:
    | "individual_contributor"
    | "tech_lead"
    | "people_manager"
    | "executive"
    | "unknown"
  confidence: number                             // 0-1 LLM self-report
  llmModel: string                               // "gpt-5.4-nano"
  extractedAt: string                            // ISO
}

export interface DerivedExperienceModel {
  version: "v1"
  yearsTotal: number                             // sum(durationMonths) / 12
  yearsPerSkill: Record<string, number>
  skillRecency: Record<string, string>           // skill → max endDate (or "present")
  titleTrajectory: string[]                      // sorted by startDate asc
  seniorityCurrent:
    | "intern" | "entry_level" | "new_grad"
    | "mid" | "senior" | "staff"
    | "manager" | "director" | "executive"
    | "unknown"
  responsibilityCurrent: WorkEntryExtractionOutput["responsibilityLevel"]
  industryHistory: Record<string, number>        // industry → years
  unverifiedSkills: string[]                     // claimed skills never appearing in any extracted set
  computedAt: string
}
```

## 4. Backward compatibility (non-negotiable)

```
pa-users/{uid}.derivedExperience            OPTIONAL   ← un-migrated users keep working
pa-users/{uid}.derivedExperienceVersion     OPTIONAL   ← used as migration gate

All existing fields unchanged:
  pa-users/{uid}.skills                     UNCHANGED
  pa-users/{uid}.workHistory                UNCHANGED
  pa-users/{uid}.totalYearsExperience       UNCHANGED  (kept; new yearsTotal coexists)

All reader code MUST tolerate undefined:
  const exp = user.derivedExperience ?? null
  if (!exp) { fall back to user.totalYearsExperience or user.skills }
```

No existing reader path breaks. Matching scorer changes (PR-D) are gated
behind a feature flag and explicit null-checks.

## 5. Storage layout

```
pa-users/{uid}                                       (existing — additive)
  ├─ derivedExperience: DerivedExperienceModel        ← NEW
  └─ derivedExperienceVersion: "v1"                   ← NEW

pa-users/{uid}/workEntries/{entryId}                 ← NEW subcollection
  WorkEntryExtractionOutput
  (per-entry cache — idempotency + cheap reruns)
```

`entryId` is a content-stable hash; rerunning the migration on the same
user produces the same `entryId`s and hits cache (no LLM cost).

## 6. LLM contract

```
provider:        OpenAI
model:           gpt-5.4-nano                         (per Adam 2026-05-22)
response_format: json_schema with strict mode
max_tokens:      1500                                 (reasoning + JSON output budget)
temperature:     0
retries:         5x exponential backoff 1s–30s
                 retry on 429 + 5xx only
                 NO retry on 4xx (bad input) or zod parse fail

prompt shape:
  system: "You extract skills from a single work-history entry. ..."
  user:   structured input (title, company, dates, bullets, candidateSkills hint)
  output: WorkEntryExtractionOutput shape (json_schema enforced)

batching:
  one LLM call per workEntry. Don't multiplex multiple entries in one
  prompt — it makes retries + caching much harder for marginal cost savings.
```

## 7. PR breakdown

```
PR-A (foundation):           packages/pa-experience-extractor
  - types.ts                  (3 interfaces above)
  - extract.ts                (LLM call + zod parse + retries + cache check)
  - derive.ts                 (pure aggregation; unit-testable, no I/O)
  - cache.ts                  (Firestore subcollection read/write)
  - prompt.ts                 (system + user prompt builders)
  - __tests__/extract.test.ts (mocks OpenAI client)
  - __tests__/derive.test.ts  (pure function, no mocks)

PR-B (migration, depends on A):
  - apps/functions/scripts/migrate-experience-model.mts
  - flags: --dry-run, --limit N, --resume-from CURSOR, --force-rerun
  - paginated walk of pa-users
  - per-user: fanout entries → cache-or-LLM → derive → writeBack
  - emits stats: total / migrated / skipped_already_v1 / failed
  - safe to ctrl-c; resumes from last cursor

PR-C (resume upload hook, depends on A — separate phase):
  - apps/functions/src/onResumeUploaded.ts (extend existing if present)
  - after parsedResumeData is written, call extractor primitive
  - same write path as migration
  - feature flag: PA_EXPERIENCE_EXTRACTOR_LIVE

PR-D (ranker integration, depends on A/B — future phase):
  - matching/scorer (Postgres side) reads derivedExperience from synced
    pa-users mirror
  - adds yearsFit + skillRecencyBonus signals
  - feature flag: MATCHING_USE_DERIVED_EXPERIENCE
```

## 8. Cost / risk

```
current (Adam 2026-05-22): ~10 pa-users × ~3 entries × 1 LLM call = ~30 calls
  estimated cost: <$0.01 (gpt-5.4-nano)
  estimated time: <1 min

at scale (10K users):     ~30K calls × ~$0.0001 ≈ $3-30 depending on token spend
  estimated time: ~30 min with 16 parallel workers

risk:
  - gpt-5.4-nano availability: confirmed by user 2026-05-22
  - LLM extraction miss rate: ~5-10% (candidate_skills hint mitigates)
  - Firestore writes: subcollection adds 1 doc per work entry — cheap, <10/user
  - schema drift: zod parse + version stamp gate
```

## 9. Acceptance criteria

```
PR-A:
  - unit tests pass with mocked OpenAI
  - derive.ts is pure (passes property-based test: same input → same output)
  - cache.ts demonstrates skip on second call with same entryId

PR-B:
  - dry-run on production reports plausible numbers
  - real run produces derivedExperience on all active pa-users
  - rerun is no-op (skipped_already_v1 == total)
  - inspect 3 random users: yearsPerSkill values match manual sanity
    (Python listed in 2 of 3 work entries → ~67% of yearsTotal)

PR-C:
  - new resume upload writes derivedExperience without manual migration
  - feature flag toggles the path on/off
```

## 10. Out of scope (explicit non-goals)

- Two-sided matching (job → candidate ranking): defer to Phase EX2
- LTR ranking model: defer until ≥10K feedback samples
- Per-skill proficiency level (junior/mid/senior PER skill): defer
- Trajectory model (career path prediction): defer
- Resume re-parse: this plan does NOT re-parse resumes; it derives from
  the already-parsed `parsedResumeData` artifacts

## 11. Open questions (none blocking; surfaced for future tightening)

- Should `seniorityCurrent` override user-self-reported when they conflict?
  → Default: LLM-derived wins, but expose both fields for UI to choose.
- Should the migration also normalize `industryHistory` to closed
  `@wekruit/shared-tags` enum?  → Default: yes, with `_other` fallback.
- Cache TTL — when does an entry become stale?  → Default: never; entryId
  is content-stable, so if title/dates change, a NEW entryId is computed
  and old cache is naturally orphaned (cleanup script in PR-E if needed).
