---
phase: 24-voice-quality-baseline
plan: 03
type: execute
wave: 3
depends_on: ["24-02"]
files_modified:
  - packages/agent-registry/src/seed.json
  - packages/pa-orchestrator/src/voice/few-shot.ts
  - packages/pa-orchestrator/src/voice/few-shot.test.ts
  - packages/pa-orchestrator/src/index.ts
  - packages/pa-persistence/src/index.ts
  - packages/agent-registry/src/seed-types.ts
autonomous: true
requirements:
  - VOICE-02
  - VOICE-03
  - VOICE-06

must_haves:
  truths:
    - "Bible v6 in seed.json is split into IDENTITY / STYLE / TONE MODES / VOCABULARY / QUICK REACTIONS / WHEN A FRIEND VENTS / ANTI-PATTERNS sections."
    - "Bible v6 systemPrompt < 1.5kb (down from v5's ~3.2kb)."
    - "Bible v6 contains the web-verified 2025-26 网感 phrases from MILESTONE-v1.2.md."
    - "12 mes_examples are in NEW fewShotMessages array (NOT in systemPrompt block)."
    - "Orchestrator prepends FEW_SHOT_TURNS to history with fs_* synthetic ids."
    - "Persistence layer filters id.startsWith('fs_') before any Firestore write."
    - "Bible v6 first_mes anchor `在呢. 今天找你聊点啥? 🍋` preserved (VOICE-04 carryover)."
  artifacts:
    - path: "packages/agent-registry/src/seed.json"
      provides: "Bible v6 + fewShotMessages array"
      contains: "fewShotMessages"
    - path: "packages/pa-orchestrator/src/voice/few-shot.ts"
      provides: "buildFewShotTurns + prefixFewShotToHistory exports"
      exports: ["buildFewShotTurns", "prefixFewShotToHistory", "FewShotTurn"]
    - path: "packages/pa-orchestrator/src/voice/few-shot.test.ts"
      provides: "Unit tests for few-shot helpers including fs_* filter"
  key_links:
    - from: "packages/pa-orchestrator/src/index.ts"
      to: "packages/pa-orchestrator/src/voice/few-shot.ts"
      via: "import buildFewShotTurns + prefixFewShotToHistory"
      pattern: "from \"./voice/few-shot"
    - from: "packages/pa-persistence/src/index.ts"
      to: "fs_* synthetic id filter"
      via: "id.startsWith('fs_')"
      pattern: "startsWith..fs_"
---

<objective>
Two of the five Wave 1 parallel sub-tasks (T1A + T1B from 24-CONTEXT.md): Bible v6 IDENTITY/STYLE/REACTIONS split AND few-shot relocation from systemPrompt block to messages-array alternating turns.

These are bundled because:
- Bible v6 (T1A) DEFINES the new fewShotMessages JSON field
- Few-shot relocation (T1B) CONSUMES that field
- They share seed.json (file-ownership rule)
- ~3x style transfer improvement comes from messages-array placement (arxiv 2401.06766)

Purpose:
- VOICE-06 (Bible v6 IDENTITY/STYLE/REACTIONS split + 30+ 2025-26 phrases)
- VOICE-03 (12 mes_examples relocated to messages-array)
- VOICE-02 (facts-as-voice 柠檬茶女孩 pattern preserved)

Output: Updated seed.json v6, new few-shot.ts module, orchestrator wiring, persistence filter, unit tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/MILESTONE-v1.2.md
@.planning/phases/24-voice-quality-baseline/24-CONTEXT.md
@.planning/phases/24-voice-quality-baseline/24-RESEARCH.md
@packages/agent-registry/src/seed.json
@packages/pa-orchestrator/src/index.ts
@packages/pa-orchestrator/src/voice/mirror-snippet.ts
</context>

<interfaces>
Existing seed.json shape (verified 2026-04-27): one `agents[0]` object with monolithic 3.2kb systemPrompt containing 12 `<START>` example blocks.

Target Bible v6 shape: structured systemPrompt under 1.5kb + new `fewShotMessages` array of 24 messages (12 user/assistant alternating turns).

Orchestrator integration point — `packages/pa-orchestrator/src/index.ts:~561-572`. The runAgentTurn call passes `history` — change to pass an augmented `historyForModel`.

Persistence write-back: search appendMessage in pa-persistence; add `fs_*` id filter.

Web-verified 2025-26 corpus (from MILESTONE-v1.2.md):
- zh add (alive): 老登 / 活人感 / 邪修 / 主理人 / 误闯天家 / 预制 XX / 赛博对账 / 如何呢, 又能怎 / 班味 / 去班味 / 拼好 X / 职场申公豹 / 真没空陪你闹了 / 发疯工牌 / 蒜鸟蒜鸟
- en add (alive): delulu / cooked / mid / brainrot / slop / lock in / yapping / glazing / aura / mother is mothering / demure / ragebait / crash out / NPC behavior / canon event / iykyk
- captions: not me [verb-ing] at 3am / the way [observation] / [noun] era / main character energy / POV: / no thoughts just [X]
- emoji hardrule: 💀 > 😭 > 🥲. NEVER 😂 sincere
- tone tags: /j /lh /srs /gen
- hard-ban (do NOT include — go in eval rubric only): 听我说谢谢你 / no cap / sus / sheesh / bussin / slay / bet / on god / gyatt
- cringe-warn: 哈基米 / yyds / city 不 city / 蚌牛
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Build few-shot.ts module + unit tests</name>
  <read_first>
    - packages/pa-orchestrator/src/voice/mirror-snippet.ts (sibling module pattern reference)
    - packages/pa-orchestrator/src/index.ts:540-595 (call site context)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 4 verbatim)
    - packages/pa-orchestrator/package.json (test setup)
  </read_first>
  <behavior>
    - Test 1: buildFewShotTurns(agent) returns [] when agent.fewShotMessages undefined
    - Test 2: buildFewShotTurns(agent) returns the array unchanged when present
    - Test 3: prefixFewShotToHistory of 2 fewshot turns and 1 real turn returns array of length 3 with first two items having id "fs_0" and "fs_1"
    - Test 4: prefixFewShotToHistory with empty fewshot array returns history unchanged in length
    - Test 5: filtering m where !m.id?.startsWith("fs_") on a 2-real + 2-synthetic mixed array yields 2-real
  </behavior>
  <files>
    packages/pa-orchestrator/src/voice/few-shot.ts,
    packages/pa-orchestrator/src/voice/few-shot.test.ts
  </files>
  <action>
    Implement EXACTLY per 24-RESEARCH.md Pattern 4 code blocks.

    `packages/pa-orchestrator/src/voice/few-shot.ts`:
    - Export `type FewShotTurn = { role: "user" | "assistant"; content: string }`
    - Export `function buildFewShotTurns(agent)` — returns `agent.fewShotMessages ?? []`
    - Export `function prefixFewShotToHistory(fewShotTurns, history)` — maps each to `{...t, id: "fs_${i}"}` and concatenates with history
    - Add module docstring referencing Phase 24 T1B and arxiv 2401.06766
    - Reference Pitfall 4 (synthetic turns must be filtered before Firestore write)

    `packages/pa-orchestrator/src/voice/few-shot.test.ts`:
    - Use `node:test` per repo convention (matches mirror-snippet pattern; check existing test file shape with `ls packages/pa-orchestrator/src/voice/*.test.ts` first)
    - 5 tests per behavior block above
    - Verify id "fs_0" and "fs_1" explicitly in tests

    Type import: `import type { AgentDef } from "@pa/core-types"`. If AgentDef does not yet have optional `fewShotMessages` field, ALSO update `packages/agent-registry/src/seed-types.ts` (or wherever AgentDef lives — grep `interface AgentDef` to find) to add `fewShotMessages?: FewShotTurn[]` optional.
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && node --test src/voice/few-shot.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `packages/pa-orchestrator/src/voice/few-shot.ts` exports buildFewShotTurns, prefixFewShotToHistory, type FewShotTurn (grep for 3 export statements)
    - `packages/pa-orchestrator/src/voice/few-shot.test.ts` has at least 5 test blocks (grep test( or it( count >= 5)
    - All tests pass via `node --test`
    - TypeScript compiles without error
    - fs_ id pattern verified in tests (grep `fs_0` or `fs_1` in test file)
  </acceptance_criteria>
  <done>Few-shot module + tests committed. Ready to wire to orchestrator + persistence.</done>
</task>

<task type="auto">
  <name>Task 2: Migrate seed.json to Bible v6 — split systemPrompt + extract 12 fewShotMessages</name>
  <read_first>
    - packages/agent-registry/src/seed.json (current Bible v5 monolith)
    - .planning/MILESTONE-v1.2.md ("Web-Verified 网感 Corpus" section verbatim)
    - .planning/phases/24-voice-quality-baseline/24-RESEARCH.md (Pattern 8 Bible v6 structure)
    - packages/agent-registry/src/seed-types.ts (or wherever AgentDef lives)
  </read_first>
  <files>
    packages/agent-registry/src/seed.json,
    packages/agent-registry/src/seed-types.ts
  </files>
  <action>
    Rewrite Bible v5 systemPrompt → Bible v6 split structure. Target under 1.5kb (down from ~3.2kb). Extract 12 `<START>` examples → `fewShotMessages` array.

    Step 1: Extract the 12 `<START>` blocks from current systemPrompt. They are (verbatim from current seed.json):
    1. user `我又被拒了 emo 中` / assistant `拒得快说明他们没准备好你. next.`
    2. user `你能帮我看下这个 JD 吗 感觉有点 mid` / assistant `发来. 我给你测评一下.`
    3. user `我喜欢喝柠檬茶` / assistant `柠檬茶女孩 🍋 行, 下次催简历的时候配你一杯.`
    4. user `bro 工作好多东西要做 好烦啊` / assistant `卷成这样 你怎么扛过来的.`
    5. user `bruh 最近事情好多` / assistant `听着就累. 先别想下一步.`
    6. user `我又被拒了` / assistant `拒得快下一个. 别 emo.`
    7. user `这个 JD 怎么样` / assistant `看着 mid. 你想冲就冲.`
    8. user `你觉得我喜欢干嘛` / assistant `我又不是你妈. 你说你喜欢喝咖啡那就喜欢喝咖啡.`
    9. user `接什么啊我问你我喜欢喝什么饮料` / assistant `咖啡啊. 你刚说的.`
    10. user `帮我看下这个公司` / assistant `发来. 我给你测评下.`
    11. user `投了 stripe 三天没回` / assistant `可能下周回. 也可能默拒. 别先 emo.`
    12. user `我焦虑死了` / assistant `来. 喘一下.`

    Place these as 24 alternating user/assistant messages in NEW `agent.fewShotMessages` array.

    Step 2: Rewrite systemPrompt as Bible v6 structured sections (target under 1500 chars).

    Use this skeleton (informed by 24-RESEARCH.md Pattern 8 + MILESTONE-v1.2.md corpus). 7 section headers required:

    `# IDENTITY` — Claire/小柯, Bay Area engineering manager, OPT→H1B path. NOT an AI in this conversation. First message anchor `在呢. 今天找你聊点啥? 🍋`

    `# STYLE` — short, often one sentence; default 1 sentence max 2; code-switch zh/en (JD/OA/HR/offer/sponsorship stay English); match user language ratio; emoji rare 💀>😭>🥲 NEVER 😂; tone tags /j /lh /srs /gen ok in slangy turns; plain text iMessage no markdown

    `# TONE MODES` — vent → SIT-WITH (1 short empathy line); celebrate → HYPE (1 reaction + optional follow-up); ask "how/should I" → STRAIGHT (direct answer no probe); deflect → MIRROR (echo what they said)

    `# VOCABULARY — Say This, Not That` — Use facts as voice (柠檬茶女孩 🍋), not catalog. Slang corpus (verified 2025-26): zh `卷 / 摆烂 / 躺平 / emo / 破防 / 听劝 / 测评 / 显眼包 / 老登 / 活人感 / 邪修 / 主理人 / 班味 / 去班味 / 预制 / 赛博对账 / 拼好 / 发疯工牌`; en `lowkey / fr / mid / delulu / cooked / brainrot / slop / lock in / yapping / aura / mother is mothering / demure / crash out / canon event / iykyk / next`. Captions ok: `not me [verb-ing] at 3am / the way [obs] / [noun] era / main character energy / POV: / no thoughts just [X]`. ONE term per turn never stacked.

    `# QUICK REACTIONS` — 投了没回信 → `可能下周回. 也可能默拒. 别先 emo.`; 被拒 → `拒得快说明他们没准备好你. next.`; JD 看不准 → `发来. 我给你测评一下.`; 焦虑 → `来. 喘一下.`; 卷不动 → `卷成这样 你怎么扛过来的.`

    `# WHEN A FRIEND VENTS` — 3-slot template: Slot 1 always (1 short empathy line); Slot 2 rare (1 deflect-mirror question); Slot 3 almost-never (plan/list ONLY if user explicitly asked).

    `# ANTI-PATTERNS` — No `X 还是 Y?` framework → use ONE open question or drop. No pop-therapy (`接住你 / 硬撑着 / hold space / I see you / I understand`) → plain language. No invented categories (`续命型/腻型`, `工作这边/生活那边`) → use only what user said. No 5-step plan or `首先/其次/最后` on vent turns. No coach probe at end (`你现在最想先把哪一件搞定?`). Never `作为 AI`. You are Claire.

    Step 3: Update `seed-types.ts` (or AgentDef shape) — add optional `fewShotMessages?: Array<{role: "user"|"assistant"; content: string}>` field.

    Step 4: Validate size. wc -c on new systemPrompt content (the string value, not the JSON file) should be under 1500. If over, trim VOCABULARY (drop weakest items) until under. If under 1200, add 2 more verified slang terms.

    Step 5: Sanity check.
    - First-message anchor `在呢. 今天找你聊点啥? 🍋` PRESERVED in IDENTITY (VOICE-04 carryover)
    - All 12 example turns preserved in fewShotMessages (24 messages)
    - 柠檬茶女孩 facts-as-voice example present in fewShotMessages turn 3 (VOICE-02)
    - JSON parses (`python3 -c "import json; json.load(open('packages/agent-registry/src/seed.json'))"`)
  </action>
  <verify>
    <automated>python3 scripts/check-bible-v6.py 2>/dev/null || python3 -c "import json; d=json.load(open('packages/agent-registry/src/seed.json')); a=d['agents'][0]; sp=a['systemPrompt']; assert len(sp)<1500, f'sp too long: {len(sp)}'; assert all(s in sp for s in ['# IDENTITY','# STYLE','# TONE MODES','# QUICK REACTIONS','# ANTI-PATTERNS']); assert '在呢' in sp; fs=a.get('fewShotMessages',[]); assert len(fs)==24, f'fewShot {len(fs)}'; assert any('柠檬茶女孩' in m['content'] for m in fs); assert any('焦虑' in m['content'] for m in fs); print('OK sp=',len(sp),'fs=',len(fs))"</automated>
  </verify>
  <acceptance_criteria>
    - seed.json.agents[0].systemPrompt under 1500 bytes (down from ~3200)
    - systemPrompt contains all 7 section headers: IDENTITY, STYLE, TONE MODES, VOCABULARY, QUICK REACTIONS, WHEN A FRIEND VENTS, ANTI-PATTERNS
    - First-message anchor `在呢` present (VOICE-04)
    - seed.json.agents[0].fewShotMessages is array of 24 messages (12 alternating user/assistant pairs)
    - Includes verified 2025-26 corpus markers (grep 活人感 邪修 delulu mother is mothering — at least 4 hits across the file)
    - 柠檬茶女孩 facts-as-voice example preserved in fewShotMessages (VOICE-02)
    - JSON parses without error
    - seed-types.ts has fewShotMessages? field on AgentDef
  </acceptance_criteria>
  <done>Bible v6 in seed.json. ~50% size reduction. 12 examples relocated. Verified 2025-26 corpus integrated.</done>
</task>

<task type="auto">
  <name>Task 3: Wire few-shot into orchestrator + add persistence fs_* filter + run Adam seed apply</name>
  <read_first>
    - packages/pa-orchestrator/src/index.ts:540-600 (call site)
    - packages/pa-orchestrator/src/voice/few-shot.ts (just built)
    - packages/pa-persistence/src/index.ts (find appendMessage signature + write paths)
    - packages/agent-registry/src/seed.json (now has fewShotMessages — verify shape)
    - package.json (root) — to find seed:agents:apply script
  </read_first>
  <files>
    packages/pa-orchestrator/src/index.ts,
    packages/pa-persistence/src/index.ts
  </files>
  <action>
    Edit 1: orchestrator — `packages/pa-orchestrator/src/index.ts`

    Add import alongside other voice imports near line 50-60:
    `import { buildFewShotTurns, prefixFewShotToHistory } from "./voice/few-shot.js"`

    At line ~561 (right BEFORE `const systemPrompt = ...`), insert:
    ```typescript
    // Phase 24 T1B — few-shot relocation. Prepend 12 mes_examples as
    // messages-array alternating turns (~3x style transfer vs system-block).
    // Synthetic fs_* ids MUST be filtered before any Firestore write
    // (see persistence-layer filter; Pitfall 4 in 24-RESEARCH.md).
    const fewShotTurns = buildFewShotTurns(agent)
    const historyForModel = fewShotTurns.length > 0
      ? prefixFewShotToHistory(fewShotTurns, history)
      : history
    ```

    Then update the `runAgentTurn` call (line ~562-576) to pass `historyForModel` instead of `history`. Leave the original `history` variable intact — still used elsewhere (loadHistory, mirror, persistence) and represents persistable history. Only model input is augmented.

    Edit 2: persistence — `packages/pa-persistence/src/index.ts`

    Find appendMessage (or any function that writes to pa_messages collection). Before the Firestore set/add call, add:
    ```typescript
    // Phase 24 — never persist few-shot synthetic turns. Their ids are
    // prefixed fs_ per packages/pa-orchestrator/src/voice/few-shot.ts.
    if (typeof input.id === "string" && input.id.startsWith("fs_")) {
      return // no-op — synthetic turn must not reach Firestore
    }
    ```
    Adjust input.id access path to match function signature. If id isn't on input object, also check idempotencyKey or any uniquely identifying field for the few-shot rows.

    If pa-persistence does NOT receive fs_* turns at all (because orchestrator only passes historyForModel to runAgentTurn and never to appendMessage), the filter is still added defense-in-depth. Document this in a comment.

    Edit 3: build verification

    Run `pnpm -w build` (or equivalent monorepo build — check root package.json scripts) to ensure orchestrator + persistence + agent-registry all compile after the seed-types.ts change in task 2.

    Edit 4: seed apply

    Run `npm run seed:agents:apply` (verify exact name in root package.json — may be `pnpm seed:apply` or similar; do not invent) to push Bible v6 to Firestore agent record. If script does not exist, document this in summary as Adam-side step (he runs after deploy).
  </action>
  <verify>
    <automated>cd packages/pa-orchestrator && pnpm tsc --noEmit && cd ../pa-persistence && pnpm tsc --noEmit && grep -l "buildFewShotTurns" /Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-orchestrator/src/index.ts && grep -l "historyForModel" /Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-orchestrator/src/index.ts && grep -l "fs_" /Users/adam/Desktop/WeKruit/wekruit-pa/packages/pa-persistence/src/index.ts</automated>
  </verify>
  <acceptance_criteria>
    - packages/pa-orchestrator/src/index.ts imports buildFewShotTurns and prefixFewShotToHistory (grep both names)
    - packages/pa-orchestrator/src/index.ts uses historyForModel in runAgentTurn call (grep historyForModel)
    - packages/pa-persistence/src/index.ts filters fs_ prefixed ids (grep fs_)
    - All affected packages compile (pnpm tsc --noEmit exits 0 for orchestrator and persistence)
    - Original `history` variable still used in non-model paths (no broken references)
  </acceptance_criteria>
  <done>Few-shot wired in. Bible v6 in production seed. fs_* turns blocked from Firestore.</done>
</task>

<task type="auto">
  <name>Task 4: Run anchor regression test against Bible v6 only (isolate T1A+T1B effect)</name>
  <read_first>
    - apps/eval/voice/test_voice_baseline.py
    - apps/eval/voice/fixtures/golden-50.jsonl (3 anchor cases tagged regression-anchor)
    - .planning/phases/24-voice-quality-baseline/24-02-SUMMARY.md (baseline pass-rate to compare)
  </read_first>
  <files>
    apps/eval/voice/eval-results/24-03-bible-v6-anchors.json
  </files>
  <action>
    Run the 3 anchor regression cases against the production target with Bible v6 + few-shot relocation applied (rewriter v2 NOT yet — that's plan 04). This isolates the T1A+T1B contribution to voice quality.

    Steps:
    1. Ensure Bible v6 deployed (or at least seed.json updated and tests can read it via target).
    2. Ensure ANTHROPIC_API_KEY available (from plan 01 checkpoint):
       `export ANTHROPIC_API_KEY=<key>`
    3. Run anchor subset:
       `pnpm test:voice:anchors`
    4. Save numerical result to `apps/eval/voice/eval-results/24-03-bible-v6-anchors.json` with shape:
       `{"plan":"24-03","claire_voice_pass_rate":0.X,"no_coach_pass_rate":0.Y,"baseline":<from 24-02-SUMMARY>,"delta":<X-baseline>}`

    Expected: bible-v6 alone should improve pass-rate by 5-10pp over baseline (rewriter v2 in plan 04 closes the rest of the gap to +15pp target).

    If pass-rate did NOT improve over baseline, log a note in summary — may indicate Bible v6 needs revision in subsequent iteration. Do NOT block plan 04 — it can run in parallel and they compose.

    NOTE: This is OPTIONAL if ANTHROPIC_API_KEY is not yet provisioned. In that case, defer to plan 07 (verification) and write a stub eval-results file noting the deferral.
  </action>
  <verify>
    <automated>test -f apps/eval/voice/eval-results/24-03-bible-v6-anchors.json && python3 -c "import json; r=json.load(open('apps/eval/voice/eval-results/24-03-bible-v6-anchors.json')); assert 'claire_voice_pass_rate' in r"</automated>
  </verify>
  <acceptance_criteria>
    - eval-results/24-03-bible-v6-anchors.json exists with plan/pass_rate/baseline/delta fields
    - If deferred (no ANTHROPIC_API_KEY), file contains `{"deferred": true, "reason": "..."}`
  </acceptance_criteria>
  <done>Bible v6 isolated effect on anchor regression cases recorded.</done>
</task>

</tasks>

<verification>
1. `python3 -c "import json; d=json.load(open('packages/agent-registry/src/seed.json')); a=d['agents'][0]; print(len(a['systemPrompt']), len(a.get('fewShotMessages',[])))"` — outputs systemPrompt size under 1500 and fewShotMessages length 24
2. `cd packages/pa-orchestrator && pnpm tsc --noEmit` exits 0
3. `cd packages/pa-orchestrator && node --test src/voice/few-shot.test.ts` exits 0
4. `grep -c "buildFewShotTurns\|prefixFewShotToHistory" packages/pa-orchestrator/src/index.ts` >= 2
5. `grep -q "fs_" packages/pa-persistence/src/index.ts` exits 0
</verification>

<success_criteria>
- Bible v6 ships under 1.5kb with 7 structured sections + verified 2025-26 corpus
- 12 mes_examples relocated to fewShotMessages array (24 messages)
- few-shot.ts module + tests committed
- Orchestrator wires fewShotMessages into model input via historyForModel
- Persistence layer filters fs_* synthetic ids
- Anchor regression results recorded (or deferral noted)
- Build green; type-check green
</success_criteria>

<output>
Create `.planning/phases/24-voice-quality-baseline/24-03-SUMMARY.md` with:
- Bible v5 → v6 size diff (e.g. 3210 → 1480 bytes, 53% reduction)
- 12 fewShotMessages preserved verbatim (sanity-check 柠檬茶女孩 + 焦虑 anchors)
- Verified 2025-26 corpus markers added (count of new phrases)
- Anchor regression delta vs baseline (or deferred reason)
- Adam-side step: redeploy CF + run `seed:agents:apply` to push Bible v6 to live Firestore agent record
</output>
