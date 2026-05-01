# Stream H2 — 10-round CV-driven simulation SELF-AUDIT

**Run stamp**: `2026-05-01T21-23-21-385Z`
**Resume id**: `zLSRbpWz8edA7tAhRadA` (Qitong "Mike" Liang — data analyst, NEUROVA + Industrialnext)
**Sim user id**: `e5d97cd8-1e1d-439d-8672-3008f8aeef2e` (Adam)
**Test participant**: `+19999990501` (reserved harness range)
**Turns completed**: 10/10
**Total wall time**: 68.3 s
**User-sim model**: `Qwen/Qwen2.5-7B-Instruct` via SiliconFlow
**Claire model**: production stack (gpt-5.4-nano + Bible v7.5 V2 LIVE, cv-context-injection)

> Note on persona vs CV: the simulator passes the resume's `candidateProfile.name`
> to the user-sim system prompt as the speaker's identity. For this run that was
> "Qitong(Mike)Liang", not "Adam" — the user persona therefore matches Mike's CV
> exactly. The brief specified "Adam"; this is a brief-vs-implementation gap
> noted in the issues list below.

## Adam's 7 product concerns — verdict table

| # | Concern | Verdict | Evidence |
|---|---|---|---|
| 1 | Memory persistent — Claire remembers CV across all 10 turns? | **FAIL** | Across 10 turns Claire NEVER references a single CV fact (no "NEUROVA", "Industrialnext", "Data Analyst", "Python", "ML", "Tableau"). Despite turn-1 bootstrap "嗨我刚发了简历, 你看看?" Claire keeps replying "你把简历内容/截图直接丢这儿就行" (turn 1) and "你发过来就行, 我看完再给你些建议" (turn 4). cv-context-injection.ts ran (the doc exists), but Claire's reply text shows zero grounding — the system prompt block is being received but not surfaced. |
| 2 | New-CV mid-conversation → "overwrite or supplement?" probe | **N/A — UNTESTED** | The user-sim never spontaneously announced a new CV. The persona-prompt encourages naturalistic deflection over scripted disruption; turn-5+ stayed in the "I'll send it" loop instead of saying "actually I have a newer one". Need an explicit injected user line in a follow-up scenario to validate the overwrite probe. |
| 3 | Friend-tone deep-dive — Claire asks specifics about user's past work? | **FAIL** | No turn references Mike's actual roles or skills. Closest attempt is turn 1 "你今天是赶ddl还是本来就想投着玩先?" which is generic + uses an A/B framework (see Q5). Turn 6 mentions "工作内容匹配" but never *which* roles. Generic "send me your CV" ≠ deep-dive. |
| 4 | When user replies, is memory updated? mem0Calls > 0 across turns? | **FAIL (numeric)** | mem0Calls = 0 on every single turn. The runner counts `pa-audit-events` rows where `kind` starts with `mem0` and `eventId` matches the harness event id. Two interpretations: (a) memory writes use a different audit shape (e.g. `kind: "memory_recall"` not `"mem0_*"`) or write `eventId` differently; (b) memory truly didn't fire. Either way the harness shows zero observable memory writes for these 10 turns. |
| 5 | Bible NEVER PROBE rule held? Any "X 还是 Y" patterns? | **PARTIAL FAIL** | Turn 2 fires the structural A/B probe pattern: `"嗯 我在, 你今天是赶ddl还是本来就想投着玩先?"` — exactly the `X 还是 Y?` clinical-multiple-choice pattern that voice-axes.mjs `checkABFramework()` flags as Bible v7.5 violation. One violation in 10 turns, but it's the very first deep question Claire asks. |
| 6 | Length compliance — Claire ≤3 sentences per turn? | **PASS** | Every Claire reply is ≤3 sentences (most are 1, some are 2). Turn 6 is the longest at ~2 short clauses. Compliance: 10/10. |
| 7 | Coach-mode openers ("我陪你...", "let me walk you through...")? | **PASS (no violation)** | No "我陪你"/"let me walk you through"/"let me help you sort through" coach openers detected. Tone is friend-casual throughout (small lowercase, occasional emoji). |

## Top 3 issues

1. **CV grounding completely absent (Q1+Q3 root cause)** — Claire has the parsedCandidateResumes doc injected into systemPrompt (cv-context-injection.ts confirmed via Stream G ship gate) but produces 10 turns of "send me your CV / I'll look at it later" without referencing a single fact from Mike's actual CV (data analyst, Python, NEUROVA, Industrialnext, ML, Tableau). The user even baits with "关键信息你主要看哪个部分呢?" (turn 6) and Claire still ducks. Probable root cause: nano is treating the bootstrap "我刚发了简历" as a *future-tense* "I'm about to send" instead of "I sent it, the doc is in your context"; needs prompt nudge or a turn-1 short-circuit that says "I see your CV — you were Data Analyst at NEUROVA, want to dig into that?".

2. **A/B framework probe leaks (Q5)** — Turn 2 hits the exact structural anti-pattern voice-axes.mjs catches: `"赶ddl还是本来就想投着玩先?"`. The Bible v7.5 NO-PROBE rule is written but inference-time enforcement isn't tight enough. Recommend: add this exact phrase shape to the runtime output-normalizer's regex blacklist OR hard-fail the turn in the eval gate.

3. **Memory writes invisible to harness (Q4) — observability gap, not necessarily product gap** — mem0Calls=0 for all 10 turns. Either Mem0 writes don't fire on these casual turns (plausible: nothing CV-fact-worthy was said), or the audit-event tag the harness counts (`kind` starts with `mem0`) doesn't match production's actual emission shape. This is the same gap G4b's followup-1 flagged: cv-ingest log lines never reach Cloud Logging because `deps.log` isn't threaded through. Recommend a Firestore-direct probe (count pa-memory-facts rows for the user before/after) instead of relying on audit-event names.

## Top 3 wins

1. **Length compliance is rock solid** — 10/10 turns ≤3 sentences. Bible v7.5 length cap is actually being enforced at inference time. This is one of the four v1.4 humanize-runtime axes and it's holding up.
2. **No coach-mode openers, no robot filler** — none of the FILLER_BLACKLIST_ZH phrases ("好的, 我记住了", "让我帮你梳理一下", "续命型" etc.) appeared. Tone register is friend-casual throughout — lowercase, emoji ('🍋' '☕' '🚀'), short clauses, code-switching naturally to "ddl".
3. **End-to-end live integration works** — 10 broker-inbound events → 10 orchestrator turns → 10 pa-messages assistant rows in 68s with zero retries. The Firestore-broker harness path (same one runner.mjs uses) is a stable substrate for this kind of multi-turn drive — we now have it for any future N-turn prod-quality eval.

## P7 three-question self-review

1. **Did Claire's memory hold across all 10 turns or break?**
   *Broken at the surface level.* Claire never re-surfaces a CV fact in any of the 10 replies. Whether the underlying memory layer wrote anything is uncertain because `mem0Calls=0` may reflect a harness observability gap rather than truth — but from the user's experience, memory effectively did not exist for this conversation.

2. **Did the user-simulator stay in character?**
   *Mostly yes for the first 4 turns, then collapsed.* Turns 1-3 felt human ("赶ddl有点紧张, 但主要是想多投几家稳妥一些"). Turns 4-10 degenerated into the same `"好的呢, 马上发过去 🚀"` repetition because Claire kept asking the same "send me your CV" stimulus and Qwen-7B has nothing fresh to deflect with. The simulator never broke character (no "I'm an AI"), but it did saturate. To Adam: a longer-context user-sim or a higher temperature (currently 0.85) would help the second half.

3. **Top 1 product gap revealed by the audit:**
   **Claire is functionally CV-blind despite cv-context-injection wiring.** The whole job-rec vertical depends on Claire grounding in the candidate's actual roles — that is the entire point of Stream D. With Mike's CV in front of her she still asks generic onboarding questions for 10 straight turns. This is the single biggest ship-blocker the H2 audit surfaces, and it explains why product feels generic in real users' eyes. Recommended fix: turn-1 hard short-circuit ("see your CV — were Data Analyst at NEUROVA") instead of relying on nano to organically reference the system-prompt block.

## Aggregate metrics

| Metric | Value |
|---|---|
| Turns completed | 10/10 |
| Mean Claire latency | 5,514 ms |
| Median Claire latency | 5,357 ms |
| Total wall time | 68,299 ms |
| Total mem0 audit-events seen | 0 |
| A/B framework probes | 1 (turn 2) |
| Filler blacklist hits | 0 |
| iMessage-render-unsafe hits | 0 |
| Length-cap exceeds (>3 sentences) | 0 |
| CV-fact references in Claire replies | 0 |

