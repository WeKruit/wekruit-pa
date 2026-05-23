# Experience Extractor — Upstream Integration

How `@pa/pa-experience-extractor` (EX1, see [AGENT_PLAN-experience-extractor.md](../AGENT_PLAN-experience-extractor.md))
fits into the three upstream systems it depends on or interacts with.

This is a reading guide for engineers adding new features that produce
or consume `pa-users/{uid}.derivedExperience`.

## 1. Resume parser (`@pa/pa-resume-parser`)

The extractor consumes the resume parser's output, never reads the
underlying CV text itself.

```
PDF / DOCX / TXT
        │
        ▼
@pa/pa-resume-parser   parseResumeText(...)
        │  (3-tier chain: gpt-5.4-nano → gpt-4.1-mini → gpt-4.1-nano,
        │   structured output, qaBank → Mem0 tag-event coupling)
        ▼
ParsedResumeData {
  skills: string[]
  workHistory: WorkHistoryEntry[]   ← input to experience extractor
  ...
}
        │
        ▼
apps/functions/src/cv-ingest writes
parsedCandidateResumes/{resumeId}
        │
        ▼
Firestore trigger: paExperienceExtractorOnParsedResume (PR-C)
        │
        ▼
@pa/pa-experience-extractor
  - extractWorkEntrySkills(...) per entry  (gpt-5.4-nano, json_schema)
  - deriveExperienceModel(entries, claimedSkills)
        │
        ▼
pa-users/{uid}.derivedExperience: DerivedExperienceModel
pa-users/{uid}/workEntries/{entryId}: WorkEntryExtractionOutput  (cache)
```

### Input contract from the parser

The extractor reads these fields off `parsedCandidateResumes/{resumeId}`:

| Field         | Type       | Used for                              |
|---------------|------------|---------------------------------------|
| `userId`      | string     | scoping pa-users writes                |
| `skills`      | string[]   | `candidateSkills` hint to LLM         |
| `workHistory` | WorkHistoryEntry[] | per-entry LLM input            |

Each `WorkHistoryEntry` from `@pa/pa-resume-parser` carries `title`,
`company`, `startDate`, `endDate`, `description`, `bullets`,
`achievements`. The extractor tolerates missing fields (returns 0
months, empty bullets, etc.) rather than rejecting the row.

### Add-on dependency contract

Anyone adding new parser fields (e.g. `responsibilities[]`,
`technologyStack[]`) should consider:

- **Append-only.** Adding a field is a no-op for the extractor — it
  ignores fields it does not recognize.
- **Rename = break.** Renaming `bullets → responsibilities` would
  silently zero out skill extraction quality. Prefer additive aliases.

## 2. Canonical tagging (`@wekruit/shared-tags` + `paMatchingJobsAutoEnrich`)

**The extractor lives ALONGSIDE the canonical-tag pipeline, not inside
it.** They produce complementary signals; the matching ranker can use
both.

| System                            | Output                                                       | Authority   |
|-----------------------------------|--------------------------------------------------------------|-------------|
| `@pa/pa-job-tag-enricher` + trigger | `matching-jobs.requiredSkills: Skill[]` (bucket+weight), `roleFunction[]`, `industrySector[]`, `seniorityLevel`, `jobType`, `locationBuckets[]` | canonical for matching |
| `@pa/pa-orchestrator/tags/user-tags-writer` | `pa-users.tags.industrySector[]`, `pa-users.tags.relevantTags[]`, `pa-users.tags.skills: Skill[]` (canonical) | canonical for user side |
| `@pa/pa-experience-extractor` (this) | `pa-users.derivedExperience.yearsPerSkill / skillRecency / titleTrajectory / seniorityCurrent / industryHistory` | depth + recency signal |

### Why both

Canonical tags answer **"does this user have this skill?"** Experience
model answers **"how deeply and how recently?"**

For matching ranker (PR-D, future), the intended combination is:

```text
final_score =
  hard_filters_pass
  × (
      0.30 * skill_match               ← canonical Skill[] overlap
    + 0.10 * skill_depth_bonus         ← derivedExperience.yearsPerSkill
    + 0.08 * skill_recency_bonus       ← derivedExperience.skillRecency
    + 0.20 * role_title_similarity     ← canonical roleFunction[]
    + 0.10 * seniority_fit             ← canonical seniorityLevel
    + ...
  )
```

### Skill-string mapping

The extractor emits **lowercase_snake_case free-form** skill strings
(e.g. `"kubernetes"`, `"model_risk_management"`). These are NOT
guaranteed to match canonical `Skill.name` values in
`@wekruit/shared-tags`. Downstream consumers should:

- Use canonical `Skill[]` (from `pa-users.tags.skills`) for hard-filter
  matching.
- Use `derivedExperience.yearsPerSkill` as a per-canonical-skill weight
  lookup, applying a fuzzy match (lowercase + underscore normalization)
  when reconciling.

If a depth value is needed for a canonical skill that does not appear
in `derivedExperience.yearsPerSkill`, treat it as `yearsPerSkill = 0`
(skill is claimed but the work history doesn't evidence it — already
surfaced in `derivedExperience.unverifiedSkills`).

### Idempotency interaction

Both pipelines use their own version stamps:

| System                            | Version field                                    |
|-----------------------------------|--------------------------------------------------|
| `paMatchingJobsAutoEnrich`        | `matching-jobs.enricherVersion`                  |
| `paExperienceExtractorOnParsedResume` | `pa-users.derivedExperienceVersion`            |

They do not interfere. A user can be at `derivedExperienceVersion="v1"`
while their canonical `pa-users.tags` evolves through its own version
bumps.

## 3. Memory system (`@pa/memory`)

The extractor does **not** call `@pa/memory` directly. Two relationships
to be aware of:

### a. `derivedExperience` may seed persona-card / memory snapshots

`@pa/memory/persona-card.ts` exposes `buildPersonaCard()` which composes
a short context snippet for the assistant's system prompt. A downstream
PR may want to include depth-aware summaries like:

> "Senior backend engineer (~5y Python, ~3y Go, current role since
> 2024-01)."

That would call `buildPersonaCardWithVoice({ derivedExperience, ... })`.
The extractor itself stays I/O-free; persona-card composition is the
caller's responsibility.

### b. Memory compaction (`@pa/memory/compaction.ts`) is independent

Mem0 fact compaction snapshots live in `mem-snapshots/{uid}/...`. They
are independent of `derivedExperience` and use their own version /
schema. Compaction does not read or write `pa-users.derivedExperience`.

If a future PR wants to surface yearsPerSkill into the memory factbank
(so the assistant can recall "you said you have 5 years of Python"),
it should:

1. Read `pa-users.derivedExperience` (cheap doc read).
2. Build `CompactedFact[]` entries using
   `@pa/memory/facts.ts::createConfirmedMemoryFact`.
3. Tag each fact with `source: "experience_extractor_v1"` for
   audit / rollback.

Do NOT couple the extractor and memory packages directly — they have
different ownership and lifecycle.

## 4. Reading guide for new features

| Need                                                            | Read from                                       |
|-----------------------------------------------------------------|-------------------------------------------------|
| User's raw declared skills                                      | `pa-users.skills` (legacy)                      |
| User's canonical Skill[] with bucket + weight                   | `pa-users.tags.skills`                          |
| Years of experience per skill                                   | `pa-users.derivedExperience.yearsPerSkill`      |
| When did the user last use Skill X                              | `pa-users.derivedExperience.skillRecency`       |
| Career title trajectory                                         | `pa-users.derivedExperience.titleTrajectory`    |
| Current seniority bucket (intern / mid / senior / staff / ...)  | `pa-users.derivedExperience.seniorityCurrent`   |
| Industry exposure                                               | `pa-users.derivedExperience.industryHistory`    |
| Skills claimed but not evidenced in work history                | `pa-users.derivedExperience.unverifiedSkills`   |
| Canonical industry sector for filtering                         | `pa-users.tags.industrySector[]`                |

## 5. Anti-patterns to avoid

- **Do not read `parsedCandidateResumes` directly for matching.** That
  document is the parser's working artifact; consumers should read
  `pa-users` instead.
- **Do not write to `pa-users.derivedExperience` from anywhere else.**
  Only the extractor (`runExperienceExtractorForUser`) writes it, so
  the version + content-hash idempotency stays meaningful.
- **Do not branch on `derivedExperience` being present.** Treat null /
  undefined as "not yet computed" and fall back to canonical tags or
  `totalYearsExperience` instead of throwing.
- **Do not call the LLM extractor from a request-handling code path.**
  It is designed for the Firestore trigger and the migration script.
  Synchronous request paths should consume the already-written
  `derivedExperience` only.
