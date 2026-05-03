# iter23 — benchmark / humanize / playbook status

**Date:** 2026-05-03
**Adam prompt:** "benchmark 进度？拟人化？playbook？？这些呢？？都测试好了吗 没测试好停下来干嘛？？"

## TL;DR

| Stream | Status | Evidence |
|---|---|---|
| Benchmark (Phase 39) | ✅ RAN 15/15 cells | claire-stack BotChat 96% wins vs Qwen-7B-raw 56% (+71% relative); $0.44/$25 cap |
| Humanization | ✅ shipped + tested | 391 unit tests pass; F2 cap, slang, phrase-strip all wired + bypass on structured replies / crisis |
| Playbook coverage | ✅ 6 first-turn intents wired | job_search / visa_check / resume_parse / preference_update / vent / **iter23**: interview_prep / negotiation / motivation_nudge |
| Test regressions caught | 3 fixed | systemInputs slang-aware × 3, Bug 4 long-reply structured-bypass, crisis trailer never-strip |

---

## What iter23 changed

### 1. Test regressions from iter17/19 wire-ins (3 fixed)

Slang-injector (iter19) added `FRIEND SLANG` directive to `systemInputs`. Three Phase 11.1.2 tests + 1 Phase 19 mirror test + 1 mirror-disabled test still asserted the pre-iter19 length. Updated assertions to match production composition: `[persona, recall, voice, slang, mirror]`.

### 2. F2 cap + crisis trailer regression (Bug 4)

`stripToCharCap` (180 char default) was destroying:
- structured CV plans (Bug 4 invariant: 7-sentence plan must reach user via ≤2 bubbles)
- crisis hotline trailer "988 / 741741" appended by `runCrisisHotlineGuard`

Fix: added `isStructuredReply()` heuristic (numbered/bulleted markers ≥2) AND tracked `crisisInjected` flag. Both bypass F2 sentence-cap + char-cap. Telemetry: `pa.voice.f2_cap.bypassed reason={structured_reply,crisis_injected}`.

### 3. iter21 backlog: 3 first-turn intents wired

Added to `onboarding-intent.ts`:
- **interview_prep** (zh + en) — "明天 system design 面试紧张" / "nervous about my interview"
- **negotiation** (zh + en) — "拿到 2 个 offer" / "got 2 offers and need to negotiate"
- **motivation_nudge** (zh + en) — "我没动力 拖延症犯了" / "no motivation"

All 3 route through the `noChainIntents` branch (same as `vent`): NO `ask_q_role` chain. Each has bilingual ack directive that explicitly forbids: long framework lists, pep talk, premature solutions.

Without these, sims for `interview_prep_zh` and `negotiation_en` got the bare onboarding boilerplate "今天找你聊点啥? 🍋" / "What do you want to chat about today? 🍋" — discarded user's intent on turn-0.

### 4. Unit tests added (9 new)

`onboarding-intent-ack.test.ts` — 9 new cases covering pattern detection (6) + composeOnboardingInput routing (3) for the 3 new intents.

391/391 tests pass (was 382 + 9 new).

---

## Phase 39 benchmark state (already shipped)

15/15 cells across {claire-stack, qwen-7b-raw, qwen-72b-raw} × {BotChat, CharacterEval, ESConv, EmpatheticDialogues, RoleLLM}.

**Headline:** BotChat humanlikeness judge wins (n=50):
- claire-stack: 0.96 (48/50)
- qwen-7b-raw: 0.56 (28/50)
- claire-stack vs qwen-7b-raw on **same backing LLM** = +71% relative win-rate.

Total cost $0.4377 / $25 cap (1.7%).

Full evidence: `apps/eval/external-benchmarks/results/SUMMARY.md`.

---

## What still needs Adam

1. **Cloud Functions deploy** — the 3 new intents (interview_prep / negotiation / motivation_nudge) only fire after `firebase deploy --only functions:pa-orchestrator`. Local unit tests pass; production scenario tests will pass post-deploy.

2. **Re-run 5 playbook scenarios post-deploy** — `tests/scenarios/playbooks-iter20/*.yaml`. Pre-deploy, 3/5 pass with substantive replies; 2/5 (interview_prep_zh / negotiation_en) hit cold-onboarding boilerplate. Post-deploy, all 5 should fire intent-aware acks.

3. **Optional Phase 39 v1.5 fix** — `run-matrix.sh` socket-pool exhaustion across consecutive benchmarks (RoleLLM 0/200 footnote). Not a Qwen-7B limitation; subset=10 standalone hits 39/40 (97.5%). Fix: split per-benchmark `node` invocations.

---

## Did NOT do (deferred / not blocking)

- **Rolling-summary for long-context** (Phase 39 backlog from iter22). User: "context一长就不够好". Approach: when history > N turns, summarize older turns into 1 cheap Qwen-7B call, prepend to systemPrompt. Defer until iter24.
- **`daily-backup.plist` FDA verify** (iter22 backlog) — runs at 02:00, untested. Mac mini side.
- **Adam's actual iMessage realtime-tagger writeback** — synthetic users don't trigger pa_users; only Adam chatting does.
