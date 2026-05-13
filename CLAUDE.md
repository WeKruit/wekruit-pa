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

### GSD — milestone audit

- **`$gsd-audit-milestone`** (Codex/Cursor skill) runs the milestone definition-of-done checklist; upstream workflow: `~/.codex/get-shit-done/workflows/audit-milestone.md`.
- **Repo guide:** [.planning/GSD-AUDIT-MILESTONE.md](.planning/GSD-AUDIT-MILESTONE.md) — where audit outputs live (`v*-MILESTONE-AUDIT.md`), what to read per phase, and production invariants to double-check during integration review.

### Reference

- Full spec: `.planning/PROJECT.md` (Current Milestone v1.6 section)
- Requirements: `.planning/REQUIREMENTS.md` (59 REQ-IDs across 10 categories)
- Roadmap: `.planning/ROADMAP.md` (11 phases 52-62)
- State: `.planning/STATE.md`

## v1.9 Design Lock — End-to-End Candidate Journey Closure (2026-05-12)

7 phases (84-90), 51/51 REQ-IDs covered. Code-complete.

| Phase | Subject |
|---|---|
| 84 | PASS/FAIL terminal → auto generateJobRecs + Level 1 reveal |
| 85 | PiiConfirmPipeline + `WeKruit_<jobId>_<userId>_Apply` trigger |
| 86 | Generic ATS inbound (`paAtsInboundWebhook` HTTP CF; Handshake live, GH/Lever/LinkedIn 501 stubs) |
| 87 | Public candidate page `/j/:jobId` + CV upload + `publicVisible` flag |
| 88 | Sendblue multi-number pool + hash-by-userId router |
| 89 | Feedback survey post-PASS + `/admin/prescreen-feedback` |
| 90 | E2E scenarios + docs + audit |

**Deploy gate:** set `ATS_HANDSHAKE_HMAC_SECRET` Firebase Secret before deploying functions (or `paAtsInboundWebhook` deploy will fail). Other CFs deploy normally.

**Reuse mandate:** zero rebuild. Every new piece extends existing infra (Question/Pipeline, KeywordSetJudge, pa-resume-parser v2, mergeUserTags, generateJobRecs, TriggerRouter, sendImessage, pa-jobs config, PreScreenPipeline). See `.planning/MILESTONE-v1.9-candidate-journey.md`.

**Tests:** orchestrator 1458/1458, functions 1139/1139, prescreen scenarios 6/6.

---

## Domain & Hosting Layout (LOCKED 2026-05-13 — Adam directive)

Adam: "这个功能点不是admin是customer side". C 端 (candidate-facing) and admin MUST live on separate hosting sites. Never put candidate flow on the admin domain again.

| Domain | Firebase Hosting site | Source app | Purpose | Auth |
|---|---|---|---|---|
| `https://candidate.wekruit.com` | `wekruit-pa-landing` | `apps/pa-landing` (Vite SPA) | **C 端**: landing CTA + /j/:jobId pre-screen entry + /j/:jobId/cv (legacy) + /legal | None (public) |
| `https://pa.wekruit.com` | `wekruit-pa-landing` | same | Same site; alternate marketing domain | None |
| `https://wekruit-pa-landing.web.app` | `wekruit-pa-landing` | same | Default Firebase URL backup for the c-end site | None |
| `https://wekruit-pa.web.app` | `wekruit-pa` | `apps/dashboard-web` (Vite SPA) | **Admin only**: `/admin/match-debug`, `/admin/canonical-tags`, `/admin/prescreen-feedback`, `/admin/onboarding-questions`, etc. | Google sign-in, `@wekruit.com` only |
| Cloud Functions | n/a (cloudfunctions.net) | `apps/functions` | HTTP/event CFs (paSendblueWebhook, paAtsInboundWebhook, paPublicCvIngest, etc.) | per-CF auth |

**DNS** (Cloudflare, `wekruit.com` zone, `DNS only` proxy mode):
- `candidate.wekruit.com` → CNAME → `wekruit-pa-landing.web.app`
- `pa.wekruit.com` → CNAME → `wekruit-pa-landing.web.app`

**Admin → candidate 301 redirect:** `firebase.json` adds `/j/:rest*` redirect on `pa-dashboard` target to `https://candidate.wekruit.com/j/:rest*` so any stale-bookmark hit on the admin domain lands on the right surface.

**Routes** (canonical, do not duplicate elsewhere):
- `apps/pa-landing/src/main.tsx` — `/` (Landing) + `/legal` + `/j/:jobId` (PublicJob inline-upload UX) + `/j/:jobId/cv` (legacy back-compat)
- `apps/dashboard-web/src/App.tsx` — all `/admin/**` routes

**Do not:**
- ❌ Put candidate routes in `apps/dashboard-web/src/pages/PublicJob.tsx` (this was the 2026-05-12 mistake — file still exists but reachable only via redirect, will purge in cleanup commit)
- ❌ Create a new Firebase Hosting site for candidate work (`wekruit-candidate` was created and then deleted 2026-05-13)
- ❌ Mention `wekruit-pa.web.app/j/...` in test guides or commit messages — that URL only 301s
- ❌ Hardcode `https://wekruit-candidate.web.app` anywhere — that site no longer exists

**Test URLs (canonical):**
- Public job page: `https://candidate.wekruit.com/j/<jobId>` (e.g. `https://candidate.wekruit.com/j/hs-11005382-invoko-product-designer`)

---

## v2.0 Product Lock — Candidate Retention Marketplace (2026-05-13)

Canonical shared blueprint: `README.md` -> "Product Blueprint: Candidate Retention Marketplace". Keep this section consistent with that README memory.

Execution roadmap: `.planning/MILESTONE-v2.0-candidate-retention-marketplace.md`.
Autonomous sprint harness: `.planning/AUTONOMOUS-SPRINT-HARNESS.md`.
Autonomous `/goal` prompt: `.planning/V2-GOAL-PROMPT.md`.
External candidate supply initiative: `.planning/INITIATIVE-external-candidate-supply-intake.md`.
External supply `/goal` prompt: `.planning/V2-EXTERNAL-SUPPLY-GOAL-PROMPT.md`.

Adam direction: WeKruit is not just a job page, pre-screen bot, or employer ATS. The final product is a **C-end candidate retention marketplace**. Candidate supply is the long-term asset; each job is a demand event that can activate the historical candidate pool.

### North Star

WeKruit should retain every candidate who enters the platform, continuously improve that candidate's global profile through Claire conversations, resumes, tags, memory, and preferences, then match new jobs against this retained pool and outbound candidates into first interviews.

New job arrives -> enrich job -> match against existing candidates -> outbound through Sendblue -> candidate does first interview -> passed profiles become employer-visible -> all outcomes feed the candidate/job/tag/match data flywheel.

Adjacent initiative: External Candidate Supply Intake turns Juicebox / Lessie /
Coresignal LinkedIn-centered rows into the same global `pa-users` candidate
pool. This is a different initiative from the core v2.0 sprint roadmap, but it
must obey the same candidate-retention rules and use the same profile, tag,
matching, outreach, HITL, and eval flywheel.

### Non-Negotiable Product Rules

1. **Candidate is the durable asset. Job is an event.**
2. **All durable candidate data is global**: mem0, tags, PII, Level 1 info, YoE, industry preference, salary range, location preference, visa, company size, resume, LinkedIn, conversation-derived preferences, and outreach preferences.
3. **Job-specific data stays job-specific**: match score, outbound invite, prescreen session, PASS/NOT_PASS/PAUSE, employer-visible profile snapshot, and next-stage status.
4. **Match score never blocks the first interview.** Once a candidate enters a job flow, Claire gives the first interview regardless of initial match quality.
5. **NOT_PASS is not an exit.** Candidate remains in the global marketplace pool and can be matched to other jobs later.
6. **Employer dashboard only shows passed candidate profiles** for now. No employer-wide candidate browsing, no scheduling, no notes, no message-on-behalf-of in v2.0 scope unless Adam explicitly expands it.
7. **Candidate flow never returns to the admin domain.** C-end surfaces stay on `candidate.wekruit.com` / `pa.wekruit.com`.
8. **User tags and job tags share one canonical vocabulary.** Do not create separate user/job/matching taxonomies.
9. **HITL corrections must become flywheel data.** Human edits are not one-off fixes; they must write auditable correction events that become eval/regression artifacts.
10. **Outbound must respect channel capacity.** Sendblue account/number groups use sticky load balancing; one account group should own roughly 300-500 active reachable users before expansion.
11. **External sourced candidates share `pa-users`.** They are not standalone
    Instantly leads, Excel rows, or per-client campaign records.
12. **LinkedIn is the primary source identity lookup handle for external
    supply.** For Juicebox / Lessie / Coresignal intake, automatic create/merge
    queries a hashed canonical LinkedIn URL index to find an existing internal
    `pa-users/{uid}`. Store a normalized URL and hashed index/source link; do
    not use raw LinkedIn URL, email, or phone as a Firestore document id. Email
    is a reachability/outreach handle and secondary identity signal, not the
    primary external-source lookup key.
13. **LinkedIn outreach is manual in V1.** Generate personalized LinkedIn
    messages and operator tasks. Do not automate LinkedIn sending.
14. **Instantly is email delivery infrastructure.** WeKruit owns identity,
    tags, scoring, personalization, suppression gates, and audit. Instantly
    owns campaign delivery and reply/bounce/unsubscribe plumbing.

### Identity And Profile Ownership

Email magic-link is the v2.0 candidate identity mechanism. Gmail-only OAuth is not the north star.

For employer bulk resume upload, the PDF-extracted email is the primary identity signal. Employer-provided email is a validation hint. If they disagree, mark for review rather than silently creating a second person.

Use a stable global candidate profile with linked handles:

- `email` / normalized email / hashed email index
- phone E.164
- Sendblue user / thread identity
- browser `wkr_uid`
- ATS applicant IDs
- canonical LinkedIn URL / hashed LinkedIn index

Do not use raw PII as a public doc id. Keep identity merge deterministic with audit events.

External candidate supply uses LinkedIn URL as the strongest external source
identity because source rows are built from LinkedIn profile URL/content plus
enrichment. Resolution rules:

- same canonical LinkedIn URL hash lookup -> same internal `pa-users/{uid}`
  unless already blocked
- same email but no LinkedIn -> importable row, but no automatic external
  profile create in V1; route to review
- LinkedIn resolves to one `pa-users` and email resolves to another -> review
- fuzzy name/company/school similarity -> review only, never automatic merge
- `pa-users/{uid}` remains an internal id; indexes map hashed handles to uid

### Global Candidate State Machine

LLM never directly controls state transitions. LLM may extract intent, judge answers, or compose copy. State changes are controlled by deterministic reducers over typed events, verified facts, confidence, and policy.

| State | Entry Condition | Exit Condition | Controller |
|---|---|---|---|
| `prospect` | Employer bulk upload, ATS applicant, external LinkedIn sourced candidate, anonymous job-page uid, or direct text with no resolved profile | Email, phone, or LinkedIn handle extracted/linked | deterministic reducer |
| `profile_created` | `pa-users` global profile exists | At least one reachable handle verified or deliverable | deterministic reducer |
| `reachable` | Verified email or deliverable phone exists | Candidate replies, logs in, or explicitly opts out | delivery evidence + reducer |
| `claimed` | Email magic-link login succeeds | Core profile reaches ready threshold | deterministic reducer |
| `profile_ready` | Resume parsed, core tags present, and at least one reachable handle exists | Candidate becomes active or retained | deterministic reducer |
| `active_job_seeker` | Candidate explicitly or behaviorally signals open to opportunities | Stop, inactivity window, cooldown, or opt-out | LLM extracts signal; reducer decides |
| `retained` | Candidate is not actively searching but allows future outreach | Reactivation, new positive signal, or opt-out | deterministic reducer |
| `opted_out` | Stop/delete/no-outreach request | Only explicit opt-in can reactivate outreach | deterministic reducer, no LLM override |
| `deleted` | Delete request fulfilled | Terminal | deterministic reducer |

Example LLM output allowed:

```ts
{
  intent: "open_to_opportunities",
  confidence: 0.91,
  evidence: "I'm actively looking for SWE roles"
}
```

The reducer decides whether that evidence updates `active_job_seeker`.

### Candidate x Job State Machine

This state is per opportunity. It must not overwrite global candidate state.

| State | Entry Condition | Exit Condition | Controller |
|---|---|---|---|
| `candidate_matched` | New job match score crosses retrieval threshold | Outreach approved or blocked | matching service + policy |
| `outbound_queued` | Outreach policy allows or HITL approves | Sendblue accepts send | deterministic reducer |
| `outbound_sent` | Sendblue sent/delivered event | Candidate replies, timeout, or decline | delivery event |
| `candidate_interested` | Candidate replies yes/interested/asks relevant details | Prescreen starts | LLM intent extraction + reducer |
| `prescreen_started` | First job interview begins | PASS / NOT_PASS / PAUSE terminal | PreScreenPipeline |
| `passed` | Prescreen PASS | Employer-visible snapshot created | deterministic reducer |
| `not_passed` | Prescreen FAIL/HARD_STOP/NOT_PASS | Candidate retained for other jobs | deterministic reducer |
| `paused` | Ambiguous, sensitive, or manual-review state | HITL resolves | deterministic reducer |
| `employer_visible` | PASS plus required consent/profile snapshot | Employer sees passed profile | deterministic reducer |
| `archived` | Job closed, candidate declined, stale invite, or employer no longer hiring | Terminal for this job | deterministic reducer |

### Product Surfaces

Candidate surfaces:

- `/` — Claire landing, positioning as ongoing job-search companion.
- `/j/:jobId` — public job page, inline resume upload, iMessage start. This remains a single-page C-end flow.
- `/login` — email magic-link profile claim.
- `/me` — candidate home: profile completeness, resume on file, Claire status, active opportunities.
- `/me/profile` — resume, LinkedIn, global PII, Level 1 info, preferences, memory controls.
- `/me/matches` — recommended jobs, invited jobs, why matched, interview status.
- `/me/privacy` — export, delete, stop outreach, memory opt-out.

Employer/admin surfaces:

- Jobs: create/import job, job tags, prescreen config, public page preview.
- Bulk Resume Upload: upload emails + PDFs, parse status, extracted email, merge/create result, retry/error state.
- External Candidate Supply: import Juicebox / Lessie / Coresignal rows,
  normalize LinkedIn-centered records, resolve identity, create/merge `pa-users`
  prospects, evaluate against company/job rubrics, generate Instantly email
  payloads, and create manual LinkedIn tasks.
- Passed Candidates: only passed profiles, filterable by job.
- Candidate Profile: resume summary, tags, Level 1 info, PII consent, transcript, pass reason, match reason.
- Match Debug: hard filters, soft score, LLM rerank, evidence, explanation.
- Tagging Admin: canonical vocab, sandbox proposed tags, promote/reject, backfill status.
- Sendblue / Outreach Ops: outbound queue, delivery, cooldown, account pool, failures, capacity.
- HITL Review Queue: low-confidence job enrichment, candidate matching, prescreen ambiguity, employer visibility concerns.
- Eval / Regression: scenario runs, ranking evals, job-intake evals, live-smoke artifacts.

### Backend System Boundaries

Long-term backend modules:

1. **candidate-profile-service**
   - identity merge
   - global profile state
   - global PII / tags / Level 1 / resume / memory hooks
   - external LinkedIn identity links and source evidence
   - candidate lifecycle reducer

2. **job-enrichment-service**
   - raw JD ingest
   - canonical job tags
   - hard filters and soft preferences
   - generated prescreen config
   - Claire job brief
   - generated eval fixtures
   - enrichment confidence + HITL review triggers

3. **tagging-service**
   - canonical vocab
   - synonym normalization
   - proposed-tag sandbox
   - admin promote/reject
   - tag confidence, evidence, source attribution
   - versioned backfills and migrations

4. **matching-service / matching repo**
   - candidate -> jobs recommendations
   - job -> candidates activation
   - hard filters
   - soft scoring
   - LLM rerank
   - embedding similarity
   - explanations
   - feedback learning
   - offline eval and debug output

5. **outreach-service**
   - Sendblue account/number pool assignment
   - Instantly email lead sync for approved external candidate outreach
   - manual LinkedIn outreach task generation
   - sticky candidate/account routing
   - account capacity model
   - cooldowns and duplicate suppression
   - delivery health and retries
   - outbound approval policy

6. **conversation-runtime**
   - Claire friend persona
   - job recommendation dialogue
   - pre-screening
   - PII / Level 1 collection
   - long-term retention conversations

7. **quality-control-plane**
   - HITL queues
   - simulation
   - eval
   - regression
   - audit
   - flywheel artifacts from human corrections

### Tagging System Maintenance

Tagging is the central language connecting candidate supply and job demand.

User-side tags include:

- roleFunction
- skills
- seniority / careerStage
- yoe
- industry preference
- location preference
- salary range
- visa / sponsorship
- company size preference
- job type
- education / major
- conversation-derived preferences
- negative preferences

Job-side tags include:

- roleFunction
- requiredSkills
- niceToHaveSkills
- seniorityLevel
- industrySector
- locationBuckets
- salaryRange
- sponsorship
- jobType
- companySize
- must-have constraints
- soft preference signals

Every meaningful tag should carry value, source, confidence, evidence, version, and updated timestamp:

```ts
{
  value: "software_engineering",
  source: "resume_parse" | "conversation" | "job_enrich" | "admin" | "llm_infer",
  confidence: 0.87,
  evidence: "Tesla SWE intern; React/TypeScript project history",
  version: "tag-vocab-2026-05",
  updatedAt: "..."
}
```

Maintenance obligations:

- keep canonical vocab in `packages/shared-tags`
- keep job and user axes aligned
- log proposed tags before promotion
- require evidence for low-confidence or new tags
- write audit events for promote/reject/edit
- generate backfill tasks when vocab or schema changes
- add eval cases whenever a tag correction is made

### Job Enrichment Pipeline

Each new job must become an enriched demand object before it participates in matching.

Pipeline:

1. ingest raw JD / employer / source metadata
2. normalize title, employer, location, salary, apply URL
3. extract canonical tags
4. infer hard constraints
5. infer soft preference signals
6. generate prescreen questions
7. generate scoring rubric
8. generate Claire candidate-facing brief
9. generate eval fixtures
10. validate and route low-confidence cases to HITL

Output shape:

```ts
JobOpportunity {
  rawJob
  enrichedJobTags
  hardFilters
  softScoringWeights
  prescreenConfig
  candidateBrief
  evalFixtures
  enrichmentConfidence
  enrichmentVersion
}
```

Guardrails:

- never infer `sponsorship=false` from silence
- keep `roleFunction` and `industrySector` orthogonal
- seniority cannot rely only on title regex
- broken or expired URLs must be swept
- enrichment version changes require backfill planning
- generated prescreen config is draft unless confidence and coverage are high

### User Tagging Pipeline

Candidate information comes from resume, chat, PII/Level1, LinkedIn, historical behavior, and HITL.

Pipeline:

1. resume parse
2. conversation extraction
3. Level 1 structured answers
4. preference updates
5. behavioral events
6. manual correction
7. periodic re-enrichment

Transcript and mem0 are not enough. Durable facts must be extracted into structured global profile fields.

Example:

User: "I only want NYC or remote AI infra startups. Below 140k is not worth it. I need H1B sponsor."

Structured updates:

- `targetLocations = ["new_york", "remote"]`
- `industrySector = ["artificial_intelligence_and_machine_learning", "cloud_and_infrastructure"]`
- `companySize = ["early_startup", "scale_up"]`
- `minSalaryUsd = 140000`
- `visaStatus = "sponsor_needed"`

LLM extracts; deterministic reducer decides whether and how to write.

### Matching Repo Responsibilities

The matching repo/service must support both directions:

1. **candidate -> jobs**: daily recommendations and candidate-requested matching.
2. **job -> candidates**: new job activates retained candidate pool and creates outbound interview opportunities.

Required output:

```ts
CandidateJobMatch {
  candidateId
  jobId
  hardFilterResult
  softScore
  llmScore
  finalRank
  reasons
  risks
  missingInfo
  recommendedAction: "auto_outbound" | "hitl_review" | "do_not_contact"
}
```

Ranking layers:

1. Deterministic hard gates: role family, work authorization, location, seniority, freshness, URL validity.
2. Soft score: skills, industry preference, salary fit, company stage, resume embedding, conversation preference.
3. LLM / embedding rerank: nuance after hard filters.
4. Outcome feedback: replies, declines, prescreen outcomes, employer action, HITL corrections.

### Outreach And Sendblue Capacity

Outbound is flexible but policy-controlled.

Account/number groups:

- sticky assignment by candidate
- one group owns roughly 300-500 active reachable users
- statuses: `active`, `warmup`, `throttled`, `paused`, `degraded`
- new users assigned by capacity
- old users keep thread continuity

Outreach decision shape:

```ts
OutreachDecision {
  allow: boolean
  mode: "auto" | "hitl_required" | "blocked"
  reason:
    | "high_fit_active_candidate"
    | "cooldown"
    | "low_fit"
    | "channel_capacity"
    | "recent_decline"
    | "opted_out"
    | "duplicate_company_or_role"
}
```

Policy must consider candidate state, recent activity, match score, cooldown, account capacity, delivery health, opt-out status, and duplicate suppression.

### HITL Control Plane

HITL is not a fallback page. It is the control and labeling surface for risky, low-confidence, or high-value actions.

HITL required or strongly considered for:

- low-confidence JD enrichment
- generated prescreen questions with weak coverage
- conflicting visa/location/salary constraints
- borderline candidate-job ranking
- high-value employer outbound batch
- new Sendblue account warmup
- recent candidate decline
- ambiguous prescreen answer
- compensation, legal, immigration, or safety-sensitive candidate questions
- PASS with incomplete PII
- employer-visible profile with inconsistent transcript/reason

Every human edit writes a correction event:

```ts
CorrectionEvent {
  objectType: "job_tag" | "user_tag" | "match_rank" | "question" | "outbound_copy" | "visibility"
  before
  after
  reason
  reviewer
  downstreamEvalCaseCreated: true
}
```

### Data Flywheel

The flywheel:

1. new candidate enters
2. resume + chat enrich global profile
3. candidate receives jobs
4. candidate replies, ignores, declines, or screens
5. interview outcome is recorded
6. employer sees passed profile
7. employer action is recorded
8. scoring/tagging/evals improve
9. future jobs use better profiles and better ranking

Feedback events to persist:

- candidate clicked job
- candidate replied interested
- candidate ignored
- candidate declined
- candidate said recommendation was irrelevant
- candidate completed prescreen
- candidate passed
- employer viewed profile
- employer advanced candidate
- employer rejected candidate
- HITL corrected tag
- HITL changed match reason
- HITL changed generated question
- HITL changed outbound copy

These events feed analytics, eval datasets, scoring calibration, tag confidence, prompt/rubric improvement, and regression cases.

### Testing And Eval System

Eval must cover marketplace behavior, not only isolated functions.

Layer 1: schema/reducer tests

- tag canonicalization
- identity merge
- candidate state transitions
- candidate-job state transitions
- hard filters
- Sendblue assignment
- cooldown
- idempotency

Layer 2: pipeline simulation

- direct job page new candidate
- employer bulk PDF upload
- old candidate matched to new job
- outbound invite
- interested reply
- prescreen PASS / NOT_PASS / PAUSE
- employer-visible profile creation

Layer 3: ranking eval

- for a job, top candidates are plausible
- for a candidate, top jobs are plausible
- obvious mismatches are suppressed
- plausible but uncertain candidates go to HITL
- score/rank changes create regression fixtures

Layer 4: job intake eval

- generated tags are correct
- generated questions cover true must-haves
- generated rubric catches strong/weak/ambiguous/visa/location/salary cases
- low confidence routes to HITL

Layer 5: safety / privacy eval

- prompt injection
- cross-user leakage
- PII leakage
- employer cannot see non-passed candidates
- delete / opt-out / stop honored

Layer 6: live smoke and channel eval

- Sendblue delivery
- no duplicate outbound
- no skipped first interview
- no admin-domain candidate route
- no PII before consent
- account capacity and cooldown respected

### Single-Point Lead Requirement

This product is large enough that work must be split by a single lead, but the lead must preserve one system model. The lead's job is not to create isolated sprints; it is to keep these invariants true across product, backend, UIUX, eval, and flywheel:

- every build slice improves the candidate marketplace
- every new data field has a lifecycle, owner, audit trail, and eval story
- every job intake path produces enriched demand
- every candidate intake path improves global supply
- every matching change is evaluated in both directions
- every HITL correction becomes flywheel data
- every C-end route stays on candidate domain
- every employer view remains passed-profile-only until Adam expands scope
- Landing: `https://candidate.wekruit.com/` or `https://pa.wekruit.com/`
- Legal: `https://candidate.wekruit.com/legal`
- Admin: `https://wekruit-pa.web.app/admin/...` (requires `@wekruit.com` sign-in)

**Deploy commands:**
```bash
# C-end (candidate.wekruit.com)
firebase deploy --only hosting:pa-landing --project wekruit-5f89b --non-interactive
# Admin (wekruit-pa.web.app)
PA_DASHBOARD_VITE_ENV_FILE=apps/dashboard-web/.env.production.local \
  firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b --non-interactive
# Functions (cloudfunctions.net)
cd apps/functions && pnpm run deploy
```

---

## v1.7 Ship State (2026-05-06)

11 phases shipped (63-73), 43 REQ-IDs covered. Same-day spawn + ship after v1.6 post-ship matching diagnostics.

| Phase | Subject | Commit |
|---|---|---|
| 63 | Senior-job scrapers (LinkedIn/Wellfound/Otta) | wekruit-pa `7c83f62` + macmini `60359a4` |
| 64 | Sponsorship LLM inference + 279 allowlist | (combined) |
| 65 | paBackfillAtsUrlsBatch hourly + retry queue | `a0b6029` |
| 66 | macmini Stage 2.5 deleted (1708 LOC) | wekruit-pa `6caee56` + macmini `b81ecaf` |
| 67 | Launchd reliability + critical health-check fix | `7bb9cb0` |
| 68 | Vocab hygiene closure (926 jobs re-canon) | `a7bf6c5` |
| 69 | Slack-alert helper + secrets scaffolding | `d26b3fa` |
| 70 | /admin/match-debug live UI | `87bb878` |
| 71 | Auto-derive targetRoleFunction + fill-tag-gaps | `b0a9c39` |
| 72 | Documentation v1.7 | `c3f1120` |
| 73 | career-ops port — Greenhouse/Lever/Ashby direct APIs (6700+ jobs/day, 1700+ senior+) | macmini Phase 73 commit |

**Plus matching hotfixes:**
- `e10d50b` orchestrator-deps V16 cutover + skill schema + vocab typos
- `b9019a2` V16 adaptive freshness 20d → 45d → 90d
- `71b9464` LLM-composed nuanced reasoning

**New CFs:** `paBackfillAtsUrlsBatch` (hourly), `paCostSummaryWeekly` (Mon 09:30 UTC), `paAdminMatchDebug` (admin callable). Plus updated all 30+ existing.

**Macmini:** Stage 2.5 deleted, health-check case-sensitive grep fix (was killing pipelines), post-pipeline-webhook FDA fix, Wellfound+LinkedIn+Otta scrapers scaffolded.

**Adam-action items (all optional with graceful fallback):**
- `ANTHROPIC_API_KEY` Firebase secret → Sonnet middle tier
- `PA_SLACK_ALERT_WEBHOOK` Firebase secret → Slack alerts
- `LINKEDIN_ACCESS_TOKEN` macmini env → senior-job scrape

See `.planning/MILESTONE-v1.7-match-depth.md` for architecture diagram + open v1.8 backlog.

---

## v1.6 Ship State (2026-05-06)

All 11 phases shipped:

| Phase | Subject | Commit | REQ-IDs |
|---|---|---|---|
| 52 | Canonical Tag Vocab Foundation | `5d1c603` | TAG-01..12 |
| 53 | pa-resume-parser v2 wire | `3209bc5` | PARSE-01..09 |
| 54 | Unified pa-users.tags writer | `d693f81` | USER-TAG-01..05 |
| 55 | matching-jobs schema migration | `5e74248` | MATCH-02 |
| 56 | queryMatchingJobs V16 | `6adb9b8` | MATCH-01,03..08 |
| 57 | Liveness sweep + macmini probe | `57c182b` | LIVE-01..04 |
| 58 | Nightly LLM rerank batch | `463bcdb` | RERANK-01..04 |
| 59 | Dashboards | `661a039` | DASH-01..04 |
| 60 | Dev triggers + V16 cutover | `7499a1b` | DEV-01..04 |
| 61 | QA evaluator weekly (ship gate) | `12a5934` | QA-01..05 |
| 62 | Documentation + cross-repo handoff | (this commit) | DOC-01..04 |

Cloud Functions deployed:
- `paLivenessSweepDaily` — 03:00 UTC daily HEAD-check + atsApplyUrl backfill
- `paLlmRerankNightly` — 04:00 UTC daily Qwen-7B + Sonnet-4-6/OpenAI/Qwen JD-rel
- `paQaEvaluatorWeekly` — Mon 09:00 UTC ship-gate evaluator
- `paPromoteSandboxTag` — admin-only callable for industrySector overlay promotion

Hosting deployed: `https://wekruit-pa.web.app` with `/admin/canonical-tags`, `/admin/qa-evaluator`, `/admin/onboarding-questions` (extended).

Macmini state (post-Phase 66, 2026-05-06): Stage 2.5 (url_resolver / run_url_resolution) **deleted**. URL resolution is now sole responsibility of wekruit-pa Cloud Functions `paBackfillAtsUrlsBatch` (hourly) + `paLivenessSweepDaily` (daily). Macmini daily pipeline = scrape + JD-enrich + LLM gap-fill + embed + Firebase sync (no URL resolution). The `SKIP_URL_RESOLUTION=1` env hotfix is removed from `/Users/Shared/wekruit/run-pipeline.sh` — no longer needed because the code path doesn't exist. Files deleted: `pipeline/url_resolver.py`, `pipeline/run_url_resolution.py`, `tests/test_url_resolver*.py`, `tests/test_run_url_resolution.py`. `pipeline/url_classifier.py` retained (still used by `run_jd_enrichment.py`/`firecrawl_enricher.py`/`ats_enricher.py` for ATS routing).

Open Adam-actions:
- Set `ANTHROPIC_API_KEY` Firebase secret to activate Sonnet-4-6 middle tier (chain falls through gracefully without it)
- Set `PA_SLACK_ALERT_WEBHOOK` to enable Slack alerts (Mailgun email already wired)
- Run `node apps/functions/scripts/migrate-pa-users-tags.mjs --apply` for any newly-onboarded users not yet covered by initial 430/529 backfill (idempotent)

Ship gate (Phase 61): pending sufficient data. First weekly run sampleSize=0 because only 5/529 users have `targetRoleFunction` set. As onboarding completion ramps, gate will surface real signal automatically.
