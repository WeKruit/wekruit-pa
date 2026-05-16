# @pa/voice-llm-shim

OpenAI-compatible HTTP shim that lets the LiveKit Agents `openai.LLM` plugin
call WeKruit's `runAgentTurnStream` (S1A export) as if it were OpenAI's
streaming chat-completions API.

Stateless. Turn / session / scoring state lives in `PreScreenPipeline.runTurn`
upstream — this service exists only to make our agent runtime callable by an
OpenAI-protocol client.

## Run

```bash
pnpm --filter @pa/voice-llm-shim build
WEKRUIT_LLM_SHIM_PORT=8787 \
WEKRUIT_LLM_SHIM_BACKEND=fake \
  pnpm --filter @pa/voice-llm-shim start
```

Dev mode (no build):

```bash
pnpm --filter @pa/voice-llm-shim dev
```

## Env

| Var | Default | Notes |
|---|---|---|
| `WEKRUIT_LLM_SHIM_HOST` | `127.0.0.1` | bind host (localhost-only in dev) |
| `WEKRUIT_LLM_SHIM_PORT` | `8787` | listen port |
| `WEKRUIT_LLM_SHIM_BACKEND` | `fake` | `fake` or `orchestrator` |
| `WEKRUIT_LLM_SHIM_MODEL` | `wekruit-prescreen-v1` | echoed back in chunks |

`backend=orchestrator` dynamically imports `runAgentTurnStream` from
`@pa/pa-orchestrator`. If the export is missing (S1A not yet merged), the
resolver logs a warning and falls back to the fake backend.

## Endpoint

`POST /v1/chat/completions` — OpenAI 2024 chat-completions streaming format.

- Request body must include `stream: true`. Non-stream requests return HTTP
  400 with an OpenAI-shape error envelope.
- Response is `text/event-stream`: `data: {chunk-json}\n\n` lines terminated
  by `data: [DONE]\n\n`.

## LiveKit wiring (S2 owner)

```py
from livekit.plugins import openai
llm = openai.LLM(
    base_url="http://127.0.0.1:8787/v1",
    model="wekruit-prescreen-v1",
    api_key="unused-localhost",
)
```

## Tests

```bash
pnpm --filter @pa/voice-llm-shim test
```

Covers:

- SSE encoder unit
- `stream=true` returns OpenAI SSE chunks
- `stream=false` returns 400
- `finish_reason` propagates from `runAgentTurnStream`
- `openai` npm SDK round-trip → shim → fake backend
