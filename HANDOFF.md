# PA Productionization — Handoff (2026-04-25)

## Where to work

- **Repo:** `/Users/adam/Desktop/WeKruit/wekruit-pa`
- **Branch / worktree:** `claude/agitated-chatelet-cc4d5b` at `.claude/worktrees/agitated-chatelet-cc4d5b`
- The old `/Users/adam/Desktop/WeKruit/Jobless` directory is GONE. Snapshots live as remote tags `jobless-archived-20260424` and `jobless-pre-port-snapshot-20260424-231852` on `https://github.com/WeKruit/Claude-Code-Source.git`. Don't recreate Jobless.
- Firebase project: `wekruit-5f89b`
- Cloud Function: `pa-orchestrator:onPaInbound` (Gen2, us-central1, nodejs20)
- Qdrant: Fly app `qdrant-wekruit` at `https://qdrant-wekruit.fly.dev`

## Architecture (no polling)

```
Mac iMessage chat.db
  → macos-imessage-worker  (apps/macos-imessage-worker, runs on user's Mac)
    → Firestore pa_inbound_events
      → CF onPaInbound (apps/functions, event-driven)
        → @pa/pa-orchestrator
          → @pa/agent-runtime  (LLM via SiliconFlow OpenAI-compat)
          → @pa/memory          (Mem0 OSS + Qdrant + bge-m3 embeddings)
          → Firestore pa_messages, pa_memory_facts
        → Firestore pa_outbound
          → macos-imessage-worker outbox listener (Mac)
            → real iMessage send
```

Memory model is two-layer: Firestore canonical (transcript + confirmed facts) + Mem0/Qdrant semantic (implicit, no `记住` prefix needed). The `记住 / 我的记忆 / forget` commands still work as explicit entry points (see `packages/memory/src/commands.ts`).

## What just landed (prior commit `398a9b7`)

1. Ported entire Jobless delta into wekruit-pa: new `@pa/pa-orchestrator` package, `apps/functions` CF wrapper, mem0-OSS integration in `@pa/memory`, all macos-imessage-worker modules, smoke scripts.
2. Outbox hard-allowlist in `apps/macos-imessage-worker/src/outbox.ts`:
   - `KNOWN_FAKE_RECIPIENTS` set (`+19990000000`, `+10000000000`, `+1`) — instant block.
   - `isFakeOrUnknownRecipient(db, toE164)` queries `pa_inbound_events` and refuses send unless recipient previously messaged us.
   - Bypass for cold-start with `PA_OUTBOUND_SKIP_INBOUND_CHECK=1`.
3. `scripts/pa-smoke.mjs` now requires `PA_SMOKE_FROM_E164` env, validates E.164, refuses placeholder numbers.
4. `firebase.json` declares `pa-orchestrator` codebase with predeploy build chain.
5. esbuild banner shim for `__filename` / `createRequire` in `apps/functions/build.mjs` keeps mem0ai/oss CommonJS deps working under ESM bundle.
6. CF deployed (revision `onpainbound-00003-vuc`). Smoke against real handle `admin1@wekruit.com` produced `pa_outbound` doc `affad872` with status=sent.
7. Cleaned 9 stale `+19990000000` / `+1` docs in `pa_outbound`.

## Verified working

- TS compiles: `npm run build` from repo root (all 6 workspaces).
- esbuild bundle: `cd apps/functions && npm run build` produces `lib/index.js` (~11MB) with `__filename` shim.
- CF deploys: `firebase deploy --only functions:pa-orchestrator --project wekruit-5f89b`.
- E2E inbound → CF → outbound: insert `pa_inbound_events` doc with real handle, CF processes within ~30s, `pa_outbound` row appears with status=sent.
- Outbound allowlist hard-blocks fake numbers — see logs from previous CF revisions.

## Fixed: BUG-1 `400 invalid model ID` (Mem0 embedder host)

**Root cause:** `mem0ai` merges embedder `baseURL` from user config only. Blank `MEM0_LLM_BASE_URL` / `MEM0_EMBED_*` env values became `""`, which bypassed `??` defaults and left the OpenAI SDK on **api.openai.com** while `model` was still **`BAAI/bge-m3`** → OpenAI returned `400 invalid model ID`. Chat LLM could still work when `OPENAI_BASE_URL` was set, hiding the bug.

**Code changes (this worktree):**
- `packages/memory/src/mem0.ts` — `normalizeOpenAiCompatBaseUrl` + `normalizeMem0RuntimeConfig` so empty strings never reach Mem0; embedder + LLM always share a non-empty SiliconFlow-compatible base.
- `packages/memory/src/stacked.ts` — `envTrim` for all Mem0 env keys; `MEM0_LLM_BASE_URL` falls back to `OPENAI_BASE_URL` when unset so CF and local orchestrator stay aligned.
- `apps/functions/src/index.ts` — after secrets bind, force non-empty `OPENAI_BASE_URL`, `MEM0_LLM_BASE_URL`, `MEM0_LLM_MODEL`, `MEM0_EMBED_MODEL`, `MEM0_EMBED_DIMS` defaults matching SiliconFlow.
- `packages/agent-runtime/src/openai-provider.ts` — trim `OPENAI_BASE_URL` / strip trailing `/`; ignore empty string.
- `packages/agent-registry/src/seed.json` — default `model` aligned to `Qwen/Qwen2.5-72B-Instruct` (still `provider: "openai"`).
- `config/firebase/firestore.indexes.json` — composite `pa_outbound`: `userId` ASC + `createdAt` DESC for operator queries.

**Verify after deploy:**
1. `curl` chat + embeddings against SiliconFlow with the same model strings (use `firebase functions:secrets:access SILICONFLOW_API_KEY`, do not paste keys into chat).
2. `firebase deploy --only functions:pa-orchestrator --project wekruit-5f89b` then trigger inbound; CF logs must **not** contain `invalid model`.
3. `curl -s -H "api-key: $QDRANT_API_KEY" https://qdrant-wekruit.fly.dev/collections` — expect `pa_memory` (or your `MEM0_QDRANT_COLLECTION`) after first successful `mem0` / `both` writeback.
4. Firestore `pa_agents/default` must use `memoryMode: "mem0"` or `"both"` for semantic writeback; `firestore_only` skips Mem0 by design.

## Known follow-ups

### 1. Mac worker not running on user's machine (probably)

The CF writes `pa_outbound` rows correctly. The Mac worker (`apps/macos-imessage-worker`) is what reads those rows and triggers the actual iMessage send. If user reports "PA isn't replying," check whether the worker is running locally and connected to Firestore.

- Start: `npm --prefix apps/macos-imessage-worker run dev` (needs `FIREBASE_SERVICE_ACCOUNT_JSON` and iMessage permissions).
- The screenshot of "+1 (999) 000-0000" delivery failures was the worker dutifully trying to deliver the smoke-test fake numbers. That class of bug is now hard-blocked at the outbox layer, but you should still verify the user's Mac worker is up before claiming "it works."

### 2. Deploy Firestore indexes

`config/firebase/firestore.indexes.json` now includes `pa_outbound` + `userId` + `createdAt` DESC. Deploy when convenient:

`firebase deploy --only firestore:indexes --project wekruit-5f89b`

## How to check things

```bash
# CF logs
firebase functions:log --only onPaInbound --project wekruit-5f89b --lines 60

# Most recent inbound events / outbound
node -e '... use /tmp/sa2.json with admin SDK ...'   # see Section "ADC quirks" below

# Qdrant collections
QDRANT_API_KEY=$(firebase functions:secrets:access QDRANT_API_KEY --project wekruit-5f89b)
curl -s -H "api-key: $QDRANT_API_KEY" https://qdrant-wekruit.fly.dev/collections

# Trigger E2E (requires real handle)
PA_SMOKE_FROM_E164=+1XXXXXXXXXX node scripts/pa-smoke.mjs
```

## ADC quirks

If `firebase login` is unavailable / non-interactive and ADC has expired, the running orchestrator process embeds `FIREBASE_SERVICE_ACCOUNT_JSON` in its env. Recover it:

```bash
ps eww <PID-of-orchestrator-or-mac-worker> | python3 -c '
import sys, re, json
text = sys.stdin.read()
m = re.search(r"FIREBASE_SERVICE_ACCOUNT_JSON=(\{.+?\})\s+\w+=", text)
print(m.group(1))' > /tmp/sa2.json
```

Then `cert(JSON.parse(fs.readFileSync("/tmp/sa2.json")))` for `firebase-admin`.

## Don't repeat past mistakes

- **Repo confusion:** Earlier sessions worked in `/Users/adam/Desktop/WeKruit/Jobless` instead of wekruit-pa. That repo is gone. Always work in `/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/agitated-chatelet-cc4d5b`.
- **Don't poll Firestore.** The architecture is event-driven via CF Gen2 onDocumentCreated trigger. Don't add a polling worker.
- **Don't mock LLM in tests that we plan to ship.** The user explicitly wants real Mem0/Qdrant integration tested.
- **Don't add `记住` / `forget` prefix requirement to default flow.** Implicit extraction is the contract.
- **Provider zod schema** is `openai | azure_openai | anthropic | other`. SiliconFlow uses `provider: "openai"` with custom `OPENAI_BASE_URL`. Don't add `siliconflow` as a literal — the seed file in jobless once had this and the CF rejected it.

## Rotated credentials reminder

The user pasted `SILICONFLOW_API_KEY` in earlier chat. It's now stored as a Firebase secret (`firebase functions:secrets:access SILICONFLOW_API_KEY`). The leaked literal in chat history should be rotated when convenient.
