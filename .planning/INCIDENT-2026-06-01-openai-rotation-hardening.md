gh is authenticated as `admin-wekruit`. Both stale backup files exist on disk holding the dead key. Core-service path confirmed. I have what I need.

# OpenAI Key Rotation + Hardening Plan (2026-06-01)

> **Context:** On 2026-06-01 OpenAI auto-revoked the org's shared OpenAI API key (old prefix `sk-proj-vPA789w…`), causing a system-wide outage. A new key (`sk-proj-fFdZ4aL7…`) was minted and is already live in `wekruit-pa/.env`. This doc closes out the rotation across every surface, scrubs the dead key, and hardens the topology so a single revoke can never take the whole platform down again.
>
> **Scope discipline:** Sections 2 (EXECUTE NOW) are commands the agent can safely run today. Section 3 (ADAM-ONLY) needs a login/box/dashboard the agent does not have. No secret is ever printed beyond the `sk-proj-XXXXXXXX…` prefix.

---

## 1. CURRENT STATE — every OpenAI-key surface

**Live (good) key prefix:** `sk-proj-fFdZ4aL7…`  •  **Dead (auto-revoked) key prefix:** `sk-proj-vPA789w…`
Project: `wekruit-5f89b` • all three Secret Manager names live in this ONE project.

| # | Surface | Var | State | Action |
|---|---------|-----|-------|--------|
| 1 | `wekruit-pa/.env` (lines 29-30) | `OPENAI_API_KEY` | **NEW** ✅ | None — already rotated. |
| 2 | `wekruit-pa/.env` (lines 29-30) | `PA_OPENAI_AGENT_API_KEY` | **NEW** ✅ | None — already rotated. |
| 3 | **`wekruit-pa/.env.bak.1780361884`** | `OPENAI_API_KEY` + `PA_OPENAI_AGENT_API_KEY` | 🔴 **OLD (DEAD KEY ON DISK)** | **Scrub** — §2 step A. File confirmed present (5105 B, Jun 1). |
| 4 | **`/Users/adam/wekruit-matching/.env`** (mode 600, in-use locally) | `OPENAI_API_KEY` | 🔴 **OLD (DEAD KEY, ACTIVE LOCAL ENV)** | **Replace** with rotated key — §2 step B. `.infisical.json` `defaultEnvironment` is empty, so this local `.env` is what the matching repo actually uses today → it is currently running on a dead key. |
| 5 | **`/Users/adam/wekruit-matching/.env.bak`** | `OPENAI_API_KEY` | 🔴 **OLD (DEAD KEY ON DISK)** | **Scrub** — §2 step A. File confirmed present (3992 B, May 27). |
| 6 | Secret Manager `PA_OPENAI_AGENT_API_KEY` (proj `wekruit-5f89b`, codebase `pa-orchestrator`, ~18 fns) | `PA_OPENAI_AGENT_API_KEY` | **UNKNOWN** | Adam reads versions (§3); confirm latest ENABLED = rotated key; disable old version after live-verify. |
| 7 | Secret Manager `OPENAI_API_KEY` (same proj, legacy fallback read by `packages/agent-runtime/src/env.ts` → `PA_OPENAI_AGENT_API_KEY \|\| OPENAI_API_KEY`, and `openai-provider.ts`) | `OPENAI_API_KEY` | **UNKNOWN** | Adam confirms latest ENABLED = rotated key; disable stale version. Candidate to retire (§5). |
| 8 | Secret Manager `MATCHING_OPENAI_API_KEY` (same proj, codebase `core-service`) | `MATCHING_OPENAI_API_KEY` | **UNKNOWN** | **Agent CAN finish this** via firebase-tools (CLI is authed) — §2 step C: set new version + redeploy `matching-api`. |
| 9 | GitHub Actions secret — `wekruit-pa` (`.github/workflows/eval.yml:43`) | `PA_OPENAI_AGENT_API_KEY` | **UNKNOWN** | **Agent CAN set** via `gh` (authed as `admin-wekruit`) — §2 step D. |
| 10 | GitHub Actions secret — `wekruit-matching` (`.github/workflows/daily-scrape.yml`) | `OPENAI_API_KEY` | **UNKNOWN** | **Agent CAN set** via `gh` — §2 step D. |
| 11 | macmini physical box (`wekruit-matching` python pipeline `.env`, SSH user `wekruitclaw1`) | `OPENAI_API_KEY` | **UNKNOWN** | **Adam-only** — box unreachable from here; SSH + edit + restart launchd — §3. |
| 12 | Infisical upstream (`wekruit-matching` workspace `afe448bb-70d6-43a3-850b-5c327595a72d`, prod `/jobless/*`) | `OPENAI_API_KEY` (canonical) | **UNKNOWN** | **Adam-only** — web/CLI login — §3. |
| 13 | `wekruit-pa/apps/functions/.env` | (none — only `OPENAI_AGENTS_DISABLE_TRACING`) | n/a | No action — carries no OpenAI key value. |
| 14 | All `.env.template` / `.env.example` / `.claude/worktrees/*` / core-service `.env.*` | placeholder `sk-...` only | n/a | No action — placeholders only, no real key anywhere. |

### Surfaces that STILL hold the DEAD key (the cleanup queue)
1. 🔴 **`wekruit-pa/.env.bak.1780361884`** — dead key, both vars (scrub).
2. 🔴 **`/Users/adam/wekruit-matching/.env`** — dead key, **actively used** by the local matching repo (replace → highest functional impact, matching is running dead).
3. 🔴 **`/Users/adam/wekruit-matching/.env.bak`** — dead key (scrub).

Everything labeled **UNKNOWN** is a Secret-Manager / GitHub / macmini / Infisical surface that cannot be *read* from disk — it must be confirmed by whoever holds that login. Items 8, 9, 10 are UNKNOWN-but-the-agent-can-finish; items 6, 7, 11, 12 require Adam.

---

## 2. EXECUTE NOW — commands the agent can safely run to finish rotation

> Ordering rule (from the rotation design): **set new secret version FIRST → redeploy SECOND → disable old version LAST** (after live-verify), so in-flight invocations never 401.
> Prereq for any key value: obtain the rotated `sk-proj-fFdZ4aL7…` value from `wekruit-pa/.env` (already on disk) — never echo it; pipe via stdin / `--data-file=-`.

### A. Scrub the two stale dead-key backups (no live dependency — safe)
```bash
rm -f /Users/adam/Desktop/WeKruit/wekruit-pa/.env.bak.1780361884
rm -f /Users/adam/wekruit-matching/.env.bak
# verify gone:
ls -la /Users/adam/Desktop/WeKruit/wekruit-pa/.env.bak.1780361884 /Users/adam/wekruit-matching/.env.bak 2>&1
```

### B. Replace the dead key in the active matching `.env` (in-place, timestamped backup, no echo)
```bash
# pull the rotated value once into a shell var WITHOUT printing it:
NEWKEY="$(grep -E '^OPENAI_API_KEY=' /Users/adam/Desktop/WeKruit/wekruit-pa/.env | head -1 | cut -d= -f2-)"
case "$NEWKEY" in sk-proj-*) :;; *) echo 'refusing: did not resolve an sk-proj- key'; return 1 2>/dev/null || exit 1;; esac
# back up, then rewrite the OPENAI_API_KEY line in matching/.env:
cp /Users/adam/wekruit-matching/.env "/Users/adam/wekruit-matching/.env.rotbak.$(date +%s)"
tmp="$(mktemp)"; awk -v k="$NEWKEY" '/^OPENAI_API_KEY=/{print "OPENAI_API_KEY=" k; next} {print}' /Users/adam/wekruit-matching/.env > "$tmp" && mv "$tmp" /Users/adam/wekruit-matching/.env
chmod 600 /Users/adam/wekruit-matching/.env
# verify ONLY the prefix:
grep -E '^OPENAI_API_KEY=' /Users/adam/wekruit-matching/.env | sed -E 's/(sk-proj-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1…REDACTED/'
unset NEWKEY
```
> Note: this fixes the *local* matching repo only. If the matching repo should be Infisical-sourced (Design B, §5), the durable fix is to wire `infisical run` instead — but `.infisical.json` `defaultEnvironment` is empty today, so the local `.env` is authoritative and must be corrected now.

### C. Core-service `MATCHING_OPENAI_API_KEY` — set + deploy (firebase-tools is authed; gcloud ADC is NOT — use firebase-tools)
```bash
# 1) set new secret version (creates ENABLED version, auto-disables prior) — value piped via stdin:
cd /Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function && \
  grep -E '^OPENAI_API_KEY=' /Users/adam/Desktop/WeKruit/wekruit-pa/.env | head -1 | cut -d= -f2- | \
  npx -y firebase-tools functions:secrets:set MATCHING_OPENAI_API_KEY --project wekruit-5f89b --data-file -

# 2) redeploy ONLY the sole binding function so the new version pins (deploy-time pin) — core-service has NO default project, pass -P/--project:
cd /Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function && \
  npx -y firebase-tools deploy --only functions:core-service:matching-api --project wekruit-5f89b --non-interactive

# 3) verify ENABLED + no auth errors in logs:
cd /Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function && npx -y firebase-tools functions:secrets:get MATCHING_OPENAI_API_KEY --project wekruit-5f89b
cd /Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function && npx -y firebase-tools functions:log --only matching-api --project wekruit-5f89b | grep -iE 'invalid_api_key|incorrect api key|401|AuthenticationError' || echo 'no auth errors in recent logs'
```
> Binding verified in source: `defineSecret('MATCHING_OPENAI_API_KEY')` at `src/bootstrap/secrets.ts:17`; in `matchingSecrets[]`; bound at `src/services/matching/functions/http/api.ts:988`; read at `application/runtime.ts:35`; consumed by `MatchingEmbeddingService` (`text-embedding-3-small`). It binds to exactly ONE function (`matching-api`) — do not redeploy the whole codebase, and do NOT touch the `pa*Matching*` functions (those are the separate nodejs24 `pa-orchestrator` codebase, they do not bind this secret).

### D. GitHub Actions secrets — set via `gh` (authed as `admin-wekruit`, confirmed)
```bash
# wekruit-pa eval.yml → PA_OPENAI_AGENT_API_KEY
grep -E '^PA_OPENAI_AGENT_API_KEY=' /Users/adam/Desktop/WeKruit/wekruit-pa/.env | head -1 | cut -d= -f2- | \
  gh secret set PA_OPENAI_AGENT_API_KEY --repo admin-wekruit/wekruit-pa --body -

# wekruit-matching daily-scrape.yml → OPENAI_API_KEY
grep -E '^OPENAI_API_KEY=' /Users/adam/Desktop/WeKruit/wekruit-pa/.env | head -1 | cut -d= -f2- | \
  gh secret set OPENAI_API_KEY --repo admin-wekruit/wekruit-matching --body -

# verify names/updated timestamps (values are write-only and never displayed):
gh secret list --repo admin-wekruit/wekruit-pa
gh secret list --repo admin-wekruit/wekruit-matching
```
> Resolve the exact repo owner/slug first if `admin-wekruit/...` 404s: `gh repo list admin-wekruit --limit 100 | grep -iE 'wekruit-pa|wekruit-matching'`. The investigation cited `<owner>/...` — `admin-wekruit` is the authenticated account; confirm the org owner if the repos live under a `wekruit` org rather than the user.

### E. Pre-rotation read-only checks (optional, safe to run before C)
```bash
cd /Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function && npx -y firebase-tools functions:secrets:get MATCHING_OPENAI_API_KEY --project wekruit-5f89b
# (gcloud ADC is expired — invalid_grant — so `gcloud secrets versions list` will fail until Adam re-auths; firebase-tools above is the working path)
```

---

## 3. ADAM-ONLY — surfaces needing a login/box the agent lacks

| Surface | What's blocked | Exact unblock |
|---|---|---|
| **Firebase Secret Manager versions** (`PA_OPENAI_AGENT_API_KEY`, `OPENAI_API_KEY`, `MATCHING_OPENAI_API_KEY`) | `gcloud` ADC is expired (`invalid_grant`); the only resolvable SA in `.env` (`livekit-tts-service-account@wekruit-5f89b`) is **denied** `secretmanager.versions.list`. Agent can *write+deploy* via firebase-tools but cannot *enumerate/disable old versions*. | `gcloud auth application-default login` (or activate a Secret-Manager-capable SA), then: `gcloud secrets versions list PA_OPENAI_AGENT_API_KEY --project=wekruit-5f89b --format='table(name,state,createTime)'` (repeat for `OPENAI_API_KEY`, `MATCHING_OPENAI_API_KEY`). Confirm latest ENABLED = rotated key; **disable the old version LAST**, after live-verify: `gcloud secrets versions disable <OLD_VERSION> --secret=PA_OPENAI_AGENT_API_KEY --project=wekruit-5f89b`. |
| **macmini box** (`OPENAI_API_KEY` in `wekruit-matching` pipeline `.env`) | Physical box, offline/unreachable from this machine; runs locally (NOT firebase) under launchd. | `ssh wekruitclaw1@<macmini>`; edit the pipeline `.env` `OPENAI_API_KEY` → rotated key; restart the launchd job (`launchctl kickstart -k gui/$(id -u)/<pipeline-label>` or the project's documented restart). Confirm next scrape run authenticates. Design B (§5) eliminates this surface by injecting via `infisical run`. |
| **Infisical** (prod `/jobless/*`, canonical upstream) | Requires Infisical web/CLI login the agent doesn't hold. This is the intended single paste-point in the durable design. | `infisical login`; update `OPENAI_API_KEY` in prod `/jobless/*` to the rotated key. (Note: matching's `.infisical.json` `defaultEnvironment` is empty, so this does NOT auto-propagate today — the local `.env` fix in §2.B is still required until Design B is wired.) |
| **OpenAI dashboard** (mint/revoke) | Owner-only platform action. | The rotated key already exists. **AFTER all surfaces are live-verified**, revoke/disable the OLD `sk-proj-vPA789w…` key at platform.openai.com (do this LAST). Also create the per-project keys in §4. |
| **PA functions redeploy** (`pa-orchestrator`, ~18 OpenAI-bound fns) | Per CLAUDE.md deploy rules + MEMORY "deploy only when asked": redeploying the 18 pa-orchestrator fns to pick up a new `PA_OPENAI_AGENT_API_KEY`/`OPENAI_API_KEY` Secret Manager version is an Adam-gated deploy (and hits the known us-central1 memory quota ceiling). | When Adam approves: `cd apps/functions && pnpm run deploy`; on partial-quota failure, retry per-fn: `firebase deploy --only functions:pa-orchestrator:paFoo`. The 18 OpenAI-bound fns MUST land. (Only needed if those Secret Manager versions aren't already rotated — confirm in step 1 above first.) |

---

## 4. CAN WE DISABLE OPENAI'S AUTO-REVOKE?

**Short answer: No — and you shouldn't try.** The auto-disable that killed `sk-proj-vPA789w…` is OpenAI's **leak/compromise revocation** (public-internet + GitHub secret-scanning + app-store leak detection, plus ToS/suspicious-activity). It is a non-negotiable platform safety control: **there is no opt-out and no dashboard toggle.** *(Corroborated across OpenAI dev-community + billing sources; the canonical Help Center page 403s bots, so treat as well-corroborated-but-verify-in-dashboard.)*

Two things people *conflate* with auto-revoke but which do **NOT** kill a key:
- **Rate limits** → HTTP **429**, key stays alive.
- **Exhausted credits/budget** → billing error, key stays alive.

**2026 gotcha:** the per-project **"Monthly budget" is now NOTIFICATION-ONLY** (soft) — it emails/alerts but does **not** hard-stop spend. The **only real hard spend cap today is your prepaid credit balance with auto-recharge OFF** — and that balance is **org-wide**, not per-project, so a per-project runaway can still drain the shared pool. That is exactly why **project topology** is the real defense.

### The actual levers (what you CAN do)
1. **Never trip the leak-detector** (the only thing that truly disables a key):
   - Restricted, project-scoped `sk-proj-` keys (auto-scoped to one project).
   - Pre-commit secret scanning (`gitleaks`) + GitHub **secret scanning + push protection ON**.
   - Env-only storage; rotate on any exposure. (This rotation's #1 root-cause mitigation.)
2. **Shrink blast radius** so one revoke ≠ whole-system outage. Today the repo runs **one shared key** (`OPENAI_API_KEY == PA_OPENAI_AGENT_API_KEY`, same `sk-proj-fFdZ4aL7…`) behind *every* service — conversation, cv-ingest, matching/nightly-rerank, enrichment, embeddings, pitch-email. **Split it.**

### Recommended OpenAI topology — 4 projects, 4 restricted keys
| Project | Owns | Restricted to (model allowlist) | Why isolated |
|---|---|---|---|
| `proj-pa-conversation` | live iMessage / agent-runtime (`PA_OPENAI_AGENT_API_KEY`) | responses/chat models only | User-facing, highest criticality — batch jobs must never throttle/revoke it. |
| `proj-matching` | matching + nightly-rerank + embeddings | embeddings + rerank chat only | Highest runaway-loop risk (batch). Isolate its rate limit + alert here. |
| `proj-enrichment` | scraping / job-enrichment / cv-ingest / bulk-resume-intake | enrichment models only | Bursty bulk intake. |
| `proj-pitch-email` | external-supply pitch-email generation | content-gen models only | A campaign blow-up can't drain the conversation path. |

### Dashboard steps (Adam, Owner role)
1. **platform.openai.com → org/project switcher (top-left) → "Create project"** → create the 4 projects above.
2. **Per project → API keys → "Create new secret key" → Permissions = "Restricted"** → grant ONLY that service's model endpoints. (`sk-proj-` keys auto-scope to the one project.)
3. **Per project → Limits → set per-project Rate limits** (Owner-only) so one project can't starve another; set **Monthly budget as an ALERT only** (it's soft in 2026) — **"Add alert"** at 50% / 80% / 100%.
4. **Org-wide HARD cap (the only real one): Settings → Billing → turn Auto-recharge OFF** (or set a low monthly-recharge cap); keep the prepaid balance modest so a runaway drains a known ceiling, not an open card.
5. **GitHub: repo Settings → Code security → confirm secret scanning + push protection ON** for `wekruit-pa` and `wekruit-matching` — this is what actually keeps keys out of git and prevents the leak auto-revoke.
6. **Rotation order:** create the 4 per-service keys → wire as Firebase secrets / `.env` → deploy → **only then** retire the shared `sk-proj-fFdZ4aL7…` key. **Never delete the shared key first.**

### Where each new key lands (names only — values from Adam)
```bash
PA_OPENAI_AGENT_API_KEY=<proj-pa-conversation restricted key>   # apps/functions secret (Firebase)
OPENAI_API_KEY_MATCHING=<proj-matching restricted key>
OPENAI_API_KEY_ENRICHMENT=<proj-enrichment restricted key>
OPENAI_API_KEY_PITCH=<proj-pitch-email restricted key>
```
> Splitting names also lets you finally retire the legacy `OPENAI_API_KEY` Secret Manager name (item #7) — consolidate the fallback in `packages/agent-runtime/src/env.ts` (`PA_OPENAI_AGENT_API_KEY || OPENAI_API_KEY`) and `openai-provider.ts` to drop one surface.

### Install pre-commit + history scanning now (agent-safe, read-only scan)
```bash
brew install gitleaks
gitleaks git --no-banner --redact -v /Users/adam/Desktop/WeKruit/wekruit-pa   # scan history for any committed keys
gitleaks git --pre-commit --redact -v                                          # enable pre-commit hook
```

---

## 5. REPEATABLE ROTATION — one-command script + token-spike early warning

### Design A (ship now): `scripts/rotate-openai-key.sh`
One operator-run script reads the NEW key from **stdin** (never argv/history), pushes to the 4 automatable surfaces, redeploys both codebases, and prints the 3 manual steps. All three Secret Manager names live in one project (`wekruit-5f89b`), so it's 3 `functions:secrets:set` + 2 redeploys. **Redeploy is mandatory** because Firebase pins the secret *version* at deploy time — setting a new version does nothing until referencing functions redeploy.

```bash
#!/usr/bin/env bash
set -euo pipefail
# Usage: bash scripts/rotate-openai-key.sh   (reads NEW key from stdin — never lands in history/argv)
PROJECT=wekruit-5f89b
PA_DIR=/Users/adam/Desktop/WeKruit/wekruit-pa
CS_DIR=/Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function
read -rs -p 'Paste NEW OpenAI key (sk-proj-...): ' NEWKEY; echo
case "$NEWKEY" in sk-proj-*) :;; *) echo 'refusing: not an sk-proj- key'; exit 1;; esac
set +x  # never trace the value
source ~/.zshrc && nvm use 24

# 1) Secret Manager: 3 names, 1 project (stdin, --data-file=-)
printf '%s' "$NEWKEY" | firebase functions:secrets:set PA_OPENAI_AGENT_API_KEY --project "$PROJECT" --data-file=-
printf '%s' "$NEWKEY" | firebase functions:secrets:set OPENAI_API_KEY           --project "$PROJECT" --data-file=-
printf '%s' "$NEWKEY" | firebase functions:secrets:set MATCHING_OPENAI_API_KEY  --project "$PROJECT" --data-file=-

# 2) Local .env (timestamped backup, in-place, no echo)
cp "$PA_DIR/.env" "$PA_DIR/.env.bak.$(date +%s)"
tmp=$(mktemp); awk -v k="$NEWKEY" \
  '/^OPENAI_API_KEY=/{print "OPENAI_API_KEY=" k; next} \
   /^PA_OPENAI_AGENT_API_KEY=/{print "PA_OPENAI_AGENT_API_KEY=" k; next} {print}' \
  "$PA_DIR/.env" > "$tmp" && mv "$tmp" "$PA_DIR/.env"

# 3) Redeploy BOTH codebases so the new VERSION binds (deploy-time pin)
( cd "$PA_DIR/apps/functions" && pnpm run deploy )                                  # Node24 predeploy gate: build+typecheck+test+smoke
( cd "$CS_DIR" && npx -y firebase-tools deploy --only functions -P production )     # core-service has NO default project → -P production

# 4) GitHub Actions (gh is authed)
printf '%s' "$NEWKEY" | gh secret set PA_OPENAI_AGENT_API_KEY -R admin-wekruit/wekruit-pa --body -
printf '%s' "$NEWKEY" | gh secret set OPENAI_API_KEY          -R admin-wekruit/wekruit-matching --body -

# 5) PRINT manual-only steps
cat <<'EOF'
MANUAL (Adam only):
  [Infisical]  Update OPENAI_API_KEY in prod (/jobless/*) — upstream source of truth.
  [macmini]    ssh wekruitclaw1@<macmini>; edit wekruit-matching .env OPENAI_API_KEY; restart launchd pipeline.
  [verify]     after live OK, DISABLE the previous key version + revoke old key in platform.openai.com (LAST).
EOF
echo 'Verify: node apps/functions/scripts/probe-pa-model.mjs  (or a /find_match scenario), then revoke old key.'
unset NEWKEY
```

**Operational notes baked into the script:**
- **Order:** new version → redeploy → disable old version LAST (no in-flight 401s).
- **Deploy quota ceiling** (MEMORY.md): a full `pa-orchestrator` redeploy partially fails on us-central1 Cloud Run memory quota; retry the 18 OpenAI-bound fns per-fn with `--only functions:pa-orchestrator:paFoo`.
- **core-service:** always pass `-P production` (no default in its `.firebaserc`).
- **Never echo the value:** `set +x`, stdin only.

### Design B (durable end-state): Infisical-as-single-source
Stop storing the raw key in 6+ places. Make **Infisical prod `/jobless/*` the ONLY human paste-point**, then `infisical-sync-openai.sh` reads it once (`infisical run -- …`) and fans out to the 3 Secret Manager names + `.env` + redeploys; GitHub via `gh secret set` reading the same value; **macmini pulls via `infisical run` inside its launchd wrapper — eliminating surface #11 entirely** (box stops holding a static `.env` key). Recommend B as target, A as the immediate ship. (Blocker today: matching's `.infisical.json` `defaultEnvironment` is empty — set it so the repo actually pulls from Infisical.)

### Token-spike early-warning (catch a runaway in minutes, not next-day)
**Most robust signal = internal counter** (no OpenAI admin-key dependency, real-time):
- Wrap every OpenAI call in `apps/functions/src/lib/llm-providers.ts` + `packages/agent-runtime` to `FieldValue.increment(usage.total_tokens)` on `pa-usage-rollup/{yyyy-mm-dd}`.
- New scheduled CF in `pa-orchestrator` (`apps/functions/src/openai-usage-poll.ts`):
```ts
export const paOpenAiUsagePoll = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1',
    secrets: [PA_SLACK_ALERT_WEBHOOK] },
  async () => {
    // read pa-usage-rollup/{yyyy-mm-dd}.totalTokens
    // if total > DAILY_TOKEN_ALERT  OR  > SPIKE_MULTIPLIER × trailing-7d median:
    //   postToSlack(PA_SLACK_ALERT_WEBHOOK) ONCE/day via pa-alerts/{yyyy-mm-dd-openai-spike} dedupe,
    //   include today's tokens, threshold, top model, and hint: "rotate: bash scripts/rotate-openai-key.sh"
  });
// Knobs (Firestore remote-config or env): DAILY_TOKEN_ALERT=20000000 ; SPIKE_MULTIPLIER=3 ; ANOMALY_WINDOW_DAYS=7
```
- Reuses the **existing `PA_SLACK_ALERT_WEBHOOK` secret + Slack helper** already scaffolded (Phase 69, `d26b3fa`).
- **Alternative** (if you prefer OpenAI's numbers): poll `GET https://api.openai.com/v1/organization/usage/completions?start_time=<midnightUTC epoch>&bucket_width=1d` — but that endpoint needs an **org ADMIN key** (the `sk-proj-` project key is insufficient) and lags. The internal counter wins on latency and has no admin-key dependency.

### Live-verify hooks (run after any rotation, before revoking old key)
```bash
# PA path:
node /Users/adam/Desktop/WeKruit/wekruit-pa/apps/functions/scripts/probe-pa-model.mjs    # or a /find_match scenario
# core-service path:
cd /Users/adam/Desktop/WeKruit/wekruit-core-service-cloud-function && npx -y firebase-tools functions:log --only matching-api --project wekruit-5f89b | grep -iE 'invalid_api_key|401|AuthenticationError' || echo 'clean'
```

---

### Close-out checklist
- [ ] §2.A scrub `wekruit-pa/.env.bak.1780361884` + `wekruit-matching/.env.bak` (dead key on disk).
- [ ] §2.B replace dead key in `wekruit-matching/.env` (matching is running dead today).
- [ ] §2.C set + redeploy `MATCHING_OPENAI_API_KEY` → `matching-api`.
- [ ] §2.D `gh secret set` for both repos' Actions secrets.
- [ ] §3 Adam: re-auth gcloud ADC → confirm/disable old Secret Manager versions (6,7,8); macmini SSH; Infisical; revoke old OpenAI key LAST.
- [ ] §4 Adam: create 4 projects + restricted keys + per-project alerts + auto-recharge OFF; turn on GitHub secret scanning; `brew install gitleaks` pre-commit.
- [ ] §5 land `scripts/rotate-openai-key.sh` + `paOpenAiUsagePoll` early-warning (Adam-gated deploy).
