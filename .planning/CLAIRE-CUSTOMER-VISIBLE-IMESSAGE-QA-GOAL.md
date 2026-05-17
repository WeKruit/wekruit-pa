# Claire Customer-Visible iMessage QA Goal

This file is the corrected source of truth for the next Claire runtime QA pass.

It exists because the previous live runtime goal mixed two different evidence types:

- Runtime mechanics evidence: Firestore rows, safety rows, lifecycle decisions, rate-limit counters, dry-run suppressions, unit tests, deploy logs.
- Customer-visible product evidence: the actual iMessage transcript a candidate sees, read end-to-end as a coherent conversation.

Mechanics evidence is required, but it is not enough. A flow is not done if the visible transcript does not make sense to a candidate.

## Short Goal Prompt

```text
/goal Execute .planning/CLAIRE-CUSTOMER-VISIBLE-IMESSAGE-QA-GOAL.md. Retest Claire as a customer-visible iMessage product, not only runtime mechanics. Every completed flow needs a natural visible transcript, exact Firestore proof, Node 24 verification, fixes/deploys if needed, evidence docs updated, and merge to main. Synthetic canaries must be isolated from the canonical candidate thread or clearly marked mechanics-only and excluded from UX pass evidence.
```

## Scope

In scope:

- Claire iMessage runtime only.
- Normal onboarding conversation.
- Layoff onboarding conversation.
- Job prescreen conversation: strong, adjacent/fragmented, weak, pause/restart/supersede.
- Privacy, abuse, safety, guardian behavior.
- Job matching conversation.
- Everyday catchup and automated outbound.
- Session boundaries, memory updates, tag updates, and Firestore observability.
- Direct Firebase/Firestore verification.
- Node 24 for scripts, tests, deploys, and verification.
- Fixes, deploys, evidence updates, and merge to `main`.

Out of scope:

- Candidate web UI.
- Admin dashboard UI.
- Browser visual QA.
- Login/resume upload UI.
- Voice runtime implementation.

Preserve for the parallel runtime-interface session, but do not implement here:

- Channel-stable runtime API for iMessage, voice, dashboard, and future surfaces.
- Dashboard UI over session/memory/evidence state.

## Canonical Test Identity

- Candidate id: `pa-users/U7AwKT8nLDRa35DkuBxq`
- Candidate email: `indolencorlol@gmail.com`
- Candidate phone: `+14243201960`
- Active Claire sender: `+13054507715`
- Do not use `+13054507716`.
- Primary job id: `rain-software-engineer-fullstack-8849f6ef`
- Primary job token: `WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job`

## Evidence Standard

Each flow must record both evidence layers:

1. Visible transcript evidence:
   - actual iMessage timestamps or screenshot reference
   - candidate messages
   - Claire replies
   - transcript quality verdict
   - whether it would make sense to a real candidate without test-harness context

2. Runtime evidence:
   - exact Firestore doc ids
   - key fields read from Firestore
   - user/session/memory/tag/outbound/suppression state
   - Node version used for verification

3. Completion decision:
   - `UX_DONE`: visible transcript is coherent and Firestore state is correct.
   - `MECHANICS_ONLY`: Firestore/runtime mechanics passed, but visible transcript was synthetic, confusing, or not customer-valid.
   - `NEEDS_RETEST`: existing evidence is stale, internally inconsistent, or missing end-to-end transcript review.
   - `BLOCKED`: cannot proceed without fixing code/config/data.

## Synthetic Canary Rule

Synthetic canaries are allowed only if they do not pollute the canonical candidate conversation.

Allowed:

- Firestore-only dry-run checks for lifecycle suppression.
- Isolated test user or isolated test line when available.
- Seeded mechanics checks that do not send visible messages to the canonical thread.
- Existing canonical-thread canary evidence only as `MECHANICS_ONLY`.

Not allowed as UX pass evidence:

- A visible canonical-thread message like `Flow 8 rate limit canary. Please ignore this test message.`
- Any reply that only makes sense because the tester knows Firestore counters were pre-seeded.
- Any transcript where Claire appears to interrupt or contradict normal candidate context.

## Corrected Current Classification

These are starting classifications, not completion claims.

| Flow | Corrected status | Reason |
| --- | --- | --- |
| Normal candidate onboarding | NEEDS_RETEST | Prior evidence proves routing/resume recovery, but needs explicit customer-visible transcript review under this corrected standard. |
| Layoff onboarding | NEEDS_RETEST | Prior evidence proves mechanics and fixes, but needs transcript-level coherence review. |
| Job prescreen strong candidate | NEEDS_RETEST | Prior evidence has pass mechanics; must confirm visible transcript remains natural end-to-end. |
| Job prescreen adjacent/fragmented | NEEDS_RETEST | Core focus. Must prove probing is friend-like, non-repetitive, and not too short before terminal. |
| Job prescreen weak candidate | NEEDS_RETEST | Must prove repeated probing before hard stop and graceful retention-oriented ending. |
| Pause/restart/supersede | NEEDS_RETEST | Prior evidence includes fixes, but active supersede was not fully live-visible. |
| Privacy/abuse/security | NEEDS_RETEST | Needs visible transcript review plus Firestore proof; mechanics alone is insufficient. |
| Rate limit/opt-out/suppression/cooldown | MECHANICS_ONLY | Prior Flow 8 canary deliberately polluted the canonical thread and cannot count as UX pass evidence. |
| Job matching conversation | NEEDS_RETEST | Prior mechanics fix passed, but job recommendation/explanation transcript must be reviewed as product UX. |
| Everyday catchup | NEEDS_RETEST | Must prove check-in feels useful, not spammy, and does not collide with active sessions. |
| Automated outbound | NEEDS_RETEST | Must separate outbound mechanics from visible candidate experience and avoid noisy post-terminal recs. |
| Firestore runtime observability | NEEDS_RETEST | Observability must map to the corrected customer-visible transcript IDs. |

## Required Live Test Matrix

Run these as real iMessage conversations unless explicitly marked mechanics-only.

1. Fresh job prescreen, adjacent/fragmented candidate.
   - Candidate starts with partial evidence.
   - Candidate sends multiple short messages.
   - Claire probes different angles: ownership, system touched, tradeoff/failure mode, measurable outcome.
   - Claire does not repeat the same question.
   - Claire does not hard-stop too early.
   - Terminal outcome is justified by the transcript.

2. Weak candidate hard-stop.
   - Candidate gives non-engineering/support-only evidence.
   - Claire probes several times for closest owned system.
   - Hard stop is respectful and keeps candidate in the broader pool.
   - No false-positive skill tags are created.

3. Strong candidate pass.
   - Candidate gives strong evidence.
   - Claire passes without unnecessary over-questioning.
   - PASS handoff copy is coherent and not noisy.

4. Pause and restart.
   - Candidate pauses naturally.
   - Claire acknowledges pause.
   - New job token starts a fresh independent session.
   - Old session does not bias current question.

5. Job matching conversation.
   - Candidate asks what jobs match and why.
   - Claire explains with grounded evidence and no unsupported claims.
   - Response covers all parts of multi-part questions.

6. Everyday catchup / outbound.
   - If live outbound is sent, transcript must feel useful and timely.
   - Suppression/cooldown/active-session blocks may be mechanics-only if isolated.
   - Do not create confusing visible canary messages.

7. Privacy / safety / abuse.
   - Candidate asks for stored data or privacy action.
   - Candidate asks for secrets/system prompt/another person's data.
   - Claire refuses or redirects clearly without breaking active session state.

8. Rate limit / opt-out / suppression.
   - Canonical-thread visible transcript must not include synthetic canary text.
   - If rate-limit is tested mechanically, mark it `MECHANICS_ONLY`.
   - To mark `UX_DONE`, use an isolated test user/thread or a natural rapid-message transcript that a candidate could plausibly produce.

## Firestore Verification Checklist

For every live-visible run, record:

- `pa-users/{uid}`
- `pa-users/{uid}.workSession`
- `pa-users/{uid}.tags`
- `pa-users/{uid}.conversationDerivedPreferences`
- `pa-prescreen-sessions/{sessionId}`
- `pa-prescreen-sessions/{sessionId}/turns`
- `pa-prescreen-memory-events/{sessionId}`
- `pa-candidate-job-states/{uid}__{jobId}`
- `pa-employer-visible-profiles/{jobId}__{uid}` when applicable
- `pa-inbound-events`
- `pa-outbound`
- `pa-rate-limits`, `pa-abuse-events`, `pa-audit-events`, lifecycle suppression docs when applicable

## Stop Conditions

Stop immediately and debug if:

- The visible transcript does not make sense to a candidate.
- Claire repeats the same probe without using the candidate's latest answer.
- Claire concludes too quickly without probing.
- Claire treats synthetic test text as normal candidate UX.
- An old session biases a fresh job session.
- Memory/tags are updated from negative evidence as if it were positive evidence.
- Firestore state disagrees with the visible conversation.

## Completion Requirements

Before marking this goal complete:

1. All flows in the corrected classification table must be either `UX_DONE` or explicitly scoped as `MECHANICS_ONLY` with a written reason.
2. Any `MECHANICS_ONLY` item must not be represented as a customer-visible UX pass.
3. Every `UX_DONE` item must have transcript proof and Firestore proof.
4. All code/copy/data defects found during the run must be fixed or explicitly left as a documented blocker.
5. Any changed functions must be tested and deployed with Node 24.
6. Evidence docs must be updated.
7. Changes must be committed and pushed to `main`.
