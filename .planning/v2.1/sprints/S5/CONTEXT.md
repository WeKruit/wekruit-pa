# S5 TCPA Plumbing + Compliance — CONTEXT

**Status:** PENDING. Blocked by S2 + S3 + S4 substantially done.
**Wave:** D (eval / compliance).
**Worktree (to create):** `.claude/worktrees/v21-S5-tcpa-compliance`.

## What S5 inherits

- S3 `outbound-bookings/{id}` state machine + dispatch trigger — S5 inserts gate check **before** `queued → dialing`.
- S2 voice worker — S5 inserts consent prompt as first agent utterance + recording start.
- S4 metrics — S5 logs gate-check decisions for audit.
- Locks L4 (TCPA dev=off / prod=on), L8 (recording consent prompt + 90d default retention).

## What S5 produces

- TCPA gate module: DNC list check + state quiet-hours table (≥3 US states) + prior-consent record check.
- Gate modes: `blocking` (when `PA_TCPA_GATE_ENFORCED=true`), `observed` (logs would-block but allows; `false`).
- Recording consent prompt inserted as worker first-utterance (depends on S2 hook).
- Audit collection `voice-tcpa-checks/{bookingId}` with reason codes.

## What S5 explicitly does NOT do

- ❌ Actual TCPA-compliant production sends — v2.2.
- ❌ Build operator UI for consent management — v2.2.
- ❌ Carrier-level DNC scraping — uses provided list only.
