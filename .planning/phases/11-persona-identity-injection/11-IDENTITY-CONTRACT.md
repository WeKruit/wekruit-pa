# WeKruit PA Identity & Memory Contract (Phase 11)

Audience: Phase 12 (proactive job-companion outreach), Phase 13
(matching connector path), and any future surface that needs to scope
behavior to "this user". If you ship without reading this, your code
will diverge from the canonical scope and either over-share memory or
silently miss it.

This contract is locked by P10 architecture decisions A1–A4. It is not
negotiable inside Phase 12 or 13.

## 1. Identity surfaces

There are exactly two identity keys in PA. No more.

| Key | Authoritative for | Lives on | Source of truth |
|-----|-------------------|----------|-----------------|
| `userId` | Firestore-keyed canonical state: `pa_users`, `pa_sessions`, `pa_messages`, `pa_inbound_events`, `pa_outbound`, `pa_turns`, `pa_agent_turns`, `pa_memory_facts`, `pa_memory_actions`, `pa_memory_events`, `pa_audit_events`, `pa_safety_events` | `User.id` | Firestore `pa_users.{id}` |
| `mem0UserId` | Mem0 / Qdrant payload `user_id` partition (semantic memory only) | `User.mem0UserId` (optional) | Firestore `pa_users.{id}.mem0UserId`; resolved via `resolveMem0PartitionKey(user) = user.mem0UserId ?? user.id` |

`mem0UserId` is the ONLY key that is allowed to differ from `userId`. It
exists so a future Mem0 / vector-store migration (or a multi-tenant
re-partitioning) can repoint semantic memory without rewriting Firestore
identity. Until such a migration runs, `mem0UserId` is unset for the
vast majority of users and the resolver returns `userId`.

## 2. Flow

```
inbound iMessage
  └─> pa_broker → pa_inbound_events (carries userId, sessionId, mem0UserId?)
        └─> pa-orchestrator
              ├─ loadHistory(sessionId)                          [Firestore, userId scope]
              ├─ listConfirmedMemoryFacts(db, userId)            [Firestore, userId scope]
              ├─ loadFirestorePersonaCard(db, userId)            [Firestore, userId scope]  ← Phase 11 new
              ├─ loadPersonalizationContext({                    [Mem0/Qdrant scope]
              │     userId,                                      // for Firestore audit only
              │     mem0UserId: resolveMem0PartitionKey(user),   // authoritative for Mem0 search
              │     ...
              │   })
              ├─ runAgentTurn({                                  [Agents SDK]
              │     systemPrompt: agent.systemPrompt,            // agent-config, not user data
              │     memoryBlock: [
              │       personaCard,                               // ← Phase 11 deterministic block
              │       confirmedFactsBlock,
              │       mem0RecallBlock                            // gated by mem0Degraded
              │     ].join("\n\n"),
              │     history,
              │     userMessage
              │   })                                             // SDK never sees Firestore
              └─ afterAssistantTurn({                            [Mem0/Qdrant scope]
                    userId,
                    mem0UserId: resolveMem0PartitionKey(user),
                    ...
                  })
```

The Agents SDK turn receives only:
- `systemPrompt` (agent config — operator-authored)
- `memoryBlock` (PA-assembled, persona card + Firestore facts + Mem0
  recall, in that order)
- `history` (Firestore `pa_messages` for the session)
- `userMessage` (current inbound body)

The SDK NEVER receives raw Firestore handles, Mem0 keys, or `userId`.
This is the A2 boundary.

## 3. Field-level contract

### 3.1 What downstream phases can rely on

- `userId` is stable for the lifetime of a Firestore user document. It
  is never reused even if the user is deleted.
- `mem0UserId` is either unset (treat as equal to `userId`) or is a
  string that, once set, must never change without going through a
  documented migration path (TBD; out of scope for Phase 11). Treat it
  as immutable.
- `User.phoneE164` and `User.channels.imessageHandle` are routing keys,
  not identity keys. Never use them to scope memory or audit.
- The orchestrator MUST resolve `mem0UserId` via the helper
  `resolveMem0PartitionKey(user)` before calling any memory function.
  Callers that already hold a partition key (e.g. scheduled-outreach
  workers in Phase 12) MUST do the same resolution from their own user
  fetch — do not pass the raw `User.mem0UserId` directly because it
  may be `undefined`.

### 3.2 Authoritative vs advisory

| Caller | Pass to memory layer | Why |
|--------|-----------------------|-----|
| Live orchestrator turn | `{ userId, mem0UserId: resolveMem0PartitionKey(user) }` | Authoritative on both surfaces |
| Memory Admin (clear/list) | Same as above; `clearUserMemory` accepts an explicit Mem0 partition override | Operator action must hit the correct Qdrant partition |
| Phase 12 outreach scheduler | Same as above. Outreach throttling / cooldowns key on `userId` (Firestore). Memory recall before composing the nudge keys on `mem0UserId`. | Two-surface scope |
| Phase 13 matching connector | Receives `userId` only. The connector reads match-source facts from `pa_memory_facts` (`userId`-scoped) and writes match-rationale audit to `pa_audit_events` (`userId`-scoped). It does NOT touch Mem0/Qdrant directly. | A4 — secondary providers are out of scope until Phase 13 review |

### 3.3 Identity drift

Drift is when `mem0UserId !== userId` but no `User.mem0UserId` is set
in Firestore (i.e. somebody constructed a partition key out-of-band).
Phase 11 handling:

- Memory layer logs a structured `[memory] identity_drift` line with
  both keys.
- The explicit override is honored for the current turn (production
  must not regress on stale fields).
- No exception is thrown.

Phase 12 / 13 implementations MUST NOT introduce new partition keys to
work around drift. If a new partition is required, propose it as a
roadmap item, not an inline override.

### 3.4 User reseating

If a user record is reseated (`User.id` changes — e.g. a phone-number
remap), Phase 11 does not handle this automatically. The Memory Admin
"clear user" flow is the supported path: clear the old `userId` (which
also clears the resolved Mem0 partition), then issue a new user record.
Phase 12 outreach schedulers MUST listen for this and cancel pending
outreach jobs scoped to the old `userId`. (This requirement is captured
here so Phase 12 cannot ship without addressing it.)

## 4. Persona card contract (Phase 11 new surface)

`loadFirestorePersonaCard(db, userId): Promise<string | null>`

- Reads `pa_memory_facts` where `userId == userId` and `status ==
  "confirmed"`.
- Excludes facts with `status === "deleted"`.
- Sorts by `createdAt` ascending (deterministic across processes).
- Returns `null` if no eligible facts exist.
- Returned string MUST start with `Persona facts (confirmed):\n` so
  downstream prompts and tests can match deterministically.
- The card is concatenated by the orchestrator into the `memoryBlock`
  surface; it is NEVER concatenated into `agent.systemPrompt`. Persona
  is data, not agent config.

Phase 12 outreach: when the scheduler composes a proactive nudge, it
MUST call `loadFirestorePersonaCard` itself and pass the result on the
same `memoryBlock` surface. Outreach inherits persona; it does not
synthesize a separate persona system message.

Phase 13 matching: the persona card is read-only context for the
matching connector's rationale, NOT a filter for which roles surface.
Match filters key on explicit `pa_memory_facts` content semantics, not
on the formatted card.

## 5. Outbound + audit binding

- `pa_outbound` rows are keyed on `userId` (Firestore). Any proactive
  send (Phase 12) MUST stamp `userId`, `sessionId`, `agentId`, and
  `policyReason` (the same fields the Phase-10 fix audited).
- `pa_audit_events` is keyed on `userId`. Mem0 partition (`mem0UserId`)
  is recorded as a sub-field when relevant (memory clear, semantic
  memory query); never as the primary key.

## 6. What this contract does NOT cover

- Multi-tenant org-level identity (no roadmap entry yet).
- Migration from Mem0/Qdrant to OpenAI vectorStores (locked out by A4
  until Phase 13 review).
- Cross-channel identity (only iMessage today; channel expansion is
  Phase 14+).
- Group chats. PA assumes 1:1 conversations; group fan-out is out of
  scope across Phase 11–13.

If your Phase 12 / 13 design needs anything from this section, escalate
to P10 before implementing.
