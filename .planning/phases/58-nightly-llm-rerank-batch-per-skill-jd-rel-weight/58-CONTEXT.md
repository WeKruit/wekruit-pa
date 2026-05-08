# Phase 58: Nightly LLM rerank batch + per-skill JD-rel weight - Context

**Gathered:** 2026-05-06
**Status:** Shipped 2026-05-06 (`463bcdb`). Verified: [.planning/v1.6-MILESTONE-AUDIT.md](../../v1.6-MILESTONE-AUDIT.md).
**Mode:** Decisions D7, D9 locked (locked llm-rerank.ts existing helper)

<domain>
## Phase Boundary

Cloud Scheduler `paLlmRerankNightly` at 04:00 UTC (1h after liveness sweep) runs LLM JD-CV match scorer using `Qwen/Qwen2.5-7B-Instruct` JSON-mode for top-50/active user. Output stored in `pa-user-rerank-cache/{userId}` with `ranked` + `computedAt`. Read-side falls back if cache stale >36h. Per-skill JD-relative weight stored as `pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}`. Async fire-and-forget llmRerank already wired (iter34 H.2 commit `c187c50`); daily batch reuses same function.

**REQ-IDs:** RERANK-01, RERANK-02, RERANK-03, RERANK-04 (4)

**In scope:**
- New CF `paLlmRerankNightly` — Cloud Scheduler, 04:00 UTC daily
- Iterates over active pa-users (those with `tags.targetRoleFunction.length > 0`)
- For each user: query top 50 candidate jobs via `queryMatchingJobsV16` (Phase 56) WITHOUT llm cache
- Reuse existing `llmRerank()` from `apps/functions/src/lib/llm-rerank.ts` (Qwen-7B JSON-mode wrapper)
- Write rerank output to `pa-user-rerank-cache/{userId}` with shape `{ ranked: [{jobId, llmScore, reasoning}], computedAt: ISO }`
- For each top-N job, compute JD-relative skill weights via second LLM call (Sonnet-4-6 if available, else Qwen-7B): "Which of {user.skills} are central to this JD?" → `Record<skill, 0.0..1.0>`
- Store at `pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}` with `{ jdRelativeWeights, computedAt }`
- Concurrency: 5 users in parallel (Qwen-7B free tier has rate limits)
- Memory: 1GB, timeout 540s (1 hour cap; if longer needed, split runs)
- Audit collection `pa-rerank-runs/{runId}` with summary

**Out of scope:**
- Real-time rerank (REQUIREMENTS line 120 — async daily only)
- Dashboard rerank-debug page (Phase 59)
- QA evaluator weekly (Phase 61)

</domain>

<decisions>
## Implementation Decisions

### Schedule
- 04:00 UTC daily (1h after `paLivenessSweepDaily` 03:00 UTC)
- Why 04:00: liveness sweep finishes by 03:30, fresh corpus state for rerank
- Cron expression: `0 4 * * *`

### Iteration loop
```ts
async function nightlyRerank() {
  const usersSnap = await db.collection('pa-users').get()
  const usersWithTags = usersSnap.docs.filter(d => d.data()?.tags?.targetRoleFunction?.length > 0)
  
  const limiter = pLimit(5)  // 5 users in parallel
  const tasks = usersWithTags.map(userDoc => limiter(async () => {
    const userId = userDoc.id
    const userTags = userDoc.data().tags
    
    // Query top 50 candidate jobs (without llm cache, just hard filter + skill score)
    const queryRes = await queryMatchingJobsV16(db, userId, { limit: 50, skipLlmCache: true })
    if (queryRes.jobs.length === 0) return
    
    // Run LLM rerank
    const rerankInput = composeRerankInput(userTags, queryRes.jobs)
    const rerankOut = await llmRerank(rerankInput, { /* Qwen-7B SiliconFlow config */ })
    
    // Store rerank cache
    await db.collection('pa-user-rerank-cache').doc(userId).set({
      ranked: rerankOut.ranked.map(r => ({ jobId: r.jobId, llmScore: r.score, reasoning: r.reasoning })),
      computedAt: new Date().toISOString(),
    })
    
    // For top-10 jobs, compute JD-relative skill weights
    const topJobs = rerankOut.ranked.slice(0, 10)
    const jdrelTasks = topJobs.map(job => limitJdrel(async () => {
      const weights = await computeJdRelativeWeights(userTags.skills, job)
      await db.collection('pa-user-skill-jdrel-cache').doc(userId)
        .collection('jobs').doc(job.jobId)
        .set({ jdRelativeWeights: weights, computedAt: new Date().toISOString() })
    }))
    await Promise.allSettled(jdrelTasks)
  }))
  
  await Promise.allSettled(tasks)
}
```

### LLM rerank prompt (already exists, reuse)
- `apps/functions/src/lib/llm-rerank.ts` `llmRerank()` already wired
- Phase 58 just calls it with composed input

### JD-relative weight prompt (NEW)
```
You are a recruiter expert. Given a candidate's skill list and a job description,
return a JSON object mapping each candidate skill to a relevance score 0.0-1.0
based on how central that skill is to this specific job description.

Skills: ["python", "typescript", "react", "kubernetes", "postgres"]
JD: <job text>

Return shape: { "python": 0.9, "typescript": 0.7, "react": 0.5, "kubernetes": 0.3, "postgres": 0.2 }
```

Use Sonnet-4-6 (Anthropic) as primary. If ANTHROPIC_API_KEY not set, fall back to Qwen-7B (cheaper but less accurate). Schema validates 0..1 range.

### Cache shapes

`pa-user-rerank-cache/{userId}`:
```ts
{
  ranked: Array<{ jobId: string, llmScore: number, reasoning: string }>,
  computedAt: string,  // ISO
  modelUsed: 'qwen-7b' | 'sonnet-4-6',
  candidatePoolSize: number,
}
```

`pa-user-skill-jdrel-cache/{userId}/jobs/{jobId}`:
```ts
{
  jdRelativeWeights: Record<string, number>,  // skillName lowercase → 0.0..1.0
  computedAt: string,
  modelUsed: 'qwen-7b' | 'sonnet-4-6',
}
```

### Audit
- `pa-rerank-runs/{runId}` — `{ runAt, totalUsers, processed, errors, durationMs, modelStats: {qwen: N, sonnet: N} }`

### Idempotency / cost control
- Skip user if `pa-user-rerank-cache/{userId}.computedAt` < 24h old (avoid double-running on retries)
- Cap candidate pool at 50 (rerank prompt token budget)
- Cap top-N for JD-rel computation at 10 (cost control — JD-rel is the expensive call)
- Free tier Qwen-7B; only Sonnet-4-6 costs (~$0.001/JD-rel call)
- Estimated cost: 500 users × 10 top-jobs × $0.001 = $5/run × 30 days = $150/mo (acceptable)

### Tests
- Unit tests for nightly batch loop (mock Firestore + llmRerank)
- Tests for JD-rel weight prompt + parser
- Tests for fallback Sonnet→Qwen on missing key

</decisions>

<code_context>
## Existing Code Insights

### Reusable
- `apps/functions/src/lib/llm-rerank.ts` — `llmRerank()` Qwen-7B wrapper (iter34 H.2 commit `c187c50`)
- Phase 56: `queryMatchingJobsV16` returns top-N with score breakdown (call with `skipLlmCache: true` to avoid recursion)
- Phase 53: Anthropic provider for Sonnet-4-6
- `apps/functions/src/instrumentation/cost-logger.ts` — existing cost telemetry

### Files to add
- `apps/functions/src/nightly-rerank.ts` — main CF
- `apps/functions/src/lib/jd-relative-weights.ts` — JD-rel prompt + caller
- `apps/functions/src/__tests__/nightly-rerank.test.ts`
- `apps/functions/src/lib/__tests__/jd-relative-weights.test.ts`

### Files to modify
- `apps/functions/src/index.ts` — register paLlmRerankNightly
- `apps/job-rec/src/tools/query-matching-jobs-v16.ts` — add `skipLlmCache?: boolean` option (avoid Phase 58 reading own output)

</code_context>

<specifics>
## Specific Ideas

- Cron splay: vary first run by jitter to avoid thundering-herd against SiliconFlow free tier
- Stagger: if 530 users × 5 concurrency = ~106 batches, expected runtime ~10-15 min for full active set
- If runtime exceeds 540s, split into 2 CFs (`paLlmRerankNightlyA` first half, `B` second half) by userId hash
- Failure: error in one user → log + continue; don't fail whole run

</specifics>

<deferred>
## Deferred Ideas

- Real-time rerank (out of scope per REQUIREMENTS)
- Multi-user batch (combine N users into one LLM call) — defer optimization
- Cost-tier auto-downgrade based on quota (defer to v1.7)

</deferred>
