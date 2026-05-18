# P10 Handoff — Phase 2 harness + Phase 3 Memory Admin baseline complete

> Reconciled **2026-04-26** against `main` after the Phase 10 Agents SDK current-info migration work.
> This file is the **source of truth** for what is done and what comes next. Ignore older snapshots (e.g. 2026-04-25) that still say “first task = run runner” or “Memory Admin not started.”

## 1. Current facts (verified in repo + deployment posture)

### 1.1 Phase 1–3 closure (what is no longer “open”)

- **Node 22** — Cloud Functions runtime is on **Node 22** (`apps/functions/package.json` `engines.node`). The old “Node 20 → 22 before 2026-04-30” upgrade item is **done** from a planning perspective; keep watching Firebase release notes for future bumps.
- **Phase 2 scenario harness** — **Runs end-to-end** against production stack (Firestore broker → CF → orchestrator → Mem0 / Qdrant / LLM). Scenarios live under `tests/scenarios/scenarios/`.
- **Outbound suppression** — Harness broker events include `rawPayload.harness.suppressOutbound: true`. Orchestrator still writes **`pa_messages`** (transcript) but **skips `enqueueOutbound`**, so `paSendblueOutbox` has nothing to deliver for harness turns. The runner **asserts** after each turn (unless `verifySuppressOutbound: false`) that **`pa_outbound`** has no row for `outbound-<inbound_event_id>`. Long **`replyTimeoutMs`** (default 120s) reduces LLM flake; directory runs use **sorted** YAML order.
- **`npm test` + scenarios** — Root `npm test` runs `scripts/run-scenarios-if-env.mjs` first. Production scenario runs are **opt-in**: set `PA_RUN_SCENARIOS=1` and valid GCP credentials; otherwise scenarios **skip** and workspace tests run as usual.
- **Scenario coverage in-tree** — Multilingual **recall** (`memory-recall-zh.yaml`, `memory-recall-en.yaml`, `memory-recall-ja.yaml`, `memory-recall-mixed.yaml`), **`__PA_RESET__` integration** (`reset-integration-zh.yaml`), and **current-info boundary** (`current-info-boundary-zh.yaml`) are present and maintained with the runner.
- **Phase 3 Memory Admin dashboard** — **Shipped** on hosting (`UserDetail` + memory admin flows, wrapping `packages/memory` admin helpers). Memory views **auto-load** when appropriate (no “dashboard is Phase-1-only shell” state).
- **Current-info tourniquet** — Without a live search connector, the orchestrator **does not** fill “recent movies / news” from stale model knowledge. Users get an explicit **boundary reply** (CN/EN paths in `buildCurrentInfoBoundaryReply` in `packages/pa-orchestrator/src/index.ts`).
- **Current-info connector direction** — Phase 10 now uses **OpenAI Agents SDK hosted `web_search`** through `@pa/agent-runtime`, not a long-lived hand-written Responses fetch wrapper. Production enablement uses the general `PA_OPENAI_AGENT_API_KEY` Firebase secret, then functions deploy + live harness verification.

### 1.2 What remains intentionally deferred

- **Live current-info / search production enablement** — Code path is in-tree, but deployed `onPaInbound` still needs `PA_OPENAI_AGENT_API_KEY` binding, functions deploy, safe metadata verification, and a live current-info harness run.
- **Persona / Firestore facts / `mem0UserId` parity** — Still Phase 4 playbook work (see §4).
- **B2 typing indicator** — Research + implementation (P2).
- **B3 “human feel”** — After harness/eval signals are stable (P4).

### 1.3 Recent anchor commits

```text
cf8020c  Reconcile PA planning and harness docs
8e9d0e9  Add current-info web search connector
15d68b1  fix(dashboard): split inbound pending vs failed on Overview
e5b7c26  Block stale current-info answers
9626410  Autoload dashboard semantic memory
b9797fe  Ship Phase 3 memory admin and safe harness
```

Use `git log` for full history; do not treat the 2026-04-25 handoff snapshot as current.

## 2. Reusable interface (`packages/memory/src/admin.ts`)

`clearUserMemory`, `RESET_PATTERNS`, `isResetCommand`, `summarizeClearResult` — unchanged role.

**Call sites today:** CLI (`scripts/pa-clear-user.mjs`), in-band `__PA_RESET__` / magic strings in orchestrator, and **Memory Admin dashboard** HTTP/API paths. **Do not reimplement** clearing semantics; wrap `admin.ts`.

## 3. Known regressions / technical debt (explicit)

1. **Firestore persona facts not injected into LLM system prompt** — Historical `firestore-persona.ts` shape vs providers; `FirestorePersonaProvider` exists but stacking path may not call it. **Phase 4 Persona Playbook.**
2. **`mem0UserId` is advisory** — Worker may pass `user.mem0UserId ?? user.id`; stacked Mem0 path should honor override consistently. **Phase 4.**
3. **Worker chunked-message / typing** — B2; Photon / platform constraints need research.

## 4. Product issues (from real channel + harness)

| ID | Issue | Status |
|----|--------|--------|
| B1 | `[ISO]` timestamp leak | Fixed (historical); keep regression coverage |
| B2 | No typing indicator / “instant LLM dump” | P2 — research + implement |
| B3 | Robotic / canned tone | P4 — after eval stable |
| Current-info | Stale “latest news/movies” without live data | **Guarded**; connector code now targets Agents SDK hosted `web_search`; production secret/deploy/harness still pending |

## 5. Red lines (ops + safety)

- **Do not write to `~/Library/Messages/chat.db`.** Worker-only; tests use Firestore broker injection.
- **Do not run tests that enqueue real iMessage outbound** unless you deliberately bypass harness suppression and accept operational risk. Default harness = suppressed.
- **Secrets** — Not in source; use Firebase secrets / SA for deploy and local creds outside git.
- **Avoid destructive git** — No `reset` / `checkout` / `revert` of shared history without explicit owner intent.
- **Do not commit** `.claude/`, `.firebase/`, or secrets.
- **Dashboard** — Treat **Delete / Clear** on production user memory as destructive; do not use casually in shared sessions.
- **`apps/functions/lib/`** — Build artifact; keep out of version control (predeploy rebuild).

## 6. Priority backlog (next executor — use this order)

| Priority | Item | Notes |
|----------|------|--------|
| **P0** | **Production-enable Agents SDK current-info** | Bind `PA_OPENAI_AGENT_API_KEY`, deploy functions, verify deployed metadata, then run live current-info harness with `pa_outbound=0`. |
| **P1** | **Persona + identity/memory injection** | Re-wire Firestore persona facts into runtime prompt; fix **`mem0UserId`** advisory / consistency; keep Mem0/Admin. |
| **P2** | **Job companion scheduled outreach** | Permissioned project/status check-ins, cooldowns, audit, and outbound policy. |
| **P3** | **Job matching connector path** | Auditable matched-role notifications with source and rationale. |
| **P4** | **B2 typing indicator / delivery feel** | Research (Photon / iMessage) + implementation. |

## 7. Recommended first task for the **next** session

**Start at P0 production enablement** — Phase 2 harness and Phase 3 Memory Admin are **not** the next “first task.” The code path now expects `PA_OPENAI_AGENT_API_KEY`; do not revive the old `PA_CURRENT_INFO_OPENAI_API_KEY` name.
If P0 is blocked on vendor/API keys, proceed to **P1 persona + identity/memory injection**; do **not** skip back to “run runner for the first time.”

**Harness usage** (when adding scenarios or validating regressions):

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
  node tests/scenarios/runner.mjs tests/scenarios/scenarios/
```

**Optional `npm test` with scenarios:**

```bash
PA_RUN_SCENARIOS=1 GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm test
```

## 8. Environment snapshot (typical)

- **Firebase project:** `wekruit-5f89b`
- **CF:** `pa-orchestrator:onPaInbound` Gen2 `us-central1`, **Node 22**
- **Local dev:** Use Node 24, matching the Firebase Functions runtime.
- **Vector / LLM:** Qdrant + SiliconFlow (see deploy secrets); exact model IDs in ops env, not repeated here.

## 9. Files you will touch for **upcoming** work

| Priority | Likely paths |
|----------|----------------|
| P0 | `packages/pa-connectors/`, orchestrator tool/connector wiring, safety boundaries |
| P1 | `apps/dashboard-web/src/pages/*`, overview metrics |
| P2 | `apps/functions/src/sendblue/`, broker/orchestrator if signaling changes |
| P3 | `packages/agent-runtime/`, `packages/memory/`, persona providers, orchestrator stacking |
| P4 | Prompting + eval scenarios |

**Phase 2 maintainer:** `tests/scenarios/runner.mjs`, `tests/scenarios/scenarios/*.yaml`, `tests/scenarios/README.md`.
