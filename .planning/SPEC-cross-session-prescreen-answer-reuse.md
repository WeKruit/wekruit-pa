# SPEC — Cross-Session Prescreen Answer Reuse (shared question key + global answer memory)

Status: **proposed**, Adam-approved direction (2026-06-14). Stage 1 (review-side history) shipped (PR #482). Stage 2 (this spec) is the runtime carry-over — coordinate the **prescreen FSM** and the **Claire agent** against the SAME contract below.

---

## 1. Goal

A candidate can have multiple prescreen sessions (one per job). Generic questions repeat across jobs (e.g. *"how do you use AI to accelerate your productivity"*). We must:

- **Not re-ask** a generic question the candidate already answered in a prior session.
- **Carry the prior answer forward** so it still counts toward the new job's rubric (decision: *skip + carry*, not *skip + ignore*).
- Make the prior answer **visible at review** (Stage 1, done — "Other prescreen sessions" panel).
- Whoever runs the screen — the deterministic FSM **or** the agentic Claire — reads the SAME global answer memory, so **Claire "already knows it"**.

## 2. Non-goals

- Re-asking job-specific questions. Only questions explicitly tagged shared are reused.
- Semantic/LLM matching of questions (rejected — too risky; we use an explicit `sharedKey`).
- Changing scoring math. We reuse the candidate's *reply*; the new job re-judges it against its own rubric (§6).

## 3. Locked decisions (Adam 2026-06-14)

| # | Decision |
|---|---|
| D1 | Match "already answered" by an explicit, authored **`sharedKey`** on the question config — NOT by qId or semantics. |
| D2 | When already answered: **skip + carry the prior answer** (counts toward this job's rubric). |
| D3 | Prior answers are **durable, global candidate data** (per the v2.0 "all durable candidate data is global" rule) — stored on `pa-users/{uid}`, not on a single session. |
| D4 | The global answer memory is the **single source of truth** shared by the prescreen FSM and the Claire agent. |

## 4. Current state (grounded in code)

- Sessions: `pa-prescreen-sessions/{sessionId}` — `PreScreenState` in `packages/pa-orchestrator/src/prescreen/state.ts:64`. Per-question state in `PreScreenQuestionState` (`state.ts:31`): `qId, type, weight, matchThreshold?, clarifyRounds, scored?, evidenceReplies?, finalS?, finalC?, answeredAt?, terminalCause?`.
- Turns: `pa-prescreen-sessions/{sessionId}/turns/{turnId}` — `PrescreenTurnRecord` in `prescreen/turn-recorder.ts:20` — `{ qId, reply, scored?, action, ts }`; `scored.aggregate.summary` is the per-turn summary.
- Questions are **job-specific**, loaded from `pa-jobs/{jobId}.prescreenConfig`; qIds are stable + unique **within a job** (`prescreen/config.ts:53`, uniqueness check `config.ts:147`). **No shared identity across jobs today.**
- Question selection is in-order over `qOrder`; the "next unanswered question" seam is `findNextQuestion()` in `prescreen/pipeline.ts:667` (`if (!state.questions[qId]?.answeredAt) return qId`).
- Session build: `apps/functions/src/prescreen-session-start.ts:857` → `configToStateQuestions(cfg)`.
- Global durable candidate doc: `pa-users/{userId}` — already the home for tags etc. Sole-writer pattern = `mergeUserTags()` lib (commit `253ce87`). Mirror that for answers.
- **No cross-session awareness exists today** (confirmed).
- Two prescreen runtimes exist: the **deterministic FSM** (KeywordSetJudge + gates — currently LIVE for prescreen) and the **agentic Claire** (`paThinPrescreenEnabled`, FSM-tools — dormant for prescreen). Both must honor this contract.

## 5. Data model (the shared contract)

### 5a. Shared question key — `packages/pa-orchestrator/src/prescreen/config.ts`

Add an optional field to `PrescreenQuestionConfigSchema`:

```ts
/** Stable cross-job identity for a GENERIC question. When two jobs' configs use
 *  the same sharedKey, an answer to one is reused for the other (skip + carry).
 *  Omit for job-specific questions — they are NEVER deduped across jobs. */
sharedKey: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/).optional()
```

- Authoring: tag generic questions, e.g. `sharedKey: "ai_usage"`, `sharedKey: "work_authorization"`. **Which questions are shared is an explicit authoring decision** (Adam to provide the list; start with the AI-usage question).
- A `sharedKey` is global vocabulary — keep a registry (suggest `packages/pa-orchestrator/src/prescreen/shared-keys.ts` enum) so FSM authors and Claire agree on the same keys.

### 5b. Global shared-answer store — `pa-users/{userId}.prescreenSharedAnswers`

```ts
type PrescreenSharedAnswer = {
  sharedKey: string          // "ai_usage"
  reply: string              // the candidate's raw answer text (latest/best)
  summary?: string           // per-turn aggregate summary at answer time
  finalS?: number            // 0..1 raw match score from the SOURCE job's judge
  finalC?: number            // 0..1 confidence
  evidenceReplies?: string[] // accumulated replies (bounded, like state)
  sourceSessionId: string
  sourceJobId: string
  answeredAt: string         // ISO
  updatedAt: string          // ISO
}

// On the user doc:
pa-users/{userId}.prescreenSharedAnswers: Record<string /*sharedKey*/, PrescreenSharedAnswer>
```

Writer: a new sole-writer lib `mergeUserPrescreenSharedAnswers(db, userId, answer)` (mirror `mergeUserTags`): last-write-wins per `sharedKey`, `update()`-style merge (avoid Firestore deep-merge surprises — see the reinit-cold gotcha).

## 6. Write path — when an answer enters the global store

When a question **with a `sharedKey`** becomes terminal-for-that-question (its `answeredAt` is set + `finalS/finalC` computed), write it to the global store.

- Seam: the prescreen FSM where `answeredAt` + `finalS/finalC` are committed (in `pipeline.ts`, the per-question finalize path; also the turn-recorder has the raw `reply`). Emit `mergeUserPrescreenSharedAnswers(...)` there.
- The Claire agent path must do the equivalent when it finalizes a shared question.
- Idempotent + last-write-wins: re-answering updates the store.

## 7. Read / carry-over path — "don't re-ask, re-judge the stored reply"

At **session start** (`prescreen-session-start.ts`), after `configToStateQuestions(cfg)`:

1. Read `pa-users/{userId}.prescreenSharedAnswers`.
2. For each new-session question that has a `sharedKey` present in the store:
   - **RECOMMENDED (re-judge):** seed the question's `evidenceReplies` with the stored `reply`, run THIS job's judge on it **silently** (no candidate message), set `finalS/finalC/scored/answeredAt` from that re-judge, and mark `carriedFrom: { sourceSessionId, sourceJobId, answeredAt }`. → The answer is reused, scored correctly against *this* job's keyword set + thresholds, and the candidate is never asked.
   - *Simpler fallback (carry-as-is):* copy the stored `finalS/finalC` directly. Less accurate when the two jobs' versions of the question differ; only use if re-judging is infeasible.
3. The FSM's `findNextQuestion()` already skips questions with `answeredAt` set — so a carried question is auto-skipped. No change needed there beyond seeding `answeredAt`.
4. Add `carriedFrom?: { sourceSessionId, sourceJobId, answeredAt }` to `PreScreenQuestionState` (`state.ts`).

## 8. Claire agent integration (what the Claire dev sessions own)

This is the half the Claire agent team must build against the SAME contract:

1. **Before asking a shared question**, Claire reads `pa-users/{uid}.prescreenSharedAnswers[sharedKey]`. If present, Claire does **not** ask it — she treats it as already known (optionally references it naturally: *"last time you mentioned you use Claude + Cursor daily…"*).
2. **After answering a shared question**, Claire writes via the same `mergeUserPrescreenSharedAnswers(...)` lib. One writer, two callers (FSM + Claire).
3. Claire and the FSM must agree on the **sharedKey registry** (§5a). Adding a key is a coordinated change.
4. Claire's conversational memory (mem0) is NOT the source of truth for this — the structured `prescreenSharedAnswers` store is (deterministic, reviewable, auditable). mem0 may also reflect it for natural recall, but carry-over scoring reads the structured store.

## 9. Review surface (Stage 1 — DONE)

- `apps/dashboard-web/src/components/prescreen/PrescreenReviewDrawers.tsx` → "Other prescreen sessions" panel (PR #482). Shows prior sessions' Q&A + summaries.
- **Stage 2 add:** in the current session's transcript/question view, label a carried question "answered in a prior session (<job>)" using `question.carriedFrom`. The source answer is already visible via the cross-session panel.

## 10. Tests (Layer 1 + 2 per the v2.0 eval plan)

- config: `sharedKey` accepted/validated; duplicate qId still rejected.
- store writer: last-write-wins per key; no deep-merge clobber.
- carry-over at session start: question with a stored sharedKey is pre-answered (answeredAt set, score carried/re-judged, `carriedFrom` marker); question with NO sharedKey or NO stored answer is asked normally.
- FSM: carried question is skipped by `findNextQuestion`; rubric total still includes it (counts toward score).
- Claire path: reads store before asking, writes after answering (Claire team).
- No behavior change when zero questions are tagged (dormant-safe).

## 11. Rollout / safety

- New global field on `pa-users` + new orchestrator behavior → **PR + review, no direct deploy** (greenfield rule).
- Ship the **mechanism dormant** (no questions tagged) → zero behavior change until a `sharedKey` is authored.
- Then tag the first shared question (AI usage), canary on a dev phone, verify carry-over end-to-end (answer in job A → start job B → question skipped + scored), THEN ramp.
- Guardrail: carry-over must never *fail a candidate* for a question they actually answered well elsewhere; re-judge (option a) protects against that.

## 12. File-level seams (implementation map)

| Concern | File:seam |
|---|---|
| `sharedKey` on config | `packages/pa-orchestrator/src/prescreen/config.ts:53` (PrescreenQuestionConfigSchema) |
| sharedKey registry | `packages/pa-orchestrator/src/prescreen/shared-keys.ts` (new) |
| `carriedFrom` on question state | `packages/pa-orchestrator/src/prescreen/state.ts:31` |
| write to global store | FSM finalize seam in `prescreen/pipeline.ts` (+ Claire agent finalize) → `mergeUserPrescreenSharedAnswers` (new lib) |
| carry-over at session start | `apps/functions/src/prescreen-session-start.ts:857` (after configToStateQuestions) |
| skip already-answered | `prescreen/pipeline.ts:667` (`findNextQuestion` — no change, just seed answeredAt) |
| review label | `apps/dashboard-web/.../PrescreenReviewDrawers.tsx` (use `question.carriedFrom`) |
| Claire read/write | Claire agent prescreen path (`apps/functions/src/claire-agent/*`) — Claire team |

## 13. Open questions for the Claire dev sessions

1. Which questions are "shared" (the authored `sharedKey` list)? Start: `ai_usage`. Adam to extend.
2. Re-judge (§7 option a) vs carry-as-is (option b) — confirm we re-judge the stored reply against each job's rubric.
3. Does Claire reference the prior answer conversationally, or silently skip? (Recommend: brief natural reference, then move on.)
4. Freshness: do shared answers ever go stale (re-ask after N months)? Default: no expiry; revisit.
5. mem0 vs structured store boundary (§8.4) — confirm structured store is authoritative for carry-over scoring.
