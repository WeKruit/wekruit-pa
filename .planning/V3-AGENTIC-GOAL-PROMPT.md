# WeKruit Agentic Rebuild — `/goal` Prompt (V3)

Hand this whole fenced block to a fresh Claude Code CLI `/goal` run. It autonomously executes the agent-core-first rebuild defined in `.planning/AGENTIC-ARCHITECTURE.md`, starting from the eval foundation.

**Prerequisite:** PR #245 (extractor scalar→array coercion + real-LLM harness foundation) should be merged to `main` first — it is Phase 0's seed. If #245 is not yet merged, the run starts by rebasing its harness work onto a fresh branch rather than waiting.

**Worktree (explicit):** This goal does NOT run in the `canonical-reducer` worktree (that holds PR #245). Each phase creates its OWN fresh worktree off updated `main` at `.claude/worktrees/agentic-P<N>-<slug>` on branch `claude/agentic-P<N>-<slug>`. Never reuse a prior phase's branch/worktree.

```text
You are the single-point lead agent for WeKruit's agent-core-first rebuild.

Goal:
Autonomously execute the architecture in .planning/AGENTIC-ARCHITECTURE.md —
replacing the regex owner-arbiter + hand-wired handlers + ~9,586 LOC of post-gen
voice processing with an LLM-at-the-top loop (the @openai/agents SDK run loop
that already exists in packages/agent-runtime), where new capabilities are
connector-registry additions, not new code branches. Move behavior into model +
prompt + tools; keep deterministic code only where it is load-bearing (process
integrity, state commit, safety, idempotency). Do it eval-first, vertical-slice,
and never delete a hand-written layer until a real-LLM eval proves the
model+prompt self-does it.

PRIMARY SOURCE OF TRUTH (read first, obey literally):
- .planning/AGENTIC-ARCHITECTURE.md   ← the locked design; every decision is here
Supporting sources:
- CLAUDE.md  (deploy authority, Node 24, "done = real proof", worktree rules)
- AGENTS.md
- README.md  (Product Blueprint: Candidate Retention Marketplace)
- packages/pa-connectors/src/index.ts  (connectorRegistry, runConnector — the existing registry)
- packages/agent-runtime/src/openai-agents-adapter.ts  (the @openai/agents run loop)
- packages/pa-orchestrator/src/index.ts  (buildTurnTools @ ~4068; the regex pre-routers @ ~4280-4960 to demote)
- apps/eval/conversation-experience/  (the harness foundation: runner.mjs deterministic, llm-runner.mjs real-LLM)

NON-NEGOTIABLE ARCHITECTURE LOCKS (from AGENTIC-ARCHITECTURE.md — do not re-litigate):
0. KEYSTONE: Conversation layer (agent-driven HOW) vs Process layer (deterministic
   config+reducer, WHAT-must-happen). LLM=interviewer, playbook=script/rubric,
   reducer=producer. NEVER move process integrity into the LLM; NEVER leave
   conversation routing/narration in regex.
1. Single agent + dynamic mode-scoping (NOT handoffs). Write/action tools scoped by
   workSession.kind; read-context + answer/recall tools GLOBAL every turn (cross-
   process context bridging). agents-as-tools for bounded subtasks.
2. Two stores, never conflated: canonical tags (pa-users.tags, matcher's only input,
   reducer-written) + mem0 (Qdrant, enrich voice, side-effect, never gates matching).
3. mem0 leans side-effect: light auto-inject read, post-turn write.
4. connector.execute = reducer = state commit + dedup + policy gate + structured verdict.
5. Dedup is first-class: prescreen no-redo, job no-re-recommend, scheduling no-rebook.
   PII edited on website only (no chat write tool); preference editable in chat.
   Every dedup/lock/redirect/change is narrated to the user ("tell them").
6. Max-flexible interrupt + always resumable. The ONLY guard is terminal idempotency
   (PASS/FAIL/PII/outbound commit exactly once via idempotency key). Context bridges
   via global read context + durable pending-step re-surface. No conversational locks.
7. Interaction layer two tiers:
   - Reflex (deterministic, immediate, no LLM): mark-read on every inbound; typing
     indicator before EVERY outbound bubble; a reflex quick-ack from a small rotation
     pool ("sure, one sec") before a known-slow tool (option a, confirmed by Adam).
   - Expressive (LLM-decided tools): send_message, react_to_user(reaction),
     no-text+react (tapback only for low-info acks while processing), multi-bubble split.
8. Output normalizer KEPT (markdown/url strip). Questionable voice post-processing
   (phrase-repeat, ab-framework, mirror, probabilistic-split, am-i-ai-deflector) is
   eval-gated: delete only what eval proves the model+prompt+few-shot self-does.
9. Safety via @openai/agents inputGuardrails (crisis/injection/privacy-stop), NOT
   hand-written. Do not push voice logic into guardrails.
10. Eval-first. Two-layer eval gates every phase:
    - Process-intact eval (deterministic Firestore/FSM state-diff) = the hard gate (exit code).
    - Conversation-quality eval (real LLM + grader, BFCL-style incl. irrelevance/abstention
      + delivery) = advisory (non-deterministic; flags follow-ups, never blocks CI).
11. New capability = connector registry addition; heavy/external = MCP server.

BRANCH AND WORKTREE RULES (explicit):
1. Start every phase from updated `main`.
2. Branch: `claude/agentic-P<N>-<slug>`. Worktree: `.claude/worktrees/agentic-P<N>-<slug>`.
3. Do NOT reuse a prior phase's branch/worktree. Do NOT use the canonical-reducer worktree.
4. Before each phase:
   - source ~/.zshrc && nvm use 24
   - git -C <main checkout> fetch origin
   - git -C <main checkout> worktree add .claude/worktrees/agentic-P<N>-<slug> -b claude/agentic-P<N>-<slug> origin/main
   - cd .claude/worktrees/agentic-P<N>-<slug>
   - pnpm install ; pnpm -r build  (workspace deps must be built before typecheck/test)
5. If a worktree makes no changes, remove it.

PHASES (execute in order; each is its own PR, eval-gated):

P0 — Two-layer eval foundation.
  - Extend apps/eval/conversation-experience into the two-layer eval:
    * Process-intact: deterministic Firestore/FSM state-diff runner (generalize runner.mjs):
      assert all prescreen questions asked, FSM no-skip, terminal-commit-once, dedup fired,
      trigger fired correctly.
    * Conversation-quality: extend llm-runner.mjs (real gpt-5.4-nano + grader) into a
      BFCL-style suite — tool-choice correctness (AST: exact {name,args}), irrelevance/
      abstention (turns where the correct action is NO tool call), delivery decision
      (tapback vs text vs no-reply), answer-capture completeness, voice.
  - Author fixtures covering: job-search, durable-preference-then-search, mid-onboarding
    prescreen-history tangent (context bridging), low-info-ack-while-processing,
    no-match narration, prescreen full-question-set coverage.
  - Run BOTH against CURRENT code; record the baseline receipt (current abstention/voice/
    intact scores). This receipt is the contract every later phase must not regress.
  - Wire process-intact eval into firebase.json predeploy as a blocking gate (advisory
    LLM grader stays non-blocking).

P1 — Vertical slice: job-search through agent-core.
  - Let run(agent) drive job-search via the find-match connector. Delete the job_search
    branch of decideConversationTurnOwner + handleCompletedUserJobSearchRequest +
    FIND_MATCH_NARRATION templates for this path.
  - Rewrite find-match connector description as a Hermes-style routing boundary
    (WHAT + positive trigger verbatim phrases incl. Chinese + "Do NOT call when ...").
  - Keep the deterministic commit in execute (dedup already-recommended jobs, verdict,
    pa-tool-calls ledger, trace completion).
  - Eval gate: P0 suite green (no regression vs baseline); the stale-tag canary passes
    with a real model.

P2 — Interaction layer.
  - Tier 1 reflexes: mark-read (verify Sendblue endpoint first; if absent, typing-only +
    flag for Adam), typing-before-every-bubble, reflex quick-ack pool before slow tools.
  - Tier 2 tools: send_message, react_to_user, no-text+react, multi-bubble.
  - Delete conversation-action-arbiter delivery regex (isShortLowInformationAck etc).
  - Eval gate: delivery-decision fixtures green; choreography timeline (mark-read → tapback
    → quick-ack → typing → result) verified.

P3 — Prescreen migration.
  - Scoped prescreen agent: write-tools scoped (record_answer/advance_fsm), read-context +
    answer tools global. Reducer-FSM iterates the playbook question set deterministically.
  - Cross-process context bridging + durable pending-step re-surface. Terminal idempotency.
  - Eval gate: process-intact (all questions asked, no skip, PASS/FAIL once) + tangent
    fixture (mid-prescreen unrelated question answered, then resumes).

P4 — Onboarding migration. Same pattern as P3 for shared-onboarding slots.

P5 — Connector reducer hardening.
  - Every connector.execute returns the verdict shape. Dedup + policy gate
    (PreToolUse-style vocab/confidence validation) + PII-website-lock connector
    (pii_change_request returns portal link; no chat PII write). "Tell them" narration.

P6 — Voice stack collapse.
  - Delete questionable voice/ post-processing layer-by-layer; each deletion gated by the
    conversation-quality eval proving the prompt+few-shot self-does it. Keep output normalizer.

P7 — New-capability proof (the scaling property).
  - Add schedule-interview + sync-registration connectors as PURE registry additions
    (ConnectorDef + execute reducer + dedup + verdict + one line in allowedConnectors),
    with ZERO changes to the agent loop. This proves the architecture's scaling claim.

P8 — Safety guardrails.
  - Move crisis/injection/privacy-stop into @openai/agents inputGuardrails; retire the
    equivalent hand-written pre-filters. Voice stays in prompt.

REQUIRED PER-PHASE PROCESS:
1. Create .planning/agentic/P<N>-<slug>/ with CONTEXT.md, PLAN.md, EXECUTOR-PLANS.md,
   ACCEPTANCE.md, SUMMARY.md.
2. Before code, ask each executor for AGENT_PLAN only (format below). Assign by disjoint
   write scope.
3. Execute in waves: A schemas/reducers/fixtures/failing-tests → B connectors/tools →
   C interaction/delivery → D eval/harness → E cleanup/docs/acceptance.
4. Run BOTH eval layers + preserve regression: pnpm --filter pa-orchestrator test,
   pnpm --filter @pa/functions test, the process-intact eval, the real-LLM eval.
   Paste EXACT outputs in SUMMARY.md (counts, abstention score, intact assertions).
5. Land: PR against main with the eval receipts in the body. Per CLAUDE.md, if the change
   touches production Claire and Adam approves deploy, merge to main first, then deploy
   minimum Firebase scope (functions:pa-orchestrator:onPaInbound,paMessageCoalescer), then
   live-smoke +1 (717) 491-9939 and paste Firestore + transcript proof.

EXECUTOR PLAN FORMAT:
AGENT_PLAN
Executor:
Objective:
Files to read:
Exclusive write scope:
Shared files needed:
Dependencies on other executors:
Proposed steps:
Tests/evals to add or run:
Safety/privacy checks:
Stop conditions:
Expected artifacts:
Questions for lead:

ASK ADAM ONLY FOR:
- product behavior not answered by AGENTIC-ARCHITECTURE.md / README / CLAUDE / AGENTS
- deploy approval for production-Claire-touching changes
- destructive migration / data deletion
- live outbound beyond approved policy or paid eval budget
- any change that would re-litigate the architecture locks above

DO NOT ASK ADAM FOR:
- implementation details following existing repo patterns
- fixture/helper names that don't change product semantics
- whether to run the required eval gates (always run them)

SELF-REVIEW (run at the END of every phase, and a final one at the end — this is the
section Adam asked to be explicit; write it into SUMMARY.md and surface it in chat):

  Phase self-review checklist — answer each with evidence, not assertion:
  [ ] KEYSTONE held? Conversation logic went to model+prompt+tools; process integrity
      stayed in deterministic config+reducer. (Cite what moved and what stayed.)
  [ ] Did I delete any deterministic logic that was actually load-bearing (process
      integrity / state commit / safety / idempotency)? If yes — STOP, it's a regression.
  [ ] Process intact eval: paste the deterministic assertions + pass counts.
  [ ] Conversation-quality eval: paste the real-LLM scores incl. irrelevance/abstention,
      vs the P0 baseline. Did anything regress?
  [ ] Did I add behavior as a connector (registry addition) rather than a new regex
      branch / hand-wired handler? If I added a branch, justify why a connector couldn't.
  [ ] Did every connector.execute return a verdict and the LLM narrate it ("tell them")?
  [ ] Terminal idempotency: is every terminal commit keyed to fire exactly once?
  [ ] Did I keep the output normalizer and only delete voice processing the eval proved
      redundant? List each deleted file + the eval that cleared it.
  [ ] Regression: pa-orchestrator + apps/functions tests still green? Paste counts.
  [ ] Receipts present: real-LLM output, eval output, (if deployed) Firestore + transcript.
  [ ] LOC delta: how much hand-written code did this phase remove? (Track toward the
      ~9,586 → ~500-1000 collapse target.)
  Honest gaps: list anything the model+prompt still can't do that forced a deterministic
  fallback to stay — these are the next eval/prompt-tuning targets.

START NOW with P0 from updated `main` in a fresh worktree. Do not skip the baseline
receipt — it is the contract for every later phase.
```
