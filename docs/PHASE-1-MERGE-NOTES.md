# Phase 1 — Source of Truth Merge Notes

This document records the P10/P9 reconciliation that brought worktree
`claude/agitated-chatelet-cc4d5b` (production CF + Mem0 OSS + Qdrant +
SiliconFlow fixes) onto `main`, while preserving main's broker arch work
(pa-broker, pa-connectors, pa-persistence, pa-safety, dashboard rework,
agent-runtime/agent-registry refactors, broker schema additions in core-types).

It is intentionally short and references file paths so future agents can
verify decisions instead of re-deriving them.

## Inputs

- Base commit: `767123d` (handoff doc)
- Worktree branch: `claude/agitated-chatelet-cc4d5b` @ `37b05ef`
  - Production fixes that produced the working iMessage 3-turn memory
    recall flow (烧鹅 → 高尔夫 → recall) on Firebase project `wekruit-5f89b`.
- Main dirty tree (~30 files modified + ~30 untracked) preserved as
  `wip/main-pre-merge-checkpoint` (commit `98a28a2`) — reflog safety.

## Strategy

Cherry-pick was rejected: main's 30+ dirty files would have collided with
worktree's 5 commits across `mem0.ts`, `worker/index.ts`, and shared
type files. Strategy used: **file-level surgical port** on top of the
wip checkpoint, with three explicit P10 decisions ("断事") below.

## P10 决断 (decisions)

### 1. `packages/memory/src/mem0.ts` — worktree wins

Main's dirty tree had a 31-line patch on top of the legacy
`api.mem0.ai` Cloud HTTP shim. Worktree replaced this file entirely with
a 195-line Mem0 OSS SDK wrapper that drives:

- LLM: SiliconFlow OpenAI-compatible (`https://api.siliconflow.cn/v1`)
  with `Qwen/Qwen2.5-72B-Instruct`
- Embedder: SiliconFlow `BAAI/bge-m3` (1024 dims)
- VectorStore: self-hosted Qdrant on Fly.dev, accessed via a custom
  `FetchQdrantClient` that bypasses the qdrant-js keepalive Agent (which
  hangs against Fly's edge).
- `disableHistory: true` — skips `better-sqlite3` (cannot ship in CF
  esbuild bundles).

Public API (`mem0Search`, `mem0Add`) unchanged — drop-in for `stacked.ts`.

### 2. `packages/pa-orchestrator/src/index.ts` — worktree wins

Main had a 367-line orchestrator; worktree had a 538-line orchestrator
that the production CF actually exercised. The CF's success on real
iMessage traffic (per the user's screenshot) is the only evidence that
matters at this point. Replaced wholesale.

Main's pa-broker / pa-connectors / pa-persistence / pa-safety packages
do **not** depend on pa-orchestrator (verified by grep), so this swap
does not break the broker arch.

### 3. `apps/macos-imessage-worker/src/index.ts` — main wins

Worktree's worker (257 LOC, "channel gateway only") and main's worker
(531 LOC, broker-arch integrated) are two orthogonal refactors. Main's
broker-arch worker uses `@pa/pa-broker`'s lifecycle helpers
(`createInboundEvent`, `completeInboundEvent`, `failInboundEvent`) and
is the architecture going forward. Worktree's worker is the legacy path
that the screenshot was produced on, but the broker arch is what main
declared as forward direction in the handoff.

The CF (`apps/functions/src/index.ts`) was already designed to consume
**main's** `PaInboundEvent` broker payload shape (`rawPayload.kind ===
"imessage"`, etc.) — see `BrokerImessageEvent` type in CF — and convert
it into worktree's enriched `InboundEvent` shape before passing to
pa-orchestrator. So main's broker → CF wire format is preserved.

## Other decisions

| File | Disposition | Reason |
|------|-------------|--------|
| `packages/memory/src/qdrant-fetch.ts` | NEW from worktree | Required by mem0.ts (custom Qdrant client) |
| `packages/memory/src/{archive,commands,facts,providers}.ts` (+ tests) | NEW from worktree | Used by pa-orchestrator memory commands |
| `packages/memory/src/index.ts` | worktree wins | Re-exports new modules; no main consumer broke |
| `packages/memory/src/stacked.ts` | worktree wins | Required by new mem0 config shape; main's persona-card hook (`loadFirestorePersonaCard`) regressed — see "Known Regressions" |
| `packages/memory/src/types.ts` | worktree base + `mem0UserId?: string` added | Worker still passes `user.mem0UserId ?? user.id`; field is currently advisory (stacked.ts ignores it) |
| `packages/memory/src/firestore-persona.ts` | DELETED | Used old `MemoryFact { key, value, sensitivity }` shape; orphaned after stacked.ts swap |
| `packages/memory/src/stacked.test.ts` | worktree wins | Replaces persona-card tests; covered separately in Phase 4 |
| `packages/pa-orchestrator/{cli,index.test,package.json,tsconfig}` | worktree wins | Ships with the new orchestrator |
| `packages/core-types/src/index.ts` | UNION merge | Kept main's `AgentDef` (superset), `OutboundMessage` (extended with worktree fields `sessionId/role/errorCode/attempts/leaseUntil/claimedAt`), `ScheduledJob`, `RuntimeHeartbeat`. Replaced `MemoryFact` + `MemoryFactStatus` with worktree's `content`-based shape. Added worktree's `ProcessingStatus, InboundEvent, TurnStage, Turn, MemoryActionType, MemoryAction, ConversationSummary, MessageArchivePointer`. Removed orphaned `MemorySensitivity*`. |
| `packages/core-types/src/index.ts` (`AgentDef.status`) | `.default("published")` → `.optional()` | Test fixtures and runtime call sites construct `AgentDef` literals without `status`; making it optional keeps zod parsing valid and unblocks compile |
| `packages/core-types/src/collections.ts` | UNION merge | Added worktree's `turns, memoryActions, conversationSummaries, messageArchives` to main's broker-heavy collection set |
| `apps/functions/` | NEW from worktree | Cloud Function entry point. `engines.node = 20` (Firebase runtime); local dev tolerates Node 24 with `EBADENGINE` warnings |
| `firebase.json` | UNION merge | Added worktree's `functions[]` block (codebase `pa-orchestrator`, runtime `nodejs20`) alongside main's `hosting[]` block |
| `scripts/pa-smoke{,-rest}.mjs` | NEW from worktree | End-to-end smoke scripts |
| `apps/macos-imessage-worker/src/{chat-db,inbound,inbox-sync,local-queue,connectors,sqlite}.ts` (+ tests) | SKIPPED | Worktree's worker module split; not imported by main's broker-arch worker |
| `config/firebase/firestore.indexes.json` | main wins | Main has a superset of indexes (broker arch needs them) |
| `package.json` (root) | no change | Workspaces (`apps/*`, `packages/*`) auto-pickup `apps/functions`; main's `build` script already lists `pa-orchestrator` |

## Known regressions (address in later phases)

1. **Persona card from Firestore facts is no longer injected into the
   LLM system prompt.** Main's `firestore-persona.ts` was deleted because
   it relied on the old `MemoryFact { key, value, sensitivity }` shape.
   Worktree's `providers.ts` (`FirestorePersonaProvider`) is a more
   capable replacement but `stacked.ts` does not call it yet. Phase 4
   (Agent / Memory Management) should wire `FirestorePersonaProvider`
   into the orchestrator's context loader.
2. **`mem0UserId` is advisory only.** Main's worker passes
   `user.mem0UserId ?? user.id` to LoadContext / AfterTurn, but
   `stacked.ts` partitions Mem0 by `userId` directly. Functionally
   identical for users where `mem0UserId` is unset (current production
   state per the screenshot test user). Phase 4 should make stacked.ts
   honor the override.
3. **AgentDef.status is optional at the type level.** Was
   `.default("published")` in main; lowered to `.optional()` to unblock
   construction sites that don't go through zod parsing. `pa-agents`
   collection writes should explicitly set `status` going forward.

## Deploy contract

```bash
# Local sanity (Node 24)
PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH npm run build
PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH npm test --workspaces --if-present
PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH npm run build --workspace=@pa/functions

# Deploy CF
firebase deploy --only functions:pa-orchestrator --project wekruit-5f89b
```

## Reflog safety

If anything below fails, the pre-merge state is preserved at branch
`wip/main-pre-merge-checkpoint` (`98a28a2`).

```bash
git reset --hard wip/main-pre-merge-checkpoint
```
