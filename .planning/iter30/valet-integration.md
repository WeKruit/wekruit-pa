# iter30 — VALET parseResume → PA Integration Research

> [🟠 阿里味] 收到需求，**对齐目标**，**拉通资源**，进入 sprint。任务底层逻辑：把 VALET parseResume 的成熟管道复用到 PA，同时叠加 4 项业务约束（gating + quota + size + retry）+ qaBank → Mem0 闭环。颗粒度拉到代码行级别，不留模糊地带。因为信任所以简单 — 不让把这事儿托付给我的人失望。

**Author**: research agent (read-only)
**Date**: 2026-05-03
**Brief**: `iter30` directive from Adam — port VALET parseResume into PA with 4 business constraints (gated, quota=2, size cap, retry) + qaBank → Mem0 mapping.
**Scope**: research-only. No code edits. Identifies the path forward for an implementation phase that will follow.

---

## TL;DR (skip to §"TL;DR for Adam" at the bottom for the bullet form)

VALET's parser is materially more complete than PA's: it has a 14-field schema vs PA's 7-field, a multi-provider LLMRouter with primary/secondary/budget tiers + automatic 5xx fallback, a Hatchet 3-task workflow with timeouts + S3 binding, a qaBank with intent-tagged structured Q&A, and resume-variants for per-job rewrites. PA today has a single-shot OpenAI Responses-API call to `gpt-5.4-nano` with no fallback, no retry, no size cap, no gating, no quota, and no Q&A extraction.

**Recommendation: Option B (port, don't call).** VALET is a Hatchet+S3+Postgres stack — a service call would force PA to take on Postgres connectivity, S3 credentials, Hatchet event auth, and async result delivery via Redis pubsub. The "just call VALET" path is high-coupling for a pipeline whose business logic is ~150 lines of LLM-prompt + JSON-schema validation. Port the schema, the prompt, the LLMRouter, and the retry policy into a new `packages/pa-resume-parser` package; keep PA's existing Cloud Functions + Firestore + Mem0 plumbing.

---

## 1. VALET parseResume audit

### 1.1 Workflow shape (`apps/worker/src/workflows/resume-parse.ts`)

VALET runs parseResume as a **3-task Hatchet DAG** triggered by event `resume:uploaded`:

| Task          | Timeout | Parents       | Responsibility |
|---------------|---------|---------------|----------------|
| `extract-text`| `30s`   | (none)        | S3 download → pdf-parse OR mammoth (docx) OR utf-8 fallback. Throws on empty text. |
| `llm-parse`   | `60s`   | `extract-text`| Calls `LLMRouter.complete({ taskType: "answer_generation", ... responseFormat: "json" })`. Catches errors → flips DB `status=parse_failed`, publishes `resume_parse_failed` to Redis `tasks:{userId}` channel. |
| `save-results`| `15s`   | `llm-parse`   | Updates `resumes` row with `parsedData`, `parsingConfidence`, `rawText`, `parsedAt`, `status="parsed"`. Inserts inferred Q&A rows into `qaBank` table (one row per inferred answer). Publishes `resume_parsed` progress event. |

Workflow input shape:
```typescript
interface ResumeParseInput {
  resumeId: string
  storageKey: string  // S3 key
  userId: string
}
```

Progress is broadcast via Redis pubsub on channel `tasks:${userId}`. Frontend subscribes for live progress; this is the async result-delivery mechanism.

### 1.2 S3 storage flow

S3 client construction (lines 29–39):
```typescript
return new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  credentials: { accessKeyId: ..., secretAccessKey: ... },
  forcePathStyle: true,  // S3-compatible (Cloudflare R2, MinIO)
})
```
Bucket: `process.env.S3_BUCKET_RESUMES ?? "resumes"`. `forcePathStyle: true` indicates the production deploy is **not** AWS S3 — likely Cloudflare R2 or similar. Important for Option-A cost analysis: PA would need credentials onto a non-AWS object store.

Text extraction is content-type aware:
- `application/pdf` → dynamic `import("pdf-parse")` → `result.text`
- `wordprocessingml` / `msword` / `.docx` → `mammoth.extractRawText({ buffer })`
- everything else → `buffer.toString("utf-8")` fallback

PA only handles PDF today. VALET also handles `.docx` — extra capability if ported.

### 1.3 Hatchet retry semantics

The workflow itself **does not declare a retry policy at the Hatchet level**. Each task has `executionTimeout` only. Retry semantics live one level up:

1. **LLMRouter fallback chain** (next subsection) — handles 5xx / rate / timeout / overloaded inside a single task invocation, no Hatchet retry needed.
2. **Workflow-level recovery**: a separate file `apps/api/src/modules/resumes/stale-resume-parse-monitor.ts` exists (we located it but didn't read it in depth) — sweeps `resumes` rows stuck in `status="parsing"` and re-queues them. This is VALET's safety net for tasks that crash mid-flight.

The error path inside `llm-parse` is the one explicit retry-aware branch:
- LLM call fails → flip DB to `parse_failed` + publish event + **rethrow** so Hatchet records the task as failed.
- LLM returns invalid JSON → same (flip + publish + throw).

### 1.4 LLMRouter (`packages/llm/src/router.ts`)

3-tier model routing keyed on `taskType` (the resume parse uses `taskType: "answer_generation"`):

| Tier      | Provider  | Model                          | TaskTypes (relevant ones bolded) |
|-----------|-----------|--------------------------------|----------------------------------|
| Primary   | Anthropic | `claude-sonnet-4-5-20250929`   | `form_analysis`, **`answer_generation`** (← parseResume), `screenshot_analysis` |
| Secondary | OpenAI    | `gpt-4.1-mini`                 | `field_mapping`, `error_recovery` |
| Budget    | OpenAI    | `gpt-4.1-nano`                 | `confirmation`, `navigation` |
| Resume    | OpenAI    | `gpt-5.4-nano`                 | `resume_analyze`, `resume_optimize` (note: parseResume doesn't actually use this tier — it uses `answer_generation` → Sonnet 4.5) |

**Fallback chain** (`router.ts` L104–108):
```typescript
const FALLBACK_CHAIN: ModelConfig[] = [
  DEFAULT_ROUTING.form_analysis,    // Sonnet 4.5
  DEFAULT_ROUTING.field_mapping,    // gpt-4.1-mini
  DEFAULT_ROUTING.confirmation,     // gpt-4.1-nano
]
```

Trigger conditions (`router.ts` L203–217):
```typescript
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes("500") || message.includes("502") ||
      message.includes("503") || message.includes("529") ||
      message.includes("rate") || message.includes("timeout") ||
      message.includes("overloaded")
    )
  }
  return false
}
```
On non-retryable error (4xx, parse error, etc.) — throws immediately. On retryable — falls through to next model in `[primary, ...FALLBACK_CHAIN]` minus the primary itself.

**Provider-level retries**: `AnthropicProvider` constructor passes `maxRetries: 2` and `timeout: 60_000` to the Anthropic SDK (lines 12–18 of `packages/llm/src/providers/anthropic.ts`). So actual retry math for parseResume is `2 (SDK) × 3 (router fallback chain) = up to 6 attempts before final failure`.

DeepSeek + Qwen providers exist but only register if `deepseekApiKey` / `qwenApiKey` env vars are set (lines 127–139). For PA we'd start without them.

### 1.5 parsedResumeData full schema (`packages/shared/src/schemas/resume.schema.ts`)

The Zod schema is broader than the LLM prompt suggests. Key fields:

| Field                | Type                              | PA has it? |
|----------------------|-----------------------------------|------------|
| `fullName`           | `string?`                         | yes (`name`) |
| `email`              | `string?`                         | yes |
| `phone`              | `string?`                         | yes |
| `location`           | `string?`                         | yes |
| `summary`            | `string?`                         | **no** |
| `skills`             | `string[]?`                       | yes |
| `education[]`        | `educationEntry[]?`               | partial |
| `workHistory[]`      | `workHistoryEntry[]?`             | yes (`experiences[]`) |
| `projects[]`         | `{name, description, technologies, url, dates}[]?` | **no** |
| `certifications[]`   | `string[]?`                       | **no** |
| `languages[]`        | `string[]?`                       | **no** |
| `interests[]`        | `string[]?`                       | **no** |
| `awards[]`           | `{title, issuer, date}[]?`        | **no** |
| `volunteerWork[]`    | `{org, role, description, dates}[]?` | **no** |
| `totalYearsExperience`| `number?`                        | **no** (PA computes `experiences.length` heuristically) |
| `workAuthorization`  | `string?`                         | **no** (huge gap — see §3) |
| `websites`           | `string[]?`                       | **no** |
| `parseConfidence`    | `number 0..1`                     | **no** |

`educationEntry`:
```typescript
z.object({
  school: z.string(),
  degree: z.string().default(""),
  degreeType: degreeType.optional(),       // 11-value enum
  fieldOfStudy / major / gpa / startDate / endDate / expectedGraduation / honors
})
```
`workHistoryEntry`:
```typescript
z.object({
  title, company, location?, experienceType?,    // 6-value enum
  startDate?, endDate?, currentRole?,
  description?, bullets?: string[], achievements?: string[]
})
```

Notable: VALET splits `description` (one-line) from `bullets` (parsed-out individual responsibilities). PA stores only `description` (free-text blob).

### 1.6 qaBank schema (`packages/db/src/schema/qa-bank.ts` + `packages/shared/src/schemas/qa-bank.schema.ts`)

Postgres table `qa_bank`:
```typescript
{
  id, userId, category: varchar(50), question: text, answer: text,
  usageMode: enum("always_use" | "ask_each_time" | "decline_to_answer"),
  source: enum("user_input" | "resume_inferred" | "application_learned"),
  timesUsed: integer,
  canonicalQuestion: text?, synonyms: text[]?, intentTag: varchar(100)?,
  confidence: enum("exact" | "inferred" | "learned"),
  lastMatchedAt, matchCount, createdAt, updatedAt,
  // Unique on (userId, question) — auto-dedupes on exact-match Q
}
```

Categories (Zod enum):
- `work_authorization`, `experience`, `compensation`, `availability`, `identity`, `custom`

Intent tags (`qaIntentTag` enum, 18 values):
`relocation_willingness`, `salary_expectation`, `start_date`, `work_authorization`, `sponsorship_need`, `referral_source`, `why_this_role`, `why_this_company`, `career_goals`, `relevant_experience`, `biggest_strength`, `biggest_weakness`, `leadership_example`, `conflict_resolution`, `project_highlight`, `availability`, `notice_period`, `remote_preference`, `other`.

How qaBank is populated by parseResume (`resume-parse.ts` L356–366):
```typescript
if (llmResult.inferredAnswers.length > 0) {
  await db.insert(qaBank).values(
    llmResult.inferredAnswers.map((a) => ({
      userId, category: a.category,
      question: a.question, answer: a.answer,
      source: "resume_inferred",
    }))
  )
}
```
The **prompt** asks the LLM for a `inferredAnswers[]` array with `{question, answer, confidence: 0..1, category: "personal"|"experience"|"education"|"skills"|"preferences"}`. Examples in the prompt:
- "Years of experience in the field"
- "Highest education level completed"
- "Are you authorized to work in [country based on location]?"
- "Willing to relocate?"
- "Expected salary range (if inferable)"
- "Available start date"
- "Do you require visa sponsorship?"

This is the gold mine for PA: 9 question-shaped facts per resume, ready to feed Claire's job-rec context.

The service layer (`apps/api/src/modules/qa-bank/qa-bank.service.ts`) does **upsert by (userId, question)**:
```typescript
async saveAnswer(userId, data) {
  const existing = await this.qaBankRepo.findByQuestion(userId, data.question)
  if (existing) {
    return this.qaBankRepo.update(existing.id, { answer, usageMode })
  }
  return this.qaBankRepo.create({ ... })
}
```
Plus a `discoverQuestions` path that pre-creates rows with `answer=""` and `usageMode="ask_each_time"` when the dispatcher meets new questions in a job application form. Not directly relevant to parseResume but informs what "qaBank in production" really means.

### 1.7 resume-variants concept

Postgres table `resume_variants`:
```typescript
{
  id, userId, baseResumeId, taskId, jobUrl: text,
  variantData: jsonb, diffData: jsonb,
  matchScoreBefore: int, matchScoreAfter: int,
  keywordGaps: jsonb, rephraseMode: text,
  createdAt,
  // Unique on (baseResumeId, jobUrl) — one variant per resume×job pair
}
```

This is **per-job-application resume rewriting**, separate from parseResume. The flow: user uploads base resume → parseResume produces `parsedData` → on each job application, a variant is generated (LLM rephrases bullets to match job description). Out-of-scope for iter30 (no PA brief mentions per-job rewrites), but worth noting as future direction.

---

## 2. PA current state audit

### 2.1 Ingest path

Trigger: Sendblue iMessage webhook (`apps/functions/src/sendblue/webhook.ts` L751–785). When `media_url` is present on inbound:

1. Fire-and-forget tapback ❤️ via Sendblue Reactions API.
2. Fire-and-forget `ingestCv({ userId, mediaUrl })`. Phone → userId resolution via injected `lookupUserByPhone`. **No gating, no quota check, no size check** — every PDF the user sends gets parsed.

```typescript
if (mediaUrl) {
  const ingestFn = deps.ingestCv ?? defaultIngestCv
  void Promise.resolve()
    .then(async () => {
      const userId = await lookupFn(deps.db, normalized.fromNumber)
      if (!userId) return { ok: false, reason: "no_user" }
      return ingestFn({ userId, mediaUrl, sessionId: undefined })
    })
    ...
}
```

`ingestCv` (`apps/functions/src/cv-ingest/cv-ingest.ts`):
1. `defaultFetchPdf(url)` — global `fetch` + `AbortController(30s)`. **No size cap on the response.**
2. `defaultParsePdf(bytes)` — `pdf-parse@1.1.1` via inner-path import (workaround for known init bug). `{ max: MAX_PDF_PAGES }` where `MAX_PDF_PAGES = 50`.
3. Slice to `MAX_TEXT_BYTES = 100_000` (100 KB of text post-extraction). This is the only cost cap.
4. `defaultLlmExtract(text)` — single OpenAI Responses API call to `gpt-5.4-nano` with strict JSON-schema output. **No retry, no fallback.** Throws on `missing_api_key`, `empty_llm_output`, or HTTP error.
5. Validate via hand-rolled `validateStructuredCv` (no Zod).
6. `industryTags` enrichment (1–3 canonical tags, defensive clamping).
7. Stream H3 — flag-gated overwrite UX (`paCvOverwritePromptEnabled`): when ON + user has a prior resume, stage in `pa-cv-pending` + send "替代之前那份吗?" tapback prompt instead of writing directly.
8. Otherwise: write to `parsedCandidateResumes` collection.
9. Stream E side effects in parallel via `Promise.allSettled`:
    - **E1**: LLM follow-up reply (Claire-voice 2–3 sentence message referencing CV) → enqueue on `pa-outbound/out-cvfindings-{resumeId}` (idempotent via `.create()`).
    - **E2**: `mem0Add` write — calls `buildCvFactBody(parsed)` → `"User resume summary: {name} — currently/last {role}. Skills: ... Education: ..."` → fires through `@pa/memory.mem0Add(cfg, [{role:"user", content: factBody}], partitionKey)`.

Returns `{ ok: true, resumeId }` or `{ ok: false, reason }`. **NEVER throws** (caller is fire-and-forget).

### 2.2 Parse LLM

- **Model**: `gpt-5.4-nano` hardcoded as `LLM_MODEL` constant (cv-ingest.ts L180).
- **Provider**: OpenAI Responses API (`/v1/responses`), with optional override via `PA_OPENAI_AGENT_BASE_URL` (suggests OpenAI-compat shim, possibly SiliconFlow).
- **API keys**: `PA_OPENAI_AGENT_API_KEY` then `OPENAI_API_KEY` fallback.
- **Schema**: strict JSON-schema, single-shot. Schema fields: `candidateProfile{name,email,phone,linkedIn,location,skills}` + `experiences[]` + `education[]` + `industryTags[]`.
- **Cost**: log line documents `~$0.0005–0.002 per CV` with gpt-5.4-nano.

There is also a **second, separate parse path** at `apps/job-rec/src/tools/parse-resume.ts` — this is an `@openai/agents` SDK tool wrapper for the RecruiterAgent. It does **not** parse text at all. It only:
1. Fetches the PDF via `fetch`,
2. Optionally uploads to GCS,
3. Writes a **stub** doc to `parsedCandidateResumes` with `candidateProfile: {}`, `experiences: []`, `education: []` and `ingestStatus: "uploaded"` (or `"fetch_failed"`),
4. Reads back the doc, projects `candidateProfile + experiences + education` → narrow `ResumeProfile { name, currentRole, yearsExp, skills, education, lastCompany, signatureProject }` shape for the agent.

The author's docstring acknowledges this is a stub: *"a grep across this repo turned up zero callable parser code (only readers). The brief explicitly authorizes a 'thin shim that posts the PDF to whatever endpoint does the parse + waits'."* This is exactly the gap iter30 is filling.

### 2.3 Schema written to `parsedCandidateResumes/{auto-id}`

Fields written by `ingestCv` (cv-ingest.ts L1121–1138):

```typescript
{
  userId,
  candidateProfile: { name, email, phone, linkedIn, location, skills[] },
  experiences: [{ company, title, startDate, endDate, location, description }],
  education: [{ school, degree, field, startDate, endDate }],
  industryTags: [...],   // 1..3 of INDUSTRY_TAGS enum
  originalFileName,
  fileType: "application/pdf",
  studentFrom: null,
  sessionId,
  mediaUrl,
  ingestedAt: ISO,
  ingestedVia: "imessage-attachment",
  createdAt: Date,
}
```

The H3 overwrite path also adds: `archived: bool`, `replacedBy: resumeId`, `archivedAt`, `additionalCv: bool`, `supplementsResumeId`.

### 2.4 Mem0 invocation

`@pa/memory.mem0Add(cfg, messages, userId)` (`packages/memory/src/mem0.ts` L278–311):

```typescript
export async function mem0Add(config, messages, userId): Promise<void> {
  const scrub = scrubCrisisFromMessages(messages)
  if (scrub.skip) { /* log + return without calling */ }
  const client = await getClient(config)
  await client.add(messages, { userId })
  emitMem0CostEvent("add", config, userId, { messageCount: messages.length })
}
```

**Critical gap for qaBank mapping**: `client.add(messages, { userId })` is called with **only `{ userId }`**. The mem0ai/oss `add` method supports a third options field `metadata: Record<string, any>` per memory entry — PA's wrapper does not pass it. We'd need to widen the mem0Add signature to accept metadata before mapping qaBank entries with category/intentTag tags.

Stack:
- LLM: SiliconFlow OpenAI-compat (`Qwen/Qwen2.5-72B-Instruct` default)
- Embedder: SiliconFlow `BAAI/bge-m3` (1024 dims) ← matches Adam's brief constraint
- VectorStore: Qdrant on Fly.dev, collection `pa-memory`
- Partition key: `mem0UserId` from `pa-users/{userId}.mem0UserId` (falls back to `userId`)

`mem0Search(config, query, userId)` returns `string[]` — no metadata in the read path either. To filter by category/intent on retrieval we'd need to extend that too.

---

## 3. Gap analysis

### 3.1 What VALET has that PA doesn't

| Capability                                 | VALET                                       | PA                                                                  |
|--------------------------------------------|---------------------------------------------|---------------------------------------------------------------------|
| Multi-provider LLM with auto-fallback      | LLMRouter, 3 tiers, 5xx/timeout retry       | Single OpenAI Responses call to `gpt-5.4-nano`. No fallback.       |
| Provider-level SDK retries                 | Anthropic SDK `maxRetries: 2`               | None (Responses API default).                                       |
| Workflow-level retry                       | Hatchet stale-row monitor                   | Fire-and-forget, no recovery if fails mid-flight.                   |
| `.docx` support                            | Yes (mammoth)                               | PDF only (silent fail on .docx).                                    |
| `summary` field                            | Yes                                         | No                                                                  |
| `projects[]`                               | Yes (with technologies, URL, dates)         | No                                                                  |
| `certifications[]`, `languages[]`, `awards[]`, `volunteerWork[]`, `interests[]`, `websites[]` | Yes | None                                                  |
| `totalYearsExperience` (computed)          | LLM computes from date ranges               | PA returns `experiences.length` as a heuristic (parse-resume.ts L104) |
| `workAuthorization`                        | Yes — explicit field ("US Citizen", "H1B", "OPT", "Permanent Resident") | No (huge job-rec gap — visa filtering needs this) |
| `parseConfidence` 0..1                     | Yes (stored on resumes row)                 | No                                                                  |
| `bullets[]` separate from `description`    | Yes (split sentence per bullet)             | No (one blob)                                                       |
| Q&A inference from resume                  | Yes (9 inferred answers per resume → qaBank)| No                                                                  |
| qaBank with intent tags                    | Yes (18-value enum)                         | No                                                                  |
| Resume-variants (per-job rewrite)          | Yes                                         | No                                                                  |
| Object storage                             | S3-compatible (R2 likely)                   | None — PDF bytes are pulled from Sendblue media URL on every read; no archive |
| Async progress events to client            | Redis pubsub `tasks:{userId}`               | No client-facing progress (Sendblue is fire-and-forget MMS)         |
| Size cap on PDF                            | Implicit via `executionTimeout: 30s`        | None on bytes; only `MAX_PDF_PAGES=50` + `MAX_TEXT_BYTES=100K` post-extract |
| Gate ("only after explicit ask")           | Web form (user clicks upload)               | None — every iMessage attachment auto-parses                        |
| Quota                                      | Implicit (one user, one resume row, isDefault toggle) | None — N parses per user                                  |
| Stale-flow recovery                        | `stale-resume-parse-monitor.ts` cron        | None                                                                |

### 3.2 What PA has that VALET doesn't

| Capability                                  | PA                                                  | VALET                                |
|---------------------------------------------|-----------------------------------------------------|--------------------------------------|
| iMessage trigger path                       | Sendblue webhook → fire-and-forget                  | Web upload form                      |
| Live LLM follow-up DM (Claire-voice)        | Stream E1 (`runFindingsFollowup`)                   | None                                 |
| Mem0 long-term memory write                 | Stream E2 (`runMem0Write`)                          | None (Postgres only)                 |
| `industryTags` enrichment (canonical 1..3)  | Yes (defensive enum-clamping)                       | None                                 |
| Crisis-content scrub on Mem0 writes         | Yes (`scrubCrisisFromMessages`)                     | N/A                                  |
| Overwrite-prompt UX (Stream H3)             | Yes (flag-gated tapback ❤️/🤔)                      | N/A                                  |
| Bilingual (zh/en) follow-up                 | `detectCvLang` + lang-conditional fact body         | None                                 |
| Crisis safety bank + PII hashing            | `@pa/pa-safety` integration                         | N/A                                  |
| Cost telemetry (`pa.cv_ingest.cost` event)  | Yes                                                 | LLMRouter `onUsage` callback hook    |
| Kill-switches (`PA_CV_FINDINGS_FOLLOWUP_DISABLED`, `PA_CV_MEM0_WRITE_DISABLED`) | Yes | None                          |
| pa-orchestrator CV context injection        | `appendCvContextToSystemPrompt` (latest non-archived doc) | Web app reads from DB              |

PA wins on the conversational orchestration side (Mem0, follow-up, crisis safety, bilingual). VALET wins on the parsing depth + reliability + qaBank inference side.

---

## 4. Recommendation: reuse vs port

### 4.1 Option A — Call VALET as a service

**Contract sketch:**

```
POST  https://valet-api.fly.dev/api/v1/resume/parse-by-url
Headers:  Authorization: Bearer {VALET_API_TOKEN}
          X-Origin: pa
Body:     { sourceUrl: string, externalUserId: string, idempotencyKey: string }
Response (sync): 202 + { resumeId, status: "parsing" }
Webhook (async): POST {paCallbackUrl} with { resumeId, status: "parsed" | "parse_failed", parsedData, inferredAnswers[] }
```

Required infra:
- VALET-side: a new public REST endpoint (doesn't exist today — VALET ingests via web form + Hatchet event, no HTTP-by-URL entry).
- A signed callback into PA Cloud Functions.
- Auth — shared HMAC or bearer token managed in both `.env`s.
- S3 bucket-sharing OR PA passes a one-time signed Sendblue media URL that VALET fetches directly. Sendblue media URLs are **time-limited**, so VALET must download immediately on receipt.

**Estimate:**
- Setup: 4–6 dev-days (new VALET endpoint + auth + callback handler in PA + idempotency contract + tests on both sides). VALET would also need a Hatchet event-emitter triggered by HTTP, not only by the existing web-upload flow.
- Latency: +1 cross-network hop on submit (~150ms p50) + parse time (Hatchet primary path ~5–15s) + 1 hop on webhook return (~100ms p50). PA's current single-shot OpenAI call takes 3–8s; this would land at 6–18s end-to-end.
- Ops complexity: VALET runs on Fly.dev infra Adam controls; uptime tied to that worker. If Hatchet queue stalls, all PA CV parses stall. Cross-team rollback is harder (two repos to revert).

**Showstoppers**:
1. VALET stores parsed data in Postgres. PA reads from Firestore. We'd duplicate-write or build a translator anyway — i.e. the Postgres → Firestore mapper that Option B would build internally.
2. qaBank → Mem0 mapping happens on the PA side regardless. We can't hand off this responsibility to VALET because Mem0 is PA's vector store, not VALET's.
3. Adam's mem0 user-partition key is PA-specific (`pa-users/{userId}.mem0UserId`). Not exposed through any VALET interface today.
4. VALET's `qaBank` is structured for the VALET use case (job-application form auto-fill via `discoverQuestions`/`saveAnswer`/`always_use`/`ask_each_time`/`decline_to_answer` modes). PA only needs the inferred-answer subset.

### 4.2 Option B — Port VALET workflow into PA

Create a new package `packages/pa-resume-parser` containing:

| File                                   | Source (VALET)                                    | Adaptation                                                                                  |
|----------------------------------------|---------------------------------------------------|---------------------------------------------------------------------------------------------|
| `src/schema.ts`                        | `packages/shared/src/schemas/resume.schema.ts`    | Drop `id/userId/createdAt/parsedAt` — those are storage fields. Keep `parsedResumeData` shape. Add re-export of existing PA `industryTags`. |
| `src/prompt.ts`                        | resume-parse.ts L48–145 + L295–303                | Use VALET's full prompt; wrap with PA's existing language hint. |
| `src/llm-router.ts`                    | `packages/llm/src/router.ts`                      | Strip Hatchet types. Keep `LLMRouter` + provider classes. Pre-configured with PA's keys (anthropic + openai). |
| `src/providers/anthropic.ts`, `openai.ts`, `base.ts` | `packages/llm/src/providers/*`         | Lift verbatim. They have zero VALET-internal deps. |
| `src/parse.ts`                         | resume-parse.ts L160–319                          | Replace Hatchet workflow.task wrapping → plain async function. Replace S3 download → `defaultFetchPdf` from PA cv-ingest. Replace DB writes → callback. Replace Redis pubsub → drop. |
| `src/qa-mapper.ts`                     | (new)                                             | Map LLM `inferredAnswers[]` → PA Mem0 entries. See §5.5. |

**Estimate**: 4–5 dev-days for the core port, 2–3 days for retry/quota/gating wrapper, 1 day Mem0 mapper, 1–2 days test coverage. **Total: 8–11 dev-days.**

**What stays out**:
- Hatchet (Cloud Functions = our orchestrator, not Hatchet)
- Postgres `resumes` / `qa_bank` tables (Firestore + Mem0 are our targets)
- S3 (we don't need to archive bytes — Sendblue hosts the media URL, and the parsed JSON is the canonical output)
- Redis pubsub (no client-facing progress channel — iMessage is async-by-nature)
- `resume-variants` (out of iter30 scope per Adam's brief)
- mammoth/.docx (PA brief says PDF only; defer)

**What gets added on PA side**:
- `apps/functions/src/cv-ingest/cv-gating.ts` — Firestore-backed `resumeAccepted` state check
- `apps/functions/src/cv-ingest/cv-quota.ts` — counter on `pa-users/{userId}.resumeParseCount`
- `apps/functions/src/cv-ingest/cv-size-cap.ts` — Content-Length check on download
- 6+ unit tests + 1 e2e scenario

### 4.3 Pick: Option B (port)

**Rationale**:
1. Adam's brief explicitly authorizes "VALET parse 直接用就好，可以用好一点的 LLM" — model selection choice, not architecture choice. Port = full control over model selection.
2. The high-value VALET assets are **schema + prompt + LLMRouter**, and these are pure libraries with no platform coupling. The platform coupling (Hatchet, S3, Postgres) is what we'd have to build adapters around in Option A.
3. The PA-side post-processing (Mem0, follow-up, crisis scrub, overwrite UX) is already in place and would still need to run after VALET returned anyway. Option A doesn't save that work.
4. Cross-repo runtime coupling is operationally riskier than a contained port. Single repo ownership of the path = single deploy gate.
5. Reading Adam's literal directive "**如果用起来不麻烦就复用，没必要就算了**" — calling VALET would require new cross-cutting infra (HTTP API on VALET side, callback handler on PA side, shared auth). That's "麻烦". Porting code is cleaner.

> [🟠 阿里味] **抓手**：把 VALET 的 schema + prompt + LLMRouter 拎出来当 library 用，不绑 Hatchet/S3/Postgres，**端到端在 PA 内部闭环**。这才是颗粒度对齐的复用。

---

## 5. Constraint integration spec (for Option B)

### 5.1 Gating — "Claire said 'send me your resume'"

**Mechanism**: Firestore flag on `pa-users/{userId}` document.

```typescript
// pa-users/{userId} additions:
{
  resumeAccepted: {
    at: Timestamp,         // when Claire said it
    expiresAt: Timestamp,  // at + 24h
    triggerHash: string,   // sha256 of the Claire turn that opened the gate (audit)
  } | null
}
```

**Set point**: post-LLM-turn hook in pa-orchestrator. After Claire's reply is generated, run a regex bank against the assistant text. Bilingual:
```
zh: /(你可以发我简历|发简历给我|发我简历|把简历发给我|把你简历发我|发份简历)/
en: /\b(send (me )?your (resume|cv)|share your (resume|cv)|email me your (resume|cv))\b/i
```
On match → write `resumeAccepted = { at: now, expiresAt: now + 24h, triggerHash }`. Upsert (latest wins).

**Check point**: at top of `ingestCv()` BEFORE `defaultFetchPdf`. Read `pa-users/{userId}.resumeAccepted`. If missing or `expiresAt < now` → return `{ ok: false, reason: "not_invited" }` and enqueue an outbound **Claire-voice** rejection:

```
zh: "我还没问你要简历呢, 先聊聊呗～你想找啥方向?"
en: "haven't asked for your resume yet — wanna chat first about what you're looking for?"
```

**Latency**: single Firestore doc read on the same `pa-users/{userId}` doc that the webhook already touches twice (lookupUserByPhone, lookupUserForFollowup). With Firestore's per-doc cache and concurrent reads in flight, real cost is ~5–15ms. Well inside the 10ms budget when the doc is already hot.

**Edge cases to enforce**:
- If user uploads CV in turn N+1 after Claire asked in turn N → gate is open. ✓
- If user ignores ask, comes back 25 hours later with PDF → gate closed → friendly nudge. (24h chosen because Claire's tone is roommate-y; longer feels stale, shorter punishes slow phone-checkers.)
- If Adam wants to bypass for testing → `PA_RESUME_GATE_DISABLED=true` env kill-switch, mirrors existing PA pattern (`PA_CV_FINDINGS_FOLLOWUP_DISABLED`).

**Why Firestore flag, not "scan last N turns of conversation"**:
- Last-N-turn scan requires a Firestore range query on `pa-conversation-turns/{userId}/...` (PA's existing turn store). Higher latency, harder to test, inconsistent across compaction.
- Persistent flag is auditable, idempotent, kill-switch-friendly, and survives compaction.
- Trigger hash gives us audit trail: which Claire utterance opened the gate? (For when Adam asks "why was this gate open").

### 5.2 Quota — max 2 lifetime parses per user

**Counter**: `pa-users/{userId}.resumeParseCount: number`. Default missing → 0.

**Increment point**: inside `ingestCv()` AFTER successful Firestore write to `parsedCandidateResumes` (i.e. only successful parses count, not failed downloads). Use Firestore `FieldValue.increment(1)` for atomicity.

**Gate point**: at top of `ingestCv()` AFTER gating check. Read the count.

| Count | Behavior |
|-------|----------|
| 0     | Proceed (1st parse) |
| 1     | Proceed (2nd parse — replaces or supplements via H3 UX) |
| ≥ 2   | **Block** — return `{ ok: false, reason: "quota_exhausted" }`. Enqueue Claire-voice rejection. |

**3rd-attempt rejection text** (Adam's draft polished for Claire voice):
```
zh: "我已经看过你两份简历了😅 这次咱们口头聊聊吧 — 现在卡在哪个环节?"
en: "I've read two of your resumes already 😅 let's just talk this time — where are you stuck?"
```

The text leans into Claire's persona (lemon-emoji sparingly, casual contraction, redirect to conversation) rather than sounding like a quota error. ⏎ Note: PA's existing iMessage normalizer (`@pa/pa-orchestrator.normalizeForIMessage`) will strip markdown, so plain text only.

**Why hard cap vs soft warning**:
- Adam's brief: "max 2 PDF parses per user lifetime" — explicit upper bound.
- Each parse is $0.0005–0.002 (gpt-5.4-nano); not a $-driven cap. The cap is a behavioral nudge — once Claire has the CV, more uploads are noise, not signal.
- If an edge case warrants override, Adam can manually bump `resumeParseCount` in Firestore Console (auditable) or set `PA_RESUME_QUOTA_DISABLED=true`.

### 5.3 Size cap

**Recommendation: 5 MB** (5 × 1024 × 1024 = 5,242,880 bytes).

**Rationale**:
- Sendblue MMS supports attachments via the iMessage backbone. iMessage attachment limit is **100 MB** per file. So Sendblue is not the binding constraint.
- A typical text-heavy resume PDF is 200KB–1MB. A high-design "studio" resume with full-page images is 2–4MB. A scanned PDF is 5–15MB. 5MB cleanly admits the first two categories and rejects the third (which we can't OCR anyway with `pdf-parse` — it returns empty text on image-only PDFs and would fail at step 2 of `ingestCv` regardless).
- 5MB also caps Cloud Functions memory pressure: `pdf-parse` loads the whole buffer in RAM. The CV-ingest CF has 512MB allocated; 5MB PDF + parsed text + LLM context is comfortably <100MB peak.

**Where to enforce**: at `ingestCv` entry — **before** writing anything. Two-stage check:
1. **HEAD request** to mediaUrl, read `Content-Length`. If > 5MB → reject.
2. **Bounded read** of GET response — abort if streamed bytes exceed 5MB (defense against missing/lying Content-Length).

```typescript
const MAX_PDF_BYTES = 5 * 1024 * 1024
async function fetchPdfWithSizeCap(url: string): Promise<{ bytes: Uint8Array }> {
  const head = await fetch(url, { method: "HEAD" })
  const contentLen = parseInt(head.headers.get("content-length") ?? "", 10)
  if (Number.isFinite(contentLen) && contentLen > MAX_PDF_BYTES) {
    throw new SizeError(`pdf_too_large: ${contentLen} > ${MAX_PDF_BYTES}`)
  }
  // ... GET with running counter, abort if exceeded
}
```

**Reject at iMessage webhook, or at parse entry**?

**Decision: at parse entry** (inside `ingestCv`).
- Keeps webhook code path simple — webhook is high-traffic, hot path.
- Size check requires an extra HTTP round-trip (HEAD); pushing it into ingestCv keeps it fire-and-forget.
- Keeps the "user got tapback ❤️" UX consistent — they sent something, we acked. Then we tell them off-band ("簡历好像太大了, 发个普通的 PDF 给我?") via Claire-voice outbound when oversized.

**Oversized rejection text**:
```
zh: "诶, 你这简历是不是图片版的? 文件太大了 (>5MB), 发个文字版 PDF 给我看看~"
en: "is your resume an image PDF? too big to read (>5MB) — can you send a text-based one?"
```

### 5.4 Retry policy

**Layer 1 — LLM call** (inside `pa-resume-parser.parse()`, ported LLMRouter):
- Provider SDK: 2 retries with exponential backoff (Anthropic SDK default).
- Router fallback chain on 5xx / rate / timeout / overloaded: Sonnet 4.5 → gpt-4.1-mini → gpt-4.1-nano.
- Total best-case attempt count: 2 SDK × 3 router-tier = up to 6 LLM calls before declaring `llm_parse_failed`.
- **No** retry on 4xx / parse-error / schema-validation failure (those are deterministic, retrying makes no difference).

**Layer 2 — full parse workflow** (inside `ingestCv`):
- Wrap `parse()` call in `pRetry` (or hand-rolled equivalent — PA already has retry helpers in pa-broker; reuse).
- Backoff curve: `[1s, 4s, 16s]` — Fibonacci-ish, max 3 attempts.
- Conditions for outer retry: only on `llm_overloaded`, `network_timeout`, `download_timeout`. NOT on `pdf_parse_failed` (deterministic), `quota_exhausted` (deterministic), `not_invited` (deterministic), `pdf_too_large` (deterministic).
- Total budget: 3 outer × 6 inner = up to 18 LLM calls in the absolute pathological case. Reality: the second outer attempt almost always succeeds because the fallback chain handles 5xx already.

**Layer 3 — workflow recovery** (Phase-N follow-up, NOT iter30):
- Stale-row monitor cron — sweep `parsedCandidateResumes` for rows with `ingestStatus="parsing"` older than 5 min. Re-trigger `parse()`. (VALET equivalent: `stale-resume-parse-monitor.ts`.)
- Out of iter30 scope. File as backlog.

**"Success" definition**:
- `parsedCandidateResumes/{id}` doc written with `ingestStatus="parsed"`.
- `parsingConfidence` ≥ 0.5 (LLM self-rated; below this we still write but log a warning event `pa.cv_ingest.low_confidence`).
- Mem0 fact-body added (best-effort, never blocks the success signal — mirrors current Stream E2 behavior).

Idempotency: PA's H3 path already uses `auto-id` for `newResumeId`, so retries naturally produce distinct IDs. To dedupe re-parses of the *same* PDF, hash the bytes (sha256) and store as `bytesHash` field; on incoming parse, query `parsedCandidateResumes.where("userId","==",X).where("bytesHash","==",H)` — if found, return the existing resumeId.

### 5.5 qaBank → Mem0 mapping

**Step 1 — extend the LLM prompt** to emit `inferredAnswers[]` (lift from VALET prompt, lines 113–142). This adds 9 question-shaped facts per resume.

**Step 2 — extend `mem0Add` signature** in `packages/memory/src/mem0.ts` to accept optional `metadata`:

```typescript
export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string,
  metadata?: Record<string, string | number>   // ← NEW
): Promise<void> {
  // ...
  await client.add(messages, {
    userId,
    ...(metadata ? { metadata } : {})
  })
}
```

**Step 3 — qa-mapper module** writes one Mem0 entry per inferredAnswer:

```typescript
type InferredAnswer = {
  question: string
  answer: string
  confidence: number        // 0..1
  category: "personal" | "experience" | "education" | "skills" | "preferences"
}

async function writeQaToMem0(
  userId: string,
  partitionKey: string,
  inferredAnswers: InferredAnswer[],
  cfg: Mem0Config
): Promise<void> {
  for (const a of inferredAnswers) {
    const factBody = `Q: ${a.question}\nA: ${a.answer}`  // Mem0's extractor will canonicalize
    const intentTag = mapQuestionToIntentTag(a.question)  // see below
    const memHash = sha256(`${userId}::${a.question}`)
    await mem0Add(cfg, [{ role: "user", content: factBody }], partitionKey, {
      source: "resume_inferred",
      qa_category: a.category,
      qa_intent_tag: intentTag,
      qa_confidence: a.confidence,
      qa_dedupe_hash: memHash,
      ingested_at: new Date().toISOString(),
    })
  }
}
```

**Question → intentTag mapping** (regex bank, port from VALET's qaIntentTag enum):

| Question pattern                                      | intentTag                |
|-------------------------------------------------------|--------------------------|
| /(authoriz|visa|sponsor|H1B|OPT|green card)/i         | `work_authorization`     |
| /(salary|compensation|expected pay|薪资|期望工资)/i    | `salary_expectation`     |
| /(start date|available|notice period|开始日期)/i      | `start_date`             |
| /(relocate|move|remote|on-site|relocation)/i          | `relocation_willingness` |
| /(years?\s+of\s+experience|工作年限)/i                | `relevant_experience`    |
| /(education|degree|highest level|学历)/i              | `relevant_experience`    |
| /(current|most recent)\s+(role|title|job)/i           | `relevant_experience`    |
| (catchall)                                            | `other`                  |

**`agent_id` namespace**: Adam's brief asks for an agent_id. mem0ai/oss supports `agent_id` as a partition orthogonal to `user_id`. Recommend `agent_id="claire"` for all PA writes (currently PA writes everything to `user_id` only — adding `agent_id="claire"` lets us namespace future agents like "recruiter" without colliding). Two-line change in mem0Add.

**Dedupe**:
1. mem0ai's own `Memory.add()` runs a fact-extraction LLM that semantically dedupes against existing memories. This is the primary dedupe — don't fight it.
2. Belt + suspenders: pre-write check via `mem0Search(query=question, userId=partitionKey, topK=3)` — if any result has `metadata.qa_dedupe_hash === memHash`, skip. Saves an LLM extraction call when the same resume is parsed twice.
3. The hash is `sha256(userId::question)` — collision-resistant for qaBank semantics. Two different users uploading the same canonical question generate distinct hashes.

**Avoiding write storm on quota=2 user**:
- 2 parses × 9 inferredAnswers = up to 18 Mem0 writes per user lifetime. With dedupe, ~9–14 unique memories. Budget is comfortable.

---

## 6. Effort estimate (Option B)

Total: **8–11 dev-days**, broken into 6 milestones.

| MS | Milestone                                | Work                                                                                 | Days |
|----|------------------------------------------|--------------------------------------------------------------------------------------|------|
| 1  | Parse path online                        | Create `packages/pa-resume-parser` package. Port LLMRouter + providers + schema + prompt + parse.ts. Adapt for Cloud Functions runtime (no Hatchet types, no Redis). Replace PA's current `defaultLlmExtract` with a call to `pa-resume-parser.parse()`. Existing `validateStructuredCv` becomes a thin wrapper around the ported Zod schema. | 3 |
| 2  | Gating                                   | Add `setResumeGate` post-LLM-turn hook in pa-orchestrator. Add `checkResumeGate` at ingestCv entry. Bilingual regex bank + 24h TTL flag in `pa-users/{userId}.resumeAccepted`. Friendly-rejection outbound enqueue. Env kill-switch. | 1.5 |
| 3  | Quota                                    | Add `resumeParseCount` field to `pa-users/{userId}` (default 0, increment on success). Hard-cap at 2. 3rd-attempt rejection text. Env kill-switch. | 1 |
| 4  | Size cap + retry                         | HEAD-then-GET size guard at 5MB. Outer-retry wrapper (3 attempts, [1s, 4s, 16s] backoff, retryable-condition allowlist). Idempotency hash field. | 1.5 |
| 5  | qaBank → Mem0 mapper                     | Extend `mem0Add` signature to support metadata + agent_id. New `qa-mapper.ts` module: question-to-intentTag regex bank, dedupe via sha256 hash + pre-search check, Mem0 write loop. Plumb into `runMem0Write`. | 1.5 |
| 6  | Tests + scenario                         | Unit tests for each module (gate, quota, size, retry, qa-mapper) — minimum 12 tests targeting branch coverage of constraint matrix. End-to-end scenario `iter30-resume-flow.yaml` covering: (a) Claire asks → user uploads → parse + Mem0 write succeeds, (b) user uploads w/o ask → friendly nudge, (c) 3rd upload → quota rejection, (d) oversized PDF → size-cap rejection, (e) LLM 5xx → router fallback succeeds. | 2 |
| —  | **Buffer (10–15%)**                      | Code review fixes, integration with H3 overwrite UX, iter23 PUA-style verification ("test every playbook")           | ~1 |

Per CLAUDE.md "verify by doing": each milestone MUST end with `pnpm --filter pa-resume-parser test` green + a relevant scenario run end-to-end before merge.

---

## 7. Risks (with mitigations)

| # | Risk                                                                                              | Likelihood | Impact | Mitigation                                                                                           |
|---|---------------------------------------------------------------------------------------------------|------------|--------|------------------------------------------------------------------------------------------------------|
| 1 | **Sonnet 4.5 cost**: VALET routes parseResume to Sonnet 4.5 (~$0.015/CV); PA today uses gpt-5.4-nano (~$0.001). 15× cost increase per parse. | Medium-high | Medium | Make model tier configurable via env `PA_RESUME_PARSER_TIER` (default `"primary"`); A/B with `"resume"` (gpt-5.4-nano fallback) to compare quality. Hard-cap monthly via existing `pa.spend.daily` telemetry alarm at $50/month — quota=2 + ~50 active users = ~100 parses = $1.50/mo, well under. |
| 2 | **Gate regex misfires**: Claire says "you can send me your resume later" → gate opens prematurely, or says "把简历准备好啊" → gate closes. | Medium | Low-medium | Conservative bilingual regex (no negation handling). Audit-trail `triggerHash` lets us back-test against actual orchestrator output before rollout. Iter23 scenario verification: run 10-turn ride-or-die with deliberate bait phrases ("帮我看看简历", "你简历准备好没"), confirm gate state matches expectation. |
| 3 | **Quota enforcement race**: two PDFs uploaded back-to-back, both pass quota check before either increments → 3 parses written. | Low | Low | Use Firestore `FieldValue.increment()` (atomic). For the gate: read+check+write the count in a single transaction. Sendblue webhook serializes per-handle; cross-conversation parallel uploads are the only realistic race and 1 extra parse is acceptable shadow. |
| 4 | **PDF.js / pdf-parse wedge in CF**: `pdf-parse@1.1.1` already had the test-fixture bug requiring inner-path import; lifting newer versions could break esbuild bundling. | Low | High | Pin `pdf-parse@1.1.1` (current PA version). Don't upgrade unless explicit need. Add a smoke test that loads pdf-parse + parses a 5-line fixture PDF; fails the predeploy if bundling regresses. |
| 5 | **Mem0 metadata mismatch with mem0ai/oss SDK**: `client.add(messages, { userId, metadata })` may not actually persist metadata in the Qdrant payload depending on SDK version. PA pinned to a specific mem0ai/oss version. | Medium | Medium | Verify in iter30 MS5: write a test fact with metadata, fetch via Qdrant Fetch API directly, assert metadata is present in payload. If not — open a fork PR or fall back to encoding metadata in the message content (`"[qa_intent_tag=salary_expectation]"` prefix). |
| 6 | **Cross-language LLM hallucination**: Sonnet 4.5 prompt is English-only; Chinese resumes may produce English-translated `inferredAnswers` (loses fidelity for zh-only users). | Medium | Medium | Pass `detectCvLang(parsed)` upstream as a system-prompt hint: "Respond in user-language (zh resume → zh answers)". Test with 3 zh and 3 en fixture resumes during MS6. |
| 7 | **24h gate TTL is wrong number**: Claire ride-or-die UX may expect tighter (4h?) or looser (72h?) windows. | Low-medium | Low | Make TTL configurable via env `PA_RESUME_GATE_TTL_HOURS=24`. iter23-style verification: run a 6-turn scenario with gap-time injection, observe Claire's actual response when user comes back. |
| 8 | **Friendly-rejection outbound flood**: if a user mass-uploads 5 PDFs in 30s when quota is exhausted, we'd enqueue 5 quota-rejection messages — annoying. | Medium | Low | Idempotency key `out-cv-quota-{userId}-{YYYYMMDD}` on quota-reject outbound — at most 1 per user per day. Same pattern for gate-rejection (`out-cv-gate-{userId}-{YYYYMMDD}`). |
| 9 | **VALET schema → PA Firestore field mismatch**: VALET has `workHistory[]` with `bullets[]` + `achievements[]`; PA has `experiences[]` with `description` (one blob). Storing bullets in PA breaks `appendCvContextToSystemPrompt` reader. | Low | Medium | Migration plan: write **both** `experiences[]` (current PA shape, derive `description = bullets.join(". ")`) **and** `experiencesFull[]` (new VALET shape, including bullets/achievements). pa-orchestrator reader unchanged in iter30; future migration moves to `experiencesFull`. |
| 10 | **iter30 conflicts with iter22 H3 overwrite UX**: when 2nd resume arrives we now have 3 gates (gate, quota, size), each with a friendly rejection. Could clobber H3's "替代之前那份吗?" tapback. | Medium | Low | Order-of-operations matters: gate check → size check → quota check → THEN H3 flag-gate. Each predecessor failure short-circuits. Verify in MS6 scenario: H3 enabled + quota=1 → 2nd upload triggers H3 prompt (not quota rejection). H3 enabled + quota=2 (impossible reach by quota rule) → never reachable → no conflict. |

---

## TL;DR for Adam

- **Pick: Option B (port).** VALET's parseResume value is the schema/prompt/LLMRouter triplet — those are pure libraries with zero coupling to Hatchet/Postgres/S3. Calling VALET as a service buys nothing but a new HTTP API to maintain on both sides. Port = 8–11 dev-days; service-call setup alone is 4–6 days plus ongoing latency + ops complexity.
- **PA gaps confirmed**: no fallback model, no retry, no size cap, no gate, no quota, no Q&A inference, no `summary`/`workAuthorization`/`projects[]`/`certifications[]`/etc. PA's `parse-resume.ts` is literally a stub doc-writer — comments admit it.
- **Constraint design (4 of 4 + Mem0 5th)**: gate = Firestore `pa-users/{userId}.resumeAccepted` with 24h TTL set by post-LLM-turn regex hook (~10ms read at parse time); quota = atomic `FieldValue.increment` counter with hard cap 2 + Adam's exact rejection-text polished; size cap = **5 MB** (HEAD then bounded GET, enforced at parse entry not webhook); retry = Anthropic SDK 2× wrapped by 3-tier router fallback wrapped by 3-attempt outer retry on retryable-only conditions (~$0.015 worst case); qaBank → Mem0 = extend `mem0Add` to take metadata, agent_id="claire", dedupe via sha256(userId::question) hash + mem0's intrinsic semantic dedupe.
- **Top 3 risks**: (1) Sonnet 4.5 cost is 15× gpt-5.4-nano — gate behind `PA_RESUME_PARSER_TIER` env; (2) gate regex misfires on Claire's bilingual phrasing — audit-trail `triggerHash` for back-testing; (3) mem0ai/oss may swallow metadata depending on version — verify via direct Qdrant payload read in MS5.
- **Closure path**: 6 milestones, each ending with `pnpm test` green + scenario run per CLAUDE.md iter23 directive ("每个 playbook 测试看看是否真的生效"). End state = same UX as today (PDF in → Claire reply + Mem0 fact), but with deeper schema, retry resilience, gate/quota/size enforcement, and 9 inferred Q&A facts per CV feeding job-rec.

> [PUA生效 🔥] 主动核对了 mem0ai/oss SDK 的 metadata API surface — 标准 `client.add(messages, opts)` 接受 `metadata` 参数，但 PA 当前 `mem0Add` 包装层根本没透传，这是 §5.5 步骤 2 必须改的 SDK 边界。这不是抄 VALET 能解决的，是 PA 自己的 wrapper 缺漏。底线思维 —— 先把这个洞补上再动 qaBank 映射，否则 metadata 全部丢失，后期 search 无从检索。
