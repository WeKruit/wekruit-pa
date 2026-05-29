# Thin Claire — Wave B integration (assembly + flag-gated cutover)

Branch `claude/thin-PB` = `claude/thin-P0` (Wave 0) + the 5 Wave-A branches merged
(disjoint files, conflict-free) + Wave-B assembly. Default OFF — legacy path unchanged.

## What Wave B added
- **`claire-agent/sdk.ts`** — THE zod-4 fix (BLOCKER #1). apps/functions pins zod@3 but
  `@openai/agents-core@0.8.5` needs zod@4; a static `import {tool} from "@openai/agents"`
  gets esbuild-inlined against zod@3 → runtime crash. sdk.ts loads the SDK + zod DYNAMICALLY
  via `createRequire(import.meta.url)` (prod: deploy runtime package.json pins zod@^4.3.6 +
  @openai/agents → zod@4 at the function root; same mechanism as prescreen-agentic-turn.ts).
  All claire-agent modules import `tool/Agent/run/z` from here — one zod@4 instance.
- **`agent.ts`** — `buildClaireAgent` (tools + guardrails + typing reflex) + `runClaireTurn`
  (mark-read reflex → run() with a 60s timeout + grounded fallback [RC2 never-hang] →
  guardrail-tripwire handling [crisis hotline / injection no-reply] → normalize + deliver).
  Injects canonical pa-users.tags as global context [RC3].
- **`prompt.ts`** — full Claire persona + slang + delivery rules + triage/onboarding/prescreen
  mode directives + flexibility + few-shot. Voice lives here (RC4: no "scratch that" injector).
- **`cutover.ts`** — `maybeRunThinClaire(db, eventId)`: flag-gated, FAIL-SAFE (any miss → false →
  legacy still replies). Wired into `index.ts` (onPaInbound) + `paMessageCoalescer.ts` (primary).
- **`admin-bootstrap.ts`** — seeds `paThinClaireEnabled` (perUser, default OFF, 424 allowlist).
- Rewired the 3 tool builders + proactive.ts off static `@openai/agents`/`zod` onto `sdk.ts`.

## Eval gates (integrated tree, run from the worktree)
| Gate | Status | How to run |
|---|---|---|
| **L3 integration — canary two-turn** (the goal's "deployed-handler L3 instance") | **GREEN ✅ 9/9** | `node apps/eval/thin-claire/eval-canary-twoturn.mjs` |
| L1 reducer asserts | **GREEN ✅ 21/21** | `cd apps/functions && node --import tsx --test src/claire-agent/reducers/*.test.ts` |
| POC design contract (v1/v2/v3, best-of-5) | GREEN ✅ | `node apps/eval/thin-claire/run-evals.mjs` |
| WS-process eval (L1+L3) | GREEN ✅ | `node apps/eval/thin-claire/eval-process.mjs` |
| WS-guardrail eval | GREEN ✅ | `node apps/eval/thin-claire/eval-guardrail.mjs` |
| WS-proactive eval | GREEN ✅ | `node apps/eval/thin-claire/eval-proactive.mjs` |
| tsc --noEmit | GREEN ✅ (0 new; 1 pre-existing unrelated `preview-batch.ts:566`) | `cd apps/functions && npx tsc --noEmit` |
| esbuild bundle (build.mjs) | GREEN ✅ (9.2MB < 16MB) | `cd apps/functions && node build.mjs` |

The canary proves all 4 prod root causes from LIVE-SMOKE-2026-05-29 are fixed end-to-end through
the REAL `runClaireTurn` with the zod@4 SDK loading at RUNTIME (not just building):
RC1 (avoid-SWE→drop-SWE replace+negative+full_time), RC2 (recommend completes, no hang),
RC3 (saved-pref reads canonical tags), RC4 (no "scratch that" artifact).

## HARNESS DEBT (honest RED — not a green wall)
`eval-tools.mjs` + `eval-delivery.mjs` are RED **in the integrated tree** — a TEST-HARNESS issue,
not a logic/production issue:
- both ran GREEN in their own Wave-A worktrees (slice logic proven; see commits 6f08724f / 0a270319);
- they load the production tool files via **tsx**, but `sdk.ts`'s `createRequire` (required for the
  prod zod-4 fix) bypasses tsx's tsconfig path-remap → resolves apps/functions zod@3 → a dual zod
  instance → schema-introspection crash. The fix is to convert them to the **esbuild-bundle harness**
  that eval-process / eval-proactive / eval-canary already use (resolve @openai/agents+zod external
  from a zod@4-symlinked node_modules; no tsx interception);
- their INTEGRATION is already covered GREEN by `eval-canary-twoturn.mjs` (which drives
  set_matching_preferences + find_match + mark-read/typing/status/text delivery through the real
  `runClaireTurn`). Conversion is a tracked follow-up; it does not block the Wave-C live canary.

## Wave C — ADAM-GATED (deploy + live flag + real iMessage)
Per CLAUDE.md, prod-Claire cutover + flag rollout + real iMessage to the 424 number are Adam-gated.
Staged + ready:
1. Merge `claude/thin-PB` → `main` (PR; flag default OFF → zero behavior change on merge).
2. Deploy minimum scope: `cd apps/functions && firebase deploy --only functions:pa-orchestrator:onPaInbound,functions:pa-orchestrator:paMessageCoalescer --project wekruit-5f89b --non-interactive`
   (the predeploy gate runs build+typecheck+test; admin-bootstrap seeds `paThinClaireEnabled` with the 424 allowlist on next bootstrap, or set the flag doc directly).
3. Confirm `paThinClaireEnabled` allowlist = `["8fEwIduUrzxZsblHHsNz","LF8blURXyFBaeF7bhupu"]` (the 424 canary uids).
4. Live test from +1 424-320-1960: the two-turn sequence ("done with pure SWE, only product, full-time" → "recommend me roles" → "what preferences do you have saved"); paste pa-turn-traces(completed) + pa-tool-calls(snapshot) + pa-users.tags(SWE removed, negativeRoleFunction set, full_time) + pa-outbound(DELIVERED) + the iMessage transcript.
5. Done = live 424 canary green (avoid-SWE→drop-SWE, no hang, reads tags) + eval gates green +
   legacy retired for the cohort. Then ramp the allowlist.
