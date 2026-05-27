# layoffhedge Source Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture `?source=layoffhedge` from any candidate-facing WeKruit surface and stamp `pa-users.source = "layoffhedge"` on first-time signup, end-to-end through CV upload, Google OAuth, and magic-link verify paths.

**Architecture:** Six layered file changes wired through the existing source-resolution stack (`source.ts` cookie + URL → `peekSource()` → CV ingest body / magic-link verify body → backend `sourceForProfileCreate` → `pa-users.source`). Closed enum extension; new value `"layoffhedge"` added to `PA_USER_SOURCES`. Standard candidate UX — only attribution differs. One defensive correction to a latent coercion in `shared-onboarding.ts` so future callers cannot silently route `layoffhedge` into the layoff flow.

**Tech Stack:** TypeScript, node:test (via `tsx`), Firebase Functions v2 callable handlers, React 19 (Vite SPA), zod, Firestore.

**Spec:** [`docs/superpowers/specs/2026-05-27-layoffhedge-source-attribution-design.md`](../specs/2026-05-27-layoffhedge-source-attribution-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/core-types/src/sources.ts` | **modify** | Add `"layoffhedge"` literal to `PA_USER_SOURCES` tuple; doc comment. |
| `packages/core-types/src/sources.test.ts` | **create** | Schema + isPaUserSource + enum-length regression locks. |
| `packages/core-types/package.json` | **modify** | Append `src/sources.test.ts` to `test` script. |
| `apps/pa-landing/src/lib/source.ts` | **modify** | Extend `SignupSource` union; `urlSource()` + `cookieSource()` + `stickSourceFromLoginNext()` recognize `"layoffhedge"`. |
| `apps/pa-landing/src/lib/source.test.ts` | **create** | URL → cookie round-trip + sticky + resolveSource priority for `layoffhedge`. |
| `apps/pa-landing/src/lib/browser-identity.ts` | **modify** | `onboardingDestination("layoffhedge")` → `"/onboarding"` (standard candidate). |
| `apps/pa-landing/src/lib/browser-identity.test.ts` | **modify** | Extend with `layoffhedge` destination assertion. |
| `apps/pa-landing/src/pages/PublicJob.tsx` | **modify** | Replace hard-coded `source: "public_job_page"` (line ~902) with `peekSource()`; add one `resolveSource()` call on mount. |
| `apps/functions/src/public-cv-ingest.ts` | **modify** | Extend `sourceForProfileCreate()` mapper to honor `"layoffhedge"` and any `isPaUserSource` value. |
| `apps/functions/src/__tests__/public-cv-ingest.test.ts` | **create** | Unit-test the mapper. |
| `apps/functions/src/candidate-magic-link-verify.ts` | **modify** | Add first-write-sticky guard around `mergeFields.source` (spec-correction discovered during plan-writing — see Task 7 note). |
| `apps/functions/src/__tests__/candidate-magic-link-verify.test.ts` | **modify** | Add coverage: `source: "layoffhedge"` stamps on create, existing source blocks overwrite. |
| `packages/pa-orchestrator/src/shared-onboarding.ts` | **modify** | Flip `normalizedSource` default: only explicit `WeKruit_Laid_Off` opts into layoff; everything else → `candidate`. |
| `packages/pa-orchestrator/src/__tests__/shared-onboarding.test.ts` | **modify** | Add 4 regression assertions for `sharedOnboardingSignupSource`. |

No new package boundaries. No new dependencies.

---

## Task 1: Read baseline + lock starting state

**Files:**
- Read-only: spec, all files listed in File Structure table.

- [ ] **Step 1: Read the design spec end-to-end**

Read [`docs/superpowers/specs/2026-05-27-layoffhedge-source-attribution-design.md`](../specs/2026-05-27-layoffhedge-source-attribution-design.md) cover-to-cover. Internalize the six layers and the defensive `normalizedSource` correction.

- [ ] **Step 2: Verify the working tree is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean` (or only this plan/spec already committed).

- [ ] **Step 3: Snapshot baseline test suites — they must be green before starting**

Run from repo root:
```bash
pnpm --filter @pa/core-types test
pnpm --filter pa-orchestrator test
pnpm --filter @pa/functions test
```
Expected: all suites pass. If any fail, STOP and surface the failure — do not start the plan on a red baseline.

- [ ] **Step 4: Snapshot the current PA_USER_SOURCES length**

Run: `grep -c '"' packages/core-types/src/sources.ts | head -1`
This is informational. The arr currently has 7 string literals; after Task 2 it will be 8.

No commit in this task.

---

## Task 2: Extend `PA_USER_SOURCES` enum with `"layoffhedge"`

**Files:**
- Create: `packages/core-types/src/sources.test.ts`
- Modify: `packages/core-types/src/sources.ts`
- Modify: `packages/core-types/package.json`

- [ ] **Step 1: Create the failing test file**

Write `packages/core-types/src/sources.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import { PA_USER_SOURCES, PaUserSourceSchema, isPaUserSource } from "./sources.js"

test("PA_USER_SOURCES contains the closed referral-partner enum", () => {
  assert.equal(PA_USER_SOURCES.length, 8, "expected 8 sources including layoffhedge")
  assert.ok(PA_USER_SOURCES.includes("layoffhedge"))
})

test("PaUserSourceSchema accepts layoffhedge", () => {
  assert.equal(PaUserSourceSchema.parse("layoffhedge"), "layoffhedge")
})

test("PaUserSourceSchema rejects unknown values", () => {
  assert.throws(() => PaUserSourceSchema.parse("layoffheaven"))
})

test("isPaUserSource recognizes every literal in the tuple", () => {
  for (const v of PA_USER_SOURCES) {
    assert.equal(isPaUserSource(v), true, `expected ${v} to be a PaUserSource`)
  }
  assert.equal(isPaUserSource("layoffhedge"), true)
  assert.equal(isPaUserSource(""), false)
  assert.equal(isPaUserSource(undefined), false)
})
```

- [ ] **Step 2: Wire the new test file into the workspace `test` script**

Edit `packages/core-types/package.json`. Find the `"test"` script and append `src/sources.test.ts` to the file list. After edit, the script should read (note the new last entry):

```json
"test": "node --import tsx --test src/marketplace.test.ts src/scheduled-jobs.test.ts src/external-supply.test.ts src/evaluation.test.ts src/candidate-profile-classifier.test.ts src/sources.test.ts"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @pa/core-types test`
Expected: the 4 new tests fail. The first failure should be `expected 8 sources including layoffhedge` because the enum still has 7 entries.

- [ ] **Step 4: Add `"layoffhedge"` to the enum**

Edit `packages/core-types/src/sources.ts`. Replace the `PA_USER_SOURCES` tuple and update the docstring:

```ts
/**
 * Canonical `source` label vocab for `pa-users/{uid}` writes.
 *
 * Values:
 *   - `candidate`         pa-landing public flow (web → SMS bridge, ats inbound)
 *   - `WeKruit_Laid_Off`  layoff.wekruit.com registration (openRegisterLayoffCandidate)
 *   - `layoffhedge`       external referral partner (layoffhedge.com); standard candidate UX
 *   - `admin`             real WeKruit operator account created via dashboard
 *   - `dev_test`          local/manual dev script (one-off probes, seed-*)
 *   - `e2e_run`           e2e simulation scripts (e2e-*.mjs)
 *   - `qa_run`            admin-bootstrap SYNTHETIC_* personas + weekly QA evaluator
 *   - `external_supply`   Juicebox / Lessie / Coresignal LinkedIn intake
 */
import { z } from "zod"

export const PA_USER_SOURCES = [
  "candidate",
  "WeKruit_Laid_Off",
  "layoffhedge",
  "admin",
  "dev_test",
  "e2e_run",
  "qa_run",
  "external_supply",
] as const

export type PaUserSource = (typeof PA_USER_SOURCES)[number]

export const PaUserSourceSchema = z.enum(PA_USER_SOURCES)

export function isPaUserSource(value: unknown): value is PaUserSource {
  return typeof value === "string" && (PA_USER_SOURCES as readonly string[]).includes(value)
}
```

(Keep the existing read-side filtering comment about `WekruitSignupSource` — only the bullet list above changes.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @pa/core-types test`
Expected: all tests in `sources.test.ts` pass; rest of suite still green.

- [ ] **Step 6: Commit**

```bash
git add packages/core-types/src/sources.ts packages/core-types/src/sources.test.ts packages/core-types/package.json
git commit -m "$(cat <<'EOF'
feat(core-types): add layoffhedge to PA_USER_SOURCES enum

External referral-partner attribution. New value carries standard candidate
UX semantics; only pa-users.source attribution differs (per spec §4.1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Recognize `?source=layoffhedge` in the client resolver

**Files:**
- Create: `apps/pa-landing/src/lib/source.test.ts`
- Modify: `apps/pa-landing/src/lib/source.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/pa-landing/src/lib/source.test.ts`:

```ts
// @ts-nocheck - landing app tests run with node --test via tsx; no Vite DOM types here.
import assert from "node:assert/strict"
import test from "node:test"

// Provide minimal DOM globals so source.ts believes it is in a browser.
function withBrowser(href: string, cookie: string, fn: () => void): void {
  const prevWindow = (globalThis as any).window
  const prevDocument = (globalThis as any).document
  const url = new URL(href)
  ;(globalThis as any).window = {
    location: { search: url.search, hostname: url.hostname, protocol: url.protocol },
  }
  ;(globalThis as any).document = { cookie }
  try {
    fn()
  } finally {
    if (prevWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = prevWindow
    if (prevDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = prevDocument
  }
}

test("resolveSource returns layoffhedge for ?source=layoffhedge", async () => {
  const mod = await import("./source.js?case=urlLayoffhedge")
  withBrowser("https://candidate.wekruit.com/j/abc?source=layoffhedge", "", () => {
    assert.equal(mod.resolveSource(), "layoffhedge")
  })
})

test("resolveSource honors a previously-written layoffhedge cookie", async () => {
  const mod = await import("./source.js?case=cookieLayoffhedge")
  withBrowser(
    "https://candidate.wekruit.com/me",
    "wko_source=layoffhedge; other=x",
    () => {
      assert.equal(mod.resolveSource(), "layoffhedge")
    },
  )
})

test("resolveSource priority: URL beats cookie", async () => {
  const mod = await import("./source.js?case=priorityUrlOverCookie")
  withBrowser(
    "https://candidate.wekruit.com/j/abc?source=layoffhedge",
    "wko_source=candidate",
    () => {
      assert.equal(mod.resolveSource(), "layoffhedge")
    },
  )
})

test("resolveSource defaults to candidate when no signal present", async () => {
  const mod = await import("./source.js?case=defaultCandidate")
  withBrowser("https://candidate.wekruit.com/", "", () => {
    assert.equal(mod.resolveSource(), "candidate")
  })
})

test("stickSourceFromLoginNext writes layoffhedge cookie when next carries it", async () => {
  const mod = await import("./source.js?case=stickyNext")
  let cookieWritten = ""
  withBrowser("https://candidate.wekruit.com/login", "", () => {
    Object.defineProperty((globalThis as any).document, "cookie", {
      configurable: true,
      get: () => cookieWritten,
      set: (v: string) => {
        cookieWritten = v
      },
    })
    mod.stickSourceFromLoginNext("/onboarding?source=layoffhedge")
    assert.match(cookieWritten, /^wko_source=layoffhedge;/)
  })
})

test("peekSource returns layoffhedge from cookie without writing back", async () => {
  const mod = await import("./source.js?case=peekLayoffhedge")
  withBrowser("https://candidate.wekruit.com/me", "wko_source=layoffhedge", () => {
    assert.equal(mod.peekSource(), "layoffhedge")
  })
})
```

(The `?case=...` query suffix is a cache-buster so each `await import()` gets a fresh module evaluation under node's import cache. Tests don't share global state across cases.)

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/pa-landing/`:
```bash
node --import tsx --test src/lib/source.test.ts
```
Expected: 5 failures. The default-candidate test should already pass.

- [ ] **Step 3: Extend `SignupSource` and recognition logic**

Edit `apps/pa-landing/src/lib/source.ts`:

```ts
export type SignupSource = "WeKruit_Laid_Off" | "candidate" | "layoffhedge"
```

Replace `urlSource()`:

```ts
function urlSource(): SignupSource | null {
  if (typeof window === "undefined") return null
  const v = new URLSearchParams(window.location.search).get("source")
  if (!v) return null
  if (v === "layoff" || v === "WeKruit_Laid_Off") return "WeKruit_Laid_Off"
  if (v === "candidate") return "candidate"
  if (v === "layoffhedge") return "layoffhedge"
  return null
}
```

Replace `cookieSource()`:

```ts
function cookieSource(): SignupSource | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp("(?:^|; )" + COOKIE_NAME + "=([^;]+)"))
  if (!match) return null
  const v = decodeURIComponent(match[1])
  if (v === "WeKruit_Laid_Off" || v === "candidate" || v === "layoffhedge") return v
  return null
}
```

Replace `stickSourceFromLoginNext()`:

```ts
export function stickSourceFromLoginNext(raw: string | null | undefined): void {
  if (!raw) return
  const q = raw.indexOf("?")
  const pathname = q >= 0 ? raw.slice(0, q) : raw
  if (/^\/j\/[^/]+(?:\/cv)?$/.test(pathname)) {
    writeCookie("candidate")
    return
  }
  if (pathname !== "/onboarding") return
  const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "")
  const fromQuery = params.get("source")
  if (fromQuery === "layoff" || fromQuery === "WeKruit_Laid_Off") {
    writeCookie("WeKruit_Laid_Off")
  } else if (fromQuery === "layoffhedge") {
    writeCookie("layoffhedge")
  } else if (fromQuery === "candidate") {
    writeCookie("candidate")
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `apps/pa-landing/`:
```bash
node --import tsx --test src/lib/source.test.ts
```
Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Run the surrounding existing tests to verify no regression**

Run from `apps/pa-landing/`:
```bash
node --import tsx --test src/lib/browser-identity.test.ts src/lib/source.test.ts
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/pa-landing/src/lib/source.ts apps/pa-landing/src/lib/source.test.ts
git commit -m "$(cat <<'EOF'
feat(pa-landing): recognize ?source=layoffhedge in client resolver

Extends SignupSource union, urlSource(), cookieSource(), and
stickSourceFromLoginNext() to honor the new referral-partner value.
Default + layoff + candidate paths unchanged (regression-locked).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `onboardingDestination("layoffhedge")` → standard candidate flow

**Files:**
- Modify: `apps/pa-landing/src/lib/browser-identity.ts:293`
- Modify: `apps/pa-landing/src/lib/browser-identity.test.ts`

- [ ] **Step 1: Add the failing assertion to the existing test**

Edit `apps/pa-landing/src/lib/browser-identity.test.ts`. Find the existing test at the bottom:

```ts
test("onboardingDestination routes layoff source to layoff query", () => {
  assert.equal(onboardingDestination("WeKruit_Laid_Off"), "/onboarding?source=layoff")
})
```

Add immediately after it:

```ts
test("onboardingDestination routes layoffhedge to the standard candidate path", () => {
  assert.equal(onboardingDestination("layoffhedge"), "/onboarding")
})

test("onboardingDestination routes candidate to the standard path", () => {
  assert.equal(onboardingDestination("candidate"), "/onboarding")
})
```

- [ ] **Step 2: Run the test to verify the new layoffhedge assertion fails**

Run from `apps/pa-landing/`:
```bash
node --import tsx --test src/lib/browser-identity.test.ts
```
Expected: the new `layoffhedge` test FAILS (because the current `===` check returns `"/onboarding"` for any non-layoff value but TypeScript will refuse to compile the literal `"layoffhedge"` until `SignupSource` is extended — which Task 3 already did). If Task 3 didn't land first, the test won't even compile — that's the correct ordering signal.

- [ ] **Step 3: Update `onboardingDestination` to use an explicit allowlist**

Edit `apps/pa-landing/src/lib/browser-identity.ts:293`. Replace:

```ts
export function onboardingDestination(source: SignupSource = peekSource()): string {
  return source === "WeKruit_Laid_Off" ? "/onboarding?source=layoff" : "/onboarding"
}
```

With (explicit switch makes the intent visible and lint-friendly for future additions):

```ts
export function onboardingDestination(source: SignupSource = peekSource()): string {
  switch (source) {
    case "WeKruit_Laid_Off":
      return "/onboarding?source=layoff"
    case "candidate":
    case "layoffhedge":
      return "/onboarding"
  }
}
```

(The exhaustive `switch` over the union eliminates the "default" branch — TypeScript will error if a future `SignupSource` value isn't handled, which is the desired safety net.)

- [ ] **Step 4: Run the test to verify it passes**

Run from `apps/pa-landing/`:
```bash
node --import tsx --test src/lib/browser-identity.test.ts
```
Expected: all 17 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/pa-landing/src/lib/browser-identity.ts apps/pa-landing/src/lib/browser-identity.test.ts
git commit -m "$(cat <<'EOF'
feat(pa-landing): layoffhedge uses standard candidate onboarding path

layoffhedge is an external referral-partner attribution, not a product
variant. onboardingDestination now uses an exhaustive switch so future
SignupSource additions are compile-time enforced.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Defensive fix — `normalizedSource` defaults to `candidate`

**Files:**
- Modify: `packages/pa-orchestrator/src/shared-onboarding.ts:782`
- Modify: `packages/pa-orchestrator/src/__tests__/shared-onboarding.test.ts`

- [ ] **Step 1: Write the failing regression test**

Open `packages/pa-orchestrator/src/__tests__/shared-onboarding.test.ts`. Find an appropriate location near other source-related tests (if none, add at the bottom). Add:

```ts
import {
  sharedOnboardingSignupSource,
  WEKRUIT_CANDIDATE_SOURCE,
  WEKRUIT_LAYOFF_SOURCE,
} from "../shared-onboarding.js"

test("sharedOnboardingSignupSource: explicit WeKruit_Laid_Off opts into layoff", () => {
  assert.equal(sharedOnboardingSignupSource(WEKRUIT_LAYOFF_SOURCE), WEKRUIT_LAYOFF_SOURCE)
})

test("sharedOnboardingSignupSource: explicit candidate stays candidate", () => {
  assert.equal(sharedOnboardingSignupSource(WEKRUIT_CANDIDATE_SOURCE), WEKRUIT_CANDIDATE_SOURCE)
})

test("sharedOnboardingSignupSource: layoffhedge defaults to candidate", () => {
  assert.equal(sharedOnboardingSignupSource("layoffhedge"), WEKRUIT_CANDIDATE_SOURCE)
})

test("sharedOnboardingSignupSource: undefined defaults to candidate (post-fix)", () => {
  assert.equal(sharedOnboardingSignupSource(undefined), WEKRUIT_CANDIDATE_SOURCE)
})

test("sharedOnboardingSignupSource: garbage defaults to candidate", () => {
  assert.equal(sharedOnboardingSignupSource("totally-not-a-source"), WEKRUIT_CANDIDATE_SOURCE)
})
```

(If the import line for these symbols already exists in the test file, merge rather than duplicate.)

- [ ] **Step 2: Run the test to verify it fails**

Run from repo root: `pnpm --filter pa-orchestrator test -- --test-name-pattern sharedOnboardingSignupSource`
Expected: the three non-explicit-layoff tests FAIL — current code coerces every non-candidate value to `WeKruit_Laid_Off`.

(If the `--test-name-pattern` filter isn't supported by your local node version, run the whole `shared-onboarding.test.ts` file directly: `cd packages/pa-orchestrator && node --import tsx --test src/__tests__/shared-onboarding.test.ts`.)

- [ ] **Step 3: Flip the default**

Edit `packages/pa-orchestrator/src/shared-onboarding.ts:782`. Replace:

```ts
function normalizedSource(value: unknown): WekruitSignupSource {
  return value === WEKRUIT_CANDIDATE_SOURCE ? WEKRUIT_CANDIDATE_SOURCE : WEKRUIT_LAYOFF_SOURCE
}
```

With:

```ts
function normalizedSource(value: unknown): WekruitSignupSource {
  return value === WEKRUIT_LAYOFF_SOURCE ? WEKRUIT_LAYOFF_SOURCE : WEKRUIT_CANDIDATE_SOURCE
}
```

(No other change to the file. `sharedOnboardingSignupSource` continues to delegate to `normalizedSource`.)

- [ ] **Step 4: Run the test to verify it passes**

Run from repo root: `pnpm --filter pa-orchestrator test`
Expected: every test in `pa-orchestrator` passes, including the five new ones AND every existing onboarding-intent-ack / shared-onboarding test (those pass explicit `WEKRUIT_LAYOFF_SOURCE` / `WEKRUIT_CANDIDATE_SOURCE` literals, so they are unaffected by the default flip).

If any existing test fails, STOP. Read the failing test — it likely encodes the old "non-candidate → layoff" assumption and needs to be re-aligned with the corrected semantics. Surface the failure to the human reviewer before changing the test.

- [ ] **Step 5: Commit**

```bash
git add packages/pa-orchestrator/src/shared-onboarding.ts packages/pa-orchestrator/src/__tests__/shared-onboarding.test.ts
git commit -m "$(cat <<'EOF'
fix(pa-orchestrator): normalizedSource defaults to candidate, not layoff

Closes the latent coercion that would silently route any non-candidate
PaUserSource (layoffhedge, admin, dev_test, etc.) into the layoff onboarding
flow. Only explicit WeKruit_Laid_Off now opts in. Defensive — no live caller
exercised the old default, but the export is reachable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Backend `sourceForProfileCreate` honors `"layoffhedge"`

**Files:**
- Modify: `apps/functions/src/public-cv-ingest.ts:171`
- Create: `apps/functions/src/__tests__/public-cv-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/functions/src/__tests__/public-cv-ingest.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import { __test_sourceForProfileCreate } from "../public-cv-ingest.js"

test("sourceForProfileCreate maps layoff_signup to WeKruit_Laid_Off", () => {
  assert.equal(__test_sourceForProfileCreate("layoff_signup"), "WeKruit_Laid_Off")
})

test("sourceForProfileCreate maps layoffhedge to layoffhedge", () => {
  assert.equal(__test_sourceForProfileCreate("layoffhedge"), "layoffhedge")
})

test("sourceForProfileCreate accepts any valid PaUserSource verbatim", () => {
  assert.equal(__test_sourceForProfileCreate("candidate"), "candidate")
  assert.equal(__test_sourceForProfileCreate("admin"), "admin")
  assert.equal(__test_sourceForProfileCreate("external_supply"), "external_supply")
})

test("sourceForProfileCreate falls back to candidate for unknown strings", () => {
  assert.equal(__test_sourceForProfileCreate("nonsense"), "candidate")
  assert.equal(__test_sourceForProfileCreate("public_job_page"), "candidate")
})

test("sourceForProfileCreate falls back to candidate for undefined", () => {
  assert.equal(__test_sourceForProfileCreate(undefined), "candidate")
})
```

(`__test_sourceForProfileCreate` is the export name added in Step 3 — internal helper exported only for test reach. Production code keeps using the same function.)

- [ ] **Step 2: Run the test to verify it fails**

Run from repo root: `pnpm --filter @pa/functions test -- --test-only-files src/__tests__/public-cv-ingest.test.ts` (or simply `cd apps/functions && node --import tsx --test src/__tests__/public-cv-ingest.test.ts`).
Expected: failures because `__test_sourceForProfileCreate` is not exported yet.

- [ ] **Step 3: Extend `sourceForProfileCreate` and add the test export**

Edit `apps/functions/src/public-cv-ingest.ts:171`. Replace:

```ts
function sourceForProfileCreate(uploadSource?: string): PaUserSource {
  return uploadSource === "layoff_signup" ? "WeKruit_Laid_Off" : "candidate"
}
```

With:

```ts
function sourceForProfileCreate(uploadSource?: string): PaUserSource {
  if (uploadSource === "layoff_signup") return "WeKruit_Laid_Off"
  if (isPaUserSource(uploadSource)) return uploadSource
  return "candidate"
}

/** Internal — exported for unit tests only. Do not call from production code. */
export const __test_sourceForProfileCreate = sourceForProfileCreate
```

(`isPaUserSource` is already imported at the top of the file. The new branch handles `"layoffhedge"` and every other `PaUserSource` value uniformly — no per-partner code in the future.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/functions && node --import tsx --test src/__tests__/public-cv-ingest.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Run the full functions test suite to verify no regression**

Run from repo root: `pnpm --filter @pa/functions test`
Expected: green. If any existing test relied on `sourceForProfileCreate("public_job_page")` returning `"candidate"` (which it still does via the fallback), no change in behavior — but verify.

- [ ] **Step 6: Confirm the test file is auto-picked**

`apps/functions/package.json` `test` script already includes `src/__tests__/*.test.ts` (wildcard, verified 2026-05-27). No edit required — `public-cv-ingest.test.ts` is auto-picked.

- [ ] **Step 7: Commit**

```bash
git add apps/functions/src/public-cv-ingest.ts apps/functions/src/__tests__/public-cv-ingest.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): public-cv-ingest stamps layoffhedge on first signup

sourceForProfileCreate now accepts any valid PaUserSource verbatim (via
isPaUserSource), preserving the explicit layoff_signup → WeKruit_Laid_Off
legacy alias. Future partners need only an enum addition + the URL param,
no backend code change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Magic-link verify — stamp `layoffhedge` + add first-write-sticky guard

**Files:**
- Modify: `apps/functions/src/candidate-magic-link-verify.ts` (around lines 219–223)
- Modify: `apps/functions/src/__tests__/candidate-magic-link-verify.test.ts`

> **Note — spec correction discovered during plan-writing:** the design spec (§4.5) said "no production code change" for magic-link verify. Reading the actual code revealed line 220 unconditionally writes `mergeFields.source = source` whenever a valid source is provided — there is NO `existingUserSource` guard equivalent to the one in `public-cv-ingest.ts:213`. A returning user who magic-links via `?source=layoffhedge` would have their previously-stamped source OVERWRITTEN. That contradicts the spec's first-write-sticky contract (§2 "Returning users keep their first-stamped source"). This task closes that gap.

- [ ] **Step 1: Add the failing tests**

Open `apps/functions/src/__tests__/candidate-magic-link-verify.test.ts`. Note the existing test infrastructure:
- `FakeFirestore` class with `seed(collection, id, data)` method
- `fakeDb()` helper returning `Firestore`
- `runCandidateMagicLinkVerify(input, tokenFromHeader, deps)` signature — three positional args; `deps.verifyIdToken` is the auth shim; `deps.claimProfile` returns `{ candidateId, authMapping, emailHandle, selfProfile, ... }`.

Append at the bottom of the file:

```ts
test("runCandidateMagicLinkVerify stamps layoffhedge on first-time pa-users create", async () => {
  const db = fakeDb()
  const { status, result } = await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-1", source: "layoffhedge" },
    undefined,
    {
      db,
      verifyIdToken: async () => ({
        uid: "fb-1",
        email: "new.layoffhedge@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-lh-1",
        authMapping: {
          firebaseUid: "fb-1",
          candidateId: "cand-lh-1",
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-lh-1",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: false,
        selfProfile: {
          candidateId: "cand-lh-1",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-27T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )
  assert.equal(status, 200)
  assert.equal(result.ok, true)

  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-lh-1").get()
  assert.equal((snap.data() as { source?: string } | undefined)?.source, "layoffhedge")
})

test("runCandidateMagicLinkVerify does NOT overwrite an existing pa-users.source", async () => {
  const db = fakeDb()
  ;(db as unknown as FakeFirestore).seed(PA_COLLECTIONS.users, "cand-lh-2", {
    source: "candidate",
    createdAt: "2026-04-01T00:00:00.000Z",
  })

  await runCandidateMagicLinkVerify(
    { firebaseIdToken: "token-2", source: "layoffhedge" },
    undefined,
    {
      db,
      verifyIdToken: async () => ({
        uid: "fb-2",
        email: "returning@example.com",
        email_verified: true,
      }),
      claimProfile: async () => ({
        candidateId: "cand-lh-2",
        authMapping: {
          firebaseUid: "fb-2",
          candidateId: "cand-lh-2",
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        emailHandle: {
          handleId: "email_hash",
          candidateId: "cand-lh-2",
          kind: "email" as const,
          handleHash: "h",
          source: "candidate" as const,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        claimedEventId: "ident_claimed",
        idempotent: true,
        selfProfile: {
          candidateId: "cand-lh-2",
          lifecycleState: "claimed" as const,
          handles: [{ kind: "email" as const, source: "candidate" as const }],
          createdAt: "2026-05-27T00:00:00.000Z",
        },
      }),
      claireConversationStarted: async () => false,
      hasResumeOnFile: async () => false,
    },
  )

  const snap = await db.collection(PA_COLLECTIONS.users).doc("cand-lh-2").get()
  assert.equal(
    (snap.data() as { source?: string } | undefined)?.source,
    "candidate",
    "returning user must keep first-stamped source",
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/functions && node --import tsx --test src/__tests__/candidate-magic-link-verify.test.ts`
Expected: the second test ("does NOT overwrite") FAILS — current code at line 220 unconditionally writes `mergeFields.source = source`, overwriting the seeded `"candidate"` with `"layoffhedge"`. The first test ("stamps layoffhedge on first-time create") may already pass — that's the desired green.

- [ ] **Step 3: Add the first-write-sticky guard to magic-link verify**

Edit `apps/functions/src/candidate-magic-link-verify.ts`. Find the merge block (currently around lines 219–223):

```ts
    const mergeFields: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (source) mergeFields.source = source
    if (linkedinUrl) mergeFields.linkedinUrl = linkedinUrl
    if (linkedinLinkedViaOauth) mergeFields.linkedinOauthLinked = true
    await userRef.set(mergeFields, { merge: true })
```

Replace with:

```ts
    const mergeFields: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (source) {
      // First-write-sticky attribution: only stamp `source` if the pa-users
      // doc does not already carry a valid PaUserSource. Mirrors the
      // existingUserSource guard in public-cv-ingest.ts. Without this,
      // a returning user who magic-links via a different partner URL
      // would have their original attribution silently overwritten.
      const existingUserSnap = await userRef.get()
      const existingUserSource = (existingUserSnap.data() as { source?: unknown } | undefined)?.source
      if (!isPaUserSource(existingUserSource)) {
        mergeFields.source = source
      }
    }
    if (linkedinUrl) mergeFields.linkedinUrl = linkedinUrl
    if (linkedinLinkedViaOauth) mergeFields.linkedinOauthLinked = true
    await userRef.set(mergeFields, { merge: true })
```

(`isPaUserSource` is already imported at the top of the file — verify before editing.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/functions && node --import tsx --test src/__tests__/candidate-magic-link-verify.test.ts`
Expected: every test in the file passes, including the two new ones.

- [ ] **Step 5: Run the full functions suite to verify no regression**

Run from repo root: `pnpm --filter @pa/functions test`
Expected: green. Pay attention to any other test that exercised `runCandidateMagicLinkVerify` with a `source` field and expected an overwrite — those tests must be re-examined (the new sticky semantics may have intentionally changed their expectation). If any such test fails, surface to the reviewer; do not change the test to match the broken old behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/functions/src/candidate-magic-link-verify.ts apps/functions/src/__tests__/candidate-magic-link-verify.test.ts
git commit -m "$(cat <<'EOF'
fix(functions): magic-link verify honors first-write-sticky source

Mirrors the existingUserSource guard in public-cv-ingest.ts. A returning
user who magic-links via ?source=layoffhedge after originally signing up
through a different funnel now keeps their first-stamped attribution.
Closes a spec gap surfaced during plan-writing — the design assumed sticky
semantics but the magic-link path was overwriting unconditionally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `PublicJob.tsx` posts the resolved source to CV ingest

**Files:**
- Modify: `apps/pa-landing/src/pages/PublicJob.tsx`

No new test file — the upload happens inside a React component with Firebase Auth + `fetch`, which the existing test fixtures don't cover (this was already the case before this change). The behavior is instead validated by the live scenario in Task 10.

- [ ] **Step 1: Import `resolveSource` and `peekSource`**

Open `apps/pa-landing/src/pages/PublicJob.tsx`. Find line 51:

```ts
import { stickSourceFromLoginNext } from "../lib/source.js"
```

Replace with:

```ts
import { peekSource, resolveSource, stickSourceFromLoginNext } from "../lib/source.js"
```

- [ ] **Step 2: Call `resolveSource()` on component mount**

Find the top-level `PublicJob` component function (the default export — search for `export default function PublicJob`). At the very top of its body, before any `useState`/`useEffect`, add:

```ts
useEffect(() => {
  // Stamp ?source=… into the wko_source cookie on first paint so the
  // subsequent CV-ingest POST has the right attribution available via
  // peekSource(). Idempotent — safe to run on every mount.
  resolveSource()
}, [])
```

(If a `useEffect` block already exists at the top of the function, add this as a new, separate effect — do not merge with an unrelated lifecycle.)

- [ ] **Step 3: Replace the hard-coded source literal in the upload POST**

Find line 902 (search for the literal `source: "public_job_page",` — it appears exactly once):

```ts
        body: JSON.stringify({
          userId: uploadUserId,
          browserUid: requestedUserId,
          resumeBase64: b64,
          resumeName: file.name,
          jobIdContext: jobId,
          source: "public_job_page",
        }),
```

Replace the body construction with:

```ts
        body: JSON.stringify({
          userId: uploadUserId,
          browserUid: requestedUserId,
          resumeBase64: b64,
          resumeName: file.name,
          jobIdContext: jobId,
          source: peekSource(),
        }),
```

`peekSource()` reads the cookie that was just written by `resolveSource()` on mount (Step 2). It returns the live `SignupSource` literal directly — `candidate` for a candidate.wekruit.com user with no `?source=` param, `WeKruit_Laid_Off` for a layoff referral, `layoffhedge` for the new partner.

- [ ] **Step 4: Typecheck**

Run from `apps/pa-landing/`:
```bash
pnpm typecheck
```
Expected: 0 errors. (`SignupSource` is a string literal union and the CV ingest body type is `Record<string, unknown>`-equivalent in the fetch path, so no type cast is needed.)

- [ ] **Step 5: Build**

Run from `apps/pa-landing/`:
```bash
pnpm build
```
Expected: build succeeds. Confirm the produced bundle contains the literal `"layoffhedge"` (the cookieSource() / urlSource() string comparisons keep it as a string-literal, so the minifier will preserve it):

```bash
grep -c '"layoffhedge"' dist/assets/index-*.js
```
Expected: ≥ 1.

- [ ] **Step 6: Run the existing tests for affected libs**

Run from `apps/pa-landing/`:
```bash
node --import tsx --test src/lib/source.test.ts src/lib/browser-identity.test.ts
```
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/pa-landing/src/pages/PublicJob.tsx
git commit -m "$(cat <<'EOF'
feat(pa-landing): PublicJob stamps live source into CV-ingest POST

Replaces hard-coded source: "public_job_page" with peekSource(); adds a
resolveSource() mount effect so ?source=layoffhedge sticks into the
wko_source cookie before the upload fires. Existing layoff and candidate
flows unchanged; layoffhedge now propagates through to pa-users.source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full local green-light + deploy preview

**Files:** none (verification only).

- [ ] **Step 1: Pin runtime to Node 24**

Run from repo root:
```bash
source ~/.zshrc && nvm use 24
node --version
```
Expected: `v24.x.x` (per CLAUDE.md Node 24 lock).

- [ ] **Step 2: Run every affected unit suite**

Run from repo root, sequentially:
```bash
pnpm --filter @pa/core-types test
pnpm --filter pa-orchestrator test
pnpm --filter @pa/functions test
cd apps/pa-landing && node --import tsx --test src/lib/source.test.ts src/lib/browser-identity.test.ts && cd -
```
Expected: all green.

- [ ] **Step 3: Build the landing bundle and grep for the literal**

Run from `apps/pa-landing/`:
```bash
pnpm build
grep -c '"layoffhedge"' dist/assets/index-*.js
```
Expected: build succeeds; grep returns ≥ 1.

- [ ] **Step 4: Predeploy smoke for functions**

Run from `apps/functions/`:
```bash
pnpm run deploy --dry-run
```

(If `pnpm run deploy` does not accept `--dry-run`, instead run the predeploy script directly: `node scripts/predeploy-smoke.mjs && pnpm build && pnpm typecheck && pnpm test`.)

Expected: predeploy chain green.

- [ ] **Step 5: Open a PR**

Run from repo root:
```bash
git push -u origin claude/kind-rhodes-b1e983
gh pr create --title "feat: layoffhedge source attribution" --body "$(cat <<'EOF'
## Summary
- Adds `layoffhedge` to `PA_USER_SOURCES`; closed-enum extension per Adam decision 2026-05-27.
- Public job page + magic-link verify + CV ingest now propagate `?source=layoffhedge` to `pa-users.source` end-to-end.
- Standard candidate UX; only attribution differs.
- Defensive fix in `shared-onboarding.ts` `normalizedSource` so future callers cannot silently coerce `layoffhedge` into the layoff flow.

## Spec
- [docs/superpowers/specs/2026-05-27-layoffhedge-source-attribution-design.md](docs/superpowers/specs/2026-05-27-layoffhedge-source-attribution-design.md)

## Plan
- [docs/superpowers/plans/2026-05-27-layoffhedge-source-attribution.md](docs/superpowers/plans/2026-05-27-layoffhedge-source-attribution.md)

## Test plan
- [ ] `pnpm --filter @pa/core-types test` green
- [ ] `pnpm --filter pa-orchestrator test` green
- [ ] `pnpm --filter @pa/functions test` green
- [ ] `apps/pa-landing` lib tests green
- [ ] `apps/pa-landing` `pnpm build` succeeds; bundle contains literal `"layoffhedge"`
- [ ] Post-merge live scenario (Task 10) confirms `pa-users.source = "layoffhedge"` in Firestore

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Surface to reviewer.

No commit (push only).

---

## Task 10: Post-merge deploy + live scenario verification

**Files:** none (operational task).

Per `CLAUDE.md` "Deploy after merge" memory: merge to `main` FIRST, then deploy. Per "Deploy only when asked, scope changed-only": use `--only` flags to scope the deploy to the changed surfaces.

- [ ] **Step 1: Wait for the PR to merge to `main`**

After the PR is approved and merged, re-sync the working tree:
```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
```

- [ ] **Step 2: Source the Firebase service-account credential**

Run from repo root:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
```

- [ ] **Step 3: Deploy the changed functions (scope to the two callables this change touches)**

Run from `apps/functions/`:
```bash
firebase deploy \
  --only functions:paPublicCvIngest,functions:paCandidateMagicLinkVerify \
  --project wekruit-5f89b \
  --non-interactive
```

Expected: both functions deploy green. The predeploy gate (`firebase.json` chain) auto-runs the smoke + build + typecheck + test sequence first.

- [ ] **Step 4: Deploy the pa-landing hosting site**

Run from repo root:
```bash
firebase deploy \
  --only hosting:pa-landing \
  --project wekruit-5f89b \
  --non-interactive
```

Expected: hosting deploy green; site URL printed.

- [ ] **Step 5: Live scenario — public job page**

Open an incognito window. Pick a test job ID from `pa-jobs` Firestore (any active job is fine; e.g. the one Adam linked at the top of the conversation: `hs-10996795-invoko-product-manager`). Visit:

```
https://candidate.wekruit.com/j/hs-10996795-invoko-product-manager?source=layoffhedge
```

Open DevTools → Application → Cookies for `candidate.wekruit.com`. Confirm:
- `wko_source = layoffhedge`
- `Domain = .wekruit.com`
- `Max-Age = 15552000` (180 d)

- [ ] **Step 6: Live scenario — sign up via magic link**

On the same incognito page, click the public-job CTA that requests email. Enter a test mailbox you control (NOT a Sendblue-routed phone). Open the magic link in the same incognito session. Confirm the post-verify redirect lands somewhere on `candidate.wekruit.com` (NOT `/onboarding?source=layoff` — the cream layoff flow).

- [ ] **Step 7: Verify the Firestore write**

Run from repo root:
```bash
node -e "
import('firebase-admin/app').then(async ({ initializeApp, applicationDefault }) => {
  const { getFirestore } = await import('firebase-admin/firestore')
  initializeApp({ credential: applicationDefault() })
  const db = getFirestore()
  const uid = process.argv[1]
  const snap = await db.collection('pa-users').doc(uid).get()
  console.log(JSON.stringify(snap.data(), null, 2))
}" "<the-uid-from-step-6>"
```

Replace `<the-uid-from-step-6>` with the actual UID. Confirm the printed `source` field is `"layoffhedge"`.

- [ ] **Step 8: Live scenario — returning-user attribution stickiness**

In the same incognito session, visit:
```
https://candidate.wekruit.com/j/<a-different-jobId>?source=layoff
```
Upload a resume (or trigger any path that hits `paPublicCvIngest`). Then re-run the Firestore probe from Step 7. Expected: `source` is **still `"layoffhedge"`** — the `existingUserSource` guard in `public-cv-ingest.ts` keeps the first-stamped value.

- [ ] **Step 9: Surface a verification screenshot to Adam**

Post in your usual channel:
- Firestore `pa-users/{uid}` doc showing `source: "layoffhedge"`
- Cookie inspector showing `wko_source=layoffhedge; Domain=.wekruit.com`
- One-sentence note: "layoffhedge attribution live. Spec + plan committed; verification artifacts attached."

No commit in this task — it's deploy verification.

---

## Self-Review (run before sending the plan to a human)

**1. Spec coverage**

| Spec section | Plan task |
|---|---|
| §4.1 vocab — add `"layoffhedge"` to `PA_USER_SOURCES` | Task 2 |
| §4.2 client resolver — `SignupSource`, `urlSource`, `cookieSource`, `stickSourceFromLoginNext` | Task 3 |
| §4.3 `PublicJob.tsx` upload — `peekSource()` body field + mount `resolveSource()` | Task 8 |
| §4.4 backend `sourceForProfileCreate` mapper | Task 6 |
| §4.5 magic-link verify (validation already present; add coverage) | Task 7 |
| §4.6 `onboardingDestination("layoffhedge")` → `"/onboarding"` | Task 4 |
| §4.7 defensive `normalizedSource` flip | Task 5 |
| §8.1 unit tests (5 file targets) | Tasks 2, 3, 4, 5, 6, 7 |
| §8.2 live scenario | Task 10 |
| §9 rollout | Tasks 9 + 10 |

No spec section without a task.

**2. Placeholder scan** — no "TBD" / "TODO" / "implement later" / "add appropriate error handling" / "fill in details" / "similar to Task N" / undefined symbols. Every code step contains the actual code.

**3. Type consistency** — `SignupSource` (pa-landing) and `PaUserSource` (core-types) are deliberately different unions. `SignupSource` is the client-resolved subset (`candidate | WeKruit_Laid_Off | layoffhedge`); `PaUserSource` is the full backend allowlist. The plan never crosses them — Task 3 extends `SignupSource`, Task 2 extends `PA_USER_SOURCES`, and Task 6 uses `isPaUserSource()` to validate at the boundary. Function and constant names (`peekSource`, `resolveSource`, `stickSourceFromLoginNext`, `sourceForProfileCreate`, `normalizedSource`, `sharedOnboardingSignupSource`) are spelled consistently across all tasks.
