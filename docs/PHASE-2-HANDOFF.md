# P10 Handoff — WeKruit PA Phase 1 Closed, Phase 2/3 Open

> Frozen on 2026-04-25 after `__PA_RESET__` + `[ISO]` fix + cold-start memory recall **all PASS in production iMessage** (real user `admin1@wekruit.com`, real Mac → Firebase → SiliconFlow → Qdrant).

## 1. State of the world (verified, not assumed)

### 1.1 origin/main timeline

```
84cf2ec  Auto-allow admin user IDs to trigger __PA_RESET__ via CF env
9254799  Reusable clearUserMemory + magic-string interface (admin.ts)
4748287  CLI scripts/pa-clear-user.mjs (Phase 3 backbone)
5f6b494  B1 hotfix: [ISO] timestamp leak (root cause messages.ts:23)
8c5a7b2  Phase 2 harness scaffold (tests/scenarios/runner.mjs)
3b3dc98  Phase 1 source-of-truth merge (worktree → broker arch on main)
98a28a2  wip: pre-merge checkpoint (reflog safety, ALSO pushed as
         origin/archive/2026-04-25-pre-phase1-merge)
```

Worktree branch (origin/archive/2026-04-25-cf-mem0-fixes-worktree)
preserved for forensic. Working dir clean except `.claude/` (worktree).

### 1.2 What's deployed

- **Cloud Function** `pa-orchestrator:onPaInbound(us-central1)`,
  Gen2 nodejs20, revision `onpainbound-00022-bip`, updated 04:20 UTC.
- **Runtime env** verified via Cloud Functions REST API (not deploy log):
  ```
  PA_ADMIN_USER_IDS = 1498dd10-e666-46ce-83e8-89433298af2c
  ```
  Plus secrets bound: `SILICONFLOW_API_KEY, QDRANT_URL, QDRANT_API_KEY`.
- **Hosting** `wekruit-pa.web.app` not redeployed this session — dashboard
  still has Phase 1 baseline. Memory Admin UI is Phase 3, not started.

### 1.3 Production verification screenshots (real iMessage)

- `__PA_RESET__` → `✓ 测试记忆已清空 — qdrant pa_memory=8; firestore
  pa_memory_facts=2, pa_memory_actions=2, pa_messages=53,
  pa_agent_turns=7, pa_turns=13` (PASS, zero CLI setup needed)
- `今晚我想吃寿司` / `我还想去打球` / `你还记得我想去干嘛？`
  → `记得，你想今晚去打球然后吃寿司。` (PASS — no `[ISO]` prefix,
  cross-turn recall on cold start)

### 1.4 Tests

- 45 → 49 passing across 7 workspace test suites
  (memory 21, pa-broker 7, pa-orchestrator 7, pa-safety 3,
  agent-registry 3, agent-runtime 7, worker 6, archive/etc)
- All workspace builds clean. CF bundles to 13.5MB esbuild.

## 2. P10 决断 made this session

| # | Decision | Reason | Where landed |
|---|----------|--------|--------------|
| 1 | `mem0.ts` worktree wins | Production validated (Mem0 OSS + Qdrant via FetchQdrantClient + SiliconFlow + disableHistory for esbuild) | `packages/memory/src/mem0.ts` |
| 2 | `pa-orchestrator/index.ts` worktree wins | 538 LOC version is the only one production tested | `packages/pa-orchestrator/src/index.ts` |
| 3 | `worker/index.ts` main wins | Preserves new broker arch (`@pa/pa-broker` lifecycle) | `apps/macos-imessage-worker/src/index.ts` |
| 4 | core-types union merge | Kept main's superset for `AgentDef` + `OutboundMessage`; took worktree's `MemoryFact { content, source }` shape because `firestore-persona.ts` was the only main consumer of the old shape and was deleted (orphan) | `packages/core-types/src/index.ts` |
| 5 | `AgentDef.status` `.default()` → `.optional()` | Test fixtures and runtime call sites construct AgentDef literals; `.default()` made TypeScript treat it as required at type level | same |
| 6 | Two-gate magic-string auth: `user.testMode` OR `PA_ADMIN_USER_IDS` env | Lets new test users avoid the CLI bootstrap; auto-promotes allowlisted user to `testMode = true` on first use | `packages/pa-orchestrator/src/index.ts` `maybeHandleResetCommand` |
| 7 | B1 fix: drop `[ISO]` history prefix entirely + add system-prompt guard + defense-in-depth strip on LLM output | Model was learning to echo the prefix from its own prior turns. Three-layer fix: stop teaching it, tell it not to, strip if it does anyway | `packages/agent-runtime/src/messages.ts`, `packages/pa-orchestrator/src/index.ts` |

## 3. Reusable interface that landed

### `packages/memory/src/admin.ts`

```ts
export async function clearUserMemory(
  userId: string,
  deps: { db, qdrantUrl, qdrantApiKey, qdrantCollection?, fetch?, logger? },
  opts: { keepMessages?, dryRun? }
): Promise<{ userId, dryRun, qdrant: {collection, matched, deleted}, firestore: Record<string, number> }>

export const RESET_PATTERNS: ["__PA_RESET__", "/pa-reset", "重置我的记忆"]
export function isResetCommand(body: string): boolean
export function summarizeClearResult(r: ClearUserMemoryResult): string
```

Three call sites today:

1. `scripts/pa-clear-user.mjs` (CLI for harness re-runs and ops)
2. `pa-orchestrator.maybeHandleResetCommand` (in-band magic string)
3. **Phase 3 Memory Admin dashboard** (HTTP wrapper, not yet built)

The dashboard task is "wrap admin.ts in an admin-auth'd HTTP endpoint and
add a User Detail page that lists/searches/deletes Qdrant memory
payloads by `user_id`." Don't reimplement; just wrap.

## 4. Known regressions (explicit, not hidden)

1. **Persona card from Firestore facts no longer injected into LLM
   system prompt.** Main's `firestore-persona.ts` was deleted because
   it relied on the old `MemoryFact { key, value, sensitivity }` shape.
   Worktree's `FirestorePersonaProvider` (in `providers.ts`) is a more
   capable replacement but `stacked.ts` does not call it yet.
   → Phase 4 (Agent / Memory Management) wires it back in.
2. **`mem0UserId` field is advisory only.** Worker passes
   `user.mem0UserId ?? user.id`; `stacked.ts` uses `userId` directly as
   the Mem0 partition. Functionally identical for users where
   `mem0UserId` is unset (current production state).
   → Phase 4 should make stacked.ts honor the override.
3. **Worker `chunked-message UX` not implemented.** B2 in this session.
   Photon SDK probably doesn't expose iMessage typing indicator —
   needs research. Workaround: chunk reply into 2-3 segments with
   1-2s delay between sends.

## 5. Three open product issues from real iMessage testing

| # | Issue | Status |
|---|-------|--------|
| B1 | `[ISO]` timestamp leak in replies | ✓ FIXED + production verified |
| B2 | No typing indicator / replies feel "instant LLM dump" | ⏳ backlog, needs Photon SDK research |
| B3 | Robotic tone ("祝你打球愉快！记得享受阳光和新鲜空气！" canned template) | ⏳ Phase 4 Persona Playbook territory; one-line prompt change won't fix it |

## 6. Red lines (carry forward from initial handoff)

- **Don't write to `~/Library/Messages/chat.db`.** Worker territory only.
  Tests use Firestore broker `pa_inbound_events` injection.
- **Don't put secrets in source / `.env.template` / commit messages.** All
  Qdrant/SiliconFlow/Firebase secrets via `defineSecret` or
  `firebase functions:secrets:*`. `apps/functions/.env` is gitignored
  for the non-secret allowlist.
- **Don't `git reset --hard` to clean state.** `wip/main-pre-merge-checkpoint`
  branch + `archive/*` branches are reflog safety nets — don't delete
  without a reason.
- **Don't trust `Deploy complete!`** as the only verification. Pull the
  Cloud Functions REST API to confirm env vars/secrets actually landed
  on the running revision.
- **Don't grow `apps/functions/lib/` in git.** It's gitignored; predeploy
  rebuilds it.

## 7. Tester workflow (for future sessions / new testers)

```
1) iMessage → "__PA_RESET__"        → ✓ clean slate
2) iMessage → test conversation     → reply must have NO [ISO] prefix
3) iMessage → recall question       → must surface earlier facts
4) iMessage → "__PA_RESET__" again  → between scenarios
```

If the tester is not the user `1498dd10-e666-46ce-83e8-89433298af2c`,
add their UUID to `apps/functions/.env` (`PA_ADMIN_USER_IDS=uuid1,uuid2`)
and redeploy. Or set `pa_users/{id}.testMode = true` once via:

```
node scripts/pa-clear-user.mjs <userId> --set-test-mode --dry-run
```

## 8. Phase backlog with priority hints

| Phase | What | Why now / why later | Estimated effort |
|-------|------|---------------------|------------------|
| Phase 2 | Run `tests/scenarios/runner.mjs` against production CF | Now — production is ready; turns hand-testing into reproducible regression. Add multi-language scenarios + adversarial scenarios (promptfoo redteam) | 0.5–1 hour for first real run + 2–3 hrs for full multilingual + adversarial coverage |
| Phase 3 | Memory Admin dashboard (User Detail Qdrant page wrapping `admin.ts`) | Dashboard is currently ops console only; no way to see/delete a real user's semantic memory without CLI | ~3 hours |
| Phase 4 | Persona Playbook + B3 robotic-tone fix + persona card re-wiring | Needs Phase 2 harness data first, otherwise tone changes are unevaluable | 4+ hours |
| B2 | Typing indicator UX (chunked sends) | UX polish; defer until product/persona settles | 2 hours research + 2 hours impl |
| Ops | Node 20 → Node 22 runtime upgrade | **Hard deadline 2026-04-30** — Firebase deprecates Node 20 then. After that, can't deploy without upgrading | 1 hour (bump engines + test deploy) |

## 9. Recommended first task for next session

**Phase 2 real-run.** Cheapest, proves the harness investment, removes
the human-in-the-loop verify dependency. Workflow:

```bash
PATH=/Users/adam/.nvm/versions/node/v24.3.0/bin:$PATH \
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs \
  tests/scenarios/scenarios/memory-recall-zh.yaml
```

If that flows, next sub-tasks:
1. Add 3 more scenarios: en-US recall, mixed-language recall,
   `__PA_RESET__` integration scenario.
2. Wire as `npm test` precondition (env-gated; skip when no GCP creds).
3. Document scenario authoring in `tests/scenarios/README.md` (already
   skeletoned).

After harness, **Phase 3 Memory Admin** is the next leverage point.
Don't jump to Phase 4 (Persona) before Phase 2 — you can't iterate
tone without an eval loop.

## 10. Hard environment facts

- Node 24.3.0 (NVM) for local dev (better-sqlite3 ABI). Node 25 breaks worker.
- Firebase project: `wekruit-5f89b`
- Cloud Function: `pa-orchestrator:onPaInbound` Gen2 us-central1
- LLM: SiliconFlow `Qwen/Qwen2.5-72B-Instruct`
- Embedder: SiliconFlow `BAAI/bge-m3` 1024 dims
- Vector DB: self-hosted Qdrant on Fly.dev (`:443`, custom `FetchQdrantClient`)
- Firestore: `(default)` database in `nam5`
- Test user: `1498dd10-e666-46ce-83e8-89433298af2c` / `admin1@wekruit.com`
- Test session: `ses_569b27ab47c4fe633139b63675bb63b1`

## 11. Files you'll touch in Phase 2

- `tests/scenarios/runner.mjs` — current MVP, will need: argv flag for
  parallel scenario execution, optional Qdrant payload assertion mode,
  cleanup-after-run flag.
- `tests/scenarios/scenarios/*.yaml` — author new scenarios here.
- `tests/scenarios/README.md` — keep contract docs current.
- `tests/promptfoo/` — separate eval harness; eventually feed scenarios
  through promptfoo provider for redteam scoring.
