# macOS iMessage worker

The **only** app in this monorepo that depends on `@photon-ai/imessage-kit`.

## Patch (`patch-package`)

`patches/@photon-ai+imessage-kit+3.0.0.patch` adjusts SQL column selections for compatibility with the local `chat.db` schema on some macOS versions. Do not edit `node_modules` by hand; update the patch with `npx patch-package @photon-ai/imessage-kit` if needed.

## Environment

- `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_PATH` — service account with Firestore access (bypasses client rules).
- `OPENAI_API_KEY` — required for LLM responses (else worker falls back to echoing `收到: ...`).
- `MEM0_API_KEY` — optional; enables Mem0 retrieval/add when the agent’s `memoryMode` is `mem0` or `both`.  
- `MEM0_BASE_URL` — optional; defaults to Mem0 cloud; set to your self-hosted API base.  
- `OPENAI_BASE_URL` / `LITELLM_BASE_URL` / `OPENROUTER_BASE_URL` — optional; use with `LITELLM_API_KEY` or `OPENROUTER_API_KEY` for gateway routing.  
- `IMESSAGE_DM_ALLOWLIST=1` and `IMESSAGE_PEER=+1...` or `IMESSAGE_PEERS=+1...,admin1@wekruit.com` — optional; only process DMs from those peers.  
- `USE_PLATFORM_FIREBASE=0` — skip Firestore; echo-only mode.  
- `PA_LLM_KILL_SWITCH=1` — env-level kill switch (blocks LLM; same effect as `pa_remote_config/platform.llmKillSwitch` in Firestore).  
- `PA_WELCOME_TEXT` — sent once on start if `PA_SEND_WELCOME_ON_START=1` and at least one peer is configured.  
- `PA_IMESSAGE_SESSION_KEY` — omit (default) to key 1:1 sessions by **E.164**; set to `chatid` to use Apple’s per-thread id (legacy).  
- Outbound queue: the worker listens to **`pa_outbound`** and sends iMessage for each `pending` row (see [ARCHITECTURE.md](../../ARCHITECTURE.md)). ATM / Infisical: [config/ATM.md](../../config/ATM.md), [config/ENV.md](../../config/ENV.md).

Firestore collections are namespaced: `pa_users`, `pa_sessions`, `pa_messages`, `pa_agents`, `pa_remote_config`, `pa_outbound` (see [ARCHITECTURE.md](../../ARCHITECTURE.md)).

## Run

```bash
cd apps/macos-imessage-worker
npm run start
```

## Full disk access

The process needs **Full Disk Access** to read `~/Library/Messages/chat.db`.
