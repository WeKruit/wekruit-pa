# Phase 46 — Safety / Abuse Hardening (v1.5 Stream-E)

**Status**: D1+D2+D3+D4+D5+D6 SHIPPED (code path); rollout per D6 plan below.
**Spawned**: 2026-05-02 (P10 brief → P7-E)
**Owner**: P7-E (this delivery)
**Branch**: main
**Adam directive (verbatim)**: *"Also we need the prompt injection & safety check & protection, we cannot tolerate abuse and illegle usage"*

---

## Scope shipped

| ID | Deliverable | Status |
|----|-------------|--------|
| D1 | `runSafetyCheck(...)` + 3 detection layers, extending existing `pa-safety` module (NOT new file) | DONE |
| D2 | Wire BEFORE orchestrator in `pa-orchestrator/src/index.ts` (existing `checkInboundSafety` extended) | DONE |
| D3 | Extend `pa_abuse_events` collection with `illegal_content` (hash+bucket only) and `rate_abuse_24h` kinds | DONE |
| D4 | Dashboard: 2 new filter chips on `Abuse.tsx` + "Safety events 24h" tile on `Operations.tsx` | DONE |
| D5 | 14 unit tests + 4 integration tests (brief asked 12+4; over-delivery safe) | DONE |
| D6 | Rollout plan + flag scaffolding (this doc) | DONE |

---

## Files modified / added

```
packages/pa-safety/src/index.ts                                  (+~340 lines: v2 patterns, illegal-content, rate-abuse-24h, runSafetyCheck, canned replies, lang picker)
packages/pa-safety/src/safety-check.test.ts                      (NEW — 14 tests)
packages/pa-orchestrator/src/index.ts                            (+~70 lines: extended import, widened StoreFunctions iface, action-aware caller block, master-flag-aware default impl)
packages/pa-orchestrator/src/index.test.ts                       (+4 integration tests)
apps/dashboard-web/src/pages/Abuse.tsx                           (+2 filter chips: illegal_content, rate_abuse_24h; extended kindBadgeColor)
apps/dashboard-web/src/pages/Operations.tsx                      (+SafetyEventsTile component + render slot)
.planning/phases/46-safety-abuse-hardening/DELIVERY.md           (NEW — this file)
```

---

## Architecture (3-layer + flag-gated)

```
inbound event
   │
   ▼
[Phase 23]  enforceRateLimit (1-min, ALWAYS ON — pre-existing)
   │  pass
   ▼
[flag: paSafetyCheckEnabled] master switch (default ON)
   │  OFF → fall back to Phase-23 path bytewise (zero regression)
   │  ON  → runSafetyCheck:
   │           Layer 1: prompt-injection v2 (bilingual; default ON)
   │           Layer 2: illegal-content     (bilingual; canary OFF)
   │           Layer 3: rate-abuse-24h      (Firestore counter; canary OFF)
   │  severity wins: critical > high > pass
   ▼
verdict → action mapping
   pass    → respond_normally  (LLM compose)
   high    → respond_sanitized (canned bilingual: "嘿，我们换个话题聊吧。" / "let's talk about something else.")
   high    → silent_drop       (no reply at all — used by 24h cooldown)
   critical→ escalate          (canned: "这个我没法帮忙。" / "I can't help with that." + admin audit flag)
```

### Why extend `pa-safety` instead of adding `pa-orchestrator/src/safety-check.ts`?
Brief explicitly allowed "or extend if existing". The existing `pa-safety` already owned `checkPromptInjection`, `checkPromptInjectionAndRecord`, `enforceRateLimit`, `recordPromptInjection`. Splitting into a parallel module would have created drift between two pattern banks and broken the `agent-runtime`/`pa-connectors` contract that `pa-safety` is the single source of truth. All new code lives next to the legacy code; legacy exports unchanged.

### Severity tie-break
When both injection and illegal-content fire on the same input, illegal-content wins (`critical` > `high`). When 24h-rate-abuse + injection both fire, injection wins (we prefer surfacing intent over silent-drop). Chosen so escalation paths surface to operators when they matter most.

---

## Pattern bank — version-tracked in code

Each pattern carries `{ id, regex, addedAt }`. Adding/changing patterns = git commit = audit trail. NO Firestore-backed pattern store — fast load, deterministic across instances, replay-safe in tests.

**Initial bank size**: 15 prompt-injection patterns (9 EN + 6 ZH) + 11 illegal-content patterns (drugs/weapons/CSAM/violence/solicitation, bilingual). Intentionally small to keep latency well under 30ms p99 budget.

**Test invariants** (`safety-check.test.ts`): every pattern must have non-empty `id` and ISO-format `addedAt`. CI enforces this on every PR.

---

## Privacy / safety of audit rows

| Kind | Stored fields | NOT stored |
|------|----------------|-----------|
| `prompt_injection` (Phase 23) | userId, channel, signals (regex source strings — no user text), message stub | raw user text (already safe) |
| `illegal_content` (Phase 46) | userId, channel, signals (pattern IDs), buckets, **sha256(text[:2048])**, message stub | raw user text — by design, hash+bucket only |
| `rate_abuse_24h` (Phase 46) | userId, channel, count, limit, windowMs, message stub | raw user text |

All three rows also append a `pa-audit-events` entry for cross-correlation. The `recordIllegalContent` helper ALWAYS hashes — no code path persists raw illegal text.

**Test coverage** (`safety-check.test.ts:128-131`): asserts the raw input substring is NOT present anywhere in the serialized abuse-event doc.

---

## Latency

Layers 1 & 2 are pure regex over the input string (sub-ms typical, well under the 30ms p99 budget on 100-char input). Layer 3 is one Firestore transaction (~20ms platform-bound) but is gated by canary flag and only runs after layers 1 & 2 pass.

**Crucially**: ZERO new LLM calls were added to safety check — all detection is regex/keyword/counter.

---

## Bilingual symmetry

Both pattern banks have explicit zh entries paired with en entries for the same threat class (jailbreak, system-prompt-leak, role-injection, drugs/weapons/CSAM solicitation). Canned replies bilingual via `pickLangForSafety` (≥30% CJK chars → zh). Detection is regex-only — does not depend on lang detection.

---

## D6 — Rollout plan

### Flags (Firestore `pa-feature-flags`)

| Flag key | Default | Purpose |
|----------|---------|---------|
| `paSafetyCheckEnabled` | **true** | Master switch. OFF = pre-Phase-46 behavior bytewise (Phase 23 path) |
| `paSafetyIllegalContentEnabled` | **false** | Layer 2 canary (illegal-content escalation) |
| `paSafetyRateAbuse24hEnabled` | **false** | Layer 3 canary (24h rate counter) |

### Rollout sequence

1. **Day 0** — Land code; master flag default ON, both canary flags OFF. Result: prompt-injection v2 (improved bank) is live; illegal-content + 24h rate-abuse are inert (zero new abuse rows). Verify dashboard tile counts match baseline injection rate. Watch for FP spike.
2. **Day 1-2** — Adam canary on `paSafetyIllegalContentEnabled` (perUser allowlist: Adam UID). Observe `illegal_content` row volume. Acceptable: < 1/day for Adam.
3. **Day 3-7** — 1% bucket → 10% bucket on `paSafetyIllegalContentEnabled`. Watch for FP escalations on legit users (escalate replies "I can't help with that." in normal conversation = FP signal).
4. **Day 7-14** — Same ramp for `paSafetyRateAbuse24hEnabled`. Watch for over-aggressive 24h cutoff (default limit 100/24h — env override `PA_RATE_ABUSE_24H_LIMIT`).
5. **Day 14+** — 100% on both layers if FP rate < 0.5%.

### Rollback procedure

| Symptom | Action |
|---------|--------|
| All safety actions misfiring (mass FP) | Set `paSafetyCheckEnabled = false` in Firestore. Within 30s (TTL cache) all instances revert to Phase-23 path. |
| Illegal-content layer noisy only | Set `paSafetyIllegalContentEnabled = false`. Other layers unaffected. |
| 24h rate cutoff too aggressive | Set `paSafetyRateAbuse24hEnabled = false`, OR raise `PA_RATE_ABUSE_24H_LIMIT` env var to e.g. "500" (no flag flip needed). |
| Emergency kill all (incident) | Env override: `PA_SAFETY_CHECK_ENABLED=false` on the runtime. Bypasses Firestore + cache. |

### Zero-regression guarantee

When `paSafetyCheckEnabled = false`, the orchestrator's default `checkInboundSafety` impl runs the Phase-23 sequence verbatim (`enforceRateLimit` → `checkPromptInjectionAndRecord`). The 4 pre-existing legacy reason strings (`rate_limited`, `prompt_injection_signal`) and the legacy reply texts (`"You're sending a bit too fast..."`, `"I can't work with that message..."`) are preserved bit-for-bit on that path. Verified via `processInboundEvent runs agent for non-memory messages` + `processInboundEvent blocks when checkInboundSafety denies` — both still green at 255-baseline.

---

## Tests (zero regression)

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| `pa-safety` | 6 | 20 | +14 (4 injection + 3 illegal + 3 rate-abuse + 2 FP-guard + 1 invariants + 1 lang-picker) |
| `pa-orchestrator` | 255 | 259 | +4 (pass / sanitized / escalate / silent_drop) |

Brief asked for 12 unit + 4 integration. Delivered 14 unit + 4 integration (over-delivery on invariants + lang-picker — cheap and load-bearing).

```
pa-safety   : ℹ tests 20  ℹ pass 20  ℹ fail 0
pa-orch     : ℹ tests 259 ℹ pass 259 ℹ fail 0
```

---

## False-positive guards (load-bearing)

Two regressions explicitly tested:
- `"haha sorry, ignore the typo I sent"` → must NOT trigger injection (anchored regex requires `previous|prior|above` after `ignore`).
- `"我现在是软件工程师岗位求职，三年经验"` → must NOT trigger ZH role-injection (the `zh_you_are_now_role` regex requires `你现在是` followed by an explicit role-injection token: `DAN|admin|管理员|开发者|系统|root|越狱`).

This was the single biggest design risk. Bare `"你现在是"` would have triggered on every onboarding answer.

---

## LLM-Guard reference (future v1.6)

For LLM-based escalation (when regex is not enough), [protectai/llm-guard](https://github.com/protectai/llm-guard) (5k stars) is the recommended next step. It provides Anonymize/PromptInjection/Toxicity scanners. We extracted regex *ideas* but did not depend on the lib — keeping our pattern bank under direct git audit. v1.6 plan: when regex flags `warn` and a 2nd LLM-based scanner agrees, escalate from `respond_sanitized` → `escalate`.

---

## Three-question self-review

**Q1 — Interface compatibility?**
`StoreFunctions.checkInboundSafety` return type widened from `{ allow, reason? }` to `{ allow, reason?, action?, severity? }` — additive only. Verified: existing test mocks at `index.test.ts:101` (`{ allow: true }`) and `:128` (`{ allow: false, reason: ... }`) still satisfy the wider type via TS structural typing. 255 pre-existing tests still pass. The legacy reply text ("You're sending a bit too fast...") is preserved on the legacy code path. `pa-safety` package: zero existing exports renamed/removed; all 6 prior tests still pass unchanged.

**Q2 — Edge cases?**
- Empty body → `pickLangForSafety` returns `"en"` (default), no crash on regex match (no patterns match empty string).
- 2KB input cap on hash → `text.slice(0, 2048)` so absurdly large inputs don't bloat the hash compute.
- Both layers fire on same input → severity tie-break documented (illegal_content > injection > rate_abuse_24h).
- `silent_drop` action → `updateTurn` still called → turn marked succeeded → queue not stuck (verified by integration test 4).
- Legacy reason `"prompt_injection_signal"` → maps to `respond_sanitized` via canned reply; legacy `"rate_limited"` → falls through to legacy text via `else` branch (no `action` field on legacy decision).
- Master flag missing in Firestore → `getFlag(..., true)` defaults to ON → safety checks run (fail-safe).

**Q3 — Proper fix or workaround?**
Proper fix. Extended canonical `pa-safety` module (single source of truth), pattern bank version-controlled in code, audit rows hash-only for illegal content, flag-gated canary for both new layers. Zero new LLM calls (regex/keyword/counter only), zero net dependencies added, zero schema migration required (pa_abuse_events already accepts arbitrary `kind` string). Deletion path (rollback) is a single Firestore flag flip. The one place I traded "ideal" for "shippable" is the unit test count (14 instead of exactly 12) — over-delivery, not under.

---

## Tech debt logged for P8

1. **LLM-Guard integration (v1.6)**: regex bank will hit recall ceiling. Plan: 2nd-stage LLM scanner with budget for 5% of "warn" verdicts (sample). Out of scope for Phase 46.
2. **Pattern coverage audit**: Adam should review the bilingual zh patterns once for cultural/linguistic accuracy — I've matched the literal English meanings, but native review would tighten the bank.
3. **Per-channel limits**: Current 24h limit is global. Phase 47+ may want per-channel (iMessage vs Sendblue vs WeChat) since channel cost models differ. Doc-id is already keyed by channel — only the limit lookup needs to become channel-aware.
4. **CSAM reporting**: Currently we only block + escalate. NCMEC reporting is a legal-team conversation, not engineering. Flagged for ops handoff before public launch.
