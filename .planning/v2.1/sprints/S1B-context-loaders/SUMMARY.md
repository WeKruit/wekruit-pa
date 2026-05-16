# S1B Context Loaders — SUMMARY

> Sprint: v2.1 S1B
> Branch: `claude/v21-S1B-context-loaders` (from `claude/v21-S0-foundation`)
> Worktree: `.claude/worktrees/v21-S1B-context-loaders` (removed post-merge)
> Status: Code-complete, tests green, integrated into `claude/v21-integration`.

## What landed

Pre-call context assembly read-side for the LiveKit voice worker (S2). Three pure loader functions hitting Firestore + identity-bridge, returning the typed `VoiceCallContext` consumed by `worker.ts → entry(ctx)`.

| Loader | Purpose |
|---|---|
| `loadUserProfileForVoice(paUserId)` | candidate name, preferredLang, consentStatus, prior-call summary |
| `loadJobBriefForVoice(paJobId)` | role, employer, jobBrief (≤200 tok), dead flag |
| `loadPrescreenConfigForVoice(paJobId)` | question set, hard-stop policy, scoring weights |

## Files added

- `apps/functions/src/voice/context-loaders/loadUserProfileForVoice.ts`
- `apps/functions/src/voice/context-loaders/loadJobBriefForVoice.ts`
- `apps/functions/src/voice/context-loaders/loadPrescreenConfigForVoice.ts`
- `apps/functions/src/voice/context-loaders/__tests__/*.test.ts`
- `apps/voice-agent/src/voice-context-types.ts` — mirrored type contract (no cross-import to functions/, avoids voice-agent depending on firebase-functions)

## Locks held

- L5 identity bridge — loaders reject if `paUserId|paJobId` missing on `outbound-bookings/{id}`.
- L11 single-source — `loadPrescreenConfigForVoice` reads from same `pa-jobs/{jobId}.prescreenConfig` that PreScreenPipeline.runTurn consumes.

## Hand-off

S2 `worker.ts → entry(ctx)` calls these via `defaultLoadContext(bookingId)` (currently throws — production wire-up handled by S3 dial-outbound CF which already has bookingId context).

## Tests

Unit tests for shape + null-safety + dead-job branch. Integrated into `apps/functions` test glob.
