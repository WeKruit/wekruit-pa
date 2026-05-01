#!/usr/bin/env tsx
/**
 * Stream H1 — pa-job-profiles backfill from parsedCandidateResumes.
 *
 * Why this exists:
 *   The daily job-rec push pipeline (paJobRecDaily) reads
 *   `pa-job-profiles/{userId}` where status="active" and queries
 *   matching-jobs from there. The intended writer is Claire (the LLM)
 *   via the saveJobProfile connector during the JOB-PREF probing flow.
 *   That probing flow has not yet completed for any allowlisted user,
 *   so on 2026-05-01 the daily cron loaded 0 active profiles and
 *   nobody got a push — including Adam (the human).
 *
 *   This script bridges the gap: for users in the paJobRecEnabled
 *   allowlist who already have a parsed resume, derive a NEW-shape
 *   profile (industryTags / sponsorshipNeeded / locationPreference /
 *   sizePreference / salaryMin) deterministically from the resume and
 *   write it. daily-batch's normalizeJobProfile recognises both legacy
 *   and new shapes — we use NEW because it carries the full canonical
 *   industryTags array that the embedding rerank consults.
 *
 * Schema fidelity:
 *   The Firestore doc shape mirrors what
 *   `packages/pa-connectors/src/index.ts` ("save-job-profile" connector)
 *   writes. So when Claire later runs the proper probing flow and calls
 *   saveJobProfile, the merge transaction in that connector lands cleanly
 *   on top of this backfill (createdAt is preserved; profile is replaced;
 *   status stays "active").
 *
 * Idempotency:
 *   - Existing pa-job-profiles/{userId} → skipped (override with --force).
 *   - Writes use set({ merge:true }), never overwrite createdAt.
 *
 * Defaults for fields the CV doesn't carry:
 *   - sponsorshipNeeded: "H1B" (most allowlisted users are intl candidates;
 *     using "none" would HARD-filter out sponsorship=true matching-jobs
 *     in queryMatchingJobs and shrink the pool).
 *   - sizePreference: "any"
 *   - salaryMin: null
 *
 * Usage:
 *   npx tsx apps/functions/scripts/backfill-job-profiles-from-cv.ts --from-allowlist
 *   npx tsx apps/functions/scripts/backfill-job-profiles-from-cv.ts --user=<id1> --user=<id2>
 *   npx tsx apps/functions/scripts/backfill-job-profiles-from-cv.ts --all-with-cv
 *   ... add --dry-run to print without writing, --force to overwrite.
 *
 * Auth (live mode): reads FIREBASE_SERVICE_ACCOUNT_JSON from
 * /Users/adam/Desktop/WeKruit/wekruit-pa/.env (same pattern as
 * run-daily-now-debug.mjs).
 */

// ---------------------------------------------------------------------------
// Lightweight types — kept inline to avoid pulling apps/functions src into
// the script tree and to match the rest of scripts/ which prefers local
// declarations + lazy imports.
// ---------------------------------------------------------------------------

const INDUSTRY_TAGS_LOCAL = [
  "tech_software",
  "tech_hardware",
  "fintech_finance",
  "ai_ml",
  "healthcare_biotech",
  "consumer_retail",
  "media_entertainment",
  "manufacturing_industrial",
  "education",
  "other",
] as const

type IndustryTag = (typeof INDUSTRY_TAGS_LOCAL)[number]

export type SponsorshipNeed = "H1B" | "GC" | "none"
export type SizePreference = "big" | "startup" | "mid" | "any"

export type DerivedJobProfile = {
  industryTags: IndustryTag[]
  sponsorshipNeeded: SponsorshipNeed
  locationPreference: string
  sizePreference: SizePreference
  salaryMin: number | null
}

export type ParsedResumeRow = {
  /** Firestore doc id of the parsedCandidateResumes row. */
  resumeId: string
  /** Owner user id. */
  userId: string
  /** ISO timestamp from `ingestedAt` or `createdAt` (whichever is present). */
  parsedAt: string
  /** From candidateProfile.location. May be empty. */
  location: string
  /** From parsedCandidateResumes.industryTags (1..3 canonical). May be empty. */
  industryTags: string[]
}

// ---------------------------------------------------------------------------
// CLI parsing — pure function exported for tests
// ---------------------------------------------------------------------------

export type Args = {
  /** Repeated --user=X flags. */
  users: string[]
  /** Pull users from pa-feature-flags/paJobRecEnabled.allowlist. */
  fromAllowlist: boolean
  /** Pull every userId having ≥1 parsedCandidateResumes row. */
  allWithCv: boolean
  /** Print only, no writes. */
  dryRun: boolean
  /** Overwrite existing pa-job-profiles/{userId} when present. */
  force: boolean
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {
    users: [],
    fromAllowlist: false,
    allWithCv: false,
    dryRun: false,
    force: false,
  }
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true
    else if (a === "--from-allowlist") out.fromAllowlist = true
    else if (a === "--all-with-cv") out.allWithCv = true
    else if (a.startsWith("--user=")) {
      const v = a.slice("--user=".length).trim()
      if (v) out.users.push(v)
    }
  }
  // Default: --from-allowlist (per H1 brief).
  if (
    out.users.length === 0 &&
    !out.fromAllowlist &&
    !out.allWithCv
  ) {
    out.fromAllowlist = true
  }
  return out
}

// ---------------------------------------------------------------------------
// Pure derivation — exposed for tests
// ---------------------------------------------------------------------------

/**
 * Derive a NEW-shape profile from a parsed resume row.
 *
 * Defaults applied when a CV field is absent:
 *   - industryTags: ["other"] when the resume has none
 *   - locationPreference: "anywhere" when candidateProfile.location is empty
 *   - sponsorshipNeeded: "H1B" (see file docstring)
 *   - sizePreference: "any"
 *   - salaryMin: null
 *
 * industryTags are truncated to the canonical set + 1..3 cap, in the order
 * they appeared in the resume (preserves LLM-inferred priority).
 */
export function deriveJobProfileFromCv(row: ParsedResumeRow): DerivedJobProfile {
  const seen = new Set<IndustryTag>()
  const tags: IndustryTag[] = []
  for (const t of row.industryTags) {
    if (typeof t !== "string") continue
    if (!(INDUSTRY_TAGS_LOCAL as readonly string[]).includes(t)) continue
    const canonical = t as IndustryTag
    if (seen.has(canonical)) continue
    seen.add(canonical)
    tags.push(canonical)
    if (tags.length >= 3) break
  }
  if (tags.length === 0) tags.push("other")

  const locationPreference =
    typeof row.location === "string" && row.location.trim().length > 0
      ? row.location.trim()
      : "anywhere"

  return {
    industryTags: tags,
    sponsorshipNeeded: "H1B",
    locationPreference,
    sizePreference: "any",
    salaryMin: null,
  }
}

// ---------------------------------------------------------------------------
// Firestore IO — wrapped behind a thin port so tests inject a fake DB
// ---------------------------------------------------------------------------

export type FsPort = {
  /** Most-recent parsedCandidateResumes row for userId, or null. */
  loadLatestResume: (userId: string) => Promise<ParsedResumeRow | null>
  /** Existing pa-job-profiles/{userId} doc data, or null. */
  loadJobProfile: (userId: string) => Promise<Record<string, unknown> | null>
  /** Write pa-job-profiles/{userId} with merge. */
  writeJobProfile: (userId: string, doc: Record<string, unknown>) => Promise<void>
  /** Read paJobRecEnabled.allowlist from pa-feature-flags. */
  loadAllowlist: () => Promise<string[]>
  /** Distinct user ids with ≥1 parsedCandidateResumes row. */
  loadAllUsersWithCv: () => Promise<string[]>
}

export type RunResult = {
  scanned: number
  written: number
  skippedAlreadyExists: number
  skippedNoResume: number
  errors: number
  perUser: Array<{
    userId: string
    status: "written" | "would_write" | "skip_already_exists" | "skip_no_resume" | "error"
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    message?: string
  }>
}

// ---------------------------------------------------------------------------
// Core run loop — pure-ish (uses FsPort, no global state)
// ---------------------------------------------------------------------------

export async function runBackfill(
  args: Args,
  fs: FsPort,
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
  if (args.allWithCv) {
    const all = await fs.loadAllUsersWithCv()
    log("source:all-with-cv", { count: all.length })
    users = users.concat(all)
  }
  // Dedupe preserving order.
  users = users.filter((u, i) => users.indexOf(u) === i)

  log("resolved_user_list", { count: users.length, users })

  const result: RunResult = {
    scanned: 0,
    written: 0,
    skippedAlreadyExists: 0,
    skippedNoResume: 0,
    errors: 0,
    perUser: [],
  }

  for (const userId of users) {
    result.scanned += 1
    let row: ParsedResumeRow | null
    try {
      row = await fs.loadLatestResume(userId)
    } catch (err) {
      result.errors += 1
      const msg = err instanceof Error ? err.message : String(err)
      log("error:load-resume", { userId, error: msg })
      result.perUser.push({ userId, status: "error", before: null, after: null, message: msg })
      continue
    }

    if (!row) {
      result.skippedNoResume += 1
      log("skip:no-resume", { userId })
      result.perUser.push({ userId, status: "skip_no_resume", before: null, after: null })
      continue
    }

    // Existing profile guard.
    let before: Record<string, unknown> | null = null
    try {
      before = await fs.loadJobProfile(userId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log("error:load-profile", { userId, error: msg })
      result.errors += 1
      result.perUser.push({ userId, status: "error", before: null, after: null, message: msg })
      continue
    }
    if (before && !args.force) {
      result.skippedAlreadyExists += 1
      log("skip:already-has-profile", { userId, beforeKeys: Object.keys(before) })
      result.perUser.push({
        userId,
        status: "skip_already_exists",
        before,
        after: null,
      })
      continue
    }

    // Derive + assemble doc.
    const derived = deriveJobProfileFromCv(row)
    const ts = nowIso()
    const doc: Record<string, unknown> = {
      userId,
      profile: derived,
      // Preserve createdAt when force-overwriting an existing profile.
      createdAt:
        before && typeof before.createdAt === "string" ? (before.createdAt as string) : ts,
      updatedAt: ts,
      cvParsedAt: row.parsedAt,
      lastJobBatchSentAt:
        before && (typeof before.lastJobBatchSentAt === "string" || before.lastJobBatchSentAt === null)
          ? (before.lastJobBatchSentAt as string | null)
          : null,
      status: "active",
      // Audit trail — survives merges.
      backfillSource: "backfill-job-profiles-from-cv",
      backfillResumeId: row.resumeId,
      backfillAt: ts,
    }

    log("derived", {
      userId,
      resumeId: row.resumeId,
      industryTags: derived.industryTags,
      locationPreference: derived.locationPreference,
      sponsorshipNeeded: derived.sponsorshipNeeded,
    })

    if (args.dryRun) {
      result.perUser.push({ userId, status: "would_write", before, after: doc })
      log("dry-run:would-write", { userId })
      continue
    }

    try {
      await fs.writeJobProfile(userId, doc)
      result.written += 1
      result.perUser.push({ userId, status: "written", before, after: doc })
      log("write:ok", { userId })
    } catch (err) {
      result.errors += 1
      const msg = err instanceof Error ? err.message : String(err)
      log("error:write", { userId, error: msg })
      result.perUser.push({ userId, status: "error", before, after: doc, message: msg })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// LIVE Firestore wiring — only used when run as a script
// ---------------------------------------------------------------------------

const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"
const JOB_PROFILES_COLLECTION = "pa-job-profiles"
const FEATURE_FLAGS_COLLECTION = "pa-feature-flags"
const FLAG_KEY = "paJobRecEnabled"

const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"

async function makeLiveFsPort(): Promise<FsPort> {
  // Mirror run-daily-now-debug.mjs: read the SA JSON line out of .env.
  const fs = (await import("node:fs")) as typeof import("node:fs")
  const adminMod = (await import("firebase-admin")) as typeof import("firebase-admin")

  const txt = fs.readFileSync(ENV_PATH, "utf8")
  const line = txt
    .split("\n")
    .find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="))
  if (!line) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env")
  }
  const sa = JSON.parse(line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length))

  // firebase-admin's namespace import path; matches run-daily-now-debug.mjs.
  // Cast through unknown to satisfy strict typing — this is admin-bootstrap-style code.
  const admin = (adminMod as unknown as { default: typeof import("firebase-admin") }).default
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: "wekruit-5f89b",
    })
  }
  const db = admin.firestore()

  return {
    async loadLatestResume(userId) {
      // No composite index on (userId, createdAt) — fetch all resumes for the
      // user and pick the most-recent in memory. Per-user resume counts cap
      // at ~10 in practice; this stays cheap and avoids requiring an index
      // build for a one-shot backfill script.
      const snap = await db
        .collection(PARSED_RESUMES_COLLECTION)
        .where("userId", "==", userId)
        .get()
      if (snap.empty) return null
      // Extract a comparable timestamp from each candidate doc.
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
      const d = pick.data
      const cp = (d.candidateProfile ?? {}) as Record<string, unknown>
      const tags = Array.isArray(d.industryTags)
        ? (d.industryTags.filter((t: unknown) => typeof t === "string") as string[])
        : []
      let parsedAt = ""
      if (typeof d.ingestedAt === "string") parsedAt = d.ingestedAt
      else if (
        d.createdAt &&
        typeof (d.createdAt as { toDate?: () => Date }).toDate === "function"
      ) {
        parsedAt = (d.createdAt as { toDate: () => Date }).toDate().toISOString()
      } else if (typeof d.createdAt === "string") parsedAt = d.createdAt
      return {
        resumeId: pick.id,
        userId,
        parsedAt: parsedAt || new Date().toISOString(),
        location: typeof cp.location === "string" ? cp.location : "",
        industryTags: tags,
      }
    },

    async loadJobProfile(userId) {
      const snap = await db.collection(JOB_PROFILES_COLLECTION).doc(userId).get()
      if (!snap.exists) return null
      return (snap.data() ?? null) as Record<string, unknown> | null
    },

    async writeJobProfile(userId, payload) {
      await db
        .collection(JOB_PROFILES_COLLECTION)
        .doc(userId)
        .set(payload, { merge: true })
    },

    async loadAllowlist() {
      const snap = await db.collection(FEATURE_FLAGS_COLLECTION).doc(FLAG_KEY).get()
      if (!snap.exists) return []
      const d = snap.data() as Record<string, unknown> | undefined
      if (!d) return []
      const allow = Array.isArray(d.allowlist)
        ? (d.allowlist.filter((s: unknown) => typeof s === "string") as string[])
        : []
      return allow
    },

    async loadAllUsersWithCv() {
      // Page through all parsedCandidateResumes; build a Set of userIds.
      const ids = new Set<string>()
      const snap = await db
        .collection(PARSED_RESUMES_COLLECTION)
        .select("userId")
        .get()
      for (const d of snap.docs) {
        const u = (d.data() as Record<string, unknown>).userId
        if (typeof u === "string" && u.length > 0) ids.add(u)
      }
      return [...ids]
    },
  }
}

// ---------------------------------------------------------------------------
// Entry point — only runs when invoked as a script (not on import).
// We detect "run as script" by checking whether the resolved module URL
// matches the process entry. This keeps the test harness happy.
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const log = (event: string, payload?: Record<string, unknown>) => {
    if (payload) console.log(`[backfill] ${event}`, JSON.stringify(payload))
    else console.log(`[backfill] ${event}`)
  }
  log("starting", {
    args,
    note: args.dryRun ? "DRY-RUN (no writes)" : "LIVE writes enabled",
  })

  const fs = await makeLiveFsPort()
  const result = await runBackfill(args, fs, log)

  console.log("\n" + "=".repeat(72))
  console.log("Stream H1 — backfill summary")
  console.log(`  scanned:               ${result.scanned}`)
  console.log(`  written:               ${result.written}`)
  console.log(`  skipped already-exists ${result.skippedAlreadyExists}`)
  console.log(`  skipped no-resume:     ${result.skippedNoResume}`)
  console.log(`  errors:                ${result.errors}`)
  console.log("Per-user:")
  for (const r of result.perUser) {
    console.log(`  ${r.userId}: ${r.status}${r.message ? " — " + r.message : ""}`)
    if (r.after) {
      const profile = (r.after as { profile?: unknown }).profile
      console.log(`      after.profile:`, JSON.stringify(profile))
    }
    if (r.before) {
      console.log(`      before keys:`, Object.keys(r.before).join(","))
    }
  }
  console.log("=".repeat(72))
}

// Are we the script entry?
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("backfill-job-profiles-from-cv.ts") ||
    process.argv[1].endsWith("backfill-job-profiles-from-cv.js"))

if (isMain) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[backfill] FATAL", err)
      process.exit(1)
    }
  )
}
