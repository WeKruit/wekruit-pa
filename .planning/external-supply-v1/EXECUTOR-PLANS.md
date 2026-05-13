# External Supply V1 — Executor Plans

> Each executor returns an `AGENT_PLAN` block here BEFORE writing code. Lead reviews, approves, edits, or rejects. Implementation begins only after the lead writes the Integration Note in `PLAN.md` §9.1.

## Template

Each executor must use this exact shape (per `.planning/AUTONOMOUS-SPRINT-HARNESS.md` §3 Phase 2):

```text
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
```

---

## A. Data Model + Contracts

_AGENT_PLAN pending — to be filled by Executor A._

---

## B. Import + Normalization

_AGENT_PLAN pending — to be filled by Executor B._

---

## C. Identity + pa-users Upsert

_AGENT_PLAN pending — to be filled by Executor C._

---

## D. Evaluation + Rubric Engine

_AGENT_PLAN pending — to be filled by Executor D._

---

## E. Agent Research + Prompt Contract

_AGENT_PLAN pending — to be filled by Executor E._

---

## F. Outreach + Instantly

_AGENT_PLAN pending — to be filled by Executor F._

---

## G. Dashboard

_AGENT_PLAN pending — to be filled by Executor G._

---

## H. Verification / Eval

_AGENT_PLAN pending — to be filled by Executor H._

---

## Integration Note (Lead)

_To be filled in `PLAN.md` §9.1 after all AGENT_PLANs return._

Checklist:

- [ ] All 8 AGENT_PLAN entries above are filled.
- [ ] Exclusive write scopes are disjoint.
- [ ] Shared-file owners are agreed (see PLAN.md §8 last paragraph).
- [ ] Data contracts match `PLAN.md` §5 — A's plan should add no field A removes.
- [ ] Every primitive maps to a UI surface or operator debug state (G's plan should cover every backend record type).
- [ ] Every LLM call has an eval or trace artifact (D, E, F).
- [ ] Every HITL edit produces a correction event (review queue, tier override, copy edit, agent finding approval).
- [ ] No product invariant violated (`PLAN.md` §4).
- [ ] Wave order confirmed: A → (B||C) → (D||E||F) → G → H.
