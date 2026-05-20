# PRD: CoreSignal Candidate Intake + Outbound Pipeline (Dashboard E2E)

**Status:** Draft for engineering handoff
**Author:** Adam directive 2026-05-20
**Relationship:** Extension of [INITIATIVE-external-candidate-supply-intake.md](./INITIATIVE-external-candidate-supply-intake.md) v1 (Juicebox/Lessie) → adds **CoreSignal** as third source + closes E2E from operator-paste → Instantly-send → reply.
**Codebase:** All work extends existing `packages/external-supply/`, `apps/functions/src/external-supply/`, and `apps/dashboard-web/src/pages/external-supply/`. Do **not** create parallel data model.

---

## 1. One-Sentence Statement

> Operators paste a CoreSignal candidate ID list into the existing **External Supply** dashboard. The system fetches CoreSignal employee + company JSON, normalizes into `pa-users` global profile (reusing resume tagging + memory pipeline), evaluates each candidate against active company/job rubric, generates LLM personalized pitch email, and sends through Instantly with full webhook tracking + suppression/opt-out gates — all from one dashboard, zero CLI.

---

## 2. Why This Now

**Current gap:**

1. External-supply v1 adapters cover Juicebox + Lessie CSV upload. **No CoreSignal collect API adapter** — only the older nested-shape CSV import.
2. Resume tagging pipeline (`pa-resume-parser` v2 → `mergeUserTags` → `pa-users.tags`) is mature. **LinkedIn experience structured data NOT routed through same pipeline** — only resume text is.
3. Match → outbound is wired (`pa-outreach-plans` + `instantly-sync.ts` + `instantly-webhook.ts`), but operator workflow has gaps: no "fetch by ID list" path, no clear handoff from CoreSignal Playground export → ingest.
4. Candidate sign-in claim (email-match → bind pre-created profile) works for resume bulk upload; **must verify same path works when source is CoreSignal LinkedIn data** (no resume).

**Why CoreSignal specifically:**

- CoreSignal Playground gives operator a clean way to filter + export candidate ID lists.
- API returns structured `experience[]`, `education[]`, `skills[]`, `headline` — richer than parsed-resume freetext.
- Same API also returns company enrichment — feeds `matching-jobs` schema directly.

---

## 3. Non-Goals (V1)

- ❌ No new tagging vocabulary. Reuse `packages/shared-tags` canonical 17/42/45 enums.
- ❌ No new matching algorithm. Reuse `queryMatchingJobs` V16 cascade.
- ❌ No fully-autonomous send. **All outbound requires operator approval click** in dashboard.
- ❌ No LinkedIn DM automation (V1 = manual task generation only — already locked).
- ❌ No CoreSignal full-text scraping beyond official API.
- ❌ No deep employer-facing surface — operator-only.

---

## 4. Architecture Diagram

```mermaid
flowchart TD
    subgraph Operator["Operator (Dashboard)"]
        A[Paste CoreSignal ID list<br/>or upload CSV] --> B[/admin/external-supply/<br/>batch/new]
    end

    subgraph Ingest["Ingest (Cloud Functions)"]
        B --> C[paCoresignalFetchBatch<br/>NEW CF]
        C -->|per id| D[CoreSignal collect API<br/>employee_multi_source +<br/>company_multi_source]
        D --> E[normalize.ts<br/>existing — add coresignal-collect-v2 adapter]
        E --> F[resolve-identity.ts<br/>canonical LinkedIn URL hash<br/>→ pa-candidate-identity-index]
    end

    subgraph Profile["Profile Layer (Firestore)"]
        F -->|merge or create| G[(pa-users/uid)]
        F --> H[(pa-external-candidate-records)]
        F --> I[(pa-candidate-source-links)]
        E --> J[mergeUserTags<br/>existing lib]
        J --> G
        K[LinkedIn experience text<br/>→ enrichment-input format] --> L[pa-resume-parser v2<br/>existing — accept new source_type]
        L --> J
    end

    subgraph Match["Match (existing)"]
        G --> M[queryMatchingJobs V16<br/>hard filter + soft score +<br/>LLM rerank]
        M --> N[(pa-candidate-company-job-evaluations)]
    end

    subgraph Outbound["Outbound"]
        N --> O[paGeneratePitchEmail<br/>NEW CF — LLM with evidence-only prompt]
        O --> P[(pa-outreach-plans<br/>status=draft)]
        P --> Q{Operator review<br/>dashboard /admin/external-supply/outreach}
        Q -->|approve| R[instantly-sync.ts<br/>existing]
        R --> S[Instantly campaign]
        S --> T[instantly-webhook.ts<br/>existing]
        T --> U[(pa-outreach-events)]
        T -->|bounce/unsub| V[(pa-suppression-list)]
    end

    subgraph Candidate["Candidate Sign-In (existing v2.0 marketplace)"]
        W[candidate.wekruit.com<br/>magic-link sign-in] --> X{email match<br/>pa-users.identities}
        X -->|hit| Y[claim pre-created<br/>pa-users profile]
        X -->|miss| Z[create new]
        Y --> AA[Optional: upload resume<br/>→ merge with CoreSignal data]
    end

    style C fill:#ffe8cc
    style O fill:#ffe8cc
    style E fill:#d4edda
    style J fill:#d4edda
    style L fill:#d4edda
    style M fill:#d4edda
    style R fill:#d4edda
    style T fill:#d4edda
```

**Legend:** 🟧 orange = NEW code. 🟩 green = existing module to extend.

---

## 5. Module Mapping (existing → extend)

| Concern | Existing module | What to add |
|---|---|---|
| CoreSignal collect API client | none | `packages/external-supply/src/coresignal-collect-client.ts` (mirror `scripts/coresignal-fetch-employees.mjs` with secret manager auth) |
| Source detection | `adapter-detect.ts` | Add `coresignal_collect_v2` enum value (additive) |
| Normalize | `apps/functions/src/external-supply/adapters/coresignal.ts` | Add sibling file `coresignal-collect-v2.ts` for new flat shape |
| Identity resolution | `resolve-identity.ts` | No change — canonical LinkedIn URL hash path works |
| Tagging from LinkedIn exp | `pa-resume-parser` v2 | Add `source_type: 'coresignal_linkedin'` input mode accepting structured `experience[]` |
| Tag merge | `mergeUserTags` | No change |
| Match | `queryMatchingJobs` V16 | No change |
| Evaluation rubric | `evaluate.ts` | No change |
| Pitch email gen | `agent-prompt.ts` (ranking only) | **NEW** `generate-pitch-email.ts` CF with hallucination guardrails |
| Instantly send | `instantly-sync.ts` | No change |
| Webhook | `instantly-webhook.ts` | No change |
| Suppression | `pa-suppression-list` collection | Verify wired in `instantly-sync.ts` preflight |

---

## 6. New Cloud Functions

| Function | Trigger | Purpose |
|---|---|---|
| `paCoresignalFetchBatch` | HTTPS admin callable | Operator submits ID list → fetches CoreSignal API in worker pool (4 concurrent, 3 retries on 429/5xx) → writes `pa-external-candidate-records` → enqueues identity-resolve job |
| `paGeneratePitchEmail` | HTTPS admin callable | Input: `{candidateId, jobId, matchId}`. Output: draft `pa-outreach-plans` doc. Uses gpt-5.4-nano primary, Sonnet-4-6 fallback |
| `paApproveAndSendOutreach` | HTTPS admin callable | Preflight suppression check → call `instantly-sync` → update `pa-outreach-plans.status` |

All secured by `@wekruit.com` admin claim (matches existing `admin-bootstrap.ts` pattern).

---

## 7. LLM Pitch Email — Hard Guardrails

```
SYSTEM:
You are writing a recruiter outreach email. You may ONLY reference facts present
in the provided candidate_evidence, job_evidence, and match_evidence blocks. If
a relevant fact is missing, omit it — do not infer.

NEVER mention: age, gender, race, religion, marital, health, immigration status,
perceived seniority unless explicitly tagged, compensation expectations.

REQUIRED:
- candidate first name from candidate_evidence.full_name
- exactly 1 specific experience overlap from candidate_evidence.experiences
- exactly 1 job requirement from job_evidence.requirements that overlaps
- opt-out line: "Reply 'stop' and I won't follow up."

LENGTH: 80–150 words.

OUTPUT JSON:
{
  "subject": "<70 chars>",
  "body": "<plain text, no markdown>",
  "used_evidence": [{"type":"...","source_id":"...","text":"<verbatim quote>"}],
  "confidence": 0.0–1.0,
  "risk_flags": ["fabricated_claim"|"sensitive_attribute"|"missing_evidence"]
}

If candidate_evidence is empty OR match_score < 0.5 OR no overlap found, return:
{"status":"insufficient_evidence","reason":"..."}
```

---

## 8. Compliance Gates

Every outbound send must pass, in order, BEFORE Instantly API call:

1. Email verified or imported from CoreSignal (deliverability score ≥ 0.7)
2. `pa-suppression-list/{emailHash}` does NOT exist
3. No outbound to same candidate in last 30 days
4. No outbound for same `(candidate, company)` ever (cap = 1 outreach per company)
5. Operator approval timestamp present
6. Outbound rate < 50/account/day, < 500/account/group/day

Failure on any gate → `pa-outreach-plans.status = blocked`, log reason, no API call.

---

## 9. Phased Rollout

| Phase | Scope | Est |
|---|---|---|
| P1 | CoreSignal client + adapter + batch fetch CF + dashboard paste UI | 2 days |
| P2 | LinkedIn experience → resume-parser tagging path | 1 day |
| P3 | Pitch email CF + prompt + 3 evals | 2 days |
| P4 | Approve-and-send CF + suppression gates + outreach detail page | 1.5 days |
| P5 | E2E scenario test + ship gate | 1 day |
| **Total** | | **~7.5 dev-days** |

Sequential dependency. Ship P1+P2 first → operator validates 3 days → ship P3+P4+P5.

---

## 10. Acceptance Criteria (selected)

- [ ] Operator pastes 100 CoreSignal IDs → batch created within 2s, fetched in <5min
- [ ] 0% data loss: every input ID → `pa-users` doc OR review queue with reason
- [ ] Existing `pa-users` with matching `canonicalLinkedInUrl` → merged (not duplicated)
- [ ] CoreSignal LinkedIn experience produces tags with `source: 'coresignal_linkedin'`
- [ ] Match score + evidence saved to `pa-candidate-company-job-evaluations`
- [ ] "Generate Pitch" returns draft in <3s with no hallucinated content
- [ ] Operator approve → Instantly lead → status=sent within 30s
- [ ] Webhook updates status to opened/replied/bounced/unsubscribed
- [ ] Bounced/unsubscribed → suppression list entry
- [ ] Candidate sign-in via magic-link email match → claim pre-created profile

---

## 11. Reference

- v1 initiative: [INITIATIVE-external-candidate-supply-intake.md](./INITIATIVE-external-candidate-supply-intake.md)
- v2.0 design lock: [../CLAUDE.md](../CLAUDE.md) — "v2.0 Product Lock — Candidate Retention Marketplace"
- Existing external-supply code: `packages/external-supply/`, `apps/functions/src/external-supply/`
- Dashboard routes: `apps/dashboard-web/src/pages/external-supply/`
- CoreSignal fetch prototype: `scripts/coresignal-fetch-employees.mjs`
- Goal doc: [V2-CORESIGNAL-INTAKE-OUTBOUND-GOAL.md](./V2-CORESIGNAL-INTAKE-OUTBOUND-GOAL.md)
