#!/usr/bin/env tsx
/**
 * Stream H6 — backfill user embeddings on parsedCandidateResumes.
 *
 * Why this exists:
 *   The daily-batch's cosine-rerank requires a user-side embedding on
 *   parsedCandidateResumes/{resumeId}.embedding. Until G1 lazy-compute
 *   ran for a user (which only fires inside paJobRecDaily), the cosine
 *   path was disabled and daily-batch silently fell back to keyword
 *   ranking — producing irrelevant matches (Adam, 2026-05-01: Baltimore +
 *   tech_software profile got QA roles in MA + CA).
 *
 *   This one-shot script primes the embedding cache for allowlist users
 *   so the very next daily run (or our H6 D3 rematch) hits the rerank
 *   path with a 1536-d user vector.
 *
 * What it does, per user:
 *   1. Find the most-recent parsedCandidateResumes row (where userId == X).
 *   2. Synthesize a `resumeText` from the structured candidateProfile +
 *      experiences + education + industryTags (template documented inline).
 *   3. Persist resumeText back to the doc (best-effort merge).
 *   4. Compute the embedding via OpenAI text-embedding-3-small (1536-d).
 *   5. Persist embedding + embeddingModel + embeddingDim + embeddingComputedAt.
 *
 * Idempotency:
 *   - Skips when embeddingDim === 1536 already on the doc (override with --force).
 *   - Best-effort writes (merge:true), no destructive overwrites of unrelated
 *     fields.
 *
 * Cost: 3 users × 1 embedding = ~$0.0003 at $0.02/M tokens (3-small price).
 *
 * CLI:
 *   npx tsx apps/functions/scripts/backfill-user-embeddings.ts --from-allowlist
 *   npx tsx apps/functions/scripts/backfill-user-embeddings.ts --user=<id> --user=<id2>
 *   ... add --dry-run, --force as needed.
 *
 * Auth (live mode): mirrors backfill-job-profiles-from-cv.ts —
 * FIREBASE_SERVICE_ACCOUNT_JSON + PA_OPENAI_AGENT_API_KEY (or OPENAI_API_KEY)
 * from /Users/adam/Desktop/WeKruit/wekruit-pa/.env.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedResumeForEmbed = {
  /** Firestore doc id (parsedCandidateResumes/{id}). */
  resumeId: string
  /** Owner user id. */
  userId: string
  /** Whether the doc already carries a 1536-d embedding from a prior run. */
  hasEmbedding: boolean
  /** Synthesized resumeText (full pre-embed payload). */
  resumeText: string
}

export type EmbedRow = {
  resumeId: string
  userId: string
  embedding: number[]
  embeddingModel: string
  embeddingDim: number
  embeddingComputedAt: string
  resumeText: string
}

export type Args = {
  users: string[]
  fromAllowlist: boolean
  dryRun: boolean
  force: boolean
}

export type RunResult = {
  scanned: number
  embedded: number
  skippedAlreadyHas: number
  skippedNoResume: number
  errors: number
  perUser: Array<{
    userId: string
    status: "embedded" | "would_embed" | "skip_already_has" | "skip_no_resume" | "error"
    resumeId?: string
    dim?: number
    message?: string
  }>
}

// ---------------------------------------------------------------------------
// Pure CLI parsing (exported for tests)
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): Args {
  const out: Args = { users: [], fromAllowlist: false, dryRun: false, force: false }
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true
    else if (a === "--from-allowlist") out.fromAllowlist = true
    else if (a.startsWith("--user=")) {
      const v = a.slice("--user=".length).trim()
      if (v) out.users.push(v)
    }
  }
  if (out.users.length === 0 && !out.fromAllowlist) out.fromAllowlist = true
  return out
}

// ---------------------------------------------------------------------------
// Pure resume → text synthesis (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Synthesize a compact resume text suitable for OpenAI text-embedding-3-small.
 * Bilingual-friendly (works for English + 中文 names/locations/skills).
 *
 * Template:
 *   Name: {name}
 *   Location: {location}
 *   Skills: {skill1, skill2, ...}
 *   Recent role: {title} at {company} ({startDate}–{endDate or 'present'})
 *   Achievements: {description trimmed to 600 chars}
 *   Education: {school} {degree} {field}; ...
 *   Industry tags: {tag1, tag2, ...}
 *
 * Skips fields that are missing rather than emitting empty rows.
 * Returns null when the doc has no usable signal at all (no name, no skills,
 * no experiences). Caller should treat null as "skip — nothing to embed".
 */
export function synthesizeResumeText(doc: Record<string, unknown>): string | null {
  const cp = (doc.candidateProfile ?? {}) as Record<string, unknown>
  const exps = Array.isArray(doc.experiences) ? (doc.experiences as Record<string, unknown>[]) : []
  const eds = Array.isArray(doc.education) ? (doc.education as Record<string, unknown>[]) : []
  const tags = Array.isArray(doc.industryTags)
    ? (doc.industryTags as unknown[]).filter((t) => typeof t === "string").map((t) => String(t))
    : []
  const skills = Array.isArray(cp.skills)
    ? (cp.skills as unknown[]).filter((s) => typeof s === "string").map((s) => String(s))
    : []

  const name = typeof cp.name === "string" ? cp.name.trim() : ""
  const location = typeof cp.location === "string" ? cp.location.trim() : ""

  const lines: string[] = []
  if (name) lines.push(`Name: ${name}`)
  if (location) lines.push(`Location: ${location}`)
  if (skills.length > 0) lines.push(`Skills: ${skills.slice(0, 25).join(", ")}`)

  // Up to top-2 experiences (most recent first; we trust input order).
  const expsToInclude = exps.slice(0, 2)
  for (let i = 0; i < expsToInclude.length; i++) {
    const e = expsToInclude[i] ?? {}
    const title = typeof e.title === "string" ? e.title : ""
    const company = typeof e.company === "string" ? e.company : ""
    const startDate = typeof e.startDate === "string" ? e.startDate : ""
    const endDate =
      typeof e.endDate === "string" && e.endDate.trim().length > 0 ? e.endDate : "present"
    const desc = typeof e.description === "string" ? e.description.slice(0, 600) : ""
    if (!title && !company) continue
    const label = i === 0 ? "Recent role" : "Prior role"
    lines.push(`${label}: ${title} at ${company} (${startDate}–${endDate})`)
    if (desc) lines.push(`Achievements: ${desc}`)
  }

  if (eds.length > 0) {
    const eduText = eds
      .slice(0, 2)
      .map((e) => {
        const school = typeof e.school === "string" ? e.school : ""
        const degree = typeof e.degree === "string" ? e.degree : ""
        const field = typeof e.field === "string" ? e.field : ""
        return [school, degree, field].filter(Boolean).join(" ")
      })
      .filter((s) => s.trim().length > 0)
      .join("; ")
    if (eduText) lines.push(`Education: ${eduText}`)
  }

  if (tags.length > 0) lines.push(`Industry tags: ${tags.join(", ")}`)

  const text = lines.join("\n").trim()
  // Embedding only meaningful when there's at least 30 chars of signal.
  if (text.length < 30) return null
  return text
}

// ---------------------------------------------------------------------------
// Firestore + OpenAI port (test-injectable)
// ---------------------------------------------------------------------------

export type FsPort = {
  /** Most-recent parsedCandidateResumes for userId, with raw doc data. */
  loadLatestResume: (userId: string) => Promise<{
    resumeId: string
    raw: Record<string, unknown>
  } | null>
  /** Persist the embedding row (merge). */
  writeEmbedding: (resumeId: string, payload: Record<string, unknown>) => Promise<void>
  /** Read paJobRecEnabled.allowlist. */
  loadAllowlist: () => Promise<string[]>
}

export type EmbedPort = {
  /** Compute a single embedding vector via OpenAI text-embedding-3-small. */
  embed: (text: string) => Promise<number[]>
}

// ---------------------------------------------------------------------------
// Core run loop (pure-ish — uses ports, no global state)
// ---------------------------------------------------------------------------

export async function runBackfill(
  args: Args,
  fs: FsPort,
  embedder: EmbedPort,
  log: (event: string, payload?: Record<string, unknown>) => void = () => {},
  nowIso: () => string = () => new Date().toISOString()
): Promise<RunResult> {
  // 1. Resolve user list.
  let users: string[] = [...args.users]
  if (args.fromAllowlist) {
    const allow = await fs.loadAllowlist()
    log("source:allowlist", { count: allow.length })
    users = users.concat(allow)
  }
  users = users.filter((u, i) => users.indexOf(u) === i)
  log("resolved_user_list", { count: users.length, users })

  const result: RunResult = {
    scanned: 0,
    embedded: 0,
    skippedAlreadyHas: 0,
    skippedNoResume: 0,
    errors: 0,
    perUser: [],
  }

  for (const userId of users) {
    result.scanned += 1
    let row: { resumeId: string; raw: Record<string, unknown> } | null
    try {
      row = await fs.loadLatestResume(userId)
    } catch (err) {
      result.errors += 1
      const msg = err instanceof Error ? err.message : String(err)
      log("error:load-resume", { userId, error: msg })
      result.perUser.push({ userId, status: "error", message: msg })
      continue
    }
    if (!row) {
      result.skippedNoResume += 1
      log("skip:no-resume", { userId })
      result.perUser.push({ userId, status: "skip_no_resume" })
      continue
    }

    // Skip if already has 1536-d embedding (idempotent unless --force).
    const existingEmb = Array.isArray(row.raw.embedding) ? (row.raw.embedding as unknown[]) : null
    const existingDim =
      typeof row.raw.embeddingDim === "number" ? (row.raw.embeddingDim as number) : null
    if (
      !args.force &&
      existingEmb &&
      existingEmb.length === 1536 &&
      existingDim === 1536
    ) {
      result.skippedAlreadyHas += 1
      log("skip:already-has-embedding", { userId, resumeId: row.resumeId })
      result.perUser.push({
        userId,
        status: "skip_already_has",
        resumeId: row.resumeId,
        dim: 1536,
      })
      continue
    }

    const resumeText = synthesizeResumeText(row.raw)
    if (!resumeText) {
      result.skippedNoResume += 1
      log("skip:no-text", { userId, resumeId: row.resumeId })
      result.perUser.push({
        userId,
        status: "skip_no_resume",
        resumeId: row.resumeId,
        message: "synthesized text < 30 chars",
      })
      continue
    }

    log("synthesized", { userId, resumeId: row.resumeId, textLen: resumeText.length })

    if (args.dryRun) {
      result.perUser.push({
        userId,
        status: "would_embed",
        resumeId: row.resumeId,
        message: `text(${resumeText.length}) — DRY RUN`,
      })
      continue
    }

    let vec: number[]
    try {
      vec = await embedder.embed(resumeText)
    } catch (err) {
      result.errors += 1
      const msg = err instanceof Error ? err.message : String(err)
      log("error:embed", { userId, error: msg })
      result.perUser.push({ userId, status: "error", resumeId: row.resumeId, message: msg })
      continue
    }
    if (!Array.isArray(vec) || vec.length === 0) {
      result.errors += 1
      log("error:empty-vec", { userId, resumeId: row.resumeId })
      result.perUser.push({
        userId,
        status: "error",
        resumeId: row.resumeId,
        message: "embed returned empty vector",
      })
      continue
    }

    const ts = nowIso()
    try {
      await fs.writeEmbedding(row.resumeId, {
        resumeText,
        embedding: vec,
        embeddingModel: "text-embedding-3-small",
        embeddingDim: vec.length,
        embeddingComputedAt: ts,
      })
      result.embedded += 1
      log("write:ok", { userId, resumeId: row.resumeId, dim: vec.length })
      result.perUser.push({
        userId,
        status: "embedded",
        resumeId: row.resumeId,
        dim: vec.length,
      })
    } catch (err) {
      result.errors += 1
      const msg = err instanceof Error ? err.message : String(err)
      log("error:write", { userId, error: msg })
      result.perUser.push({ userId, status: "error", resumeId: row.resumeId, message: msg })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// LIVE wiring — only when invoked as a script
// ---------------------------------------------------------------------------

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const FEATURE_FLAGS_COLLECTION = "pa-feature-flags"
const FLAG_KEY = "paJobRecEnabled"
const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"

async function readEnvLine(name: string): Promise<string | null> {
  const fs = (await import("node:fs")) as typeof import("node:fs")
  const txt = fs.readFileSync(ENV_PATH, "utf8")
  const line = txt.split("\n").find((l) => l.startsWith(`${name}=`))
  if (!line) return null
  return line.slice(`${name}=`.length).trim()
}

async function makeLiveFsPort(): Promise<FsPort> {
  const adminMod = (await import("firebase-admin")) as typeof import("firebase-admin")
  const admin = (adminMod as unknown as { default: typeof import("firebase-admin") }).default
  const saStr = await readEnvLine("FIREBASE_SERVICE_ACCOUNT_JSON")
  if (!saStr) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not in .env")
  const sa = JSON.parse(saStr)
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: "wekruit-5f89b",
    })
  }
  const db = admin.firestore()

  return {
    async loadLatestResume(userId) {
      // Same pattern as backfill-job-profiles-from-cv: scan-and-pick to
      // avoid composite-index requirements.
      const snap = await db
        .collection(PARSED_RESUMES_COLLECTION)
        .where("userId", "==", userId)
        .get()
      if (snap.empty) return null
      type Cand = { id: string; data: Record<string, unknown>; ts: number }
      const cands: Cand[] = []
      for (const doc of snap.docs) {
        const d = doc.data() as Record<string, unknown>
        let ts = 0
        if (typeof d.ingestedAt === "string") {
          const t = Date.parse(d.ingestedAt)
          if (!Number.isNaN(t)) ts = t
        }
        if (
          ts === 0 &&
          d.createdAt &&
          typeof (d.createdAt as { toDate?: () => Date }).toDate === "function"
        ) {
          ts = (d.createdAt as { toDate: () => Date }).toDate().getTime()
        } else if (ts === 0 && typeof d.createdAt === "string") {
          const t = Date.parse(d.createdAt)
          if (!Number.isNaN(t)) ts = t
        }
        cands.push({ id: doc.id, data: d, ts })
      }
      cands.sort((a, b) => b.ts - a.ts)
      const pick = cands[0]!
      return { resumeId: pick.id, raw: pick.data }
    },

    async writeEmbedding(resumeId, payload) {
      await db
        .collection(PARSED_RESUMES_COLLECTION)
        .doc(resumeId)
        .set(payload, { merge: true })
    },

    async loadAllowlist() {
      const snap = await db.collection(FEATURE_FLAGS_COLLECTION).doc(FLAG_KEY).get()
      if (!snap.exists) return []
      const d = snap.data() as Record<string, unknown> | undefined
      if (!d || !Array.isArray(d.allowlist)) return []
      return (d.allowlist.filter((s: unknown) => typeof s === "string") as string[])
    },
  }
}

async function makeLiveEmbedPort(): Promise<EmbedPort> {
  const apiKey =
    (await readEnvLine("PA_OPENAI_AGENT_API_KEY")) ||
    (await readEnvLine("OPENAI_API_KEY")) ||
    ""
  if (!apiKey) throw new Error("No OpenAI API key in .env")
  const { default: OpenAI } = await import("openai")
  const client = new OpenAI({ apiKey })
  return {
    async embed(text: string) {
      const resp = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: text.slice(0, 8000),
      })
      const v = resp.data?.[0]?.embedding
      if (!Array.isArray(v)) throw new Error("OpenAI returned no embedding")
      return v as number[]
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const log = (event: string, payload?: Record<string, unknown>) => {
    if (payload) console.log(`[backfill-emb] ${event}`, JSON.stringify(payload))
    else console.log(`[backfill-emb] ${event}`)
  }
  log("starting", {
    args,
    note: args.dryRun ? "DRY-RUN (no embed/write)" : "LIVE — will call OpenAI + write",
  })

  const fs = await makeLiveFsPort()
  const embedder = args.dryRun
    ? { async embed() { return [] as number[] } }
    : await makeLiveEmbedPort()

  const result = await runBackfill(args, fs, embedder, log)
  console.log("\n" + "=".repeat(72))
  console.log("Stream H6 — backfill-user-embeddings summary")
  console.log(`  scanned:                 ${result.scanned}`)
  console.log(`  embedded:                ${result.embedded}`)
  console.log(`  skipped already-has:     ${result.skippedAlreadyHas}`)
  console.log(`  skipped no-resume/text:  ${result.skippedNoResume}`)
  console.log(`  errors:                  ${result.errors}`)
  for (const r of result.perUser) {
    console.log(
      `  ${r.userId}: ${r.status}${r.resumeId ? " (" + r.resumeId + ")" : ""}` +
        `${r.dim ? " dim=" + r.dim : ""}${r.message ? " — " + r.message : ""}`
    )
  }
  console.log("=".repeat(72))
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("backfill-user-embeddings.ts") ||
    process.argv[1].endsWith("backfill-user-embeddings.js"))

if (isMain) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[backfill-emb] FATAL", err)
      process.exit(1)
    }
  )
}
