# QA 2026-05-28 — Claire harness root-cause map (dev phone +14243201960)

Evidence: 7 read-only code investigators + 5 prod Firestore probes (zero writes).
Ground truth: all 14 QA turns resolved to pa-users **LF8blURXyFBaeF7bhupu** ("Adam Yang"),
ZERO `pa-tool-calls` the whole session, onboardingState still `pending`.

## Per-turn arbiter trace (the smoking gun)

| time | user msg | arbiterOwner | result | why it broke |
|---|---|---|---|---|
| 19:36 | hey | fallback_claire | bootstrapped_q1 `main_goal` | greeted w/ STALE "Adam"+Tesla resume |
| 19:37 | career growth+learning | shared_onboarding | asked `culture_stage` | OK |
| 19:37 | (long SWE para: 3yr/React/TS/Py/fintech/NYC/H1B/140k) | **fallback_claire** | rejected: "not an answer to culture_stage" | **richest msg DROPPED — not extracted/persisted** |
| 19:38 | "you missed role+skills" | fallback_claire | rejected (culture_stage still active) | acked, not persisted |
| 19:39 | bump 160k + crypto | fallback_claire | rejected (culture_stage still active) | acked, **160k never stored anywhere** |
| 19:40 | early startup/scale-up | shared_onboarding | asked `industry_interest` | finally answered culture_stage |
| 19:40 | Remote/NYC | fallback_claire | rejected (industry active) | **location DROPPED** (re-asked later) |
| 19:41 | what do you remember | (memory cmd) | listed pa-memory-facts | only 2 onboarding facts (see C) |
| 19:42 | show me roles | **job_search / status_then_async_tool** | "let me dig up matches" | **async find-match NEVER ran — toolCallIds=[], 0 tool-calls, 0 job links** |
| 19:45 | Ok | shared_onboarding | **reasked** `industry_interest` | short-ack to active slot → re-ask loop |
| 19:45 | Yes | shared_onboarding | **reasked** `industry_interest` | same |
| 19:46 | Fintech/AI/crypto | shared_onboarding | asked `location_relocation` | re-asks location (already given 19:40) |
| 19:47 | remote/NYC + burned out | shared_onboarding | asked `special_context` | ignored burnout tone |
| 19:47 | H1B+160k non-neg; which roles first | explicit_explanation | "going to send strongest…" | another empty promise, no tool |

## Root causes

**A — Onboarding never converges; out-of-slot facts dropped.** Shared-onboarding is a rigid
single-slot Q&A. Any msg that isn't an answer to the *currently active* slot → arbiter rejects →
`fallback_claire` acks conversationally but does NOT extract/persist or advance. Short acks
("Ok"/"Yes") to an active slot → re-ask same question. 14 turns, still `pending`, user repeats self,
location asked twice. THE core "endless intake loop" failure.

**B — job_search async tool never delivers.** Arbiter correctly routes "show me roles" →
`job_search` / `status_then_async_tool`, emits the "let me pull" status, but the async `find-match`
never executes / never posts back (`conversationToolCallIds=[]`, 0 `pa-tool-calls`, 0 job links in
17 outbound). Recs are structurally undeliverable. THE core "no roles ever" failure.

**C — three disconnected preference stores.** Onboarding writes `statedPreferences`
(now has visaStatus=sponsorship_needed, yoe, industry, locations, companySize). Matcher reads
`tags.*` (visaStatus/minSalary undefined → hard filters never apply). Recall reads
`pa-memory-facts` (only onboarding-confirmed → missed everything). `minSalary` 160k captured by
NONE. Nothing syncs them.

**D — reset incomplete + leaks internals.** Reset clears `firstName`/onboardingState but NOT
`displayName` ("Adam Yang") nor resume linkage (`derivedExperience`/`latestResumeArtifactId`/
`sharedOnboarding.promptContext` — still holds the full Tesla resume summary). So cold-start
re-greets stale. Reset reply also dumps internal counts verbatim ("qdrant pa_memory=0; firestore
pa-memory-facts=13…"). `summarizeClearResult` → needs candidate-facing copy.

**E — humanizer drops a space.** Outbound corruptions confirmed: "atarget", "missedthe",
"$160kand", "dig upmatches", "sendstrongest". A transform in the humanize/imperfection layer
(paHumanizeRuntimeEnabled ON) deletes one space at a join boundary. Exact line not yet pinned
(investigator 40% conf) — needs a decisive dig.

**F — reflex/tapback misfires.** (1) short-ack "Ok" to a statement → full text not tapback
(conversation-action-arbiter.ts:187). (2) tapback co-occurs with text — `outbound-delivery-plan.ts`
BASE_WEIGHTS assigns tapback modes with no sentiment gate. (3) heart tapback on `__PA_RESET__` —
`isControlOrPrivacyIntent` (conversation-turn-arbiter.ts:414) doesn't match `__*__` controls.

**G — identity dup (latent; dev-phone only).** 2 pa-users share +14243201960:
8fE (Shixiang/Tesla resume/63 skills/roleFunction/careerStage) + LF8 (Adam/the conversation/no
skills/no roleFunction). Live inbound resolved LF8 all session, so LF8 lacks the resume-derived
tags → starves the matcher even when find-match runs. Resolver `.where(phoneE164).limit(1)` has no
`orderBy` → latent flap risk. Blast radius = 1 of 194 phones, 0 email dups (NOT platform-wide).

## Fix plan
- B (recs async delivery), C (store unify: onboarding→tags + recall reads tags/statedPreferences +
  capture minSalary), D, E, F, H, G(merge 8fE→LF8 + deterministic resolver): clear bugs, clear fixes.
- A (onboarding convergence): direction decision — see questions.

## UPDATE (2026-05-28, post-eval-recon) — the eval was a green wall too; failures are onboarding-gated

**Both test layers are false-greens (Adam's thesis, proven):**
- Unit tests: `makeStore` has no `db` → `getFlag` returns false → every flag reads OFF → the
  suite tests the PRE-rebuild (flag-OFF) path, never the live canary (flag-ON). Fixed my B test
  by seeding a real flag doc; proven RED→GREEN. (See memory `flag-gated-tests-false-green`.)
- P0 "process-intact" eval (`runner.mjs`, the predeploy BLOCKING gate): uses
  `extractor_simulated_patch` + `matcher_simulated_result` — it SIMULATES the extractor's output
  then grades a DB it pre-seeded with the answer. Ran it: `avoid-swe-after-onboarding.json` =
  **PASS / exit 0** while the SAME case fails live. Green wall by design.

**The real-seam canary tells the truth and is GREEN for the COMPLETED-user path:**
`agent-jobsearch-canary.mjs` (real `maybeRunExtractor` + real `run(agent)` + find-match, grades the
DB snapshot) → turn1 extractor REPLACES `["software_engineering"]`→`["product_management"]` (the
#245 additive/parse bug is fixed+deployed), turn2 agent CALLS find-match, matcher sees product-only.
So the agent architecture works WHEN REACHED. BUT it's `onboardingState=complete`; the live QA user
was `pending`.

**Refined root cause: the failures are ONBOARDING-GATED.** While `onboardingState=pending`:
out-of-slot facts ("160k", "H1B") never trigger the durable-preference extractor → don't persist;
"show me roles" turns are consumed by the onboarding/fallback path → never reach the working
agent→find-match; short-acks re-ask the active slot.
→ **A (agentic extract-first onboarding) is the keystone; it subsumes B + C for the mid-onboarding
case.** B + E are committed in worktree `fix/claire-harness-qa-2026-05-28` as INTERIM nets (unpushed),
to be removed in P1/P6.

**P0-done-right (eval fidelity):** promote the real-seam runners (`agent-*-canary.mjs`,
`llm-runner.mjs`) to the blocking gate; demote the simulated `runner.mjs`. Add a NEW mid-onboarding
fixture (pending user volunteering out-of-slot facts) → goes RED = the correct baseline the
migration must turn green.

## Workstream-1 (soft/hard buffer + enrich + website) — separate swarm, plan in
`.planning/INITIATIVE-soft-hard-preferences.md`. 3 open product decisions (buffer %, which axes get
the hard/soft question, hard-salary-keeps-null-jobs).
