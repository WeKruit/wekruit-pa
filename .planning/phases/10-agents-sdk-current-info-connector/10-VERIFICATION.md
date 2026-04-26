status: human_needed

# Phase 10 Verification

## Automated

Passed:

- `npm run build --workspace=@pa/agent-runtime`
- `npm run build --workspace=@pa/pa-connectors`
- `npm run test --workspace=@pa/pa-connectors`
- `npm run test --workspace=@pa/pa-orchestrator`
- `npm test`
- `npm run build:all`
- `npm run build --workspace=@pa/functions`

## Human / Production Verification Needed

1. Confirm whether to store the OpenAI hosted-tool key as Firebase Secret `PA_OPENAI_AGENT_API_KEY`.
2. Deploy functions after the secret is available.
3. Verify deployed `onPaInbound` metadata includes `PA_OPENAI_AGENT_API_KEY`, `SILICONFLOW_API_KEY`, `QDRANT_URL`, and `QDRANT_API_KEY`.
4. Run a live current-info scenario that expects sourced answers, not the unavailable-boundary reply.
5. Confirm harness still writes no `pa_outbound` rows for suppressed test participants.
