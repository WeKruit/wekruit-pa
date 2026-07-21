# AI Headhunter — Slack Agent (shipped) + Competitor Gap Analysis & Roadmap

_Built 2026-06-24. The WeKruit Headhunter is an internal AI recruiting copilot living in Slack (Wekruit workspace, app `A0BCX0EA0JJ`)._

## What shipped

| Piece | What | Where |
|---|---|---|
| **MCP server** `paHeadhunterMcp` | 14 tools wrapping existing `run*` admin runners; admin-gated (Firebase admin claim / `PA_ADMIN_TOKEN`); passed-candidate PII consent-redacted server-side; unit-tested redaction gate | `apps/functions/src/headhunter-mcp/` |
| **Slack receiver** `paHeadhunterSlack` | Bolt `Assistant` middleware → `@openai/agents` loop → connects to the MCP over Streamable HTTP (bearer = admin token); persona = internal headhunter copilot, confirm-first on writes | `apps/functions/src/headhunter-slack/` |
| **Slack app** | WeKruit Headhunter — bot user + 6 scopes (`assistant:write`,`chat:write`,`im:*`,`app_mentions:read`) + Agents&AI-Apps assistant view + event subs (`assistant_thread_started`,`message.im`,`app_mention`) | api.slack.com app `A0BCX0EA0JJ` |

Stack ownership: **shell** = Slack (Bolt + official starter pattern), **brain** = OpenAI Agents SDK, **tool protocol** = MCP (Anthropic-originated open standard), **hands + data** = our Cloud Functions. Reuse-not-rebuild: every tool rides an existing admin `run*` runner.

### The 14 tools (v1)
- **Read:** `list_candidate_pool_summary`, `list_recruiter_submissions`, `list_rejected_candidates`, `list_passed_candidates_for_job` (consent-gated), `get_prescreen_ops_snapshot`, `get_ops_metrics`
- **Match:** `find_matching_jobs_for_candidate` (cand→jobs, V16), `find_candidates_for_job` (job→cands)
- **Write (operator-confirm + audit):** `advance_/reject_/request_info_/comment_recruiter_submission`, `decide_employer_intro`, `reevaluate_candidate_tier`

## E2E test (2026-06-24) — 8/8 read+match tools GREEN

Drove the live Slack DM through every read/match tool: `list_recruiter_submissions` (3967 total), `list_candidate_pool_summary` (5353), `list_rejected_candidates` (33, reasons+source split), `list_passed_candidates_for_job` (consent-aware), `get_prescreen_ops_snapshot` (712), `get_ops_metrics` (1350 new/30d), `find_candidates_for_job` (clean, 0 for collab jobId — see gap A), `find_matching_jobs_for_candidate` (clean, 0 `noUserTags` — see gap B). Write gate verified behaviorally (confirm-first articulated, no action); a live destructive reject was independently blocked by the safety classifier (defense in depth). Two bugs fixed en route: silent bot (needed Bolt `Assistant` middleware) + context-overflow (row-cap 25). Slack formatting fixed (`toSlackMrkdwn` — GitHub md → Slack mrkdwn; 9/9 unit tests).

## v2 gap-closure build (2026-06-24) — reuse-not-rebuild

Companion research: [`HEADHUNTER-COMPETITOR-ATS-RESEARCH.md`](HEADHUNTER-COMPETITOR-ATS-RESEARCH.md) (14-agent workflow: 7 competitor clusters + 6 ATS surfaces). The 7 gaps + ATS write-back, by wave:

| Gap | Tool(s) | Reuses | Wave |
|---|---|---|---|
| #5 free-text pool search (no jobId) | `search_candidate_pool` | synthetic-job + V16 `rankCandidatesForJob` over retained pool (agent parses NL→filters) | **A ✅ built** |
| #6 silver-medalist rediscovery | `rediscover_for_job` | `pa-users.globalCandidateTier` query + V16 scorer | **A ✅ built** |
| #3 transcript summary/scorecard | `summarize_prescreen` | reads already-scored `pa-prescreen-sessions` (no re-LLM) | **A ✅ built** |
| #4 scheduling | `get_scheduling_status` (read) | `pa-interview-bookings` (Cal.com) | **A ✅ built** |
| #1 outbound exposed to agent | `draft_outreach` + `send_candidate_message` | `sendRuntimeApprovedIMessage` + LOCKED gates (`isSuppressed`, `hasPriorInboundEvidence`, `resolveBoundFromNumber`), dev-phone-gated, confirm-first | B (next) |
| #2 external sourcing | `search_external_candidates` | wrap `paAdminCoresignalAgenticSearch` (NL→profiles) | B (next) |
| #4 scheduling send | `send_scheduling_link` | Cal.com `offer_interview_slots` + outbound pipe | B (next) |
| #7 proactive push + Approve/Reject | scheduled `rediscover_for_job` → Slack Block Kit buttons → existing confirm-first writes | net-new interactivity endpoint | C |
| ATS write-back | `push_candidate_to_ats` | **Kombo unified API** (lead) / Ashby direct (fallback) — needs vendor key (Adam) | C |

Known data gaps to fix for #6 to fully pay off: (A) `find_candidates_for_job`/rediscover match the scraped `matching-jobs` catalog, not WeKruit collab jobs; (B) passed candidates lack global V16 tags. Both flagged in the research doc.

## Competitor feature landscape (2026)

Categories researched: sourcing (hireEZ, SeekOut, Juicebox, Findem, LinkedIn Hiring Assistant, Fetcher, Eightfold, Moonhub); copilots/interviewers (Mercor, Paraform, Metaview, HeyMilo, Apriora, Micro1); outreach/scheduling (Paradox/Olivia, Gem, GoodTime); CRM/rediscovery (Gem, Beamery); Slack/ATS copilots (Greenhouse, Ashby).

### Where we have parity
Internal read/match/triage core — pool summary, submission triage, two-way V16 matching with score breakdowns, passed-candidate review, prescreen + ops metrics, operator write-actions (advance/reject/intro/tier) with confirm-first. Solid ATS-copilot ground.

### Gaps (what competitors have, we lack)
1. **External sourcing** — LinkedIn/GitHub/web index (every sourcing tool ships a 500M–1.6B pool). We only rank the *internal* retained pool.
2. **Outbound sequencing exposed to the agent** — Sendblue SMS exists in-product, but the agent has **zero** outreach tools. **#1 workflow gap.**
3. **Interview transcript summary / scorecard** — transcripts captured, no TL;DR/per-question scoring tool (Metaview/HeyMilo/Ashby parity).
4. **Scheduling / self-scheduling** — no calendar tool (Cal.com in the flow but unexposed).
5. **Free-text candidate search w/o a jobId** — `find_candidates_for_job` needs an existing job.
6. **Silver-medalist / rediscovery** — ad-hoc only; no first-class "reached onsite/offer, not hired" pool.
7. **Proactive Slack push + Approve/Reject button blocks** — agent is pull-only.
8. Contact/identity enrichment · closed feedback-learning loop into V16 · market/comp + DEI funnel analytics.

### Prioritized roadmap
1. **Expose outbound** — `invite_candidate_to_job` / `draft_and_send_outreach` over existing Sendblue + pa-outbound, respecting LOCKED outbound-safety rules (one number/user, never cold-open a never-inbound handle, dev-phone gating, operator-confirm). Turns read/triage → actual headhunter.
2. **`summarize_prescreen`** — TL;DR + per-question score + red flags from transcripts already in Firestore (reuse PreScreenPipeline judge). ~no new model work.
3. **`find_candidates_from_brief`** — NL brief → V16 filters over the pool, no jobId required.
4. **`rediscover_for_job` / silver-medalist surfacing** — cheap given tier + retained-pool data.
5. **Scheduling** — expose Cal.com `send_scheduling_link` / `schedule_prescreen`.
6. **Proactive notifications** — push new-match / stage-change events into a hiring channel + interactive Approve/Reject blocks.
7. **`get_candidate_profile`** — one stitched profile (resume, tags, handles, prescreen history, submissions) + contact enrichment.
8. **Close the feedback loop** — wire reject-tier + intro feedback events into V16 recalibration / eval-regression.

## E2E test script (15 queries → tool)
Read/match: pool summary→`list_candidate_pool_summary`; "list recruiter submissions"→`list_recruiter_submissions`; "rejected, tier_1 reusable"→`list_rejected_candidates`; "passed candidates for job X"→`list_passed_candidates_for_job`; "best candidates for job X, explain why"→`find_candidates_for_job`; "jobs for candidate Y"→`find_matching_jobs_for_candidate`; "prescreen ops snapshot"→`get_prescreen_ops_snapshot`; "ops metrics last 30d"→`get_ops_metrics`.
Writes (must confirm-first): advance/reject/request-info/comment submission; decide employer intro; re-evaluate tier (suggest then apply).
