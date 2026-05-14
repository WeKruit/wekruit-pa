# External Candidate Supply V2 — Executor AGENT_PLAN ledger

Lead dispatches each executor below for **AGENT_PLAN only** — written-out plan, no code. Lead reads each plan, asks clarifying follow-ups inline, then merges into integration notes. Code execution starts only after the integration note is checked into this file.

## Executor template

Each executor returns a Markdown block containing:

1. **Scope confirm** — paraphrase write scope + acceptance criteria.
2. **File-level plan** — every file the executor will create or edit (path + 1-line purpose).
3. **API / contract surface** — exact function/callable signatures + Zod shapes (mirror PLAN §3 where applicable).
4. **Test plan** — which unit tests, fixtures, mocks.
5. **Open questions** — anything ambiguous; lead resolves and writes a single `Lead resolution: ...` line per question into this file.
6. **Risk callouts** — anything that could spill outside scope.
7. **Estimated effort** — hours / LOC range / commit count.

Lead integration note format:

```
## Lead integration note — Executor X — yyyy-mm-dd

- Resolutions: ...
- Cross-executor surface: ...
- Greenlit to start: yes/no, gate = ...
```

---

## A. Data Model + Contracts — AGENT_PLAN (placeholder)

_Pending dispatch._

---

## B. Adapter Registry + Detection — AGENT_PLAN (placeholder)

_Pending dispatch._

---

## C. Dashboard Preview Server — AGENT_PLAN (placeholder)

_Pending dispatch._

---

## D. Agent Ranking — AGENT_PLAN (placeholder)

_Pending dispatch._

---

## E. Dashboard UX — AGENT_PLAN (placeholder)

_Pending dispatch._

---

## F. Flywheel Integration — AGENT_PLAN (placeholder)

_Pending dispatch._

---

## G. Verification — AGENT_PLAN (placeholder)

_Pending dispatch._
