# Candidate Questions Step — Design

**Status:** v2.2 Prescreen Runtime Platform, Slice 2. Design-only. Authored 2026-05-16.

**Scope:** Specifies the conversational slot where the candidate can ask Claire about the job/company **inside an active prescreen session**, before the session closes. Does not implement runtime, prompts, or UI. Implementation lives downstream of this doc and the JSON schema (`candidate-questions-step.schema.json`).

---

## 1. Problem & Motivation

Today's prescreen is one-way: Claire asks scoring questions, the candidate answers, the 4-gate state machine resolves to PASS / FAIL / HARD_STOP / PAUSE, and the session terminates. Real recruiter conversations are two-way — candidates push back, ask about scope, team, comp, interview process, visa, relocation. Stripping that surface makes Claire feel like a form, costs candidate trust, and forfeits signal (questions asked also predict fit and seriousness).

The **candidateQuestionsStep** is the deterministic slot where Claire invites questions. The hard constraint per CLAUDE.md product rule #5 (no fabrication) and v2.0 retention rules: **Claire may only answer from pre-approved sources**. Anything outside that set is refused with a deferral, optionally HITL-flagged. The step is not an open-ended chatbot — it is a bounded Q&A surface backed by employer-authored content.

This design closes the loop on the prescreen contract (S1) by reserving a typed surface that voice (S3) and dashboard (S4) can consume without re-litigating shape later.

---

## 2. When the Step Fires

Three candidate triggers. Recommended lock: **`post_pass_only` as the v1 default, with `candidate_initiated` as an additive flag that can fire mid-conversation.**

| Trigger | Pros | Cons |
|---|---|---|
| `post_pass_only` | Clean separation (interview first, then your turn). Aligns with Level-1 reveal — candidate already knows the role is real. Cheapest to ship. | FAIL/HARD_STOP candidates get nothing. May feel cold for borderline cases. |
| `post_last_q_any_terminal` | More equitable; everyone gets a turn. | Mixes Q&A with interview signals. Bad for HARD_STOP cases where Claire should exit fast. PAUSE state would block step indefinitely. |
| `candidate_initiated` | Most natural (`"wait, can I ask something?"`). | State machine must allow re-entry from any scoring turn. Risks derailing the 4-gate flow. |

**Recommendation:** Default `trigger: "post_pass_only"` for v1. Authors may enable `"candidate_initiated"` per-job as an additive flag (not mutually exclusive) — handled in S3 voice adapter and the eventual runtime, not in this slice. **Opt-out by default**: Claire proactively prompts `"Any questions about the role before we wrap?"` once after Level-1 reveal. Candidate may decline; that's a clean exit. Opt-in only (silent unless candidate asks) discards signal and feels off-brand for a friend-shaped assistant.

`post_last_q_any_terminal` is rejected for v1: FAIL/HARD_STOP candidates with relevance/visa hard-stops should exit with the terminal text + retention copy, not get pulled into another turn. We can revisit when retention messaging matures.

---

## 3. Answer Sources (Closed Set)

Claire's answer universe is a closed set. This is the load-bearing rule of the step. Sources:

1. **`prescreenConfig.jobTitle`, `prescreenConfig.company`** — already public at session start.
2. **`prescreenConfig.level1Reveal.applyUrl` / `salaryRange` / `nextStepEta`** — already disclosed at PASS terminal. Re-quotable verbatim.
3. **`pa-jobs/{jobId}.companyCultureDoc`** (NEW, optional) — bounded employer-authored blurb (≤2000 chars) covering culture, team, working model. One field, one paragraph, no nested structure. Read-only at runtime; authored in admin.
4. **`pa-jobs/{jobId}.faqs`** (NEW, optional) — array of pre-approved `{ question, answer: {zh, en}, tags }` pairs. Employer writes these up-front in `/admin/onboarding-questions` (extension, see §10). Hard cap 20 entries per job.

Explicitly **NOT** answerable from:
- LLM general knowledge or web search (no fabrication, no hallucinated team sizes/headcounts).
- Employer-private fields on `pa-jobs` (internal scoring rubric, hiring manager email, candidate pool composition).
- Cross-candidate data ("how many people applied" / "what's everyone else getting paid").
- Anything legal / immigration / medical / accommodation policy — these route to refusal §4 + HITL §5.

The matching of candidate question → FAQ entry is LLM-mediated (semantic similarity over `faqs[].question` + `tags`), but the **answer text is verbatim from `faqs[].answer`**. The LLM picks the entry, it does not synthesize the answer.

---

## 4. Refusal Categories

Verbatim refusal templates. Claire memorizes these via system prompt; LLM does not compose. Copy length capped at 200 chars each side.

| Category | Example trigger | Refusal (zh) | Refusal (en) | Follow-up |
|---|---|---|---|---|
| `comp_specifics_beyond_range` | "What's the actual offer band?" | "我只能分享公开的薪资范围，具体 offer 由招聘团队和你直接谈。" | "I can only share the posted range. The full offer band is between you and the hiring team." | Defer to hiring team; flag if asked ≥2x. |
| `legal_immigration_advice` | "Can you help me file H1B?" | "我没法给签证或法律建议，建议咨询专业律师。" | "I'm not able to give immigration or legal advice. Please consult a qualified advisor." | Hard refuse; HITL flag on first hit (sensitive). |
| `safety_sensitive` | "Will this require a background check?" | "这个细节我这边没有，招聘团队会在后续告诉你。" | "I don't have that detail; the hiring team will share it in the next step." | Defer; HITL flag. |
| `interview_process_unknown` | "Who will I interview with?" | "面试安排会在这一步之后由团队同步给你。" | "The hiring team will share the interview lineup after this step." | Defer to scheduling email. |
| `salary_negotiation` | "Can I negotiate?" | "薪资具体谈判在招聘团队那边，他们会接着跟你聊。" | "Salary negotiation happens with the hiring team — they'll follow up with you." | Defer; no counter. |
| `competing_offers` | "I have another offer at $X" | "了解，我会把这个情况同步给团队。" | "Noted — I'll flag this to the team." | Log in transcript; surface in observability dashboard. No counter, no commitment. |
| `out_of_scope_general` | "What's the weather in SF?" / chitchat | "我们只聊这个机会哈。" | "Let's keep this about the role." | Soft redirect; no flag. |
| `unclassifiable_low_confidence` | LLM classifier returns confidence < threshold | "这个问题我没完全 get 到，能换个说法吗？" | "I didn't quite get that — could you rephrase?" | One clarify; if still low, HITL flag + soft handoff. |

Refusal copy is **templated** in v1 (Open Question for P10 — see §10). Choosing templates over LLM composition makes refusals auditable, predictable, and trivially diffable in QA.

---

## 5. HITL Handoff Threshold

Claire flags the session for human review (not blocking — async) when:

- **Consecutive refusals ≥ 3**: candidate keeps probing things Claire can't answer. Indicates Claire is the wrong surface; route to a teammate.
- **Sensitive category hit** (`legal_immigration_advice`, `safety_sensitive`, plus any future `accommodation_request`): immediate flag on first occurrence + soft handoff copy ("我会请一位同事跟进你的问题 / a teammate will follow up").
- **Frustration markers**: caps-lock runs ≥6 chars, profanity per a small static list, or literal `"are you a bot"` / `"是机器人吗"`. Flag + offer human contact (no auto-pause; let candidate finish).
- **Unclassifiable**: LLM classifier confidence < `minLlmClassifyConfidence` (default `0.55`) twice in a row.

**Write path** (specified, not implemented): `pa-prescreen-hitl-flags/{sessionId}` document with shape:

```ts
{
  sessionId: string
  userId: string
  jobId: string
  flagKind: "consecutive_refusals" | "sensitive_topic" | "frustration" | "unclassifiable"
  candidateQuestion: string        // verbatim
  classifiedCategory: string | null
  occurredAt: ISO8601
  status: "open" | "acknowledged" | "resolved"
  resolvedBy?: string              // operator email
  resolvedAt?: ISO8601
}
```

Dashboard reads from this collection (S4 observability). No write-back from operator → runtime in v1.

---

## 6. Transcript Persistence

**Recommendation: augment `pa-prescreen-sessions/{sessionId}/turns` with a new turn kind**, not a separate subcollection.

Reasoning: the prescreen transcript is already the canonical session log read by terminal-action, observability, and memory compaction. Splitting candidate questions into a sibling subcollection forces every reader to perform two queries and merge — pure overhead. One collection, one ordering, kind discrimination:

```ts
// Existing kinds: "candidate_reply" | "claire_prompt" | ...
// New:
{
  kind: "candidate_question"
  ts: ISO8601
  candidateQuestion: string
  classifiedCategory: string | null      // "comp_specifics_beyond_range" | "faq:<id>" | null
  answerSource: "faq" | "level1_reveal" | "company_culture" | "refusal" | null
  answer: string                          // verbatim, may be refusal copy
  refused: boolean
  hitlFlagged: boolean
  llmClassifyConfidence: number | null   // 0..1
}
```

This shape is also what the S1 contract field `candidateQuestions` (the recent-Q&A short-term memory window) reads from — last N entries projected for runtime context.

---

## 7. State Machine Integration

```
[ScoringTurn] ──(last Q answered)──> [Final eval]
                                      │
                ┌─────────────────────┴────────────────────┐
                │ PASS                          FAIL / HS  │
                ▼                                          ▼
        [Level1 Reveal SMS]                       [Terminal text]
                │                                          │
                ▼                                          ▼
   [CandidateQuestionsStep] (if cfg.enabled            [closed]
        & trigger="post_pass_only")                       
                │
        ┌───────┼───────┬─────────┐
        │       │       │         │
        ▼       ▼       ▼         ▼
   [refused] [answered] [HITL]   [candidate declines / max reached]
        │       │       │         │
        └───────┴───┬───┴─────────┘
                    ▼
              [transcript log]
                    │
                    ▼
                [closed]
```

The step never re-opens the 4-gate machine. Once entered, the only exits are: candidate declines, `maxQuestionsPerSession` reached, HITL handoff (session continues to log but Claire stops accepting new questions), or natural completion. PAUSE candidates never enter the step (PAUSE is already a "human will follow up" state).

---

## 8. Contract Integration with S1

S1 (`packages/prescreen-contract/`) reserves the field name `candidateQuestionsStep` in the prescreen contract surface as a stub. S2's JSON schema is what that stub expands to. The eventual contract shape:

```ts
// packages/prescreen-contract/src/candidate-questions-step.ts (S5 implementation slice, not S2)
interface CandidateQuestionsStepConfig {
  enabled: boolean
  trigger: "post_pass_only" | "post_last_q_any_terminal" | "candidate_initiated"
  approvedFaqs: ReadonlyArray<ApprovedFaq>
  refusalCategories: ReadonlyArray<RefusalCategoryConfig>
  hitlFlagThresholds: {
    consecutiveRefusals: number               // default 3
    sensitiveCategories: ReadonlyArray<string> // default ["legal_immigration_advice","safety_sensitive"]
    minLlmClassifyConfidence: number          // default 0.55
  }
  maxQuestionsPerSession: number              // default 5, range 0..10
  companyCultureDoc?: string                  // ≤2000 chars
}

interface ApprovedFaq {
  id: string
  question: string
  answer: { zh: string; en: string }
  tags?: ReadonlyArray<string>
}

interface RefusalCategoryConfig {
  category: string
  refusal: { zh: string; en: string }
  followUp: "defer_hiring_team" | "defer_scheduling" | "hard_refuse" | "soft_redirect" | "log_only"
  hitlOnHit: boolean
}
```

The JSON schema (deliverable 2) is the runtime-validatable form. The TypeScript surface is what S1 / S5 generate from it (or hand-port; ts-from-json-schema is acceptable but not mandated).

---

## 9. Out of Scope

- **LLM prompt engineering** for classify / FAQ-match / refusal-rendering — implementation slice, not S2.
- **HITL review queue UI** — deferred to a v2.x HITL milestone. v1 surfaces flags via the S4 observability dashboard read view only.
- **Voice-channel adaptation** — S3 voice adapter handles channel abstraction. This step is content-agnostic; voice and SMS produce the same transcript shape.
- **Candidate-portal "ask anytime" inbox** — out of scope. This step is in-session only. The retained candidate `/me` surface is a separate v2 product slice.
- **Cross-session FAQ learning** — proposed FAQs derived from candidate questions are dashboard-visible (S4) but not auto-promoted. Manual employer review only.
- **Multi-locale beyond zh/en** — schema fixes the two locales for now. Adding more is a vocab extension, not a runtime change.

---

## 10. Open Questions for P10

1. **Refusal copy: templated vs LLM-composed.** Templates (chosen for v1) trade naturalness for auditability. Worth A/B testing once eval harness exists?
2. **HITL flagged sessions: auto-PAUSE or finish silently?** Current design = finish silently, log flag. Alternative = pause and let an operator resume. Pause adds latency cost; silent finish risks candidate never hearing back.
3. **FAQ authoring surface.** Extend `/admin/onboarding-questions` (the natural home — same admin already authors prescreen Qs) or build a new `/admin/job-faqs` page? Recommend extending the existing route to avoid surface sprawl, but P10 owns the call.
4. **`companyCultureDoc` source of truth.** Field on `pa-jobs.prescreenConfig` (this design) vs hoisting to `pa-jobs.companyCulture` top-level for reuse beyond prescreen (e.g., on the public `/j/:jobId` page)? Top-level is cleaner for reuse but couples two consumers to one field.
5. **Should `competing_offers` be HITL-flagged by default?** Current design = log only. Could be high-value signal worth surfacing to recruiters immediately. Defaults are debatable here.
