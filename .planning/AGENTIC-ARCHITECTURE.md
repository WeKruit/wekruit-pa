# Claire — Agentic Architecture (locked design)

**Status:** Confirmed with Adam 2026-05-27 through a multi-round design discussion. This is the authoritative north-star architecture for the Claire conversation runtime. Every future change is measured against it. It exists to stop the patch-accretion cycle (regex routers + 9,586 LOC of post-gen voice hacks) and replace it with an agent-core-first system where new capabilities are registry additions, not new code branches.

**Why this doc exists:** Three prior PRs (#237/#238/#239) and one of this session's PRs (#242, closed) all "passed eval" yet shipped regressions, because they patched a regex/state-machine layer instead of fixing the architecture. The real root-cause of the live matcher bug (PR #245) was found only by running a *real* LLM end-to-end: the extractor silently failed `parse_error` because the model emits scalars where the schema demanded arrays. The lesson: the model is capable; the hand-written scaffolding around it is the debt. This architecture moves behavior into the model + prompt + tools, and keeps deterministic code only where it is load-bearing (process integrity, state commit, safety, idempotency).

---

## 0. KEYSTONE — Conversation layer vs Process layer (never confuse)

| | CONVERSATION (agent-driven) | PROCESS / POLICY (deterministic, hardcoded-as-config) |
|---|---|---|
| Governs | **HOW** — how it is said | **WHAT-MUST-HAPPEN** — what must occur |
| Content | routing (which connector), wording/narration, delivery (tapback/text/no-reply), reading intent, extracting answers, handling tangents, when to pause | prescreen question set + order + rubric, trigger conditions, pass threshold, FSM transitions, dedup, idempotency, safety, PII-website-lock |
| Decided by | the LLM | playbook data + deterministic reducer |
| Can the LLM override it | — | **No** |

Deterministic logic **must exist** — it is the process rail. The historical mistake was applying deterministic logic to the *conversation* (regex routing, hand-written narration, voice strippers). Correction: conversation → agent; process → deterministic config + reducer.

Metaphor: **LLM = the interviewer** (skilled, flexible, human; owns HOW). **Playbook = the script + rubric** (fixed; owns WHAT). **Reducer = the producer** (ensures the interviewer covers every required item and records the verdict exactly once; owns process integrity).

---

## 1. Single agent + dynamic mode-scoping (NOT handoffs)

Verified against the OpenAI Agents SDK (`@openai/agents`, which `packages/agent-runtime` already wraps): the SDK offers **handoffs** (control transfer; needs a round-trip to return) and **agents-as-tools** (`agent.asTool()`, manager keeps control). Official guidance: *"start with one agent whenever you can."*

Decision: **one agent, dynamic mode-scoping.** Each inbound turn, a deterministic reducer reads durable process state (`workSession.kind`) and selects the agent config (scoped tools + scoped prompt + pending step). No round-trip handoff. Process completes → state clears → triage mode resumes next turn naturally.

- **agents-as-tools** (`agent.asTool()`) for self-contained bounded subtasks (e.g. enrich-candidate, deep-research) — the manager keeps the user-facing conversation, gets the sub-agent result back.
- **handoffs** only if a true ownership transfer is ever needed (onboarding/prescreen do NOT need this).

### Scoping rule (refined — context bridging)

Scoping narrows **write/action tools only** (to protect process integrity). The **read context and answer/recall tools are GLOBAL** (always available) so the agent can answer any cross-process question without losing process state.

```
GLOBAL READ CONTEXT (injected every turn, never scoped out):
  • full candidate profile: canonical tags
  • prescreen history + outcomes (what they screened for, results)
  • previously recommended jobs
  • mem0 enrich (recent conversation / preferences)
  • current process pending step

ALWAYS-ON ANSWER/RECALL TOOLS (callable in any mode):
  explain_prescreen_outcome · recall_memory ·
  explain_why_recommended · answer_meta_question

SCOPED WRITE/ACTION TOOLS (narrowed by mode, protects intact):
  onboarding mode : write_onboarding_slot ...
  prescreen mode  : record_prescreen_answer / advance_fsm ...
  triage mode     : find-match / set-matching-preferences / schedule-interview / ...
```

---

## 2. Full turn lifecycle

```
                          INBOUND iMessage
                                │
   ── TIER 1 · REFLEX (deterministic · immediate · no LLM) ──
        mark-read POST (read receipt, fire-and-forget)
        typing indicator (if an upcoming tool is expected to be slow)
                                │
   ── SAFETY GUARDRAIL (SDK inputGuardrails · deterministic) ──
        crisis / prompt-injection / privacy-stop → tripwire bypasses agent
                                │
   ── MODE SELECTOR (deterministic reducer reads durable process state) ──
        workSession.kind → { scoped write-tools, scoped prompt, pending step }
        + GLOBAL read context + ALWAYS-ON answer tools (see §1)
                                │
   ── AGENT CORE · run(agent) · @openai/agents loop ──
        context injected: recent history + mem0 enrich + canonical tags
                          + pending process step + few-shot voice
        │
        ├─ LLM routes → tool call (routing = LLM, by connector description)
        │      │
        │      ▼  CONNECTOR.execute = REDUCER (deterministic):
        │           1. dedup check (already screened? already recommended? already booked?)
        │           2. policy gate (PreToolUse: vocab / confidence floor / PII-website-lock)
        │           3. state commit (mergeUserTags / FSM advance / schedule write) + idempotency key
        │           4. return structured verdict { action, reason, detail }
        │      verdict returns to the LLM
        │
        ├─ LLM narrates verdict (agent-driven wording)
        │
        └─ DELIVERY decision (agent-driven · Tier 2):
              send_message (substantive)
              react_to_user (emotion / win → tapback)
              no-text + react ("sure" while processing → tapback only)
                                │
   ── OUTPUT NORMALIZER (deterministic · kept) ──
        markdown strip / URL param clean / iMessage length
        (questionable voice post-processing → eval-gated reassessment)
                                │
                          OUTBOUND (Sendblue · multi-bubble, typing before each bubble)
                                │
   ── POST-TURN side-effect: mem0 write (enrich) · audit event · flywheel enqueue
```

---

## 3. Data model (four stores, each with one job)

```
pa-users.tags            canonical, structured — the matcher's ONLY input
                         reducer-written (mergeUserTags + scalar→array coercion from #245)
                         envelope: { value, source, confidence, evidence, version, updatedAt }
                         chat-editable + always inform the user

mem0 (Qdrant)            free-form semantic recall — enriches voice/continuity
                         read = light auto-inject; write = post-turn side-effect
                         leans side-effect; NEVER gates matching

process state            workSession.kind + FSM position + pending step
                         reducer controls transitions (LLM cannot override)
                         playbook (question set + rubric) = deterministic config

candidate×job state      per-(candidate, job): matched / screening / passed / not_passed / ...
                         dedup source (prescreen no-redo, job no-re-recommend)
                         terminal idempotency key (PASS/FAIL/PII/outbound commit once)

PII (email/phone/        edited on the website only (no chat write tool);
  legal-name)            inform the user to use the portal
```

Two layers never conflated: **canonical tags drive matching (reducer-written, structured); mem0 enriches voice (side-effect, free-form).**

---

## 4. Connector = Reducer (the deterministic commit seam)

The LLM picks a connector (choice); `execute` is deterministic code (commit). New capability = new `ConnectorDef` + one line in `allowedConnectors`. Zero core changes.

```ts
ConnectorDef<I, O> {
  name, version,
  description,            // routing boundary — replaces the regex.
                         // Hermes pattern: one line WHAT + positive trigger
                         // (verbatim phrases incl. Chinese) + "Do NOT call when ..."
  inputSchema: Zod,      // parse(args) = BFCL AST check: rejects hallucinated/mistyped params
  outputSchema: Zod,
  execute(input, ctx) {  // = REDUCER (deterministic)
    // 1. dedup check
    // 2. policy gate (vocab / confidence / PII-website-lock)
    // 3. state commit + idempotency key
    // 4. return verdict
  }
}
```

Verdict shape (so the LLM can narrate it):
```ts
{ ok: boolean,
  action: "committed" | "deduped" | "redirected" | "done",
  reason: "already_screened" | "already_recommended" | "pii_website_only" | ...,
  detail: { link?, priorResult?, changedFields?, v16Counters? } }
```

Connectors never throw to the model — every failure resolves to a structured `ok:false` the model can apologize for (the existing matching connector's degraded-mode contract is the template).

---

## 5. Process control (prescreen example — guarantees intact)

The existing prescreen trigger / full question set / eval / playbook are **kept** — they are the process layer, not discarded.

```
playbook config (pa-jobs) = Q1..Qn + rubric + trigger      ← deterministic data, KEPT
        │
   trigger satisfied → reducer sets workSession.kind = "job_prescreen"
        │
   each turn: reducer hands the pending question → scoped prescreen agent
        │
   LLM asks it in natural language, handles follow-ups, extracts the answer   ← agent (HOW)
        │
   reducer receives extracted answer → records it → advances FSM to next pending question  ← deterministic (WHAT)
        │   (the LLM CANNOT declare "interview done"; the reducer ends it only when all required questions are answered)
        │
   all answered → rubric threshold deterministic rollup → PASS/FAIL (borderline → HITL)
        │
   terminal commit (employer snapshot + notification) + idempotency key (once)
```

**The whole question set is read completely because the reducer iterates it deterministically — not because the LLM remembers. Skipping is impossible: the reducer's "next pending question" always points at the unanswered one.**

---

## 6. Flexibility, interruption, context bridging

Principle (Adam): **maximally flexible interrupt + always resumable.** Bet: if extraction + tagging are solid, process state is durably captured before any switch, so pause/resume anywhere is safe. The load-bearing dependency is therefore extraction quality (which is exactly what the real-LLM harness proves).

- **No conversational locks.** The user can divert at any point.
- **The only guard is terminal idempotency** — an already-committed terminal (PASS/FAIL written, PII confirmed, outbound sent) must not re-fire on resume. Keyed so it commits exactly once. This is NOT a flow lock; it is a write-once guard. Interrupt freely before a terminal commit; after it, resume continues the conversation without re-emitting.

### Cross-process tangent (mid-onboarding asks about prescreen)

```
onboarding in progress (pending step = "what's your target salary range?")
        │
user suddenly asks: "why didn't I pass the Rain interview last time?"
        │
LLM (has GLOBAL prescreen history + explain_prescreen_outcome tool)
   → calls explain_prescreen_outcome → answers: "it came down to systems-design depth ..."   ← context bridges
        │
reducer: onboarding pending step UNCHANGED (durable, no skipped commit)
        │
LLM finishes the tangent → re-surfaces the pending step:
   "anyway — back to it, what salary range are you targeting?"
```

Context bridges because (1) global read context keeps prescreen history available in every mode, and (2) the pending step is durable, so after the tangent the reducer re-surfaces it.

---

## 7. Interaction layer (two tiers — this is what makes it feel human)

Human-feel is an emergent property of giving the agent interaction affordances (tools + reflexes) + a prompt that teaches *when*. It is NOT hand-coded post-gen rules (the old `isShortLowInformationAck` regex is the anti-pattern).

### Tier 1 — Reflex (deterministic, immediate, no LLM)
Latency-sensitive, cannot wait for an LLM round-trip:
- **mark-read** — fired on every inbound, immediately, fire-and-forget. (Verify Sendblue has a mark-read endpoint; if not, typing-only.)
- **typing indicator** — fired before **every** outbound bubble, and while a slow tool runs.
- **quick pre-tool ack** — when the first action is a known-slow tool, immediately emit a generic ack ("sure, one sec" / "let me check") from a **small rotation pool** (NOT a per-connector hardcoded template like "ok hold on let me pull up roles"). **Decision (a): reflex pool**, so the ack lands before the LLM has even finished its first token. The ack *wording* may carry voice via the pool/prompt, but the trigger is deterministic. The slow-tool list is maintained deterministically.

### Tier 2 — Expressive delivery (LLM-decided, tools)
- `send_message` — substantive text.
- `react_to_user(reaction)` — tapback their message (win → ❤️, emotional → empathetic react).
- **no-text + react** — `react_to_user(like)` + empty text → harness sends a tapback only. Replaces the `isShortLowInformationAck` regex. Used when the user sends a low-info ack ("sure"/"yes"/👍) while we are already processing.
- multi-bubble split — typing indicator before each bubble (text split decision: keep `probabilistic-split` only if eval proves the model can't self-split well).

### Choreography of a slow tool-backed turn ("help me find a match")
```
T0    user: "help me find a match"
T0+   ⚡ mark-read (reflex)                        → user sees "Read"
T0+   ⚡ react_to_user(like) (tapback their msg)
T1    💬 "sure, one sec" (reflex quick ack, pool)
T1+   ⚡ typing ON
      ╔═ find-match connector (~3.5s) — reducer: dedup + commit + verdict ═╗
T2    ⚡ typing ON (before result bubble)
T2+   💬 bubble 1: "found a couple that fit —"
T2++  ⚡ typing (before each subsequent bubble)
T2++  💬 bubble 2: "Stripe PM role @ SF ..."
POST  mem0 write (enrich) + audit
```

---

## 8. Safety guardrails (SDK-native, not hand-written)

Use `@openai/agents` `inputGuardrails` (run before the agent, can tripwire/reject) for crisis / prompt-injection / privacy-stop. Use `outputGuardrails` only for true safety validation. **Do NOT push the 9,586-LOC voice stack into guardrails** — guardrails are safety tripwires, not voice/business logic. Voice lives in the prompt + few-shot.

---

## 9. Eval architecture (two layers — the gate before deleting anything)

```
Process-intact eval (deterministic state-diff assertion) — the GATE (exit code):
  • were all prescreen questions asked?
  • did the FSM avoid skipping?
  • was the terminal committed exactly once?
  • did dedup work? did the trigger fire correctly?

Conversation-quality eval (real LLM + grader, BFCL-style) — advisory:
  • is answer extraction accurate?
  • is routing correct? irrelevance detection (when NOT to call a tool)?
  • is delivery human? voice?
  Non-deterministic even at temp 0 → flags follow-ups, does not block CI.
```

Foundations already built this session:
- **Conversation layer:** `apps/eval/conversation-experience/llm-runner.mjs` (#245) — runs the production extractor with a real model, no mock, asserts the real patch + LLM grader. This produced the receipt that found the real bug.
- **Process layer:** `apps/eval/conversation-experience/runner.mjs` — deterministic Firestore-state-diff (the correct use of the #242 harness shape).

BFCL (Berkeley Function Calling Leaderboard) is the reference for the conversation layer: it scores multi-turn, parallel, and crucially **irrelevance/abstention** as a first-class metric. Our old regex router is a bad abstention detector; the BFCL-style eval is what proves the LLM is a better one before we delete the regex.

---

## 10. Scaling property (the whole point — new capability = registry addition)

```
Add conversational scheduling:
  1. write SCHEDULE_INTERVIEW connector (ConnectorDef + execute reducer + dedup + verdict)
  2. add one line to seed.json allowedConnectors
  done. LLM routes by description. Zero regex, zero loop change.

Add website-registration sync:
  1. write SYNC_REGISTRATION connector (execute pulls the API → merges pa-users → verdict)
  2. register it
  same interface (ConnectorDef), same infra (runConnector), same identity (pa-users)
  → satisfies "register on website → sync → inform in conversation, all one interface"

Heavy / swappable external systems → wrap as an MCP server (runtime registration, zero redeploy)
  + ToolSearch deferred loading once there are many connectors.
```

---

## 11. Delete vs Keep

| Delete (conversation work the agent should do) | Keep (legitimately deterministic) |
|---|---|
| `decideConversationTurnOwner` 8-regex router | tool `execute` = reducer (state commit) |
| `handleCompletedUserJobSearchRequest` and peer hand-wired handlers | playbook config (question set + rubric + trigger) |
| `FIND_MATCH_NARRATION` preCall/frameResult templates | FSM reducer (process intact) |
| `conversation-action-arbiter` delivery regex | dedup + idempotency + policy gate |
| `composeNoMatchReply` if/else lang tree (incl. the one added in #245) | SDK guardrails (crisis/injection) |
| questionable `voice/` post-processing (phrase-repeat, ab-framework, mirror, probabilistic-split, am-i-ai-deflector) → eval-gated, delete what prompt+few-shot self-does | output normalizer (markdown/url strip) |
| | transport / identity / idempotency infra |
| | mem0 (enrich) + canonical tags (matcher) |

Estimated collapse: ~9,586 LOC (`voice/`) + the index.ts regex routers/handlers → ~500–1000 LOC (prompt + few-shot + thin reducers + safety gate).

---

## 12. Migration order (eval-first; never delete on faith)

```
0. Extend the #245 real-LLM harness into the two-layer eval
   (process-intact deterministic + conversation-quality BFCL-style incl. irrelevance + delivery).
   Run it against current code to capture the baseline receipt.

1. Vertical slice: take ONE flow (job-search) end-to-end through agent-core.
   Delete its regex + narrator templates; let run(agent) drive find-match.
   Eval gate guards against regression. Prove the pattern, then generalize.

2. Migrate flow-by-flow: prescreen, onboarding (scoped agent + reducer-FSM).

3. Delete voice post-processing layer-by-layer; each deletion gated by eval
   proving the model+prompt+few-shot self-does it.

4. New capabilities (scheduling, registration-sync, notify) = pure connector registrations.

Every step: eval green first, then delete / ship. Receipt-driven.
```

---

## Locked decisions (the discussion converged on these)

0. **Conversation vs Process two-layer separation** (keystone).
1. Single agent + dynamic mode-scoping (write-tools scoped, read-context + answer-tools global). No handoffs; agents-as-tools for bounded subtasks.
2. Two layers: canonical tags (matcher, reducer-written) + mem0 (enrich, side-effect). Never conflated.
3. mem0 leans side-effect: light auto-inject read, post-turn write, never gates matching.
4. Connector `execute` = reducer = state commit + dedup + policy gate + verdict.
5. Dedup is first-class: prescreen no-redo, job no-re-recommend, scheduling no-rebook. PII edited on website only; preference editable in chat. Every dedup/lock/redirect/change is narrated to the user ("tell them").
6. Max-flexible interrupt + always resumable; the only guard is terminal idempotency (commit once). Context bridges via global read context + durable pending-step re-surface.
7. Interaction layer two tiers: Reflex (mark-read, typing-before-every-bubble, **(a) reflex quick-ack pool** before slow tools) + Expressive (react / no-text / send / split, LLM-decided).
8. Output normalizer kept; questionable voice post-processing eval-gated.
9. Safety via SDK guardrails, not hand-written.
10. Eval-first migration, two-layer eval (process-intact deterministic gate + conversation-quality LLM grader). BFCL-style irrelevance detection.
11. New capabilities = connector registry additions; heavy/external = MCP server.
