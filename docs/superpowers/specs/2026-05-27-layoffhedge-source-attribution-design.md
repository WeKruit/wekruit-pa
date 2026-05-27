# layoffhedge Source Attribution — Design Spec

**Status:** draft, design approved by Adam (2026-05-27)
**Author:** Claude
**Scope:** capture `?source=layoffhedge` (and equivalent referral partners added via the same mechanism) as a first-class `pa-users.source` value, end-to-end through the candidate.wekruit.com / wekruit.com / pa.wekruit.com surface.

## 1. Problem

Today an external referral partner (layoffhedge.com) sends candidates to:

```
https://candidate.wekruit.com/j/<jobId>?source=layoffhedge
```

The client-side resolver `apps/pa-landing/src/lib/source.ts` only recognizes
`?source=layoff` and `?source=candidate`. Anything else falls through to the
default `"candidate"` bucket. As a result:

- the `?source=layoffhedge` hint is silently dropped on first paint
- the `wko_source` cookie is written as `candidate`
- the first-time signup that follows (Google OAuth, magic link, or CV upload)
  stamps `pa-users.source = "candidate"`
- there is no way to know, after the fact, that the user came from
  layoffhedge — partner attribution is lost

Equivalent landings on `wekruit.com` (apex) and `pa.wekruit.com` behave the
same way because they share the same SPA bundle.

The `layoff.wekruit.com` precedent already proves the rest of the plumbing
works: when `?source=layoff` is honored, the cookie sticks across the OAuth
redirect, the backend `sourceForProfileCreate` maps it to the enum value
`WeKruit_Laid_Off`, and `pa-users.source` is written correctly.

## 2. Goal

Stamp `pa-users.source = "layoffhedge"` on every **first-time** signup that
originated from a `?source=layoffhedge` referral, on every public-facing
WeKruit surface (`candidate.wekruit.com`, `wekruit.com`, `pa.wekruit.com`),
regardless of whether the user converts via:

- public job page `/j/:jobId` → resume upload (`paPublicCvIngest`)
- Google OAuth sign-in → claim
- magic-link sign-in → `paCandidateMagicLinkVerify`
- root landing → `/onboarding` first-paint registration

Returning users keep their first-stamped source. Existing pre-ship hits that
were silently bucketed as `candidate` are NOT backfilled (data already lost).

## 3. Non-Goals

- No new visual flow for layoffhedge. Standard candidate.wekruit.com UX.
- No new hostname (`layoffhedge.wekruit.com` is not created).
- No utm_medium / utm_campaign / utm_content capture in this ship.
- No retroactive backfill of pre-ship `?source=layoffhedge` rows.
- No generic open-allowlist mechanism for arbitrary partners. Each new
  partner requires a code change + deploy (closed enum, Adam decision
  2026-05-27).
- No cross-host redirect from `layoffhedge.com` (partner runs their own site).

## 4. Architecture

Six layers, each touching one file or one tight cluster. Layers 4.1–4.6 are
the primary path. Layer 4.7 is a defensive correction to a latent coercion
bug uncovered during spec review.

### 4.1 Vocab layer — `packages/core-types/src/sources.ts`

Add `"layoffhedge"` to `PA_USER_SOURCES`:

```ts
export const PA_USER_SOURCES = [
  "candidate",
  "WeKruit_Laid_Off",
  "layoffhedge",        // NEW — external referral partner (layoffhedge.com)
  "admin",
  "dev_test",
  "e2e_run",
  "qa_run",
  "external_supply",
] as const
```

The doc comment above the array gets a new bullet describing layoffhedge as
the first external referral-partner attribution. Future partners follow the
same enum-extension pattern.

`PaUserSourceSchema` (zod) auto-picks up the new literal because it's derived
from the same const tuple. `isPaUserSource()` auto-picks up the same.

### 4.2 Client resolver — `apps/pa-landing/src/lib/source.ts`

Extend the `SignupSource` union and the recognition list:

```ts
export type SignupSource = "WeKruit_Laid_Off" | "candidate" | "layoffhedge"
```

Update `urlSource()`:

```ts
function urlSource(): SignupSource | null {
  if (typeof window === "undefined") return null
  const v = new URLSearchParams(window.location.search).get("source")
  if (!v) return null
  if (v === "layoff" || v === "WeKruit_Laid_Off") return "WeKruit_Laid_Off"
  if (v === "candidate") return "candidate"
  if (v === "layoffhedge") return "layoffhedge"   // NEW
  return null
}
```

Update `cookieSource()` validation: include `"layoffhedge"` in the allowed
set so a previously-written cookie is honored on next paint.

Update `stickSourceFromLoginNext()`: if the login `next` carries
`?source=layoffhedge` (the OAuth roundtrip path), stick the cookie before
Firebase strips the URL.

Cookie domain is already `.wekruit.com` via `cookieDomainForHost`, so it
covers all three c-end hosts plus the apex with no additional change.

### 4.3 Public job upload — `apps/pa-landing/src/pages/PublicJob.tsx`

Today line 902 hard-codes `source: "public_job_page"` in the CV-ingest POST
body. That string is not a `PaUserSource` and is ignored by the backend's
`sourceForProfileCreate` mapper, so every public-job-page signup currently
defaults to `candidate`.

Change: replace the hard-coded literal with `peekSource()` from
`../lib/source.js`. The cookie has already been written by the
`resolveSource()` call on first paint elsewhere in the SPA (Onboarding.tsx)
or on first visit to a routed page that imports source.ts.

Add an explicit `resolveSource()` call at the top of `PublicJob` mount
(once) to guarantee the cookie is written even when the user lands directly
on `/j/:jobId` without ever hitting Onboarding.

### 4.4 Backend CV ingest — `apps/functions/src/public-cv-ingest.ts`

Today `sourceForProfileCreate(uploadSource?)` only branches on
`"layoff_signup"`:

```ts
function sourceForProfileCreate(uploadSource?: string): PaUserSource {
  return uploadSource === "layoff_signup" ? "WeKruit_Laid_Off" : "candidate"
}
```

Replace with an explicit, exhaustive mapper that validates against
`isPaUserSource` so the frontend cannot push arbitrary strings:

```ts
function sourceForProfileCreate(uploadSource?: string): PaUserSource {
  if (uploadSource === "layoff_signup") return "WeKruit_Laid_Off"
  if (uploadSource === "layoffhedge") return "layoffhedge"
  if (isPaUserSource(uploadSource)) return uploadSource
  return "candidate"
}
```

`existingUserSource` guard at the original line 213 is unchanged: it already
prevents source overwrites on returning users.

### 4.5 Magic-link verify — `apps/functions/src/candidate-magic-link-verify.ts`

No code change required. Line 165 already validates the incoming source via
`isPaUserSource`. Once the enum has `"layoffhedge"`, this path accepts the
new value automatically and writes it into `pa-users.source` via the merge
at the end of the verify handler.

The frontend `candidate-verify.ts:69` already passes
`options?.source ?? resolveSource()` to this endpoint, so the cookie-resolved
value flows through with no change.

### 4.6 Onboarding destination — `apps/pa-landing/src/lib/browser-identity.ts`

`onboardingDestination(source)` currently returns
`"/onboarding?source=layoff"` for `WeKruit_Laid_Off` and `"/onboarding"` for
everything else. Extend the explicit allowlist so `"layoffhedge"` returns
`"/onboarding"` (standard candidate UX), not the layoff path.

This is the only place the destination forks; no further plumbing change is
needed for the standard-UX decision.

### 4.7 Defensive fix — `packages/pa-orchestrator/src/shared-onboarding.ts:782`

`normalizedSource` and its exported wrapper `sharedOnboardingSignupSource`
currently coerce any non-`candidate` value to `WeKruit_Laid_Off`:

```ts
function normalizedSource(value: unknown): WekruitSignupSource {
  return value === WEKRUIT_CANDIDATE_SOURCE ? WEKRUIT_CANDIDATE_SOURCE : WEKRUIT_LAYOFF_SOURCE
}
```

No live caller exists today, but the export is reachable. If any future
runtime path feeds the raw `pa-users.source` field through this helper,
`"layoffhedge"` would silently coerce to `WeKruit_Laid_Off` and route the
user into the layoff onboarding flow — the exact UX outcome the design
just ruled out.

Flip the default so only the explicit literal `WeKruit_Laid_Off` opts into
the layoff flow; everything else defaults to `candidate`:

```ts
function normalizedSource(value: unknown): WekruitSignupSource {
  return value === WEKRUIT_LAYOFF_SOURCE ? WEKRUIT_LAYOFF_SOURCE : WEKRUIT_CANDIDATE_SOURCE
}
```

Behavior for the two live values is unchanged. The defensive change covers
`layoffhedge` and every future `PaUserSource` value that is not explicitly
the layoff bucket. Existing unit tests in `__tests__/onboarding-intent-ack.test.ts`
that pass `WEKRUIT_LAYOFF_SOURCE` / `WEKRUIT_CANDIDATE_SOURCE` explicitly are
unaffected; a new assertion `normalizedSource("layoffhedge") === "candidate"`
locks the new contract.

## 5. Data Flow

```
1. User clicks layoffhedge link → lands on
     https://candidate.wekruit.com/j/<jobId>?source=layoffhedge

2. PublicJob mount fires resolveSource():
     - urlSource() returns "layoffhedge"
     - writeCookie writes wko_source=layoffhedge; Domain=.wekruit.com; Max-Age=180d
     - window.__wkoSourceResolver = "resolveSource:layoffhedge" (deploy marker)

3. User clicks "Apply" / "Upload resume" on PublicJob:
     - Sign-in gate triggers (Google OAuth or magic link)
       - OAuth: stickSourceFromLoginNext preserves cookie across redirect
       - Magic link: candidate-verify POST includes source=layoffhedge (from peekSource())
     - CV upload POST to paPublicCvIngest with body.source = "layoffhedge"

4. paPublicCvIngest:
     - existingUserSource guard checks current pa-users.source
     - if absent → sourceForProfileCreate("layoffhedge") returns "layoffhedge"
     - userPatch writes pa-users/{uid}.source = "layoffhedge"

5. Returning visit (same uid):
     - resolveSource overwrites cookie to whatever new param is present
     - BUT pa-users.source stays at the first-write value because of the
       existingUserSource guard
```

Same path on wekruit.com root: `Onboarding.tsx` calls `resolveSource()` at
first paint; first signup writes `pa-users.source = "layoffhedge"`.

## 6. Compatibility & Migration

- Pre-ship `?source=layoffhedge` hits → already lost. No backfill.
- Existing `WeKruit_Laid_Off`, `candidate`, `admin`, etc. rows → untouched.
- Existing `wko_source` cookies with `WeKruit_Laid_Off` or `candidate`
  values continue to be recognized by `cookieSource()`.
- Deploy is additive. Backend, frontend, types ship together via the
  standard predeploy gate so the enum value lands everywhere atomically.

## 7. Risk & Mitigation

| Risk | Mitigation |
|---|---|
| Frontend minifier strips `urlSource` literal | Existing `SOURCE_RESOLVER_MARKER` + `__wkoSourceResolver` marker already covers identifier renames. Acceptance grep extended to look for both `"resolveSource:candidate"` and `"resolveSource:layoffhedge"` strings in the built bundle. |
| Frontend ships before backend (or vice versa) | Same monorepo deploy; `firebase.json` predeploy gate builds core-types first. Backend `isPaUserSource` would treat new value as invalid only if backend lags — falls back to `candidate` (current behavior), not crash. |
| Partner attribution pollution by mischievous URLs | Frontend writes whatever is in the URL; backend re-validates against `isPaUserSource`. Adding a malicious `?source=admin` cannot land — it requires `existingUserSource` to be unset AND the backend mapper to accept. The closed enum + sourceForProfileCreate mapper prevents privilege escalation. |
| Returning user from different partner overwrites attribution | The `existingUserSource` guard at `public-cv-ingest.ts:213` already drops the new source if a value is present. Verified path in 4.4. |
| `pa.wekruit.com` and `wekruit.com` apex not covered | Same SPA bundle, same cookie domain `.wekruit.com`. No additional plumbing required; covered by Onboarding.tsx `resolveSource()` first-paint. |

## 8. Test Plan

### 8.1 Unit / vitest

File-existence status verified 2026-05-27. New files explicitly marked.

- `packages/core-types/src/sources.test.ts` (**new file**):
  - `PaUserSourceSchema.parse("layoffhedge")` succeeds.
  - `isPaUserSource("layoffhedge")` returns true.
  - `PA_USER_SOURCES` length increments by exactly 1 vs. pre-ship snapshot.
- `apps/pa-landing/src/lib/source.test.ts` (**new file**):
  - `urlSource()` returns `"layoffhedge"` when `?source=layoffhedge` set.
  - Cookie round-trip: write `layoffhedge` → `cookieSource()` returns it.
  - `stickSourceFromLoginNext("/onboarding?source=layoffhedge")` writes cookie.
  - `resolveSource()` priority preserved: URL > host > cookie > default.
- `apps/pa-landing/src/lib/browser-identity.test.ts` (**existing — extend**):
  - `onboardingDestination("layoffhedge")` returns `"/onboarding"`.
- `apps/functions/src/__tests__/public-cv-ingest.test.ts` (**new file**):
  - `sourceForProfileCreate("layoffhedge")` returns `"layoffhedge"`.
  - `sourceForProfileCreate("layoff_signup")` still returns `"WeKruit_Laid_Off"`.
  - `sourceForProfileCreate("nonsense")` returns `"candidate"` (fallthrough).
  - `sourceForProfileCreate(undefined)` returns `"candidate"`.
- `apps/functions/src/__tests__/candidate-magic-link-verify.test.ts` (**existing — extend**):
  - Verify endpoint accepts `source: "layoffhedge"` and writes it on first
    create, leaves alone on returning user.
- `packages/pa-orchestrator/src/__tests__/shared-onboarding.test.ts` (**existing — extend**):
  - `sharedOnboardingSignupSource("layoffhedge")` returns `"candidate"`.
  - `sharedOnboardingSignupSource("WeKruit_Laid_Off")` returns `"WeKruit_Laid_Off"` (regression lock).
  - `sharedOnboardingSignupSource("candidate")` returns `"candidate"` (regression lock).
  - `sharedOnboardingSignupSource(undefined)` returns `"candidate"` (post-fix default).

### 8.2 Scenario / integration

- Predeploy smoke (`apps/functions/scripts/predeploy-smoke.mjs`):
  - Greps the built `apps/pa-landing/dist/assets/index-*.js` for the
    literal `"layoffhedge"` so the minifier can't drop it.
- Live scenario verify after deploy:
  - Open incognito → `https://candidate.wekruit.com/j/<test-jobId>?source=layoffhedge`
  - DevTools: confirm cookie `wko_source=layoffhedge` written, Domain=`.wekruit.com`.
  - Open `https://wekruit.com/?source=layoffhedge` → cookie writes again.
  - Sign in via magic link (test inbox) → confirm `pa-users/{uid}.source = "layoffhedge"`
    in Firestore.
  - Upload resume on `/j/<jobId>` → reconfirm `pa-users/{uid}.source` unchanged
    (still `"layoffhedge"`, not overwritten back to `candidate`).
  - Re-visit same `/j/<jobId>?source=anotherpartner` (or no source) →
    Firestore `source` stays `"layoffhedge"` (existingUserSource guard).

### 8.3 Regression

- Existing layoff funnel (`layoff.wekruit.com` and `?source=layoff`):
  - Cookie + `pa-users.source = "WeKruit_Laid_Off"` unchanged.
- Existing candidate funnel:
  - Default `pa-users.source = "candidate"` unchanged.

## 9. Rollout

1. Land all six file changes in one PR (atomic ship).
2. Predeploy gate green (orchestrator unit suite, functions unit suite,
   pa-landing build, minifier-bundle grep for `"layoffhedge"`).
3. Deploy via `firebase deploy` (functions + pa-landing hosting in the
   standard order from `CLAUDE.md`).
4. Run section 8.2 live scenario in incognito.
5. Notify Adam with the Firestore screenshot proving `pa-users.source = "layoffhedge"`.
6. Inform layoffhedge partner the parameter is live (out of band).

## 10. Open Questions

None at design-time. All four interactive decisions resolved:

1. **Closed enum vs generic mechanism** → closed enum (Adam 2026-05-27).
2. **Visual flow for layoffhedge** → standard candidate UX (Adam 2026-05-27).
3. **Backfill of pre-ship hits** → none, future-only (Adam 2026-05-27 implicit).
4. **Returning-user attribution** → first-write sticky via `existingUserSource` guard (existing behavior, kept).
