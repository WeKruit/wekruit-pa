# Phase 30 — PLAN (5-task spec)

**Status:** Plan-only. P9 not spawned. Total estimate ~4 dev-day across 1-2 P8s.

T1→T2→T3 serial (each unlocks the next). T4 dashboard can fork parallel after T1. T5 is final gate.

---

## T1 — Schema + persistence SDK

**WHERE:**
- `packages/pa-persistence/src/eval-triggers.ts` (new) — CRUD: `listTriggers`, `getTrigger`, `saveTrigger`, `deleteTrigger`
- `packages/pa-persistence/src/eval-fires.ts` (new) — `recordFire`, `checkCooldown(userId, slug, cooldownSec)`, `listFiresForTrigger(slug, limit)`
- `packages/pa-persistence/src/eval-triggers.test.ts` + `eval-fires.test.ts` (new)
- `packages/pa-persistence/src/index.ts` (export only)
- Firestore TTL policy on `pa-eval-fires.ttlExpiresAt` (documented in `.planning/phases/30-downstream-eval-connector/FIRESTORE-TTL.md`, applied by Adam in console)

**HOW MUCH:** ~0.5 day.

**DONE:**
- `npm run test --workspace=@pa/pa-persistence` 全绿
- `checkCooldown` correctness: same userId+slug within window returns `blocked`; different bucket returns `allowed`
- TTL doc explains console steps (we don't apply policy in code)

**DON'T:**
- DON'T expose secret refs in list responses (server-only field)

Commit msg: `feat(30/T1): pa-eval-triggers + pa-eval-fires SDK (P9-Connectors)`

---

## T2 — Eval pipeline (regex + nl_judge)

**WHERE:**
- `packages/pa-orchestrator/src/eval-connectors/pipeline.ts` (new) — `runPostTurnEvals(turn): Promise<void>`
- `packages/pa-orchestrator/src/eval-connectors/regex-eval.ts` (new) — sync match, returns `{matched, snippet}`
- `packages/pa-orchestrator/src/eval-connectors/nl-judge.ts` (new) — nano call, 1.5s timeout, parse yes/no
- Tests for both

**HOW MUCH:** ~1 day.

**DONE:**
- Unit: regex match works on user msg + assistant reply combined
- Unit: nl_judge stubs nano response "yes" → matched=true; "no" → matched=false; timeout → matched=false (graceful)
- Integration: pipeline reads triggers, evals each, returns matches list
- Master kill switch: `evalConnectorsEnabled=false` → pipeline returns empty list immediately (no Firestore reads)

**DON'T:**
- DON'T throw on nl_judge timeout — log + skip
- DON'T cache judge results (every turn fresh)

Commit msg: `feat(30/T2): eval pipeline + regex + nl_judge variants (P9-Connectors)`

---

## T3 — Dispatcher (HTTP POST + HMAC + retry)

**WHERE:**
- `packages/pa-orchestrator/src/eval-connectors/dispatcher.ts` (new) — `dispatch(trigger, payload): Promise<{status, error?}>`
- `packages/pa-orchestrator/src/eval-connectors/hmac.ts` (new) — sha256 sign body with secret resolved from Secret Manager
- Wire `pipeline.ts` to call dispatcher post-match
- Wire `recordFire` post-dispatch
- Tests

**HOW MUCH:** ~1 day.

**DONE:**
- Unit: HMAC header `X-PA-Signature: sha256=<hex>` matches expected
- Unit: 5xx → 1 retry with 1s backoff; 4xx → no retry; 2xx → success
- Unit: 30s total timeout enforced
- Integration: full pipeline run with stubbed endpoint logs fire row with httpStatus
- Cooldown integration: fire 1 → fire 2 same user/slug within window → second skipped (no HTTP call)

**DON'T:**
- DON'T log secret value anywhere
- DON'T await dispatcher on chat path beyond `Promise.race(timeout=2s)`
- DON'T retry on timeout (drop after first timeout — pipeline is fire-and-forget)

Commit msg: `feat(30/T3): HMAC dispatcher + retry + cooldown wire (P9-Connectors)`

---

## T4 — Dashboard `/admin/triggers` CRUD

**WHERE:**
- `apps/dashboard-web/src/pages/Triggers.tsx` (new)
- `apps/dashboard-web/src/lib/triggers-api.ts` (new — Firestore client wrapper)
- `apps/dashboard-web/src/components/triggers/TriggerEditor.tsx` (new)
- `apps/dashboard-web/src/components/triggers/FiresDrawer.tsx` (new)
- `apps/dashboard-web/src/App.tsx` (route + nav link)

**HOW MUCH:** ~1 day.

**DONE:**
- List shows enabled state + last-fired timestamp
- Editor: select kind (regex|nl_judge), edit pattern/judgePrompt, endpoint, payloadTemplate, cooldownSec
- "Test" button: synthetic eval against an example user msg + assistant reply (calls eval pipeline in dry-run mode, no dispatch)
- Recent fires drawer: last 50 fires for trigger, with HTTP status
- Save writes audit row (`action: "trigger.update"`)

**DON'T:**
- DON'T let editor save without `endpoint` validation (https-only, length cap)
- DON'T expose `hmacSecretRef` value (just the ref id; secret stays in Secret Manager)
- DON'T fire dispatcher from "Test" button (dry-run only)

Commit msg: `feat(30/T4): /admin/triggers CRUD + dry-run test + fires drawer (P9-Connectors)`

---

## T5 — Default seeds + integration tests

**WHERE:**
- `apps/functions/scripts/seed-eval-triggers.ts` (new — idempotent)
- `packages/pa-orchestrator/src/eval-connectors/__tests__/integration.test.ts` (new)
- `.planning/phases/30-downstream-eval-connector/SEED.md` (Adam runbook)

**HOW MUCH:** ~0.5 day.

Two seeded triggers (both `enabled: false` initially):
1. `mentioned_layoff` — kind: nl_judge, judgePrompt: "Did the user mention being fired, laid off, terminated, or losing their job? Answer yes or no.", cooldownSec 86400, endpoint placeholder `https://example.invalid/layoff` (Adam edits)
2. `mentioned_salary_research` — kind: nl_judge, judgePrompt: "Did the user share a specific salary number or explicitly ask about pay benchmarks/levels.fyi? Answer yes or no.", cooldownSec 86400, endpoint placeholder

**DONE:**
- `--dry-run` prints proposed seeds, exits 0
- Integration test: seed → enable → simulate user msg "I just got laid off last week" → expect fire row with httpStatus from stubbed endpoint
- SEED.md documents enable steps + endpoint config + HMAC secret provisioning

**DON'T:**
- DON'T enable seeds by default
- DON'T run live in CI

Commit msg: `feat(30/T5): seed default triggers + integration tests + runbook (P9-Connectors)`

---

## Sub-task summary

| ID | Title | Dep | Time |
|----|-------|-----|------|
| T1 | Schema + persistence SDK | none | 0.5d |
| T2 | Eval pipeline (regex + nl_judge) | T1 | 1d |
| T3 | Dispatcher + HMAC + cooldown wire | T1, T2 | 1d |
| T4 | Dashboard CRUD + dry-run test | T1 | 1d |
| T5 | Seeds + integration tests + runbook | T1-T4 | 0.5d |

Total **~4 dev-day**.

## Adam decisions still owed

- [ ] Confirm 2 default trigger NL prompts wording
- [ ] Confirm Secret Manager ref naming convention (`PA_TRIGGER_HMAC_<SLUG>`?)
- [ ] Confirm `evalConnectorsEnabled` default `false` (yes per current spec)
- [ ] Confirm cooldownSec default 86400 (24h) reasonable for v1
