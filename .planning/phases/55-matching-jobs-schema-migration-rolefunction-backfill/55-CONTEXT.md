# Phase 55: matching-jobs schema migration + roleFunction backfill - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning
**Mode:** Auto-generated (decisions D1, D2, D9 locked)

<domain>
## Phase Boundary

Firestore `matching-jobs` schema gains `roleFunction: string[]` (closed enum 17 from D1) while retaining `industrySector: string[]` (42 from D2). **Two orthogonal axes.** Deterministic migration backfills 116K+ jobs from legacy `category` (jobright source) → `roleFunction` and `industryKey`/`industryEnum` → `industrySector`. Migration is idempotent + dry-run audit before write.

**REQ-IDs:** MATCH-02 (1)

**In scope:**
- Add Firestore index `matching-jobs.roleFunction` (array-contains-any compatible)
- Migration script `apps/functions/scripts/migrate-matching-jobs-schema.mjs` — DRY-RUN default
- Deterministic mappers in `apps/functions/src/lib/matching-jobs-mappers.ts`:
  - `mapJobrightCategoryToRoleFunction(category: string): RoleFunction[]`
  - `mapLegacyIndustryToCanonical(legacyKey: string): IndustrySector[]`
- TypeScript schema for matching-jobs in `packages/core-types` (extend if exists)
- Audit collection `matching-jobs-migration-audit/{runId}` for DRY-RUN output
- Tests + dry-run on representative sample

**Out of scope:**
- Apply migration to production 116K+ docs (Adam decision via `--apply`)
- queryMatchingJobs consumer (Phase 56)
- Liveness/atsApplyUrl (Phase 57)

</domain>

<decisions>
## Implementation Decisions

### Schema additions (matching-jobs)
- New field: `roleFunction: string[]` — closed enum, multi-value (most jobs have 1, some span e.g. ML+SWE)
- New field: `industrySector: string[]` — closed enum from Phase 52, multi-value
- Retain legacy fields: `category`, `industry`, `industryKey`, `industryEnum` (Phase 56 will read new fields; legacy stays as fallback)
- Add `roleFunctionMigratedAt: string` for idempotency (skip if already migrated)
- Add `industrySectorMigratedAt: string` similarly

### Deterministic mappers (sourced from `wekruit-matching/src/wekruit_matching/scraper/jobright_github.py` REPO_TO_CATEGORY + `enrichment/classifier.py` INDUSTRY_VOCAB)

**`mapJobrightCategoryToRoleFunction`** — input is the legacy `category` field stored on matching-jobs (e.g. `"tech"`, `"data_analytics"`, `"engineering"`, etc — output of REPO_TO_CATEGORY mapping):

```ts
const JOBRIGHT_CATEGORY_TO_ROLE_FUNCTION: Record<string, RoleFunction[]> = {
  tech: ['software_engineering'],
  data_analytics: ['data_analysis'],
  engineering: ['engineering_and_development'],
  product: ['product_management'],
  business: ['business_analyst'],
  design: ['creatives_and_design'],
  consulting: ['consultant'],
  accounting_finance: ['accounting_and_finance'],
  marketing: ['marketing'],
  management: ['management_and_executive'],
  sales: ['sales'],
  human_resources: ['human_resources'],
  legal: ['legal_and_compliance'],
  arts_entertainment: ['arts_and_entertainment'],
  education: ['education_and_training'],
  government: ['public_sector_and_government'],
  customer_service: ['customer_service_and_support'],
  general: [],  // Internship/catch-all — defer to title-regex secondary pass
}
```

If category unknown OR maps to `[]`, run secondary title-regex pass: regex match common titles ("software engineer", "data scientist", "product manager", etc) → RoleFunction.

**`mapLegacyIndustryToCanonical`** — input is legacy `industryKey` or `industryEnum`:

```ts
const LEGACY_INDUSTRY_TO_CANONICAL: Record<string, IndustrySector[]> = {
  tech: ['technology_general'],
  fintech: ['financial_technology'],
  healthtech: ['healthcare_and_life_sciences'],
  healthcare: ['healthcare_and_life_sciences'],
  ecommerce: ['e_commerce_and_retail'],
  enterprise_saas: ['software_and_saas'],
  ai_ml: ['artificial_intelligence_and_machine_learning'],
  cybersecurity: ['cybersecurity'],
  gaming: ['gaming_and_esports'],
  social_media: ['media_and_entertainment'],
  hardware: ['hardware_and_semiconductors'],
  consulting: ['management_consulting'],
  telecom: ['telecommunications'],
  automotive: ['automotive_and_mobility'],
  aerospace_defense: ['aerospace_and_defense'],
  construction: ['construction_and_built_environment'],
  defense: ['aerospace_and_defense'],
  security: ['cybersecurity'],
  manufacturing: ['manufacturing_and_industrial'],
  retail: ['e_commerce_and_retail'],
  media: ['media_and_entertainment'],
  education: ['education_technology'],
  government: ['public_sector_and_government'],
  energy: ['energy_and_utilities'],
  transportation: ['transportation_and_logistics'],
  hospitality: ['hospitality_and_travel'],
  real_estate: ['real_estate_and_proptech'],
  nonprofit: ['non_profit_and_social_impact'],
  legal: ['legal_services'],
  pharma: ['biotechnology_and_pharmaceuticals'],
  banking: ['financial_technology'],
  finance: ['financial_technology'],
  insurance: ['financial_technology'],
  logistics: ['transportation_and_logistics'],
  food_service: ['hospitality_and_travel'],
  agriculture: ['agriculture_and_foodtech'],
  mining: ['manufacturing_and_industrial'],
  utilities: ['energy_and_utilities'],
  other: [],
  unknown: [],
}
```

### Migration script
- Path: `apps/functions/scripts/migrate-matching-jobs-schema.mjs`
- DRY-RUN default → writes to `matching-jobs-migration-audit/{runId}/jobs/{jobId}` with `{ before, after, diff, mapper_used }`
- `--apply` flag actually writes to matching-jobs
- `--limit N` for testing (e.g., 100 first)
- `--status active` filter (skip dead jobs)
- Batch 500/Firestore commit, rate limit 10/sec to avoid hot-spot
- Idempotent: skip if `roleFunctionMigratedAt` set

### Firestore index
- Add to `firestore.indexes.json`:
  ```json
  {
    "collectionGroup": "matching-jobs",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "roleFunction", "arrayConfig": "CONTAINS" },
      { "fieldPath": "firstSeenAt", "order": "DESCENDING" }
    ]
  }
  ```
- Required for Phase 56 query path

### Audit + observability
- `matching-jobs-migration-audit/{runId}` doc shape: `{ runId, startedAt, completedAt?, total, processed, errors[], dryRun, sample[] }`
- Per-job audit: `matching-jobs-migration-audit/{runId}/jobs/{jobId}` with diff
- Dry-run sample logged to console: 5 random before/after pairs

</decisions>

<code_context>
## Existing Code Insights

### Existing matching-jobs schema (live Firestore — query to confirm exact fields)
- Likely fields: `id`, `title`, `company`, `companyUrl`, `applyUrl`, `atsApplyUrl`, `location`, `workModel`, `category` (legacy jobright), `industry`/`industryKey`/`industryEnum` (legacy), `firstSeenAt`, `lastSeenAt`, `status`, `dead`, `embedding`
- Phase 55 ADDS: `roleFunction[]`, `industrySector[]`, `roleFunctionMigratedAt`, `industrySectorMigratedAt`

### Source mapping refs (read first via SSH macmini if needed)
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/scraper/jobright_github.py:75` — REPO_TO_CATEGORY 19→17 mapping
- `~/Desktop/WeKruit/wekruit-matching/src/wekruit_matching/enrichment/classifier.py:31` — INDUSTRY_VOCAB 38 frozenset

These are the source-of-truth for what's already in `matching-jobs.category` and `industryKey`. Mappers read these, output Phase 52 canonical.

### Reusable code
- `apps/functions/src/cv-ingest/industry-tags.ts` — has free-text → 10-bucket map; PARTIAL reusable (the keys overlap with legacy industryKey)
- `apps/functions/src/backfill-ats-urls.ts` — pattern for batch CF script with audit (mirror this structure)
- `packages/shared-tags/src/canonical/role-function.ts` — Phase 52 enum
- `packages/shared-tags/src/canonical/industry-sector.ts` — Phase 52 enum

### Firebase admin pattern (existing scripts)
- `apps/functions/scripts/refresh-adam-cv.mjs` (referenced in STATE) — example of admin SDK init
- `apps/functions/scripts/migrate-pa-users-tags.mjs` — Phase 54 pattern, mirror it

</code_context>

<specifics>
## Specific Ideas

- Run `--limit 100 --dry-run` first → manual audit → `--limit 1000 --dry-run` → eyeball → `--apply --limit 5000` → eyeball → full `--apply`
- Title-regex secondary pass for `general`/unknown categories: regex over `title.toLowerCase()` for keywords (`engineer`, `developer`, `analyst`, `manager`, `designer`, `consultant`, etc) → infer RoleFunction
- Multi-value handling: if title says "Senior Software Engineer / Tech Lead", roleFunction could be `[software_engineering, management_and_executive]`
- INDUSTRY_VOCAB extra entries (banking, finance, insurance) collapse to `financial_technology` — slight loss of fidelity OK for now; future revisit if Adam wants split

</specifics>

<deferred>
## Deferred Ideas

- ML-based title classifier (REQUIREMENTS line 110 — v2.0 SKILL-SIMILARITY-EMBEDDING)
- Cross-repo Python port of mappers (REQUIREMENTS line 106 — v2.0)
- queryMatchingJobs (Phase 56)
- Apply to production (Adam decides via --apply flag)

</deferred>
