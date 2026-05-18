# Mem0 (optional, self-host)

The PA runtime can call Mem0 when an agent’s **`memoryMode`** is `mem0` or `both` (see [ENV.md](ENV.md) and `packages/pa-memory`).

## What you need to self-host Mem0

1. A running **Mem0 API** (official Docker/helm or your deployment) with a **base URL** and **API key**.
2. On the runtime/functions environment (not the browser):
   - `MEM0_API_KEY`
   - `MEM0_BASE_URL` (e.g. `https://mem0.your-lan` or `http://127.0.0.1:8000` if local)
3. In **Firestore** (`pa_agents`), set **`memoryMode`** to `mem0` or `both` for that agent.
4. If Mem0 is down, runtime logs **degraded** and can continue in **firestore-only**-style behavior depending on code paths — for a predictable POC, use **`firestore_only`** until Mem0 is stable.

**Dashboard** does not host Mem0; it only edits agent fields. No extra `VITE_*` keys are required for Mem0.

For deployment specifics, use Mem0’s own docs; this repo does not pin a Mem0 version.

## Fly.io (same pattern as other VALET-style services)

We don’t run `fly deploy` from the assistant in your account; you `fly auth login` locally, then:

1. In a small repo or folder, add a `Dockerfile` (or `fly.toml` + `[[services]]`) that runs the **Mem0 server image** you choose — follow [Mem0 self-hosting](https://github.com/mem0ai/mem0) for the exact image/ports.  
2. `fly launch` in that app directory, set region, scale to 1 shared-CPU machine if the POC is light.  
3. `fly secrets set MEM0_API_KEY=...` (and any env Mem0 expects: DB URL, etc.).  
4. After deploy, `https://<your-mem0-app>.fly.dev` (or a custom domain) is your runtime `MEM0_BASE_URL`.
5. Ensure deployed runtime can reach the Fly app.

Troubleshooting: if health checks fail, match Mem0’s **listen host** to `0.0.0.0` in the container and the **internal port** in `fly.toml` `[[services]] internal_port`.
