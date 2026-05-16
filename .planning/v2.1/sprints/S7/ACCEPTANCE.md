# S7 Ship Gate — ACCEPTANCE

## Verification

- [ ] All 8 SUMMARY.md present (S0..S7)
- [ ] All 12 locks held (no edits to `agent-runtime/runAgentTurn` core or `PreScreenPipeline.runTurn`)
- [ ] All 7 Done-criteria checkboxes ticked

## Merge integrity

- [ ] Each sprint branch merges to main as FF or PR
- [ ] Regression gate green on main after each merge
- [ ] No `--no-verify`, no force-push
- [ ] `git worktree remove` after each branch lands

## Ship artifact

- [ ] Tag `v2.1-internal-smoke-shipped` pushed
- [ ] `.planning/v2.2/HANDOFF-from-v2.1.md` finalized
- [ ] Adam ship approval captured (via /goal or direct)
