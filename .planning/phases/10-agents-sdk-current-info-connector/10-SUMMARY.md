# Phase 10: Agents SDK current-info connector - Summary

## Completed

- Added `packages/agent-runtime/src/current-info.ts`.
- Exported `runOpenAIAgentsCurrentInfo` from `@pa/agent-runtime`.
- Moved `current-info` connector execution to Agents SDK hosted `web_search`.
- Replaced the current-info-specific secret with `PA_OPENAI_AGENT_API_KEY`.
- Updated Cloud Functions secret binding code for `onPaInbound`.
- Updated package build order and `@pa/pa-connectors` dependency graph.
- Updated connector and orchestrator tests.
- Updated `.planning` milestone direction for Agents SDK runtime, job companion, and memory boundaries.

## Verification

- `npm run build --workspace=@pa/agent-runtime` passed.
- `npm run build --workspace=@pa/pa-connectors` passed.
- `npm run test --workspace=@pa/pa-connectors` passed.
- `npm run test --workspace=@pa/pa-orchestrator` passed.
- `npm test` passed. Production scenarios were skipped because `PA_RUN_SCENARIOS` was not set.
- `npm run build:all` passed. Existing dashboard chunk-size warning remains.
- `npm run build --workspace=@pa/functions` passed and regenerated gitignored `apps/functions/lib`.

## Open

- `PA_OPENAI_AGENT_API_KEY` is not yet confirmed bound on deployed `onPaInbound`.
- Functions have not yet been deployed with this secret rename.
- Live current-info harness scenario still needs a production run after secret/deploy.
