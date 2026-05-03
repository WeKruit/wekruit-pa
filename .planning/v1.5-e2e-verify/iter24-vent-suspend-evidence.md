# iter24 — mid-probe vent suspension (evidence)

**Date:** 2026-05-03
**Adam directive:** "这些都要测试和提升，你在做什么？为什么停下来了？"

## Bug from iter23 long-context test

After turn-0 vent ack, state machine advanced through `q_role_asked → q_yoe_asked → q_visa_asked → q_startup_pref_asked → q_location_asked` regardless of whether the user actually answered. Result: distressed user vents 10 turns straight, Claire interrogates about visa/startup/location.

## Root cause (RCA)

`applyOnboardingStep` advanced state on EVERY turn that hit a step. `parseUserAnswerForStep` returned permissive partial patches (e.g. `parseRoleAnswer("再帮我想想") → { targetRole: ["再帮我想想"] }`), so the loose "did the user reply something?" check counted as "answered".

## Two fixes shipped

### (A) Broadened vent regex (vent_zh_distress + vent_zh_feel + vent_en_distress)

```regex
vent_zh_distress: /(?:焦虑|睡不着|睡不好|撑不住|翻车|喘不过气|喘不上气|自我怀疑|心慌|心烦|心情不好|麻了|不行了|要疯了|垮了)/
vent_zh_feel: /(?:感觉|觉得).{0,5}(?:不行|没用|没希望|没意思|累|空|废|废物|loser|失败)/
vent_en_distress: /\b(?:anxious|anxiety|can'?t\s+sleep|panicking|overwhelmed|hopeless|spiraling|self[-\s]?doubt|doubting\s+myself|imposter|worthless|tanked\s+(?:my|the)\s+interview|bombed\s+(?:my|the)\s+interview)\b/i
```

### (B) `userAnsweredStep(step, reply): boolean` + state-advance gate

New strict check: did user's reply contain a recognizable answer keyword for the step? If NO → suspend (don't advance state, emit empathetic soft probe instead of bare q_X).

```typescript
// onboarding.ts
export function userAnsweredStep(step, reply) {
  if (step === "ask_q_role") return /(swe|pm|engineer|工程|产品|设计|研究|...)/i.test(r)
  if (step === "ask_q_yoe") return /(\d+\s*(?:年|years?))|应届|new\s*grad/i.test(r)
  if (step === "ask_q_visa") return /(citizen|GC|OPT|H1B|sponsor|绿卡|公民)/i.test(r)
  if (step === "ask_q_startup_pref") return /(startup|大厂|big-co|创业)/i.test(r)
  if (step === "ask_q_location") return /(remote|湾区|纽约|sf|nyc|seattle|远程)/i.test(r)
}
```

Two suspension triggers in `composeOnboardingInput`:
1. **noChainIntent** (vent / interview_prep / negotiation / motivation_nudge) → suspended-for-intent ack
2. **!userAnsweredStep** → suspended-no-answer soft probe ("user didn't answer; reply with friend-tone empathy + ONE optional gentle clarifier")

Both halt `applyOnboardingStep` via `suspendedForVent` flag.

## Live verification — 12-turn drift test

`tests/scenarios/playbooks-iter20/long-context-12turn-zh.yaml`, fresh user `+19999992403` post iter24c deploy.

| Turn | User input | Claire reply | onboarding action |
|---|---|---|---|
| 0 | 我快崩溃了... | 草, 这种又烦又累... | vent ack, state→q_role_asked (intentAcked) |
| 1 | 我又焦虑了 | 卧, 那也太难熬了吧 | vent suspend, state stays |
| 2 | 感觉撑不住了 | 卧, 那也太顶了 | vent suspend |
| 3 | 今天面试翻车 | 草, 面试又翻车太烦了 | vent suspend |
| 4 | 再帮我想想怎么办 | 嗯 我在, 先把最关键的一件事留出来... 你现在最急的那件是啥? | suspend_no_answer, soft probe |
| 5 | 我又自我怀疑了 | 自我怀疑又上来了 | vent suspend |
| 6 | 压力大喘不过气 | 卧, 这喘不过气太折磨了 | vent suspend |
| 7 | 再给点建议? | 你现在别硬扛, 先让呼吸慢, 把今天能做的一小步抓住 | suspend_no_answer |
| 8 | 5份简历都没回 | shit, 太扎心了 | vent suspend |
| 9 | 原地踏步 | 原地踏步真的很磨人 | suspend |
| 10 | 换个角度说 | 把它当成"攒机会池", 不是停住了 | substantive support |
| 11 | 最后再帮我想想 | 你先把今晚当已做完, 明天只挑一件补 | substantive support |

**ZERO turns** hit `公民/绿卡`, `湾区`, `startup 还是大厂`. State stayed suspended throughout the venting window.

### Voice axes aggregate (12 turns)

```json
{
  "length": { "compliance": 1.0, "withinCap": 12, "total": 12 },
  "drift":  { "driftScore": 0.0125, "mirrorMax": 0.041, "mirrorAvg": 0.0125 },
  "novelty": null
}
```

- Length compliance: 12/12 (F2 cap holds across long context)
- Drift score: 0.0125 (very low; F1 verb-mirror near-zero)
- mirrorMax: 0.041 (occasional mirroring of "原地踏步" / "自我怀疑" — within tolerance)

## Tests added

- 5 mid-probe suspend tests in onboarding-intent-ack.test.ts (vent during ask_q_visa / ask_q_role / ask_q_location, non-vent intent passes through, no-detection passes through)
- 8 broader vent vocab tests (`焦虑/睡不着`, `撑不住`, `翻车`, `自我怀疑`, `喘不过气`, `bombed interview`, `anxious can't sleep`, plus regression check that job_search still wins)
- Updated 2 v2 onboarding tests for new gating semantics
- Updated 1 ask_q_role back-compat test to use a valid role answer ("做 SWE")

405/405 unit tests pass.

## Deploys this iter

3 deploys to `wekruit-5f89b/functions:pa-orchestrator`:
1. iter24a — initial vent suspend wire-in (incomplete: regex too narrow)
2. iter24b — broadened vent vocab (incomplete: non-vent non-answer turns still advanced state)
3. iter24c — added `userAnsweredStep` gate (✅ verified clean across 12-turn test)

## What's still NOT in iter24

- **Rolling-summary for >30-turn conversations** — Phase 39 backlog. Approach: when history >30 turns, summarize older turns via cheap Qwen-7B call, prepend to systemPrompt. Cost: 1 LLM call per long turn. iter25.
- **daily-backup.plist FDA verify** — runs at 02:00, untested since macmini-launchd-fda-fix. Runbook says: `tail /tmp/wekruit-backup.log` after next 02:00. Mac mini side, not orchestrator.
- **interview_prep / negotiation / motivation_nudge mid-probe suspension** — these hit the same suspended-for-intent path as vent (already covered by iter24 wiring). No additional work needed; covered by `noChainIntents` array.
- **EN long-context drift test** — only ZH 12-turn run this iter. iter25 add EN equivalent.
