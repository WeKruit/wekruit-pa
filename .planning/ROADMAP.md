# Roadmap (increment from existing phase work)

Phases are **suggested**; renumber in your GSD system if needed.

| Phase | Focus | Outcome |
|-------|--------|--------|
| **N+1** | **Health + proxy** | Worker exposes `GET /health` (or similar); optional nginx; doc for Mac. |
| **N+2** | **E2E send** | Playground (or dedicated flow) can enqueue outbound + see `pending` → `sent` with worker running; runbook. |
| **N+3** | **Console trim** | Remove/hide **Agent Builder**; **Agents** = registration + OpenAI (minimal UI). |
| **N+4** | **Tests + Mem0 decision** | CI-safe tests with stubs; Mem0 = spike or deferred. |

**Cut line if late:** drop Mem0 and deep health before cutting **E2E send** or **health up**.
