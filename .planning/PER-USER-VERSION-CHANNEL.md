# Per-User Version Channel (Canary / Ring)

**Status:** plumbing shipped on branch `feat/per-user-version-channel` (zero-regression no-op until a behavior is marked latest-only). Built 2026-05-28.

## Why

When we ship new conversation behavior we want to dogfood it on internal/test
users FIRST, while everyone else keeps the previous stable behavior — then
promote once it's proven. This is a per-user canary/ring, modeled byte-for-byte
on the existing per-user `runtimeMode` HITL pause.

## The mechanism (4 parts + 1 worked example)

### 1. Schema field — `packages/core-types/src/index.ts`

Sibling of `runtimeMode` on `UserSchema` (~line 248):

```ts
versionChannel: z.enum(["latest", "stable"]).optional()  // default/unset = stable
versionChannelAt / versionChannelSetBy / versionChannelReason  // audit
```

`stable` (or unset) = previous behavior. `latest` = newest behavior under test.

### 2. Pure resolver — `packages/pa-orchestrator/src/version-channel.ts`

No Firestore; pure function over a small facts object so it's unit-testable and
shared by the store + the CF.

```
resolveVersionChannel({ userId, phoneE164, storedChannel, env }) → "latest" | "stable"
  latest IF  userId ∈ env.PA_INTERNAL_USER_IDS (CSV)
         OR  phoneE164 ∈ internal phones (env.PA_INTERNAL_PHONE_NUMBERS CSV,
             ALWAYS incl. the dev phone +14243201960 = DEFAULT_INTERNAL_PHONE)
         OR  storedChannel === "latest"
  stable OTHERWISE
```

Also exports `isInternalUser`, `internalUserIds`, `internalPhoneNumbers`,
`DEFAULT_INTERNAL_PHONE`, and the integration seam **`isLatestChannel`**.

### 3. Gate read — orchestrator store

- Type: `OrchestratorStore.getVersionChannel?(userId): Promise<"latest"|"stable">`
  added as an **optional** method (~line 740) so older / test stores are
  unaffected.
- Impl: the Firestore-backed store (~line 6830) reads `pa-users/{userId}`
  (`versionChannel` + `phoneE164`) and resolves via the pure fn with
  `process.env`. Default `stable` when absent / user-not-found.

### 4. Admin setter CF — `apps/functions/src/index.ts` + `version-channel.ts`

- `paVersionChannel` (sibling of `paRuntimeMode`): `GET ?userId=` reads stored +
  **effective** channel + `internal` flag; `POST { userId, channel, reason? }`
  sets the field + audit fields + a `version_channel` audit row.
- `paHealthVersionChannel` health probe (mirrors `paHealthRuntimeMode`).
- Core read/write logic lives in `apps/functions/src/version-channel.ts`
  (`readVersionChannel` / `setVersionChannel` / `parseChannel`) over an injected
  Firestore so it's unit-tested without importing the side-effectful CF entry
  (same extract pattern as `admin-match-debug.ts`).
- Dashboard lib: `apps/dashboard-web/src/lib/versionChannel.ts`
  (`getVersionChannel` / `setVersionChannel`) — sibling of `runtimeMode.ts`. A
  full `/admin/version-channel` UI page is a **follow-up** (the lib is the
  seam; not blocking).

### Worked example — `__PA_CHANNEL_PROBE__` dev-trigger

`processInboundEvent` (~line 4257, right after `__PA_RESET__`) handles the
dev/test-only `__PA_CHANNEL_PROBE__` token: it calls `isLatestChannel(store,…)`
and replies with which channel the user resolved to. It is the canonical
worked example of a latest-only behavior and is **strictly inert** for all real
traffic (only fires on the exact token).

## How to mark a behavior "latest-only"

Wrap the NEW path in `isLatestChannel`. The else-branch is the existing stable
behavior:

```ts
import { isLatestChannel } from "@pa/pa-orchestrator" // or "./version-channel.js" in-package

if (await isLatestChannel(store, event.userId)) {
  // NEW behavior under test — internal/canary users only
} else {
  // PREVIOUS stable behavior — everyone else (UNCHANGED)
}
```

For prompt/handbook selection, the same idea applies at the slug layer (see open
decision): `slug = (await isLatestChannel(store, userId)) ? \`${base}-latest\` : base`,
falling back to `base` when the `-latest` handbook doc is absent.

`isLatestChannel` **self-gates to `false`** when the store has no
`getVersionChannel` (older/test stores) and **fails closed to `false`** on a
resolver error — a normal user is never flipped onto unproven behavior by an
outage.

## Zero-regression contract

- Everyone defaults to `stable` = byte-for-byte current behavior.
- The field/resolver/CF are a **strict no-op** until some behavior is wrapped in
  `isLatestChannel` AND a user resolves to `latest`. Exactly like `runtimeMode`
  self-gating when `getRuntimeMode` is unimplemented or returns `auto`.
- Verified: core-types 99/99, orchestrator 1817/1817, functions 2037/2037 green
  (the only behavior consulting the channel today is the inert
  `__PA_CHANNEL_PROBE__` trigger).

## Promotion flow (latest → everyone)

A version is promoted by one of:

1. **Flip the cohort** — for canary opt-ins, `POST paVersionChannel` each user
   `stable→latest` (or, at scale, a backfill setting `versionChannel:"latest"`).
   Internal users are already `latest` via the allowlist; no write needed.
2. **Remove the gate (preferred end-state)** — once a latest-only behavior is
   proven, delete the `if (await isLatestChannel(...))` wrapper so the NEW path
   becomes the unconditional default for everyone. The channel field then frees
   up for the NEXT change. (Add an eval/regression case for the now-default
   behavior when you remove the gate.)
3. **Rollback** — `POST … channel:"stable"` puts an individual back on the
   previous behavior; or keep the gate and stop marking new behaviors latest-only.

Expanding the canary cohort: set individual users to `latest` via the setter
(route 1) before full promotion. Shrinking: set back to `stable`.

## OPEN DECISION FOR ADAM — which surfaces are version-gated?

The plumbing is surface-agnostic on purpose. **Decide which of these the channel
should actually gate** (we can do one, some, or all):

- **(a) Prompt / handbook version** — latest channel loads a `<slug>-latest`
  handbook (the V2 loader at index.ts ~4972 already resolves a slug + falls back
  cleanly when a doc is missing). Cleanest for "new Claire voice/persona" tests.
- **(b) Specific behavior feature-flags** — keep behaviors behind `getFlag` and
  have a flag's allowlist (or a helper) consult `isLatestChannel` so a flag is
  "ON for latest users only". Cleanest for one-off conversational changes.
- **(c) The whole agentic rebuild stack** — gate the entire P0–P8 agentic stack
  (currently flag-gated default-OFF, Adam hold per memory) on the channel so
  internal users run the full new runtime end-to-end. Biggest blast radius;
  needs Adam's explicit go.

Recommendation: start with **(a) prompt/handbook** + **(b) per-behavior** as
needed (both are low-risk, additive). Hold **(c)** until Adam lifts the agentic
merge hold. No surface is wired to the channel yet — that wiring is the next
step once Adam picks.

## Internal allowlist config (Adam action when activating)

- `PA_INTERNAL_USER_IDS` — CSV of internal `pa-users/{uid}` ids → always latest.
- `PA_INTERNAL_PHONE_NUMBERS` — CSV of internal E.164 phones → always latest.
  The dev phone `+14243201960` is baked in and needs no config.

Set as Firebase function env/secrets when we start gating a real surface.

## Files

| File | What |
|---|---|
| `packages/core-types/src/index.ts` | `versionChannel` + audit fields on `UserSchema` |
| `packages/pa-orchestrator/src/version-channel.ts` | pure resolver + `isLatestChannel` seam |
| `packages/pa-orchestrator/src/index.ts` | `getVersionChannel?` type + Firestore impl + re-exports + `__PA_CHANNEL_PROBE__` example |
| `apps/functions/src/version-channel.ts` | CF core read/write logic (injected Firestore) |
| `apps/functions/src/index.ts` | `paVersionChannel` + `paHealthVersionChannel` CFs |
| `apps/dashboard-web/src/lib/versionChannel.ts` | dashboard client lib |
| `packages/pa-orchestrator/src/version-channel.test.ts` | 14 resolver/seam tests |
| `apps/functions/src/__tests__/version-channel.test.ts` | 9 CF read/write/audit tests |
| `tests/scenarios/version-channel/*.yaml` | 3 runner-local sims (internal=latest, normal=stable, opt-in=latest) |
