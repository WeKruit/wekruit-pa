---
phase: 19-adaptive-mirror
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/pa-orchestrator/src/voice/style-analyzer.ts
  - packages/pa-orchestrator/src/voice/style-analyzer.test.ts
  - packages/pa-orchestrator/src/voice/mirror-snippet.ts
  - packages/pa-orchestrator/src/voice/mirror-snippet.test.ts
  - packages/pa-orchestrator/src/voice/index.ts
  - packages/pa-orchestrator/src/index.ts
  - packages/memory/src/persona-card.ts
  - packages/memory/src/voice-style-preference.ts
  - packages/memory/src/voice-style-preference.test.ts
  - tests/scenarios/companion-voice-mirror.yaml
autonomous: false
requirements: [ADAPT-01, ADAPT-02, ADAPT-03, ADAPT-04, ADAPT-05]

must_haves:
  truths:
    - "Given 3-5 user turns, analyzer returns a deterministic StyleSnapshot with 5 features (register_score, zh_char_ratio, emoji_freq, avg_sentence_len, slang_hits)."
    - "When user is formal, mirror snippet describes a formal style and PA replies formally."
    - "When user becomes slangy mid-session, mirror snippet shifts and PA replies slangy on the very next turn."
    - "Long-term style preference is written to mem0 after a session and re-injected via persona card on the next session for the same user_id."
    - "Setting PA_VOICE_MIRROR_DISABLED=true causes orchestrator to skip analyzer + skip mirror snippet entirely; transcript is identical to Phase 18 static-voice output."
    - "Mirror snippet contains only positive framing (no 'don't', 'avoid', 'never') — verified by regex test."
  artifacts:
    - path: "packages/pa-orchestrator/src/voice/style-analyzer.ts"
      provides: "Pure-function style feature extraction from user turns"
      exports: ["analyzeUserStyle", "StyleSnapshot"]
    - path: "packages/pa-orchestrator/src/voice/mirror-snippet.ts"
      provides: "StyleSnapshot → positive-framing mirror snippet string"
      exports: ["buildMirrorSnippet"]
    - path: "packages/pa-orchestrator/src/voice/index.ts"
      provides: "Barrel export for voice module"
    - path: "packages/memory/src/voice-style-preference.ts"
      provides: "mem0 read/write helpers for long-term style preference"
      exports: ["readStylePreference", "writeStylePreference", "VoiceStylePreference"]
    - path: "tests/scenarios/companion-voice-mirror.yaml"
      provides: "E2E eval: turn 1 formal → PA formal; turn 3 slangy → PA slangy; mem0 preference shift recorded"
  key_links:
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/pa-orchestrator/src/voice/style-analyzer.ts"
      via: "analyzeUserStyle(lastNUserTurns) call before model dispatch"
      pattern: "analyzeUserStyle\\("
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/pa-orchestrator/src/voice/mirror-snippet.ts"
      via: "buildMirrorSnippet(snapshot) appended after Phase 18 voice reminder, before user turn"
      pattern: "buildMirrorSnippet\\("
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "process.env.PA_VOICE_MIRROR_DISABLED"
      via: "early-return guard before analyzer call"
      pattern: "PA_VOICE_MIRROR_DISABLED"
    - from: "packages/memory/src/persona-card.ts"
      to: "packages/memory/src/voice-style-preference.ts"
      via: "readStylePreference call inside persona card builder; appends 'voice preference' line if present"
      pattern: "readStylePreference\\("
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/memory/src/voice-style-preference.ts"
      via: "writeStylePreference(userId, snapshot) on session-end / drift threshold"
      pattern: "writeStylePreference\\("
---

<objective>
Build the per-turn Adaptive Mirror Layer on top of Phase 18 static voice. PA observes user style on the last 3-5 user turns and adapts register / language ratio / emoji frequency / sentence length per turn via a deterministic JS analyzer + positive-framing mirror snippet injected post-history. Long-term preferences accumulate in mem0 and re-inject via persona card extension next session. Kill switch falls back cleanly to Phase 18.

Purpose: Phase 18 makes Claire sound like Claire. Phase 19 makes Claire feel like she's talking to *you specifically*. This is the difference between "in-character" and "alive."

Output: New `voice/` module under pa-orchestrator (analyzer + mirror-snippet), mem0 preference helpers, persona card extension, kill-switch wiring, and an E2E eval scenario that asserts register-shift mid-session and mem0 preference write.

Hard dependency: Phase 18 must be shipped (post-history voice reminder injection point + slang lexicon must exist). Plan is written now; execution waits for Phase 18 SUMMARY.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/19-adaptive-mirror/19-CONTEXT.md
@.planning/phases/18-companion-voice-v1/CHARACTER-BIBLE-v1.md
@.planning/phases/17-pre-launch-hardening/17-RESEARCH-raw-artifacts.md

# Phase 18 SUMMARY must exist at execution time (hard dep)
@.planning/phases/18-companion-voice-v1/18-01-SUMMARY.md

# Direct codebase pointers
@packages/pa-orchestrator/src/index.ts
@packages/memory/src/persona-card.ts

<interfaces>
<!-- Contracts the executor must honor. -->

```typescript
// packages/pa-orchestrator/src/voice/style-analyzer.ts
export interface StyleSnapshot {
  register_score: number;     // 0=slangy, 1=formal
  zh_char_ratio: number;      // 0-1, share of CJK chars vs total chars
  emoji_freq: number;         // emojis per 100 non-whitespace chars
  avg_sentence_len: number;   // chars; sentences split on [。.!?！？\n]
  slang_hits: number;         // count of zh+en lexicon matches in window
  sample_size: number;        // number of user turns observed (1..5)
}

export function analyzeUserStyle(userTurns: string[]): StyleSnapshot;

// packages/pa-orchestrator/src/voice/mirror-snippet.ts
export function buildMirrorSnippet(s: StyleSnapshot): string | null;
// Returns null when sample_size === 0 (no user turns yet → skip injection).
// Output is POSITIVE FRAMING ONLY. Examples (final wording up to executor):
//   "User is currently formal — match: complete sentences, no slang, no emoji."
//   "User is currently slangy zh-en mix — match: short, code-switch natural, max 1 emoji."

// packages/memory/src/voice-style-preference.ts
export interface VoiceStylePreference {
  user_id: string;
  preferred_register: "formal" | "casual" | "slangy";
  zh_en_mix: "zh_dominant" | "en_dominant" | "balanced";
  emoji_tolerance: "none" | "sparse" | "expressive";
  updated_at: string;  // ISO
  observed_turns: number;
}

export function readStylePreference(userId: string): Promise<VoiceStylePreference | null>;
export function writeStylePreference(userId: string, snapshot: StyleSnapshot): Promise<void>;
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Build deterministic style analyzer + types (per D-01, D-02, D-05, D-08, D-10)</name>
  <files>packages/pa-orchestrator/src/voice/style-analyzer.ts, packages/pa-orchestrator/src/voice/style-analyzer.test.ts, packages/pa-orchestrator/src/voice/index.ts</files>
  <behavior>
    - Empty input → returns StyleSnapshot with sample_size=0 and zeroed metrics (no throw).
    - 1-5 user turns → window = all available; >5 → window = last 5.
    - Pure all-zh formal text ("您好，我想咨询一下面试流程") → zh_char_ratio ≈ 1.0, register_score ≥ 0.7, emoji_freq = 0, slang_hits = 0.
    - Mixed slangy zh-en ("lowkey emo了 fr fr 🍋") → register_score ≤ 0.3, slang_hits ≥ 2 (lowkey + emo了 + fr), emoji_freq > 0.
    - Pure-emoji turn ("🍋🍋🍋") → emoji_freq high, register_score very low.
    - Punctuation-only / whitespace turn → does not crash; contributes near-zero metrics.
    - Deterministic: same input twice → identical snapshot (no Date.now, no Math.random).
    - register_score formula documented in a top-of-file code comment (transparency for eval audit).
  </behavior>
  <action>
    Create `packages/pa-orchestrator/src/voice/style-analyzer.ts` exporting `StyleSnapshot` and `analyzeUserStyle`.

    Implementation per D-10 (5 features only — no more):
    1. **register_score**: weighted blend of (avg_sentence_len normalized, slang_hits inverse, emoji_freq inverse, punctuation density). Document weights in code comment.
    2. **zh_char_ratio**: count chars in `[一-鿿]` ÷ total non-whitespace chars.
    3. **emoji_freq**: count `\p{Extended_Pictographic}` ÷ (non-whitespace chars / 100).
    4. **avg_sentence_len**: total chars ÷ sentence count, where sentences split on `[。.!?！？\n]+`.
    5. **slang_hits**: lexicon match count against Phase 18 zh + en slang lexicon (VOICE-07). Import lexicon from Phase 18 module — DO NOT re-author it (D-08).

    Per D-05: window = `userTurns.slice(-5)`. Per D-02: NO model calls, pure JS.

    Create barrel `packages/pa-orchestrator/src/voice/index.ts` exporting both modules.

    Reference: D-01, D-02, D-05, D-08, D-10. Addresses ADAPT-01.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && npm test -- style-analyzer</automated>
  </verify>
  <done>analyzeUserStyle is deterministic, returns 5 documented features, handles empty/edge inputs, reuses Phase 18 lexicon, all unit tests pass.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Build positive-framing mirror snippet builder (per D-03, D-04)</name>
  <files>packages/pa-orchestrator/src/voice/mirror-snippet.ts, packages/pa-orchestrator/src/voice/mirror-snippet.test.ts</files>
  <behavior>
    - sample_size === 0 → returns null (caller should skip injection).
    - High register_score formal snapshot → snippet says "match: formal register, complete sentences" (positive framing).
    - Low register_score slangy snapshot → snippet says "match: short, code-switch natural, sparse emoji ok".
    - High zh_char_ratio (≥0.8) → snippet says "primary language: 中文".
    - High en ratio (zh_char_ratio ≤0.2) → snippet says "primary language: English".
    - Mixed (0.2-0.8) → snippet says "natural zh-en code-switch ok".
    - emoji_freq high → snippet says "emoji 1 per turn ok"; emoji_freq 0 → snippet says "no emoji".
    - **Negative-instruction regex test FAILS the build**: snippet MUST NOT contain `\b(don'?t|never|avoid|do not|不要|别|禁止|严禁)\b` — automated test asserts this on 20 generated snapshots.
  </behavior>
  <action>
    Create `packages/pa-orchestrator/src/voice/mirror-snippet.ts` exporting `buildMirrorSnippet(s: StyleSnapshot): string | null`.

    Per D-03: positive framing only. Build snippet from a small library of positive phrases keyed by feature buckets (e.g., `formal | casual | slangy` × `zh | en | mix` × `no_emoji | sparse_emoji | expressive`). Combine with an opening hint following the Meta AI pattern:

    > "User is currently using [observed style]. Match that — [positive descriptors]."

    Snippet target length: 30-80 tokens (small enough not to dilute Phase 18 voice reminder; large enough to carry signal).

    Per D-04: this snippet is consumed in Task 3 — it is injected POST-history, AFTER Phase 18 voice reminder, BEFORE user turn.

    Add explicit unit test that runs `buildMirrorSnippet` on 20 varied snapshots and regex-asserts NO negative phrases (per D-03). This test is load-bearing.

    Reference: D-03, D-04. Addresses ADAPT-02.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && npm test -- mirror-snippet</automated>
  </verify>
  <done>buildMirrorSnippet returns null on empty snapshot, returns positive-framing string for all bucket combinations, negative-instruction regex test passes on 20 sample snapshots.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Wire analyzer + mirror snippet + kill switch into orchestrator turn flow (per D-04, D-07)</name>
  <files>packages/pa-orchestrator/src/index.ts</files>
  <behavior>
    - Standard turn (PA_VOICE_MIRROR_DISABLED unset/false): orchestrator extracts last 3-5 user turns from transcript → analyzer → mirror snippet → injects after Phase 18 post-history voice reminder, before user's latest turn → model call.
    - PA_VOICE_MIRROR_DISABLED=true: orchestrator does NOT call analyzer, does NOT inject snippet. Transcript bytes match Phase 18 static-voice baseline exactly. (Snapshot test asserts this.)
    - Empty transcript / first user turn (sample_size=0 → snippet=null): orchestrator skips injection gracefully; no error, no empty-string injection.
    - Injection ordering test: assertion that the rendered prompt contains, in order: [system prompt] → [history] → [Phase 18 voice reminder marker] → [Phase 19 mirror snippet marker] → [latest user turn].
  </behavior>
  <action>
    Modify `packages/pa-orchestrator/src/index.ts` turn-construction path:

    1. Read `process.env.PA_VOICE_MIRROR_DISABLED` once at module top → boolean `MIRROR_DISABLED` (per D-07). Treat literal string `"true"` as disabled.
    2. In turn flow, AFTER Phase 18 post-history voice reminder is appended (find existing VOICE-05 anchor — should be marked in Phase 18 SUMMARY), insert:
       - If `MIRROR_DISABLED` → skip.
       - Else: extract last 5 user turns from transcript, call `analyzeUserStyle`, call `buildMirrorSnippet`. If snippet is non-null, append as a system-role message (or whatever role Phase 18 used for its voice reminder — match that pattern).
    3. Add structured log line `pa.voice.mirror.injected` with `{user_id, sample_size, register_score, zh_char_ratio}` for offline audit. Do NOT log raw user text.
    4. Per D-04: position is **after** Phase 18 reminder, **before** the latest user turn.

    Add orchestrator-level integration test that:
    - With kill switch ON: asserts no `analyzeUserStyle` call (mock) and rendered prompt has no mirror marker.
    - With kill switch OFF + 3 mock user turns: asserts injection ordering.

    Reference: D-04, D-07. Addresses ADAPT-02 (injection) + ADAPT-04 (kill switch).
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && npm test -- index</automated>
  </verify>
  <done>Orchestrator injects mirror snippet at correct position when enabled, fully bypasses when PA_VOICE_MIRROR_DISABLED=true, integration tests pass.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: mem0 long-term style preference + persona card extension (per D-06)</name>
  <files>packages/memory/src/voice-style-preference.ts, packages/memory/src/voice-style-preference.test.ts, packages/memory/src/persona-card.ts</files>
  <behavior>
    - `writeStylePreference(userId, snapshot)` derives `VoiceStylePreference` from snapshot (register_score → preferred_register bucket; zh_char_ratio → zh_en_mix bucket; emoji_freq → emoji_tolerance bucket) and persists to mem0 under user partition with namespace `voice_style_preference`.
    - Idempotent: writing same derived preference twice doesn't create duplicate entries.
    - Drift gate: if existing preference matches new derivation, write is a no-op (avoids mem0 churn — Claude's discretion D-noted in CONTEXT).
    - `readStylePreference(userId)` returns null if absent, returns parsed preference if present.
    - Persona card builder: when called for `userId` with an existing preference, the rendered persona card includes a single line: `voice preference: 用户偏 [register], [zh_en_mix], [emoji_tolerance]`. Phrased as a Tendera-style "facts as voice" line, NOT as a bullet spec (per Phase 18 VOICE-02 pattern).
    - When persona card is built for a user with no preference yet, output is byte-identical to pre-Phase-19 persona card (regression-safe).
  </behavior>
  <action>
    Create `packages/memory/src/voice-style-preference.ts` with:
    - `VoiceStylePreference` interface (per `<interfaces>` block above).
    - `readStylePreference(userId)` using existing mem0 helpers in `packages/memory/src/`.
    - `writeStylePreference(userId, snapshot)` with bucket derivation:
      - `preferred_register`: register_score ≥ 0.7 → "formal"; ≥ 0.4 → "casual"; else "slangy".
      - `zh_en_mix`: zh_char_ratio ≥ 0.7 → "zh_dominant"; ≤ 0.3 → "en_dominant"; else "balanced".
      - `emoji_tolerance`: emoji_freq = 0 → "none"; ≤ 1.5 → "sparse"; else "expressive".
    - Drift gate: read existing → if equal, no-op. Else write.

    Modify `packages/memory/src/persona-card.ts` to:
    - Accept (or already accept) `userId`.
    - Call `readStylePreference(userId)`.
    - If non-null: append a single voice-as-fact line to the persona card output, phrased per Tendera "facts as voice" pattern. Example: `用户跟 Claire 聊天偏 [register]，[mix description]，emoji [tolerance]。`
    - If null: leave card unchanged (regression safety).

    Per D-06: NO new Firestore collection. Reuse existing mem0 user partition + persona card.

    Reference: D-06. Addresses ADAPT-03.
  </action>
  <verify>
    <automated>cd packages/memory && npm test -- voice-style-preference persona-card</automated>
  </verify>
  <done>writeStylePreference is idempotent + drift-gated, readStylePreference returns null/preference, persona card extends with one voice-as-fact line when preference exists, regression-identical when absent.</done>
</task>

<task type="auto">
  <name>Task 5: Wire orchestrator session-end mem0 write + E2E mirror eval scenario (per D-09)</name>
  <files>packages/pa-orchestrator/src/index.ts, tests/scenarios/companion-voice-mirror.yaml</files>
  <action>
    **Part A — orchestrator wiring**: at session end (or per-turn with drift-gate; executor's choice — document in code comment why), call `writeStylePreference(userId, latestSnapshot)`. Skip when `PA_VOICE_MIRROR_DISABLED=true` (per D-07 — kill switch must also disable mem0 writes, otherwise rollback bleeds state).

    **Part B — E2E eval scenario** at `tests/scenarios/companion-voice-mirror.yaml`:
    - User: same `user_id`, fresh session, no prior style preference in mem0.
    - **Turn 1** — user formal zh: `"您好，请问我应该如何准备下周的技术面试？"` → assert PA reply matches Phase 18 voice eval rubric AND register_score of PA reply ≥ 0.6 (formal).
    - **Turn 2** — user mid-formal: bridge turn.
    - **Turn 3** — user slangy zh-en: `"lowkey emo了 fr，今天 OA 我直接 emo 了 🍋"` → assert PA reply register_score ≤ 0.4 (slangy), assert PA includes at least one slang from Phase 18 lexicon, assert at most 1 emoji.
    - **Post-session assertion**: `readStylePreference(user_id)` returns a preference reflecting the latest observed style (per D-09).
    - **Kill-switch variant**: same scenario with `PA_VOICE_MIRROR_DISABLED=true` → PA reply on turn 3 is byte-identical to Phase 18 static-voice baseline (register stays Phase-18 default), AND `readStylePreference(user_id)` returns null after the session.

    Reuse `tests/scenarios/runner.mjs` harness conventions. Reference Phase 18 voice rubric assertions (do not re-author).

    Reference: D-09. Addresses ADAPT-05.
  </action>
  <verify>
    <automated>node tests/scenarios/runner.mjs --scenario companion-voice-mirror</automated>
  </verify>
  <done>Scenario runs end-to-end. Turn 1 PA reply scores formal, turn 3 PA reply scores slangy with at least one lexicon slang. Post-session mem0 preference write verified. Kill-switch variant produces Phase 18-identical output and no mem0 write.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 6: Adam manual verification — does mirror feel alive, not animatronic?</name>
  <what-built>
    Phase 19 Adaptive Mirror Layer fully integrated:
    - Per-turn deterministic style analyzer (5 features) on last 3-5 user turns.
    - Positive-framing mirror snippet injected post-history, after Phase 18 voice reminder, before model call.
    - Long-term style preference accumulated in mem0 + re-injected via persona card extension.
    - Kill switch `PA_VOICE_MIRROR_DISABLED=true` falls back cleanly to Phase 18 static voice.
    - E2E eval scenario passes (turn 1 formal → PA formal; turn 3 slangy → PA slangy; mem0 records preference).
  </what-built>
  <how-to-verify>
    1. Open dashboard / start a real iMessage thread with PA (allowlisted test user).
    2. **Formal probe**: send `"您好，我想咨询一下海外硕士申请的时间线安排"`. Confirm Claire replies in formal-ish zh, ≤2 sentences, no slang, no emoji.
    3. **Slang probe** (3 turns later): send `"lowkey emo了，今天 OA 直接芭比Q"`. Confirm Claire mirrors — short, slang present (lowkey / fr / emo / 卷 / 躺 etc.), at most 1 🍋 / ☕.
    4. **Persistence probe**: `__PA_RESET__`. Start fresh session same user. Send neutral first turn `"在吗"`. Confirm reply leans toward the slangy register Claire learned in step 3 (preference re-injection working).
    5. **Kill switch probe**: set `PA_VOICE_MIRROR_DISABLED=true`, restart orchestrator, repeat steps 2-3. Confirm replies follow Phase 18 default code-switch policy regardless of user register (no mirroring).
    6. **Vibe check (load-bearing, qualitative)**: does it feel like Claire is *paying attention* to you, or like a thermostat? If thermostat-y, capture failing turn for next iteration. If alive, approve.

    Expected: steps 2-5 deterministic + measurable; step 6 is qualitative — Adam owns this judgment.
  </how-to-verify>
  <resume-signal>Type "approved" if mirror feels alive. If animatronic / over-mirroring / under-mirroring, paste failing turn(s) and describe.</resume-signal>
</task>

</tasks>

<verification>
- All unit tests green: `style-analyzer`, `mirror-snippet`, `voice-style-preference`, `persona-card`, orchestrator integration.
- Negative-instruction regex test passes on 20 generated snippets (D-03 enforcement).
- E2E scenario `companion-voice-mirror.yaml` passes both standard and kill-switch variants.
- Phase 18 baseline scenarios still pass unchanged (regression check — Phase 18 voice is untouched when mirror is disabled).
- Manual checkpoint approved by Adam.
</verification>

<success_criteria>
Maps 1:1 to ROADMAP Phase 19 success criteria:
1. Per-turn analyzer extracts 5 style features from last 3-5 user turns. → Task 1.
2. Dynamic mirror snippet injected post-history each turn. → Tasks 2 + 3.
3. Long-term style preferences accumulate in mem0; persona card re-injects next session. → Task 4.
4. `PA_VOICE_MIRROR_DISABLED=true` rollback flag honored. → Task 3 (skip path) + Task 5 (skip mem0 write).
5. E2E scenario: turn 1 formal → PA formal; turn 3 slangy → PA slangy; mem0 records preference shift. → Task 5.

All 5 ADAPT requirements addressed: ADAPT-01 (T1), ADAPT-02 (T2+T3), ADAPT-03 (T4), ADAPT-04 (T3+T5), ADAPT-05 (T5).
</success_criteria>

<output>
After completion, create `.planning/phases/19-adaptive-mirror/19-01-SUMMARY.md` documenting:
- Final register_score formula + weights chosen.
- Mirror snippet template wording shipped.
- mem0 namespace + bucket thresholds chosen.
- Whether mem0 writes are session-end or per-turn-drift-gated, and why.
- Manual verification observations from Task 6 (Adam vibe check verbatim).
- Any deferred follow-ups (candidate items for ADAPT-DRIFT P1).
</output>
