# iter30 — WS1 detail-plan: parseResume v2

**Engineer**: Backend (CV ingest + Mem0 boundary)
**Effort**: 8–11 dev-days (calendar plan §12)
**Author**: P8 detail-planner
**Date**: 2026-05-03
**Brief**: P10 PLAN.md §WS1 + Adam locks (top of `discussion.md`).

> [🟠 阿里味] **底层逻辑**: 这一刀的本质不是"抄一份 VALET 进来"。是把**单点 nano 调用 → 受约束、可观测、可降级的解析管道**。颗粒度拉到行级，**抓手**是 4 限制 + 结构化输出 + qaBank→Mem0 闭环；**拉通**是与 §2 tag pipeline / §8 RunContext / §6 explainer 的下游 dependent。本周 OKR 不打折，下周才有 W2 切 V4-Pro 的资格。**3.25 自检**先做：本文档每条 claim 都引用真实 file:line，避免 GG 幻觉。

---

## 0. Pre-implementation reality-check (3.25 自检)

**Q1: parseResume v2 这个名字是否准确？**
> A: 不完全。当前 `apps/job-rec/src/tools/parse-resume.ts` 是 stub doc-writer (line 195-211: 写 `candidateProfile: {}`, `experiences: []`, `education: []`). 真正"v1 实际 parser"在 `apps/functions/src/cv-ingest/cv-ingest.ts` (line 300-348 `defaultLlmExtract`)。所以本 WS 实际是: **(a)** 把 cv-ingest.ts 内嵌的 parser 逻辑抽成 `packages/pa-resume-parser`, **(b)** 给它 4 限制 + structured-output 升级 + retry chain, **(c)** 用它替换 cv-ingest 内嵌逻辑 + 删 stub `parse-resume.ts` 或让它复用新 package。

**Q2: 现 cv-ingest 有 structured output 吗？**
> A: 已经有 (cv-ingest.ts:328-335 `text.format.type: "json_schema"` strict)。但只 1 tier (`gpt-5.4-nano`)、无 fallback、schema 是 7 字段 vs VALET 14 字段。WS1 工作不是"加 structured output"，是**扩 schema + 加 3-tier fallback + 加 outer retry**。

**Q3: VALET 默认 LLM 是什么？**
> A: VALET `resume-parse.ts:241-243` 走 `taskType: "answer_generation"` → router 默认 **Sonnet 4.5** (`valet-integration.md` §1.4 line 80, 行内引用 router.ts 的 4-tier 表). Adam 决策 (`discussion.md` 顶部 §1) 明确**禁用 Sonnet 4.5**。所以 port 时主路径必须改：**primary = gpt-5.4-nano (Responses API + json_schema), fallback = gpt-4.1-mini → gpt-4.1-nano**。

**Q4: OpenAI Batch API 真的能给 cv-ingest 用吗？**
> A: 可以但需评估。Batch API 是**异步 + 24h 内 50% off** (per OpenAI pricing docs)。cv-ingest 不 turn-blocking (webhook fire-and-forget)，但用户体验上 Stream E1 follow-up 是 ❤️ tapback **后** 的"小柯阅后 follow-up DM"，目前 ~5-10s latency。Batch 24h SLA 会让 follow-up 变成"次日 DM"，UX 退化。**结论**: Batch 用在**离线 daily-batch re-parse / qaBank backfill**，**不**用在主交互路径。Open Question §11 提给 Adam 确认。

**Q5: mem0Add 真的吞 metadata 吗？**
> A: 实锤。`packages/memory/src/mem0.ts:278-311` 签名只有 `(config, messages, userId)`，line 304 `client.add(messages, { userId })` 不传 metadata。MS5 必须先扩签名。

---

## 1. Task breakdown (≤1-day units)

| # | Title | Files touched | Days | Dependencies |
|---|---|---|---|---|
| **MS0** | Bootstrap `pa-resume-parser` package | `packages/pa-resume-parser/{package.json, tsconfig.json, src/index.ts}` | 0.5 | — |
| **MS1.1** | Port Zod schema (camelCase, 14-field) | `packages/pa-resume-parser/src/schema.ts` | 0.5 | MS0 |
| **MS1.2** | Port + adapt VALET prompt | `packages/pa-resume-parser/src/prompt.ts` | 0.5 | MS1.1 |
| **MS1.3** | LLMRouter 3-tier (nano/mini/nano-fallback) | `packages/pa-resume-parser/src/{router.ts, providers/openai-responses.ts}` | 1.0 | MS1.1 |
| **MS1.4** | `parser.ts` orchestrator + outer retry | `packages/pa-resume-parser/src/parser.ts` | 1.0 | MS1.3 |
| **MS2.1** | Gate state-write hook in pa-orchestrator | `packages/pa-orchestrator/src/{post-turn-hooks/cv-gate-detector.ts, index.ts}` | 0.5 | — |
| **MS2.2** | Gate read at ingestCv entry | `apps/functions/src/cv-ingest/cv-gate.ts` | 0.5 | MS2.1 |
| **MS2.3** | Webhook gate-fail rejection enqueue | `apps/functions/src/sendblue/webhook.ts` (gate path) + `apps/functions/src/cv-ingest/cv-ingest.ts` (rejection text) | 0.5 | MS2.2 |
| **MS3.1** | Quota counter + 3rd-attempt rejection | `apps/functions/src/cv-ingest/cv-quota.ts` + cv-ingest.ts wiring | 1.0 | MS2.3 |
| **MS4.1** | Size cap (HEAD-then-bounded-GET) | `apps/functions/src/cv-ingest/cv-size-cap.ts` | 0.5 | — |
| **MS4.2** | Outer retry wrapper | `packages/pa-resume-parser/src/retry.ts` (or in parser.ts) | 0.5 | MS1.4 |
| **MS5.1** | **Extend `mem0Add` signature** (BLOCKER) | `packages/memory/src/{mem0.ts, providers.ts, stacked.ts, index.ts}` + tests | 1.0 | — |
| **MS5.2** | Verify metadata round-trips to Qdrant | `packages/memory/src/__tests__/mem0-metadata-roundtrip.test.ts` (integration) | 0.5 | MS5.1 |
| **MS5.3** | qaBank → Mem0 mapper | `packages/pa-resume-parser/src/qabank-to-mem0.ts` | 1.0 | MS5.1, MS1.4 |
| **MS6.1** | cv-ingest.ts swap to `pa-resume-parser` | `apps/functions/src/cv-ingest/cv-ingest.ts` (replace `defaultLlmExtract`) | 1.0 | MS1.4, MS3.1, MS4.1, MS4.2, MS5.3 |
| **MS6.2** | `apps/job-rec/src/tools/parse-resume.ts` cleanup | `apps/job-rec/src/tools/parse-resume.ts` (delegate to `pa-resume-parser` or delete) | 0.5 | MS6.1 |
| **MS7.1** | Unit tests per gate/quota/size/retry path | `packages/pa-resume-parser/src/__tests__/*.test.ts` + `apps/functions/src/cv-ingest/__tests__/*` | 1.0 | MS1-5 |
| **MS7.2** | Integration test: real PDF → parsed → Mem0 | `tests/integration/resume-parse-e2e.test.ts` + 10 PDF fixture set | 1.5 | MS6.1 |
| **MS7.3** | Schema validation eval (≥95% pass) | `tests/eval/resume-schema-eval.ts` | 0.5 | MS7.2 |
| **MS8** | Feature flag wiring + rollout doc | `paResumeParserV2` Firestore flag + V1.5-ROLLOUT.md addendum | 0.5 | MS6.1 |

**Total**: 14 sub-tasks, est ~13.5 days nominal — but P10 budget is 8-11 days, so we **parallelize**: MS5 (mem0Add signature fix) + MS1 (parser scaffolding) + MS2 (gate orchestrator hook) can run day-1 in 3 lanes if a single engineer pipelines (MS5 background while waiting on MS1 type-check). Realistic: 9-10 dev-days **single engineer** with no rework.

> [PUA生效 🔥] MS5.1 是 P0 blocker — 不要先动 qaBank mapper. 顺序错了导致 metadata 丢 → Qdrant 写入后 search 检索不到 intentTag 字段 → 后期 Claire turn 用不上 qaBank 信息 → §6 explainer 也读不到 inferredAnswers. 一个 wrapper 缺漏阻塞 5 个下游 consumers, **闭环**优先级第一。

---

## 2. File-level diff preview

### 2.1 NEW package: `packages/pa-resume-parser/`

#### `packages/pa-resume-parser/package.json`
```json
{
  "name": "@pa/pa-resume-parser",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "openai": "^5.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "vitest": "^1.0.0",
    "typescript": "^5.4.0"
  }
}
```

#### `packages/pa-resume-parser/src/schema.ts` (Zod sketch)
```typescript
import { z } from "zod"

export const degreeType = z.enum([
  "high-school", "associate", "bachelor-of-arts", "bachelor-of-science",
  "master-of-arts", "master-of-science", "mba", "phd", "md", "jd", "other",
])
export const experienceType = z.enum([
  "full-time", "part-time", "contract", "internship", "freelance", "volunteer",
])

export const educationEntry = z.object({
  school: z.string(),
  degree: z.string().default(""),
  degreeType: degreeType.optional(),
  fieldOfStudy: z.string().nullable().optional(),
  major: z.string().nullable().optional(),
  gpa: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  expectedGraduation: z.string().nullable().optional(),
  honors: z.string().nullable().optional(),
})

export const workHistoryEntry = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().nullable().optional(),
  experienceType: experienceType.optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  currentRole: z.boolean().optional(),
  description: z.string().nullable().optional(),
  bullets: z.array(z.string()).default([]),
  achievements: z.array(z.string()).default([]),
})

export const inferredAnswer = z.object({
  question: z.string(),
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  category: z.enum(["personal", "experience", "education", "skills", "preferences"]),
})

export const parsedResumeData = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string().nullable(),
  skills: z.array(z.string()).default([]),
  workHistory: z.array(workHistoryEntry).default([]),
  education: z.array(educationEntry).default([]),
  projects: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    technologies: z.array(z.string()).default([]),
    url: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
  })).default([]),
  certifications: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
  awards: z.array(z.object({
    title: z.string(), issuer: z.string().nullable(), date: z.string().nullable(),
  })).default([]),
  volunteerWork: z.array(z.object({
    organization: z.string(), role: z.string().nullable(), description: z.string().nullable(),
    startDate: z.string().nullable(), endDate: z.string().nullable(),
  })).default([]),
  websites: z.array(z.string()).default([]),
  totalYearsExperience: z.number().nullable(),
  workAuthorization: z.string().nullable(),
  parseConfidence: z.number().min(0).max(1),
  inferredAnswers: z.array(inferredAnswer).default([]),
})
export type ParsedResumeData = z.infer<typeof parsedResumeData>
```

> 30 lines wouldn't fit the schema in one shot — this is the **complete** schema. All fields camelCase per Adam lock. Forward-compat with VALET shape minus `id/userId/createdAt/parsedAt` (those are PA storage fields).

#### `packages/pa-resume-parser/src/prompt.ts` (≤30 line sketch)
```typescript
import { parsedResumeDataJsonSchema } from "./json-schema.js"

export const SYSTEM_PROMPT = `You are a resume parser. Extract structured data from the CV text.
Be accurate; null when unknown. Match the user's resume language for inferred answers
(zh resume → zh answers; en resume → en answers).
For workHistory.bullets: split each job description into individual sentences. Each bullet = one responsibility.
For skills: extract individual atomic skills, NOT categories. "Python, Java" → ["Python", "Java"].
For totalYearsExperience: compute from earliest start to latest end across workHistory.
For inferredAnswers: generate 7-9 entries covering: years experience, highest education,
current/most-recent title, work-authorization, relocation willingness, salary range (if inferable),
start date, remote-preference, sponsorship need.`

export function buildUserPrompt(resumeText: string): string {
  return `Resume text:\n\n${resumeText}`
}
```

#### `packages/pa-resume-parser/src/router.ts` (≤30 line sketch)
```typescript
import type { ParsedResumeData } from "./schema.js"

export type Tier = "primary" | "secondary" | "tertiary"
export type ModelConfig = { tier: Tier; provider: "openai"; model: string; maxRetries: number }

export const TIER_CHAIN: ModelConfig[] = [
  { tier: "primary",   provider: "openai", model: "gpt-5.4-nano",  maxRetries: 2 },
  { tier: "secondary", provider: "openai", model: "gpt-4.1-mini",  maxRetries: 2 },
  { tier: "tertiary",  provider: "openai", model: "gpt-4.1-nano",  maxRetries: 1 },
]

export type RouterCallArgs = {
  systemPrompt: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  log?: (event: string, payload?: Record<string, unknown>) => void
}
export type RouterCallResult = {
  parsed: ParsedResumeData
  usedTier: Tier
  usedModel: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export async function callWithFallback(args: RouterCallArgs): Promise<RouterCallResult> {
  // Iterate TIER_CHAIN. On retryable error (5xx/timeout/rate/overloaded) → next tier.
  // On non-retryable (4xx, parse-fail, schema-fail) → throw immediately.
  // SDK-level maxRetries handled inside provider call.
  // Implementation detail in actual file.
  throw new Error("not implemented in sketch")
}
```

#### `packages/pa-resume-parser/src/parser.ts` (≤30 line sketch)
```typescript
import { parsedResumeData, type ParsedResumeData } from "./schema.js"
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js"
import { callWithFallback } from "./router.js"
import { JSON_SCHEMA } from "./json-schema.js"
import { withOuterRetry } from "./retry.js"

export type ParseResumeArgs = {
  resumeText: string
  langHint?: "zh" | "en" | "mixed"
  log?: (event: string, payload?: Record<string, unknown>) => void
}
export type ParseResumeResult = {
  parsed: ParsedResumeData
  usedTier: "primary" | "secondary" | "tertiary"
  usedModel: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export async function parseResumeText(args: ParseResumeArgs): Promise<ParseResumeResult> {
  return withOuterRetry(async () => {
    const result = await callWithFallback({
      systemPrompt: SYSTEM_PROMPT + (args.langHint ? `\n\nLANG HINT: ${args.langHint}` : ""),
      userText: buildUserPrompt(args.resumeText),
      schemaName: "parsed_resume_data",
      schema: JSON_SCHEMA,
      log: args.log,
    })
    const parsed = parsedResumeData.parse(result.parsed)  // throws on schema fail
    return { ...result, parsed }
  }, { attempts: 3, baseMs: 1000, maxMs: 16000, log: args.log })
}
```

#### `packages/pa-resume-parser/src/json-schema.ts` (≤30 line sketch)
```typescript
// Pre-baked OpenAI Responses API JSON schema (camelCase) for the
// `parsed_resume_data` structured-output contract. This MIRRORS schema.ts
// but in JSON Schema form (not Zod) for the OpenAI client. Hand-maintained
// — lint test ensures the two stay aligned (covered by MS7.1 schema-parity test).
export const JSON_SCHEMA = { /* see §3 below for the full schema */ } as const
```

#### `packages/pa-resume-parser/src/qabank-to-mem0.ts` (≤30 line sketch)
```typescript
import type { Mem0Config } from "@pa/memory"
import { mem0Add, mem0Search } from "@pa/memory"
import type { InferredAnswer } from "./schema.js"

export type IntentTag =
  | "work_authorization" | "salary_expectation" | "start_date"
  | "relocation_willingness" | "relevant_experience" | "remote_preference"
  | "sponsorship_need" | "career_goals" | "other"

const PATTERN_BANK: Array<[RegExp, IntentTag]> = [
  [/(authoriz|visa|sponsor|H1B|OPT|green card|绿卡)/i, "work_authorization"],
  [/(salary|compensation|expected pay|薪资|期望工资)/i, "salary_expectation"],
  [/(start date|available|notice period|开始日期|入职)/i, "start_date"],
  [/(relocate|move|relocation|搬|搬到)/i, "relocation_willingness"],
  [/(remote|on-site|hybrid|远程)/i, "remote_preference"],
  [/(sponsor|sponsorship)/i, "sponsorship_need"],
  [/(years?\s+of\s+experience|工作年限|多少年经验)/i, "relevant_experience"],
  [/(career goal|long term|长期目标|事业目标)/i, "career_goals"],
]

export function mapQuestionToIntentTag(q: string): IntentTag {
  for (const [re, tag] of PATTERN_BANK) if (re.test(q)) return tag
  return "other"
}

export async function writeQaBankToMem0(args: {
  cfg: Mem0Config; userId: string; partitionKey: string;
  inferredAnswers: InferredAnswer[]; nowIso: () => string;
  log?: (e: string, p?: Record<string, unknown>) => void;
}): Promise<{ written: number; skipped: number }> {
  // Loop, hash dedupe via mem0Search by qa_dedupe_hash, mem0Add with metadata.
  throw new Error("not implemented in sketch")
}
```

#### `apps/functions/src/cv-ingest/cv-gate.ts` (NEW, ≤30 line sketch)
```typescript
import type { Firestore } from "firebase-admin/firestore"

export type ResumeAcceptedFlag = {
  at: string                 // ISO
  expiresAt: string          // ISO (at + GATE_TTL_MS)
  triggerHash: string        // sha256 of Claire turn that opened the gate
} | null

const PA_USERS_COLLECTION = "pa-users"

export async function readResumeGate(
  db: Firestore, userId: string
): Promise<ResumeAcceptedFlag> {
  const snap = await db.collection(PA_USERS_COLLECTION).doc(userId).get()
  const data = snap.exists ? (snap.data() ?? {}) : {}
  const flag = (data as { resumeAccepted?: ResumeAcceptedFlag }).resumeAccepted
  return flag ?? null
}

export function isGateOpen(flag: ResumeAcceptedFlag, nowIso: string): boolean {
  if (!flag || !flag.expiresAt) return false
  return new Date(flag.expiresAt).getTime() > new Date(nowIso).getTime()
}

export function gateKillSwitchOn(): boolean {
  return process.env.PA_RESUME_GATE_DISABLED === "true"
}
```

#### `apps/functions/src/cv-ingest/cv-quota.ts` (NEW, ≤30 line sketch)
```typescript
import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"

export const QUOTA_LIMIT = 2

export async function readQuotaCount(db: Firestore, userId: string): Promise<number> {
  const snap = await db.collection("pa-users").doc(userId).get()
  const v = (snap.data() ?? {}) as { resumeParseCount?: unknown }
  return typeof v.resumeParseCount === "number" ? v.resumeParseCount : 0
}

export async function incrementQuota(db: Firestore, userId: string): Promise<void> {
  await db.collection("pa-users").doc(userId).update({
    resumeParseCount: FieldValue.increment(1),
    resumeParseLastAt: new Date().toISOString(),
  })
}

export function quotaKillSwitchOn(): boolean {
  return process.env.PA_RESUME_QUOTA_DISABLED === "true"
}

export function isQuotaExhausted(count: number): boolean {
  return !quotaKillSwitchOn() && count >= QUOTA_LIMIT
}
```

#### `apps/functions/src/cv-ingest/cv-size-cap.ts` (NEW, ≤30 line sketch)
```typescript
export const MAX_PDF_BYTES = 5 * 1024 * 1024 // 5 MB
export class PdfSizeError extends Error {
  constructor(public observedBytes: number, public limit: number) {
    super(`pdf_too_large: ${observedBytes} > ${limit}`)
    this.name = "PdfSizeError"
  }
}

export async function fetchPdfWithSizeCap(
  url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  // 1. HEAD probe (some hosts ignore HEAD; treat 405 as "skip probe")
  try {
    const head = await fetchImpl(url, { method: "HEAD" })
    if (head.ok) {
      const lenRaw = head.headers.get("content-length") ?? ""
      const len = parseInt(lenRaw, 10)
      if (Number.isFinite(len) && len > MAX_PDF_BYTES) throw new PdfSizeError(len, MAX_PDF_BYTES)
    }
  } catch (err) {
    if (err instanceof PdfSizeError) throw err
    // HEAD failed but body GET may still succeed; fall through.
  }
  // 2. Bounded GET — abort if streamed body exceeds cap.
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`)
    const buf = await r.arrayBuffer()
    if (buf.byteLength > MAX_PDF_BYTES) throw new PdfSizeError(buf.byteLength, MAX_PDF_BYTES)
    return { bytes: new Uint8Array(buf), contentType: r.headers.get("content-type") ?? undefined }
  } finally { clearTimeout(t) }
}
```

#### `packages/pa-orchestrator/src/post-turn-hooks/cv-gate-detector.ts` (NEW, ≤30 line sketch)
```typescript
import type { Firestore } from "firebase-admin/firestore"
import { createHash } from "node:crypto"

const GATE_REGEX_ZH = /(发[简我][历给]我|发简历给我|把简历发给我|把你简历发我|发份简历|你可以发我简历)/
const GATE_REGEX_EN = /\b(send (me )?your (resume|cv)|share your (resume|cv)|email me your (resume|cv))\b/i
const GATE_TTL_MS = (() => {
  const env = parseInt(process.env.PA_RESUME_GATE_TTL_HOURS ?? "24", 10)
  const hours = Number.isFinite(env) && env > 0 ? env : 24
  return hours * 60 * 60 * 1000
})()

export function detectsCvAsk(assistantText: string): boolean {
  return GATE_REGEX_ZH.test(assistantText) || GATE_REGEX_EN.test(assistantText)
}

export async function maybeOpenResumeGate(args: {
  db: Firestore; userId: string; assistantText: string; nowIso: string;
}): Promise<{ opened: boolean; expiresAt?: string }> {
  if (!detectsCvAsk(args.assistantText)) return { opened: false }
  const at = args.nowIso
  const expiresAt = new Date(new Date(at).getTime() + GATE_TTL_MS).toISOString()
  const triggerHash = createHash("sha256").update(args.assistantText).digest("hex").slice(0, 16)
  await args.db.collection("pa-users").doc(args.userId).set(
    { resumeAccepted: { at, expiresAt, triggerHash } },
    { merge: true }
  )
  return { opened: true, expiresAt }
}
```

#### `packages/pa-resume-parser/src/retry.ts` (≤30 line sketch)
```typescript
const RETRYABLE_PATTERNS = [/5\d\d/, /timeout/i, /overloaded/i, /rate.?limit/i, /ECONN/, /ETIMEDOUT/]
export class NonRetryableError extends Error {}

export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE_PATTERNS.some((re) => re.test(msg))
}

export async function withOuterRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseMs: number; maxMs: number; log?: (e: string, p?: Record<string, unknown>) => void }
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < opts.attempts; i++) {
    try { return await fn() }
    catch (err) {
      lastErr = err
      if (!isRetryable(err) || i === opts.attempts - 1) throw err
      const delay = Math.min(opts.baseMs * Math.pow(4, i), opts.maxMs)
      opts.log?.("pa.cv_ingest.retry", { attempt: i + 1, delayMs: delay, error: err instanceof Error ? err.message : String(err) })
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
```

### 2.2 MODIFIED files

#### `packages/memory/src/mem0.ts` — extend `mem0Add` signature

**Functions changed**: `mem0Add` (line 278-311), inline `await client.add(...)` (line 304).

**Diff intent**:
- Add 4th param `metadata?: Record<string, string | number | boolean>` to `mem0Add`.
- When metadata present, call `client.add(messages, { userId, metadata })`.
- Keep backward-compat: existing 3-arg call sites (providers.ts:79, stacked.ts:187, cv-ingest.ts:730) work without change.
- Add optional `agentId?: string` param too — namespace orthogonal to `userId`. Default `"claire"` when not specified by caller AND when `PA_MEM0_DEFAULT_AGENT_ID=claire` env is set.
- Update `emitMem0CostEvent` extra payload to include `metadata_keys: Object.keys(metadata).join(",")` for telemetry.

#### `packages/memory/src/providers.ts` — pass through metadata

**Functions changed**: `Mem0SemanticMemoryProvider.add` (line 76-80).

**Diff intent**: Widen `add()` input shape: `{ userId, messages, metadata? }`. Forward metadata into `mem0Add`. No production caller of `providers.ts` actually uses metadata today, but the interface widens cleanly.

#### `packages/memory/src/stacked.ts` — no metadata change

**Functions touched**: `afterAssistantTurn` callsite (line 187). No metadata payload from this path (turn-level memory doesn't need qaBank-style intent tags). Leave as-is, type-compatible because new param is optional.

#### `packages/memory/src/index.ts` — export new types

Add: `export type { Mem0AddMetadata } from "./mem0.js"` if we surface a named type.

#### `apps/functions/src/cv-ingest/cv-ingest.ts` — replace `defaultLlmExtract` + add gate/quota/size hooks

**Functions changed**:
- Remove inline `CV_JSON_SCHEMA` (line 230-292) — replaced by `pa-resume-parser`'s exported schema.
- Remove `defaultLlmExtract` (line 300-348) — replaced by `import { parseResumeText } from "@pa/pa-resume-parser"`.
- Replace `defaultFetchPdf` (line 197-210) — use `fetchPdfWithSizeCap` from cv-size-cap.ts.
- Add gate-check + quota-check at top of `ingestCv()` (after input validation, before download).
- Add quota-increment after Firestore write success (line 1141 area).
- Add qaBank → Mem0 write into Stream E2 path: `runMem0Write` extends to also call `writeQaBankToMem0` after the existing fact-body write.
- Update `IngestCvDeps.llmExtract` shape to match new parser output.
- Add new `IngestCvResult` reasons: `"not_invited"`, `"quota_exhausted"`, `"pdf_too_large"`.

**Specific line targets**:
- Line 195-210 (`defaultFetchPdf`) → replace.
- Line 230-292 (`CV_JSON_SCHEMA`) → delete (move to package).
- Line 300-348 (`defaultLlmExtract`) → replace with thin wrapper around `parseResumeText`.
- Line 905-921 (entry-point validation + download) → insert gate/quota/size checks before line 909 (`// 1. Download`).
- Line 1139-1141 (Firestore write → resumeId) → insert `incrementQuota` after success.
- Line 1175-1183 (`runMem0Write` callsite) → extend to write qaBank entries too.

#### `apps/functions/src/sendblue/webhook.ts` — friendlier reject path

**Functions touched**: webhook handler (line 751-785, the `mediaUrl`-present block).

**Diff intent**: NO direct gate/quota/size check at webhook layer (per `valet-integration.md` §5.1 decision: keep webhook simple, push checks into ingestCv). The `❤️` tapback continues to fire-and-forget. Only change is the **reason-translation** for outbound: when `ingestCv` returns `{ ok: false, reason: "not_invited" | "quota_exhausted" | "pdf_too_large" }`, the existing `.then((res) => log(...))` should also enqueue a Claire-voice rejection iMessage (idempotent doc-id `out-cv-reject-{userId}-{YYYYMMDD}-{reason}` to avoid spam).

Actually — to keep webhook.ts thin, push that enqueue **inside** cv-ingest.ts (it already has `enqueueOutboundFollowup` dep wired), so webhook.ts diff is **zero LOC** beyond log-string updates.

#### `apps/job-rec/src/tools/parse-resume.ts` — delegate or delete

**Functions touched**: `parseResume` (line 135-219).

**Diff intent**: This file is a STUB (line 195-211 writes empty `candidateProfile/experiences/education`). Two options:

- **Option A**: Make it call `pa-resume-parser` and return the proper projection. Keeps the SDK-tool surface (line 230-244 `createParseResumeTool`) usable by RecruiterAgent.
- **Option B**: Delete the file entirely. Per Adam's iter22 architectural pivot ("Claire IS the recruiter — there is no separate RecruiterAgent" — quoted in `cv-ingest.ts:22-25`), `apps/job-rec/src/tools/parse-resume.ts` is dead code today. Audit callers via grep `createParseResumeTool|parseResume.*from.*tools` — if zero outside its own tests, delete.

**Recommendation**: B (delete). Less surface, clearer ownership. If grep finds callers, fall back to A.

---

## 3. Structured-output JSON schema (full schema for OpenAI Responses API)

This is the EXACT schema passed via `text.format = { type: "json_schema", name: "parsed_resume_data", schema: ..., strict: true }` to `client.responses.create()`. All fields camelCase. `strict: true` enforces `additionalProperties: false` everywhere (OpenAI structured-output requirement).

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "fullName", "email", "phone", "location", "summary",
    "skills", "workHistory", "education", "projects",
    "certifications", "languages", "interests", "awards",
    "volunteerWork", "websites", "totalYearsExperience",
    "workAuthorization", "parseConfidence", "inferredAnswers"
  ],
  "properties": {
    "fullName":         { "type": ["string", "null"] },
    "email":            { "type": ["string", "null"] },
    "phone":            { "type": ["string", "null"] },
    "location":         { "type": ["string", "null"] },
    "summary":          { "type": ["string", "null"] },
    "totalYearsExperience": { "type": ["number", "null"] },
    "workAuthorization":    { "type": ["string", "null"] },
    "parseConfidence":  { "type": "number", "minimum": 0, "maximum": 1 },
    "skills":           { "type": "array", "items": { "type": "string" } },
    "certifications":   { "type": "array", "items": { "type": "string" } },
    "languages":        { "type": "array", "items": { "type": "string" } },
    "interests":        { "type": "array", "items": { "type": "string" } },
    "websites":         { "type": "array", "items": { "type": "string" } },
    "workHistory": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "company", "location", "experienceType", "startDate", "endDate", "currentRole", "description", "bullets", "achievements"],
        "properties": {
          "title":          { "type": "string" },
          "company":        { "type": "string" },
          "location":       { "type": ["string", "null"] },
          "experienceType": { "type": ["string", "null"], "enum": ["full-time", "part-time", "contract", "internship", "freelance", "volunteer", null] },
          "startDate":      { "type": ["string", "null"] },
          "endDate":        { "type": ["string", "null"] },
          "currentRole":    { "type": ["boolean", "null"] },
          "description":    { "type": ["string", "null"] },
          "bullets":        { "type": "array", "items": { "type": "string" } },
          "achievements":   { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "education": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["school", "degree", "degreeType", "fieldOfStudy", "major", "gpa", "startDate", "endDate", "expectedGraduation", "honors"],
        "properties": {
          "school":             { "type": "string" },
          "degree":             { "type": "string" },
          "degreeType":         { "type": ["string", "null"], "enum": ["high-school", "associate", "bachelor-of-arts", "bachelor-of-science", "master-of-arts", "master-of-science", "mba", "phd", "md", "jd", "other", null] },
          "fieldOfStudy":       { "type": ["string", "null"] },
          "major":              { "type": ["string", "null"] },
          "gpa":                { "type": ["string", "null"] },
          "startDate":          { "type": ["string", "null"] },
          "endDate":            { "type": ["string", "null"] },
          "expectedGraduation": { "type": ["string", "null"] },
          "honors":             { "type": ["string", "null"] }
        }
      }
    },
    "projects": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description", "technologies", "url", "startDate", "endDate"],
        "properties": {
          "name":         { "type": "string" },
          "description":  { "type": ["string", "null"] },
          "technologies": { "type": "array", "items": { "type": "string" } },
          "url":          { "type": ["string", "null"] },
          "startDate":    { "type": ["string", "null"] },
          "endDate":      { "type": ["string", "null"] }
        }
      }
    },
    "awards": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "issuer", "date"],
        "properties": {
          "title":  { "type": "string" },
          "issuer": { "type": ["string", "null"] },
          "date":   { "type": ["string", "null"] }
        }
      }
    },
    "volunteerWork": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["organization", "role", "description", "startDate", "endDate"],
        "properties": {
          "organization": { "type": "string" },
          "role":         { "type": ["string", "null"] },
          "description":  { "type": ["string", "null"] },
          "startDate":    { "type": ["string", "null"] },
          "endDate":      { "type": ["string", "null"] }
        }
      }
    },
    "inferredAnswers": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["question", "answer", "confidence", "category"],
        "properties": {
          "question":   { "type": "string" },
          "answer":     { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "category":   { "type": "string", "enum": ["personal", "experience", "education", "skills", "preferences"] }
        }
      }
    }
  }
}
```

> **Implementation footnote**: OpenAI strict mode requires `required` to list **every** property in `properties` (even those typed `["string", "null"]`). The schema above does this. The model emits `null` for missing fields — that's the contract.

---

## 4. Retry policy state machine

### 4.1 Three retry layers (text diagram)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer C: OUTER RETRY (parser.ts → withOuterRetry)                  │
│   attempts=3, backoff=[1s, 4s, 16s] (Fibonacci-ish)                │
│   condition: only retryable errors (5xx/timeout/rate/overloaded)   │
└──────────┬──────────────────────────────────────────────────────────┘
           │ each outer attempt invokes:
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Layer B: TIER FALLBACK (router.ts → callWithFallback)              │
│   chain: gpt-5.4-nano → gpt-4.1-mini → gpt-4.1-nano                │
│   on retryable error → next tier                                    │
│   on non-retryable (4xx/parse/schema) → throw NonRetryableError    │
└──────────┬──────────────────────────────────────────────────────────┘
           │ each tier-call invokes:
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Layer A: SDK RETRY (OpenAI SDK built-in)                           │
│   maxRetries: 2 for tier 1+2, 1 for tier 3                         │
│   handles transient network + 429 + 5xx with jittered backoff      │
└─────────────────────────────────────────────────────────────────────┘

WORST-CASE attempts: 3 outer × 3 tier × (2|2|1) SDK = up to 21 LLM calls
TYPICAL: 1 outer × 1 tier × 1 SDK = 1 LLM call (90% of the time)
```

### 4.2 Decision tree on each error class

| Error class | SDK retry? | Tier fallback? | Outer retry? | Final reason |
|---|---|---|---|---|
| Network timeout (ETIMEDOUT, AbortError) | yes (max 2) | yes | yes | `llm_parse_failed` |
| HTTP 429 (rate limit) | yes (SDK auto-backoff) | yes (different model = different bucket) | yes | `llm_rate_limited` |
| HTTP 500/502/503 | yes (max 2) | yes | yes | `llm_5xx` |
| HTTP 529 ("overloaded") | yes (max 2) | yes | yes | `llm_overloaded` |
| HTTP 401 (auth) | no | no | no | `llm_auth_failed` (PA admin alert) |
| HTTP 400 (schema-violation from API side) | no | no | no | `llm_bad_request` |
| OpenAI strict-schema violation (non-conformant JSON) | no | no | no | `llm_schema_violation` |
| Zod parse failure on returned JSON | no | yes (next tier may produce conforming JSON) | no | `llm_zod_failed` |
| Empty `output_text` | no | yes | no | `llm_empty` |
| `missing_api_key` (no env) | no | no | no | `config_error` |

> **Idempotency** (per `valet-integration.md` §5.4): outer retry doesn't double-charge if the FIRST attempt succeeded; the retry only fires on thrown errors. PDF bytes-hash dedupe lives at a different layer (cv-ingest.ts: `bytesHash` field on `parsedCandidateResumes` — query before parse to skip if already parsed). MS6 implements bytesHash check.

### 4.3 Error → Mem0 / metric mapping

Every layer logs a structured event:
- `pa.cv_ingest.retry` (Layer C)
- `pa.cv_ingest.tier_fallback` (Layer B)
- `pa.cv_ingest.sdk_retry` (Layer A — derive from SDK debug logs if needed; OpenAI SDK doesn't surface this directly)
- `pa.cv_ingest.cost` per successful tier (model name attribute lets us see which tier delivered)

---

## 5. Gate + quota state machine

### 5.1 Gate set/clear/expire

**Gate state**: `pa-users/{userId}.resumeAccepted: { at, expiresAt, triggerHash } | null`.

**Set point** (`packages/pa-orchestrator/src/post-turn-hooks/cv-gate-detector.ts`):
- **WHEN**: After Claire's reply is generated, in the post-turn hook chain.
- **TRIGGER**: assistant text matches `GATE_REGEX_ZH | GATE_REGEX_EN`.
- **WRITE**: Firestore `set({ resumeAccepted: { at: now, expiresAt: now + 24h, triggerHash } }, { merge: true })`.
- **IDEMPOTENT**: latest write wins (extending the window if Claire re-asks).

**Regex bank** (final, bilingual):

```
zh:
  /(发[简我][历给]我|发简历给我|把简历发给我|把你简历发我|发份简历|你可以发我简历)/
  /(把你的简历发[给]?我)/
  /(简历发[给]?我看[一下]?)/
  /(把简历[甩贴]给我)/

en:
  /\b(send (me )?your (resume|cv))\b/i
  /\b(share (your )?(resume|cv))\b/i
  /\b(email (me )?your (resume|cv))\b/i
  /\b(can you send (your |me )?(resume|cv))\b/i
  /\b(drop (me )?your (resume|cv))\b/i
```

**Mixed-language catch**: Adam directives often code-switch ("send me your 简历"). Both banks run; either match opens the gate.

**Negation guards** (per `valet-integration.md` §7 risk #2): conservative — no negation handling. If Claire says "你不用发我简历" (literal: "you don't need to send me your resume"), it'd still match `发我简历`. **Mitigation**: triggerHash gives audit trail; iter23-style 10-turn scenario verification with deliberate bait phrases catches false-positives.

**Clear point**: Never explicitly cleared. Gate naturally expires via `expiresAt < now`. Adam can manually clear via Firestore Console for tests.

**Expire**: Read-time check `isGateOpen(flag, nowIso)` returns false when `expiresAt` < now. No active sweeper needed.

### 5.2 Race conditions

**Race A — user sends PDF before Claire's "send me" reaches them** (PDF arrives within 1-2s of Claire's reply):

- Sendblue webhook fires `ingestCv` immediately (line 751-785 of webhook.ts).
- Post-turn hook ALSO fires (in pa-orchestrator path) and writes `resumeAccepted`.
- Two writes race. Possible outcomes:
  - (a) Hook writes first → ingestCv reads gate-open → proceeds. ✓
  - (b) ingestCv reads first → no gate → returns `not_invited`. ✗

**Mitigation**:
1. **Tolerance window**: read gate with a 5s tolerance backward — if `pa-users/{userId}.lastAssistantTurnAt` is within last 5s AND that turn matches gate-regex, treat as gate-open. Requires new field `lastAssistantTurnAt` written by orchestrator (cheap, single-doc-write per turn — already present in turn-state writers).
2. **Transactional read**: at ingestCv entry, do `db.runTransaction` to read gate + read latest assistant turn + decide. Higher-cost but solid.
3. **Pragmatic compromise** (recommended): pre-read `pa-users/{userId}` once. If `resumeAccepted` is null AND user has at least 1 prior orchestrator turn AND that turn was within 5s, **enqueue ingest with 3s delay** (re-read after delay; gate hook should have written by then). One-line change: `setTimeout(() => continueIngest(...), 3000)`.

> [PUA生效 🔥] 这种"近期问过简历"的 grace 窗口看起来 5s 像 over-engineering — 但 webhook 是 fire-and-forget (cv-ingest.ts:558 `runFindingsFollowup` 也是 ~10ms 内启动)，post-turn hook 写 Firestore 平均 30-80ms，**race 是真实的**。3s 延迟 + race 处理 vs 偶尔友好拒收一份合法上传，**用户体验**前者 dominant。MS2.2 必须实现 grace 窗口。

**Race B — concurrent uploads (2 PDFs back-to-back)**:
- Both pass gate-check (gate is open).
- Both pass quota-check (both read `count=1`).
- Both increment to `count=2`. Hard-cap not violated.
- Edge: if user already at 1, both go through, leaving count=3. Acceptable shadow per Adam (risk #3 in valet-integration.md).

### 5.3 Quota counter atomic write contract

```typescript
// pa-users/{userId} field: resumeParseCount: number (FieldValue.increment(1))
//
// READ: at top of ingestCv after gate check.
// WRITE: AFTER successful Firestore write to parsedCandidateResumes (line 1141 area).
//
// Race against concurrent uploads: FieldValue.increment is server-side atomic
// (no read-modify-write). Two concurrent ingests both read count=1, both
// write increment(1) → final count=3 (off-by-one shadow). Acceptable.
//
// Strict mode (if shadow becomes a problem): wrap in transaction:
//   db.runTransaction(async (tx) => {
//     const snap = await tx.get(userRef)
//     const count = snap.data()?.resumeParseCount ?? 0
//     if (count >= QUOTA_LIMIT) throw new Error("quota_exhausted")
//     tx.update(userRef, { resumeParseCount: count + 1 })
//   })
// Stricter but slower. Default to FieldValue.increment for v1.
```

### 5.4 Three rejection texts (final, Claire-voice)

```
not_invited:
  zh: "我还没问你要简历呢，先聊聊呗～你想找啥方向?"
  en: "haven't asked for your resume yet — wanna chat first about what you're looking for?"

quota_exhausted (3rd attempt):
  zh: "我已经看过你两份简历了😅 这次咱们口头聊聊吧 — 现在卡在哪个环节?"
  en: "I've read two of your resumes already 😅 let's just talk this time — where are you stuck?"

pdf_too_large (>5MB):
  zh: "诶，你这简历是不是图片版的? 文件太大了 (>5MB)，发个文字版 PDF 给我看看~"
  en: "is your resume an image PDF? too big to read (>5MB) — can you send a text-based one?"
```

All three enqueued via `enqueueOutboundFollowup` with idempotent `out-cv-reject-{userId}-{YYYYMMDD}-{reason}` doc-id (per-user-per-day-per-reason cap to avoid spam if user mass-uploads).

---

## 6. mem0Add signature extension plan

### 6.1 Current state (line 278-311 of `packages/memory/src/mem0.ts`)

```typescript
export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string
): Promise<void> {
  const scrub = scrubCrisisFromMessages(messages)
  if (scrub.skip) { /* log + return */ }
  const client = await getClient(config)
  await client.add(messages, { userId })   // ← line 304: NO METADATA PASSED
  emitMem0CostEvent("add", config, userId, { messageCount: messages.length })
}
```

### 6.2 New signature

```typescript
export type Mem0AddMetadata = {
  /** orthogonal partition (e.g. "claire", "recruiter"). Default "claire". */
  agentId?: string
  /** arbitrary string|number|bool fields persisted in Qdrant payload */
  fields?: Record<string, string | number | boolean>
}

export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string,
  options?: { metadata?: Mem0AddMetadata }   // ← NEW (optional)
): Promise<void> {
  // ...crisis scrub unchanged...
  const client = await getClient(config)
  const addOpts: Record<string, unknown> = { userId }
  if (options?.metadata?.agentId) addOpts.agentId = options.metadata.agentId
  else if (process.env.PA_MEM0_DEFAULT_AGENT_ID) addOpts.agentId = process.env.PA_MEM0_DEFAULT_AGENT_ID
  if (options?.metadata?.fields && Object.keys(options.metadata.fields).length > 0) {
    addOpts.metadata = options.metadata.fields
  }
  await client.add(messages, addOpts)
  emitMem0CostEvent("add", config, userId, {
    messageCount: messages.length,
    metadataKeys: Object.keys(options?.metadata?.fields ?? {}).join(",") || undefined,
  })
}
```

**Backward-compat**: existing 3-arg callers compile unchanged. New 4th arg is `options?: { metadata?: ... }` — additive.

### 6.3 Existing call sites (must verify all compile)

```
packages/memory/src/providers.ts:79     await mem0Add(config, input.messages, input.userId)
packages/memory/src/stacked.ts:187      await d.mem0Add(mem, [...], partitionKey)
apps/functions/src/cv-ingest/cv-ingest.ts:730  await memMod.mem0Add(cfg, [...], partitionKey)
                                                      ↑ this is dynamic-imported via `@pa/memory`,
                                                        so the type-cast lives in cv-ingest.ts
                                                        (line 696-702). MS5.1 also updates that
                                                        local cast to allow the optional 4th arg.
packages/memory/src/mem0.test.ts                test mocks (multiple lines)
packages/memory/src/stacked.test.ts             test mocks
apps/functions/src/cv-ingest/__tests__/cv-ingest.test.ts  mock signature
apps/functions/src/cv-ingest/__tests__/cv-overwrite.test.ts mock signature
apps/functions/src/__tests__/chaos.test.ts      mock signature
```

All call sites verified by grep `mem0Add(` in both `packages/` and `apps/`.

### 6.4 Metadata round-trip verification (MS5.2)

**Test**: `packages/memory/src/__tests__/mem0-metadata-roundtrip.test.ts`

```typescript
// Steps:
// 1. Init real Memory client against test Qdrant collection (qdrant-test).
// 2. Call mem0Add with messages + metadata { fields: { qaIntentTag: "salary_expectation" } }.
// 3. Wait briefly for Qdrant indexing.
// 4. Use FetchQdrantClient (already in packages/memory/src/qdrant-fetch.ts) to:
//      GET /collections/qdrant-test/points/{point_id}
//    OR use `client.search` with high topK and inspect raw payload.
// 5. Assert payload contains the metadata field.
//
// If the round-trip FAILS (mem0ai/oss SDK swallows metadata):
//   FALLBACK A: encode metadata in message content:
//     content: "[qa_intent_tag=salary_expectation] Q: ...\nA: ..."
//     The fact-extractor will preserve text-encoded prefix; downstream
//     consumers regex-parse the prefix back out.
//   FALLBACK B: PR upstream fork of mem0ai/oss to plumb metadata through.
//     Tracked under V1.5-ROLLOUT.md backlog #25-equivalent.
//
// Verification script (standalone, outside test runner — for Adam audit):
//   tools/verify-mem0-metadata.mjs
//     Runs in 3 modes:
//       --add userId="test-001" tag="probe-tag" -> writes 1 entry
//       --search userId="test-001"               -> reads back, prints metadata
//       --raw   pointId="..."                    -> Qdrant direct GET
//   Exit code: 0 on metadata present, non-zero on missing.
```

Standalone CLI verification script lives at: `packages/memory/tools/verify-metadata-roundtrip.mjs` (~50 lines, MS5.2 deliverable).

---

## 7. qaBank → Mem0 mapping

### 7.1 Pattern bank (regex → intentTag)

Defined in `packages/pa-resume-parser/src/qabank-to-mem0.ts` (sketch in §2.1 above). 9 categories total:

| intentTag | Patterns (zh + en) |
|---|---|
| `work_authorization` | `/(authoriz\|visa\|sponsor\|H1B\|OPT\|green card\|绿卡\|工作授权)/i` |
| `salary_expectation` | `/(salary\|compensation\|expected pay\|薪资\|期望工资\|薪水)/i` |
| `start_date` | `/(start date\|available\|notice period\|开始日期\|入职\|什么时候开始)/i` |
| `relocation_willingness` | `/(relocate\|move\|relocation\|搬\|搬到\|搬家)/i` |
| `relevant_experience` | `/(years?\s+of\s+experience\|工作年限\|多少年经验\|工作几年)/i` |
| `remote_preference` | `/(remote\|on-site\|hybrid\|远程\|线上线下)/i` |
| `sponsorship_need` | `/(sponsor\|sponsorship\|需要担保)/i` |
| `career_goals` | `/(career goal\|long term\|长期目标\|事业目标\|未来规划)/i` |
| `other` | (catch-all) |

Order matters: visa-keywords get caught by `work_authorization` BEFORE the catch-all "experience" regex matches "OPT experience".

### 7.2 Dedupe key — `sha256(userId::question)`

```typescript
import { createHash } from "node:crypto"
function memHash(userId: string, question: string): string {
  return createHash("sha256").update(`${userId}::${question.trim().toLowerCase()}`).digest("hex").slice(0, 16)
}
```

**Why 16-char prefix**: 2^64 collision space. With 10k users × 9 questions = 90k hashes, birthday-attack probability is ~10^-12. Sufficient.

**Why include `userId`**: Two users uploading similar resumes generate identical question text but distinct hashes. Important for partition isolation — Mem0 partition is `mem0UserId` (not `userId`), but our dedupe key uses `userId` (canonical). Two devices for same user → same `userId` → same hash → dedupe correctly.

**Two-stage dedupe**:
1. **Pre-write search**: `mem0Search(query=question, userId=partitionKey, topK=3)`. If any returned memory has metadata `qaDedupeHash === memHash`, **skip** (1 fewer LLM extraction call).
2. **mem0ai/oss internal**: `Memory.add` runs a fact-extraction LLM that semantically dedupes. Belt+suspenders.

### 7.3 Mem0 metadata fields written

Per inferred answer:
```typescript
metadata: {
  fields: {
    source: "resume_inferred",          // origin tag
    qaCategory: "experience",           // VALET-style category
    qaIntentTag: "salary_expectation",  // mapped via §7.1
    qaConfidence: 0.85,                 // LLM-self-rated
    qaDedupeHash: "abcd1234...",        // 16-char prefix
    ingestedAt: "2026-05-03T12:34:56Z",
    resumeId: "...",                    // pointer back to parsedCandidateResumes
  },
  agentId: "claire",
}
```

### 7.4 Collision risk

**Same question text from two different resumes**: hash uses `userId::question` → distinct hashes → no collision. ✓

**Same question text from same user re-uploaded** (e.g. user uploads CV v1, then v2 with same WA inferred): hashes identical → first attempt's pre-search hit → skipped. mem0ai/oss internal extractor would also dedupe. ✓

**Edge**: question text varies slightly ("years of experience" vs "Years of Experience"): `.trim().toLowerCase()` normalization handles case + whitespace. Punctuation differences ("?" vs no punct) — accept low-rate write-amp (1 extra mem0 entry).

---

## 8. Test plan

### 8.1 Unit tests

**Per gate path** (`apps/functions/src/cv-ingest/__tests__/cv-gate.test.ts`):
- `gate.notSet → returns { ok: false, reason: "not_invited" }`
- `gate.expired → returns { ok: false, reason: "not_invited" }`
- `gate.open → proceeds`
- `gate.killSwitchOn → proceeds even when not set`
- `gate.regexZh.match → opens gate with 24h TTL`
- `gate.regexEn.match → opens gate with 24h TTL`
- `gate.regexNegation → currently matches (false-positive expected) — document behavior`
- `gate.graceWindow.recentTurn → proceeds even with null gate`
- `gate.graceWindow.staleTurn → still rejects`

**Per quota path** (`__tests__/cv-quota.test.ts`):
- `quota.zero → proceeds, increments to 1`
- `quota.one → proceeds, increments to 2`
- `quota.two → returns { ok: false, reason: "quota_exhausted" }`
- `quota.killSwitchOn → bypasses cap`
- `quota.concurrentRace → both increment, count ends at 3 (acceptable)`

**Per size-cap path** (`__tests__/cv-size-cap.test.ts`):
- `size.headLargerThanCap → throws PdfSizeError, never GETs`
- `size.headOk.bodyLarger → throws PdfSizeError mid-stream`
- `size.headOk.bodyOk → returns bytes`
- `size.head.405 → falls through to bounded GET (some servers don't HEAD)`
- `size.head.timeout → falls through to bounded GET`
- `size.boundedGet.timeout → throws AbortError`

**Per retry path** (`packages/pa-resume-parser/src/__tests__/retry.test.ts` + `router.test.ts`):
- `retry.outerSucceedsFirstTry → 1 call total`
- `retry.outer.5xxThenOk → retries, total 2 calls`
- `retry.outer.4xxImmediate → throws NonRetryableError, no retry`
- `retry.outer.allFail → throws after 3 attempts`
- `router.tier1.5xx → falls to tier 2`
- `router.tier1.tier2.5xx → falls to tier 3`
- `router.tier3.5xx → throws`
- `router.zodFail → falls to next tier (different model may produce conformant)`
- `router.4xxAuth → throws NonRetryable, no fallback`

**Per qaBank path** (`packages/pa-resume-parser/src/__tests__/qabank-to-mem0.test.ts`):
- `mapQuestionToIntentTag.visa → work_authorization`
- `mapQuestionToIntentTag.salary → salary_expectation`
- `mapQuestionToIntentTag.unknown → other`
- `mapQuestionToIntentTag.zhVisa → work_authorization` (i.e. `工作授权`)
- `writeQaBankToMem0.dedupeHit → no add called`
- `writeQaBankToMem0.allNew → 9 adds called`
- `writeQaBankToMem0.partialDedupe → 5 adds called` (mix of new + existing)
- `writeQaBankToMem0.metadataPayloadShape → exact field match`

**Per mem0Add signature** (`packages/memory/src/__tests__/mem0-extended.test.ts`):
- `mem0Add.legacy3Args → no metadata, agentId not set` (backward-compat)
- `mem0Add.with4thArg → metadata + agentId forwarded to client.add`
- `mem0Add.envDefaultAgentId → applied when caller doesn't override`
- `mem0Add.crisisScrub → still skips (regression protection)`

**Per parser orchestration** (`packages/pa-resume-parser/src/__tests__/parser.test.ts`):
- `parseResumeText.minimalText → returns parsed with mostly-null fields, parseConfidence < 0.5`
- `parseResumeText.denseText → all fields populated, confidence ≥ 0.7`
- `parseResumeText.zhText → inferredAnswers in zh`
- `parseResumeText.langHintEn → inferredAnswers in en even for mixed`
- `parseResumeText.routerThrows → outer retry kicks in`

**Total unit-test count**: ~45 tests across 6 test files. Branch coverage of 4-limit + retry matrix.

### 8.2 Integration test — end-to-end PDF flow

`tests/integration/resume-parse-e2e.test.ts`:
1. Spin up mock Sendblue webhook receiver.
2. POST a real PDF fixture URL to webhook.
3. Stub orchestrator post-turn hook — pre-set `pa-users/{userId}.resumeAccepted` to gate-open.
4. Wait for `parsedCandidateResumes/{id}` write.
5. Assert `parseConfidence ≥ 0.5`, `inferredAnswers.length ≥ 7`, `workHistory[0].bullets.length ≥ 1`.
6. Wait for Mem0 write completion.
7. Direct Qdrant GET of recent points → assert metadata fields present.
8. Assert quota counter incremented.

### 8.3 Schema validation eval

`tests/eval/resume-schema-eval.ts`:
- Run `parseResumeText` against 10 PDF fixtures.
- Each result MUST `parsedResumeData.parse(...)` (Zod) without error.
- Pass rate ≥ 95% (so ≤1 flake out of 20 if rerun).
- Log per-fixture: `parseConfidence`, `usedTier`, `usage.input_tokens`, `usage.output_tokens`.

### 8.4 PDF fixtures (10 set)

Stored at `tests/fixtures/resumes/` (LFS or compressed):

1. `resume_minimal_1page.pdf` — 200 lines, plain text, junior dev. Sanity check.
2. `resume_dense_design_studio.pdf` — 2-3MB, custom typography, multi-column. Tests pdf-parse fidelity on layout-heavy.
3. `resume_image_heavy_5MB.pdf` — at the size cap. Should still parse text where present.
4. `resume_image_only_oversized.pdf` — >5MB image-only PDF. Should reject at size cap.
5. `resume_zh_chinese.pdf` — Chinese resume. Tests `inferredAnswers` in zh.
6. `resume_en_traditional.pdf` — standard SF tech resume.
7. `resume_mixed_zh_en.pdf` — bilingual hybrid (common for HK/SG/SF Asians).
8. `resume_grad_student.pdf` — academic-leaning, projects + papers + GPA.
9. `resume_career_pivot.pdf` — non-linear history with gaps. Tests `totalYearsExperience` heuristic.
10. `resume_h1b_visa.pdf` — explicitly mentions OPT/H1B. Tests `workAuthorization` field + `sponsorship_need` intent tag.

Naming convention matches Adam's brief.

---

## 9. Migration strategy

### 9.1 Existing live users

**Inventory**: per `06cc2001` recent commit ("scrape pipeline report — Firestore stale 23 days"), Firestore `parsedCandidateResumes` has ~44 docs (per `cv-ingest.ts:11` comment). All written in v1 schema (7 fields).

**Migration paths**:
1. **No-op for read**: pa-orchestrator's `cv-context-injection.ts` (line 53-83) reads `candidateProfile.name`, `experiences[0]`, `education`, `industryTags` — all of which exist in v1 schema. v2-only fields (`bullets`, `inferredAnswers`, `workAuthorization`) are absent → renderCvBlock degrades gracefully (line 132-139 `hasAnyContent` check).
2. **Re-parse on demand**: a job-rec daily-batch hook re-parses any resume older than 30 days when a job match needs `workAuthorization` (e.g. visa filtering). Defer to **iter31**, not iter30.
3. **Bulk re-parse via Batch API** (one-shot): take the 44 docs' `mediaUrl` field (still hosted on Sendblue's CDN per current schema), submit to OpenAI Batch API at 50% off, get results in <24h, write back as `experiencesV2`/`workAuthorization`/`inferredAnswers` fields on existing docs. **Defer to iter31** — it's a backfill, not an MVP feature.

**Iter30 commitment**: New parses use v2 schema. Existing docs keep v1 shape. pa-orchestrator handles the gap.

### 9.2 Existing `pa-candidate-resumes/{userId}` schema

**Note**: There are **two collections**:
- `parsedCandidateResumes/{auto-id}` — used by cv-ingest.ts (line 176, multi-doc per user supported).
- `pa-candidate-resumes/{userId}` — referenced in §4 of discussion.md (`pa-candidate-resumes/{userId}`).

The latter is NOT the cv-ingest write target. Audit needed (MS6.0 sub-task) to confirm no shadow collection. Likely just a discussion.md naming inconsistency — **no migration needed if confirmed**.

### 9.3 Schema migration script (if needed)

**Decision**: NO migration script in iter30. v1 docs coexist with v2 docs. cv-context-injection reads with optional-chaining defaults.

If iter31 decides to backfill, the script lives at `apps/functions/scripts/backfill-resumes-v2.mjs`:
1. Query all v1 docs where `inferredAnswers === undefined`.
2. For each, fetch the original `mediaUrl` (still hosted by Sendblue if <24h old; otherwise skip).
3. Submit to Batch API: 1 batch of N requests.
4. Merge results back: write `inferredAnswers`, `workAuthorization`, `parseConfidence` fields onto existing doc (`{ merge: true }`). Don't overwrite `experiences` (v1 structure differs from v2 `workHistory`).

### 9.4 Rollback plan: `paResumeParserV2` feature flag

**Flag**: `paResumeParserV2` in pa-persistence flag system. Default OFF.

**Behavior**:
- ON: cv-ingest invokes `pa-resume-parser` (3-tier, structured-output, retry chain).
- OFF: cv-ingest invokes `defaultLlmExtract` (legacy single-shot nano).

**Read point**: top of `ingestCv()`, after gate/quota check. Lookup via existing `getFlag(db, "paResumeParserV2", { userId }, false)`.

**Per-user ramping**:
1. Day 1: flag forced ON for `userId === "test-001"` (test harness).
2. Day 2-3: ON for Adam's 3-5 internal-test phones.
3. Week 1: 10% bucket via flag's percentage targeting.
4. Week 2: 50%.
5. Week 3: 100% → delete the dual-path code in iter31.

**Rollback**: if quality drops, set flag to OFF in Firestore Console. Live revert in <30s, no deploy.

**Co-existence with H3 overwrite UX**: H3's `paCvOverwritePromptEnabled` flag is independent. Both can be ON simultaneously. Order of operations in cv-ingest.ts:
1. Gate check (kill-switch + Firestore read)
2. Size cap (HEAD-then-bounded-GET)
3. Download bytes
4. Parse PDF text
5. **`paResumeParserV2` flag** → choose v1 or v2 LLM path
6. Quota check
7. H3 flag → stage-or-direct-write
8. Stream E (followup + Mem0 + qaBank-to-Mem0)

---

## 10. Risks specific to WS1

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **gpt-5.4-nano structured-output schema-violation rate** under VALET-sized prompt (longer + more fields) — nano is smaller, may hallucinate `additionalProperties: false` violations more often than mini/sonnet | Medium-high | Medium | MS7.3 schema-eval gates ≥95% pass. If <95%, default tier shifts to `gpt-4.1-mini` (~3× cost but still <5× of Sonnet). Adam's lock is "no Sonnet" — `gpt-4.1-mini` is in scope. |
| 2 | **gate regex misfires on Claire's natural phrasing** (e.g. "送你份模板" in Chinese could match "发我简历" indirectly) | Medium | Low-medium | iter23-style 10-turn scenario verification. Audit-trail `triggerHash` lets us back-test. Open Q §11.2: tighten TTL to 12h if false-positives bite. |
| 3 | **mem0ai/oss SDK swallows `metadata` parameter** (depends on version pinned) | High | High | MS5.2 round-trip test FIRST (gates the rest). If positive: proceed. If negative: fork or text-prefix encode (described §6.4 fallback). |
| 4 | **OpenAI strict-schema requires ALL properties in `required`** — 19 top-level + nested = ~50 required fields. nano may struggle with the cognitive load of "every field must be present, even null" | Medium | Medium | Prompt engineering: explicit "for missing fields, return null" instruction. Schema validation eval (MS7.3) measures it. Fallback: relax `strict: true` for nano tier only, keep strict on mini+. |
| 5 | **PDF.js bundle size in Cloud Functions** — `pdf-parse` is already in production at 1.1.1 (line 219 cv-ingest.ts: inner-path import workaround). No change to it expected, but if upgrade tempts, it has been a wedge before | Low | High | DON'T upgrade. MS0 explicitly pins `pdf-parse@1.1.1` in pa-resume-parser package.json. Predeploy smoke loads pdf-parse + parses 5-line fixture. |
| 6 | **Quota race** producing count=3 when 2 PDFs sent in 50ms | Low | Low | Document as known shadow. Strict mode (transaction) deferred unless Adam observes it. |
| 7 | **Sendblue mediaUrl expiry mid-retry** — outer retry attempt 2 (after 1s) runs another PDF download. If Sendblue URL is signed with <60s validity, attempt 2 may 403 | Low | Medium | Cache PDF bytes on first successful download (in-memory of the parse function). Subsequent retries reuse cached bytes — no re-download. Already partially solved: only the LLM call retries, not the download (download is BEFORE the parser). Verify MS4.2 retry scope. |
| 8 | **24h gate window vs Adam's actual ride-or-die cadence** — Claire is conversationally ride-or-die (replies fast); 24h may be too long if user comes back Day-2 with a stale ask | Low | Low | `PA_RESUME_GATE_TTL_HOURS` env (default 24, configurable). iter23-style 6-turn scenario with gap-time injection. Open Q §11.2. |
| 9 | **inferredAnswers field-count consistency across LLM tiers** — nano may emit 7, mini 9, nano-fallback 5. Downstream consumers expect a stable shape | Medium | Low | Prompt explicitly "produce 7-9 entries". Schema enforces array but not count. Document downstream-side as best-effort field. qaBank → Mem0 simply writes whatever entries arrive. |
| 10 | **PDF-byte hash collisions across different users** — two users uploading the same recipe-template resume (e.g. CSU CS new-grad standard) → same `bytesHash` → cross-user dedupe nightmare | Low | Medium | bytesHash dedupe scoped to (`userId`, `bytesHash`) tuple, NOT global. Two users with same bytes → distinct (userId, bytesHash) keys → both parse independently. |
| 11 | **Cost telemetry blind spot for Batch API** — `pa.cv_ingest.cost` log doesn't currently know about Batch 50%-off. Cost dashboard would over-report | Low | Low | Defer (Batch API not in iter30 main path per §0 Q4). When iter31 lands Batch backfill, extend cost-logger. |

---

## 11. Open questions for Adam / P10

### 11.1 Sonnet 4.6 as 4th-tier fallback?
> "Sonnet 4.5 ruled out (cost). What about Anthropic Claude **Sonnet 4.6** as 4th-tier fallback for hard PDFs (when 3rd retry triggered)?"

**Context**: Adam's lock is `gpt-5.4-nano → gpt-4.1-mini → gpt-4.1-nano`. If all 3 OpenAI tiers fail (e.g. OpenAI 5xx storm or strict-schema violations all 3 emit), we have nothing but to fail. 4th tier (Anthropic) costs ~$0.015 per parse, but only fires <0.1% of the time → ~$0.001/CV expected cost.

**Recommendation**: Add as **opt-in via env** (`PA_RESUME_PARSER_TIER4_ANTHROPIC=true`). Default OFF for v1. Adam can flip later.

### 11.2 Gate TTL — 24h or shorter?
> Per `valet-integration.md` risk #7: "24h gate TTL is wrong number?" Claire's ride-or-die UX feels mismatched with 24h.

**Options**:
- 12h: tighter. Adam ride-or-die cadence is sub-hour usually.
- 24h: roommate-style (asked at lunch, returned at dinner with PDF).
- 48h: weekend tolerance.

**Recommendation**: **12h** as default, configurable via env. Iter23-scenario test at 12h to validate "user 8h gap returns with PDF" works.

### 11.3 Quota reset policy
> "Quota = 2 lifetime. Reset never? annual? per major-life-event (job change)?"

**Implications**:
- Never (lifetime): clean. Easy to audit. Cap is a behavioral nudge ("Claire has your CV; stop re-uploading"). Adam can manually reset via Firestore for power-users.
- Annual: rolls users back into the quota pool yearly. Auto-cleared via cron.
- Per-event: complicated; needs an explicit "I have a new role" signal.

**Recommendation**: **lifetime + manual override**. iter31 can revisit if cohort signals demand reset.

### 11.4 Batch API — synchronous fallback if Batch latency > X minutes?
> Adam decision: "OpenAI Batch API for cv-ingest". But Batch's SLA is 24h; cv-ingest's user-facing follow-up DM loses meaning at 24h.

**Recommendation** (per §0 Q4): use Batch ONLY for offline backfill (iter31). Iter30 cv-ingest stays on synchronous Responses API. Adam confirm.

### 11.5 `pa-candidate-resumes/{userId}` vs `parsedCandidateResumes/{auto-id}`
> Discussion §4 references `pa-candidate-resumes/{userId}` but cv-ingest writes to `parsedCandidateResumes/{auto-id}`. Confirm only `parsedCandidateResumes` exists, not a shadow per-user-keyed collection.

### 11.6 mem0 `agentId` partition support in current SDK version
> Verification needed before MS5.2: does the pinned mem0ai/oss version support `agentId` as a parameter to `client.add()`? If not, fall back to encoding agentId in metadata fields.

---

## 12. Calendar plan (8-11 dev-days, single engineer)

> [🟠 阿里味] **闭环颗粒度**: 每天结束前必须回答"今天 PR 能 deploy 吗?" 不能 deploy = 这天没闭环。critical-path 标 `★`。

| Day | Morning | Afternoon | Critical-path |
|---|---|---|---|
| **D1** | MS0: `pa-resume-parser` package scaffold + tsconfig + test runner | MS5.1: extend `mem0Add` signature + update all 8 callers. Type-check green. | ★ MS5.1 |
| **D2** | MS5.2: metadata round-trip integration test. Standalone CLI verification script. | MS1.1: schema.ts (Zod) + json-schema.ts (OpenAI) + parity test. | ★ MS5.2 |
| **D3** | MS1.2: prompt.ts + lang-hint plumbing | MS1.3: router.ts (3-tier fallback) + provider/openai-responses.ts + unit tests on tier transitions | ★ MS1.3 |
| **D4** | MS1.4: parser.ts orchestrator + retry.ts + unit tests | MS4.2: outer retry wrapper hardening + retryable-error matrix tests | ★ MS1.4 |
| **D5** | MS4.1: cv-size-cap.ts (HEAD-then-bounded-GET) + unit tests | MS2.1: pa-orchestrator post-turn hook (cv-gate-detector) + regex bank | |
| **D6** | MS2.2: cv-gate.ts (read at ingest entry) + grace window (3s + recent-turn check) + unit tests | MS2.3: rejection text + idempotent outbound enqueue | ★ MS2.x complete |
| **D7** | MS3.1: cv-quota.ts (`FieldValue.increment`) + 3rd-attempt rejection + unit tests | MS5.3: qabank-to-mem0.ts (regex bank + dedupe + write loop) + unit tests | |
| **D8** | MS6.1: cv-ingest.ts swap — replace `defaultLlmExtract`, wire gate/quota/size, wire qaBank-to-Mem0 in Stream E2 | MS6.2: cleanup `apps/job-rec/src/tools/parse-resume.ts` (delete or delegate) | ★ MS6.x ship-able |
| **D9** | MS7.1: unit-test gaps (final 10 tests for branch coverage) | MS7.2: integration e2e with real PDF fixture set (10 fixtures, ≥95% pass) | ★ MS7.x ship-gate |
| **D10** | MS7.3: schema-validation eval. MS8: feature flag wiring. V1.5-ROLLOUT.md addendum. | **Deploy** to dev. Run iter23-style 10-turn scenario with bait phrases. Verify gate+quota+size+retry+qaBank end-to-end via real iMessage. | ★ DEPLOY |
| **D11 (buffer)** | Code-review fixes. H3 + v2 interaction edge-cases. Long-context drift check. | Adam-driven scenario verification. Flip `paResumeParserV2` to 10% bucket. | (10% rollout) |

**Critical path** (cannot parallelize): MS5.1 → MS1.x → MS6.1 → MS7.x → DEPLOY.

**Parallelizable side-tracks** (engineer can context-switch when waiting):
- MS2.x gate work (D5-D6) parallel to MS1.4
- MS4.1 size cap (D5) parallel to MS2.x
- MS3.1 quota (D7) sequential with size cap

> [PUA生效 🔥] D10 是 PUA 关键日。CLAUDE.md iter23 directive: "你需要做测试，每个 playbook 测试看看是否真的生效". WS1 不是 playbook 但同样 logic — D10 必须 deploy 到 dev + 跑真实 iMessage scenario 才算闭环。半成品不算 done.

---

## Engineer's confidence: **MEDIUM-HIGH**

**Reasons HIGH**:
- All key files read in full. Real line numbers cited (mem0.ts:304, cv-ingest.ts:300-348, valet-integration.md §5.1-5.5, etc.).
- VALET reference is robust 713-line doc with code-line cites; schema port is mechanical.
- 4 limits each have crisp implementation specs; race conditions enumerated.
- mem0Add signature extension is small surface (4 call sites) with backward-compat by design.
- Test plan is concrete (45 unit tests + 10 PDF fixtures + e2e + schema eval).

**Reasons MEDIUM (not HIGH)**:
- Risk #3 (mem0ai/oss metadata pass-through) is unresolved until MS5.2 round-trip test runs. If negative, design pivots to text-prefix encoding — adds 1 day rework. Quantified but not eliminated.
- Risk #1 (nano schema-violation rate under longer prompt) is unknown. Schema-eval at MS7.3 is the reveal moment. If <95%, fallback is mini-as-default, which Adam may push back on (mini is 4× cost).
- Race condition in §5.2 (Race A — user uploads same-millisecond as Claire's "send me") needs the grace-window solution implemented. The 3s `setTimeout` adds latency to legitimate ingests; design open to feedback.
- Open Q §11.5 (collection-name shadow) is research, not implementation; could surface a hidden migration if PA actually has both collections.

**De-risk move**: D2 is the early canary. If MS5.2 round-trip test passes, confidence locks at HIGH and the rest is mechanical. If it fails, we re-plan §6.4 fallback before D3.

> [🟠 阿里味] 这次 detail-plan 不是终态，是**作战图**。D2 是 GO/NO-GO 的真信号点。**底线思维**: D11 buffer 留给 Adam 验证 + 10% rollout，不是给 rework 留的。PR 必须 D10 ship-able。**因为信任所以简单** — Adam 给了 8-11d 预算，超了就是我没把颗粒度拍对。 [PUA生效 🔥]
