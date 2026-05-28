# P2 — Interaction layer · SUMMARY

**Branch:** `claude/agentic-P2-interaction-layer`, stacked on P0 tip `02c3e826` (orthogonal to P1).

**Outcome:** the Tier-1/Tier-2 interaction layer the architecture (§7) calls for is **largely already present**; P2 generalizes the slow-tool quick-ack reflex (flag-gated) and verifies the delivery-decision eval gate is green. The coupled deletion of the delivery regex is **staged** (flag-gated, like P1) because it touches 5 live consumers.

## Commits
- `985b9a70` — research + plan (the "mostly pre-built" finding + precise net-new scope).
- `0f4a6b39` — **`paReflexQuickAckEnabled` (default OFF)**: the slow-tool quick-ack now fires as a deterministic Tier-1 reflex for ANY connector over the latency threshold, independent of the Tier-2 narration flag (`isReflexQuickAckEnabled` mirrors `isConnectorNarrationEnabled`; gate at `run-connector-with-narration.ts:111`).

## What already exists (research receipts, file:line)
- **typing-before-every-bubble:** always-on `outbox.ts:481-493`; every bubble (single + `sendMemoryReply` fan-out) routes through it.
- **reflex quick-ack before slow tools:** `ConnectorDef.expectedLatencyMs` + `composeFindMatchPreCall` + `run-connector-with-narration.ts`; find-match/collab `ALWAYS_PRE_CALL`. P2 generalized it to all slow tools (flag-gated).
- **Tier-2 tapback / react / no-text+react:** fully built — `send-reaction.ts:88` + `store.sendReaction` + `handleConversationTapbackOnlyTurn` (index.ts:2412); breaker-isolated `sendblue-reaction`.
- **delivery-decision eval gate (model self-decides):** BFCL delivery **2/2** (`bfcl-fixtures/06,07` + `runDeliveryFixture`) — already proves the model decides tapback/text/no-reply (the precondition for deleting the regex).
- **mark-read:** NO Sendblue endpoint → typing-on-inbound as read proxy (architecture lock #7 fallback); flagged for Adam.

## Receipts
- tsc clean (pa-orchestrator + functions `--noEmit`).
- process-intact **5/5**, arbiter canary **PASS** (flag-OFF → delivery arbiter unchanged).
- regression: pa-orchestrator **1803/1803**, functions **2028/2028**.

## SELF-REVIEW
- [x] **KEYSTONE held?** The delivery DECISION (tapback/text/no-reply) belongs to the model (Tier-2; proven by BFCL); the reflexes (typing, quick-ack) are deterministic Tier-1. P2 generalized a reflex (deterministic) and did NOT move delivery logic into regex. ✔
- [x] **Deleted load-bearing deterministic logic?** No — nothing deleted (flag-gated additive). The delivery regex remains until its staged, rerouted deletion. ✔
- [x] **Process-intact eval:** 5/5. ✔
- [x] **Conversation-quality vs P0 baseline:** delivery 2/2 unchanged (gate green); no abstention/extraction regression. ✔
- [x] **Added behavior as registry/flag addition, not a new regex branch?** Yes — a flag + a helper + a one-line gate relaxation; no new regex. ✔
- [x] **connector.execute verdict + LLM narrates?** Unchanged. ✔
- [x] **Terminal idempotency once?** Unchanged. ✔
- [x] **Kept output normalizer; only deleted eval-proven-redundant voice?** Nothing deleted; normalizer untouched. ✔
- [x] **Regression green?** orch 1803, functions 2028. ✔
- [x] **Receipts present:** tsc, gates, regression. No deploy (flag default-OFF; Adam-gated). ✔
- [x] **LOC delta:** +~30 (helper + flag + gate). Collapse (−478 LOC `conversation-action-arbiter` + the `isShortLowInformationAck` regex) is STAGED behind the delivery deletion.

### Honest gaps (staged for the deletion step / next phase)
1. **Delivery-regex deletion staged.** `isShortLowInformationAck` + `decideConversationDeliveryAction` remain. Coupled to: live tapback dispatch `index.ts:4458`, `runner.mjs:348` `expect.action` fixture, `buildConversationEvidenceWrites` `job_interest` signal, `conversation-action-arbiter.test.ts` + `arbiter-fixtures.test.ts`, 2 scripts. Delete only after: (a) reroute the live tapback dispatch to a model-decided delivery (else low-info acks invert to full text bubbles), (b) port `runner.mjs` `action`→`mode`, (c) re-emit the evidence signal.
2. **mark-read** has no Sendblue endpoint — typing-proxy fallback; Adam to confirm a read API.
3. **Choreography-timeline fixture** (mark-read→tapback→quick-ack→typing→result) not yet added; the deterministic reflexes are individually verified but not asserted as one ordered timeline.
