# Onboarding Refactor — Real-Machine Checklist (Layer 3, Adam UAT)

> **P10 owner**: blocks ship until 5/5 green. Run AFTER:
> 1. P9 returns [P9-INTEGRATION-COMPLETE]
> 2. Layer 1 (110+ unit cases) all pass
> 3. Layer 2 (8 sim files) all pass
> 4. Deploy to wekruit-5f89b complete
> 5. E2E 20-iter PASS

## Setup

- Test phone: Adam's iMessage (real device)
- Trigger word: `__PA_RESET__` to start fresh

---

## Check 1 — q_lang exact_match

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Send `__PA_RESET__` | bot acks reset |
| 1.2 | Send `Hi` | bot first_mes + asks q_lang |
| 1.3 | Send `English` | bot advances to q_email (NO re-ask) |

**Verify**: `pa-users.{userId}.statedPreferences.preferredLang === "en"` AND `pa-users.{userId}.tags.preferredLang === "en"`

---

## Check 2 — Adam pain points (location parser regression)

After completing q_lang/email/tos/role/yoe/visa/startup_pref:

| Step | Adam types | Expected behavior | Old behavior (broken) |
|------|------------|-------------------|----------------------|
| 2.1 | `In USA is good` (at q_country) | bot stores `country=usa`, advances to q_location | (was lumped — re-ask loop) |
| 2.2 | `Everywhere is fine` (at q_location) | bot stores `targetLocations=["anywhere"]`, advances | re-ask: "city / region / or 'remote'" |
| 2.3 | `sfran or nYC works` (re-test alt path) | bot stores `targetLocations=["sf","nyc"]` | "other" → re-ask |
| 2.4 | `不知道` (at q_location) | bot re-asks ONCE with clarifying Q | infinite re-ask |

**Verify**: `pa-users.{userId}.statedPreferences.targetCountry === "usa"`, `targetLocations` contains expected canonical tokens.

---

## Check 3 — Visa (OPT no longer separate option)

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | At q_visa, send `I'm on OPT` | bot maps to `visaStatus="sponsorship_needed"` (D4 compliance), advances |
| 3.2 | (Alt path) Send `Need sponsorship` | same canonical token |
| 3.3 | Inspect prompt text | NO standalone "OPT" listed in prompt — should be `citizen / GC / need sponsorship (incl. OPT/CPT/H1B)` |

**Verify**: `tags.visaStatus === "sponsor_needed"` per CLAUDE.md D4.

---

## Check 4 — DiscussionPhase: resume async ack pattern

| Step | Action | Expected | Time |
|------|--------|----------|------|
| 4.1 | At q_resume, send PDF attachment | bot replies INSTANTLY: "got it, reading through your resume..." (≤2s) | t+0 |
| 4.2 | Immediately send another msg `tell me a joke` | bot replies: "稍等 / hold on, still reading" (NOT generic ignore) | t+5 |
| 4.3 | Wait 30-60s for cv-ingest | bot fires analysis: "I see you have <skills>, <projects>, 对吗?" | t+30~60 |
| 4.4 | Reply `yeah looks right` | bot acknowledges + transitions to general chat / matching | t+~ |

**Verify**:
- `pa-users.{userId}.onboardingState` transitions: `q_resume_asked` → `q_resume_processing` → `q_resume_done` → `complete`
- `pa-orchestrator-logs` shows `pa.onboarding.discussion.resume.ack`, `pa.onboarding.discussion.resume.processing_hold`, `pa.onboarding.discussion.resume.analysis_sent`
- NO duplicate "still waiting" prompts (Bug A regression check)

---

## Check 5 — Personalized rec reasoning post-CV

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | After Check 4 completes, bot triggers job-rec | rec body cites SPECIFIC CV item (e.g. "your Tesla V&C portfolio") |
| 5.2 | Inspect prod log | `pa.match.nuanced_reason_ok` fires, `usedTier=primary` `usedModel=gpt-5.4-nano` |
| 5.3 | Confirm NO 401 | `pa.match.nuanced_reason_failed` count = 0 in 10-min window |
| 5.4 | Reply `tell me about role 1` | bot enters general agent runtime, free-form discussion |

**Verify**: `pa-messages` has assistant body with literal company/project names from Adam's CV (Tesla, ESL, OFO, etc), NOT "skill X+Y 跟核心技能对得上" template.

---

## Failure handling

If any check fails:
1. P10 captures: timestamp, userId, prod log span (3 min around incident)
2. NO ship until root cause identified
3. P10 either spawns hotfix P7 or rolls back to baseline (env-aliasing cleanup b4225f3 was last green state)

## Sign-off

| Check | Result | Verifier | Timestamp |
|-------|--------|----------|-----------|
| 1 — q_lang | ⬜ | Adam | |
| 2 — location pain points | ⬜ | Adam | |
| 3 — visa OPT mapping | ⬜ | Adam | |
| 4 — resume DiscussionPhase | ⬜ | Adam | |
| 5 — personalized rec reasoning | ⬜ | Adam | |

**Ship gate**: ALL 5 ✅ → P10 marks acceptance complete in `.planning/STATE.md`.
