# Agent Builder migration — skill-router scope

Status: **scope only, not implementation**. Adam, this is the design
doc you asked for so you can decide go/no-go before we touch code.

## Why

iter32 onboarding is fully deterministic + state-machine. Post-onboarding
flow uses Claire (LLM) routed via the **skill-router** → **skill-stacker**
→ playbook system, which today is half hardcoded:

| Component | Today | Editable by ops? |
|---|---|---|
| Skill regex bank (`pa-playbooks/<skill>.regexBank`) | Firestore | ✅ yes |
| Skill priority + conflictsWith | Firestore | ✅ yes |
| Skill addendum (system-prompt insert) | Firestore | ✅ yes |
| **Routing logic** (when to fire which skill) | TS code (`skill-router.ts`) | ❌ no |
| **Stacking rules** (multi-skill priority resolution) | TS code (`skill-stacker.ts`) | ❌ no |
| **Intent classifier weights** | TS code | ❌ no |
| Vent / crisis suspension rules | TS code | ❌ no |

Adam's directive 2026-05-04 ("else it's all hardcoded no?") points at this
gap. **Agent Builder** (OpenAI's visual workflow canvas, GA Oct 2025) lets
us model branching/dispatch logic as a node graph operators can edit
without redeploying.

## What migrates, what stays

### MIGRATES → Agent Builder workflow

1. **Skill router decision tree** — given user message + memory context +
   onboarding state, decide which playbook(s) fire.
2. **Skill stacker priority resolution** — when multiple match, which wins.
3. **Vent / crisis routing** — escalate to crisis-hotline node vs. continue
   probe.
4. **Multi-step playbook handoffs** — e.g. resume_review → followup_email
   → calendar_invite as a chain.

### STAYS in TS code

- **iter32 deterministic onboarding** — explicitly NOT migrated. Adam's
  directive: structurally hardcoded, configurable phrases, no LLM. Agent
  Builder would add cost + drift risk for zero benefit.
- **HITL pause gate** — pure side-effect, no decision logic.
- **Safety / pa-safety inbound checks** — latency-critical, deterministic,
  must run pre-LLM.
- **Output guardrails** — langlock, AB-probe-strip, hotline injection — all
  deterministic post-LLM transforms.
- **Memory / Mem0 / Qdrant** — operational infra, not workflow logic.
- **Sendblue / outbox** — transport.

## Architecture

```
iMessage inbound
    ↓
[ HITL gate ] → if paused → return
    ↓
[ Safety check ] → if blocked → canned safety reply → return
    ↓
[ Onboarding state != complete ] → deterministic dispatcher → return  (iter32, stays)
    ↓
                       ┌─────────────────────────┐
                       │  Agent Builder workflow │
[ Compose context ] → ─┤  (NEW — replaces        │ → Claire reply text
                       │  skill-router +         │
                       │  skill-stacker)         │
                       └─────────────────────────┘
    ↓
[ Output guardrails ] → langlock, hotline, etc. (stays)
    ↓
[ Sendblue outbox ]
```

The Agent Builder workflow is invoked via the OpenAI Agents SDK (which
already wraps it; `@pa/agent-runtime` already calls Agents SDK). Migration
is mostly: replace the inline `skill-router.ts` decision tree with a
single SDK call to a hosted workflow, passing user message + context.

## Workflow nodes (initial design)

```
START
  │
  ▼
[ classify_intent ] (LLM node — OpenAI gpt-4o-mini, 200ms)
  │   outputs: intent ∈ {job_search, vent, interview_prep, negotiation,
  │            motivation_nudge, resume_review, jd_roast, casual_chat, abuse}
  ▼
[ route_by_intent ] (deterministic switch node)
  ├─ vent / crisis → [ vent_branch ] → emit crisis hotline check + empathy
  ├─ job_search    → [ stack_skills: job_search + cv_followup ] → playbook addendum
  ├─ resume_review → [ stack_skills: resume_review ]
  ├─ jd_roast      → [ stack_skills: jd_roast ]
  ├─ negotiation   → [ stack_skills: negotiation ]
  ├─ casual_chat   → [ minimal_addendum ]
  ├─ abuse         → [ canned_refusal ]
  └─ default       → [ no_skill ]
  │
  ▼
[ compose_systemprompt ] (deterministic — splice handbook + skill addenda)
  │
  ▼
[ generate_reply ] (LLM node — SiliconFlow Qwen2.5-7B-Instruct, 600ms)
  │
  ▼
END → reply text
```

Each node is editable via Agent Builder canvas. Adam can:
- Adjust intent classifier prompt without redeploy
- Add new branches (e.g. `salary_negotiation_v2`) by drag-drop
- A/B test routing variants via OpenAI's built-in eval rails
- Inspect per-turn traces in the Agent Builder dashboard

## Phased rollout

### Phase 1: Shadow mode (1-2 days)

- Build the workflow in Agent Builder canvas, hook to existing
  `skill-router` results
- For every turn, fire the workflow in parallel, log decisions to
  `pa.skill_router.shadow.*` Cloud Logging events
- Compare workflow decisions vs. `skill-router.ts` decisions
- Flip ON via `paSkillRouterAgentBuilderShadow`

### Phase 2: Cutover (after ≥99% parity for 24h, 1 day)

- Flip `paSkillRouterAgentBuilderEnabled=true`
- Workflow becomes load-bearing; `skill-router.ts` runs in shadow with
  alerts on divergence
- Adam can edit canvas; changes go live within ~1 min (Agent Builder
  workflow versioning — pin a version per env)

### Phase 3: Full delete (1 week post-cutover, 0.5 day)

- Delete `skill-router.ts` + `skill-stacker.ts` + tests
- ~600 lines of code removed
- Skill registry in Firestore stays (still source-of-truth for skill
  content), only the routing/dispatch moves to Agent Builder

## Effort + cost

| Item | Estimate |
|---|---|
| Build Agent Builder workflow canvas | 1-2 days |
| Wire `@pa/agent-runtime` to invoke hosted workflow | 0.5 day |
| Shadow telemetry + parity check | 0.5 day |
| Cutover + delete legacy | 0.5 day |
| **Total** | **3-4 days** |

| Cost | Today | After |
|---|---|---|
| Per-turn skill routing | $0 (TS) | ~$0.0005 (gpt-4o-mini classify) |
| Per-turn LLM reply | ~$0.001 (Qwen-7B) | unchanged |
| Latency added per turn | 0 | ~150ms (workflow overhead + intent classify) |
| Monthly cost @ 10k turns/mo | $10 (Qwen) | $15 (Qwen + classify) |

50% cost increase, 150ms latency increase, in exchange for
operator-editable routing.

## Risks

1. **Latency budget**: current p95 is ~3.5s end-to-end. Adding 150ms is
   noticeable. Mitigation: Agent Builder workflow can run intent classify
   in parallel with memory load; net latency add ~80ms.
2. **Outage radius**: Agent Builder is hosted on OpenAI's infra. If they
   have an outage, our skill router goes down. Mitigation: keep a
   `paSkillRouterAgentBuilderDisabled` env kill switch that snaps back to
   `skill-router.ts` (kept in code as fallback for 30 days post-cutover).
3. **Cost runaway**: A poorly-designed workflow could call LLM at every
   node (classify + route + verify + ...). Mitigation: design review,
   per-turn cost ceiling alert (`$0.005/turn` warning).
4. **Vendor lock**: Agent Builder is OpenAI-specific. If we ever want to
   switch providers (Anthropic, etc.) we'd lose the visual canvas.
   Mitigation: workflow logic is a graph, easy to re-implement; we'd lose
   ~3 days but not the IP.
5. **Loss of TS-level type safety**: Workflow node IO is JSON-shaped.
   Mitigation: Zod-validate inputs/outputs at the boundary.
6. **Existing 590+ tests**: `skill-router.test.ts` + `skill-stacker.test.ts`
   become integration tests against a remote workflow. Migration plan:
   keep ~30% as TS unit tests for the wrapper/adapter; move ~70% to
   Agent Builder eval suite.

## Decision points for Adam

1. **Go / no-go.** Worth 3-4 days + 50% cost for visual editing? Strong
   argument for yes if you plan to iterate skill routing weekly. Argument
   for no if routing is stable after iter32.
2. **Provider lock comfort.** OK pinning skill routing to OpenAI's
   platform? You're already pinned to OpenAI Agents SDK in `agent-runtime`,
   so this isn't a new dependency, just a deeper one.
3. **Editor model.** Adam-only canvas access OR open to ops team /
   external partners? Affects auth setup.
4. **Eval discipline.** Adam directive iter23: "你需要做测试，每个 playbook
   测试看看是否真的生效". Agent Builder's eval rails can ingest existing
   `tests/scenarios/intent-matrix/*.yaml` fixtures. Want me to wire the
   54-cell intent matrix into the canvas eval pre-cutover?

## Recommendation

**Conditional yes**: do it AFTER biz testers ship and you have a real
feedback loop on which skills need tuning. If iteration on routing is
weekly during biz test, the visual editor pays for itself quickly. If
routing stays stable post-iter32, defer 1-2 months and revisit.

If you greenlight, open `iter33-agent-builder/` with this scope as the
spec doc and I'll run Phase 1 (shadow) end-to-end in 1-2 days.

---

## Out of scope (intentionally NOT covered here)

- Onboarding migration to Agent Builder — Adam directive: stays
  deterministic.
- Memory / Mem0 / Qdrant — separate ops concern.
- Sendblue transport — separate ops concern.
- Dashboard rebuild around Agent Builder — viable but huge; this doc is
  "swap routing engine", not "rebuild dashboard".
- Cross-product (hiring app) — `parsedCandidateResumes` + matching
  pipeline stay as-is; only the personal-assistant orchestrator
  routing changes.

## Files to delete after Phase 3 (estimate)

- `packages/pa-orchestrator/src/skill-router.ts` (~280 lines)
- `packages/pa-orchestrator/src/skill-stacker.ts` (~310 lines)
- `packages/pa-orchestrator/src/skill-intent-classifier.ts` (~120 lines)
- `packages/pa-orchestrator/src/skill-tool-gate.ts` (~80 lines)
- Their `.test.ts` siblings (~700 lines of test code)

Net code reduction: ~1500 lines after migration.

## Files to add (estimate)

- `packages/agent-runtime/src/agent-builder-adapter.ts` (~150 lines)
- `packages/agent-runtime/src/agent-builder-shadow-telemetry.ts` (~80 lines)
- `apps/functions/src/__tests__/agent-builder-parity.test.ts` (~200 lines)
- Workflow definition lives in Agent Builder canvas, NOT in repo (just
  versioned via Agent Builder's own UI). Optionally export workflow JSON
  to `.planning/iter33-agent-builder/workflow-v1.json` for git history.

Net add: ~430 lines + workflow JSON snapshot.

## Open questions

- Does Agent Builder support full `@pa/agent-runtime` Session-style
  history? (Need to confirm — likely yes via `messages` input array, but
  exact shape needs prototyping.)
- Per-user A/B routing variant support? (Agent Builder supports versioned
  workflows but per-user routing might need our own splitter at the
  invocation layer.)
- Cost alerting at runtime — does Agent Builder emit per-call cost in
  the response? If yes, we can wire a daily cost dashboard easily.

These resolve in Phase 1 (1-2 days of prototyping).
