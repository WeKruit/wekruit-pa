# P2 — Interaction layer · CONTEXT

**Branch/worktree:** `claude/agentic-P2-interaction-layer` @ `.claude/worktrees/agentic-P2-interaction-layer`.
**Base:** P0 tip `02c3e826` (carries the two-layer eval foundation P2 needs). Orthogonal to P1 (job-search) — based on P0, NOT P1, so P2's diff is interaction-layer only. Retarget to main once P0 merges.

## Goal (V3-AGENTIC-GOAL-PROMPT.md P2)
- **Tier 1 reflexes (deterministic, no LLM):** mark-read on EVERY inbound (verify Sendblue has a mark-read endpoint first; if absent → typing-only + flag Adam); typing indicator before EVERY outbound bubble; reflex quick-ack from a small rotation pool ("sure, one sec") before a known-slow tool (decision (a) = reflex pool, Adam-confirmed).
- **Tier 2 expressive (LLM-decided tools):** `send_message`, `react_to_user(reaction)`, no-text+react (tapback only for low-info acks while processing), multi-bubble split.
- **Delete** `conversation-action-arbiter` delivery regex (`isShortLowInformationAck` etc., conversation-action-arbiter.ts:412 + peers, 478 LOC).
- **Eval gate:** delivery-decision fixtures green; choreography timeline (mark-read → tapback → quick-ack → typing → result) verified.

## Architecture locks (P2-relevant)
- #7 two-tier interaction (Reflex + Expressive). Reflex trigger is deterministic; ack WORDING may carry voice via the pool/prompt. Slow-tool list maintained deterministically.
- #0 KEYSTONE: delivery DECISION (tapback vs text vs no-reply) = LLM (Tier 2 tool); the reflexes (mark-read, typing) = deterministic.
- Lock: never delete the delivery regex until the conversation-quality delivery eval proves the model self-decides delivery. (P0 BFCL delivery baseline = 2/2 — the seed eval.)

## Key research questions (for the next cycle)
1. Sendblue mark-read endpoint — does it exist? (check apps/functions/src/sendblue/*). If not → typing-only fallback + flag Adam.
2. Current delivery decision: `conversation-action-arbiter.ts` `isShortLowInformationAck` (L412) + `decideConversationDeliveryAction` — what it decides + who consumes it (runner.mjs arbiter canary asserts `action`).
3. Outbound path: how bubbles + typing indicators are sent (sendImessage / sendMemoryReply); where to insert typing-before-every-bubble + the reflex quick-ack.
4. The Tier-2 tools (react_to_user / no-text+react / multi-bubble) — are any wired in the agent runtime already? Add as connectors/tools.
5. Eval: extend the P0 BFCL delivery fixtures (06-delivery-low-info-ack, 07-delivery-substantive) into the P2 delivery-decision gate + a choreography-timeline assertion.

## Status
Worktree created + build kicked. Implementation deferred to the next loop cycle (P0+P1 delivered as PRs #251/#253; context limit reached at the P1→P2 boundary).
