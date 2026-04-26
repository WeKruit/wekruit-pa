# Phase 11 Context — Persona + Identity/Memory Injection

## Why this phase

Phase 10 closed the current-info channel through Agents SDK. Before any
proactive job-companion outreach (Phase 12) ships, PA must own a stable
identity layer between Firestore facts, Mem0/Qdrant semantic memory, and
the Agents SDK system prompt. Without it, follow-up DMs cannot be
permissioned per user, and persona regressions silently shift tone.

## Strategic decisions locked by P10 (do not relitigate)

- **A1** Agent Runtime is OpenAI Agents SDK; reasoning + hosted tools
  flow through it.
- **A2** WeKruit owns identity, canonical memory, outbound send policy,
  and audit. Agents SDK never reaches Firestore directly.
- **A3** Identity injection is hybrid: Firestore facts → PA-assembled
  persona card → injected as a system message to Agents SDK.
- **A4** Mem0/Qdrant + Memory Admin remain primary memory. OpenAI
  vectorStores are evaluated only as a secondary provider in Phase 13.

## Known regressions / gaps to close

1. `FirestorePersonaProvider` exists but is not wired into
   `packages/agent-runtime/src/stacked.ts`. The deterministic persona
   card built from confirmed Firestore facts is not injected into the
   live Agents SDK turn.
2. `mem0UserId` is advisory in `stacked.ts` — not actually used to
   scope per-user memory recall against Qdrant payload `user_id`.
3. There is no end-to-end identity contract documented for downstream
   phases (Phase 12 outreach, Phase 13 matching). Phase 12 cannot ship
   permissioned DMs without it.

## Out of scope

- B3 human-feel tuning (waits on identity + harness data).
- B2 typing indicator (Phase 15, parallel).
- Job companion outreach scheduler (Phase 12, depends on this phase).
- Migrating Mem0/Qdrant to OpenAI vectorStores (locked out by A4).

## Success criteria (goal-backward)

1. Live agent turns include a deterministic persona card derived from
   Firestore confirmed facts.
2. `mem0UserId` is the authoritative key when reading or writing
   semantic memory; Memory Admin reflects the same scope.
3. A documented identity contract exists in
   `.planning/phases/11-.../11-IDENTITY-CONTRACT.md` that downstream
   Phase 12/13 can consume without surprise.
4. Production scenario harness covers a persona-injection regression
   path (e.g., asserting tone/constraints from Firestore facts).
5. No live sends from harness; `pa_outbound` count for harness events
   stays at 0.

## Hand-off to P9-B

P9-B should produce:

- `11-PLAN.md` task breakdown with explicit goal-backward verification.
- `11-IDENTITY-CONTRACT.md` documenting the identity surface for
  downstream phases.
- A scenario file covering persona-card injection regression.

P9-B does NOT write production code; that is P8 territory once the
plan is approved.
