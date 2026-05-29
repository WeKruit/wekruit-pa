# Live Canary Receipt — 2026-05-29 (agentic flags ON for +1 424-320-1960)

Real iMessage smoke by Adam from +1 (424) 320-1960 against **deployed main `6c6cfa50`**
with the agentic canary flags ON (`paAgenticJobSearchEnabled`,
`paAgenticOnboardingEnabled`, `paAgenticPrescreenEnabled`, `paReactionTapbackEnabled`,
`paHumanizeRuntimeEnabled` — allowlist includes uid `LF8blURXyFBaeF7bhupu` +
`8fEwIduUrzxZsblHHsNz`).

**HEADLINE: CORE TEST FAILED.** The agentic path is flag-ON but **half-built** — turning
the flag on exposed that the agentic flow does not actually work end-to-end. The goal's
P1 (job-search vertical slice) / P4 (onboarding) / P5 (preference reducer) are NOT
complete. These four root causes are non-negotiable must-fix, each backed by the
deployed-prod Firestore trace below.

User / source of truth: `pa-users/LF8blURXyFBaeF7bhupu` (onboardingState=pending). Post-test:
- `tags.targetRoleFunction = ["product_management","software_engineering"]` ← SWE NOT removed
- `tags.negativeRoleFunction = undefined` ← negative axis NEVER written
- `tags.targetJobType = undefined` ← "full-time only" lost
- `tags.targetLocations = ["san_francisco_bay_area","remote_united_states"]` ← captured OK

## Transcript (03:42–04:04 UTC)

```
03:42 user "What matching preferences are you using right now?"
03:42 Claire "Yep — I'm using AI/devtools/fintech, SF or remote, early/scale-up... Avoiding adtech/crypto."   (reads OLD statedPreferences)
03:44 user "Can you recommend me some roles?"  (sent twice — dup)
03:44 Claire 2 progress bubbles + 1 SWE role "Software Engineer - Backend & Data @ spate"
03:45 user "actually I'm done with pure software engineering — I only want product strategy / PM roles now, full-time, in SF or remote"
03:45 Claire "scratch that, Got it - I'll keep matches focused on product management/software engineering roles, SF Bay Area or remote."   ← still says software engineering
03:46 user "Ok now recommend me some roles"
03:46 Claire "One sec, checking roles against what you shared."   ← then NOTHING (turn stuck)
03:49 user "what preferences do you have saved for me now?"
03:49 Claire "scratch that, Yep — I'm using AI/devtools/fintech, SF or remote..."   ← old prefs again, switch not reflected
03:53 user "Sure"
03:53 Claire "Got it—Any non-negotiables I should keep in mind before matching you?"   ← over-replied (onboarding reask)
03:54 user "Why did you pick those roles?"   → NO REPLY (turn stuck at stage=llm running)
03:58 user "wait, what do you actually know about my background?"  (twice) → NO REPLY for 6 min, then 04:04 "scratch that, I know want to move away from pure software engineering and into product strategy..."
```

## ROOT CAUSES (deployed-prod Firestore trace, not guesses)

### RC1 — durable_preference_update ran the LEGACY regex, NOT the #245 synchronous extractor → add-not-remove  (→ P5)
- `pa-turn-traces 03:45:23`: `owner=durable_preference_update action=micro_ack extractorRan=FALSE`.
- `pa-turns 03:45:20`: `directIntent=durable_preference_update result=profile_updated` via the regex `extractLifecycleProfileUpdate` path (the #245 fallback), which **adds** product_management but does **not remove** software_engineering and never writes `negativeRoleFunction`.
- The #245 synchronous extractor (`maybeRunExtractor forceTrigger:intent_signal`) is gated behind `shouldContinueToSearch` (the durable-pref turn only force-runs the extractor when the SAME turn also requests job search). Adam split "avoid SWE" (turn 1) and "recommend" (turn 2) → gate not met → extractor skipped (`extractorRan=false`) → regex fallback → SWE survives, full-time lost, negativeRoleFunction never set.
- Result snapshot proof: `pa-tool-calls 03:46:31` find-match `userTagsSnapshot.targetRoleFunction=["product_management","software_engineering"]`, `negativeRoleFunction=undefined`.
- **Fix (P5):** the durable_preference_update reducer must ALWAYS run the structured extractor (remove the `shouldContinueToSearch` gate for intent_signal), and the extractor must express "only X / done with Y" as REPLACE + negativeRoleFunction, not append. The 717 negativeRoleFunction chain (#269) is wired but never reached because the regex fallback front-runs it on a standalone preference turn.

### RC2 — agentic job_search turn STUCK; LLM loop never completes → no reply  (→ P1)
- `pa-turn-traces 03:46:31`: `owner=job_search action=status_then_async_tool status=owner_arbitrated` (never advances to completed).
- `pa-tool-calls 03:46:31`: find-match `status=pending` (never completes).
- `pa-turns 03:54:38` + `03:58:17`: `stage=llm status=running` — the agentic LLM loop hangs in "running" forever; Steps 4/7/8 got NO reply within 75s+.
- Flag-OFF legacy path replied to every turn; flag-ON agentic path hangs. **Turning the canary on made replies WORSE for these turns.**
- **Fix (P1):** the agentic `run(agent)` job-search path must (a) actually complete and post a reply (timeout + fallback to a grounded no-match/answer), (b) close the trace `completed`, (c) drive the find-match connector to `completed`. Today it stalls at `owner_arbitrated` / `status=pending` / `stage=llm running`.

### RC3 — "saved preferences" reads OLD statedPreferences, not canonical tags  (→ gap C / data-model unify)
- `03:42` and `03:49` Claire both recited "AI/devtools/fintech, SF or remote, early/scale-up, avoiding adtech/crypto" — the OLD `statedPreferences` store — even after the 03:45 switch.
- `explicit_explanation` / saved_job_preferences_summary reads `statedPreferences`, while the matcher reads `tags.*`. Two stores, not synced (AGENTIC-ARCHITECTURE.md §3 says canonical tags are the one source; this path still reads the legacy store).
- **Fix:** the saved-preference summary must read canonical `pa-users.tags` (the same the matcher reads), so "what do you have saved" reflects the real matcher input.

### RC4 — humanizer prefixes "scratch that," + ack misreads negative as additive  (→ P6 voice + P5)
- 3 replies began "scratch that," (03:45, 03:49, 04:04) — a humanizer/imperfection artifact firing wrongly.
- 03:45 ack said "product management/**software engineering** roles" — the regex ack composed an ADDITIVE sentence from a NEGATIVE statement.
- **Fix:** (P5) ack copy must come from the structured reducer verdict (replace/remove), not the regex; (P6) the "scratch that," prefix bug in the humanizer must be found + removed.

## What this proves about the harness

The harness layers are real and green in-process (process-intact 6/6, real-seam-gate 2/2,
bfcl 8/8) — but they test the SEAMS in isolation, not the FULL flag-ON agentic path through
the deployed handler. **The canary is the integration test the harness does not yet cover.**
Add a real-seam fixture that drives the standalone two-turn sequence ("avoid SWE" turn,
THEN "recommend" turn) through the production handler with agentic flags ON, asserting:
(1) extractorRan=true on the preference turn, (2) targetRoleFunction loses software_engineering
+ negativeRoleFunction set, (3) the job_search turn completes (trace=completed, not stuck),
(4) the saved-preference summary reads tags not statedPreferences. This fixture WILL be red
against current main — correct failing baseline for P1/P4/P5.

## Reproduce
```
cd <checkout>/apps/functions
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" <repo>/.env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
node verify-smoke.mjs LF8blURXyFBaeF7bhupu "2026-05-29T03:40:00Z"
```

## Bottom line for the goal
- Deploy of main (incl. #269 717 chain) is LIVE; the chain code exists but is NOT REACHED on a standalone preference turn (RC1).
- Flag-ON agentic job_search + late turns HANG (RC2) — P1 is not actually complete.
- saved-pref summary reads the wrong store (RC3).
- humanizer "scratch that," + additive-ack bugs (RC4).
- These four are the P1/P4/P5/P6 acceptance items. Do not mark the agentic cutover done until a flag-ON two-turn canary fixture (above) is green against the production handler.
