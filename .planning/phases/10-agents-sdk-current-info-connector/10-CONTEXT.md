# Phase 10: Agents SDK current-info connector - Context

**Gathered:** 2026-04-26
**Status:** Ready for production enablement

<domain>
## Phase Boundary

Migrate current-info lookup from a hand-written OpenAI Responses API fetch to OpenAI Agents SDK hosted `web_search`, while preserving WeKruit-owned orchestration boundaries: connector policy, audit/tool-call records, memory writeback behavior, and scenario `suppressOutbound`.

</domain>

<decisions>
## Implementation Decisions

### OpenAI Agents SDK as Runtime Spine
Use `@openai/agents` directly for OpenAI-native hosted tools when the SDK exposes the tool. The current-info path should not keep a bespoke long-lived Responses fetch wrapper.

### Unified OpenAI Agent Secret
Use `PA_OPENAI_AGENT_API_KEY` for OpenAI official hosted tools and agent workflows. Do not keep `PA_CURRENT_INFO_OPENAI_API_KEY` as a current-info-specific credential.

### Product Boundary
WeKruit continues to own identity, memory, scheduling, outbound policy, dashboard, and audit. Agents SDK receives injected context and executes hosted tools; it does not become the identity or memory system of record.

### Memory Boundary
Keep Firestore facts and Mem0/Qdrant semantic memory, including Memory Admin. OpenAI file/vector search can be evaluated later as another provider, not as a replacement in this phase.

</decisions>

<code_context>
## Existing Code Insights

- `packages/agent-runtime` already depends on `@openai/agents` and is the right package for SDK-backed runtime helpers.
- `packages/pa-connectors` owns connector policy/audit integration and should call runtime helpers rather than hand-writing OpenAI API calls.
- `apps/functions/src/index.ts` binds Firebase secrets and re-exports them into `process.env` for workspace packages.
- `packages/pa-orchestrator` already routes current-info before the normal LLM stale-answer path and preserves `suppressOutbound`.

</code_context>

<specifics>
## Specific Ideas

- Create an agent-runtime helper for current-info search.
- Use `webSearchTool({ searchContextSize: "low", externalWebAccess: true })`.
- Force `toolChoice: "web_search"` for current-info questions.
- Keep connector output shape stable: `{ ok, source, summary, asOf, sources }`.
- Update planning docs to reflect the job companion direction and Agents SDK runtime strategy.

</specifics>

<deferred>
## Deferred Ideas

- Production secret binding and functions deploy require explicit operator action because they store/use an OpenAI key.
- Live current-info scenario should be split from boundary scenario after production secret binding.
- OpenAI vectorStores/file_search provider evaluation belongs after current-info and persona identity are stable.

</deferred>
