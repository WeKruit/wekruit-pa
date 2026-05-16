# S1C LLM Shim — SUMMARY (P10 transcription)

> Agent harness blocked direct SUMMARY write. P10 transcribed final report.
> Source: completion notification 2026-05-15.

**Branch:** `claude/v21-S1C-llm-shim` (pushed)
**Parent:** `claude/v21-S0-foundation` @ `249dfa4`

## Commits

| SHA | Subject |
|---|---|
| `d66ac84` | chore(voice-llm-shim): scaffold @pa/voice-llm-shim package |
| `7b23c64` | feat(voice-llm-shim): SSE encoder + runtime contract types |
| `e8849a3` | feat(voice-llm-shim): chat completions handler + fake backend |
| `6daa001` | feat(voice-llm-shim): backend resolver for orchestrator import |
| `8b723b7` | feat(voice-llm-shim): server bootstrap + openai SDK roundtrip test |

## Package: `@pa/voice-llm-shim` at `apps/voice-llm-shim/`

Stateless HTTP service, OpenAI-compatible `POST /v1/chat/completions`, emits 2024 SSE chunks. Native `node:http` only (no Express/Fastify), zero runtime deps. ESM ES2022 strict.

```
apps/voice-llm-shim/
├── package.json     # @pa/voice-llm-shim 0.0.1
├── src/server.ts    # process entry
├── src/app.ts       # createApp(deps) → http.Server
├── src/handler.ts   # POST /v1/chat/completions
├── src/sse.ts       # OpenAI 2024 chunk encoder
├── src/validate.ts
├── src/runtime/{contract.ts, fake.ts, resolve.ts}
└── src/__tests__/   # 17 tests
```

## Test summary

| Suite | Result |
|---|---|
| `@pa/voice-llm-shim` | 17/17 PASS (new) |
| `@pa/pa-orchestrator` | 1498/1498 PASS |
| `@pa/functions` | 1518/1518 PASS |
| `runner-prescreen pass.yaml` | PASS |
| `runner-prescreen pause.yaml` | PASS |
| `runner-prescreen fail.yaml` | **pre-existing baseline failure** (same as S1A) |
| `runner-prescreen hard-stop.yaml` | **pre-existing baseline failure** (same as S1A) |

S1C touches zero shared code — confirmed scenario failures reproduce on S0 base with all S1C changes stashed.

## Integration gap (P10 action)

S1C `RunAgentTurnStream` contract declared:
```ts
(req: { messages: Array<{role:string; content:string}>; model?: string })
  => AsyncIterable<{ delta: string; finishReason?: "stop"|"length"|null }>;
```

S1A actual export:
```ts
runAgentTurnStream(ctx: AgentTurnContext): AsyncGenerator<AgentTurnStreamChunk, void, void>;
// AgentTurnStreamChunk = { delta, finishReason?: "stop"|"length"|"error", usage? }
```

**Mismatch**: req shape ≠ AgentTurnContext shape; finishReason gains `"error"`; chunk shape gains `usage`. Tracked in task #12 (S1A↔S1C adapter). Folded into S2 scope.

## Env config

| Var | Default | Purpose |
|---|---|---|
| `WEKRUIT_LLM_SHIM_HOST` | `127.0.0.1` | bind host (localhost dev) |
| `WEKRUIT_LLM_SHIM_PORT` | `8787` | listen port |
| `WEKRUIT_LLM_SHIM_BACKEND` | `fake` | `fake` or `orchestrator` |
| `WEKRUIT_LLM_SHIM_MODEL` | `wekruit-prescreen-v1` | echoed in chunks |
| `WEKRUIT_LLM_SHIM_URL` (S2 consumer) | `http://127.0.0.1:8787` | LiveKit `openai.LLM` base_url + `/v1` |

## S2 wiring snippet

```python
from livekit.plugins import openai
llm = openai.LLM(
  base_url="http://127.0.0.1:8787/v1",
  model="wekruit-prescreen-v1",
  api_key="unused-localhost",
)
```

## Deployment

LiveKit Cloud agent hosting (L12) co-located with shim:
- Sidecar to LK Cloud agent (if platform allows), OR
- Cloud Run `node:24-alpine` + `dist/`, exposed via VPC connector or auth-header public URL

Auth = S5 ownership. v2.1 dev = 127.0.0.1; prod = host flip + boundary auth.
