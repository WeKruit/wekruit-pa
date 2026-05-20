# GOAL — Matching Quality Launch Blocker

**Created:** 2026-05-20 (mid-session, paused before macmini commit)
**Owner:** Adam
**Status:** ❌ NOT DONE — multiple silent-failure tracks open
**Why this exists:** Pre-launch live audit found that V16's matching quality is gated by silent failures upstream of the matcher. Code-level matching (V16, B5.1, hygiene) is shipped, but the **corpus itself** is broken — synthetic placeholders, missing JD, missing skills, wrong URLs. This doc captures every gap + the definition of "correct" + the SSH/access notes needed to fix from a fresh session.

---

## 1. Current state — what's broken (verified live 2026-05-20)

Pool counts (after W6 paJobPoolHygiene flip already executed):

| Metric | Value | Notes |
|---|---|---|
| `matching-jobs` total | 140,841 | post hygiene |
| Active | 12,351 — 12,473 (drifting w/ macmini sync) | |
| Inactive | 128,368 | |
| W6 hygiene flipped (this session) | 4,618 | 1,029 dead + 0 no-title + 2,920 stale + 669 missing-ats |

**Active-pool quality after hygiene flip — STILL BROKEN**:

| Bug | Count | % active | Root cause |
|---|---|---|---|
| 🚨 `jobDescription IS NULL` | **6,888** | **56%** | macmini JD enrich silently fails / no retry / no backfill |
| 🚨 `jobDescription IS NULL` AND `requiredSkills` empty (zombie) | **2,425** | 19.6% | enrich pipeline broken or unrun |
| 🚨 YC synthetic `roleTitle="Open Engineering Roles"` | **558** | 4.5% | macmini YC scraper iterates `workatastartup.com/companies/{co}` and writes 1 doc per company with literal placeholder title — NOT real job pages |
| `requiredSkills` empty | 2,899 | 23.5% | downstream of JD enrich failure |
| `primaryUrl == atsApplyUrl` (unresolved) | 5,323 | 43% | Serper-backed ATS URL resolver miss or jobright placeholder retained |
| Cross-source company+roleTitle dup | 107 | 0.6% | (was thought to be 10k+ — my title-field bug. Real: tiny) |

**Verified Firecrawl 500 root cause** (concrete log evidence, today 06:25–06:36 UTC):

```
[ScrapeURL] Scrape via playwright deemed unsuccessful
factors: { isLongEnough: false, isGoodStatusCode: true, hasNoPageError: true }
length: 105118 bytes
URL: ace.wd5.myworkdayjobs.com/careers/job/.../Digital-Product-Management-Intern...
```

Playwright loads 105 KB HTML, status 200, no JS error — but Firecrawl content-extraction declares it "not long enough" because **SPA JD content is lazy-rendered in JS DOM that the static markdown extractor cannot reach**. Same pattern for Workday, some Lever subpages, some Greenhouse.

**Confirmed (Adam 2026-05-20)**: Workday has NO public job API — every workday URL goes through Firecrawl. Same for YC `workatastartup.com` (no API).

---

## 2. Definition of correct — what "done" means

Production-acceptable matching pool has these invariants for EVERY active doc:

1. `jobDescription` is a non-empty string, ≥ 200 chars (i.e. actually contains the JD, not just a heading)
2. `requiredSkills` is a non-empty array (LLM enrichment extracted ≥ 1 token)
3. `roleTitle` is a real role title — never the literal placeholder `"Open Engineering Roles"` or any synthetic `^Open \w+ Roles?$` pattern
4. `primaryUrl` resolves to a **specific job listing page**, not a company landing page (e.g. NOT `workatastartup.com/companies/veritus`)
5. `atsApplyUrl` is resolved (≠ jobright placeholder, ≠ primaryUrl when primaryUrl is a jobright mirror)
6. Tags are populated per axis registry (`roleFunction`, `industrySector`, `seniorityLevel`, `jobType`, `requiredSkills`, `locationBuckets`, `relevantTags`)
7. No dup by `sha256(norm(companyName) + "::" + norm(roleTitle))` signature (within-axis enforce in scraper)
8. V16 query for any real user (e.g. `indolencorlol@gmail.com`) returns top-10 jobs that all pass invariants 1–6

When the audit script `scripts/cleanup-verify.mjs audit` reports < 1% violation for each invariant, this goal is done.

---

## 3. Workstreams (sprint structure)

### Track A — YC scraper must scrape real job pages (NOT company landing pages)

**Where the bug lives**: macmini scraper iterates `workatastartup.com/companies/{co}` directory pages. When it can't find specific job listings on that page, it writes a synthetic doc with literal `roleTitle="Open Engineering Roles"` + `roleFunction=["software_engineering"]`. These pollute active pool (558 docs).

**Real YC job pages live at**: `workatastartup.com/companies/{co}/jobs/{slug}` — must navigate INTO the company page, find each job link, scrape the JD from there. If no jobs listed, SKIP — do not write synthetic.

**Acceptance**:
- Zero active docs with `roleTitle === "Open Engineering Roles"`
- Zero active docs with `primaryUrl` matching `^https://www\.workatastartup\.com/companies/[^/]+/?$` (i.e. company landing without `/jobs/{id}`)
- New YC docs have real role titles + JD text + skills

**Pointer**: macmini repo, scraper module. Find `enrich_from_jobright.py` adjacent (likely `yc_scraper.py` or `workatastartup.py`).

### Track B — JD enrichment must cover ALL active docs (kill the silent-failure pipeline)

**Where it breaks**: `wekruit-matching/src/wekruit_matching/pipeline/run_jd_enrichment.py`

Current filter (lines ~431–449):
```sql
WHERE status = 'active'
  AND (job_description IS NULL OR job_description = '')
  AND (
    (primary_url IS NOT NULL AND primary_url NOT LIKE 'https://jobright.ai/%%')
    OR (ats_apply_url IS NOT NULL AND ats_apply_url NOT LIKE 'https://jobright.ai/%%')
  )
  AND (
    jd_fetch_attempted_at IS NULL
    OR (jd_fetch_source = 'failed' AND permanent_404 = FALSE
        AND jd_fetch_attempted_at < NOW() - INTERVAL '{STAGE2B_STALE_DAYS} days')
  )
ORDER BY first_seen_at DESC
LIMIT %(limit)s
```

`STAGE2B_STALE_DAYS = 7` (line 75). `max_workers = 1` (line 356, "parallel signal-timeout broken"). `batch_size` capped at 500/run (line 413).

Firecrawl call (`firecrawl_enricher.py:220`):
```python
json={"url": url, "formats": ["markdown"], "waitFor": 5000}  # 5s = too short for SPA
```

**Edits Adam directive 2026-05-20** (paused, NOT YET PUSHED):
- `STAGE2B_STALE_DAYS: 7 → 1` ✅ edited locally on `fix/jd-enrichment-aggressive` branch
- `waitFor: 5000 → 20000` ✅ edited locally on same branch
- Remove the `primary_url NOT LIKE jobright OR ats_apply_url NOT LIKE jobright` filter → attempt all URLs (jobright-only docs will fail gracefully but at least logged) — NOT YET DONE
- Bump `batch_size` cap 500 → 5000 — NOT YET DONE
- Fix `max_workers` parallel (currently disabled due to signal-timeout bug) — needs investigation
- Run multiple times/day via launchd — NOT YET DONE

**Acceptance**:
- Daily JD enrich processes ≥ 2,000 docs/run (not 142)
- Retry failed within 1 day
- 6,888 backlog drops to < 500 within 2 weeks

### Track C — ATS URL resolution must catch up backlog (5,323 unresolved)

**Where**: `wekruit-pa/apps/functions/src/backfill-ats-urls-batch.ts` (cron hourly). Uses Serper to find the canonical ATS URL behind jobright mirror.

**Issues**:
- 5,323 active docs still have `primaryUrl == atsApplyUrl` (or jobright placeholder URL)
- Either Serper search miss, or backfill stuck on retry queue

**Acceptance**:
- < 200 active docs with `atsApplyUrl == primaryUrl` AND primaryUrl is jobright pattern
- Serper used to find the REAL employer career page when jobright mirror is the only known URL

**Pointer**: `apps/functions/src/backfill-ats-urls-batch.ts` + `apps/functions/src/backfill-ats-urls.ts`

### Track D — Tag enrichment chain (skills + industrySector + roleFunction)

**Where**: macmini pipeline stage `llm_enrich` runs LLM over JD text to extract skills + tags. If JD is null (Track B failure), no tags extracted.

**Hardening**:
- Stage gate: don't sync to Firestore unless JD enriched + tags extracted (or mark `enrichment_complete: false` so downstream can defer)
- Validate: every Firestore upsert has `requiredSkills.length > 0` + `roleFunction.length > 0` OR `enrichment_complete: false`

**Acceptance**: 0 active docs with empty `requiredSkills` AND `enrichment_complete: true`

### Track E — Write-side canonical dedup (cross-source overlap)

**Reality** (Adam insight, this session): jobright/simplify already URL-dedup at source. Cross-source overlap = 107 docs. **Not worth a standalone workstream**.

**Lightweight fix**: when macmini scraper writes a job and computes `sha256(norm(companyName) + "::" + norm(roleTitle))`, check `pa-job-canonical-signature/{sig}`. If exists with different jobId → log + skip OR mark new doc as duplicate.

**Acceptance**: dup count holds ≤ 200 over weeks (don't grow with corpus).

### Track F — Serper / real-website finding (for jobs lacking ATS link)

**Where**: when scraper has only a jobright mirror URL, Serper search "{companyName} {roleTitle} careers" can find the real employer career page → store as canonical `atsApplyUrl`.

**Already implemented** in `backfill-ats-urls.ts`. Need:
- More aggressive retry (currently hourly batch, hits Serper quota)
- Fallback: if Serper doesn't find within N retries, mark `unresolvable_ats: true` → hygiene flips inactive

---

## 4. Out-of-scope (don't touch this sprint)

- pa-users 624-doc cleanup (separate goal `.planning/GOAL-pa-users-cleanup.md`)
- Chat → tag/memory extraction wire-up (separate goal `.planning/GOAL-chat-tag-memory-extraction.md`)
- Firecrawl self-hosted → Firecrawl cloud SaaS migration (deferred)
- V16 scoring/reranker changes (B5 + B5.1 already shipped, no further changes needed)
- `pa-orchestrator` voice work (in progress separately)

---

## 5. Reuse (don't rebuild these)

- `paJobPoolHygiene` callable + admin token + dryRun pattern (`apps/functions/src/job-pool-hygiene.ts`) — **extend its predicate** to flip YC synthetic + zombie docs
- `paBackfillAtsUrlsBatch` (`apps/functions/src/backfill-ats-urls-batch.ts`) — extend retry + Serper budget
- `paLivenessSweepDaily` — leave alone, already works
- `paMatchingJobsTtlDeleteWeekly` + Callable — leave alone, current TTL (90d inactive) is healthy
- `ALL_CANONICAL_VOCABS` + `userField/jobField` registry (`packages/shared-tags/src/canonical/registry.ts`) — derive enrichment expectations from this
- `audit-job-pool-health.mjs` / `cleanup-verify.mjs` / `audit-real-dedup.mjs` (`scripts/`) — re-run after each fix

---

## 6. SSH / access for the new session

**Macmini access** (for Tracks A, B, D, E — code lives in wekruit-matching repo):

- SSH alias: `wekruit-mini` (Tailscale `100.83.121.89`)
- SSH user on macmini: `wekruitclaw1`
- Wekruit-matching repo path: `~/Desktop/WeKruit/wekruit-matching`
- Daily pipeline log: `/tmp/wekruit-matching-daily-YYYYMMDD-HHMMSS.log` (rotating, kept ~7 days)
- Pipeline script: `/Users/Shared/wekruit/run-pipeline.sh` (also `health-check.sh`, `post-pipeline-webhook.sh`)
- Postgres jobs table: macmini-local, used by scraper + enrichment
- Launchd jobs (run `launchctl list | grep wekruit` to see):
  - `com.wekruit.daily-update`
  - `com.wekruit.matching-engine`
  - `com.wekruit.health-check`
- Firecrawl Docker (`/Applications/Docker.app/Contents/Resources/bin/docker ps`; `docker` NOT in PATH for SSH):
  - `firecrawl-api-1`
  - `firecrawl-playwright-service-1`
  - `firecrawl-rabbitmq-1`
  - `firecrawl-redis-1`
  - `firecrawl-nuq-postgres-1`
- Firecrawl API endpoint: `http://localhost:3002/v1/scrape`, `http://localhost:3002/v1/extract`
- Logs for Firecrawl: `/Applications/Docker.app/Contents/Resources/bin/docker logs firecrawl-api-1 --tail 200`
- Mid-edit branch (Adam paused this session): `fix/jd-enrichment-aggressive` with `STAGE2B_STALE_DAYS=1` + `waitFor=20000` already applied (not pushed). Verify with `git status` + `git diff main` before continuing.

**Wekruit-pa (this repo)**:
- Worktree pattern: `git worktree add /tmp/wekruit-pa-deploy origin/main` then deploy from there (Adam edits main parallel)
- Deploy: `cd apps/functions && pnpm run deploy` (predeploy gate: build all workspaces + assert-runtime-bundle.mjs + typecheck + test)
- Selective deploy: `firebase deploy --only "functions:pa-orchestrator:<funcName>" --project wekruit-5f89b --non-interactive --force`
- `--force` is critical when re-deploying a previously-deleted CF (otherwise `allUsers` invoker IAM isn't restored, callable returns 401)
- Test scripts: `scripts/cleanup-verify.mjs audit | probe-match | probe-hygiene-dry | probe-hygiene-exec | probe-ttl-dry`
- Firebase Web API key (for ID token exchange): `AIzaSyCoAAGLn4dYvp5vUb3aAHv4tTbMnNMN8Is`
- `PA_ADMIN_TOKEN`: `firebase functions:secrets:access PA_ADMIN_TOKEN --project wekruit-5f89b`

**Wekruit-core-service-cloud-function**:
- Local path: `/Users/adam/Desktop/WeKruit/wekruit-core-service`
- Already has W1 status-respecting upsertJobs (PR #7) + W2 schema fields (PR #8) merged

---

## 7. Git diff / workflow conventions

- All cross-repo work via PR branches off `origin/main` of each repo
- When Adam is actively editing main in his clone, use `git worktree add /tmp/<repo>-<branch> origin/main` to avoid race
- PR commit message: explain WHY + reference the workstream label + include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- Merge: `gh pr merge <num> --squash --delete-branch --admin` (when CI green)
- Never `--no-verify` on hooks; never force-push main; never amend after pre-commit hook fail

---

## 8. Verification end-to-end (how to know it's done)

After fixes ship + macmini pipeline runs ≥ 2 successful daily cycles:

1. `node scripts/cleanup-verify.mjs audit` — expects:
   - `Total active: ~10k-12k` (post hygiene)
   - `no JD count: < 500` (down from 6,888)
   - `zombie count: < 200` (down from 2,425)
   - `YC synthetic 'Open Engineering Roles': 0` (down from 558)
   - `unresolved ATS (primary==ats): < 500` (down from 5,323)

2. `node scripts/cleanup-verify.mjs probe-match U7AwKT8nLDRa35DkuBxq` (indolencorlol) — expects:
   - 10 jobs returned
   - All have non-empty `roleTitle` (specific, not "Open Engineering Roles")
   - All `v16Score.total > 0`
   - All `freshnessBoost` present
   - Top 3 jobs from ≥ 2 different ATS hosts (diverse, not all YC)

3. `firebase functions:log --only paLlmRerankNightly` — expects:
   - `processed > 100` per nightly run for active users (currently 0 for KEEP_LIST → broken signal, separate followup)

4. Adam imessage `__PA_FIND_MATCH__` test — top-3 jobs are real, fresh, role-relevant, and the apply URL clicks through to an actual job posting (not a company landing page).

---

## 9. Followup gotchas / lessons (learned in this session)

- **Field-name drift**: macmini canonically writes `roleTitle`, V16 reader expected `jobTitle`. `projectMatchingJobRow` already normalizes, but consumers that bypass the projector hit empty. Hotfix #123 added `roleTitle ?? jobTitle` fallback at all V16 sites. Future fields: always cross-check macmini schema vs job-rec/types.ts.

- **`paJobPoolHygiene` IAM regression on recreate**: when the CF is DELETED then re-deployed, the `allUsers` invoker IAM binding is NOT restored. Must redeploy with `--force` OR manually grant via `gcloud functions add-invoker-policy-binding` (gcloud auth required).

- **`firebase deploy` quota**: deploying 50+ CFs at once hits hourly quota. Use `--only functions:pa-orchestrator:<funcName>` for single-CF iteration.

- **My audit field-name bugs (3.25 acknowledged)**: I incorrectly counted 10k+ "wasted dups" using `jobTitle` (empty for everyone). Real dup waste is 107. Adam's intuition about source-side URL dedup was correct.

- **Firecrawl `waitFor` 5s default is too short for SPA**: bumped to 20s in pending edit. Workday/Lever/some Greenhouse pages need this.

- **Macmini parallel JD enrich disabled**: `max_workers=1` due to "signal-timeout broken (loop tick #5 finding)". Re-enabling parallelism requires debugging that signal handler — not a free win.

---

## 10. Done criteria checklist

| # | Check | Pass condition |
|---|---|---|
| 1 | active pool 100% has roleTitle (no "Open Engineering Roles" placeholder) | Audit script: 0 matches |
| 2 | active pool > 95% has jobDescription (≥ 200 chars) | Audit script: > 11k active have JD |
| 3 | active pool > 90% has non-empty requiredSkills | Audit script: > 11k active have skills |
| 4 | active pool < 500 with primaryUrl == atsApplyUrl unresolved | Audit script |
| 5 | YC docs have specific `/jobs/{slug}` URLs, not bare company landing | Audit script regex check |
| 6 | Cross-source dup count stable < 200 | Audit script |
| 7 | indolencorlol probe top-10 all pass invariants | probe-match script |
| 8 | adam.ylol probe top-10 all pass invariants | probe-match script |
| 9 | Live SMS `__PA_FIND_MATCH__` from adam returns 3 diverse, real, fresh jobs | manual SMS test |

When all 9 ✅, this goal is done and matching is launch-ready.
