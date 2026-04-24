# ATM (on-site) → OpenAI for Jobless (macOS worker)

The worker matches **VALET’s pattern** for Anthropic/ATM: a bearer-authenticated `GET` to your ATM host returns an LLM runtime profile JSON. Jobless reuses the same `ATM_BASE_URL` and **service token** family as vCode / other WeKruit apps.

## Required for outbound LLM (prod)

| Variable | Purpose |
|----------|--------|
| `ATM_BASE_URL` | e.g. `https://your-atm` (no trailing slash) |
| `VALET_ATM_TOKEN` *or* `PA_ATM_TOKEN` *or* `ATM_SERVICE_TOKEN` | Bearer for `/internal/...` |

## Profile URL

- Default: `GET {ATM_BASE_URL}/internal/llm-runtime-profiles/personal-assistant-default`
- Override: `PA_ATM_LLM_RUNTIME_URL` (full URL) or `PA_ATM_LLM_PROFILE_PATH` (path only, combined with `ATM_BASE_URL`)

## Response shape (from ATM / adapter)

The worker expects a JSON object with at least:

- `apiKey` (string) → sets `process.env.OPENAI_API_KEY`
- optional `apiBase` / `api_base` / `baseUrl` / `api_base_url` / `url` / `apiUrl` / `api_url` / `apiEndpoint` / `api_endpoint` → `OPENAI_BASE_URL`
- optional `defaultModel` / `default_model` / `model` → `PA_ATM_DEFAULT_MODEL` (if your `runAgentTurn` / registry reads it)

## Cache and disable

- Re-fetch is rate-limited to **~5 minutes** in-process after a successful hydration.
- `PA_ATM_DISABLE=1` (or `ATM_DISABLE=1`): do not call ATM; use only `OPENAI_*` and `FIREBASE_*` from your env (e.g. Infisical on the Mac).
- If `ATM_BASE_URL` and token are **missing**, the worker leaves existing `OPENAI_API_KEY` (from shell or `apps/macos-imessage-worker/.env`).

## Infisical on the Mac

Same as other WeKruit workers: run `infisical run -- env` or a LaunchAgent that runs `infisical run -- npx --yes tsx src/index.ts` with paths pointing at the worker. Inject `FIREBASE_SERVICE_ACCOUNT_JSON` (or path), `ATM_BASE_URL` + `VALET_ATM_TOKEN`, and optionally Google/Firebase client vars for other tooling.

## Related

- `config/ENV.md` — full env matrix.
- `packages/agent-runtime/src/atm-llm-runtime.ts` — implementation.
