---
phase: 23-closed-beta-onboarding
type: context
milestone: v1.1
status: locked
locked_at: 2026-04-27
owner: adam
---

# Phase 23 — Closed Beta Onboarding + Safety (Context)

## Why this phase

WeKruit PA v1.1 launch gate requires onboarding ≤20 hand-picked beta users with operational guardrails. Two debts must close before the gate:

1. **No first-contact flow.** New users hit cold orchestrator turns. Voice v1 (Phase 18) ships `first_mes` but nothing routes it to a brand-new user.
2. **Abuse signals are schema-only.** `pa_abuse_events` exists (`packages/core-types/src/collections.ts`) but has zero producers wired in production despite Phase 17 hot-fixing allowlist-deny via console audit only.

Adam owns the beta runbook and the kill switch decision. Claude implements onboarding state, abuse producers, dashboard surfaces, and the Firestore migration of the allowlist source-of-truth.

## Hard scope (BETA-01 .. BETA-05)

| ID | Requirement | Phase 23 deliverable |
|----|-------------|----------------------|
| BETA-01 | First-contact flow uses Voice v1 first_mes; asks 1-2 grounding questions; sets up mem0 partition | Onboarding state machine in orchestrator + `pa_users.onboardingState` |
| BETA-02 | `pa_abuse_events` producers wired at 3 points | rate-limit-trip (already produces — confirm), prompt-injection-detect, allowlist-deny |
| BETA-03 | Dashboard abuse panel surfaces last 50 events with filter by type | New `/abuse` route in dashboard-web |
| BETA-04 | Allowlist UI in dashboard | New `/beta` route + Firestore-backed allowlist (CRUD without env edits) |
| BETA-05 | Beta runbook | `BETA-RUNBOOK.md` (one page) — onboarding script, escalation, kill switch |

## Locked decisions

**D-01 — Allowlist source-of-truth migrates env → Firestore (production); env stays for dev only.**
Rationale: BETA-04 explicitly demands "without editing `.env`". Two-source precedence: Firestore wins; `IMESSAGE_PEERS` env only honored when `PA_ALLOWLIST_SOURCE=env` (dev mode default for local worker). New collection: `pa_beta_participants`. Phase 21 (Sendblue) will read from same collection — no rework.

**D-02 — `pa_beta_participants` is a new collection (NOT extending `pa_users`).**
Rationale: `pa_users` is the user identity record (channel handles, mem0 partition). Beta participation is an orthogonal lifecycle: invited → active → suspended → removed. Mixing concerns would force `pa_users` to carry beta-only fields. Cross-link by `userId`.

Schema (locked):
```
pa_beta_participants/{participantId}
  id: string (uuid)
  contactHandle: string         // normalized: +E164 phone OR lowercased email
  contactType: "phone" | "email"
  userId: string | null         // null until first contact resolves to pa_users row
  status: "invited" | "active" | "suspended" | "removed"
  addedAt: ISO string
  addedBy: string               // operator email from Firebase Auth
  removedAt: ISO string | null
  notes: string | null
  metadata: { source?: string; cohort?: string }
```

**D-03 — Onboarding state lives on `pa_users`, not a new collection.**
Rationale: One field, one lifecycle, naturally per-user. Add `onboardingState: "pending" | "first_mes_sent" | "grounding_q1_asked" | "complete"` and `onboardedAt: ISO | null`. Driven by orchestrator on each inbound event.

**D-04 — Onboarding uses Voice v1 prompt unchanged.**
Rationale: Phase 18 ships `first_mes` already in-character. Onboarding does NOT introduce a separate utility prompt (mirrors PROACTIVE-04 pattern). Synthetic system input: `"onboarding_step: send_first_mes"` and `"onboarding_step: ask_grounding_q"`. The grounding questions are 1-2 prompts derived from Character Bible v1 (e.g., name + what brings them here).

**D-05 — Abuse panel is read-only with one mutation: `mark_resolved`.**
Rationale: Abuse events are append-only audit. Operator can annotate `resolvedAt` + `resolvedBy` + `resolutionNote` but cannot delete. This matches existing `pa_audit_events` semantics.

**D-06 — Kill switch = flip `pa_remote_config/platform.outboundPaused = true`.**
Rationale: `pa_remote_config` already exists (Phase 6 era). Outbox listener checks the flag before Sendblue/Photon dispatch. One-click in dashboard `/beta` panel sets the flag. Audit event written. Recovery requires explicit operator unflip.

**D-07 — Onboarding partition for mem0 is the existing `mem0UserId` semantics.**
Rationale: Phase 11 resolved mem0 identity. "Set up mem0 partition" = ensure `pa_users.mem0UserId` exists; orchestrator already lazy-creates this. Onboarding adds a `metadata.cohort = "beta-v1"` field on the user row for downstream filtering.

## Deferred ideas (NOT in Phase 23)

- Operator-issued one-time invite links (Phase 23 onboards by adding a phone/email; first inbound triggers onboarding flow).
- Multi-step structured intake form. Onboarding is conversational by design (1-2 questions max).
- Resolution workflows beyond `mark_resolved` (e.g., "auto-suspend after N abuse events"). Manual decision for closed beta.
- Per-user rate-limit overrides via dashboard.
- Email/SMS notification to operator on abuse-event creation (Slack hook deferred to post-beta).

## Claude's discretion

- Exact wording of the 2 grounding questions (must follow Character Bible v1 voice; Adam reviews via human-verify checkpoint).
- Internal API shape for `applyOnboardingStep` — orchestrator can structure however cleanest, as long as it's idempotent.
- Whether `/abuse` and `/beta` are two routes or one tabbed page (Claude picks; one tabbed page suggested for fewer clicks).
- Pagination implementation for the abuse list (cursor vs. offset; default to limit 50 newest).

## Cross-phase dependencies

- **Phase 18 (Voice v1)** — HARD. `first_mes` template must exist on the agent record. Phase 23 reads it; does not modify it.
- **Phase 17 (Allowlist fail-closed)** — HARD. Phase 17 added the allowlist-deny audit. Phase 23 formalizes it into a `pa_abuse_events` row with `kind=allowlist_deny`. Existing audit event stays (defense in depth).
- **Phase 20 (Output Normalizer)** — SOFT. If Phase 20 has shipped before 23 executes, onboarding output is normalized for free. If not, Voice v1 first_mes is hand-curated and passes iMessage rendering already (no markdown).
- **Phase 21 (Sendblue migration)** — SOFT. Phase 21 will read `pa_beta_participants` for its allowlist gate. Phase 23 must define the schema cleanly so Phase 21 doesn't reshape it.
- **Phase 22 (Proactive Check-in)** — INDEPENDENT. No conflict.

## Files this phase will touch

- `packages/core-types/src/collections.ts` — add `betaParticipants` constant.
- `packages/core-types/src/index.ts` — export `BetaParticipant`, `OnboardingState` types; extend `User` with onboarding fields.
- `packages/pa-safety/src/index.ts` — `checkPromptInjection` produces abuse event when blocking; export `recordAllowlistDeny()`.
- `packages/pa-orchestrator/src/index.ts` — onboarding state machine + injection-detection abuse producer wiring.
- `packages/pa-orchestrator/src/onboarding.ts` (NEW) — onboarding step resolver.
- `packages/pa-orchestrator/src/allowlist.ts` (NEW) — Firestore-first allowlist resolver (Firestore wins, env fallback).
- `apps/macos-imessage-worker/src/config.ts` — read from new resolver.
- `apps/dashboard-web/src/pages/Abuse.tsx` (NEW) — abuse panel.
- `apps/dashboard-web/src/pages/Beta.tsx` (NEW) — allowlist + kill-switch UI.
- `apps/dashboard-web/src/App.tsx` (or router) — register routes.
- `.planning/phases/23-closed-beta-onboarding/BETA-RUNBOOK.md` (NEW) — one-page operator runbook.
- `config/firebase/firestore.rules` — rules for `pa_beta_participants` (write: @wekruit.com only; read: same).

## Out of scope for Phase 23

- WhatsApp / web fallback (P1).
- GDPR delete cascade (P1).
- Allowlist phone-number portability (Sendblue concern in Phase 21).
- Auto-promotion of `invited → active` on first inbound (we keep operator-managed status for beta to catch onboarding bugs early; status is set manually after sanity check).

Wait — D-08 below clarifies.

**D-08 — `status=invited` is the single accept gate. Inbound from `invited` participant triggers onboarding flow AND auto-promotes status to `active` after `complete` step.**
Rationale: Reduces operator toil. Operator only acts to suspend/remove. The status promotion is a single transaction at end of onboarding.

---

*Locked 2026-04-27. Modifications require explicit Adam approval.*
