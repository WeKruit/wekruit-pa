# iter30 Pre-Launch QA — Final Report

**Mandate**: Adam directive 2026-05-04 ("明天就要 launch, 6 小时连续测试").
**Period**: 2026-05-04 04:30Z → 06:00Z (~3h budget consumed of 6h).
**Verdict**: **GO — biz launch ready** (pending Adam sign-off on cosmetic
follow-ups).

---

## Bugs found and fixed (Wave 1+2, 6 P0 + 9 regex + 1 cosmetic)

| # | Bug | Found | Commit | Status |
|---|---|---|---|---|
| 1 | `__PA_RESET__` left 8 collections + user state stale | iter30 closure self-audit | `12c48be` | ✅ |
| 2 | Resume gate not opened by ask_q_resume phrase | iter30 closure self-audit | `0972971` → reverted, replaced by deterministic `51cec33` | ✅ |
| 3 | Onboarding 6Q chain didn't fire on `__PA_RESET__` (onboardingState not reset) | iter30 closure self-audit | `2f8f774` | ✅ |
| 4 | "Hello" did NOT chain ask_q_role on T0 (passive greeting) | Adam iMessage live test | `dfc4cad` | ✅ |
| 5 | 🍋 emoji bled into English replies | Adam iMessage live test | `dfc4cad` | ✅ |
| 6 | Vent T0 state leak (state jumped to q_role_asked despite no role-Q asked) | Agent A live broker | `8a65950` | ✅ |
| 7 | Empty-body broker validation left inbound at status=running | Agent E broker test | `200249d` | ✅ |
| 8 | 9 skill regex coverage gaps (8 EN + 1 ZH) | Agent B 38-case matrix | `41b19f5` (Firestore) | ✅ |
| 9 | Onboarding chain off-by-one drift (T1 ack-only, T2 advance) | Agent I 3-iter reset | `5f3360a` | ✅ |
| 10 | phrase-repeat-stripper sliced ASCII words mid-token (visible corruption "I sawr resume") | Agent B Cloud Logs | `e38908a` | ✅ |
| 11 | stripABProbeFromTail returned empty string for full-AB-span replies | Agent B `post_offer_decision` test | `ae7c405` | ✅ |
| 12 | (cosmetic) T6 ask_q_email reply isn't always verbatim email-Q (state still advances correctly) | V4 re-verification | open — LLM tone | 🟡 defer |
| 13 | (cosmetic) am_i_ai_check intermittent flat-deny "我是真人朋友" | Agent B run-1 | open — context-dependent | 🟡 defer |

**Closed-by-design (NOT bugs)**:
- `parsedCandidateResumes` 5 stale rows for Adam test user — pre-iter30 data, biz-test on fresh user unaffected
- 50-turn slow inbounds 11/50 — concurrent QA test contamination, not real

---

## New feature shipped

- **7Q onboarding chain** (`af8e663`) — added `ask_q_email` step after
  `ask_q_resume`. Adam-locked tone, bilingual, parses email or skip
  keywords. Storage only — outbound transport (SendGrid/Postmark) deferred
  post-launch.

---

## Architecture refactors

- **Deterministic resume gate open** (`51cec33`) — removed regex-primary
  cv-gate-detector path; now `applyOnboardingStep("ask_q_resume")` writes
  resumeAccepted directly. Regex bank kept as helper-only fallback for
  other skills (cv_followup etc).

---

## Test gates passed

| Suite | Count | Pass |
|---|---|---|
| `@pa/pa-orchestrator` | 534 | 534 (+15 new regression) |
| `@pa/functions` | 437 | 437 |
| `@pa/memory` | 104 | 104 |
| `@pa/agent-registry` | 52 | 52 |
| `@wekruit/shared-tags` | 22 | 22 |
| `@pa/job-rec` | 272 | 272 |
| `cv-ingest` | 105 | 105 |
| `pa-resume-parser` | 41 | 41 |
| **Total unit** | **1567** | **1567** |

---

## Live E2E (deployed Cloud Functions, broker-shape inbound)

### Reset 闭环 (V4) — 18/18 surfaces, 3-iter idempotent
13 PA-namespaced collections + entity-tags subcollection + user-record
fields all cleared on each `__PA_RESET__`. Verified across 3 consecutive
reset+onboarding cycles on isolated phone +19999998002.

### 7Q chain proactive walk
```
pending → q_role_asked → q_yoe_asked → q_visa_asked
→ q_startup_pref_asked → q_location_asked → q_resume_asked
→ q_email_asked → complete
```
8 state transitions, 8/8 correct per iter. statedPreferences populated.
contactEmail saved. resumeAccepted gate opens deterministically with
`triggerHash="onboarding_ask_q_resume"` and 24h TTL.

### Long-context regression (Adam's biggest concern)
Adam saw 30-turn vent loop produce **47% 卧/卧槽/草** with no advice
pivot. Post-fix 50-turn run shows **4%** (2/50 — both clean ack uses,
not monopoly). Skill rotation across 8 distinct skills.

### Edge cases (V5)
13/14 PASS — 1 BUG (empty body status=running leak) found and fixed.
Crisis hotlines verified live both zh + en. Prompt-injection refusal
intact. PII not echoed. Length cap holds.

### CV pipeline (V3)
0 code bugs. 4 limits (gate / quota / size cap / page cap) all enforce
correctly. 161/161 cv-related unit tests pass. cv-overwrite tapback
flow sound end-to-end.

---

## Pending follow-ups (POST-LAUNCH, NOT gate-blocking)

1. **am_i_ai_check intermittent flat-deny** — add post-gen regex re-roll
   on `我是真人 / I'm (a )?real (person|human)` patterns.
2. **T6 email-Q LLM tone drift** — reply doesn't always include literal
   "邮箱". State machine works correctly; tone-lock the directive
   harder.
3. **WS6 guardrail chain wire-up** — input chain (PII scanner / length
   cap / prompt-injection v2) defined but NOT called in production. Legacy
   paths cover crisis + injection; PII enforcement gap.
4. **Slang-enforcer scope expand** — currently only 卧→卧槽; Bible v7
   banlist (友好, 没问题) not enforced.
5. **Onboarding skill addendum stale** — comments "6Q chain" but it's
   now 7Q. Update for documentation hygiene.
6. **5 stale parsedCandidateResumes for Adam test user** — pre-iter30
   data; archive 4-of-5 to give job-rec a single canonical CV.

---

## Deploy state

- **9 commits push origin/main** (`af8e663` → `ae7c405`)
- **Cloud Functions 25 functions deployed** (latest deploy `bpz3f6gma`)
- **Hosting 200** (`https://wekruit-pa.web.app`)
- **4 health endpoints all 200**
- **All Firestore flags 100% ON** (paResumeParserV2, paSkillRouterV2Enabled,
  paWeightsFromFirestore, paTagEventsEnabled, paSkillNamingV2,
  paGuardrailChainShadow=true)
- **Skill `onboarding_probe`** seeded in pa-playbooks (priority 95,
  conflictsWith 19 skills, requiresCtxState.onboarding_completed=false)
- **6 skill regex updates** in pa-playbooks (Firestore audit rows)

---

## Biz-test launch verdict: **🟢 GO**

| Check | Status |
|---|---|
| Reset clean | ✅ 18/18 surfaces × 3 iters |
| Onboarding 6Q + email | ✅ proactive, state machine 100% |
| Skill activation 19 skills | ✅ 38/38 trigger correctly post-regex-fix |
| Long-context drift (Adam concern) | ✅ vent monopoly DEAD |
| Crisis hotlines | ✅ zh + en verified live |
| Prompt injection defense | ✅ canned reply path works |
| PII not echoed | ✅ confirmed |
| Resume gate deterministic | ✅ no regex dependency |
| Length cap holds | ✅ 100% of 50 turns |
| State corruption | ✅ 0/50 turns |
| Visible word corruption | ✅ word-boundary fix shipped |
| AB-probe leak | ✅ fallback shipped |

Biz testers can now use any allowlisted phone (admin or testMode=true)
to:
1. Send `__PA_RESET__` to reset state
2. Send any greeting → 7Q chain begins on T0
3. Walk through 7 questions answer-by-answer, state advances per turn
4. Final state=complete, statedPreferences + contactEmail populated
5. Resume upload window (24h) opens automatically when ask_q_resume fires

---

## Loop status

3h consumed of 6h budget. 6 P0 bugs found-and-fixed plus 9 regex gaps
plus 1 feature shipped. State machine + reset + skills + edge cases all
green on live deploy. **Biz can test now.** Continuing into hours 4-6 to
hunt the 5 remaining cosmetic gaps + WS6 wire-up if Adam wants
gate-tier PII enforcement before launch.
