# Operations runbook (24/7 Mac worker)

1. **Host** — A dedicated Mac mini or Mac Studio stays signed into Messages (iMessage) and runs `apps/macos-imessage-worker` under `launchd` or a process manager (pm2, forever).
2. **Secrets** — Store `google-services` JSON and `OPENAI_API_KEY` in the user keychain or a root-only file; `chmod 600` the service account path; never commit secrets.
3. **Logs** — Redirect stdout/stderr to rotated logs (`logrotate` or `newsyslog`); include timestamps (worker already logs ISO time).
4. **Failure modes** — If Mem0 or OpenAI is down, the worker logs errors and may send a user-visible apology; Mem0 is best-effort and degrades to transcript-only.
5. **Firebase** — Service account for the worker must have Firestore access; deploy `config/firebase/firestore.rules` / indexes when you ship; operator access is by **email** in rules (`@wekruit.com` + allowlist in `isPaOperator()`).
6. **Upgrades** — `npm update` at repo root, rebuild packages, restart worker; run `npm run build` in `packages/*` if you publish from `dist/`.
7. **PII** — `messages` and `users` contain phone numbers; restrict dashboard access; enable Firebase App Check for web if exposed publicly.

## Brokered production mode

Production target is two processes:

```bash
# Terminal/process 1: channel adapter only
cd apps/macos-imessage-worker
PA_BROKER_MODE=primary npm run start

# Terminal/process 2: runtime brain
npm run orchestrator
```

Use `PA_BROKER_MODE=shadow` during migration to write durable inbound events while preserving the old direct worker path. Operators debug lifecycle state in Dashboard → Operations.
