# S2 Voice Bridge — AGENT_PLAN

> Worktree: `.claude/worktrees/v21-S2-voice-bridge`
> Branch: `claude/v21-S2-voice-bridge`
> Base: `claude/v21-integration` (contains S0 + S1A + S1B + S1C)
> Author: P8 sub-agent (Opus 4.7), spawned by P10.

## 1. Mission (one-liner)

Ship the LiveKit Agents worker that bridges a SIP-connected outbound call to
`PreScreenPipeline.runTurn` and deploys to **LiveKit Cloud managed agent
hosting** (L12). Each VAD-committed user turn → one `runTurn` invocation →
agent text streamed through the S1C shim → spoken via Deepgram Aura-2. Folds
in task #12 (S1A↔S1C adapter) so the shim's `orchestrator` backend mode
becomes real.

## 2. Language + package decision

**Language: Node.js / TypeScript.**

Rationale:

- Repo is TS-dominant (every `apps/*` and `packages/*` is TS ESM, Node ≥20).
- `@livekit/agents` ships a Node SDK that fully supports voice (VAD, STT, TTS,
  LLM, AgentSession + events) — confirmed via LiveKit Voice AI docs.
- Sharing the lockfile + tsconfig + workspace alias resolution (`@pa/*`) means
  S1B context loaders import natively without a second runtime.
- LiveKit Cloud managed agent hosting accepts either Node or Python entries
  (per LK Cloud docs); no penalty for Node.
- The orchestrator-backend adapter (task #12) lives inside
  `apps/voice-llm-shim/` (already TS) — keeping S2 TS avoids a second language
  boundary in the same sprint.

**Package path: `apps/voice-agent/`** as a workspace child of
`pnpm-workspace.yaml` (already globs `apps/*`).

**Package name: `voice-agent`** (private, unpublished). Filter:
`pnpm --filter voice-agent test`.

## 3. Architecture

```
                   LiveKit Cloud Room (dispatched by S3)
                                │
                                │ metadata = { bookingId }
                                ▼
                  ┌─────────────────────────────┐
                  │  voice-agent worker         │
                  │  (LiveKit Agent process)    │
                  │                             │
                  │  entry(ctx):                │
                  │   1. parse bookingId        │
                  │   2. load context (S1B)     │
                  │   3. build AgentSession w/  │
                  │      Silero VAD,            │
                  │      MultilingualModel,     │
                  │      Deepgram Nova-3 STT,   │
                  │      Aura-2 TTS,            │
                  │      openai.LLM → shim URL  │
                  │   4. register 7 handlers    │
                  │   5. speak L8 consent       │
                  │      prompt as 1st utterance│
                  └──────┬──────────────────────┘
                         │ user audio frames
                         ▼
                  STT (Deepgram Nova-3)
                         │
                         │ final transcript
                         ▼
              user_input_transcribed (isFinal=true)
              + agent_false_interruption (S4 hook)
                         │
                         ▼
                  ┌─────────────────────────┐
                  │  TurnLoop.onUserCommit  │
                  │  - PII gate (L6)        │
                  │  - PreScreenPipeline    │
                  │      .runTurn(input)    │
                  │  - emit agent text      │
                  │  - if SMS handoff,      │
                  │    mark turn-output     │
                  │    flag (no TTS)        │
                  └──────┬──────────────────┘
                         │ agent text
                         ▼
                  PII handler (L6 redactor)
                         │
                         ▼
                  TTS (Aura-2) speaks reply
                         │
                         ▼
              conversation_item_added (logged)
              session_usage_updated (S4 hook)
                         │
                         ▼
              close / participant_disconnected / ErrorEvent
              → graceful shutdown + write nothing to Firestore
                (S3/S4 own writes)
```

### Why the `openai.LLM → shim → orchestrator-backend` adapter still matters

The voice bridge invokes `PreScreenPipeline.runTurn` directly (it's the
scoring brain, returns deterministic emit text). The shim is wired so that:

- LiveKit's `openai.LLM` plugin has a real backend during session bring-up.
- The `composeClarify` LLM callback inside `PreScreenPipeline` *can* be routed
  through `runAgentTurnStream` via the shim's `orchestrator` backend in S5/S6
  (out of v2.1 scope to enable, but the plumbing is in place).
- Task #12: S1A↔S1C signature mismatch is closed in this sprint —
  `orchestrator-backend.ts` adapter inside `apps/voice-llm-shim/src/runtime/`.

The default flag in v2.1 dev = the **fake** backend, so the LiveKit `openai.LLM`
plugin echoes during smoke. We don't depend on the adapter for the core S2
acceptance path; we only require the adapter to be tested and behind
`WEKRUIT_LLM_SHIM_BACKEND=orchestrator`.

## 4. Event handler mapping (LiveKit Node SDK names)

Per LiveKit Node SDK / `@livekit/agents` docs (`AgentSessionEventTypes` enum):

| P10 spec name (L7) | LiveKit Node SDK event | Source object |
|---|---|---|
| `user_speech_committed` | `AgentSessionEventTypes.UserInputTranscribed` filtered on `event.isFinal === true` | `session.on(...)` |
| `conversation_item_added` | `AgentSessionEventTypes.ConversationItemAdded` | `session.on(...)` |
| `agent_false_interruption` | `AgentSessionEventTypes.AgentFalseInterruption` | `session.on(...)` |
| `participant_disconnected` | `RoomEvent.ParticipantDisconnected` | `ctx.room.on(...)` |
| `ErrorEvent` | `AgentSessionEventTypes.Error` (or `"error"` string) | `session.on(...)` |
| `session_usage_updated` | `AgentSessionEventTypes.SessionUsageUpdated` | `session.on(...)` |
| `close` | `AgentSessionEventTypes.Close` | `session.on(...)` |

The voice-agent module exports a `registerEventHandlers(session, room, sinks)`
function so tests can register against a mock session/room and assert each of
the 7 handler kinds were registered (one assertion per kind). `sinks` is the
S4-facing listener registry (per-turn metric hook + cost hook), defaulting to
no-ops in v2.1.

## 5. PII handler (L6)

Module: `apps/voice-agent/src/pii-handler.ts`.

```ts
export type PiiHandlerInput = {
  agentText: string;
  profile: VoiceUserProfile;
};

export type PiiHandlerOutput = {
  speakText: string;            // safe to TTS
  smsHandoffTokens: string[];   // [] when no PII detected
  redacted: boolean;
};

export function redactForVoice(input: PiiHandlerInput): PiiHandlerOutput;
```

Rules:

1. If `profile.piiConsentAt` is a non-empty ISO string → **passthrough**
   (`redacted: false`, no token rewrite).
2. Else run 4 regex passes over `agentText` (case-insensitive, Unicode
   word-boundary aware):
   - **email** `\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`
   - **E.164 phone** `\+?[1-9]\d{6,14}\b`
   - **dollar amount** `\$\s?\d{1,3}(?:[,\d]{3})*(?:\.\d+)?` or `\b\d{2,3}k\b`
   - **http(s) URL** `https?://\S+`
3. Replace each match with `[sms_handoff:<kind>:<index>]` and record the
   redacted slice + kind in `smsHandoffTokens` so an orchestrator-side SMS
   dispatcher can fan it out later (S5 wires the actual dispatch; S2 only
   marks).
4. Voice output `speakText` is the redacted string; if the entire utterance
   ended up redacted to whitespace only, return `speakText: ""` and let the
   caller emit a generic "I'll text you that" filler.

The handler is pure (no Firestore, no Sendblue) — easy to unit test.

## 6. Turn loop

Module: `apps/voice-agent/src/turn-loop.ts`.

```ts
export interface TurnLoopDeps {
  pipeline: PreScreenPipeline;
  loaders: {
    userProfile: VoiceUserProfile;
    jobBrief: VoiceJobBrief;
    prescreenConfig: VoicePrescreenConfig;
  };
  pii: typeof redactForVoice;
  log?: (event: string, payload: Record<string, unknown>) => void;
  /** S4 hook — invoked once per completed turn with metrics scaffolding. */
  onTurn?: (turn: TurnEvent) => void;
}

export type TurnEvent = {
  qIdBefore: string | null;
  qIdAfter: string | null;
  action: RunTurnResult["action"];
  redacted: boolean;
  emitChars: number;
  ttfaMs?: number;
};

export function createTurnLoop(deps: TurnLoopDeps): {
  onUserCommit: (input: { reply: string; nowIso: string; lang: Lang }) => Promise<string>;
};
```

The returned `onUserCommit`:

1. Calls `pipeline.runTurn({ sessionId: <bookingId>, reply, lang, nowIso, judgeCtx })`.
   - `judgeCtx` constructed from `loaders.userProfile.skills` + `loaders.jobBrief.requiredSkills` (existing JudgeCtx shape; placeholder values are acceptable for v2.1 dev — the runner builds real ones).
2. Applies `pii.redactForVoice` to `result.text` with `loaders.userProfile`.
3. Calls `deps.onTurn` with the metric event.
4. Returns `speakText` for the agent to TTS.

The voice-agent entrypoint then calls `session.say(speakText)` (or the
equivalent `AgentSession.say` in Node SDK) to speak it.

## 7. Recording consent (L8)

The first agent utterance (before any user audio) is a deterministic localized
string keyed off `loaders.prescreenConfig.voiceMode` and
`loaders.userProfile.preferredLang`:

```
en: "Hi! This is Claire from WeKruit. This call is being recorded for
     quality. Reply STOP any time to end the call. Ready to start?"
zh: "你好，我是 WeKruit 的 Claire。本次通话将被录音以便质量管理。任何时候说
     'STOP' 即可挂断。准备好了吗？"
```

Implementation: call `session.say(consentLine, { addToChatCtx: true })` inside
`entry(ctx)` immediately after the session starts. Recording is enabled by
`session.start({ room, agent, output: { audio: { sample_rate: 24000 } }, ... })`
plus LiveKit's `recordings` API which we leave for S5/S6 to wire to the GCS
bucket; S2 only ensures the consent prompt fires.

## 8. Adapter (task #12) inside `apps/voice-llm-shim/src/runtime/`

Files to ADD (not edit existing):

- `apps/voice-llm-shim/src/runtime/orchestrator-backend.ts` — exports
  `createOrchestratorBackend()` returning a `RunAgentTurnStream`.
- `apps/voice-llm-shim/src/__tests__/orchestrator-backend.test.ts` — adapter
  tests (messages-to-AgentTurnContext mapping, finishReason coercion).

Edits to existing files (minimal, additive):

- `apps/voice-llm-shim/src/runtime/resolve.ts` — when backend === `"orchestrator"`,
  delegate to `createOrchestratorBackend()` rather than the current "look up
  mod.runAgentTurnStream then return raw" path that doesn't match shapes.

Adapter contract:

```ts
import { runAgentTurnStream } from "@pa/agent-runtime"; // S1A export
import type { AgentTurnContext } from "@pa/agent-runtime";
import type { RunAgentTurnStream } from "./contract.js";

export function createOrchestratorBackend(opts?: {
  /** Default agent definition used for voice — provider/model/system prompt. */
  agent?: AgentTurnContext["agent"];
  systemPromptFallback?: string;
  logger?: ResolveLogger;
}): RunAgentTurnStream;
```

Implementation outline:

1. Extract last user message → `userMessage`.
2. Extract leading system message(s) → joined into `systemPrompt`. If no system
   message present, fall back to `opts.systemPromptFallback ?? "You are
   WeKruit voice assistant."`.
3. Convert remaining `messages[]` minus the last user → `history` array of
   `ChatMessage` (`{ role, content }`).
4. Build `AgentTurnContext`:

```ts
{
  agent: opts.agent ?? {
    id: "voice-shim",
    provider: "openai",
    model: req.model ?? "gpt-4o-mini",
    name: "voice",
  } satisfies AgentDef,
  systemPrompt,
  history,
  userMessage,
}
```

5. For-await `runAgentTurnStream(ctx)`:
   - Map each `{delta, finishReason}` to shim contract chunk.
   - `finishReason === "error"` → emit one final chunk with `delta: ""`,
     `finishReason: null`, log the error via logger; the handler's caller
     (`handler.ts`) treats a terminal `null` as `"stop"` so the SSE close
     stays graceful.
   - Drop `usage` field (shim contract chunk shape lacks `usage`).

The adapter never throws — errors are mapped to a terminal `null`
finishReason and logged.

## 9. Tests

### `apps/voice-agent/src/__tests__/`

| Test | What it asserts |
|---|---|
| `turn-loop.test.ts` | End-to-end turn loop: mock pipeline returns text, PII handler runs, `onTurn` fires with action kind, `speakText` returned. |
| `pii-handler.test.ts` | (a) consent present → passthrough. (b)–(e) email / phone / URL / $ amount redacted to `[sms_handoff:*]`. (f) multi-PII compound. (g) empty input. |
| `event-handlers.test.ts` | `registerEventHandlers(session, room, sinks)` calls `session.on(...)` 6× with the correct AgentSessionEventTypes constants and `room.on(...)` 1× with `RoomEvent.ParticipantDisconnected`. Asserts via spy. |
| `no-min-endpointing.test.ts` | Greps `apps/voice-agent/src/**/*.ts` for the literal substring `minEndpointingDelay`. Fails if found. |
| `graceful-close.test.ts` | Simulates `participant_disconnected` and `Error` event → asserts cleanup callback ran exactly once each. |
| `consent-prompt.test.ts` | When `entry(ctx)` runs with a happy-path context, first `session.say()` argument is the consent line for `preferredLang`. |
| `agent-help.test.ts` | `apps/voice-agent/bin/cli.mjs --help` exits 0 and prints usage. |

### `apps/voice-llm-shim/src/__tests__/orchestrator-backend.test.ts`

- maps OpenAI `messages[]` (system + user + assistant + user) → `AgentTurnContext`
  with correct `userMessage`, `history`, `systemPrompt`.
- emits chunks from a mocked `runAgentTurnStream` (using `__forTesting.override`).
- coerces `finishReason: "error"` → terminal `null` + logger.warn called.
- behind `WEKRUIT_LLM_SHIM_BACKEND=orchestrator` env, resolver returns the
  adapter not the fake.

## 10. Deployment to LiveKit Cloud (L12)

Config file: `apps/voice-agent/livekit.toml` (per LK Cloud agent hosting
docs):

```toml
[project]
subdomain = "wekruit-prescreen"

[agent]
name = "voice-prescreen"
runtime = "node20"
entry = "dist/cli.js"
```

Build + deploy command (captured in final report; not invoked in this sprint
since L12 says "managed hosting" and Adam is the deployer of record for
real telephony):

```bash
cd apps/voice-agent
pnpm --filter voice-agent build
lk agent deploy
```

`Dockerfile`, `k8s/*`, `docker-compose.yml` — **none of these files exist** in
the deliverable. LK Cloud builds the container from the `livekit.toml`. This
is enforced by an `acceptance.test.ts` that asserts none of those paths exist
under `apps/voice-agent/`.

## 11. Environment variables S2 reads

| Var | Source | Purpose |
|---|---|---|
| `LIVEKIT_URL` | `.env` (Adam) | LiveKit Cloud project URL |
| `LIVEKIT_API_KEY` | `.env` | LK auth |
| `LIVEKIT_API_SECRET` | `.env` | LK auth |
| `DEEPGRAM_API_KEY` | `.env` | Nova-3 STT + Aura-2 TTS |
| `WEKRUIT_LLM_SHIM_URL` | `.env` (S1C) | `openai.LLM(base_url)` target |
| `PA_AGENT_RUNTIME_STREAM_ENABLED` | hardcoded `"true"` in worker entry | Flip S1A flag |
| `WEKRUIT_VOICE_RECORDINGS_BUCKET` | `wekruit-voice-recordings` (default) | S5 will wire actual recording |
| `WEKRUIT_LLM_SHIM_BACKEND` | `fake` default, `orchestrator` in shim CI test | Backend selection (shim, not worker) |

No new secrets introduced by S2.

## 12. Atomic commit sequence

1. `chore(voice-agent): scaffold apps/voice-agent package`
2. `feat(voice-llm-shim): orchestrator-backend adapter for S1A↔S1C bridge (task #12)`
3. `feat(voice-agent): PII redaction handler for L6 SMS handoff`
4. `feat(voice-agent): turn loop wiring PreScreenPipeline + S1B loaders`
5. `feat(voice-agent): AgentSession event handlers (L7 — all 7 registered)`
6. `feat(voice-agent): LiveKit Agent entrypoint + recording consent prompt (L8)`
7. `feat(voice-agent): LiveKit Cloud livekit.toml + dev launcher`
8. `test(voice-agent): unit suite for turn loop, PII, events, consent, CLI`
9. `test(voice-llm-shim): orchestrator-backend adapter + resolver wiring`

Each commit is buildable + tests pass. NO `--no-verify`.

## 13. Out of scope (handoff)

- **S3 owns**: actual `paVoiceDialOutbound` CF, `outbound-bookings` write
  schema, room dispatch with `bookingId` metadata. S2 exposes the ingress
  contract (`bookingId` from room metadata) but doesn't write that path.
- **S4 owns**: turn-telemetry writer to `voice-call-metrics/{callSid}`. S2
  exposes `TurnLoopDeps.onTurn` and `registerEventHandlers(... sinks)`.
- **S5 owns**: TCPA gate enforcement, GCS recording archive wiring,
  SMS-handoff dispatch fed by `PiiHandlerOutput.smsHandoffTokens`.
- **S6 owns**: 10-call internal smoke + audit.

## 14. Open risks / questions for P10

- LiveKit Node SDK event name spellings: docs surface `AgentSessionEventTypes`
  enum but not every name; if `UserInputTranscribed` isn't in Node SDK we'll
  fall back to `ConversationItemAdded` filtered on `item.role === "user"`.
  Test will tolerate both.
- `session.say()` exists in Python; Node may use `session.speak()` or
  `agent.publish_speech()`. We will adapt at code-time via the SDK's actual
  surface and update this plan if it diverges.
- `inference.LLM` vs `openai.LLM` Node-side: GOAL-PROMPT specifies
  `openai.LLM(base_url=...)`. We use that to keep shim-URL routing
  deterministic. (`inference.LLM` is LK Inference, not BYO LLM.)

— end plan —
