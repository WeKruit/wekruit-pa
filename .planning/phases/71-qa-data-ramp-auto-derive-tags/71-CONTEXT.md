# Phase 71: QA data ramp (auto-derive tags) - Context

REQ-IDs: QADATA-01..04 (4)

**Status:** Shipped 2026-05-06 (`b0a9c39`). Verified: [.planning/v1.7-MILESTONE-AUDIT.md](../../v1.7-MILESTONE-AUDIT.md).

**Goal:** Auto-derive `targetRoleFunction` from CV skills+industries for users without onboarding completion. Fill-gaps script. QA evaluator post-ramp re-trigger to verify sampleSize >50.

**Background:** Phase 61 weekly QA evaluator first run had sampleSize=0 (only 5/529 users have targetRoleFunction populated). Auto-derive bridges the data gap.

**In scope:**
- Auto-derive heuristic in `apps/functions/src/lib/auto-derive-tags.ts`:
  - tags.skills overlaps `programming_languages|frameworks_and_libraries` >3 → `software_engineering`
  - skills overlaps `data_and_ml` + has python → `software_engineering` + `data_analysis`
  - skills overlaps `design_and_ux` >2 → `creatives_and_design`
  - etc — map per skill bucket distribution
- Fill-gaps script `apps/functions/scripts/fill-tag-gaps.mjs`:
  - Iterate pa-users
  - For each missing axis (targetRoleFunction, careerStage from yoeRange, visaStatus default, etc), compute defaults
  - Write to `pa-users-tag-gaps-audit/{userId}` for admin review (default DRY-RUN)
  - --apply flag writes through mergeUserTags
- Re-trigger Phase 61 QA evaluator after data ramp — verify sampleSize >50
- New widget: `/admin/overview` % users with targetRoleFunction (trended weekly)
