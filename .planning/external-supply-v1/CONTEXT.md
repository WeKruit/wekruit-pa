# External Supply V1 — Sprint Context

**Status:** Lead-authored sprint context, 2026-05-13.
**Initiative:** `.planning/INITIATIVE-external-candidate-supply-intake.md`
**Goal prompt:** `.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md` (also Adam's `/loop` input).
**Branch / worktree:** `codex/v2-external-supply-intake` at `.claude/worktrees/v2-external-supply-intake`.
**Base commit:** `0a8b794 feat(v2): add candidate identity claim layer (#25)` (= `origin/main`).

## 1. Why This Sprint Exists

Adam directive (2026-05-13): WeKruit must scale beyond the v1.9 single-funnel candidate journey into a multi-company candidate activation network. Recruiting ops needs an internal V1 to:

1. Import LinkedIn-centered external candidate rows from Juicebox / Lessie / Coresignal exports.
2. Normalize them, resolve identity, create/merge into the shared `pa-users` pool.
3. Evaluate against general + company + job rubrics, produce tiered outreach decisions.
4. Sync approved email leads to Instantly, generate manual LinkedIn outreach tasks.
5. Feed reply / bounce / opt-out / interested outcomes back into PA flywheel data.

External candidates must share the same `pa-users` collection — they are not isolated campaign leads, not Instantly-only, not Excel-only.

## 2. Repo Orientation — Reuse Map

This is the most important section: do **not** duplicate primitives that already shipped in v2.0 S0–S2.

### 2.1 Identity Layer (S2, already shipped at `0a8b794`)

| Already exists | File / Symbol | What we reuse |
|---|---|---|
| LinkedIn handle kind | `packages/core-types/src/marketplace.ts:74-83` `CandidateHandleKindSchema` includes `"linkedin"` | Store canonical LinkedIn URL as a `pa-candidate-handles/{linkedin__<hash>}` doc — primary identity index. |
| Handle doc id pattern | `marketplace.ts:659` `createCandidateHandleId(kind, handleHash)` | Use for LinkedIn handle doc id. |
| Handle value normalization | `marketplace.ts:663-685` `normalizeCandidateHandleValue` | Already lowercases LinkedIn — extend with stricter canonicalization (strip `?utm=`, trailing slash, locale prefix). |
| Hash material | `marketplace.ts:687-692` `candidateHandleHashMaterial(kind, normalizedValue)` | Feed into SHA-256 from `@wekruit/shared-tags/sha256` to derive `handleHash`. |
| Identity resolver | `packages/pa-persistence/src/identity.ts:287` `resolveCandidateIdentity()` | Canonical entry point for find-or-create. We extend, not replace. |
| Self-claim | `packages/pa-persistence/src/identity.ts:462` `claimCandidateProfile()` | Not used by external supply (no Firebase Auth for sourced candidates) — keep untouched. |
| Conflict record | `marketplace.ts:251-271` `CandidateIdentityConflictSchema` | Extend `IdentityConflictKindSchema` to add `"linkedin_email_candidate_mismatch"` and `"external_fuzzy_match"`. |
| Identity audit event | `marketplace.ts:225-241` `CandidateIdentityEventSchema` | Extend `IdentityEventTypeSchema` to add `"external_source_linked"` and `"external_candidate_imported"`. |
| Resolution outcome | `marketplace.ts:273-289` `CandidateIdentityResolutionSchema` discriminated union (`resolved_existing` / `created` / `identity_conflict`) | Map V1 initiative statuses to this shape: `create_new` -> `created`, `merge_existing` -> `resolved_existing`, `needs_review` -> `identity_conflict`. `blocked` is a new external-supply-specific terminal that we'll surface in the import record, not in the resolver. |

### 2.2 Profile Layer (S1, already shipped)

| Already exists | What we reuse |
|---|---|
| `CandidateProfile.linkedinUrl` (`marketplace.ts:143`) | Lift LinkedIn URL onto profile from primary handle when created via external sourcing. |
| `CandidateGlobalTagsSchema` (`marketplace.ts:104-131`) | Write external-sourced tags into the same `globalTags` shape. Honor existing source/confidence/version pattern via `mergeUserTags`. |
| `pa-users` (`pa-users`) | Single source of truth — external supply writes here through `resolveCandidateIdentity` only. |
| `pa-candidate-handles` | Use for LinkedIn AND email lookup. No separate `pa-candidate-identity-index` collection needed. |
| `pa-resume-artifacts` | If Juicebox/Lessie ever surface resume PDFs (rare in V1), reuse this collection. |
| Lifecycle reducer (`marketplace.ts:518-579`) | External-supply path emits `profile_created` then `handle_linked` events through reducer. Never bypass. |

### 2.3 Marketplace Evidence Pattern

| Already exists | Extension required |
|---|---|
| `MarketplaceEvidenceSchema.source` (`marketplace.ts:55-71`) currently: `resume_parse / conversation / job_match / outbound_delivery / prescreen / admin / ats / system / llm_infer` | **Extend** with: `"external_sourcing"`, `"agent_research"`, `"instantly_delivery"`. |
| `CandidateHandleSourceSchema` (`marketplace.ts:85-93`) currently: `candidate / resume / ats / sendblue / admin / system` | **Extend** with: `"external_sourcing"` (one umbrella value — finer-grained Juicebox/Lessie/Coresignal goes on the source-link record, not the handle). |

### 2.4 Tagging

- `packages/shared-tags/` — canonical vocab and `mergeUserTags` helper.
- `packages/shared-tags/src/sha256.ts` — already used for handle hashing.
- External enrichment writes only into `globalTags` and never overwrites stronger existing values. The rule is documented in `CLAUDE.md` v1.6 lock #8 (`mergeUserTags()` sole writer); external supply must respect that.

### 2.5 Resume Parsing

- `apps/functions/src/cv-ingest/` and `packages/pa-resume-parser/` exist for resume parsing.
- External supply V1 does **not** parse resumes (Juicebox / Lessie / Coresignal already ship structured fields). Only `experience` / `education` arrays land on `ExternalCandidateRecord` and on `pa-users.globalTags` via `mergeUserTags`. No parser invocation in V1.

### 2.6 Outbound Layer

- Existing: `pa-outbound`, `pa-outbound-invites`, `apps/functions/src/sendblue` — these are iMessage / SMS outbound for retained PA candidates.
- External supply V1 **does not** reuse Sendblue for email outreach. Email goes to Instantly. Manual LinkedIn outreach stays as in-dashboard task records.
- We keep external email outreach separate: new `pa-outreach-plans` and `pa-outreach-events` collections so iMessage / Sendblue flow stays untouched.

### 2.7 Dashboard

- `apps/dashboard-web` is the admin SPA on `wekruit-pa.web.app`. Existing pattern: routes under `/admin/**`, Google sign-in `@wekruit.com` only.
- We add a new internal section `/admin/external-supply/...` with sub-routes per pipeline step. **Never** put external-supply routes on `candidate.wekruit.com` — domain split is locked.

## 3. New Collections This Initiative Creates

All `pa-*` namespaced for shared Firebase project `wekruit-5f89b`. All keep their first-class `collectionId`, `createdAt`, `updatedAt`, `evidence[]` fields.

| Collection | Purpose |
|---|---|
| `pa-external-sourcing-batches` | One import batch (Juicebox / Lessie / Coresignal export). Owns rowCount + valid/duplicate/needsReview/readyToProfile stats + rawFileRef + normalizerVersion. |
| `pa-external-candidate-records` | One normalized source row before/after identity resolution. Holds rawPayload + canonicalLinkedInUrl + linkedinProfileHash + emails + identityResolutionStatus + resolvedUserId. |
| `pa-candidate-source-links` | Auditable link between a `pa-users` profile and an external source record. Belongs alongside `pa-candidate-handles` but carries `batchId` / `source` / `confidence` / `evidence` provenance. |
| `pa-candidate-evaluation-runs` | One evaluation pass for one company / job over a candidate set. Owns rubricVersion + runMeta + completion stats. |
| `pa-candidate-company-job-evaluations` | Per-candidate-per-job evaluation output — hard gates, soft score, missing info, risks, evidence, proposed tier, reviewer decision. |
| `pa-agent-research-tasks` | ChatGPT Agent Mode prompt + structured findings record. Findings need human approval before they affect tier. |
| `pa-outreach-plans` | One outreach plan per candidate / job — tier, channel, personalizedHook, whyThisRole, whyCompany, emailSubject/Body, linkedinMessage. |
| `pa-instantly-sync-records` | Tracks Instantly leadId / campaignId / listId / syncStatus / lastSyncedAt / error / dryRun flag. |
| `pa-outreach-events` | Reply / bounce / unsubscribe / interested events from Instantly + manual LinkedIn task status. Idempotent by `(provider, providerEventId)`. |
| `pa-source-quality-metrics` (optional) | Per-source rolling stats: validRate, duplicateRate, identityConflictRate, replyRate, bounceRate, conversionToFirstInterview. |

## 4. Non-Negotiable Rules Inherited

Locked from `CLAUDE.md`, `AGENTS.md`, `README.md`, the milestone roadmap, and this initiative:

1. Candidate is the durable global asset. Company/job is demand context.
2. External candidates share `pa-users`. No parallel candidate database.
3. LinkedIn URL is primary external source identity handle. Email is secondary signal.
4. Email-only rows MAY be imported but MUST NOT auto-create profiles in V1 (goes to review).
5. LinkedIn vs email conflict → `needs_review` (`identity_conflict`).
6. Fuzzy name / company / school matches → `needs_review`, never auto-merge.
7. Raw LinkedIn URL / email / phone NEVER used as Firestore doc id.
8. Tags written through `mergeUserTags`; never overwrite stronger existing facts.
9. Opt-out, bounce, cooldown, duplicate suppression gate every Instantly sync.
10. LinkedIn sending is manual — generate task/message only, never automate.
11. Match score does not block first interview — Claire interviews regardless of tier.
12. Dashboard is internal-only (`wekruit-pa.web.app/admin/**`).
13. Domain split locked: never put external-supply routes on candidate domain.
14. Every tag/fact written to `pa-users` carries source / confidence / evidence / version.

## 5. Out Of Scope For V1

- Live LinkedIn automation (sending, accepting connections).
- Employer-visible external-supply pages.
- Daily / scheduled auto-imports — V1 is operator-triggered batch import.
- Re-architecting matching / `generateJobRecs` — evaluation runs piggy-back on existing match score where available, but the rubric engine is new and lives alongside `apps/job-rec`, not inside it.
- Building a second LinkedIn URL canonicalizer in the Python `wekruit-scraping` repo — TS canonicalizer lives in `packages/shared-tags` and is the only one we touch in V1.
- Live outbound to non-test recipients (gated behind explicit operator approval + env flag).

## 6. Current Repo State

- Branch: `codex/v2-external-supply-intake` (new, off `origin/main` at `0a8b794`).
- Working tree dirty at start of sprint: copied in `INITIATIVE-external-candidate-supply-intake.md`, `V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md`, plus `CLAUDE.md` / `AGENTS.md` / `README.md` with the v2.0 product lock and external-supply paragraphs that are not yet in `origin/main`. These are Adam-authored docs; we commit them as the first sprint commit so the new branch carries the authoritative product memory.
- Other repo dirty files on the main worktree (`apps/pa-landing/src/lib/firebase.ts`, `package.json` deltas, new `Login.tsx` / `Me.tsx`) are not part of this initiative and stay on the main worktree.
- v1.9 + S0–S2 tests assumed green from prior PRs (#23 / #24 / #25). We do not re-run them as part of this sprint, but acceptance includes a v1.9 regression check.

## 7. Acceptance Posture

Acceptance defined in `ACCEPTANCE.md` (this sprint dir). Highlights:

- 100+ mixed external fixture imports successfully.
- LinkedIn-anchored auto create/merge works; email-only stays in review.
- Tier 1 / 2 / 3 / retain-only / blocked all produce expected payload shape.
- Instantly dry-run + live mode both implemented; live mode gated behind config.
- Reply / bounce / opt-out events flow back into PA.
- Dashboard supports the full operator path (import → resolve → evaluate → research → outreach → sync → outcome) without terminal-only steps.
- All work under disjoint executor write scopes; lead integrates A's contracts first.
