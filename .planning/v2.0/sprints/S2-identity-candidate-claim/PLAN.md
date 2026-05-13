# S2 Plan

## Purpose

Build the identity and claim layer that lets WeKruit retain candidates as global
supply. S2 must make email, PDF resume extraction, phone, browser uid, ATS, and
Sendblue resolve to one canonical `pa-users/{candidateId}` profile without raw
PII document ids.

## Observable Outcome

A candidate can:

- open `candidate.wekruit.com/login`;
- request an email magic link;
- complete the link on the candidate domain;
- land on `/me`;
- see profile and resume data tied to the same global profile that public CV,
  phone/iMessage, and ATS paths resolve.

An operator can:

- open a candidate profile inspector;
- see linked handles, claim/auth mapping, and merge history;
- inspect identity conflicts when employer-provided email disagrees with
  PDF-extracted email.

## Locked Invariants

- Candidate profile is the durable asset; job is a demand event.
- Candidate claim is email magic-link first, not Gmail-only OAuth.
- PDF-extracted email is primary for resume identity. Employer email is a hint.
- No raw PII in public document ids.
- Identity merge is deterministic and audited.
- LLM output never owns lifecycle transitions.
- Match score never blocks the first interview.
- NOT_PASS keeps candidate in the global marketplace pool.
- Employer surface remains passed-profile-only.
- Candidate routes stay on `candidate.wekruit.com` / `pa.wekruit.com`.

## Data Model And Ownership

Canonical root:

- `pa-users/{candidateId}` remains the global candidate profile row.

Handle lookup:

- `pa-candidate-handles/{kind}__{handleHash}` is the unique handle index.
- `handleHash` is a deterministic SHA-256 of normalized handle material plus
  handle kind.
- `normalizedValue` may be stored because the collection is not public, but it
  is never used as a document id.
- Email normalization: trim and lowercase.
- Phone normalization: existing E.164 values only; no weak phone guessing.
- Browser uid normalization: existing `wkr_uid` UUID string.

Candidate auth mapping:

- `pa-candidate-auth/{firebaseUid}` maps Firebase Auth uid to `candidateId`.
- Only Admin SDK writes this mapping.
- Candidate self-read rules use this mapping, not client-supplied candidate ids.

Candidate self profile:

- `pa-candidate-self-profiles/{candidateId}` is the redacted candidate-facing
  projection for `/me` and `/me/profile`.
- `pa-users/{candidateId}` remains the raw global profile root and stays
  server/operator owned. Firestore rules cannot field-filter document reads, so
  S2 must not grant candidates direct reads of raw `pa-users`.

Identity events:

- `pa-candidate-identity-events/{eventId}` records handle links, claims,
  canonical-user selection, duplicate suspicion, and merge decisions.
- Events are append-only and redacted.

Identity conflicts:

- `pa-candidate-identity-conflicts/{conflictId}` records deterministic review
  items for:
  - PDF-extracted email differs from employer-provided email;
  - one handle points at two candidate ids;
  - same phone and different verified email indicate duplicate suspicion.

Candidate lifecycle:

- Claim flow emits reducer-owned lifecycle events:
  - `profile_created` if a new global row is created;
  - `handle_linked` for verified/deliverable email;
  - `candidate_claimed` after magic-link auth succeeds.

## UI Surface Map

Candidate site:

- Add `/login` for email magic-link request and link completion.
- Add `/me` for candidate home: lifecycle, resume on file, claim state, active
  opportunities summary placeholder from own job states.
- Add `/me/profile` for resume/profile data and linked handles.
- Keep public job `/j/:jobId` unchanged except for optional sign-in/profile
  links that do not block first interview.

Admin site:

- Extend marketplace inspector with auth mapping, merge events, and conflicts.
- Add a focused identity conflict queue under admin navigation.
- Do not create employer browsing or employer-facing claim tools.

## Backend / API / Service Map

Core contracts:

- Extend `@pa/core-types` with candidate-auth, identity-event, and
  identity-conflict schemas plus collection constants.
- Keep pure normalizers in shared code only when they do not import Node-only
  modules. Hashing can live in Node persistence/functions code.

Persistence:

- Add identity service helpers in `@pa/pa-persistence`:
  - normalize identity handles;
  - compute handle ids;
  - link handle to candidate;
  - resolve or create candidate by extracted email;
  - record claim/auth mapping;
  - record merge event;
  - record conflict deterministically.

Functions:

- Add authenticated callable `paCandidateClaimProfile`.
- The callable verifies Firebase Auth email, resolves/creates canonical
  candidate, links the verified email handle, writes auth mapping, applies the
  candidate lifecycle event, and returns a redacted profile payload.
- Update `public-cv-ingest` / `ingestCv` so the parsed PDF email can resolve a
  canonical candidate before `parsedCandidateResumes` and `pa-users.tags` are
  written.
- Update ATS handling so applicant email is a hint and resume/PDF email
  mismatch records a conflict.

Firestore rules:

- Keep operator access.
- Add candidate self-read only for the candidate's own
  `pa-candidate-auth/{request.auth.uid}` mapping and
  `pa-candidate-self-profiles/{candidateId}` through that mapping.
- Keep raw `pa-users`, identity events, identity conflicts, correction events,
  employer-visible snapshots, and operator audit data operator-only.

## Executor Topology

Executor A - Identity Contracts And Persistence:

- Write scope: `packages/core-types/src/marketplace.ts`,
  `packages/core-types/src/collections.ts`, `packages/core-types/src/index.ts`,
  `packages/core-types/src/*.test.ts`,
  `packages/pa-persistence/src/identity.ts`,
  `packages/pa-persistence/src/identity.test.ts`,
  `packages/pa-persistence/src/index.ts`,
  `packages/pa-persistence/package.json`.
- Owns schemas, handle hashing, deterministic identity resolution, auth mapping,
  conflict/event persistence, and core tests.

Executor B - Functions Integration:

- Write scope: `apps/functions/src/identity/*`,
  `apps/functions/src/index.ts`, `apps/functions/src/public-cv-ingest.ts`,
  `apps/functions/src/cv-ingest/cv-ingest.ts`,
  `apps/functions/src/cv-ingest/__tests__/*`,
  `apps/functions/src/ats-inbound-handler.ts`,
  `apps/functions/src/ats-inbound-handler.test.ts`,
  `apps/functions/package.json` if needed.
- Owns callable claim API and existing intake path integration.
- Depends on Executor A's persistence interface.

Executor C - Candidate Site Claim UI:

- Write scope: `apps/pa-landing/src/lib/firebase.ts`,
  `apps/pa-landing/src/main.tsx`,
  `apps/pa-landing/src/pages/Login.tsx`,
  `apps/pa-landing/src/pages/Me.tsx`,
  `apps/pa-landing/src/pages/Profile.tsx`,
  `apps/pa-landing/src/pages/PublicJob.tsx` if adding non-blocking links,
  `apps/pa-landing/package.json` if needed.
- Owns `/login`, `/me`, `/me/profile`, auth state, callable client, and
  candidate-domain build verification.
- Depends on Executor B's callable response shape.

Executor D - Admin, Rules, Acceptance:

- Write scope: `apps/dashboard-web/src/pages/CandidateMarketplace.*`,
  `apps/dashboard-web/src/pages/IdentityConflicts.tsx`,
  dashboard tests, `apps/dashboard-web/src/App.tsx`,
  `config/firebase/firestore.rules`,
  `config/firebase/firestore.indexes.json`,
  S2 acceptance docs/artifacts.
- Owns operator debug visibility, conflict queue, rules/indexes, acceptance
  ledger, and deploy notes.
- Depends on Executor A's collection names and B/C query shapes.

Shared files:

- `pnpm-lock.yaml` is lead-owned after package script/dependency changes.
- `firebase.json` should not change unless a deploy target gap is proven.

## Agent Plan Handshake

Before implementation, each executor must return `AGENT_PLAN` only. The lead
will append the executor plans to `EXECUTOR-PLANS.md`, resolve shared-file
ownership, and write an integration note here before code changes begin.

## Integrated Execution Note

Executor plans are integrated.

1. File write scopes are mostly disjoint. Executor A owns core contracts and
   persistence identity helpers. Executor B owns functions integration.
   Executor C owns the candidate site. Executor D owns dashboard identity
   visibility, rules, indexes, and acceptance docs. The lead owns sprint docs
   and `pnpm-lock.yaml`.
2. Shared sequencing is explicit. A lands collection constants, schemas,
   normalizers, and persistence helpers first. B consumes those helpers for the
   callable, CV ingest, and ATS handling. C consumes B's callable response. D
   consumes A's collection names and B/C read paths.
3. Data contracts are consistent. New candidate ids are random Firestore ids,
   not email-hash-derived ids. Uniqueness comes from hashed handle docs in
   `pa-candidate-handles/{kind}__{handleHash}`. This avoids stable
   PII-derived profile roots.
4. S2 gets dedicated append-only identity observability collections:
   `pa-candidate-auth`, `pa-candidate-self-profiles`,
   `pa-candidate-identity-events`, and `pa-candidate-identity-conflicts`.
   Existing `pa-audit-events` may receive summary audit rows, but it is not the
   only identity debugging source.
5. Candidate self-read does not target raw `pa-users`. The claim callable
   returns a redacted payload and writes `pa-candidate-self-profiles` for
   candidate pages. Firestore rules permit candidate reads only through
   `pa-candidate-auth/{request.auth.uid}`.
6. Claim API is an authenticated Firebase callable. The trusted email comes
   from Firebase Auth after email-link sign-in. Client data such as browser
   `wkr_uid` is attribution/handle evidence only, never the trusted identity.
7. ATS email conflict outcome is `identity_conflict`. A conflict does not
   silently merge, create a second candidate, or send outbound. It writes a
   review record and returns a rejected/manual-review outcome.
8. Backend primitives have UI visibility. Admin sees handles, auth mappings,
   identity events, and conflicts; candidates see only redacted self-profile
   state.
9. HITL edits become flywheel data. Identity conflicts and later operator
   resolutions write identity events and correction events.
10. No executor plan violates product invariants. Candidate flow stays on
   `apps/pa-landing`; no employer browsing, scheduling, notes, or message
   delegation is introduced.

Lead answers to executor questions:

- The missing-doc reports were caused by a lead-side setup timing issue. The
  S2 docs are now present in this worktree; implementation proceeds from this
  integrated plan.
- Use dedicated identity event/conflict collections plus summary audit rows.
- New candidate profiles use random Firestore ids.
- Claim API is Firebase callable requiring authenticated email-link context.
- Candidate-readable fields live in redacted self-profile payload/docs only:
  lifecycle, profile completeness, resume summary/artifact pointers safe for the
  candidate, linked handle status labels, global tags/preferences intended for
  candidate display, and candidate-owned opportunity summaries. Raw conflicts,
  merge lineage, correction/audit rows, employer snapshots, and match-debug
  internals are operator-only.
- `/me` should hard-route signed-out users to `/login` or render the login
  prompt as the primary action; it must not expose profile placeholders as if
  the user is recognized.
- `IdentityConflicts` is a standalone admin route because S2 explicitly
  requires a conflict queue, but it remains operator-only and is not an
  employer candidate list.

## Waves

Wave A - Contracts, reducers, and failing tests:

- Add identity/auth/conflict schemas and collection constants.
- Add pure tests for normalization, hash ids, same email across browser uids,
  employer-email mismatch, phone-only, and duplicate upload idempotency.

Wave B - Services and APIs:

- Implement persistence identity service.
- Add `paCandidateClaimProfile` callable.
- Wire public CV ingest to resolve canonical candidate after PDF parse and
  before permanent profile writes.
- Wire ATS email hints and conflict creation.

Wave C - Candidate and admin UI:

- Build `/login`, `/me`, `/me/profile` on `apps/pa-landing`.
- Extend candidate marketplace inspector with handle/claim/merge event state.
- Add admin identity conflict queue.

Wave D - Eval, simulation, HITL, and dry-run harness:

- Add local identity simulation for the five roadmap cases.
- Add conflict queue fixtures.
- Keep outbound/live candidate contact disabled.

Wave E - Integration, deploy, and summary:

- Run targeted tests and standing v1.9 regressions.
- Run candidate and admin builds.
- Run local browser smoke for `/login`, `/me`, and admin conflict/inspector
  routes.
- Deploy functions, candidate hosting, dashboard hosting, Firestore rules, and
  indexes if code/rules changes land.
- Update acceptance and summary with exact outputs.

## Verification Harness

Targeted checks:

- `pnpm --filter @pa/core-types test`
- `pnpm --filter @pa/core-types typecheck`
- `pnpm --filter @pa/pa-persistence test`
- `pnpm --filter @pa/pa-persistence typecheck`
- `pnpm --filter @pa/functions test`
- `pnpm --filter @pa/functions typecheck`
- `npm run build --workspace=@pa/landing`
- `npm run build --workspace=@pa/dashboard-web`

Identity scenarios:

- same PDF email plus same phone maps to one profile;
- same email across different browser `wkr_uid` maps to one profile;
- employer email differs from PDF email records a conflict and prefers PDF;
- no email in PDF but phone exists links by phone without inventing email;
- duplicate upload is idempotent and does not create a second candidate.

Standing regression:

- `pnpm --filter pa-orchestrator test`
- `cd apps/functions && pnpm test`
- `curl -sS -i -I https://candidate.wekruit.com/`
- `curl -sS -i -I https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`
- `curl -sS -i -I https://wekruit-pa.web.app/j/hs-11005382-invoko-product-designer`
- `curl -sS -i -X POST https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest -H 'content-type: application/json' -d '{}'`

Post-deploy checks, if S2 lands:

- candidate `/login` returns HTTP 200;
- candidate `/me` redirects or prompts when signed out;
- admin `/j/*` still 301s to candidate domain;
- unauthenticated Firestore REST reads of identity collections are denied.

## HITL / Flywheel

S2 creates the first identity HITL queue. Conflict resolution is not allowed to
silently rewrite identity. Every operator resolution must become a correction or
identity event that can later seed regression fixtures.

## Safety And Privacy

- No raw PII document ids.
- Candidate auth mapping is server-owned.
- Candidate self-read goes through Firebase Auth uid mapping, never a URL
  candidate id.
- Conflict records are redacted and operator-only by default.
- No live outbound or paid eval during S2 implementation.
- No production merge/delete without explicit approval.

## Progress

- [x] S1 landed and deployed.
- [x] S2 worktree created from updated `main`.
- [x] S2 context drafted.
- [x] S2 plan drafted.
- [x] Executor plans collected.
- [x] Integrated execution note written.
- [ ] Wave A implemented.
- [ ] Wave B implemented.
- [ ] Wave C implemented.
- [ ] Wave D implemented.
- [ ] Acceptance complete.

## Decision Log

- `pa-users/{candidateId}` remains the canonical profile root.
- Candidate magic-link auth uses Firebase Auth email link plus a server-owned
  `pa-candidate-auth/{firebaseUid}` mapping.
- Public CV identity resolution must happen before permanent resume/profile
  writes when extracted email is available.
- Employer email mismatch is a review conflict, not silent duplicate creation.

## Surprises

Pending implementation.

## Outcomes

Pending implementation.
