# Phase 29 — PLAN (4-task spec)

**Status:** Plan-only. P9 not spawned. Total estimate ~3 dev-day across 1 P8 (T1→T2→T3→T4 serial; T2 dashboard can fork parallel after T1 lands).

---

## T1 — Schema + loader SDK + cache + unit tests

**WHERE:**
- `packages/pa-persistence/src/handbook.ts` (new) — `loadHandbook`, `saveHandbook`, `revertHandbook`, `listVersions`
- `packages/pa-persistence/src/handbook.test.ts` (new) — cache hit, save creates version doc, revert reads prev version
- `packages/pa-persistence/src/index.ts` (export only)
- `packages/pa-orchestrator/src/handbook/loader.ts` (new) — `composeSystemPrompt(handbook): string` fixed-order render

**HOW MUCH:** ~1 day.

**DONE:**
- `npm run test --workspace=@pa/pa-persistence` 全绿
- `npm run test --workspace=@pa/pa-orchestrator` 全绿
- `npm run typecheck` clean
- Unit test: cache hit ≥95% over 1000 calls; save creates `versions/{v}`; revert reads `versions/{v-1}` and writes new `v+1`

**DON'T:**
- DON'T touch agent doc shape yet (T4)
- DON'T wire orchestrator runtime yet (T4)

Commit msg: `feat(29/T1): pa-handbooks SDK + version sub-collection + cache (P9-Handbook)`

---

## T2 — Dashboard `/admin/handbook` editor

**WHERE:**
- `apps/dashboard-web/src/pages/Handbook.tsx` (new)
- `apps/dashboard-web/src/lib/handbook-api.ts` (new — Firestore client wrapper, mirror `lib/memoryAdmin.ts` pattern)
- `apps/dashboard-web/src/components/handbook/SectionEditor.tsx` (new) — accordion per section, type-aware (textarea for strings, chip-input for arrays, JSON editor for objects)
- `apps/dashboard-web/src/components/handbook/VersionDiff.tsx` (new) — side-by-side diff vs previous version
- `apps/dashboard-web/src/App.tsx` (add route + nav link)

**HOW MUCH:** ~1 day.

**DONE:**
- `npm run build --workspace=@pa/dashboard-web` 成功
- `npm run typecheck --workspace=@pa/dashboard-web` clean
- Manual smoke (Adam): open `/admin/handbook`, edit `default_posture`, see diff preview, save → new `versions/{v+1}` row in Firestore + audit event
- Rollback button on a previous version writes new version with `reason: "revert to vN"`

**DON'T:**
- DON'T add markdown rendering / WYSIWYG (raw text + JSON only)
- DON'T let editor save if `version` of pointer changed mid-edit (optimistic concurrency check — show "stale, refresh")

Commit msg: `feat(29/T2): /admin/handbook section editor + diff + rollback (P9-Handbook)`

---

## T3 — Migration script (Bible v7.0 → handbook v1)

**WHERE:**
- `apps/functions/scripts/migrate-bible-to-handbook.ts` (new)
- `.planning/phases/29-agent-handbook/MIGRATION.md` (new — Adam runbook + section mapping table + dry-run output sample)

**HOW MUCH:** ~0.5 day.

Steps:
1. Read `packages/agent-registry/src/seed.json` Bible v7.0 + live `pa-agents/claire.systemPrompt`
2. Parse into `sections` per the mapping table documented in script comments (identity, hard_rules, never_5, escape_hatch, tone_flavors, human_tells, vocab, playbooks.headhunter)
3. Dry-run mode: print proposed handbook JSON, exit
4. Live mode: write `pa-handbooks/claire` (v1) + `pa-handbooks/claire/versions/1`; write `pa-agents/claire.handbookSlug = "claire"` (does NOT delete `systemPrompt` field — left for fallback during cutover)
5. Idempotent: refuses to overwrite if `pa-handbooks/claire/versions/1` already exists

**DONE:**
- `npm exec --workspace=@pa/functions -- tsx scripts/migrate-bible-to-handbook.ts --dry-run` prints handbook JSON, exits 0
- MIGRATION.md documents dry-run command + live command + verification SQL/Firestore queries
- Adam reviews dry-run output before running live (gate)

**DON'T:**
- DON'T delete `systemPrompt` from agent doc (kept as failsafe, removed in later cleanup phase)
- DON'T run live in CI; Adam runs locally with prod creds

Commit msg: `feat(29/T3): migrate-bible-to-handbook script + runbook (P9-Handbook)`

---

## T4 — Orchestrator wire-in (read handbook at runtime)

**WHERE:**
- `packages/pa-orchestrator/src/index.ts` — replace `agent.systemPrompt` read with `loadHandbook(agent.handbookSlug ?? "claire")` + `composeSystemPrompt`
- `packages/pa-orchestrator/src/__tests__/handbook-integration.test.ts` (new)

**HOW MUCH:** ~0.5 day.

**DONE:**
- `npm run test --workspace=@pa/pa-orchestrator` 全绿
- Integration test: stub Firestore returns handbook v1 → orchestrator system prompt matches expected fixed-order composition
- Smoke (Adam, post-deploy): live conversation reads handbook (verified by editing `tone_flavors.curious` in dashboard, conversation reflects within 30s)
- Fallback: if `pa-handbooks/{slug}` missing → fall back to `agent.systemPrompt` field with warning log (graceful degrade until full migration confidence)

**DON'T:**
- DON'T remove the `agent.systemPrompt` fallback in this commit (cleanup phase later)
- DON'T touch voice/sendblue uncommitted Adam work in `git status`

Commit msg: `feat(29/T4): orchestrator reads handbook at runtime + fallback (P9-Handbook)`

---

## Sub-task summary

| ID | Title | Dep | Time |
|----|-------|-----|------|
| T1 | Schema + loader SDK + cache | none | 1d |
| T2 | Dashboard editor + diff + rollback | T1 | 1d |
| T3 | Migration script | T1 | 0.5d |
| T4 | Orchestrator wire-in + fallback | T1, T3 | 0.5d |

Total **~3 dev-day**.

## Adam decisions still owed

- [ ] Confirm fixed-order section render sequence is correct (identity → hard_rules → default_posture → never_5 → escape_hatch → vocab → human_tells → tone_flavors → playbooks)
- [ ] Confirm `playbooks.headhunter` is the only v1 playbook to seed (vs salary/layoff also)
- [ ] Confirm `systemPrompt` fallback retained for one phase (cleanup in v1.4)
