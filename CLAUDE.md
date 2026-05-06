# Claude Operating Authority — wekruit-pa

**Adam directive iter23 (2026-05-03):** "你可以 deploy 不要再说让我 deploy 然后自己不做事情了"

## You CAN and MUST deploy

Full deploy authority. **Never tell Adam "deploy this yourself"** — iter19 + iter22 + iter23 failure mode.

### Deploy commands (use directly, no ask)

```bash
# Cloud Functions (orchestrator code path — iMessage live + admin sims)
cd apps/functions && pnpm run deploy
# = firebase deploy --only functions --project wekruit-5f89b

# Hosting (pa-dashboard SPA)
pnpm run deploy:hosting

# Firestore rules / indexes
firebase deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b --non-interactive
```

Auth: `FIREBASE_SERVICE_ACCOUNT_JSON` set in `.env`. Source before run:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
  grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
```

Or pass `--project wekruit-5f89b` + firebase-tools picks creds from `gcloud auth application-default login` if Adam pre-auth'd.

### Predeploy gated — green build = ship

`firebase.json` predeploy runs:
1. Clean orchestrator dist
2. Build dependent workspaces (`@pa/core-types ... @pa/pa-orchestrator`)
3. `apps/functions/scripts/predeploy-smoke.mjs` (smoke checks)
4. `apps/functions` build + typecheck + test

Any step fails → deploy aborts. **Don't `--no-verify`.** Fix cause.

## Verify by doing — no claim "ready post-deploy" without testing

**Adam directive iter23:** "你需要做测试，每个 playbook 测试看看是否真的生效"

Workflow contract for orchestrator-touching change:

1. **Unit tests** — `pnpm --filter pa-orchestrator test` 100% green before commit
2. **Deploy** — run deploy yourself
3. **Live scenario verify** — `node tests/scenarios/runner.mjs <scenario-yaml>` + paste reply text. Scenario "pass" status NOT proof — read actual reply.
4. **Long-context check** — humanization / voice work: run ≥10-turn scenario, check drift (mirror score, repeat-advice, length compliance). Adam iter23: "context 一长就不够好" — test that.

## No delegate back to Adam

Forbidden:
- "Adam needs to deploy" / "pending Adam deploy"
- "you can re-run X yourself"
- "blocked on user"

**Truly** blocked (e.g. requires prod secret only Adam holds, needs physical Mac mini offline) → state **exact unblock** + what pre-staged. Don't bounce default.

## When confirm with Adam

Risky / irreversible / observable per system prompt safety:
- Force-push `main` (avoid; new commits instead)
- Drop Firestore collections / destructive migrations
- Modify prod feature-flag rollout (`paHumanizeRuntimeEnabled`, etc.) — flag flip ramping Adam-gated per V1.5-ROLLOUT.md
- Real iMessage SMS via Sendblue with non-test recipients
- Delete/amend git history Adam pulled

**Routine deploys of orchestrator code NOT in list.** Do them.

## What "done" means

Done = code merged + deployed + scenario-verified + long-context tested. Less = half-done. Adam tells you if half OK; default = full closure.

---

## v1.6 Design Lock — Unified Canonical Tags & Match Quality (2026-05-05)

**Adam directive (2026-05-05):** "tag 必须有一个地方 manage tag, 而且我们对于工作的 enrichment / 人的 enrichment 都必须要走这个 tag, 这样他们能共享这个都不算 match... 减少 regex 判断."

### 16 locked decisions (D1-D16) — do not re-litigate without Adam

| # | Decision | Source |
|---|---|---|
| **D1** | `roleFunction` = jobright `utm_campaign` 17 verbatim (`software_engineering`, `customer_service_and_support`, `legal_and_compliance`, etc) — closed enum, multi-pick | Adam 2026-05-05 |
| **D2** | `industrySector` = 42+ spelled-out closed enum (`crypto_web3_blockchain`, `gaming_and_esports`, `artificial_intelligence_and_machine_learning`, `accessibility_and_assistive_technology`...). **Add-able** by admin via dashboard sandbox→promote | Adam 2026-05-05 |
| **D3** | `major` = soft score (NOT hard filter) — SWE candidates have varied majors | Adam 2026-05-05 |
| **D4** | `visa` = exactly 4 enum: `citizen` / `permanent_resident` / `sponsor_needed` / `other`. Do NOT split OPT/CPT/H1B (all → `sponsor_needed`) | Adam 2026-05-05 |
| **D5** | **NO abbreviations** in any closed vocab. `software_engineering` not `swe`, `san_francisco_bay_area` not `sf`. LLM gets confused on abbrev | Adam 2026-05-05 |
| **D6** | `relevantTags` / `proposedTags` parse-time extract (in `pa-resume-parser` schema, NOT separate enrichment step) | Adam 2026-05-05 |
| **D7** | Per-skill `baseWeight` (global static) × JD-relative weight (Qwen-7B nightly batch) | Adam 2026-05-05 |
| **D8** | Single user tag source: `pa-users/{userId}.tags`. Both `cv-ingest` + chat answer hooks write here. `mergeUserTags()` lib (commit `253ce87`) is sole writer | Adam 2026-05-05 |
| **D9** | Match cascade: hard filter → skill+relevant+industry score → JD-CV LLM rerank async → emb cosine fallback | Adam 2026-05-05 |
| **D10** | Freshness window: `firstSeenAt < 20d`. **Abandon `lastSeenAt`** (jobright re-scrape pattern makes it noise). Daily 404 sweep handles dead jobs | Adam 2026-05-05 |
| **D11** | `cv-ingest` wires `pa-resume-parser` v2 (NOT inline single-shot gpt-5.4-nano). 3-tier router | Adam 2026-05-05 |
| **D12** | Post-parse Claire dialogue confirms understanding ("我看到你: <skills+companies>; 对吗?"). User correction writes back | Adam 2026-05-05 |
| **D13** | QA evaluator thread runs **weekly** auto-eval — 100 user×match samples, hard-filter pass + top-3 acceptable rate. Loop until milestone-shipped | Adam 2026-05-05 |
| **D14** | `__PA_FIND_MATCH__` iMessage trigger forces `generateJobRecs` (mirrors `__PA_RESET__`). Dev/test only | Adam 2026-05-05 |
| **D15** | **Reduce regex**, prefer LLM judgment for ambiguous classification. When LLM emits `["other"]`, second-pass with explicit reasoning prompt (NOT regex token match) | Adam 2026-05-05 |
| **D16** | Industry vocab is **add-able by admin** via dashboard. Sandbox `proposedTags` (open) → review → admin promote-to-canonical. Firestore `pa-canonical-tags` overlay | Adam 2026-05-05 |

### Two orthogonal axes (NOT one)

**Critical past mistake**: confusing `industry` and `function` as one axis. They are **orthogonal**.

- **`roleFunction`** (axis 1): WHAT you do. Source = jobright 17 (`utm_campaign`). Hard filter axis. SWE candidate → `roleFunction includes 'software_engineering'`.
- **`industrySector`** (axis 2): WHAT KIND of company. Source = 42 sectors (extends macmini `INDUSTRY_VOCAB` 38). Soft score axis. SWE candidate at fintech vs healthtech are both valid.

A SWE at Stripe = `roleFunction='software_engineering'` AND `industrySector='financial_technology'`. Two independent.

### Match flow (canonical, do not change without milestone)

```
queryMatchingJobs(userId):
  1. read pa-users.tags                              ← D8 single source
  2. Firestore query (push role to query layer):
       where status == 'active'
       where roleFunction array-contains-any user.targetRoleFunction   ← D1 hard filter
       orderBy firstSeenAt desc                                        ← D10 NOT lastSeenAt
       limit 500                                                       ← raise from 50

  3. in-memory hard filter:
       visa intersect                                ← D4 (sponsor_needed → drop sponsorship=false)
       location intersect (anywhere bypass)
       careerStage window
       jobType exact match                           ← D5 closed enum
       firstSeenAt < 20 days                         ← D10
       atsApplyUrl present + not jobright.ai
       dead !== true                                 ← D10 404 sweep result

  4. soft score (post-hard-filter):
       llm_match (Qwen-7B nightly cache)             0.40   ← D7+D9 main signal
       skill_jaccard (per-skill base × jd-rel)        0.20   ← D7
       relevantTags overlap                          0.15   ← D6 parse-time
       industrySector overlap                        0.10   ← D2 soft
       cv emb × jd emb cosine                        0.10   ← D9 fallback
       salary fit                                    0.05
       sponsor_fit and location_fit REMOVED         ← already hard-filtered

  5. compose message:
       title @ company \n atsApplyUrl \n 为啥推: <weighted reason from top-2 skills>
```

### Data sources (single point per axis)

| Axis | Person side | Job side | Match mode |
|---|---|---|---|
| `roleFunction` | `tags.targetRoleFunction[]` | `matching-jobs.roleFunction[]` | Hard filter, query-level array-contains-any |
| `industrySector` | `tags.industrySector[]` | `matching-jobs.industrySector[]` | Soft score (overlap) |
| `relevantIndustry` | `tags.relevantIndustry[]` (from CV experience) | (n/a — derived from job's industrySector + jd) | Soft score |
| `visa` | `tags.visaStatus` (1 of 4) | `matching-jobs.sponsorship` (bool) | Hard filter |
| `location` | `tags.targetLocations[]` | `matching-jobs.locationBuckets[]` | Hard filter (anywhere bypass) |
| `careerStage` | `tags.careerStage` | `matching-jobs.seniorityLevel` | Hard filter (window) |
| `jobType` | `tags.targetJobType[]` | `matching-jobs.jobType` | Hard filter (exact) |
| `skills` | `tags.skills[]` (open + bucket + weight) | `matching-jobs.requiredSkills[]` | Soft score (Jaccard + LLM JD-rel) |
| `relevantTags` | `tags.relevantTags[]` (open, max 12) | (n/a — derived JD-side) | Soft score (overlap + LLM judge) |
| `freshness` | (n/a) | `matching-jobs.firstSeenAt` | Hard filter (< 20d) |
| `liveness` | (n/a) | `matching-jobs.dead` | Hard filter (!= true) |
| `urlRealness` | (n/a) | `matching-jobs.atsApplyUrl` | Hard filter (present + not jobright) |
| `salary` | `tags.minSalary` (optional) | `matching-jobs.salaryMin` | Soft score (no hard drop) |

### Vocab files (single source of truth)

- `packages/shared-tags/src/canonical/role-function.ts` — 17 enum
- `packages/shared-tags/src/canonical/industry-sector.ts` — 42+ enum
- `packages/shared-tags/src/canonical/major.ts` — 45+ enum
- `packages/shared-tags/src/canonical/visa.ts` — 4 enum
- `packages/shared-tags/src/canonical/job-type.ts` — 10 enum
- `packages/shared-tags/src/canonical/career-stage.ts` — 13 enum
- `packages/shared-tags/src/canonical/location.ts` — 130+ enum
- Firestore overlay: `pa-canonical-tags/{vocab}/{token}` for runtime add-able vocab (D16)

**Do not duplicate vocab** — every reader (cv-ingest, generateJobRecs, dashboard, scraping bridge) imports from `packages/shared-tags`. Cross-repo (wekruit-scraping) Python port deferred to v2.

### LLM chain (locked)

| Tier | Provider | Model | Use |
|---|---|---|---|
| Primary | OpenAI | `gpt-5.4-nano` | CV parse main pass (PARSE-02) |
| Fallback | Anthropic | `claude-sonnet-4-6` | 5xx/timeout/rate retry, "industryTags=other" second pass |
| Final | OpenAI | `gpt-4.1-mini` | Final fallback if both above fail |
| Async LLM rerank | SiliconFlow | `Qwen/Qwen2.5-7B-Instruct` | Nightly batch JD-CV match score, JSON-mode |
| Embedding | OpenAI direct | `text-embedding-3-small` 1536d | Sync at cv-ingest, used in scoreJob |

### Anti-patterns to avoid (recorded for future agents)

- ❌ **Two parallel tag taxonomies** that don't talk (wekruit-pa 10-bucket vs core-service 16-bucket — pick one source, use everywhere)
- ❌ **Confusing function and industry as one axis** (jobright `utm_campaign` is function not industry — different dimension)
- ❌ **Reading multiple fragmented tag sources at match time** (`statedPreferences` + `parsedCandidateResumes.industryTags` + `parsedCandidateResumes.topSkills` — single source)
- ❌ **Adding regex when LLM judgment fits** (D15)
- ❌ **Truncating skills to top 12** — write full list to `tags.skills`, don't lose info
- ❌ **Using abbreviations in vocab** (D5 — `swe` confuses LLM, `software_engineering` doesn't)
- ❌ **Filter then rank with low limit** — top-50 by `lastSeenAt` may all be sales batch; raise to 500 + push role filter to query layer (D9 / D10)

### Reference

- Full spec: `.planning/PROJECT.md` (Current Milestone v1.6 section)
- Requirements: `.planning/REQUIREMENTS.md` (59 REQ-IDs across 10 categories)
- Roadmap: `.planning/ROADMAP.md` (11 phases 52-62)
- State: `.planning/STATE.md`
