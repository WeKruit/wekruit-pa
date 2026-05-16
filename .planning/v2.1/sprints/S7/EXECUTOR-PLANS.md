# S7 Ship Gate — EXECUTOR-PLANS

## P10 self-task (no sub-agent spawn unless explicitly needed)

### 1. Objective
Validate the 12 locks + 7 Done-criteria, merge all `claude/v21-*` branches to `main` in dep order, tag the release, finalize v2.2 hand-off doc, and request Adam ship approval.

### 2. Context
All earlier sprints landed on their own branches and have SUMMARY.md. S6 produced SMOKE-REPORT.md. S4 aggregate query is queryable. S5 produced gate-audit collection populated.

### 3. Constraints
- Atomic per-sprint merges (one PR or one FF push per sprint branch). NO `--no-verify`. NO force-push.
- Regression gate must pass on each merge candidate vs main.
- If any Done-criterion fails, STOP and open a follow-up sprint — do NOT ship a partial.

### 4. Deliverables
- Merged main with all v2.1 sprints integrated
- Tag `v2.1-internal-smoke-shipped`
- `.planning/v2.2/HANDOFF-from-v2.1.md` finalized (from S0 skeleton)
- `.planning/v2.1/sprints/S7/SUMMARY.md`
- Final P10 report to Adam: ship decision, follow-up backlog (if any)

### 5. Verification
Regression gate green on main after final merge. Aggregate query returns shipped-state thresholds. Adam ship approval captured.

### 6. Done-criteria
- [ ] All 8 SUMMARY.md present + Done-criteria checkboxes ticked
- [ ] All 12 locks held (no agent-runtime / PreScreenPipeline edits in diff)
- [ ] Tag pushed
- [ ] v2.2 HANDOFF finalized
- [ ] Adam ship approval (via /goal or direct)
