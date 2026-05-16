# v2.1 Research Files — Index

Adam approved at S0 confirmation: research files are NOT a prereq. S1+
sub-agents web-fetch official docs as needed and back-fill the relevant
file when findings materially influence implementation.

## Suggested topic owners

| File | Topic | Suggested owner sprint |
|---|---|---|
| `01-livekit-agents-sdk.md` | Node/Python SDK shape, event handler list, deploy semantics | S2 |
| `02-deepgram-stt-tts.md` | Nova-3 + Aura-2 stream config, voice IDs, latency profile | S2 |
| `03-twilio-sip-trunking.md` | Trunk creation, termination URI, status callbacks, caller-ID rotation, DLR semantics | S3 |
| `04-silero-vad-multilingual.md` | Adaptive turn detection model, parameters, false-commit tuning | S2 / S4 |
| `05-llm-shim-design.md` | OpenAI Chat Completions SSE format spec + LiveKit `openai.LLM` plugin contract | S1C |
| `06-tcpa-compliance.md` | DNC list source, quiet-hours per state, consent capture, retention | S5 |
| `07-turn-telemetry.md` | `session_usage_updated` payload + cost attribution + aggregate metrics design | S4 |

Sprint owners: fill the relevant file in your worktree if you discover a non-obvious gotcha worth preserving. Brief findings welcome (1-2 page max). Otherwise leave as stub.
