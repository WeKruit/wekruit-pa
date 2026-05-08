# Phase 52: Canonical Tag Vocab Foundation - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (`5d1c603`). Verified: [.planning/v1.6-MILESTONE-AUDIT.md](../../v1.6-MILESTONE-AUDIT.md).
**Mode:** Auto-generated (decisions D1-D16 locked in CLAUDE.md, smart-discuss skipped per directive)

<domain>
## Phase Boundary

Extend `packages/shared-tags` with all 10 canonical axes — `roleFunction` 17 / `industrySector` 42 / `major` 45 / `visa` 4 / `jobType` 10 / `careerStage` 13 / `location` 130+ / `relevantTags` open-vocab / `skills` bucketed open-vocab + per-skill weight / sandbox-promote pattern. **All values spelled out, zero abbreviations** (D5). Zod write-time validation. Firestore overlay (sandbox + promote-to-canonical) for industrySector.

**In scope:**
- TypeScript vocab files under `packages/shared-tags/src/canonical/`
- Zod schemas + write-time validation
- Firestore overlay schema (sandbox `proposedTags` → `pa-canonical-tags/{vocab}/{token}` promote)
- `mergeUserTags` extension for new axes
- Unit tests covering all vocabs + zod rejection of abbreviations

**Out of scope:**
- Cross-repo Python port (deferred to v2.0 per REQUIREMENTS line 106)
- Dashboard UI (Phase 59)
- Match query consumer (Phase 56)

</domain>

<decisions>
## Implementation Decisions

### Vocab File Organization
- One file per axis under `packages/shared-tags/src/canonical/{axis}.ts` — readable + grep-friendly
- Each file exports `const X_VOCAB = [...] as const`, `type X = (typeof X_VOCAB)[number]`, and `XSchema = z.enum(X_VOCAB)`
- Re-export from `packages/shared-tags/src/index.ts`

### roleFunction (D1, TAG-01)
- Closed enum, 17 values verbatim from jobright `utm_campaign`
- `software_engineering`, `engineering_and_development`, `data_analysis`, `product_management`, `business_analyst`, `creatives_and_design`, `consultant`, `accounting_and_finance`, `marketing`, `management_and_executive`, `sales`, `human_resources`, `legal_and_compliance`, `arts_and_entertainment`, `education_and_training`, `public_sector_and_government`, `customer_service_and_support`
- Multi-pick allowed on user side (`tags.targetRoleFunction: RoleFunction[]`)
- Hard filter axis on match (D9, MATCH-03)

### industrySector (D2, TAG-02, TAG-11)
- Closed enum starts at 42 spelled-out values, **add-able by admin** via Firestore overlay sandbox→promote
- Includes `crypto_web3_blockchain`, `gaming_and_esports`, `artificial_intelligence_and_machine_learning`, `accessibility_and_assistive_technology`, plus 38 from `wekruit-scraping` `INDUSTRY_VOCAB` (port verbatim)
- Soft score axis on match (D9, MATCH-05)
- Runtime resolver: `resolveIndustrySectorVocab()` reads static enum + merges Firestore `pa-canonical-tags/industry-sector/{token}` overlay

### major (D3, TAG-03)
- Closed enum 45+ spelled-out values — `computer_science`, `electrical_engineering`, `mechanical_engineering`, etc.
- **Soft score signal, NOT hard filter** (SWE candidates have varied majors)

### visa (D4, TAG-04)
- Exactly 4 enum: `citizen` / `permanent_resident` / `sponsor_needed` / `other`
- OPT/CPT/H1B all collapse to `sponsor_needed` (do NOT split per D4)
- Hard filter axis (MATCH-04)

### jobType (D-derived, TAG-05)
- 10 spelled-out: `full_time`, `internship`, `new_graduate`, `contract`, `part_time`, `fellowship`, `apprenticeship`, `freelance`, `return_to_work_program`, `co_op_rotation`
- Hard filter exact match

### careerStage (TAG-06)
- 13 spelled-out (e.g., `student`, `intern`, `entry_level`, `junior`, `mid_level`, `senior`, `staff`, `principal`, `manager`, `director`, `vp`, `c_level`, `founder`)
- Hard filter window (e.g., `entry_level` user matches `entry_level` + `junior` jobs)

### location (TAG-07)
- 130+ spelled-out values, US/CA/EU/APAC/LATAM/MEA + remote variants
- Examples: `san_francisco_bay_area`, `new_york_metro`, `boston_massachusetts`, `remote_united_states`, `remote_global`, `singapore`, `london_united_kingdom`
- Hard filter intersect with `anywhere` bypass

### relevantTags (TAG-08, D6)
- Open-vocab sandbox, max 12 per profile
- Pattern: `^[a-z][a-z0-9_]{1,79}$` (lowercase, underscore-separated, 2-80 chars)
- Parse-time extracted by pa-resume-parser v2 (Phase 53)
- Soft score on match (D9, MATCH-05 weight 0.15)

### skills (TAG-09, D7)
- Bucketed open-vocab in 10 buckets: `programming_languages`, `frameworks_and_libraries`, `databases`, `cloud_and_infrastructure`, `devops_and_tooling`, `data_and_ml`, `design_and_ux`, `product_and_business`, `soft_skills`, `domain_specific`
- Per-skill object: `{ name, bucket, proficiency, evidenceCount, baseWeight }`
- `name` lowercase, no abbreviations (`python` not `py`, `kubernetes` not `k8s`)
- `baseWeight` global static (Phase 52); JD-relative weight applied at match time (Phase 58)
- Full list written to `tags.skills` (do NOT truncate to top 12 per D7 anti-pattern)

### Validation (TAG-12, D5)
- Zod schemas reject:
  - Spaces (`software engineering` → reject, must be `software_engineering`)
  - Abbreviations heuristic: any token ≤3 chars OR matching abbreviation list (`swe`, `pm`, `sf`, `nyc`, `k8s`, `js`, `ts`, `py`)
  - Uppercase (must be lowercase + underscore only)
- Reject error includes "use spelled-out form, not abbreviation" guidance for LLM consumers

### Firestore Overlay Schema (TAG-11, D16)
- Collection: `pa-canonical-tags`
- Doc path: `pa-canonical-tags/{vocab}/tokens/{token}`
  - `{vocab}` = one of `industry-sector` | `relevant-tags-promotion-candidates`
  - `{token}` = lowercase + underscore form
- Doc shape: `{ token, status: 'sandbox'|'promoted'|'rejected', proposedBy, proposedAt, evidence: { rawText, source, sourceDocId }[], promotedAt?, promotedBy?, count }`
- Resolver function: `resolveCanonicalVocab(vocabName, db?)` — returns merged static + promoted

### mergeUserTags Extension
- Existing `packages/pa-orchestrator/src/tags/user-tags-merger.ts` (commit `253ce87`) extends to validate against new schemas
- New writers (cv-ingest in Phase 53, onboarding hooks in Phase 54) use `mergeUserTags` exclusively (USER-TAG-05)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/shared-tags/src/types.ts` — has `TAG_TYPES` 10-event taxonomy (orthogonal to per-axis vocab — keep both)
- `packages/shared-tags/src/schemas.ts` — has zod for `pa-canonical-tags`, `pa-tag-events`, `pa-entity-tags` (event system, KEEP — different from per-axis vocab Phase 52 adds)
- `packages/shared-tags/src/sha256.ts` — sha256 idempotency-key helper, reuse if needed
- `packages/shared-tags/src/record-tag-event.ts` — event writer
- `packages/pa-orchestrator/src/tags/user-tags-merger.ts` — `mergeUserTags()` lib (commit `253ce87`), sole writer for `pa-users.tags`
- `wekruit-scraping/src/wekruit_matching/enrichment/classifier.py` — `INDUSTRY_VOCAB` 38 frozenset (port verbatim, add 4 to reach 42)
- `wekruit-scraping/src/wekruit_matching/scraper/jobright_github.py` — `REPO_TO_CATEGORY` 17 (port to roleFunction verbatim)

### Established Patterns
- Zod schemas: import from `zod` package, export both schema and inferred type
- Schema versioning: `SchemaVersionSchema = z.literal('v1')` for forward-compat
- Frozen enums: `as const` arrays + `(typeof X)[number]` type pattern (mirrors existing TAG_TYPES)
- Firestore collection naming: kebab-case (`pa-users`, `matching-jobs`, `pa-canonical-tags`)

### Integration Points
- New `canonical/` subdir under `packages/shared-tags/src/`
- `index.ts` re-exports
- Consumers will be: Phase 53 (pa-resume-parser), Phase 54 (cv-ingest writer), Phase 56 (queryMatchingJobs), Phase 59 (dashboards)
- No Firestore migration needed Phase 52 — overlay collection created lazily on first promote

</code_context>

<specifics>
## Specific Ideas

- File naming: kebab-case files, PascalCase types — `canonical/role-function.ts` exports `RoleFunctionSchema` and `RoleFunction` type
- Provide `ALL_CANONICAL_VOCABS` registry for dashboard enumeration (DASH-01 Phase 59)
- Provide helper `validateCanonicalToken(value, vocab)` for runtime validation in mergeUserTags
- Provide CLI test seed: `packages/shared-tags/scripts/dump-vocabs.mjs` lists all values per axis (useful for QA)

</specifics>

<deferred>
## Deferred Ideas

- Cross-repo Python port (REQUIREMENTS deferred to v2.0)
- Recruiter agent tag extension (REQUIREMENTS deferred to v2.0)
- Skill similarity embedding for `python` ≈ `pyspark` clustering (REQUIREMENTS deferred to v2.0)
- Multi-language CV parse (out of scope per REQUIREMENTS line 118)

</deferred>
