# WeKruit AI Headhunter — Enterprise Customer Onboarding (research blueprint)

_Generated 2026-06-25 via 7-agent research workflow (Viktor deep-dive + B2B AI onboarding + AI-hiring compliance + recruiting-competitor onboarding + ATS integration + GTM). Modeled on the Viktor managed-easy-button posture, adapted for AI hiring. Companion to HEADHUNTER-SLACK-AGENT.md + HEADHUNTER-COMPETITOR-ATS-RESEARCH.md._

I'll create the comprehensive blueprint directly from the research provided.

# WeKruit AI Headhunter — Enterprise Customer Onboarding

> **Category:** Managed "AI recruiter employee" delivered inside Slack/Teams, over an MCP, on top of a retained ~5,300-candidate global pool. This blueprint mirrors Viktor's managed-easy-button onboarding posture, adapted to the regulatory, integration, and trust realities of AI-assisted hiring.

---

## 1. Positioning — Managed Easy-Button AI Recruiter vs. DIY

WeKruit is not a sourcing tool, a Boolean-search box, or a chatbot the customer has to configure and babysit. It is a **managed AI recruiter employee** that lives in the customer's existing Slack/Teams channel and *owns the outcome* between an open requisition and a scheduled first interview: it searches the retained candidate pool, runs two-way V16 matching and rediscovery against new reqs, conducts the first prescreen, summarizes verdicts, drafts and (after human approval) sends outreach, and books interviews — with a human-in-the-loop confirm gate on every consequential action. The conquest frame, copied directly from Viktor-vs-Claude-Tag, is **"hire, don't configure."** Competitors and in-house stacks hand recruiters a *building block* (a search index, an outreach sequencer, an LLM they must prompt). WeKruit hands them a *colleague* that already knows the candidate pool and does the work end-to-end. The "easy button" is concrete: **WeKruit does the integration, the job enrichment, the prescreen-rubric calibration, the matching, and the screening — the customer presses one button in a channel they already use.**

| Dimension | WeKruit (managed AI recruiter) | DIY / in-house sourcing (toolkit or human sourcer) |
|---|---|---|
| **What you get** | A colleague that owns req→scheduled-interview | A tool + a process you assemble and run |
| **Where it lives** | Slack/Teams channel you already use, over MCP | New dashboard(s) to learn; or a recruiter's inbox |
| **Candidate supply** | Retained ~5,300 global pool, re-activated per new req | Start from scratch every req; ATS applicants rot |
| **Time-to-first-value** | First qualified candidate surfaced in days | Weeks of sourcing setup; quarters for in-house ramp |
| **Sourcing** | Two-way V16 match + rediscovery, automatic | Manual Boolean / paid seat per recruiter |
| **Screening** | AI prescreen + summarized verdict, HITL on adverse calls | Manual phone screens, recruiter bandwidth-bound |
| **Outreach** | Draft + send (consent + suppression + confirm gates) | Manual sequences; compliance left to the customer |
| **Scheduling** | Cal.com booking inside the flow | Back-and-forth email/calendar tetris |
| **Setup burden** | We ingest reqs, enrich JDs, calibrate rubrics | You buy plan → keys → permissions → templates → train |
| **Compliance** | Bias-audit data, audit log, HITL, consent built in | You own LL144 audits, EU AI Act logs, EEOC exposure |
| **Cost anchor** | Priced against a loaded human recruiter/sourcer | Per-seat SaaS + headcount + tool sprawl |
| **Steps to start** | 3 (install → connect → ask) | 6+ (buy → key → codes → credits → perms → configure) |

---

## 2. The Enterprise Onboarding Journey

Two tracks run in parallel off one funnel: a **Day-1 easy-button** path (Section 3) that produces value in days, and the **full enterprise track** below for the SSO/SOC2/DPA/ATS buyers. Each stage names: customer action, WeKruit action, the **gate** that must clear to advance, and a typical timeline. Stages are gated — instrument every transition (this is also where deals stall).

### Stage 0 — Discovery / Fit (1–3 days)
- **Customer:** Names the success metric they're buying (e.g., qualified-candidate rate, time-to-first-interview, recruiter-override rate, sourced-hire count). Identifies 2–3 high-activity reqs for a pilot. Names the executive sponsor + recruiter champion.
- **WeKruit:** AE-led discovery; map the customer's req-intake → ATS → screening workflow; confirm pool overlap (do we already hold candidates relevant to their reqs?); scope pilot reqs.
- **Gate:** Written, quantitative success criterion agreed **before** the pilot, on the customer's *real* reqs (not a demo). AE→CSM handoff initiated.
- *Why it matters:* #1 cause of enterprise-AI pilot failure is unclear success criteria set at PoC start.

### Stage 1 — Security & Legal (2–6 weeks; the long pole — start immediately)
- **Customer:** Runs security review / questionnaire; legal reviews DPA + MSA; IT confirms data-residency and sub-processor requirements.
- **WeKruit:** Provide **SOC 2 Type II report** (or current Type I + Type II in progress), pre-filled security questionnaire / Trust Center, **signable standard DPA** with documented non-negotiables, **public sub-processor list** (OpenAI, Anthropic, SiliconFlow, Sendblue, Algolia, Coresignal, Instantly, Firebase, Cal.com), **no-training guarantee** (provider-level no-training agreements), and the **AI-hiring compliance pack** (bias-audit methodology, EU AI Act high-risk dossier, HITL/audit-log evidence — Section 4).
- **Gate:** Security review passed; DPA + MSA signed. *This is a hard gate — no SOC 2 = no deal for ~83% of enterprise HR buyers.*
- *Lever:* A templated DPA + SOC 2 Trust Center is the single biggest cycle-time reducer (custom DPA negotiation adds 4–12 weeks).

### Stage 2 — Provisioning & SSO (3–10 days, parallel to Stage 1)
- **Customer:** IT configures SAML/OIDC SSO (Okta / Entra / Google Workspace) for the WeKruit recruiter/employer dashboard; ideally SCIM for seat lifecycle.
- **WeKruit:** Self-serve SAML setup; inherit identity from Slack/Teams where possible; RBAC roles (recruiter, hiring manager, admin, HITL reviewer) scoped to least-privilege candidate-PII access.
- **Gate:** Recruiter org can sign in via SSO; seats provisioned (auto-deprovision via SCIM if available).

### Stage 3 — Connect Channels (Slack / Teams) (~2 minutes — the easy-button moment)
- **Customer:** Install WeKruit from the Slack App Directory / Teams; one OAuth connect; admin sets approval policies (who can approve sends, who sees PII).
- **WeKruit:** Agent appears in-channel as a colleague; inherits SSO/MFA/provisioning from the collaboration surface; no new app for recruiters to learn.
- **Gate:** Agent responds in the customer's channel; admin policy (HITL approvers) configured.

### Stage 4 — ATS Integration + Data Ingestion (24–48h native; 1–2 wks net-new; 6–8 wks Workday)
- **Customer:** ATS admin authorizes connection (designate service user/role; for Workday, IT provisions the Integration System User + security groups + endpoints).
- **WeKruit:** Connect via **unified API (Kombo, lead) or Ashby/Greenhouse/Lever direct**; ingest **open requisitions IN** (to match against) and **existing candidate pool IN** with field mapping (status, rejection reason, last-contact-date, owner — to power rediscovery / "silver medalists"); configure **source-attribution write-back OUT** (WeKruit-credited candidates, stage changes, notes). See Section 5.
- **Gate:** Open reqs syncing; candidate pool imported & deduped; one test candidate written back with correct WeKruit source attribution.
- *Why it's the long pole:* ATS integration is consistently the most time-consuming step; kick it off at the *start* of the timeline, especially Workday.

### Stage 5 — JD Intake & Calibration (3–7 days)
- **Customer:** Hiring managers answer clarifying questions on pilot reqs; recruiters confirm must-haves vs. nice-to-haves.
- **WeKruit:** Run `intake_job` (JD enrich + clarifying questions); generate per-role **prescreen config + scoring rubric**; calibrate matching axes; generate eval fixtures; route low-confidence enrichment to HITL.
- **Gate:** Calibrated rubric + prescreen config signed off per pilot req; "configuration done, not out-of-box" (the hireEZ lesson — out-of-box use degrades quality).

### Stage 6 — Pilot / POC with Success Criteria (4–6 weeks)
- **Customer:** Recruiters work the 2–3 pilot reqs alongside the agent; HITL reviewers approve/override; weekly check-ins.
- **WeKruit:** Run matching + rediscovery + prescreen on real candidates; HITL on every adverse decision; track the Stage-0 metric **plus** recruiter-override rate (which doubles as flywheel/eval data), false-positive screen rate, P95 latency.
- **Gate:** Pre-agreed **written go/no-go decision rule** met (e.g., ≥X qualified candidates surfaced, override rate ≤Y, time-to-first-interview ↓Z%). Production-readiness checklist passed. *A written go/no-go rule is what prevents "pilot purgatory."*

### Stage 7 — Go-Live / Rollout (2–4 weeks of change management)
- **Customer:** Expand to more reqs/teams; recruiter enablement; define where the agent acts vs. where humans approve; internal champion drives adoption.
- **WeKruit:** Scale matching across reqs; role-based training (recruiter, HM); certification/enablement materials; turn on scheduled sourcing/rediscovery crons + proactive follow-up so value is continuous, not on-demand.
- **Gate:** Adoption threshold hit (the recurring failure mode is *adoption*, not integration — structured change management yields ~2.3× higher adoption).

### Stage 8 — CSM / QBR (ongoing)
- **Customer:** Named admin + champion; reviews outcomes at QBR.
- **WeKruit:** Named CSM; first QBR baselined on the Stage-0 metric; publish time-to-first-interview, response-rate lift, sourced-hire / rediscovery stats; feed HITL corrections into eval/regression flywheel.
- **Gate:** Renewal / expansion criteria tracked from day one.

**Timeline summary:** Easy-button value in **days**; full enterprise go-live **6–12 weeks** (longer if Workday + deep integration). Budget **4–6 wks pilot + 2–4 wks rollout** as the change-management arc.

---

## 3. Day-1 Easy-Button (3 Steps)

Mirrors Viktor's Connect → Ask → Deliver, scoped to headhunting. Designed for a frictionless pilot *before* procurement (no card, first N candidates screened free).

1. **Connect (~2 min).** Install WeKruit from Slack/Teams. One OAuth connect to the channel. (ATS connect optional at this stage — the pool already exists.)
2. **Drop a JD (ask).** Paste or `intake_job` a real requisition in the channel. WeKruit enriches it, asks 1–3 clarifying questions, and calibrates a rubric on the spot.
3. **Get candidates (deliver).** WeKruit returns matched + rediscovered candidates from the retained pool with **why-matched explanations**, runs a prescreen on the willing, and surfaces summarized verdicts — outreach is drafted and waits for your one-click approval.

> The wedge against enterprise-gated incumbents (Claude Tag ships only to Enterprise/Team contracts): WeKruit's **first qualified candidate happens with zero procurement friction**, consistent with our rule that *match score never blocks the first interview.*

---

## 4. Compliance & Trust Checklist (AI Hiring)

The convergent enterprise demand across NYC LL144, EEOC Title VII, EU AI Act, GDPR Art. 22, CCPA/CPRA, IL AIVIA/BIPA, and Colorado: **notice/consent, human-in-the-loop on adverse actions, explainability, bias/adverse-impact metrics, audit logging, RBAC, retention limits, and SOC 2 + DPA.** Status legend: ✅ have · ⚠️ partial · ❌ build.

| Requirement | What buyers demand | Status | WeKruit basis / gap |
|---|---|---|---|
| **SOC 2 Type II** | De-facto minimum; "no report, no deal" (~83%) | ❌ | Must obtain (Type I → Type II). No story today. |
| **Signable DPA + sub-processor list** | Mandatory data-processor terms; public sub-processors | ❌ | Build standard DPA + publish sub-processor list. |
| **Bias audit / NYC LL144** | Independent annual audit; selection-rate & impact-ratio (4/5 rule) export; published summary; 10-day candidate notice + opt-out/alt process | ⚠️→❌ | Have decision data (match/screen verdicts) but **no selection-rate-by-protected-group export, no candidate notice/opt-out surface.** Build adverse-impact instrumentation + notice/opt-out. |
| **EEOC Title VII (adverse impact)** | Customer-specific, *continuous* selection-rate monitoring by protected category at each screen-in/out/rank; ability to tune/remove biasing features; indemnity | ❌ | Build self-audit dashboard; instrument selection rates per stage. |
| **EU AI Act (high-risk)** | Conformity docs, data-governance/bias dossier, human oversight, transparency notices, **automatic tamper-evident logging** of every inference; obligations ~Aug 2026 | ⚠️→❌ | HITL + correction events partially cover oversight; **need exportable per-inference automatic log + conformity dossier.** |
| **GDPR Art. 22 (no solely-automated adverse decision)** | Human review on adverse decisions; lawful basis ≠ candidate consent; right to contest/appeal | ⚠️ | Have HITL/confirm-first on writes; **need configurable human-review gate on every NOT_PASS/auto-reject + candidate contest/appeal path.** |
| **GDPR/CCPA candidate consent & DSAR** | Notice-at-collection w/ per-category retention; access/delete/correct; opt-out of sale/sharing; sensitive-PII handling | ⚠️ | Have consent gates on outreach; **need candidate-facing notice + DSAR (access/delete/correct) tooling.** |
| **Data residency** | EU residency option on enterprise contracts | ❌ | Firestore single-region today; build EU-residency path. |
| **Retention limits** | Per-purpose timers; auto delete/anonymize (unsuccessful 6–12 mo; pool 12–24 mo w/ consent + renewal) | ⚠️ | Retained pool is in *tension* with minimization. **Build configurable per-purpose retention timers + automated purge + consent-renewal prompts.** |
| **Explainability (match + screen)** | Per-decision "why matched / why screened out" reconstructable | ✅→⚠️ | V16 emits why-matched; `summarize_prescreen` gives verdict rationale. **Harden into exportable per-decision explanation.** |
| **Human-in-the-loop on adverse actions** | Approval gate on consequential actions (send, pass/reject, employer-reveal) | ✅ | Confirm-first on all MCP writes; consent + suppression on outbound; employer-visible profiles consent-redacted. |
| **Audit log / decision trail** | Immutable, queryable: every match, prescreen verdict, outbound, HITL override — incl. what reviewer saw + final owner | ⚠️ | Have CorrectionEvent/HITL audit concept + Firestore events; **extend to complete, exportable, immutable decision trail.** |
| **RBAC + least-privilege PII access** | Role-scoped access; timely offboarding; encryption in transit/rest | ⚠️ | Need formal RBAC roles + SSO-driven offboarding for the dashboard. |
| **IL AIVIA / BIPA (if voice/video)** | Written consent + AI explanation before video AI; 30-day recording deletion; BIPA written consent + published retention if voiceprints | ⚠️ | Voice prescreen exists; **if it derives voiceprints, build written-consent capture + 30-day deletion + no-biometric-profiting posture.** |
| **Colorado / appeal & correct-data** | Impact assessments; candidate appeal of adverse decision + correct-your-data | ❌ | Build candidate appeal/correction workflow (also satisfies GDPR/EU/NYC overlap). |

**Strongest defensible claims to lead with today:** HITL confirm-first on every write, consent + suppression gates on outbound, consent-redacted employer-visible profiles, why-matched/why-screened explainability. **Hard gates to close before enterprise:** SOC 2 Type II, DPA, bias-audit export, candidate notice/opt-out/appeal, retention timers.

---

## 5. Integration & Data Plan

**ATS — lead with unified API, offer direct for marquee accounts.**
- **Primary: Kombo (or Merge).** One build → Greenhouse, Ashby, Lever, Workday, SmartRecruiters, iCIMS, Oracle; normalized candidate/application/requisition models; embeddable white-labeled connect flow; pass-through/custom fields for edge cases. Compresses per-customer onboarding and short-circuits each ATS's monthly/multi-week partner-approval cycle (the vendor already holds partner status).
- **Direct: Ashby** (REST + GraphQL + webhooks `application.stage.changed`/`offer.accepted`; native click-to-connect 24–48h) for design-partner depth; **Greenhouse Ingestion API** (the *minimal sourcing surface* — post candidates/prospects + read stage/status, not full pipeline; smaller security review than Harvest) for sourced-candidate write-back.
- **Scope inbound vs. outbound explicitly at onboarding:** IN = open reqs, candidate pool (status, rejection reason, last-contact, owner). OUT = new sourced candidates, stage changes, notes, **source attribution**. Cadence = webhooks + polling.
- **Workday** = customer ISU provisioning + security groups; budget 6–8 wks; a unified API abstracts the linking but the customer admin still must create the ISU.

**SSO / SCIM.** SAML 2.0 / OIDC (Okta, Entra, Google Workspace) for the recruiter/employer dashboard; SCIM for automated seat lifecycle (frequent mid-market/enterprise deal-gate). Self-serve SAML setup + audit trails to keep IT off the critical path. (Candidate side stays magic-link.)

**Candidate-pool import.** Map ATS fields that power rediscovery: **status, rejection reason ("silver medalists"), last-contact-date (>6 mo filter), owner.** Dedup against ATS email-based matching (esp. Lever) to avoid duplicate candidates. Non-API fallback (CSV/bulk/RPA) for ATSs without clean APIs.

**Source attribution write-back (the commercial heart).** Every candidate POST must set the **referrer/source = a named WeKruit user/source in the customer's ATS** — silence defaults credit to whichever user the API key acts on behalf of (Greenhouse "Who Gets Credit" auto-populates the current user). Capture the customer's desired attribution at onboarding; for Greenhouse Basic Auth, designate the service user + `On-Behalf-Of` header. **No attribution → customer can't measure ROI → WeKruit can't prove sourced-hire value.** Credentials never reach the LLM — inject ATS keys via a backend gateway at execution time (architecture, not policy).

---

## 6. Pricing & Commercial Motion

**Recommended: hybrid base + usage, workspace-based, with an outcome upside — anchored against a human recruiter, not ATS seats.**

| Option | Structure | Use when | Notes |
|---|---|---|---|
| **Workspace + usage credits** (Viktor model) | Shared org credit pool, no per-seat | Default — removes "how many seats" friction; lets a whole TA org pilot Claire | Self-serve ladder up to a $/mo wall, then sales-led. Pure usage risks bill-shock. |
| **Per-seat** | $/recruiter/mo | Buyer demands predictability | Friction-heavy; rejected by modern AI-employee GTM; avoid seat minimums. |
| **Success-based** | Per qualified candidate / per interview / per sourced-hire | Maps naturally to recruiting; most defensible vs. seats | Best as the *variable* component of a hybrid, not standalone. |
| **Hybrid (recommended)** | Predictable base fee + usage (screens/matches) + optional outcome bonus | Enterprise default in 2026 | Caps bill-shock; aligns with value. |

**Motion:** Freemium-style frictionless pilot (first N candidates screened free, no card) → land via the easy-button → expand via usage → **sales-led wall at the enterprise tier** (SSO, DPA, SLA, data residency, dedicated onboarding). **Cost anchor:** "cheaper than a junior sourcer/recruiter" — some Viktor customers spend more on the AI than a junior hire. **Enterprise tier line items:** invoicing + custom billing, security review + DPA, SLA + priority support, dedicated onboarding + tailored limits/controls, **no seat minimums.** **TCO honesty:** implementation/tuning (JD enrichment, rubric calibration, ATS integration) is a large share of TCO — scope it as part of paid dedicated onboarding (a priced onboarding SKU, $2K–$20K range per market comps).

---

## 7. Gap Analysis & Prioritized Build Order

**Have today (built + live):** candidate-pool search · two-way V16 matching · rediscovery · prescreen + `summarize_prescreen` · draft+send outreach (Sendblue SMS, dev-gated + suppression + consent) · `schedule_interview` (Cal.com) · `intake_job` (JD enrich + clarifying Qs) · recruiter-submission triage · candidate tiers · passed-candidate employer-visible profiles (consent-redacted) · retained ~5,300 pool (Firestore) · HITL/confirm-first on writes.

| Onboarding requirement | Have today | Must build | Effort |
|---|---|---|---|
| Slack/Teams easy-button install + OAuth | Slack agent over MCP live | Teams parity; App Directory listing; admin approval-policy UI | **M** |
| Day-1 3-step flow (connect→JD→candidates) | All pieces exist (`intake_job`, V16, prescreen) | Package as a guided first-run in-channel | **S** |
| SOC 2 Type II | — | Full audit program (Type I → II) | **L** |
| Standard DPA + public sub-processor list | — | Legal templates + Trust Center page | **M** |
| Bias-audit export (LL144 / EEOC selection-rate by group) | Decision data exists | Adverse-impact instrumentation + impact-ratio export + dashboard | **L** |
| EU AI Act automatic per-inference logging + conformity dossier | Firestore events, CorrectionEvent | Tamper-evident exportable inference log + docs | **L** |
| Candidate notice / consent / opt-out / appeal + DSAR | Outreach consent gates | Candidate-facing notice + opt-out/alt-process + appeal + access/delete/correct | **L** |
| Retention timers + auto-purge + consent renewal | Retained pool | Per-purpose timers + purge jobs + renewal prompts | **M** |
| Human-review gate on adverse (NOT_PASS/auto-reject) | HITL confirm-first on writes | Explicit configurable adverse-decision gate | **M** |
| Exportable per-decision explainability | V16 why-matched + verdict rationale | Harden + export format | **M** |
| Immutable, queryable, exportable audit trail | CorrectionEvent/HITL audit concept | Extend to complete decision trail + export | **M** |
| RBAC + SSO/SCIM for dashboard | — | SAML/OIDC + SCIM + role model | **M** |
| Data residency (EU) | Single-region Firestore | EU-residency deployment path | **L** |
| ATS integration (read reqs + pool, write source attribution) | None (research done) | Kombo unified + Ashby/Greenhouse-Ingestion direct; referrer/source write-back; ISU runbook | **L** |
| Candidate-pool import field mapping (status/reason/last-contact/owner) | Pool exists internally | ATS import mapper + dedup | **M** |
| Credential gateway (ATS keys never reach LLM) | — | Backend secrets-vault injection at call time | **M** |
| Pilot success-metric instrumentation (override rate, qualified rate, TTFI) | Some signals | Pilot dashboard + go/no-go tracking | **M** |
| IL AIVIA/BIPA consent + 30-day deletion (voice) | Voice prescreen exists | Written consent + deletion automation (only if voiceprints derived) | **M** |

### Prioritized Build Order (to be enterprise-onboarding-ready)

**Phase A — Clear the hard gates (no enterprise deal without these):**
1. **SOC 2 Type II program** (L) — kick off immediately; longest lead time.
2. **Standard DPA + sub-processor list + Trust Center** (M).
3. **Credential gateway** (M) — ATS keys never touch the LLM; de-risks every integration.
4. **SSO/SAML + RBAC** for the dashboard (M); SCIM fast-follow.

**Phase B — AI-hiring compliance (the recruiting-specific gates):**
5. **Immutable exportable audit trail + per-decision explainability** (M+M) — foundation for everything below.
6. **Bias-audit / selection-rate export** (L) — LL144 + EEOC.
7. **Human-review gate on adverse decisions** (M) — GDPR Art. 22.
8. **Candidate notice/opt-out/appeal + DSAR** (L); **retention timers + purge** (M).
9. **EU AI Act inference logging + conformity dossier** (L) — ahead of Aug 2026.

**Phase C — Integration & data (the value-delivery path):**
10. **Kombo unified ATS + Ashby/Greenhouse-Ingestion direct + source-attribution write-back** (L).
11. **Candidate-pool import mapper + dedup** (M); Workday ISU runbook.

**Phase D — Onboarding UX & GTM packaging:**
12. **Teams parity + App Directory listing + admin policy UI** (M).
13. **Day-1 3-step guided first-run** (S).
14. **Pilot success-metric dashboard + go/no-go tracking** (M).
15. **Data residency (EU)** (L) — gate only for EU expansion; defer until a deal requires it.

**Critical path:** Phase A items 1–3 unblock the first enterprise security review; Phase C item 10 unblocks the first enterprise *value* (reqs in, sourced candidates credited out). Start SOC 2 and the ATS unified-integration build **now** — they are the two longest poles and gate, respectively, *contracting* and *value delivery*.
