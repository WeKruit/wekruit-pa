# AGENT_PLAN — S1C LLM Shim

P8 sub-agent owned by P10. Worktree: `.claude/worktrees/v21-S1C-llm-shim`.
Branch: `claude/v21-S1C-llm-shim`. Parent: `claude/v21-S0-foundation` (commit `249dfa4`).

## Objective

Build a stateless HTTP service exposing OpenAI-compatible
`POST /v1/chat/completions` that LiveKit Agents' `openai.LLM` plugin can call.
Internally bridges to `runAgentTurnStream` (S1A export) and converts its
async-iterable chunks into OpenAI 2024 SSE chunk format
(`data: {...}\n\n` … `data: [DONE]\n\n`).

LOCK L2 reminder: the shim is a **runtime-stream adapter**, NOT a scoring
layer. `PreScreenPipeline.runTurn` keeps its existing contract; this service
exists only to make our agent runtime callable by an OpenAI-protocol client.

## Placement decision

New package: `apps/voice-llm-shim/`.

Reasoning:

- Stack inspection: `apps/functions/` runs inside Firebase Functions runtime
  (cannot host a plain HTTP listener), `apps/pa-orchestrator/` is a CLI/seed
  package. Neither hosts a long-running HTTP server.
- No Express/Fastify in repo. Repo convention is ESM TS + native
  `node:http` + `node --test`. The shim uses these directly — zero new deps.
- L12 (LiveKit Cloud managed agent hosting) means S2 deploys the LiveKit
  agent to LiveKit Cloud; S1C produces a runnable binary the S2 owner can
  colocate with that agent (LiveKit Cloud allows sidecar / external base
  URL). Deployment strategy is owned by S2; we ship a process anyone can
  run.

Package metadata:

- Name: `@pa/voice-llm-shim`
- Type: `module` (ESM)
- Engines: `node@>=20` (matches functions `node@24`, compatible with 20+)
- Scripts: `build` (tsc), `start` (`node dist/server.js`), `dev`
  (`tsx src/server.ts`), `test` (`node --import tsx --test src/**/*.test.ts`).
- Deps: `openai` (peer for integration test only, devDep), nothing else
  needed at runtime — native `node:http` suffices.

## Contract

### Endpoint

`POST /v1/chat/completions`

**Request (OpenAI ChatCompletionCreateParams subset):**

```jsonc
{
  "model": "wekruit-prescreen-v1",     // arbitrary; passed through
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,                       // REQUIRED true (else 400)
  "temperature": 0.7,                   // ignored, accepted
  // other fields ignored
}
```

**Response (success):** SSE stream `Content-Type: text/event-stream`.

```
data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":<ts>,"model":"wekruit-prescreen-v1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":<ts>,"model":"wekruit-prescreen-v1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":<ts>,"model":"wekruit-prescreen-v1","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":<ts>,"model":"wekruit-prescreen-v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

```

**Response (stream=false or missing):** `400 application/json`

```json
{"error":{"message":"stream=true required","type":"invalid_request_error","param":"stream","code":"unsupported_param"}}
```

**Response (other errors):** OpenAI-shape error envelope, HTTP 400/500.

### S1A integration interface

We define and ship the interface NOW; S1A's real impl will satisfy it later.

```ts
// apps/voice-llm-shim/src/runtime/contract.ts
export interface AgentTurnStreamChunk {
  delta: string;                                  // additive text
  finishReason?: "stop" | "length" | null;        // null until end
}
export interface AgentTurnStreamRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
}
export type RunAgentTurnStream =
  (req: AgentTurnStreamRequest) => AsyncIterable<AgentTurnStreamChunk>;
```

Backend resolution (in `apps/voice-llm-shim/src/runtime/resolve.ts`):

1. Default `runAgentTurnStream` = fake echo backend. Useful for dev + tests.
2. When `WEKRUIT_LLM_SHIM_BACKEND=orchestrator`, dynamically `import(
   "@pa/pa-orchestrator")` and look up `runAgentTurnStream` export. If
   missing (S1A not merged yet), log warn and fall back to fake.
3. Tests inject backend directly via factory; never depend on the env.

This lets S2 owner switch the env flag once S1A lands without rebuilding
this package.

## Files

```
apps/voice-llm-shim/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── server.ts              # bootstrap: createServer + listen
│   ├── app.ts                 # createApp(deps) → http.Server (testable)
│   ├── handler.ts             # POST /v1/chat/completions handler
│   ├── sse.ts                 # OpenAI SSE encoder
│   ├── validate.ts            # request validation
│   ├── runtime/
│   │   ├── contract.ts        # AgentTurnStream types
│   │   ├── fake.ts            # fake echo backend
│   │   └── resolve.ts         # backend resolution
│   └── __tests__/
│       ├── handler-stream.test.ts        # stream=true returns SSE
│       ├── handler-non-stream.test.ts    # stream=false returns 400
│       ├── sse.test.ts                   # encoder unit
│       ├── finish-reason.test.ts         # finishReason propagation
│       └── openai-sdk-roundtrip.test.ts  # openai npm client → shim → fake
```

## Atomic commits

1. **chore(voice-llm-shim): scaffold @pa/voice-llm-shim package**
   - package.json, tsconfig.json, empty src/
2. **feat(voice-llm-shim): SSE encoder + types**
   - sse.ts, contract.ts, sse.test.ts
3. **feat(voice-llm-shim): chat completions handler + validation**
   - handler.ts, validate.ts, app.ts, handler-stream.test.ts,
     handler-non-stream.test.ts, finish-reason.test.ts, fake backend
4. **feat(voice-llm-shim): backend resolver for orchestrator import**
   - resolve.ts
5. **feat(voice-llm-shim): server bootstrap + openai sdk integration test**
   - server.ts, openai-sdk-roundtrip.test.ts, README.md
6. **docs(v2.1): S1C summary**
   - .planning/v2.1/sprints/S1C-llm-shim/SUMMARY.md

## Verification plan

After each commit's package-scoped tests pass, final gate:

```bash
pnpm --filter @pa/voice-llm-shim test
pnpm --filter @pa/pa-orchestrator test
pnpm --filter @pa/functions test
node tests/scenarios/runner-prescreen.mjs pass.yaml
node tests/scenarios/runner-prescreen.mjs fail.yaml
node tests/scenarios/runner-prescreen.mjs hard-stop.yaml
node tests/scenarios/runner-prescreen.mjs pause.yaml
```

Shim adds no shared-code edits → orchestrator/functions tests must stay green
by construction. Scenarios must stay green.

## Env / config

| Var | Default | Purpose |
|---|---|---|
| `WEKRUIT_LLM_SHIM_HOST` | `127.0.0.1` | bind host (localhost-only in dev) |
| `WEKRUIT_LLM_SHIM_PORT` | `8787` | listen port |
| `WEKRUIT_LLM_SHIM_BACKEND` | `fake` | `fake` \| `orchestrator` |
| `WEKRUIT_LLM_SHIM_MODEL` | `wekruit-prescreen-v1` | echoed back in chunks |

Auth: localhost-bind only. Production auth (signed header / mTLS) is S5's
job. Document explicitly in SUMMARY.

## S2 wiring notes (for S2 owner)

```py
from livekit.plugins import openai
session = AgentSession(
    llm=openai.LLM(
        base_url="http://<shim-host>:8787/v1",  # WEKRUIT_LLM_SHIM_URL + /v1
        model="wekruit-prescreen-v1",
        api_key="unused-localhost",
    ),
    ...
)
```

Shim is stateless: every voice turn is one `POST /v1/chat/completions`
streamed call. Turn/session/scoring state lives upstream in the LiveKit
agent's call to `PreScreenPipeline.runTurn` (NOT in this shim).
