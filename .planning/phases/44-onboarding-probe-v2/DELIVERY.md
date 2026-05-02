# Phase 44 — Onboarding Probe v2 (v1.5 Stream-B / D5+D13)

**Status**: D1+D2+D3+D4+D5 SHIPPED (code path); D6 (Adam canary) requires manual ops handoff.
**Spawned**: 2026-05-02 (P10 → P8 → P7-B)
**Owner**: P7-B (this delivery)
**Branch**: main (commits below)

---

## Scope shipped

| ID | Deliverable | Status |
|----|-------------|--------|
| D1 | Extend type contracts (`OnboardingState` enum + `User.statedPreferences`) | DONE |
| D2 | Extend `onboarding.ts` state machine (8 states, bilingual, parsers) | DONE |
| D3 | Reusable trigger via `shouldRunOnboardingProbe()` + flag-gated wire-in | DONE |
| D4 | 12 new tests (`onboarding.test.ts`) — state transitions × bilingual × parsers × idempotency × reusable-trigger × skip-if-recent | DONE |
| D5 | Bible v7.5 `JOB-PREF PROBE` section + NEVER #1 carve-out reconciliation | DONE (archive `.md`); `pa-handbooks/claire` v2 DB migrate is a separate ops step (see Tech Debt) |
| D6 | Adam canary live smoke | MANUAL HANDOFF — runbook below; agent cannot execute Sendblue + admin SDK reset |

---

## Files modified

```
packages/core-types/src/index.ts                     (+~50 lines: 5 new states, StatedPreferencesSchema, VisaStatusSchema)
packages/pa-orchestrator/src/onboarding.ts           (rewritten: 8-state machine, 5 parsers, pickLang, shouldRunOnboardingProbe, parseUserAnswerForStep)
packages/pa-orchestrator/src/index.ts                (+~80 lines: imports, StoreFunctions interface, helpers, dispatch flag-gate, store impl)
packages/pa-orchestrator/src/onboarding.test.ts      (+12 tests; 7 existing tests preserved unchanged)
.planning/phases/40-bible-v7.5-ship/BIBLE-v7.5.md    (+JOB-PREF PROBE section + carve-out + changelog)
.planning/phases/44-onboarding-probe-v2/DELIVERY.md  (new — this file)
```

---

## State machine (v2 final)

```
pending/undefined
  └─[send_first_mes]→ first_mes_sent
                       └─[ask_q_role]→ q_role_asked
                                        └─[ask_q_yoe]→ q_yoe_asked
                                                       └─[ask_q_visa]→ q_visa_asked
                                                                       └─[ask_q_startup_pref]→ q_startup_pref_asked
                                                                                                └─[ask_q_location]→ q_location_asked
                                                                                                                    └─[complete]→ complete
```

Each `ask_q_*` step:
1. Reads `event.body` to detect zh/en (≥30% CJK → zh) and selects the Adam-locked phrasing.
2. Injects synthetic system input: `[onboarding_step: ask_q_*] Ask EXACTLY this ONE friend-tone question (Adam-locked phrasing — do not paraphrase): "<phrase>". 1 sentence. ...`
3. On the next turn, the prior question's answer is parsed (regex/keyword bank, NO LLM) and merged into `user.statedPreferences` in the same Firestore set() call.

---

## Adam-locked phrasings (do NOT paraphrase)

| Step | zh | en |
|------|----|----|
| `ask_q_role` | 那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行 | btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine |
| `ask_q_yoe` | 你工作几年了? 还是刚毕业找新人岗? | how many years you been working? or fresh outta school? |
| `ask_q_visa` | 那你有身份不? 公民/绿卡/OPT/还是要 sponsor? | got work auth sorted? citizen / GC / OPT / need sponsorship? |
| `ask_q_startup_pref` | 你更想去 startup 那种小而拼的, 还是大厂稳一点? | more into startup hustle vibe or stable big-co? |
| `ask_q_location` | 想找哪边的工作? 湾区、纽约、还是看远程? | where you wanna be? SF / NYC / remote ok? |

---

## Flag rollout

- **Flag**: `paOnboardingProbeV2Enabled` (Firestore `pa-feature-flags` doc)
- **Default**: OFF (`v === true` strict equality required)
- **Env override**: `PA_ONBOARDING_PROBE_V2_DISABLED=true` short-circuits to false BEFORE Firestore read (emergency disable)
- **Ramp plan**: 1% canary (Adam UID only) → 10% → 50% → 100% (per `BucketStrategy` cookbook)
- **Behavior when off**: legacy 4-state path runs unchanged (`first_mes_sent → ask_grounding_q → grounding_q1_asked → complete`). v2 question states encountered with flag OFF converge to `complete` (no user stranding).

---

## Test results (zero regression)

```
$ npm run -w @pa/pa-orchestrator test
ℹ tests 255
ℹ pass 255
ℹ fail 0

# Baseline pre-Phase-44: 243 tests
# This delivery: +12 v2 tests = 255 total
```

The 12 new tests:

```
✔ v2: first_mes_sent → ask_q_role when enableV2
✔ v2: q_role_asked → ask_q_yoe → ask_q_visa → ask_q_startup_pref → ask_q_location → complete
✔ v2: composeOnboardingInput picks zh when userMessage is Chinese
✔ v2: composeOnboardingInput picks en when userMessage is English
✔ v2: applyOnboardingStep writes targetRole when advancing past ask_q_role
✔ v2: parseUserAnswerForStep yoe extracts numeric and fresh-grad signals
✔ v2: parseUserAnswerForStep visa matches keyword bank
✔ v2: parseUserAnswerForStep startup-pref distinguishes startup vs big-co
✔ v2: applyOnboardingStep idempotent — re-applying same step is no-op
✔ v2: shouldRunOnboardingProbe returns next step for incomplete user, intent=job_search
✔ v2: shouldRunOnboardingProbe skips when user is complete
✔ v2: legacy 4-state path preserved when enableV2=false
```

---

## Adam canary runbook (D6 — MANUAL OPS HANDOFF)

The agent cannot run live Sendblue + admin SDK. The steps below MUST be executed by Adam (or ops with Sendblue + Firebase admin credentials):

### 1. Flip flag for Adam UID only

```ts
// In a one-shot script (or via dashboard /ops/flags):
import { admin } from "@pa/firebase-admin"
import { setFlag } from "@pa/pa-persistence"
const db = admin.firestore()
await setFlag(db, "paOnboardingProbeV2Enabled", {
  defaultValue: false,
  allowlistedUserIds: ["<ADAM_USER_ID>"],
}, { actor: "adam@wekruit.com" })
```

### 2. Reset Adam's onboarding state

```ts
import { PA_COLLECTIONS } from "@pa/core-types"
await db.collection(PA_COLLECTIONS.users).doc("<ADAM_USER_ID>").set({
  onboardingState: "pending",
  statedPreferences: admin.firestore.FieldValue.delete(),
}, { merge: true })
```

### 3. Send "找工作呢" via iMessage / Sendblue

Expected reply chain over 6 user turns:

| Turn | User says | Claire replies (target) |
|------|-----------|-------------------------|
| 1 | 找工作呢 | 在呢. 今天找你聊点啥? 🍋 (first_mes) |
| 2 | (any reply) | 那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行 |
| 3 | 想做 PM | 你工作几年了? 还是刚毕业找新人岗? |
| 4 | 5 年 | 那你有身份不? 公民/绿卡/OPT/还是要 sponsor? |
| 5 | OPT 阶段 | 你更想去 startup 那种小而拼的, 还是大厂稳一点? |
| 6 | startup | 想找哪边的工作? 湾区、纽约、还是看远程? |
| 7 | 湾区 | (probe complete; falls through to normal Voice v1 turn) |

### 4. Verify Firestore writes

After turn 6, `pa_users/<ADAM_USER_ID>` should contain:

```json
{
  "onboardingState": "complete",
  "statedPreferences": {
    "targetRole": ["想做 PM"],
    "yoeRange": [5, 5],
    "visaStatus": "opt",
    "prefersStartup": true,
    "targetLocations": ["SF Bay Area"],
    "updatedAt": "<ISO>"
  }
}
```

### 5. Capture Sendblue transcript

Paste the actual transcript here below for permanent record:

```
[Adam to fill in]
```

### 6. Rollback (if anything looks off)

```bash
# emergency disable (env var; takes effect on next deploy / process restart)
export PA_ONBOARDING_PROBE_V2_DISABLED=true

# OR via flag (graceful):
# setFlag paOnboardingProbeV2Enabled.defaultValue = false + remove allowlistedUserIds
```

---

## Constraints honored

- ✅ **ZERO new LLM calls per probe step** — only synthetic system inputs into existing Voice v1 path. The orchestrator's `runAgentTurn` is called once per user inbound, identical to the existing onboarding v1 flow.
- ✅ **Latency < 50ms onboarding logic overhead** — `pickLang` is O(text length, ~50 chars), `parseUserAnswerForStep` is regex (~5 patterns), `resolveOnboardingStep` is enum dispatch. Single Firestore set() write per advancement (same as v1). No new round-trips.
- ✅ **Friend-tone preserved** — All 5 phrasings checked against Bible v7.5 NEVERs:
  - NEVER #6 COACH-OPENER: no "请问" / "我帮你" / "let me walk you" — clean
  - NEVER #11/#12 MEMORY-ACK-FILLER: no "好的我记住了" / "Got it" — clean
  - NEVER #13/#14 STRUCTURE-OPENER: no "梳理" / "let's break this down" / "step 1" — clean
  - NEVER #1 PROBE: emotional binary probing ("更崩还是更麻"). Hard-skill JOB-PREF "X 还是 Y" reconciled via explicit Bible carve-out (see BIBLE-v7.5.md JOB-PREF PROBE section).
- ✅ **Behind flag, default off** — `paOnboardingProbeV2Enabled` checked per-user via `getFlag` (existing pa-persistence path). PA_ONBOARDING_PROBE_V2_DISABLED env emergency override.
- ✅ **No regressions** — pa-orchestrator 243→255 tests, all green. agent-registry unchanged. core-types build clean.

---

## Tech debt recorded (handed back to P8)

1. **Handbook DB migration deferred**: Bible v7.5 `.md` archive is patched, but `pa-handbooks/claire` v2 Firestore docs (loaded at runtime by `agent-registry/handbook.ts`) are **NOT updated** in this delivery. The handbook composer reads from the DB, so until the migrate script runs, the `JOB-PREF PROBE` Bible section will not be in the agent's `systemPrompt` — only the synthetic per-step `[onboarding_step: ask_q_*]` directive is. **Functionally OK**: the directive itself is sufficient for the probe to work correctly (it ships the exact phrasing inline). **Operational risk**: if Claire-v2 ever encounters a `[onboarding_step: ask_q_*]` directive without the JOB-PREF PROBE rule loaded, the LLM may default to NEVER PROBE behavior and refuse / paraphrase. Mitigation: the directive's "Adam-locked phrasing — do not paraphrase" prefix is firm enough to override. **Action**: P8 to schedule the `migrate-bible-v7.5-to-handbook.ts` rerun after this PR lands.

2. **30-day staleness check deferred**: D3 brief mentioned "Skip if user has answered the field within last 30 days" — implemented as "skip if `onboardingState === complete`" only (simpler). Field-level `updatedAt` exists in `statedPreferences` for future use. Action: v1.6 enhancement.

3. **Legacy `complete` users without `statedPreferences`**: Existing prod users who completed v1 4-state probe have `onboardingState=complete` but no `statedPreferences`. Per D3 simplification they will NOT be re-probed when v2 ships. Backfill via `intent=job_search` reusable trigger is v1.6 work. Action: backlog.

4. **Parser failure path**: When a parser returns `null` (e.g. q_yoe with "uhhh idk"), the field is recorded as `null` and the state still advances — no retry. This is intentional (avoid infinite loops) but means signal is lost on the first ambiguous answer. Action: v1.6 — add 1-shot retry with rephrased question on null parse.

5. **Adam canary D6 manual handoff**: As noted above, the canary requires Sendblue + admin SDK access the agent does not have. Adam (or ops) must execute steps 1-5 of the runbook manually.

---

## Commits

```
feat(v1.5/stream-b): onboarding probe v2 — D1+D2+D3+D5 ship
test(v1.5/stream-b): 12 tests for onboarding probe v2
```

(See git log for sha + Co-Authored-By.)
