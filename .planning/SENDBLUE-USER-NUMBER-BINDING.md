I have all the grounding I need. The worktree state confirms: `pickFromNumber` is hash%N (pool.ts:169-178), the binding field exists and is written by 4 paths, honored by outbox (outbox.ts:505-516) but clobbered by the `sendImessage` userId override (sendblue-client.ts:143-157), bypassed by transport (transport.ts:130-131) and send-reaction (send-reaction.ts:178-184); counters infra exists (pool.ts:519-604); UserSchema lacks the bind fields; the non-QR provisional create (index.ts:915) gives no binding. Now I'll write the plan.

# Sendblue User↔Number Binding — Design + Implementation Plan (2026-06-01)

> Scope: make **one user bind to one Sendblue number, persisted**, so growing the from-number pool (1→2→N) never moves an existing user's thread. Read-only investigation; this is a design + impl plan, no code changed. All `file:line` are against the `claude/thin-PB` worktree.

---

## 1. Why — the hash%N reshuffle bug

The from-number selector is a **pure, stateless hash**:

```ts
// apps/functions/src/sendblue/pool.ts:169-178
export function pickFromNumber(pool, userId, options = {}): string | null {
  const active = normalizedPoolNumbers(pool).filter((n) => isSelectablePoolNumber(n, options))
  if (active.length === 0) return null
  const idx = hashStringToUint(userId) % active.length   // ← N = active.length
  return active[idx].number
}
```

`idx = hash(userId) % active.length`. The instant a second number becomes `status:'active'`, `active.length` goes `1 → 2`, and **~50% of users land on a different index** → their outbound now comes from a different line than every prior message. On iMessage, a from-number change breaks thread continuity: the candidate's existing blue-bubble thread goes silent and a new thread appears from a stranger number. Read receipts and typing indicators also stop matching (Sendblue keys those on the line that owns the thread).

Today this is *latent* because there is effectively **one** active number (`hash(uid) % 1 === 0` for everyone), so nobody has moved yet. The bug detonates on the **first pool growth** — exactly the capacity expansion product rule 10 mandates (300–500 reachable users per group before adding a number).

A persisted per-user binding (`pa-users.senderNumber`) **already exists** and is honored on 2 of 5 send paths, but 3 hot paths re-derive via `pickFromNumber` and one of those (`sendImessage`) actively **overrides** the binding the honoring path passed in. The fix: make the persisted binding the single source of truth on **every** send path; only ever use `pickFromNumber` to *mint a brand-new* binding, never to *route an already-bound user*.

---

## 2. AS-IS — every from-number call site

### 2.1 The selector and pool config
- **Selector:** `pickFromNumber(pool, userId)` = `hash(userId) % active.length`, pure, no persistence — `pool.ts:169-178`.
- **Selectable predicate:** `isSelectablePoolNumber` gates `status==='active'` + `isUserAccessibleSendblueNumber` (excludes `adminOnly` / audience `admin|internal|developer`) + optional `requireNewUserCapacity` (`assignedNewUsers < newUserCap`) — `pool.ts:141-163`.
- **Pool config doc:** `pa-config/sendblue-pool`, `groups[]`/`numbers[]`, 60s TTL cache — `loadSendbluePool` `pool.ts:481`. Adding a number = editing this one doc; picked up within 60s across CF instances.
- **Counter infra (already built):** sibling doc `pa-config/sendblue-pool-counters`, map `{ [groupId]: assignedNewUsers }`, race-safe `FieldValue.increment` — `incrementAssignedNewUsers` `pool.ts:577`, `decrementAssignedNewUsers` `pool.ts:593`, `loadSendbluePoolWithCounters` (overlay-at-read) `pool.ts:568`, `pickScanNumber` `pool.ts:614`.
- **Capacity-aware sibling selector:** `selectSendblueCapacityGroup` (sticky group, warmup/paused/degraded statuses, `dailySendCap`) — `pool.ts:336`; note its **final tie-break is also `hash(candidateId) % eligible.length`** (`pool.ts:441`), so it has the same reshuffle exposure if used at route time.

### 2.2 The persisted binding (already exists)
Field: `pa-users/{uid}.senderNumber` + `senderGroupId` + `senderAssignedAt` + `senderAssignedSource`.

**Written by 4 identity-creation paths:**
| Path | Site | Source tag |
|---|---|---|
| Candidate identity assign (read-before-pick, no-op if present) | `identity/candidate-sender-number.ts:35-56` | `candidate_identity` |
| QR-scan provisional create (scan-time pick wins, override-first) | `index.ts:687-691` | `qr_scan` |
| Layoff intake register | `openLayoff.ts:301-321` (+ re-register `:423`) | (source field) |
| Magic-link verify / resume-gate | `candidate-magic-link-verify.ts:263`, `candidate-resume-gate.ts:268` | (assign helper) |

`assignCandidateSenderNumber` is the closest thing to a binder today: it **reads `user.senderNumber` first and returns it if set** (`candidate-sender-number.ts:35-42`), else `pickFromNumber(..., {requireNewUserCapacity:true})` and a **non-transactional** `set(merge:true)` (`:44-55`). It is only called from magic-link / resume-gate / identity — **never from the plain iMessage hot path**.

### 2.3 The five send paths — who honors the binding, who bypasses it

| # | Path | Site | Binding? |
|---|---|---|---|
| READ 1 | **pa-outbound delivery** reads `user.senderNumber` → passes as `explicitFromNumber` | `outbox.ts:505-516` | ✅ honors (but see clobber ↓) |
| READ 2 | **orchestrator-deps `sendReaction`** dep | `orchestrator-deps.ts:87-89` | ⚠️ in this worktree it calls `sendReaction({to,messageHandle,reaction})` with **no fromNumber** → falls into the bypass below |
| BYPASS A | **live-chat `sendImessage`** re-derives `pickFromNumber(pool, input.userId)` and **unconditionally overrides** `resolvedFromNumber` whenever `userId` is set | `sendblue-client.ts:143-157` | ❌ hash%N — **and clobbers the explicit fromNumber outbox passed** |
| BYPASS B | **transport read-receipt + typing line** `resolveFromNumber` = `pickFromNumber(loadSendbluePool, deps.userId)`, memoized per-turn only | `transport.ts:130-131` | ❌ hash%N |
| BYPASS C | **send-reaction fallback** `resolveReactionFromNumber` = `pickFromNumber(loadSendbluePool, input.userId)` when no explicit `fromNumber` | `send-reaction.ts:178-184` | ❌ hash%N |

**The load-bearing bug** (`sendblue-client.ts:143-157`): even READ 1 is defeated. `outbox.ts:510-516` sends `{ fromNumber: explicitFromNumber, userId, ... }`. Inside `sendImessage`, `input.userId` being present runs `pickFromNumber` and assigns `resolvedFromNumber = picked` **on top of** the explicit `fromNumber`. So the persisted binding outbox correctly read is thrown away and replaced by live hash%N. Net effect: **routing is hash%N on every surface today**, persisted binding or not.

### 2.4 Mint sites that also use bare hash (not route-time, but relevant)
- `openLayoff.ts:301` register — `pickFromNumber(pool, candidateId, {requireNewUserCapacity})` then persists.
- `candidate-sender-number.ts:45` — same.
- `qr-onboarding` scan redirect → `pickScanNumber` keyed on `scanToken` (no candidateId yet) → increments per-group counter at pick time — `pool.ts:614-624`, `index.ts:687-691`.
- **Non-QR provisional create has NO binding:** plain text-only inbound → `createProvisionalUser(db, payload.participant)` with no sender options (`index.ts:915`), so a user who only ever texts (never QR, never magic-link, never gate) gets **no persisted binding** and falls through to hash%N forever.

### 2.5 Inbound resolution is number-agnostic (safe)
Inbound resolves the user by the **candidate's** phone, never by which Sendblue line received the message:
- webhook → `lookupUserByPhone(db, fromNumber, text)` → `resolveInboundUserId`, keyed on opener/prescreen token candidateId then `pa-users.phoneE164` → `pa-candidate-handles` hashed phone.
- The receiving line (`payload.to_number` / `normalized.toNumber`) is audited but **not used for user resolution**.
- ⇒ Inbound survives any line change. **The breakage is purely the OUTBOUND line picked.** Pinning the from-number is therefore safe for inbound — no inbound code changes needed.

### 2.6 Schema gap
`UserSchema` (`core-types/src/index.ts:187`) is a plain `z.object` that does **not** declare `senderNumber` / `senderGroupId` / `senderAssignedAt` / `senderAssignedSource`. Readers spread the raw doc so it works untyped today, but the contract is implicit.

---

## 3. Binding model

### 3.1 Storage choice — keep it on `pa-users/{uid}` (do NOT add a sibling doc)
Bind on the existing fields:
```ts
pa-users/{uid} {
  senderNumber: string            // E.164, the bound line
  senderGroupId: string           // sendblueGroupId(number)
  senderAssignedAt: string        // ISO
  senderAssignedSource:           // audit
    | "inbound_first" | "qr_scan" | "candidate_identity"
    | "layoff_intake" | "capacity_assign" | "rebind_paused" | "backfill_pin_2026_06"
}
```
**Why not a `sendblue-assignments/{uid}` sibling doc:** the hot durable path (`outbox.ts:505`) already loads the user doc and reads `user.senderNumber` — the binding is **co-located with data already on the critical path → zero extra Firestore read per send**. A sibling doc adds one read to every outbound. Auditability is satisfied by `senderAssignedSource` + `senderAssignedAt` plus a `pa_audit_event` on every (re)bind (product rule 9).

**Schema:** add the 4 fields to `UserSchema` (`core-types/src/index.ts:187`) as `.optional()` so the contract is typed and explicit.

### 3.2 The assignment reducer — `resolveBoundFromNumber(db, userId, pool?, opts?)`
One new function in `pool.ts` (or a new `sendblue/sender-binding.ts`) that is the **single writer** and **single route-time resolver**:

```
resolveBoundFromNumber(db, userId, { inboundToNumber?, requireNewUserCapacity?, repickOnDeadLine=false }):
  read pa-users/{userId}
  1. READ-BIND-FIRST: if senderNumber set AND that number still resolves to a
     non-deleted pool entry (findSendbluePoolNumber !== null):
        → if status ∈ {active, throttled, warmup}  → RETURN it (sticky no-op, NO write)
        → if status ∈ {paused, degraded} AND repickOnDeadLine → fall to re-bind (§3.4)
        → else (transient) → RETURN it (hold the bind)
     if senderNumber set but number NOT in pool (hard-removed) → fall to re-bind (§3.4)
  2. MINT (no bind yet, or re-bind):
        a. INBOUND-FIRST: if inboundToNumber is a valid user-accessible active pool
           number → bind to THAT (the line the candidate actually texted)
        b. else capacity-fill: pickLeastLoadedActive over loadSendbluePoolWithCounters
           (exclude admin/internal/developer + non-active; respect newUserCap +
           dailySendCap; choose min(assignedNewUsers); tie-break hash(userId) for
           determinism) — NOT bare hash%N
        c. else null (no eligible line) → caller falls back to creds.fromNumber
  3. PERSIST inside the transaction (§3.5): set senderNumber/groupId/assignedAt/source;
     bump per-group counter (incrementAssignedNewUsers) for a NEW bind only;
     emit pa_audit_event.
  return senderNumber
```

- **Read-bind → else capacity-fill:** an established user is *never* re-hashed; only an unbound user consults the pool, and even then via capacity-fill, not bare hash.
- **Inbound-first bind:** a plain text-only user who texts number B gets bound to **B** — the de-facto thread they're already in — not a hash. This is the natural backfill for the §2.4 no-binding gap.
- **`pickFromNumber` stays untouched** as the pure fallback inside capacity-fill's tie-break and for callers with no `db`/no uid (e.g. QR scan-token pre-bind).
- **Refactor `assignCandidateSenderNumber` to delegate** to this reducer so there is exactly ONE writer.

### 3.3 Paused-number / dead-line policy (locked default — Adam to confirm D1)
| Bound line status | Action |
|---|---|
| `active` | return bound (sticky no-op) |
| `throttled` / `warmup` (transient) | **HOLD** the bind, return it — continuity wins; do not move |
| `paused` / `degraded` | **HOLD by default**; re-bind only if `repickOnDeadLine` AND user has an outbound to send now |
| **hard-removed from pool** (deleted) | **RE-BIND** via capacity-fill, source `rebind_paused`, emit audit old→new |

Never auto-rebind on transient throttle or on pool *growth*. Re-bind is the single place a thread can move; gate it to genuine paused/degraded/removed and **audit every instance** (HITL-visible).

### 3.4 Transaction / race safety
Wrap read-decide-write in `db.runTransaction` keyed on the single user doc:
1. `t.get(pa-users/{uid})`; if `senderNumber` already committed → return it (loser of a concurrent double-send re-reads the committed bind and returns the same number — cannot assign two).
2. else pick (inbound-first → capacity-fill).
3. `t.set(...senderNumber/groupId/assignedAt/source)`.
4. counter bump: do `incrementAssignedNewUsers(groupId)` as a best-effort **after commit** (the counters doc is a different doc; keeping it out of the user-doc tx avoids cross-doc contention; the map-keyed `FieldValue.increment` at `pool.ts:577` is already race-safe). Decrement on opt-out/delete via `decrementAssignedNewUsers` (`pool.ts:593`).

Contention is per-user only (no cross-doc fan-in) → trivial. Reconcile with the QR pre-bind counter: QR already increments at scan-time pick (`pickScanNumber` → `incrementAssignedNewUsers`), so when the reducer sees an existing QR binding (read-bind-first) it **must NOT** double-count — only a freshly-minted bind bumps the counter.

---

## 4. Edit points — `file:line` → exact change

> Pattern everywhere: **read the persisted binding; use `pickFromNumber` only to mint.** Keep each edit fail-open (null → existing env/creds fallback). Keep the lazy `await import("./pool.js")` shape (boot-safety, per memory `functions_undeployable_sdk_agent_runtime`).

**E0 — new reducer + schema (prerequisite)**
- `apps/functions/src/sendblue/pool.ts` (or new `sendblue/sender-binding.ts`): add `resolveBoundFromNumber(db,userId,pool?,opts?)` (§3.2), `pickLeastLoadedActive(poolWithCounters,userId,opts)`. ~80 LOC.
- `packages/core-types/src/index.ts:187` — add `senderNumber/senderGroupId/senderAssignedAt/senderAssignedSource` `.optional()` to `UserSchema`.
- `apps/functions/src/identity/candidate-sender-number.ts:44` — `assignCandidateSenderNumber` delegates to `resolveBoundFromNumber` (one writer).

**E1 — `sendblue-client.ts:143-157` (THE load-bearing fix)**
Today: `if (input.userId) { ... resolvedFromNumber = pickFromNumber(pool, input.userId) }` — unconditional override.
Change:
```ts
let resolvedFromNumber = input.fromNumber?.trim() || (allowEnvFallback ? creds.fromNumber : undefined)
if (!input.fromNumber?.trim() && input.userId) {          // ← guard: never clobber explicit
  try {
    const { resolveBoundFromNumber } = await import("./pool.js")
    const db = input.db ?? getFirestore()
    const bound = await resolveBoundFromNumber(db, input.userId)   // read-bind-first
    if (bound) resolvedFromNumber = bound
  } catch { /* keep fallback */ }
}
```
Effect: an explicit bound `fromNumber` (from outbox) is preserved; the override only fires when no explicit number was passed, and then it reads the binding (not hash). **Risk: Medium — add a test proving explicit `fromNumber` wins.**

**E2 — `transport.ts:130-131` (read-receipt + typing)**
```ts
const { resolveBoundFromNumber } = await import("../sendblue/pool.js")
fromNumberCache = (await resolveBoundFromNumber(deps.db, deps.userId)) ?? undefined
```
Keep the `try/catch → undefined` and per-turn memo. Typing/read-receipt now ride the bound line. Risk: Low (best-effort, fail-open).

**E3 — `send-reaction.ts:178-184` (reaction fallback)**
After the explicit early-return (`:175-176`), swap the `pickFromNumber` branch for `resolveBoundFromNumber(input.db ?? getFirestore(), input.userId)`; keep the `allowEnvFromNumberFallback` tail (`:190`). Risk: Low.

**E4 — `orchestrator-deps.ts:87-89` (sendReaction dep)**
Pass the bound number explicitly so it never enters the bypass: read `pa-users.senderNumber` (or call the reducer) and pass `fromNumber` with `allowEnvFromNumberFallback:false`. Risk: Low.

**E5 — `openLayoff.ts:301`** — swap `pickFromNumber(pool, candidateId, {requireNewUserCapacity:!isReregistration})` for `resolveBoundFromNumber(deps.db, candidateId, pool, {requireNewUserCapacity:!isReregistration})`; keep the `batch.set` of `senderNumber/senderGroupId`. Idempotent (read-bind-first). Risk: Low.

**E6 — `index.ts:915` (non-QR provisional, the no-binding gap)** — after `createProvisionalUser(db, payload.participant)`, best-effort `await resolveBoundFromNumber(db, user.id, undefined, { inboundToNumber: normalized.toNumber })` so a binding exists (to the line they texted) before first outbound. QR override still wins (reducer no-ops when `senderNumber` already set from `index.ts:687`). Risk: Low.

**Unchanged on purpose:** `pickFromNumber` (`pool.ts:169`) stays the pure fallback; QR `pickScanNumber` (`pool.ts:614`) stays (no uid yet at scan time); inbound resolution (`webhook.ts`, `candidate-inbound-resolve.ts`) — number-agnostic, no change.

---

## 5. Backfill + safe pool-growth runbook

**Hard ordering constraint:** backfill-all (pin every existing user to the current line) AND deploy the read-before-hash code MUST both complete and verify **before** the 2nd number is appended to `pa-config/sendblue-pool`. If the number is added first, `active.length` 1→2 reshuffles every not-yet-pinned user before they can be pinned. Because today N=1 (`hash(uid)%1===0`), every active user's current effective from-number **is** that one line, so the backfill is a safe "pin everyone to the single current line."

**Script — `apps/functions/scripts/backfill-sendblue-binding.mjs`** (read-only by default; mirror `migrate-pa-users-tags.mjs` + `audit-sendblue-routing.mjs`):
- Import real prod seams (`loadSendbluePool`, `pickFromNumber`, `findSendbluePoolNumber`, `sendblueGroupId`) and reuse the audit script's predicates (`isActiveReachable`, `isAdminOrDevUser`).
- Paginate `pa-users` by doc id (cursor, pageSize 500). For each user: **SKIP if `senderNumber` already set** (idempotent, never overwrite); **SKIP if no E.164 `phoneE164`** (can't receive SMS); **SKIP if not `isActiveReachable`**; **SKIP admin/dev** unless `--include-admin`.
- Compute `currentNumber = pickFromNumber(pool, uid)` (same no-options call transport uses), `currentGroupId = sendblueGroupId(findSendbluePoolNumber(pool, currentNumber))`. If null → record `unroutable`, don't write. Else `set(merge:true)` `{senderNumber, senderGroupId, senderAssignedAt, senderAssignedSource:'backfill_pin_2026_06'}`.
- Args: `--apply` (default dry-run), `--limit`, `--page-size`, `--json`, `--include-admin` (default OFF). Summary: scanned / eligible / already-pinned / newly-pinned / skipped-no-phone / skipped-not-reachable / unroutable / per-number distribution before↔after.

**Ordered ops (DO NOT REORDER):**
- **STEP 0 — baseline.** `node apps/functions/scripts/audit-sendblue-routing.mjs --json`; save per-number distribution + active-reachable count as pre-state snapshot.
- **STEP 1 — dry-run backfill.** Confirm eligible ≈ active-reachable and 100% map to the single current number.
- **STEP 2 — apply backfill.** `backfill-sendblue-binding.mjs --apply`; assert `newly-pinned + already-pinned === eligible`, `unroutable === 0`.
- **STEP 3 — deploy read-before-hash code** (E0–E6). Merge to main first, then `cd apps/functions && pnpm run deploy` (predeploy gate green; per memory `deploy_after_merge`). Verify a live scenario send to dev phone **+14243201960** and confirm `from_number === pinned senderNumber`. **Gate behind flag `paStickySenderBindEnabled`, canary dev-phone first** (per `canary_gate` rule).
- **STEP 4 — re-pin sweep.** Re-run `--apply` (idempotent) to pin any reachable users created during the STEP 2→3 window (still onto N=1).
- **STEP 5 — ADD the 2nd number.** Edit `pa-config/sendblue-pool`: append the number to a group `status:'active'` (or `'warmup'` first to HITL-gate). Wait >60s for the TTL cache. Existing pinned users keep `senderNumber` → **unmoved**; only unbound brand-new users consult the now-2-number pool (via capacity-fill).
- **STEP 6 — capacity steering (optional).** Set `newUserCap` on the old line / use the counter overlay so the new line absorbs new users.

**The ONLY way to break continuity is doing STEP 5 before STEP 2+3 complete** — which is exactly why the backfill + deploy gate the pool edit. Use `warmup` on the new line for HITL before it takes load.

---

## 6. Test / eval matrix

**Unit — new `resolve-bound-from-number.test.ts`:**
| # | Assert |
|---|---|
| U1 | read-bind reuse: `senderNumber` set → returns it, `pickFromNumber` **not called** (spy) |
| U2 | assign-on-miss: unset → picks, persists; second call reads persisted (no re-pick) |
| U3 | inbound-first: `inboundToNumber` is a valid active line → binds to THAT over any hash |
| U4 | capacity-fill: bumps `assignedNewUsers` counter exactly once, respects `requireNewUserCapacity`, excludes admin/internal/developer |
| U5 | transaction: two concurrent assigns for one uid converge to ONE number |
| U6 | QR no-double-count: existing QR binding → read-bind-first, no counter bump |
| U7 | paused-line policy: bound line `throttled`/`warmup` → HOLD; `paused`+removed → re-bind + audit |

**Keystone — sticky-across-growth (extend `pool.test.ts` / `pool-integration.test.ts`):**
- Bind 20 users over a 1-number pool → add number #2 → all 20 still resolve #1 unchanged; only new unbound users reach #2. **Control:** bare `pickFromNumber` over the same 20 reshuffles ~50%. Use `_resetPoolCache` / `_resetCountersCache` + `makeStore`.

**Call-site integration:**
- `sendblue-client`: explicit `fromNumber` **wins** over `userId` (E1 regression — the load-bearing assert); absent explicit → reads binding not hash.
- `transport`: read-receipt + typing return the bound number; fail-open to `undefined` on pool error.
- `send-reaction`: tapback rides the bound line for direct callers.

**Backfill / runbook (Layer 1 + 6 of the v2.0 eval system):**
- `verify-sendblue-binding-stable.mjs`: for every pinned user assert `resolveBoundFromNumber(now-2-number pool) === senderNumber` AND `=== preNumber` from STEP 0 snapshot. **Zero offenders** required. Re-run audit checks (stickiness / admin-isolation / coverage) — all PASS; per-number distribution for *existing* users unchanged. Save before/after JSON as the HITL audit artifact.

**Live smoke (per CLAUDE.md "verify by doing"):** send to dev phone +14243201960, paste the actual reply, confirm `from_number === pinned senderNumber` both pre- and post-STEP 5.

---

## 7. Sequenced action list

**P0 — make the binding authoritative (no behavior change until backfilled; safe under N=1)**
1. E0: add `resolveBoundFromNumber` + `pickLeastLoadedActive` (`pool.ts`); add 4 fields to `UserSchema` (`core-types/src/index.ts:187`); refactor `assignCandidateSenderNumber` to delegate.
2. E1 `sendblue-client.ts:143-157` — guard so explicit `fromNumber` is never clobbered; read binding (not hash) on the userId branch. **(the single most important line)**
3. E2 transport, E3 send-reaction, E4 orchestrator-deps — read-bind on all UX seams.
4. Unit U1–U7 + sticky-across-growth keystone + call-site integration; gate `paStickySenderBindEnabled` (default OFF).
5. **Adam decisions before coding:** D1 dead/removed line → keep vs re-pick (recommend **keep**; re-bind only on hard-removed/paused, never on growth); D2 `newUserCap` applies to first-touch only, replies bypass; D3 one-time idempotent backfill before #2 (dry-run, Adam-gated).

**P1 — backfill + first safe growth**
6. Write `backfill-sendblue-binding.mjs` (idempotent, dry-run default; reuse audit predicates).
7. Run STEP 0–4 of §5 (baseline → dry-run → apply → deploy P0 code behind flag, canary dev phone → re-pin sweep).
8. `verify-sendblue-binding-stable.mjs` + flip `paStickySenderBindEnabled` on after canary verify.
9. STEP 5: add number #2 (`warmup` first if HITL-gating) → wait >60s → re-run verify (zero offenders).

**P2 — capacity-aware steady state**
10. E5 openLayoff + E6 index non-QR provisional bind (close the text-only no-binding gap).
11. Wire `pickLeastLoadedActive` (counter overlay) as the mint path; reconcile QR pre-bind counter vs candidate-bind counter (no double-count); decrement on opt-out/delete.
12. STEP 6 capacity steering; emit `pa_audit_event` on every (re)bind → flywheel/HITL artifact (product rule 9).

---

**Key file:line anchors:** selector `apps/functions/src/sendblue/pool.ts:169-178`; counters `pool.ts:519-624`; binding read `apps/functions/src/sendblue/outbox.ts:505-516`; **clobber bug** `apps/functions/src/sendblue/sendblue-client.ts:143-157`; transport bypass `apps/functions/src/claire-agent/transport.ts:130-131`; reaction bypass `apps/functions/src/sendblue/send-reaction.ts:178-184`; existing binder `apps/functions/src/identity/candidate-sender-number.ts:35-56`; QR bind `apps/functions/src/index.ts:687-691`; non-QR no-binding gap `apps/functions/src/index.ts:915`; layoff mint `apps/functions/src/openLayoff.ts:301-321`; schema `packages/core-types/src/index.ts:187`.
