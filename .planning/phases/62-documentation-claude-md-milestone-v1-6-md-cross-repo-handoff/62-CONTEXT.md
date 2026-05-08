# Phase 62: Documentation + cross-repo handoff - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (`eab4e63`). Verified: [.planning/v1.6-MILESTONE-AUDIT.md](../../v1.6-MILESTONE-AUDIT.md).
**Mode:** Final phase, decisions trivial (just write docs)

<domain>
## Phase Boundary

Capture v1.6 architecture, vocab tables, match flow, and ship state in 4 doc files. Cross-repo handoff to wekruit-scraping.

**REQ-IDs:** DOC-01, DOC-02, DOC-03, DOC-04 (4)

**In scope:**
- DOC-01: `CLAUDE.md` updated with v1.6 design lock summary (already partial — finalize)
- DOC-02: `.planning/MILESTONE-v1.6-unified-tags.md` — full architecture diagram + vocab table + match flow + measurement protocol
- DOC-03: `packages/shared-tags/README.md` — v1.6 vocab additions + sandbox-promotion pattern + cross-repo notes
- DOC-04: `wekruit-scraping/WEKRUIT_PA_TAG_HANDOFF.md` — cross-repo coordination doc (no code change in scraping)

**Out of scope:**
- Lifecycle (audit → complete → cleanup) — separate skill invocation

</domain>

<decisions>
## Implementation Decisions

### CLAUDE.md updates (DOC-01)
- Already has v1.6 Design Lock section (D1-D16, two orthogonal axes, match flow). Finalize:
  - Update "Cross-repo state" with macmini Stage 2.5 hotfix path (Phase 57 finding)
  - Add "v1.6 ship state" subsection: phases shipped + commit shas + open Adam-actions
  - Update LLM chain table with Anthropic note (graceful fallthrough until key set)

### MILESTONE-v1.6-unified-tags.md (DOC-02)
New file at `.planning/MILESTONE-v1.6-unified-tags.md`:
- Architecture diagram (mermaid) showing flow: cv-ingest → mergeUserTags → pa-users.tags → queryMatchingJobsV16 → match output
- Full vocab table for all 9 axes with counts
- Match flow ASCII art (filter chain + score weights)
- Measurement protocol: how QA evaluator weekly runs + ship gate criteria
- Phase 52-62 changelog with shas
- Open issues + v1.7 roadmap pointers

### shared-tags/README.md (DOC-03)
Update `packages/shared-tags/README.md`:
- v1.6 vocab additions (Phase 52: 9 canonical axes)
- Sandbox-promotion pattern docs
- Browser-safe export (Phase 59 finding)
- Cross-repo notes: Python port (deferred v2.0)

### Cross-repo handoff (DOC-04)
SSH `wekruit-mini` to access wekruit-scraping repo. Write `WEKRUIT_PA_TAG_HANDOFF.md` at `~/Desktop/WeKruit/wekruit-scraping/`:
- v1.6 milestone summary (what changed in wekruit-pa)
- 9 canonical axes + how scraping currently maps (REPO_TO_CATEGORY, INDUSTRY_VOCAB)
- Eventual port plan for v2.0: Python equivalents in scraping repo
- Migration script Phase 55 + the 38→42 industrySector vocab extension
- Macmini Stage 2.5 status (Supabase pooler hangs, SKIP_URL_RESOLUTION=1 hotfix permanent until v1.7)
- Contact + flow: scraping team owns ingestion, wekruit-pa owns canonicalization + matching

</decisions>

<code_context>
## Existing Code Insights

### Files to update
- `/Users/adam/Desktop/WeKruit/wekruit-pa/CLAUDE.md` — already has v1.6 section, augment
- `/Users/adam/Desktop/WeKruit/wekruit-pa/packages/shared-tags/README.md` — read first to mirror existing tone

### Files to create
- `/Users/adam/Desktop/WeKruit/wekruit-pa/.planning/MILESTONE-v1.6-unified-tags.md`
- `~/Desktop/WeKruit/wekruit-scraping/WEKRUIT_PA_TAG_HANDOFF.md` (on macmini via SSH)

### Phase summary references (commits)
- P52 `5d1c603` — vocab foundation
- P53 `3209bc5` — pa-resume-parser v2 + Anthropic
- P54 `d693f81` — onboarding hooks + cv-confirm + migration
- P55 `5e74248` — matching-jobs schema + roleFunction backfill
- P56 `6adb9b8` — queryMatchingJobsV16
- P57 `57c182b` — liveness sweep + macmini probe
- P58 `463bcdb` — nightly rerank
- P59 `661a039` — dashboards
- P60 `7499a1b` — dev triggers + V16 cutover
- P61 `12a5934` — QA evaluator weekly

</code_context>

<specifics>
## Specific Ideas

- Mermaid diagram in MILESTONE doc using triple-backtick mermaid block
- Vocab table format: per axis, list count + sample 5 values + "see packages/shared-tags/src/canonical/X.ts"
- Cross-repo handoff: include scp command Adam can use to refresh

</specifics>

<deferred>
## Deferred Ideas

- Architecture decision records (v1.7)
- Auto-generated vocab docs (v1.7)

</deferred>
