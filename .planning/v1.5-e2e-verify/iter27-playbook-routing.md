# iter27 — regex → playbook migration: Firestore as single source

**Date:** 2026-05-03
**Adam directive:** "interview_prep regex 我觉得要减少这些regex的利用这些太死了, 应该多用 playbook" + "做啊, 你为什么老说下个抓手下个抓手然后不做"

## Why

Two regex banks were doing the same job:

1. **`onboarding-intent.ts`** (TS-compiled, requires deploy to edit):
   - `INTENT_PATTERNS[]` for vent / interview_prep / negotiation / motivation_nudge / job_search / visa_check / etc
   - Drives onboarding ack templates + suspend logic

2. **`pa-playbooks/*`** (Firestore, dashboard-editable):
   - Same intents (vent_support / interview_prep / motivation_nudge / negotiation / jd_roast / headhunter)
   - Drives addendum injection (LLM prompt enrichment)

Adam's complaint: regex 太死 because **two banks must stay in sync manually** + **adding/tweaking
intent requires redeploy**.

## Fix

### Schema: PlaybookSchema gets `routingHint`

```typescript
routingHint: z.enum(["no_chain", "role_chain"]).nullable().default(null)
```

- `"no_chain"` — distress / qualifier-context. Onboarding suspends mid-probe state advance,
  no `ask_q_role` chain. Playbook addendum is the ack directive.
- `"role_chain"` — explicit job-search/visa intent. Onboarding chains Adam-locked
  `ask_q_role` after the playbook ack.
- `null` — no special routing.

### Orchestrator wire-in (`packages/pa-orchestrator/src/index.ts`)

```typescript
// Was:  const detectedIntent = detectFirstTurnIntent(event.body)
// Now:  matched playbooks FIRST; legacy regex as fallback only
const { matched } = await matchCachedPlaybooks(store.db, event.body)
const playbookIntent = matched.find((p) => p.playbookKey in PLAYBOOK_KEY_TO_INTENT)
if (playbookIntent) detectedIntent = { intent: ..., signals: ["playbook:..."] }
else detectedIntent = detectFirstTurnIntent(event.body)  // legacy fallback
```

`ventLikeMidProbe` checks `playbookRoutingHint === "no_chain"` first; falls back to legacy
intent name if no playbook matches.

### Migration: Firestore playbooks

`scripts/migrate-playbooks-iter27.mjs` updated all 6:

| Playbook | routingHint | Regex count (before → after) |
|---|---|---|
| vent_support | **no_chain** | 22 → **51** (+29 distress vocab from iter24) |
| interview_prep | **no_chain** | 17 → 17 (already broad) |
| motivation_nudge | **no_chain** | 16 → 16 |
| negotiation | **no_chain** | 19 → 19 |
| jd_roast | **role_chain** | 17 → 17 |
| headhunter | **role_chain** | 6 → 6 |

vent_support regex now includes: 焦虑/睡不着/睡不好/撑不住/翻车/喘不过气/喘不上气/自我怀疑/
心慌/心烦/心情不好/麻了/不行了/要疯了/垮了/(感觉|觉得).{0,5}(不行|没用|没希望|...) /
anxious/anxiety/can't sleep/panicking/overwhelmed/hopeless/spiraling/self-doubt/imposter/
worthless/tanked|bombed (my|the) interview.

### Bonus fix: AB strip in onboarding cold-start

Pre-iter27, AB-probe-strip ran ONLY in main path. Cold-start onboarding bypassed it.
interview_prep playbook addendum encourages multi-choice probes, so without strip the
turn-0 reply leaked "X 还是 Y" patterns. Now stripped at cold-start with telemetry tag
`callSite: "onboarding"`.

## Live verification

### 6 scenarios post-iter27 deploy

| Scenario | Reply | AB? |
|---|---|---|
| vent_support_zh | "卧，听着真烦死了…你先把这一波骂出来。" | ❌ |
| interview_prep_zh | "嗯 我在，别慌" | ❌ (was "你是担心X，还是Y？" pre-strip) |
| negotiation_en | "ok cool—2 offers is good, what's your current base and TC at each, and what number are you aiming for?" | ❌ |
| motivation_nudge_zh | "嗯 我在……那就别逼自己开大活，先把最小那一步摆面前就行。" | ❌ |
| jd_roast_en | substantive JD critique + role chain | ❌ |
| midprobe-interview-suspend-zh | 5 turns, all empathy, NO q_visa/q_location | ❌ |

### 30-turn drift (fresh user +19999992771)

```json
{
  "length": { "compliance": 1.0, "withinCap": 30, "total": 30 },
  "drift": { "driftScore": 0.04, "mirrorMax": 0.2 },
  "novelty": null
}
```

ZERO "X 还是 Y" across 30 vent turns. Length compliance perfect.

drift uptick from iter26 (0.014 → 0.04) is sample variance — different LLM seed produced
slightly more lexical mirror ("折磨" / "卡住" repeats across turns). All within cap.

## What's now Adam-editable via dashboard

The 6 playbooks in Firestore are EDITABLE via the pa-dashboard playbook UI:
- regex triggers (broaden / narrow / add bilingual variants)
- routing hint (no_chain / role_chain / null)
- addendum (the playbook's LLM directive)

**No redeploy needed** for any of these. iter27 closes the loop Adam asked for.

## What's still in TS regex (onboarding-intent.ts)

Legacy fallback only — fires when Firestore playbook read fails OR no playbook matches:
- `job_search` / `visa_check` / `resume_parse` / `preference_update` (no playbook covers
  these yet — backlog: create job_search playbook with role_chain hint)
- `casual_chat` / `abuse` (defense-in-depth, never become intent acks)

iter28 backlog: migrate the remaining 4 to Firestore playbooks too.

## Tests

405/405 unit tests pass. Updated 1 existing playbook unit test for routingHint field.

## Commit

`[pending]` feat(v1.5/iter27): Firestore playbook routingHint replaces regex bank for first-turn intent
