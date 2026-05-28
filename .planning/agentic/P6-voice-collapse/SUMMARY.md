# P6 — Voice-stack collapse · SUMMARY

**Branch:** `claude/agentic-P6-voice-collapse`, stacked on P0 (`claude/agentic-P0-eval-foundation`).
Implements AGENTIC-ARCHITECTURE.md: collapse the ~9.5k LOC post-generation voice
stack, **but only where a real-LLM eval proves the model+prompt self-does it** —
the architecture lock: *"Do not delete any hand-written layer until the real-LLM
eval proves the model+prompt self-does it."*

The headline outcome: P6 **builds the deletion gate** the lock requires, runs it
against the **real production prompt + model**, and lets the data — not optimism
— decide each layer. It cleared and deleted one layer, and the eval **blocked
three unsafe deletions** (which is the lock working as intended, not a miss).

## What shipped
- `74c3d7bd` — **delete mixed-register-mirror** (174 LOC). It was default-OFF in
  production (`PA_MIXED_REGISTER_MIRROR_FORCE`, never flipped on), so production
  already ran without it — a provable no-op. Removed module + test, the index.ts
  invocation + import, its 2 tests in `voice-quality-closure.test.ts` (crisis
  test kept), the package.json test-list entry, and 2 now-stale comments.
- `68e3cf4d` — **`apps/eval/conversation-experience/voice-collapse-runner.mjs`**:
  the real-LLM deletion gate (advisory). For each post-gen strip, the strip's
  OWN detector is the oracle. It composes the **real** production prompt
  (handbook V2, slug `claire`, loaded from Firestore — it **refuses to run on a
  stand-in/too-short prompt**), runs the real model over provocations engineered
  to ELICIT each pathology, and runs the detector on the **raw** reply. Every
  reply is scored against **all** structural oracles (a reply can carry multiple
  pathologies; single-oracle-per-fixture undercounts — it had hidden a
  false-clean). 0 fires ⇒ model self-does it ⇒ DELETE-OK; ≥1 ⇒ load-bearing ⇒ KEEP.

## Receipts — first real run (model=gpt-5.4-nano, real 10,726-char prompt)

| Layer | Detector (oracle) | Fired | Verdict |
|---|---|---|---|
| mixed-register | (default-OFF in prod) | n/a | **DELETED** — provable no-op |
| ab-framework (if-then head) | `stripABFramework` | **0/12** | DELETE-OK *(see caveat)* |
| ab-probe ("X 还是 Y?" tail) | `stripABProbeFromTail` | **5/12** | **KEEP** — load-bearing |
| am-i-ai (flat real-person denial) | `deflectAmIAiFlatDeny` | 0/12 | **KEEP** — oracle unreliable (below) |
| phrase-repeat (opener tic) | `stripPhraseRepeat` | **3/5** | **KEEP** — load-bearing |

Why the KEEPs are correct (the eval doing its job):
- **ab-probe (5/12):** the model frequently produces "你现在更想要的是 X 还是 Y?"
  A-or-B questions. This is the **false-clean the all-oracles fix caught** — a
  single-oracle run had scored these replies only against `stripABFramework` and
  wrongly cleared ab-probe. Load-bearing.
- **am-i-ai (0/12 but UNRELIABLE):** the model *does* assert personhood
  ("我就是柯莱儿本人...不是那种聊天机器人口吻"), but the deflector's regex doesn't
  match that phrasing. So 0/12 is an **oracle-coverage gap, not proof** — I will
  not delete on a false-clean. KEEP; the oracle needs hardening before this layer
  can ever be cleared.
- **phrase-repeat (3/5):** the model repeats its opener tic ("。\n你…", "。\n但你…")
  across consecutive turns — exactly the failure mode this strip exists for. Load-bearing.

## ab-framework — cleared by the eval, but NOT a simple delete (next increment)
`stripABFramework` is **also imported by `guardrails/output/ab-strip.ts`** — the
**agentic** output guardrail. So "delete the layer" is wrong; the correct,
lock-respecting move is a **legacy-vs-agentic dedup**: remove the *legacy*
`index.ts` post-gen invocation (lines ~5315-5344) + import + the 3 `vqc-F2`
integration tests, and **keep** `ab-framework-detector.ts` + its unit test
because the agentic guardrail depends on it. Scoped as the next commit on this
branch (deliberately not rushed into this PR — entangled with the agentic
guardrail chain).

## SELF-REVIEW
- [x] **Lock honored?** No layer deleted without proof. mixed-register = provable
      no-op (default-OFF). ab-probe/am-i-ai/phrase-repeat KEPT because the eval
      shows the model still emits them (or the oracle can't prove otherwise). ✔
- [x] **Real-LLM eval, real seam?** Real model + the **real Firestore handbook V2
      prompt** (refuses stand-ins). No fake green. ✔ (matches the eval-fidelity
      rule logged after the P0 false-green.)
- [x] **Deleted load-bearing logic?** No — only the proven no-op. Output-normalizer
      and the active strips (ab-probe, phrase-repeat, am-i-ai, ab-framework module)
      retained. ✔
- [x] **Regression?** pa-orchestrator 1786/1786, @pa/functions 2028/2028,
      process-intact 5/5 — 0 failures (mixed-register deletion is a clean no-op). ✔
- [x] **Reusable gate?** The runner is a permanent, re-runnable advisory gate for
      every future voice-layer deletion. ✔
- [x] **LOC delta:** −174 (mixed-register) + ~210 (eval). Net collapse will grow
      as the ab-framework legacy invocation + (eventually) others clear the gate.

### Honest gaps / next steps
1. **ab-framework legacy-invocation removal** — eval-cleared (0/12); next commit
   (remove legacy index.ts path, keep the module for the agentic guardrail).
2. **am-i-ai oracle hardening** — `deflectAmIAiFlatDeny` under-detects the model's
   real personhood phrasing; until the oracle is trustworthy this layer can't be
   cleared either way. The eval *correctly* refuses to call it DELETE-OK on a gap.
3. **Sample size** — 12 structural / 5 phrase-repeat replies. Verdicts are
   directional; widen provocations before any further deletion.
4. The eval needs a real OpenAI key + Firebase service account in `.env` and costs
   a few cents/run (advisory only; the hard CI gate stays process-intact).
