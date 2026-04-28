# Phase 25 — PLAN (P8 execution, post-24.5)

**Topology:** 3 sub-tasks, serial in single P8.
**Spawn condition:** Phase 24.5 SUMMARY.md committed + acceptance gate green.

## Sub-task breakdown

### T1: Voice review schema + Firestore writes + persistence helper
**Files:**
- `packages/pa-persistence/src/voice-reviews.ts` (new — typed write/list helpers)
- `packages/pa-persistence/src/voice-reviews.test.ts` (new — schema validation + agentSnapshot denorm)
- `packages/pa-persistence/src/index.ts` (export only)

Deliverables:
- `writeVoiceReview(db, { messageId, rating, tags, comment, reviewerId, agentSnapshot })` — single Firestore write to `pa_voice_reviews/{messageId}` with `createdAt: serverTimestamp()`
- `listVoiceReviews(db, { sinceTs?, ratingMax?, ratingMin?, limit? })` — paginated query (used by Phase 27 read consumer)
- `listAssistantTurnsForReview(db, { cursor?, limit? })` — joins `pa_messages` (role=assistant) with existing `pa_voice_reviews` (LEFT) so UI can show reviewed/unreviewed state per turn

DONE:
- `npm run test --workspace=@pa/pa-persistence`
- `npm run typecheck --workspace=@pa/pa-persistence`
- Schema test asserts all 6 fields present + tag enum strict

Commit: `feat(25/T1): pa_voice_reviews schema + persistence helpers (P9-Voice)`

### T2: Voice.tsx page + keyboard UX + nav route
**Files:**
- `apps/dashboard-web/src/pages/Voice.tsx` (new)
- `apps/dashboard-web/src/lib/voice-reviews-api.ts` (new — wraps T1 helpers via callable functions or direct firestore client per dashboard pattern)
- `apps/dashboard-web/src/App.tsx` (add `/voice` route + nav link "Voice")

Deliverables:
- List 50 assistant turns/page, sorted by `createdAt desc`, with prev/next pagination
- Per-row UI: turn text + user prior turn (context) + 5 star buttons + tag chip multi-select + comment input + Save button + green/red badge if already reviewed
- Keyboard: focus management — j/k navigate rows, 1-5 set rating on focused row, t opens tag picker, c focuses comment, Enter saves+jumps next unreviewed row
- localStorage draft: in-flight rating/tags/comment persist on page reload (per messageId key)
- High rating (≥4) = green left border; low rating (≤2) = orange left border

DONE:
- `npm run build --workspace=@pa/dashboard-web`
- `npm run typecheck --workspace=@pa/dashboard-web`
- Manual smoke (Adam post-deploy): open /voice, rate 5 turns with keys, refresh — drafts persist, saved entries land in `pa_voice_reviews`

Commit: `feat(25/T2): Voice.tsx review dashboard with keyboard UX (P9-Voice)`

### T3: Eval rerun button + diff vs baseline
**Files:**
- `apps/dashboard-web/src/pages/Voice.tsx` (extend — add eval panel)
- `apps/dashboard-web/src/lib/voice-eval-api.ts` (new — callable trigger + result fetch)
- `apps/functions/src/index.ts` (add new callable `paRunVoiceEval` if not present — OR document Adam local-only execution path)

Deliverables:
- "Run eval golden-50" button (gated by `getFlag('voiceEvalAutoRerun')` for auto-on-save behavior — manual button always live)
- Calls callable that runs `PA_RUN_EVAL=1 deepeval test run apps/eval/voice/test_voice_baseline.py` OR returns instructions for Adam to run locally + paste result JSON path
- After run: read `eval-results/{timestamp}.json` from CF Storage (or local fixture for dev), render score + diff vs latest `eval-results/baseline.json`
- Diff renderer: top-20 changed turns (rating delta), full JSON download link

DONE:
- `npm run build --workspace=@pa/dashboard-web`
- Manual smoke: button visible + click triggers eval (or shows local-run instructions if CF callable not deployable in scope)

Commit: `feat(25/T3): one-click voice eval rerun + diff vs baseline (P9-Voice)`

## P9 acceptance gate

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa
npm run test --workspace=@pa/pa-persistence
npm run build --workspace=@pa/dashboard-web
npm run typecheck --workspace=@pa/dashboard-web
git log --oneline -10 | head -5
```

3 commits + green build + sendblue/voice Adam files untouched.

## Estimated time

2 dev-day. Single P8, sonnet/inherit.
