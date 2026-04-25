# Phase 1 Reviews

## P10 Direction

Build the product as a PA control plane, not a pile of debug tools:

```
iMessage Worker  ->  Firestore Broker  ->  Orchestrator  ->  Agent Runtime
     |                    |                    |                  |
 channel adapter      durable state       turn ownership      model/tools
     |                    |                    |                  |
     +---------------- Dashboard / Operations / Memory Control ---+
```

Operating principle: channel adapters send and receive, the orchestrator owns assistant turns, Firestore owns durable truth, and the dashboard owns operator clarity.

## Engineering Review

### Scope Challenge

- Existing code already solves the hard E2E path: worker health, inbound polling, Firestore queues, orchestrator turn processing, transcript append, outbound send.
- The minimum Phase 1 change is narrow: suppress duplicate outbox transcript writes for broker-managed outbound, then verify via tests and a fresh local worker restart.
- Larger reliability items are real but belong to Phase 2: outbound leases, processing reclaim, terminal safety states, and broader broker tests.

### What Already Exists

- `packages/pa-orchestrator/src/index.ts` already writes assistant transcript rows before enqueueing `pa_outbound`.
- `apps/macos-imessage-worker/src/outbox.ts` already owns outbound send and status updates.
- `packages/memory/src/stacked.test.ts` already establishes the local `node --import tsx --test` pattern reused for worker/safety tests.

### Issues Found

1. **Transcript ownership was split.** The orchestrator wrote assistant transcript rows, then the outbox appended the same assistant body as `role=user`.
   - Resolution: broker-managed `out-imessage-in-*` outbound no longer appends an outbox transcript message.

2. **Manual E2E still needs a fresh inbound message after restart.**
   - Resolution: verification status remains `human_needed` until one new real iMessage confirms no assistant-as-user echo.

3. **Model switch request cannot be safely executed.**
   - Resolution: earlier `gpt5.4nano` probe used the wrong model string. Official target slug is `gpt-5.4-nano`, so the live default stays unchanged until that exact slug passes a runtime probe.

## Design Review Prep

Phase 1 is backend correctness, so no visual fix was applied. The UI audit scope for Phase 3 is:

- Dashboard shell, active navigation, page headers.
- Overview health and queue summary.
- Conversations workbench.
- Operations tabs/detail/confirmation flows.
- Agent registry and platform danger zone.

`gstack-design-review` full audit/fix loop should run after either committing or stashing current work, because the skill requires a clean tree before it starts atomic design-fix commits.
