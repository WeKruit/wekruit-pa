# DESIGN — LinkedIn One-Tap Login + Coresignal Enrich (résumé OPTIONAL)

Status: DESIGN ONLY (no code in this pass). Owner lens (Adam 2026-06-02):
**"super easy to start" — minimize friction above all. One-tap LinkedIn login,
zero wall of questions, Claire pitches FROM their data, résumé optional if
LinkedIn.**

This is **mostly a wiring job, not a build job.** A LinkedIn OAuth login flow
ALREADY EXISTS and ALREADY mints a Firebase session + links the candidate. A
Coresignal adapter + identity resolver + handle index ALREADY EXIST. The net-new
surface is small and bounded. See "Reusable vs net-new" below.

---

## 0. The one-line summary

SMS/QR → tap → `paLinkedinAuthStart` (existing) → LinkedIn OAuth on mobile →
`paLinkedinCallback` (existing) mints a custom token + (NEW) records the OAuth
LinkedIn identity as a **canonical** handle → candidate lands on
`/login` → `verifyCandidateMagicLinkSession` (existing) claims the
`pa-users/{uid}` profile → (NEW) async `paCoresignalEnrichSelfSignup` resolves
the candidate's LinkedIn URL → Coresignal profile → runs the **existing**
`coresignal-collect-v2` adapter → **existing** `upsertCandidateFromExternalRecord`
merges into the SAME `pa-users/{uid}` → Claire pitches from the enriched data
(thin path, the PART 2 work). Résumé becomes an optional "want to add a résumé
too?" nudge, never a gate.

---

## 1. What already exists (verified in-repo)

### 1a. LinkedIn OAuth login — FULLY BUILT
`apps/functions/src/linkedin-auth.ts`:
- `paLinkedinAuthStart` (HTTP, `onRequest`) — builds the LinkedIn authorize URL
  (`openid profile email` scope), HMAC-signs a `state` (`buildLinkedinState`,
  10-min TTL), redirects. Allowed-origin guard `isAllowedReturnTo` already
  includes `candidate.wekruit.com`, `pa.wekruit.com`, `wekruit.com`,
  `wekruit-pa-landing.web.app`.
- `paLinkedinCallback` (HTTP) — exchanges code → token → `fetchLinkedinUserInfo`
  (`/v2/userinfo` → `{sub,email,name,picture}`), then in `mode!=="connect"`
  (login mode): `buildLinkedinUid(sub)` = `li_<sha256(linkedin:sub)[0:40]}`,
  `ensureFirebaseUser`, `createCustomToken(uid,{provider:"linkedin.com",
  linkedinSub, linkedinEmail, linkedinName})`, returns `{ok:true, customToken}`
  to the SPA via `window.name` handoff.
- Callback secrets already wired: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
  (defineSecret). Redirect URI hardcoded:
  `https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinCallback`.

### 1b. Login SPA — FULLY BUILT
`apps/pa-landing/src/pages/CandidateLogin.tsx`:
- "Continue with LinkedIn" button → `startProviderSignIn("linkedin")` →
  `window.location.assign(LINKEDIN_AUTH_START_URL?returnTo=…/login?next=…)`.
- On return, `takeLinkedinAuthPayload()` reads `window.name`,
  `signInWithCustomToken`, then `finishSignedIn()` →
  `verifyCandidateMagicLinkSession({ registrationEntryPath })`.
- This is literally the "one-tap" surface already. Mobile-friendly (full-page
  redirect, not popup).

### 1c. Magic-link verify already understands LinkedIn
`apps/functions/src/candidate-magic-link-verify.ts` (`paCandidateMagicLinkVerify`):
- Input already accepts `linkedinUrl`, `linkedinSignIn`, links handles, assigns a
  Sendblue sender number, returns `portalReady`, `claireConversationStarted`,
  `hasResumeOnFile`. `claimCandidateProfile` + `linkCandidateHandle` are the
  claim primitives.

### 1d. Coresignal ingest — FULLY BUILT (admin/batch path)
- Adapters: `apps/functions/src/external-supply/adapters/coresignal.ts`
  (CSV/JSON export) + `…/coresignal-collect-v2.ts` (live cdapi v2 `collect/{id}`
  response shape). Both map `linkedin_url → canonicalLinkedInUrl` +
  `linkedinProfileHash = linkedinHash(canonical)`.
- Live client: `packages/external-supply/src/coresignal-collect-client.ts`
  `fetchEmployeeCollect(id, {apiKey})` → GET
  `…/employee_multi_source/collect/{id}`.
- Batch CF: `apps/functions/src/external-supply/coresignal-batch-fetch.ts`
  (`paCoresignalFetchBatch`) — fans IDs → collect → `runCreateBatch` →
  records → identity-resolve. Secret `CORESIGNAL_API_KEY` ALREADY defined.
- Search: `apps/functions/src/admin-coresignal-agentic-search.ts` →
  `https://api.coresignal.com/cdapi/v2/agentic_search/reasoning` (same
  `CORESIGNAL_API_KEY`).

### 1e. Identity resolution — FULLY BUILT
- `packages/pa-persistence/src/external-supply-identity.ts`
  `resolveExternalSupplyIdentity(db, record)`:
  - LinkedIn hash hit → `merge_existing` (returns the existing candidateId).
  - LinkedIn novel → `create_new`.
  - LinkedIn→A but email→B → `needs_review` (`linkedin_email_candidate_mismatch`)
    + writes `pa-candidate-identity-conflicts` doc.
  - email-only / fuzzy → `needs_review` / `blocked`.
- `upsertCandidateFromExternalRecord` (pa-persistence) — sole mutator;
  merges into `pa-users.globalTags`; the batch runner additionally dual-writes
  legacy `pa-users.tags` via `dualWriteLegacyUserTagsFromExternal` + mirrors
  Coresignal experiences into `parsedCandidateResumes` via
  `runCoresignalExperiencesMirror` (so Claire/find_match can read them).
- Handle index: `pa-candidate-handles/<kind>__<sha256>`; `linkCandidateHandle`
  (pa-persistence) is the writer; `hashCandidateHandle("linkedin", value)` and
  `linkedinHash(canonical)` BOTH route through
  `candidateHandleHashMaterial("linkedin", …)` — i.e. **the OAuth path and the
  Coresignal path can share one LinkedIn handle index** IF the OAuth path stores
  the canonical URL (see Risk R1 — today it stores an `oauth-linked/<sub>`
  marker, not the canonical URL; this is THE fix that makes the merge
  deterministic).

---

## 2. The exact link / flow

### 2a. Entry surfaces (all reuse existing routes)
1. **SMS-delivered link** (primary, "super easy"): Claire (or the QR-prefill SMS)
   sends one tap link:
   `https://candidate.wekruit.com/login?next=/onboarding&p=li`
   (`p=li` = optional hint so the page can auto-fire LinkedIn — see 2b).
2. **QR card → prefilled SMS** (existing `imessage_first_qr_onboarding` design):
   unchanged; the same login link can ride in the SMS body, OR the QR can deep
   link straight to `/login?next=…&p=li`.
3. **`/login` page button** (existing): "Continue with LinkedIn" already present.

C-end ONLY — `candidate.wekruit.com` / `wekruit.com` / `pa.wekruit.com`. Never
the admin domain. (`isAllowedReturnTo` already enforces this server-side.)

### 2b. One-tap auto-fire (NEW, tiny)
- `CandidateLogin.tsx`: if `searchParams.get("p")==="li"` and no session yet,
  auto-invoke `startProviderSignIn("linkedin")` on mount (skip the button tap).
  Net: link → LinkedIn consent screen, literally one tap.

### 2c. OAuth round trip (EXISTING + one additive write)
- `paLinkedinAuthStart` → LinkedIn authorize (mobile web) → user taps "Allow" →
  `paLinkedinCallback`:
  - EXISTING: mint `li_<hash>` uid + custom token.
  - **NEW (additive):** also persist the LinkedIn identity onto the user doc so
    the SPA + enrich worker can read it:
    - `pa-users/{li_uid}.linkedinUrl` = canonical URL **if** `userinfo`/the
      authorize response yields a usable public profile URL. NOTE: LinkedIn's
      OIDC `/v2/userinfo` returns `sub/email/name/picture` but **NOT** the public
      `/in/<slug>` URL (Risk R2). So we cannot reliably get the canonical URL
      from OIDC alone. Two honest options (decide before build):
      - **Option A (recommended, lowest friction):** Do NOT require the canonical
        URL at login. Bind a deterministic **OAuth-sub LinkedIn handle**
        (`linkedin_sub:<sub>`) as the join key, AND resolve the canonical URL
        asynchronously via Coresignal search (the enrich worker uses name+email
        +sub to search Coresignal, gets back the canonical URL + the numeric
        Coresignal id, THEN binds the canonical `linkedin` handle). One-tap UX
        is preserved; canonical URL/merge is settled async.
      - **Option B:** Request LinkedIn's member-snapshot / `r_basicprofile`
        product (not granted by default on the consumer app) to get the vanity
        URL at login. Higher LinkedIn-app-review cost. Defer.
  - Either way `paLinkedinCallback` writes `linkedinOauthLinked:true`,
    `linkedinOauthSub:<sub>`, `linkedinOauthEmail`, `linkedinOauthName` (it
    already writes most of these in `connect` mode; extend `login` mode to do the
    same).

### 2d. Claim (EXISTING)
- SPA `finishSignedIn()` → `verifyCandidateMagicLinkSession({linkedinSignIn:true,
  registrationEntryPath:"/onboarding"})` → `paCandidateMagicLinkVerify` →
  `claimCandidateProfile` ensures `pa-users/{uid}` + Sendblue number + lifecycle
  `claimed`.

### 2e. Coresignal enrich (NEW worker, reuses adapter + upsert)
- NEW callable/trigger `paCoresignalEnrichSelfSignup({candidateId})` (or a
  Firestore onWrite trigger when `linkedinOauthLinked` flips true):
  1. Read `pa-users/{uid}` → `{linkedinOauthSub, linkedinOauthName,
     linkedinOauthEmail, linkedinUrl?}`.
  2. **Resolve to a Coresignal record:**
     - If we already have a canonical `linkedinUrl`: search Coresignal
       (`/v2/.../search/filter` ESDSL by `shorthand`/`linkedin_url`, or
       `agentic_search/reasoning`) → numeric id.
     - Else: search by name + email (+ headline if present) → best id (confidence
       gate; ambiguous → no auto-merge, route to HITL review, optionally fall
       back to "ask for résumé").
  3. `fetchEmployeeCollect(id, {apiKey: CORESIGNAL_API_KEY})` → live profile.
  4. Normalize via the EXISTING `coresignal-collect-v2` adapter →
     `ExternalCandidateRecord` (gets `canonicalLinkedInUrl` +
     `linkedinProfileHash`).
  5. `resolveExternalSupplyIdentity(db, record)` — but PIN the resolution to the
     already-claimed `candidateId` (this is a self-signup, the candidate IS the
     uid). Concretely: bind the canonical `linkedin` handle to THIS uid first
     (`linkCandidateHandle(uid, kind:"linkedin", value:canonical,
     source:"candidate", verified:true)`), so the resolver returns
     `merge_existing → candidateId === uid`. If the canonical LinkedIn hash
     ALREADY maps to a DIFFERENT uid → that's a real duplicate-person conflict →
     `needs_review` (do not silently merge; see §3).
  6. `upsertCandidateFromExternalRecord(db,{record, resolution,
     operatorUid:"self_signup", source-marked})` merges enrichment into the same
     `pa-users/{uid}` + dual-writes legacy `tags` + mirrors experiences to
     `parsedCandidateResumes`.
- The whole worker runs ASYNC (like résumé parse). UX is not blocked on it.

### 2f. Pitch (EXISTING thin work — the PART 2 task)
- Once enrichment lands, Claire pitches from `loadGlobalContext`
  (`resumeBits`/`enrichedResumeBits` reads `parsedCandidateResumes[].experiences`
  — which the Coresignal mirror populates). No new pitch seam; this design just
  FEEDS the existing one. Same quality bar (seniority/arc/owned-impact/advocacy).

### 2g. Résumé optional (UX copy only)
- After login, Claire/SPA offers "Want to add a résumé too? (optional — I already
  pulled your LinkedIn)". If LinkedIn enrich succeeded, résumé is never a gate.
  If enrich was ambiguous/empty, Claire asks for résumé as the fallback. Merge of
  LinkedIn + résumé reuses `mergeUserTags`/`applyPartialUserTags` (last-writer
  semantics already in place); **discrepancies are resolved through conversation**
  — Claire asks ("your LinkedIn says X, résumé says Y — which is current?"), the
  answer flows through the existing conversational extractor (no regex).

---

## 3. Identity resolution rules (per v2.0 product lock §"Identity And Profile Ownership")

| Situation | Outcome | Mechanism |
|---|---|---|
| Canonical LinkedIn hash matches THIS uid | merge enrich into uid | `resolveExternalSupplyIdentity` → `merge_existing` |
| Canonical LinkedIn hash novel | bind to uid, enrich | `linkCandidateHandle` then `create_new`-equivalent (pin to uid) |
| Canonical LinkedIn hash maps to a DIFFERENT existing uid | **needs_review** — never auto-merge two persons | `pa-candidate-identity-conflicts` doc → `/admin/external-supply/review` |
| LinkedIn → A but row email → B | **needs_review** (`linkedin_email_candidate_mismatch`) | existing resolver branch |
| No canonical URL resolvable (Coresignal search ambiguous) | no auto-create from search; ask for résumé OR HITL | confidence gate in enrich worker |

Invariants honored:
- **No raw PII as doc id.** uid stays `li_<hash>` (or existing uid on merge);
  handles live under `pa-candidate-handles/<kind>__<sha256>`. Canonical LinkedIn
  URL + hashed index only.
- **LinkedIn is the primary external-source lookup handle** (product rule 12).
- **Email is a secondary signal**, not the join key.
- **Deterministic merge + audit** — every link/conflict writes an identity event
  (existing `recordIdentityConflict` / identity-event audit rows).

---

## 4. Reusable vs net-new

### Reusable (DO NOT rebuild)
- LinkedIn OAuth: `paLinkedinAuthStart`, `paLinkedinCallback`, `buildLinkedinUid`,
  `buildLinkedinState`/`parseLinkedinState`, `isAllowedReturnTo`,
  `ensureFirebaseUser`. (`linkedin-auth.ts`)
- Login SPA + custom-token handoff: `CandidateLogin.tsx`
  (`startProviderSignIn("linkedin")`, `takeLinkedinAuthPayload`,
  `verifyCandidateMagicLinkSession`).
- Claim: `paCandidateMagicLinkVerify`, `claimCandidateProfile`,
  `linkCandidateHandle`, `assignCandidateSenderNumber`.
- Coresignal: `fetchEmployeeCollect`, `coresignal-collect-v2` adapter,
  `agentic_search` CF (or its endpoint), `CORESIGNAL_API_KEY` secret.
- Identity: `resolveExternalSupplyIdentity`, `upsertCandidateFromExternalRecord`,
  `dualWriteLegacyUserTagsFromExternal`, `runCoresignalExperiencesMirror`,
  `pa-candidate-handles` index, `pa-candidate-identity-conflicts`.
- Merge/tag write-through: `mergeUserTags`, `applyPartialUserTags`, the
  conversational extractor (no regex), `loadGlobalContext` (the pitch seam).

### Net-new (small, bounded)
- **N1.** `paLinkedinCallback` login-mode: also write
  `linkedinOauthLinked/Sub/Email/Name` + (when known) canonical
  `linkedinUrl` to `pa-users/{uid}` (today it only does this in `connect` mode).
  ~20 LOC.
- **N2.** Login-mode handle binding: in login mode, when canonical URL is known,
  `linkCandidateHandle(uid, "linkedin", canonical)` so the hash index is
  populated for future dedup. (Coupled to R1/R2 decision.) ~15 LOC.
- **N3.** `paCoresignalEnrichSelfSignup` worker (CF) — the URL→id search + collect
  + adapter + pinned-merge + experiences mirror, runs async. ~150-250 LOC
  (mostly orchestration over existing pieces). Plus a Coresignal **search-by-URL
  / search-by-name** helper if `agentic_search` isn't a clean fit (~60 LOC).
- **N4.** `CandidateLogin.tsx` `?p=li` auto-fire (~10 LOC) + résumé-optional copy.
- **N5.** Thin Claire: a tiny "LinkedIn enrich in progress / done" awareness so
  the pitch waits for enrich like it waits for résumé parse (reuse the
  sequencing work from task #21 — same "fire pitch AFTER enrich" pattern). No
  new seam.

Honest effort: **~2-4 dev-days** of code (the OAuth + claim + adapter + merge are
done), **plus** the Coresignal URL→id resolution reliability work, which is the
real unknown (LinkedIn OIDC does not hand us the vanity URL — see R2).

---

## 5. EXACT credentials / secrets Adam must provision (THE unblock)

| Secret / config | Where | Status | Needed for |
|---|---|---|---|
| `LINKEDIN_CLIENT_ID` | Firebase Secret (`defineSecret`) | EXISTS in code; **confirm a real value is set** (`isConfiguredSecret` rejects empty/"pending") | OAuth login |
| `LINKEDIN_CLIENT_SECRET` | Firebase Secret | same — **confirm set, not "pending"** | OAuth token exchange |
| LinkedIn app **OAuth product**: "Sign In with LinkedIn using OpenID Connect" enabled | LinkedIn Developer portal | **Adam must verify** | `openid profile email` scope |
| LinkedIn app **Authorized redirect URL** = `https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinCallback` | LinkedIn Developer portal | **Adam must add exactly this** | callback must match or LinkedIn 400s |
| `CORESIGNAL_API_KEY` | Firebase Secret | EXISTS (used by batch + agentic-search) — **confirm self-signup CF gets it in its `secrets:[]`** | live `collect/{id}` + search |
| (Decision, not a secret) Coresignal plan supports **search/agentic_search by LinkedIn URL or name** | Coresignal account | **Adam/ops confirm** | URL→id resolution in N3 |

If `LINKEDIN_CLIENT_ID/SECRET` are real (the connect-mode connector implies they
may be) **and** the redirect URL is registered, the login half ships immediately.
The enrich half additionally needs `CORESIGNAL_API_KEY` on the new CF + a confirmed
Coresignal search capability.

**No LinkedIn r_basicprofile / member-snapshot product is required for Option A.**

---

## 6. Flag-gated, canary-first implementation outline

Per `canary_gate_dev_only_new_behavior`: new product behavior ships DEPLOYED but
dev-phone/dev-uid only via `isCanaryUser`; safety/opt-out + pure bug-fixes are
universal.

- **Phase 0 — confirm secrets (Adam):** real `LINKEDIN_CLIENT_ID/SECRET`,
  redirect URL registered, `CORESIGNAL_API_KEY` present, Coresignal search
  capability confirmed. (Blocking; nothing below runs without it.)
- **Phase 1 — login parity (mostly free):** verify existing LinkedIn login E2E on
  `candidate.wekruit.com/login`; add N1 (login-mode user-doc writes) + N4
  (`?p=li` auto-fire) behind a SPA flag/param so prod button is unchanged.
- **Phase 2 — enrich worker (canary):** `paCoresignalEnrichSelfSignup` (N2/N3),
  gated `if (!isCanaryUser(candidateId)) return` — so only Adam's dev uid
  enriches at first. Deterministic merge + conflict review. Async.
- **Phase 3 — pitch sequencing (canary):** thin Claire waits for enrich like it
  waits for résumé parse (N5); pitch fires AFTER enrich; find_match never before
  enriched data exists. Reuse task #21 sequencing.
- **Phase 4 — résumé-optional copy + discrepancy-through-conversation:** copy +
  the existing extractor; LinkedIn↔résumé conflicts asked, not auto-resolved.
- **Phase 5 — ramp (Adam-gated):** widen `CANARY_UIDS` → cohort → all, watching
  conflict rate + enrich success rate + duplicate-person rate.

Verify-by-doing per phase: real OAuth round trip on a dev phone, real Coresignal
collect on a known dev LinkedIn URL, assert the enrichment landed on the SAME uid
(no second profile), assert pitch reads the enriched experiences.

---

## 7. Where it must NOT go (guardrails)

- **NEVER the admin domain.** All candidate surfaces stay on
  `candidate.wekruit.com` / `wekruit.com` / `pa.wekruit.com`. `isAllowedReturnTo`
  enforces server-side; do not add admin origins.
- **No raw PII as a Firestore doc id.** uid = `li_<hash>` or existing uid; handles
  hashed under `pa-candidate-handles`; canonical LinkedIn URL stored as a field +
  hashed index, never a doc id.
- **No silent two-person merge.** Conflicting LinkedIn/email→uid mappings →
  `needs_review` + conflict doc, never auto-merge.
- **No regex text→enum tagging** anywhere in the merge/discrepancy path (Adam
  absolute rule) — discrepancies resolved by the conversational LLM extractor +
  reducer.
- **find_match never before enriched data exists** (same invariant as the résumé
  flow).
- **Do not chase a fictional second context seam.** The pitch reads
  `loadGlobalContext` only.
- **Do not rebuild** OAuth, Coresignal adapter, identity resolver, or the handle
  index. Extend.

---

## 8. Open decisions for Adam (need answers before build)

- **D-A.** Option A (sub-handle + async Coresignal URL resolution, lowest
  friction, recommended) vs Option B (request LinkedIn vanity-URL product). I
  recommend A.
- **D-B.** Coresignal search method for URL→id: `agentic_search/reasoning`
  (already wired) vs standard `search/filter` ESDSL by `shorthand`. Which does
  the current Coresignal plan support cheaply at per-login volume?
- **D-C.** When Coresignal search is ambiguous (no confident id): ask for résumé
  silently, or route to HITL, or both? (Default proposal: ask for résumé,
  no HITL noise.)
- **D-D.** Per-login Coresignal `collect` cost is real money. Cap / cache /
  cooldown policy (e.g. only enrich once per uid; re-enrich on explicit request)?

---

## 9. Residual risks (honest)

- **R1 — handle-key mismatch (the load-bearing one).** Today `paLinkedinCallback`
  (connect mode) and `connectLinkedinToCandidate` bind the LinkedIn handle as an
  `oauth-linked/<sub>` MARKER, NOT the canonical `/in/<slug>` URL. The Coresignal
  path binds the **canonical URL** hash. These two DO NOT collide, so a LinkedIn
  login and a prior Coresignal-sourced row for the same person would NOT
  auto-merge. The fix: in the enrich worker, once Coresignal yields the canonical
  URL, bind the canonical `linkedin` handle to the uid — that's what makes
  `resolveExternalSupplyIdentity` return `merge_existing`. Until that binding
  runs, the `sub` handle is just an internal session key. Verify the
  `normalizeCandidateHandleValue("linkedin", …)` output equals
  `canonicalizeLinkedInUrl(...)` so OAuth-bound and Coresignal-bound hashes match;
  if they differ, align them (one canonicalizer) — otherwise the index splits.
- **R2 — LinkedIn OIDC gives no public URL.** `/v2/userinfo` returns
  `sub/email/name/picture`, not `/in/<slug>`. So the canonical URL must come from
  Coresignal search (Option A) or a higher LinkedIn product (Option B). This is
  why enrichment is async + search-dependent, not a synchronous read.
- **R3 — Coresignal search precision.** Name+email search can mis-resolve common
  names → wrong-person enrichment. Hence the confidence gate + no-auto-merge on
  ambiguity + HITL/résumé fallback.
- **R4 — Coresignal cost** at per-login scale (see D-D).
- **R5 — duplicate Firebase identities.** A user who earlier signed up via
  email-magic-link (different uid) then logs in via LinkedIn (`li_<hash>` uid) =
  two Firebase uids for one person. The handle index + conflict review catch the
  person-level dup, but the two Firebase sessions need a documented account-merge
  story (out of scope here; flag for the identity backlog).
