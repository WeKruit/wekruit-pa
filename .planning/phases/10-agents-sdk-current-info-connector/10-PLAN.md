# Phase 10: Agents SDK current-info connector - Plan

## Goal

Replace the hand-written current-info Responses fetch with an OpenAI Agents SDK hosted `web_search` path while preserving PA connector and harness boundaries.

## Tasks

1. Add an `@pa/agent-runtime` current-info helper that creates an Agents SDK agent with hosted `web_search`.
2. Route `@pa/pa-connectors` `current-info` through that helper and keep connector output stable.
3. Rename the production OpenAI hosted-tool secret from `PA_CURRENT_INFO_OPENAI_API_KEY` to `PA_OPENAI_AGENT_API_KEY`.
4. Update tests for missing key, SiliconFlow env isolation, and hosted web_search request behavior.
5. Update planning docs for the Agents SDK runtime spine and job companion milestone.
6. Run package tests, root tests, dashboard build, and functions build.

## Validation

- `npm run build --workspace=@pa/agent-runtime`
- `npm run build --workspace=@pa/pa-connectors`
- `npm run test --workspace=@pa/pa-connectors`
- `npm run test --workspace=@pa/pa-orchestrator`
- `npm test`
- `npm run build:all`
- `npm run build --workspace=@pa/functions`

## Remaining Production Gate

Production enablement requires binding `PA_OPENAI_AGENT_API_KEY`, deploying functions, verifying deployed function metadata, and running a live current-info harness scenario with `pa_outbound=0`.
