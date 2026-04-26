status: complete

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

## Production Verification (closed 2026-04-26)

1. Firebase Secret `PA_OPENAI_AGENT_API_KEY` created at version 1
   (`projects/876479962995/secrets/PA_OPENAI_AGENT_API_KEY/versions/1`).
2. `onPaInbound` redeployed three times during bug closure; final revision
   includes `PA_OPENAI_AGENT_API_KEY`, `SILICONFLOW_API_KEY`, `QDRANT_URL`,
   and `QDRANT_API_KEY` in `secret_environment_variables` (audit logs
   confirm). Runtime: nodejs22, Gen 2.
3. Live scenario `current-info-live-zh.yaml` returns sourced 2026-04-26 web
   results (white-house dinner shooting, OpenAI/Cerebras $20B, etc.) with
   citations, not the boundary fallback.
4. `pa_outbound` rows for harness events (`outbound-${eventId}`) confirmed
   `0` across the live current-info run and previous runs.
5. Full scenario directory passes: 6/6 (memory recall zh/en/ja/mixed,
   reset-integration-zh, current-info-live-zh). Boundary scenario
   `current-info-boundary-zh.yaml` renamed to `.disabled` because it
   intentionally asserts behavior that only exists when the secret is
   unbound; the boundary path stays covered by orchestrator unit tests.

## Bugs surfaced and fixed during production closure

1. `policyReason: undefined` rejected by Firestore in
   `packages/pa-connectors/src/index.ts` `runConnector` when the policy
   decision was `allow`. Fixed by conditional spread.
2. `appendAuditEvent` in `packages/pa-broker/src/audit.ts` wrote optional
   fields (`userId`, `sessionId`, `turnId`, `inboundEventId`, `toolCallId`,
   `message`, `meta`) verbatim, including `undefined`, which Firestore
   rejected. Fixed by conditional spread for every optional.
3. `OpenAIProvider({ apiKey, useResponses: true })` in
   `packages/agent-runtime/src/current-info.ts` fell through to the
   process-wide `OPENAI_BASE_URL=https://api.siliconflow.cn/v1` (set by the
   functions entrypoint for the SiliconFlow LLM). The Agents SDK then
   POSTed `/responses` to SiliconFlow → 404. Fixed by constructing an
   explicit `OpenAI` client pinned to the official endpoint
   (`PA_OPENAI_AGENT_BASE_URL` override available) and passing it via
   `openAIClient` only (apiKey is implied by that client).
