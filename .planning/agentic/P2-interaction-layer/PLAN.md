# P2 — Interaction layer · PLAN (research-derived)

## Major finding: most of the Tier-1/Tier-2 layer ALREADY EXISTS

| Piece | Status | Where |
|---|---|---|
| typing-before-every-bubble | ✅ already (always-on) | `apps/functions/src/sendblue/outbox.ts:481-493`; every bubble (single + `sendMemoryReply` fan-out) routes through it |
| reflex quick-ack before slow tool | ✅ exists (rotation pool) | `ConnectorDef.expectedLatencyMs` (connector-types.ts:66) + `composeFindMatchPreCall` (job-match-narration.ts:63) + `run-connector-with-narration.ts:70-122` (fires when `expectedLatencyMs >= latencyMinMs`) |
| tapback / react_to_user / no-text+react | ✅ fully built | `sendblue/send-reaction.ts:88` + `store.sendReaction` (index.ts:812) + `handleConversationTapbackOnlyTurn` (index.ts:2412); breaker-isolated key `sendblue-reaction` |
| delivery decision (the regex to delete) | exists | `conversation-action-arbiter.ts` `isShortLowInformationAck` L412 + `decideConversationDeliveryAction` L67 + enum L7-15 |
| delivery eval gate (model self-decides) | ✅ GREEN (P0) | BFCL `bfcl-fixtures/06,07` + `runDeliveryFixture` — delivery 2/2 baseline already proves the model decides tapback/text/no-reply |
| **mark-read** | ❌ **NO Sendblue endpoint** | only `send-message` + `typing-indicator` (`sendblue-client.ts:26`). Read-receipts are inbound webhook types only. → typing-as-read-proxy + ADAM DECISION |

## Net-new P2 work (small — the layer is mostly built)
1. **Reflex quick-ack independence:** relax `run-connector-with-narration.ts:109-111` so the slow-tool quick-ack fires on `expectedLatencyMs` regardless of the narration flag (make it a true Tier-1 reflex). One-line gate change + a test.
2. **Mark-read fallback:** confirm typing-on-inbound (`webhook.ts:114`) as the read proxy; FLAG ADAM (no Sendblue mark-read API — architecture lock #7 fallback).
3. **Delete `isShortLowInformationAck` + the 3 helpers it alone uses (L412-444)** — the delivery DECISION is proven model-side (BFCL 2/2), satisfying the lock. COUPLED deletion (stage like P1): cannot drop `decideConversationDeliveryAction` wholesale until consumers migrate — (i) `index.ts:4435/4458` live tapback dispatch reroute, (ii) `runner.mjs:348` `expect.action` → bfcl `mode`, (iii) `buildConversationEvidenceWrites` L338-356 re-emit the `job_interest` signal, (iv) tests `conversation-action-arbiter.test.ts` + `arbiter-fixtures.test.ts` + `scripts/audit-turn-arbitration.mjs`/`conversation-arbiter-auto-pr.mjs`.
4. **Eval:** add a `choreography` BFCL fixture kind asserting the ordered timeline (typing→quick-ack→typing→result; mark-read step optional since unavailable) + `08-choreography-slow-tool.json`; port the legacy `runner.mjs` `action` fixtures to `mode`.

## Approach (P1 pattern): flag-gate the risky delivery-arbiter deletion behind `paAgenticDeliveryEnabled` (default OFF); the eval gate (BFCL delivery + choreography) is the precondition (already green). Reflexes #1/#2 are safe/additive.

## Risks
- Mark-read gap → cannot fabricate `/send-read`; degrade to typing proxy + Adam.
- `runner.mjs` `action`-fixture + 4 other consumers couple the delivery-arbiter deletion — migrate before deleting or hard-fail.
- Deleting the arbiter without rerouting `index.ts:4457` tapback dispatch INVERTS the regression (low-info acks become full text bubbles). Reroute first.
