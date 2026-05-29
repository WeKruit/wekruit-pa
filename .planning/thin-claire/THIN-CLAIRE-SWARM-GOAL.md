# Thin Claire — Swarm-Team Rebuild `/goal`

Hand the fenced block below to a fresh Claude Code `/goal` run that can spawn a
swarm (parallel workstream agents). It rebuilds Claire as a THIN `@openai/agents`
agent — LLM + tools + memory + delivery reflexes + reducer-owned process flows —
replacing the ~12k LOC of regex routers + post-gen voice processing that the live
canary proved is half-built and brittle.

This goal is **receipt-driven and eval-first**: three runnable POCs
(`.planning/thin-claire/poc/`) already prove every layer is thin against a real
model with zero deploy. The swarm copies those POCs into production wiring; it
does not re-invent the design.

---

## Full context (read before spawning anything)

### How we got here (the honest history)
- Live `+1 424-320-1960` canary (2026-05-29) against the deployed 10k-LOC agentic
  path FAILED the core test: "done with pure SWE, only product" left
  `targetRoleFunction=["product_management","software_engineering"]` (added product,
  never removed SWE), `targetJobType=undefined` (full-time lost); the job-search turn
  hung at `owner_arbitrated` / `stage=llm running` and never replied; the saved-pref
  summary read the OLD `statedPreferences` store. Root causes in
  `.planning/LIVE-SMOKE-2026-05-29-CANARY-RECEIPT.md`.
- Diagnosis: the agent was built inside-out — a regex `decideConversationTurnOwner`
  routes BEFORE the LLM sees the turn; the LLM is a leaf; ~9,586 LOC of `voice/`
  post-processing rewrites its output (the "scratch that," welded-word bug lives
  there); preferences live in 3 unsynced stores. Every past bug got a deterministic
  patch instead of a prompt fix. The pile got more brittle, not better.
- OpenAI Agents SDK research (`.planning/thin-claire/poc/README.md` + this session's
  transcript) + three POCs proved: the SDK natively gives the loop, memory (`Session`),
  description-routed tools, guardrails, and a lifecycle reflex hook. The whole agent
  is low hundreds of LOC, not 12k.

### The locked architecture (from `.planning/AGENTIC-ARCHITECTURE.md`, still authoritative)
KEYSTONE: **Conversation layer (agent-driven HOW)** vs **Process layer
(deterministic config + reducer, WHAT-must-happen)**. The LLM only PROPOSES;
deterministic reducer code DECIDES every state transition. LLM=interviewer,
playbook=script/rubric, reducer=producer.

### The proof you must not regress (run these first to see GREEN)
```
source ~/.zshrc && nvm use 24
cd .planning/thin-claire/poc && ln -sf ../../../packages/agent-runtime/node_modules ./node_modules
node poc-v1-core.mjs           # core loop + avoid-SWE→drop-SWE
node poc-v2-delivery.mjs --eval # delivery 4/4
node poc-v3-full.mjs           # full agent 7/7
```
These are the executable spec. The production thin agent must pass the SAME
assertions with real backend wiring swapped in for the in-memory stubs.

---

```text
You are the lead of a SWARM rebuilding WeKruit's Claire as a THIN @openai/agents agent.

GOAL
Replace the ~12k LOC regex-router + post-gen-voice Claire with a thin agent:
LLM + description-routed tools + SDK Session memory + delivery reflexes +
reducer-owned onboarding/prescreen flows + guardrails. The three POCs in
.planning/thin-claire/poc/ are the proven, runnable spec — copy their design into
production wiring; do not redesign. Eval-first, flag-gated, legacy path retained
until thin is green; never delete a layer until a real-model eval proves the
prompt+tools self-do it.

PRIMARY SOURCES (read first, obey literally)
- .planning/thin-claire/poc/README.md + poc-v1-core.mjs + poc-v2-delivery.mjs + poc-v3-full.mjs
  ← the runnable spec. Every production tool/reducer mirrors a POC tool/reducer.
- .planning/AGENTIC-ARCHITECTURE.md  ← the locked 12 decisions + KEYSTONE.
- .planning/LIVE-SMOKE-2026-05-29-CANARY-RECEIPT.md  ← the 4 prod failures this must fix.
- .planning/AGENT-HARNESS-PRODUCTION-GAPS.md  ← the 8 ops-readiness gates for public traffic.
- CLAUDE.md (Node 24, deploy authority, "done = real proof", worktree rules), AGENTS.md, README.md.

NON-NEGOTIABLE INVARIANTS (the KEYSTONE; violating any = regression)
1. The LLM never controls a state transition. Tools let it PROPOSE (answer text,
   a judge score, a tool choice); deterministic REDUCER code DECIDES (next question,
   PASS/FAIL rollup, commit-once, dedup, out-of-order rejection).
2. ONE canonical store for matcher input: pa-users.tags, written ONLY via
   applyPartialUserTags / mergeUserTags. mem0 is enrich-only, never gates matching.
   The saved-preference summary MUST read pa-users.tags (not statedPreferences).
3. "only X" REPLACES the role set; "avoid Y / done with Y" writes negativeRoleFunction
   AND removes Y from the positive set (poc-v1 reducer). The matcher subtracts the
   negative axis (#269 chain already on main).
4. Single agent, dynamic mode in the system prompt by process state — NO sub-agent
   handoff for onboarding/prescreen (poc-v3 C3 proves interrupt+resume needs none).
   The candidate can ask anything mid-flow; answer it, state stays durable, resume the
   pending question.
5. Process integrity (prescreen must-ask question set, onboarding slots) is reducer-
   owned: the "next question" tool always returns the earliest pending item; the LLM
   cannot skip or self-declare PASS. Terminal (PASS/FAIL/PII/outbound) commits exactly
   once via idempotency key.
6. Voice/slang lives in the system prompt + few-shot, NOT in post-gen string
   processors. Keep ONE lightweight outputGuardrail for long-context voice-drift +
   the markdown/url normalizer. Delete the rest gated by eval.
7. Delivery: mark-read is a deterministic reflex (every inbound, pre-run); typing is
   an agent.on('agent_tool_start') reflex before slow tools; tapback/no-reply/status
   are LLM-decided tools — NOT a regex action arbiter.
8. Eval-first, no deploy needed to test: every workstream ships an in-process
   real-model eval (poc-v3 style: real gpt-5.4-nano + stub channel/db + assert
   side-effects + exit 0/1). A layer is not "done" until its eval is green AND it does
   not regress the POC assertions.

ARCHITECTURE TARGET (the thin agent, ~800-1200 LOC replacing ~12k)
  apps/functions/src/claire-agent/   (new home; onPaInbound/paMessageCoalescer call it)
    agent.ts        — new Agent({ instructions: <Claire prompt>, tools, inputGuardrails, outputGuardrails })
                      + agent.on('agent_tool_start', typingReflex)
    prompt.ts       — Claire persona + slang + delivery rules + mode directives (per process state)
    session.ts      — Firestore Session (5 methods: getSessionId/getItems/addItems/popItem/clearSession) over pa-messages
    tools/          — each execute = deterministic reducer wrapping an EXISTING backend module:
       set-matching-preferences.ts → applyPartialUserTags (only/avoid reducer, poc-v1)
       find-match.ts               → queryMatchingJobsV16 (reads post-reducer tags; returns counters)
       match-collab.ts             → MATCH_COLLAB_CONNECTOR
       remember.ts                 → mem0 add
       save-job-profile.ts         → existing connector
       set-daily-subscription.ts   → existing connector
       schedule-interview.ts       → SCHEDULE_INTERVIEW_CONNECTOR (dedup verdict)
       privacy.ts                  → export/delete/stop (+ PII-website-lock: no chat PII write)
       cv-parse.ts                 → parse-resume / cv-summary
       react-to-user / send-status-then-continue / no-reply  (delivery, poc-v2)
       ask-next-onboarding / record-onboarding-answer        (onboarding FSM, poc-v3)
       ask-next-prescreen / score-prescreen-answer / explain-prescreen-outcome (prescreen FSM + LLM judge, poc-v3)
    reducers/       — pure deterministic state machines (NO LLM):
       onboarding-fsm.ts  — slots from shared-onboarding config; order-enforcing; complete-once
       prescreen-fsm.ts   — questions+rubric from pa-jobs config; score rollup→PASS/FAIL; commit-once; idempotent
       candidate-job-state.ts — prospect→…→passed; terminal idempotency keys
       matching-profile-reducer.ts — only/avoid/replace → canonical tags (poc-v1)
    delivery.ts     — mark-read reflex + typing reflex wiring (poc-v2)
    guardrails.ts   — inputGuardrail (crisis/injection via pa-safety) + outputGuardrail (voice-drift) + normalizer
    transport.ts    — Sendblue send/typing/mark-read/tapback (wrap existing send-imessage + add mark-read)
    compaction.ts   — reuse existing mem0 compaction for long-context (not in POC; required)

DELETE (gated by eval proving the thin path covers it; legacy stays flag-OFF until then)
  decideConversationTurnOwner (8-regex) · conversation-action-arbiter · handleCompletedUserJobSearchRequest
  + peer hand-wired handlers (handleDurablePreferenceUpdateTurn, handleExplicitExplanationTurn,
  handleSharedOnboarding* , handlePrescreenOutcomeExplainerTurn, handleLifecycleProfileReply,
  detect*/parse*/is* intent regexes) · ~9,586 LOC voice/ post-processing EXCEPT output-normalizer
  and one voice-drift outputGuardrail.

KEEP (verified deterministic, wire as tools/session/reducers — do NOT rewrite)
  Sendblue transport + coalescer + identity-merge (candidate-inbound-resolve) ·
  queryMatchingJobsV16 + #269 negativeRoleFunction chain · applyPartialUserTags/mergeUserTags ·
  mem0 + compaction · prescreen rubric/screening-evaluation · pa-jobs prescreen config ·
  the eval harnesses (process-intact-runner, real-seam-gate, bfcl-runner) — extend, don't drop.

SWARM WORKSTREAMS (disjoint write scope; spawn in waves; each ends with its own green eval)
  Wave 0 (lead, inline): scaffold apps/functions/src/claire-agent/ skeleton + Firestore Session +
     copy poc-v3 eval into apps/eval/thin-claire/ as the regression contract. Land the skeleton so
     workstreams have stable imports.
  Wave A (parallel):
     WS-tools     — implement tools/ wrapping the KEEP backend modules. Eval: each tool execute does
                    the real write/read against a Firestore emulator OR injected stub; avoid/replace
                    reducer matches poc-v1; find-match returns counters; schedule dedups.
     WS-delivery  — mark-read + typing reflex + react/no-reply/status tools wired to transport.ts.
                    Eval: poc-v2 4/4 against the real Sendblue client in dry-run (no real send).
     WS-process   — onboarding-fsm + prescreen-fsm reducers + their tools + LLM-judge scoring.
                    Eval: poc-v3 C/C2/C3 (all-asked, no-skip, commit-once, flex resume, idempotent).
     WS-guardrail — inputGuardrail (pa-safety crisis/injection) + outputGuardrail voice-drift + normalizer.
                    Eval: poc-v3 D + injection corpus; voice-drift flags long-context regressions.
     WS-proactive — OUTBOUND-INITIATED turns (not user-triggered). Claire proactively sends:
                    post-match retention (after recs sent), daily job-rec batch push, proactive
                    follow-ups. SAME agent + tools; the trigger is a cron/event, not an inbound msg.
                    Wrap existing post-match-retention.ts + proactive-turn.ts + the daily batch CF as
                    a `runProactiveTurn(userId, kind)` entry that builds the same Agent with a proactive
                    system-prompt directive and emits via the same delivery tools (status/text, dedup,
                    idempotency so a retry never double-sends). multi-bubble split = prompt instruction
                    ("split into ≤2 short bubbles") or repeated send_message, NOT probabilistic-split.ts.
                    Eval: L3 side-effect — a proactive trigger produces exactly one outbound (idempotent),
                    respects opt-out/cooldown, and dedups already-sent jobs.
  Wave B (lead): prompt.ts (persona+slang+delivery+mode directives) + agent.ts assembly +
     onPaInbound/paMessageCoalescer cutover behind paThinClaireEnabled (default OFF).
     Full real-model eval: the deployed-handler two-turn canary (avoid-SWE turn THEN recommend turn)
     asserting extractor-equivalent tag mutation + job-search completes + saved-pref reads tags.
  Wave C (lead): flag-gated canary on +1 424-320-1960 (allowlist already set), live verify with the
     computer-use test prompt (in this session's transcript), backend pairing via verify-smoke.mjs,
     then ramp. Legacy path deleted only after thin is green in prod for the canary cohort.

PER-WORKSTREAM CONTRACT
  - Own a disjoint directory; no two workstreams write the same file.
  - Deliver: code + the eval layers below that apply to it, run + output pasted.
  - Node 24. Real key from .env (PA_OPENAI_AGENT_API_KEY). No deploy to test — evals are in-process.

EVAL STACK — replaces unit-test suites entirely (research-backed: Anthropic "Demystifying
Evals for AI Agents", BFCL v3, Sierra τ-bench/τ²-bench, LangChain agentevals). Unit tests do
NOT meaningfully evaluate an agent; these six layers do. CI blocks on L1-L4 + L3-outcome;
judges/online are advisory and never break the build.

  L1  Reducer/schema code-asserts        [BLOCKING · offline/CI every PR]
      Pure deterministic asserts on the reducers: tag canonicalization, identity merge,
      candidate + candidate×job state transitions, only/avoid/replace tag math (poc-v1),
      single-commit idempotency. No LLM. (This is the ONLY "unit-like" layer and it tests
      the deterministic reducers, not the agent's words.)
  L2  Trajectory / tool-choice           [BLOCKING · offline/CI]
      agentevals createTrajectoryMatchEvaluator (TS-native) in strict/subset mode: did Claire
      call the right tools with right args, in the right order, AND abstain when no tool applies
      (BFCL irrelevance). Reference trajectories per scenario; deterministic, no model call at grade time.
  L3  Side-effect / outcome              [BLOCKING on outcome · offline, real model, sampled]
      The poc-v3-style harness: real gpt-5.4-nano + an ISOLATED stub DB/channel per trial; assert
      the ENVIRONMENT end-state, not the transcript (Anthropic outcome>transcript). e.g. pa-users.tags
      == expected (SWE removed, negativeRoleFunction set, full_time), tool-call ledger row exists,
      terminal committed exactly once, proactive trigger emits exactly one outbound. Run pass^k
      (all k repeats pass) for the core flows. This is the load-bearing layer.
  L4  Process-adherence / policy          [BLOCKING · offline/CI]
      Deterministic state-machine asserts on the typed event ledger (NOT a judge): all required
      prescreen questions covered + never skipped, terminal PASS/FAIL committed once, no terminal
      without a preceding rubric-pass event, onboarding slots all filled in order. (poc-v3 C/C2.)
  L5  Simulated-user multi-turn           [outcome-blocking · offline nightly, real model, sampled]
      τ-bench-style: an LLM user-simulator (scenario / expected_outcome / user_description) converses
      with Claire ≥10 turns; graded on FINAL tag/DB state + required-info coverage, not wording.
      Catches long-context goal/context drift. DeepEval ConversationSimulator shape or hand-rolled.
  L6  Judge quality + online              [ADVISORY only · offline + online/prod]
      ConversationalGEval / G-Eval for voice/humanization/answer-first — multi-judge, order-swapped,
      human-calibrated; NEVER a hard gate (non-deterministic, position+self-preference bias). Plus
      online scoring of sampled live traffic (Langfuse/Braintrust) for drift + real candidate outcomes
      (prescreen-completion rate, reply rate).

  Also keep green (do not drop): the 3 POC evals (design spec) + the existing
  apps/eval/conversation-experience/{process-intact-runner,real-seam-gate,bfcl-runner}.mjs.
  Deployed-handler two-turn canary (flag-ON) is the L3 integration instance on the real handler.

DEPLOY / DONE (CLAUDE.md: done = real proof)
  - Merge to main; deploy minimum scope functions:pa-orchestrator:onPaInbound,paMessageCoalescer.
  - Flip paThinClaireEnabled for the 424 canary only; run the live test sequence; paste
    pa-turn-traces(completed) + pa-tool-calls(snapshot reflects new tags) + pa-users.tags(SWE removed,
    negativeRoleFunction set, full_time) + pa-outbound(DELIVERED) + the iMessage transcript.
  - Done = thin agent passes the live 424 canary (avoid-SWE→drop-SWE, no hang, reads tags) AND the
    L1-L5 eval layers are green AND legacy path retired for the cohort. Not done from any single layer
    alone — the live outcome + L3 side-effect + L4 policy are the real bar.

ASK ADAM ONLY FOR: product behavior not in the docs; deploy approval for prod-Claire; destructive
  migration; live outbound beyond the 424 canary; re-litigating an architecture invariant.
DO NOT ASK FOR: fixture names, helper names, whether to run the evals (always run them).

SELF-REVIEW (end of every workstream AND final — write into the workstream SUMMARY + surface in chat):
  [ ] KEYSTONE held — every state transition is reducer code; the LLM only proposed. Cite the reducer.
  [ ] No deterministic logic deleted that was load-bearing (process integrity / commit / safety / idempotency).
  [ ] Added behavior as a tool/reducer, not a new regex branch.
  [ ] Eval layers that apply (L1-L6) run + pasted; L1-L4 + L3-outcome green; POC evals not regressed.
  [ ] Voice came from prompt+few-shot, not a new post-processor (only normalizer + 1 voice-drift guardrail kept).
  [ ] Delivery: mark-read/typing reflexes + tapback/no-reply/status tools (no regex arbiter).
  [ ] Single agent, no handoff; mid-flow interrupt answered + pending resumes (cite the flex eval).
  [ ] LOC delta toward the ~12k→~1k collapse.
  Honest gaps: what the prompt+tools still can't do that forced deterministic code to stay.

START: Wave 0 — scaffold claire-agent/ + Firestore Session + copy poc-v3 eval into apps/eval/thin-claire/.
Run the three POC evals first to confirm the green baseline before writing production code.
```
