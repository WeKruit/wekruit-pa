# AI Headhunter — Competitor Capability + ATS Integration Research

_Generated 2026-06-24 via multi-agent research workflow (14 agents: 7 competitor clusters + 6 ATS surfaces + synthesis). Companion to HEADHUNTER-SLACK-AGENT.md._

I'll produce the report directly. The two research payloads contain everything I need — no tool calls required.

# WeKruit Competitive Parity & Build Plan: From Pull-Only Agent to Full-Stack AI Headhunter

## 1. Parity / Gap Matrix

Columns: **Best-in-class benchmark** (who sets the bar + what they do) vs **WeKruit today** vs **Gap severity**.

| Capability dimension | Best-in-class benchmark | WeKruit today | Gap |
|---|---|---|---|
| **Sourcing / supply** | Ribbon, hireEZ, Moonhub, Juicebox, Gem: 800M–1B+ external open-web profile indexes across 30–45 sources, NL search, no Boolean. Mercor *owns* a ~300k vetted pool. | ~5,300-candidate **proprietary retained pool** (pa-users) + Coresignal enrichment on demand. No standing external index; no free-text search without a jobId. | **Sourcing breadth = wide; supply ownership = a genuine moat.** Our 5,300 are *retained, conversational, prescreened* — closer to Mercor's owned-pool thesis than to scraper indexes. Gap is index size + searchability, not concept. |
| **Outreach automation** | Sense, hireEZ, Metaview, Gem, Ribbon, HeyMilo: multi-step, multi-channel (SMS/WhatsApp/email/InMail) AI-personalized sequences, auto-follow-up, reply classification, 38–46% response lift claims. | **Sendblue SMS outbound infra (pa-outbound) exists and runs** — but it is *not exposed to the agent*. No sequencing, no agent-driven send, no reply-state machine surfaced. | **Infra present, agent-blind.** Highest-leverage gap: the pipe is built, the agent just can't pull the trigger. |
| **Interview scoring / transcript intelligence** | BrightHire, Metaview, Ribbon, Apriora, HeyMilo, Mercor: full transcript + structured scorecard, competency-mapped, ATS write-back, numeric scores/rankings. | **Prescreen transcripts persisted in Firestore** + PASS/NOT_PASS terminal + tier stamping. No agent-facing *summary/scorecard* tool. | **Data exists, not summarized-on-demand.** We have richer signal (full conversational prescreen) than most; we lack a tool that distills it for the operator. |
| **Scheduling** | Paradox, GoodTime, Gem, hireEZ, Moonhub: conversational self-scheduling, panel/multi-tz coordination, calendar negotiation, no-show reduction. | **Cal.com is in the flow** but unexposed to the agent. | **Wired but not agent-callable.** Same shape as outreach: capability exists one layer below the agent. |
| **Rediscovery / silver-medalist** | Gem, Beamery, hireEZ, Ashby, Apriora, HeyMilo: first-class "rediscover past applicants / silver medalists / warm leads" with criteria-match buckets, >90% accuracy claims. | Pool is *globally retained* (NOT_PASS stays in pool by product rule) — the substrate for rediscovery exists. No first-class rediscovery tool; passed candidates lack global V16 tags. | **Best-positioned gap.** Our retention rule *is* rediscovery-by-design; we just haven't built the surface or back-filled tags to query it. |
| **ATS write-back** | hireEZ/Ashby/Greenhouse/Workday + unified (Merge/Kombo): push sourced candidate → application into employer ATS, source attribution, webhook outcome tracking. | None. Candidates live in pa-users + recruiter submissions; no path into an employer's system of record. | **Net-new.** The "last mile" that turns a passed candidate into a real application in the employer's stack. |
| **Proactive UX / agent autonomy** | LinkedIn Hiring Assistant, Juicebox, Findem Copilot, Apriora, Sense Grace: agents run 24/7 in background, surface matches proactively, approve/reject inline, learn from decisions. | Agent is **pull-only** (14 read/write tools, all confirm-first). No proactive push, no approve/reject buttons, no background runs. | **Interaction-model gap.** Tools are confirm-first and operator-initiated; competitors push and learn. |

**One-sentence read:** WeKruit's *moats* (owned retained pool, full conversational prescreen transcripts, NOT_PASS-stays-in-pool retention) are stronger than most competitors' — but five of seven capabilities are **built one layer below the agent and simply not exposed**, and two (ATS write-back, proactive UX) are genuinely net-new.

---

## 2. ATS Integration Recommendation

### Goal: "push a passed WeKruit candidate into the employer's ATS as an application."

This requires a write surface that creates **candidate + application against a specific job/req in one motion**, with **source attribution** (so the employer sees "WeKruit" sourced them) and ideally **webhook outcome tracking** (so PASS→interview→hire flows back into our flywheel).

### Direct-integration ranking (if building per-ATS)

| ATS | Endpoint that unlocks the use case | Partner gate? | Verdict |
|---|---|---|---|
| **SmartRecruiters** | `POST /jobs/{jobId}/candidates` — creates candidate **and** assigns to job in one call, with `sourceDetails` attribution; rich webhooks (`application.created/hired/rejected`). | **No** for single customer (X-SmartToken key). Partner program only to scale/list. | **Cleanest single-call fit.** |
| **Ashby** | `candidate.create` → `application.create` (candidateId + jobId), `sourceId`/`creditedToUserId` attribution. Self-serve API key with `candidatesWrite`. | **No** — any admin self-serves a key. Marketplace listing optional. | **Lowest friction, founder-friendly ATS our cohort uses.** |
| **Greenhouse** | Candidate Ingestion API `POST /v1/partner/candidates` (`prospect=false` + `job_id` → returns `application_id`); resume passed as a URL. | **Yes** for the `/v1/partner/` path (partner relationship + per-customer key). DIY alt: customer's own Harvest v3 key, no partner program. | **Strong, but partner-gated** unless customer hands their own key. Migrate to Harvest v3 (v1/v2 dies 2026-08-31). |
| **Lever** | `POST /opportunities` (name+email, `origin="sourced"`, `sources[]`, `perform_as` required). | **No** for single-customer API key. OAuth multi-customer = partner approval. | Good; `perform_as` (real user id) is a required gotcha. |
| **Workday** | SOAP `Put_Candidate` (candidate + application vs req in one call). No webhooks — poll or Outbound Messaging. | Per-tenant ISU/OAuth = no Workday approval; productized/marketplace = partner + certification. | Heaviest lift; enterprise only; no real webhooks. |
| **iCIMS** | Profiles API `POST /people` + Apply Framework for submittal. | **Yes, hard gate** — no self-serve creds, needs sponsoring customer + business review + signed agreement. | Avoid until a customer demands it. |

### Recommendation: **Lead with a unified API (Kombo, with Merge as alternative) — do NOT hand-roll per-ATS first.**

**Why unified is the faster path:**
- **One integration → 70–130+ ATS.** Kombo `POST /ats/jobs/{job_id}/applications` and Merge `POST /ats/v1/applications` both **create candidate + application in a single call**, auto-dedupe to existing candidates, and accept resume + screening answers.
- **Source attribution is first-class.** Kombo's `sourced_by` + "Automatic Source Writing" stamps the application so the employer ATS shows WeKruit as the source — exactly our flywheel need. Merge supports `source`/`credited_to`.
- **No per-ATS OAuth to manage.** Hosted Connect/Link flow; the customer authorizes their own ATS; we never touch each ATS's OAuth.
- **Webhook outcomes normalized.** Kombo `data-changed` / Merge "Changed Data" + auto-registered third-party webhooks track `application.hired/rejected/stage-change` → feeds PASS→hire back into pa-evaluation-attempts.
- **No partner approval at the unified layer.** Sign up, get a key, customer connects.

**The binding constraint is per-ATS, not per-unified-vendor:** write-back coverage varies by underlying ATS (Kombo: *"not all ATS support creating applications"* — check `app.kombo.dev/coverage/ats` / get-tools `ats_create_candidate`; Merge inline-create is 24 ATS incl. all six majors). Greenhouse Harvest scopes, Workday tenant ISU, and iCIMS partner enrollment still gate the *underlying* connection — unified standardizes the call once the customer's connection has scopes; it can't bypass an ATS's own write permissions.

**Concrete first move:**
1. **Integrate Kombo** (more sourcing/recruiting-oriented; `sourced_by` attribution + auto-source-writing out of the box). Use Merge if we later need richer read models (scorecards/interviews/offers passthrough).
2. **First direct fallback = Ashby**, because it's self-serve, zero partner gate, single-call clean, and matches our startup/founder cohort — a good "design partner" to prove the push end-to-end before relying on the unified layer.
3. **Gotcha to bake in:** GET screening questions per job first and answer required ones, or the ATS rejects the application. Resume via download-URL (both unified APIs prefer it over base64).

**MCP tool to add:** `push_candidate_to_ats(candidateId, jobId, atsConnectionId, includeResume, screeningAnswers?)` — confirm-first, returns `applicationId` + `profileUrl`; plus a passive `ats_outcome` webhook ingest that writes status changes back to the candidate record.

---

## 3. The 7 Gaps: Benchmark · Reuse · Tools · Effort

### Gap 1 — Outbound not exposed to the agent
- **Benchmark:** Sense Journeys / hireEZ EZ Agent / Ribbon — agent composes + sends personalized multi-step SMS, auto-follow-up, reply classification.
- **Reuse:** **Sendblue/pa-outbound is already live** (one-user-one-number sticky routing, STOP gate, inbound-evidence consent gate, dedup). Reuse the existing outbound safety rules verbatim (never cold-open phone without inbound evidence; never outbound to a never-inbound handle; dev-phones-only until ramp flag).
- **Add to MCP:** `send_candidate_message(candidateId, draftText, channel=sms)` — **confirm-first**, routes through existing send path + safety gates; `get_outbound_thread(candidateId)` to read reply state; `draft_outreach(candidateId, jobId)` to compose grounded in tags + match reason.
- **Effort:** **S** (wrap existing infra + gates; the pipe and safety logic already exist).

### Gap 2 — No external sourcing index
- **Benchmark:** Ribbon/hireEZ/Juicebox 800M–1B+ index; Mercor *owns* a vetted pool.
- **Reuse:** **Coresignal external-candidate enrichment** (already wired, unified cache `lib/coresignal-cache.ts`, `getOrFetchCoresignalById`) + LinkedIn-URL-hash identity merge into pa-users (already a product rule). We don't need a 1B scraper — we need *on-demand* external resolution into our owned pool.
- **Add to MCP:** `source_external_candidates(jobId | freeTextCriteria, limit)` — runs Coresignal/external supply intake, normalizes LinkedIn-centric rows, create/merge into pa-users as `prospect`, returns enriched candidates routed to review (per identity-merge rules). LinkedIn outreach stays manual (V1 product rule).
- **Effort:** **L** (identity merge, dedupe-to-review, normalization at query time; this is the External Candidate Supply Intake initiative).

### Gap 3 — No transcript summary tool
- **Benchmark:** BrightHire/Metaview structured competency notes + scorecard; hireEZ AI phone-screen summary + job-fit analysis.
- **Reuse:** **Prescreen transcripts in Firestore** + existing prescreen judge/eval (`paPrescreenCandidateEval`, KeywordSetJudge, engagement pillar, tier stamping). We already compute richer signal than a notetaker — just not summarized for the operator.
- **Add to MCP:** `summarize_prescreen(candidateId | sessionId)` — returns structured summary (key answers, strengths, red flags, gating-Q outcomes, engagement signal, tier, pass reason) grounded in the real transcript; reuse existing judge output rather than re-LLM from scratch.
- **Effort:** **S–M** (mostly composition over existing persisted judge/transcript data; LLM summary pass with the real-LLM-probe discipline from prior prescreen work).

### Gap 4 — Scheduling unexposed
- **Benchmark:** Paradox/GoodTime conversational self-scheduling; Moonhub/Gem auto-book.
- **Reuse:** **Cal.com is already in the flow.**
- **Add to MCP:** `send_scheduling_link(candidateId, jobId)` (drops Cal.com link via the existing outbound path) and `get_scheduling_status(candidateId)` (booked / no-show / pending). Confirm-first on send.
- **Effort:** **S** (expose existing Cal.com + reuse Gap-1 outbound pipe for delivery).

### Gap 5 — No free-text candidate search without a jobId
- **Benchmark:** Juicebox PeopleGPT / Ashby NL filters / SeekOut Assist — describe a candidate in plain language, no Boolean, query the pool.
- **Reuse:** **V16 matcher + canonical tag vocab (`packages/shared-tags`)** + the whole-pool scan patterns already built for admin counts (`paAdminCandidatePoolCounts`) and Algolia search foundation (already LIVE for dashboard — app ZKXR45ZNNH, candidates+subs indexed).
- **Add to MCP:** `search_candidate_pool(freeTextQuery, filters?)` — NL → canonical tags (LLM extract) → Algolia/Firestore query over the full ~5,300 pool, no jobId required. Algolia already indexes the pool; this is the agent-facing front door to it.
- **Effort:** **M** (NL→tag extraction + wire agent to existing Algolia index; index already exists, just not agent-exposed).

### Gap 6 — No first-class silver-medalist rediscovery
- **Benchmark:** Gem/Ashby "Silver Medalists / Warm Leads / High Fit" buckets; Beamery >90% rediscovery accuracy; Apriora re-activates ATS cold profiles per new role.
- **Reuse:** **NOT_PASS-stays-in-pool is already a product invariant** — the substrate is there. V16 two-way matcher (job→candidates direction) + tier stamping (`globalCandidateTier`) + rejected-candidates browse already built. **Blocker to fix first: passed candidates lack global V16 tags** (and find_candidates_for_job only matches the scraped-US catalog, not WeKruit collab jobs).
- **Add to MCP:** `rediscover_for_job(jobId)` — runs job→candidates V16 over the **retained pool incl. prior NOT_PASS + passed**, bucketed (silver-medalist / warm / high-fit), returns why-matched. **Prerequisite task:** backfill global V16 tags onto passed candidates + extend the matcher to cover WeKruit collab jobs (not just scraped catalog).
- **Effort:** **M** (matcher + buckets is moderate; the tag backfill + collab-job matching extension is the real work and is a hard dependency).

### Gap 7 — Agent is pull-only (no proactive push + approve/reject buttons)
- **Benchmark:** LinkedIn Hiring Assistant / Juicebox / Findem Copilot run 24/7, surface matches proactively, learn from approvals; Apriora/Sense push then escalate to human.
- **Reuse:** **Slack agent over MCP + confirm-first write tools** (advance/reject/intro/tier) + existing HITL/correction-event patterns + recruiter notify infra. The decision-capture (CorrectionEvent → eval/regression) flywheel is already a product rule.
- **Add to MCP / surface:** a scheduled job that runs `rediscover_for_job` on new collab jobs and **pushes a Slack card** with inline **Approve / Reject / Edit** buttons (maps to existing advance/reject/intro tools); approvals/rejections write correction events that feed eval. Keep the deterministic-reducer rule (LLM proposes, reducer/operator decides).
- **Effort:** **M** (scheduled trigger + Slack Block Kit interactive buttons wired to existing confirm-first tools; learning loop reuses existing correction-event plumbing).

---

## 4. Prioritized Build Order (highest leverage first)

1. **Expose outbound to the agent (Gap 1) — S.** The pipe, safety gates, and routing already exist; one wrapper turns a pull-only agent into one that can act. Biggest capability unlock per unit effort.
2. **Expose scheduling (Gap 4) — S.** Cal.com is in the flow and rides on the Gap-1 outbound pipe; trivial increment that completes the "reach → book" loop.
3. **Transcript summary tool (Gap 3) — S–M.** Pure composition over data we already persist; instantly makes the operator dramatically faster and surfaces our prescreen moat.
4. **Free-text pool search (Gap 5) — M.** Algolia index of the pool is *already live*; exposing NL search to the agent monetizes our owned-supply moat without new infra.
5. **Rediscovery + the tag/collab-job fix it depends on (Gap 6) — M.** Our NOT_PASS-retention rule is rediscovery-by-design; fixing passed-candidate V16 tags + collab-job matching is the single highest-value data fix and unblocks job→candidate activation.
6. **Proactive Slack push with Approve/Reject (Gap 7) — M.** Once rediscovery exists (#5), wrapping it in a scheduled push + inline buttons converts the agent from reactive to a 24/7 operator-in-the-loop — and closes the decision→eval flywheel.
7. **ATS write-back via Kombo, Ashby as direct fallback (Gap 2-adjacent / Section 2) — M–L.** The last mile that turns a passed candidate into a real application in the employer's system of record; lead with the unified API to hit 70+ ATS from one build, but it depends on the upstream pieces (summary, push) being solid so we only push vetted candidates.
8. **External sourcing index (Gap 2) — L, last.** Highest effort, and our retained pool + on-demand Coresignal already covers near-term demand; build the standing external index only after the owned-pool flywheel (1–7) is fully exposed and learning.

**Throughline:** ship the five "expose what we already built" gaps first (1,4,3,5,6 — mostly S/M), then the two net-new bets (ATS push, external index) last, because WeKruit's durable advantage is the *retained, prescreened, conversational pool* — and steps 1–6 are what finally let the agent fully exploit it.
