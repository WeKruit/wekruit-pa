# AI Headhunter — Harsh QA & Product Review (2026-06-25)

_Adversarial 7-agent audit: code-level truth vs claimed-done, per capability._

# AI Headhunter — Harsh QA & Product Review

## 1. Blunt Verdict

The AI headhunter is a **read-and-research tool with a demo skin on top of it — not a working recruiting agent.** What a real customer could actually use today: it can *read* an existing prescreen and summarize it, it can *research/rank* candidates against the scraped job catalog (with caveats), and it can *enrich* a raw JD into draft tags and questions. That's it. Everything that implies *action on the candidate's behalf* — book an interview, message a real candidate, connect an ATS, onboard an employer — is either dev-phone-gated to Adam and Noah's two hardcoded numbers, a "coming soon" placeholder, or a calculator that throws its output away at end of turn. Calendar can't book (offer-only, book-on-behalf explicitly unbuilt). Email-to-candidate doesn't exist at all. ATS is one unverified inbound adapter plus three 501 stubs — no Kombo, no Ashby, no write-back in any direction, despite memory claiming "ATS=Kombo/Ashby." The employer onboarding "easy-button" is 1 of 7 steps real, and even that 1 step only writes to browser localStorage. **Nothing in this product moves a real candidate through a real hire today.**

## 2. Scorecard

| Capability | Claimed | ACTUAL | One-line truth | Severity |
|---|---|---|---|---|
| Calendar / book interview on candidate's behalf | "BUILT", real Cal.com booking | **PARTIAL** | Headhunter can only *offer* slots; book-on-behalf is explicitly unbuilt; real booking is a separate candidate-driven tool gated to 2 dev uids. | High |
| Email to candidate (agent) | (not claimed) | **DONE_E2E** | Agent honestly has no candidate-email tool — outreach is SMS-only by design; the one "email" verb is recruiter-only. No overclaim. | Low |
| ATS integration (connect / read / write-back) | "Handshake live", ATS=Kombo/Ashby | **STUB_ONLY** | One unverified inbound adapter (Handshake) + 3 × HTTP 501 stubs; zero write-back; no Kombo/Ashby/Merge code exists. | High |
| Headhunter outbound SMS | "e2e-verified", write gate confirm-first | **PARTIAL** | Wired end-to-end to the real Sendblue path, but ramp flag is OFF in prod — only Adam/Noah's 2 numbers can receive; full async path untested; no proof of a real send. | High |
| Employer onboarding wizard (7-step) | "managed easy-button", ATS sync runs in background | **STUB_ONLY** | 1 of 7 steps functional (a radio button); other 6 are "coming soon" placeholders; state never leaves the browser. | High |
| Matching (find/search/rediscover) | "8/8 GREEN live" | **PARTIAL** | Tools return rows, but reverse-match's 0.40-weight llmMatch is permanently 0 and tools can't target real WeKruit collab jobs (pa-jobs) — only the scraped catalog. | High |
| Prescreen summary (summarize_prescreen) | (part of "8/8") | **DONE_E2E** | Reads real persisted judge output (scores, red flags, engagement, terminal cause). The one genuinely solid end-to-end piece. | — |
| Job intake (intake_job) | "intake_job done" | **STUB_ONLY** | Enrichment compute is real but persists NOTHING and has no reachable approve/create tool — the draft is discarded at end of turn. | High |

## 3. Told vs Reality

These are the specific overclaims. State them plainly so they stop recurring.

- **"Scheduling is BUILT / real Cal.com booking."** The *headhunter* cannot book. `schedule_interview` pulls availability and writes an "offered" doc — it sends no message and creates no booking. The docstring itself says book-on-behalf is "pending" (`scheduling.ts:11-14`). The only real booking tool lives in the *candidate-facing* Claire agent and requires the candidate to reply and pick a slot themselves — and it's gated to two dev uids. Also: `schedule_interview` is annotated `READ_ONLY` but writes to `pa-interview-bookings`. That's a lie in the tool surface.

- **"intake_job done (JD enrichment + clarifying questions)."** It computes correct enrichment, then throws it away. Zero Firestore writes, no approve/persist/create-job tool anywhere in the MCP. A "done" intake capability that produces no durable, matchable job is not done — it's a calculator.

- **"ATS=Kombo/Ashby" / "Handshake live."** No Kombo, Ashby, Merge, or Workday code or dependency exists anywhere in the repo. The only ATS sources are handshake/greenhouse/lever/linkedin — three of which return HTTP 501. Handshake's own code comments admit its payload shape is unconfirmed. There is no write-back in either direction. "Live" overstates a single, unverified, inbound-only adapter with no evidence of a real partner.

- **"8/8 read+match tools GREEN live."** "GREEN" meant "returns a 200 with rows," not "ranks correctly." Every reverse-match candidate carries `risks: ['llm_score_unavailable']` because the 0.40-weight llmMatch is read from a `pa-users` field that nothing writes (the real score lives per-(user,job) in `pa-user-rerank-cache`). And these tools can't even target the `pa-jobs` collection candidates actually get prescreened for.

- **"e2e-verified" outbound SMS.** The only test covers the pure synchronous dev-phone gate. The full async path (suppression, inbound-evidence, enqueue, worker drain, Sendblue POST) has zero test coverage and zero evidence of a real delivered send. And `PA_HEADHUNTER_OUTBOUND_RAMP_ALL` is unset in the deployed env, so no real candidate can be messaged at all.

- **"Onboarding easy-button where ATS sync and security run in the background."** 6 of 7 steps are identical "isn't wired up yet in this build" placeholders with a Skip button. The captured success metric never leaves `localStorage`. There is no `paOnboardingState` backend despite the name appearing in comments.

The pattern: **"wired and deployed" was reported as "works." "Returns 200" was reported as "verified." "Compute runs" was reported as "feature done."** None of those are the same thing.

## 4. Real Remaining Work — Calendar, Email, ATS (priority order)

### Calendar (make book-on-behalf genuinely done)
1. **[M] Extract a SDK-free book-on-behalf core** from the candidate `book_interview_slot` logic (`scheduling-tools.ts:755-1089`) — the docstring's "book core extraction pending." This is the keystone.
2. **[S] Register a `book_interview` MCP tool** on top of that core so the headhunter can actually book, not just offer.
3. **[M] Wire the offer→send→book loop** so an offer auto-sends via Sendblue and a candidate pick completes the booking without manual operator steps.
4. **[S] Fix the `READ_ONLY` annotation** on `schedule_interview` (it mutates Firestore) and **disable `DEV_MIMIC_SCHEDULABLE_JOBS`** for any real run.
5. **[S] Ramp `paSchedulingEnabled`** beyond Adam/Noah, then **[S] verify `createBooking` against a real interviewer calendar** with one consenting non-dev candidate.

### Email (decide if it's even in scope, then build the channel)
1. **[S] Decision first:** does the headhunter need candidate *email* at all? Today's design is deliberately SMS-only and that's defensible. If email stays out of scope, **the only "remaining work" is correcting the docs** — no code needed. (This is the one capability that is *not* overclaimed.)
2. **[M] If yes:** build a net-new email-outreach MCP tool with its own safety gates (suppression, prior-inbound-evidence, opt-out, idempotency) — mirror the SMS gate chain. The external-supply Instantly path is dry-run-gated and not wired to the agent; do not assume it's reusable as-is.
3. **[S] To send to real candidates by any channel:** flip `PA_HEADHUNTER_OUTBOUND_RAMP_ALL` (Adam-gated) — without it, even SMS is dev-phone-only.

### ATS (this is the biggest gap — currently near-zero)
1. **[L] Pick the architecture:** adopt a unification provider (Kombo or Merge, as memory implies) vs. per-ATS clients (Greenhouse Harvest, Ashby, Lever). Memory says Kombo/Ashby but no such code exists — this is a from-scratch build, not a wiring task.
2. **[L] Build the "Connect ATS" OAuth/authorize flow** in employer onboarding (currently a `ComingSoonStep`) plus token storage/refresh.
3. **[M] Implement read-back** of open reqs + candidate pool — the onboarding copy already promises this and nothing delivers it.
4. **[L] Implement write-back** (create candidate/application, stage updates) — entirely absent in every direction today.
5. **[M] Replace the 3 stub inbound adapters** (greenhouse/lever/linkedin) with schema-verified parsers + per-source HMAC secrets, and **[S] verify Handshake** against real docs before ever calling it "live."

**Honest sequencing:** Calendar is closest to done (one extraction + one tool away). Email is a scoping decision, not necessarily work. ATS is effectively a greenfield epic — treat any "ATS is built" framing as false and plan it as net-new.

## 5. What's Genuinely Solid (credit where it's e2e-real)

- **`summarize_prescreen`** — reads real persisted judge output (per-question score/confidence, red flags, `engagementSignal`, terminal cause) written by the live prescreen pipeline. Real read-only value today, no caveats.
- **Email honesty** — the agent correctly does *not* claim to email candidates; outreach is SMS-only and the one "email" verb (`comment_on_submission`) is honestly scoped to recruiter notifications, consistent with the LOCKED recruiter-only rule. This is the model for how the other capabilities should have been reported.
- **Cal.com client primitives** — `getAvailableSlots` (GET /v2/slots) and `createBooking` (POST /v2/bookings) are real, functional, with correct per-endpoint API-version headers. The secret is bound. The plumbing under the missing book-on-behalf tool is genuinely there.
- **Outbound SMS safety chain** — the gate architecture is real and layered (length/empty reject, dev-phone gate, fail-closed suppression, never-cold-open inbound-evidence, idempotency, worker re-applies RULE 1 at dequeue). It's correctly built; it's just gated off and unproven by test.
- **intake_job enrichment compute** — uses the real production enricher (`enrichJobTags`, `deriveJobOpportunityDraft`) to produce correct canonical tags, hard filters, and draft questions. The output is right; it just has nowhere to go.
- **The MCP server itself is deployed** (`paHeadhunterMcp` exported) and the read/research tools execute and return structured rows. The skeleton is real — it's the action-taking muscle that's missing or gated.

**Bottom line for the founder:** you were right to call it out. Calendar, email, and ATS are not done. Calendar is offer-only, email-to-candidate doesn't exist, and ATS is three 501 stubs plus one unverified adapter with no write-back and no Kombo/Ashby. What's real is the *reading and ranking* layer — valuable, but it's a research assistant, not yet a headhunter that does anything on a candidate's behalf in production.
