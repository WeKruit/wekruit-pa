/**
 * s2-website-signup-continuation.mjs — ENTRY-UX SIM round 1, scenario S2 (PRD §2.3/§2.4 + §2.1).
 *
 * SEED: Google-auth website signup, résumé uploaded + PARSED (parsedCandidateResumes row + tags
 * written), phone already bound (pa-users.phoneE164), NO pitch ever sent (no pitchedAt). The website
 * entry event is then emitted by the REAL producer and consumed by the REAL thin cutover — so the
 * FIRST Claire turn after "Talk to Claire" is captured verbatim.
 *
 * WHAT IS REAL (production code, no stand-ins):
 *   1. processWebsiteEntry (website-entry/website-entry-event.ts) — the §2.4 continuation write +
 *      the runtime-event emission, via the REAL enqueueRuntimeEventHandoff (creates the session,
 *      writes the resume_parse_completed pa-inbound-events doc with context.websiteEntry=true).
 *   2. maybeRunThinClaire (claire-agent/cutover.ts) on that doc — REAL flag gate, REAL
 *      cv_parsed_reentry carve-out, REAL entry-UX canary branch, REAL pitch engine
 *      (composePitchTurn on live gpt-5.4-mini) and the REAL createSendblueTransport.
 *
 * CAPTURE: the run is NOT dryRun — transport.sendText rides the REAL @pa/pa-broker enqueueOutbound,
 *   which is a PURE Firestore write (pa-outbound rows). Against this in-memory Firestore stub that
 *   means the EXACT bubbles cutover composed land as durable rows we read back verbatim — and
 *   nothing real can send (no outbox worker runs in-process; SENDBLUE_* env is unset so the
 *   best-effort typing indicator throws inside its own try/catch). No prod Firestore, no real sends.
 *
 * S2 CONTRACT asserted on the captured bubbles:
 *   - 3-bubble pitch posture: source confirmation → evidence-backed pitch → ONE next action.
 *   - MUST NOT ask to sign in; MUST NOT ask for a résumé; MUST NOT be a receipt
 *     ("you are signed in / I have your resume on file").
 *
 * Run (Node 24, repo root, PA_OPENAI_AGENT_API_KEY exported, SENDBLUE_* unset):
 *   node --import tsx tests/scenarios/entry-ux/s2-website-signup-continuation.mjs
 */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  processWebsiteEntry,
  WEBSITE_ENTRY_FIELD,
} from "../../../apps/functions/src/website-entry/website-entry-event.js"
import { maybeRunThinClaire } from "../../../apps/functions/src/claire-agent/cutover.js"

// Canary slot: the entry-UX pitch path is gated on isClaireEntryUxCanary (static dev-UID cohort).
// The UID string is borrowed for the gate only — ALL data below is a synthetic in-memory persona
// ("Maya Chen"), nothing is read from or written to prod.
const UID = "UKFaKdsMzzfPW2CDl5ve"
const PHONE = "+12154034668"
const THIN_FLAG_KEY = "paThinClaireEnabled"
const RESUME_ID = "res_s2_maya_0612"

// ── In-memory Firestore (same stub family as resume-e2e-text-capture.mjs) ──────────────────────
function makeFirestore() {
  const store = new Map()
  const col = (name) => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)
  }
  let autoId = 0
  const makeQuery = (name, filters) => {
    const run = () =>
      [...col(name).entries()].filter(([, data]) =>
        filters.every(([field, value]) => {
          const actual = data[field]
          if (value === null) return actual === null || actual === undefined
          return actual === value
        }),
      )
    const api = {
      where(field, _op, value) {
        return makeQuery(name, [...filters, [field, value]])
      },
      orderBy() {
        return api
      },
      limit() {
        return api
      },
      async get() {
        const rows = run()
        const docs = rows.map(([id, data]) => ({ id, exists: true, data: () => data }))
        return { empty: docs.length === 0, docs, size: docs.length }
      },
    }
    return api
  }
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            async get() {
              const data = col(name).get(id)
              return { exists: data !== undefined, id, data: () => data }
            },
            async set(data, opts) {
              col(name).set(id, opts?.merge ? { ...(col(name).get(id) ?? {}), ...data } : { ...data })
            },
            async create(data) {
              if (col(name).has(id)) {
                const err = new Error("ALREADY_EXISTS")
                err.code = 6
                throw err
              }
              col(name).set(id, { ...data })
            },
          }
        },
        async add(data) {
          const id = `auto_${name}_${++autoId}`
          col(name).set(id, { ...data })
          return { id }
        },
        where(field, _op, value) {
          return makeQuery(name, [[field, value]])
        },
        orderBy() {
          return makeQuery(name, [])
        },
        limit() {
          return makeQuery(name, [])
        },
        async get() {
          const docs = [...col(name).entries()].map(([id, data]) => ({ id, exists: true, data: () => data }))
          return { empty: docs.length === 0, docs, size: docs.length }
        },
      }
    },
  }
  return { db, store, col }
}

// ── S2 seed: Google-auth + parsed résumé + bound phone + NO pitch ───────────────────────────────
function seedS2(col) {
  col("pa-feature-flags").set(THIN_FLAG_KEY, {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [UID],
    blocklist: [],
  })

  // pa-users: identity from Google sign-in; tags as the résumé-parse tag-writer (mergeUserTags /
  // merge-experience seam) leaves them. NO pitchedAt, NO sharedOnboarding (website-origin user has
  // never been through the SMS onboarding), phone BOUND via connect-phone.
  col(PA_COLLECTIONS.users).set(UID, {
    id: UID,
    displayName: "Maya Chen",
    email: "maya.chen.s2@gmail.com",
    googleSignIn: true,
    phoneE164: PHONE,
    onboardingStatus: "invited",
    tags: {
      careerStage: "mid_level",
      yoeRange: [4, 6],
      targetRoleFunction: ["software_engineering"],
      industrySector: ["cloud_and_infrastructure"],
      recentRoleTitle: "Software Engineer",
      recentCompany: "Datadog",
      visaStatus: "citizen",
      targetLocations: ["new_york", "remote"],
      skills: [
        { name: "Go" },
        { name: "TypeScript" },
        { name: "Kafka" },
        { name: "Kubernetes" },
        { name: "PostgreSQL" },
        { name: "Terraform" },
      ],
      experienceHighlights: [
        {
          title: "Software Engineer",
          company: "Datadog",
          description:
            "Owns the metrics ingestion pipeline; cut p99 ingestion latency from 800ms to 90ms across 40k hosts.",
          durationMonths: 36,
          startDate: "2023-05",
          companyIndustry: "cloud_and_infrastructure",
        },
        {
          title: "Software Engineer",
          company: "Shopify",
          description:
            "Built the checkout fraud-screening service that screens $2B+ GMV per year.",
          durationMonths: 24,
          startDate: "2021-05",
          endDate: "2023-04",
          companyIndustry: "ecommerce_and_retail",
        },
      ],
    },
  })

  // The PARSED résumé (public-cv-ingest already ran; this is its durable output).
  col("parsedCandidateResumes").set(RESUME_ID, {
    id: RESUME_ID,
    userId: UID,
    sha256: "s2maya".padEnd(64, "0"),
    createdAt: "2026-06-12T18:02:11.000Z",
    candidateProfile: { name: "Maya Chen", email: "maya.chen.s2@gmail.com" },
    topSkills: ["Go", "TypeScript", "Kafka", "Kubernetes", "PostgreSQL", "Terraform"],
    workHistory: [
      {
        title: "Software Engineer",
        company: "Datadog",
        startDate: "2023-05",
        endDate: null,
        bullets: [
          "Own the metrics ingestion pipeline (Go, Kafka); cut p99 ingestion latency from 800ms to 90ms across 40k hosts",
          "Led the migration of 12 ingest services to Kubernetes with zero-downtime cutovers",
        ],
      },
      {
        title: "Software Engineer",
        company: "Shopify",
        startDate: "2021-05",
        endDate: "2023-04",
        bullets: [
          "Built the checkout fraud-screening service screening $2B+ GMV/yr (TypeScript, PostgreSQL)",
          "Shipped rate-limiting middleware adopted by 30+ internal services",
        ],
      },
    ],
    projects: [],
    experiences: [],
  })
}

// ── S2 contract checks ──────────────────────────────────────────────────────────────────────────
const SIGNIN_ASK_RE =
  /\b(sign|log)[\s-]?in\b|\bsign[\s-]?up\b|magic.?link|\blog into\b|verify your (email|account)|\bauthenticate\b/i
const RESUME_ASK_RE =
  /\b(paste|upload|re-?send|attach)\b[^.?!]{0,40}\b(r[ée]sum[ée]|resume|cv)\b|\bsend (me )?(your |a )?(r[ée]sum[ée]|resume|cv)\b|\bshare (your |a )?(r[ée]sum[ée]|resume|cv)\b|\bdrop (your |a )?(latest )?(r[ée]sum[ée]|resume|cv)\b/i
const RECEIPT_RE =
  /\b(you('?| a)re|you are) (signed|logged) in\b|\bon file\b|\baccount (is )?(created|set ?up)\b|\byou'?re all set\b|\bsuccessfully (signed|logged|uploaded)\b/i
const EITHER_OR_CLOSER_RE = /\bor\b[^.?!]{0,40}\b(tweak|adjust|edit|change|first)\b[^.?!]{0,10}\?/i

async function attemptOnce(attempt) {
  const { db, col } = makeFirestore()
  seedS2(col)

  // ── PRODUCER (real): website entry → continuation write + runtime-event emission ─────────────
  const producer = await processWebsiteEntry(
    db,
    {
      candidateId: UID,
      authProvider: "google",
      resumeStatus: "parsed",
      linkedinState: "none",
      jobIdContext: null,
      pitchAlreadySent: false,
    },
    { flowId: `cv:${RESUME_ID}`, source: "public_cv_ingest", newEvidence: true },
  )
  assert.equal(producer.recorded, true, "producer: continuation state must be recorded")
  assert.equal(producer.emitted, true, `producer: event must EMIT (phone is bound) — got ${JSON.stringify(producer)}`)
  assert.equal(producer.pendingEmit, false, "producer: no pendingEmit when routable")

  const continuation = col(PA_COLLECTIONS.users).get(UID)?.[WEBSITE_ENTRY_FIELD]
  assert.equal(continuation?.authProvider, "google")
  assert.equal(continuation?.resumeStatus, "parsed")
  assert.equal(continuation?.pitchAlreadySent, false)

  // Locate the handoff doc the real producer wrote.
  let handoffId
  for (const [id, data] of col(PA_COLLECTIONS.inboundEvents)) {
    if (data?.rawMeta?.runtimeEventKind === "resume_parse_completed") handoffId = id
  }
  assert.ok(handoffId, "producer: resume_parse_completed handoff doc must exist")
  const handoff = col(PA_COLLECTIONS.inboundEvents).get(handoffId)
  assert.equal(handoff.rawMeta.context.websiteEntry, true, "handoff context carries websiteEntry=true")
  assert.equal(handoff.rawMeta.context.jobIdContext, null, "general entry: no job context")

  // ── CONSUMER (real): the first Claire turn after Talk-to-Claire ───────────────────────────────
  const logs = []
  const t0 = new Date().toISOString()
  const handled = await maybeRunThinClaire(db, handoffId, {
    log: (e, p) => logs.push({ e, ...(p ? { p } : {}) }),
  })
  const t1 = new Date().toISOString()
  const logNames = logs.map((l) => l.e)

  assert.equal(handled, true, "thin must own the website-entry completion turn")
  assert.equal(logNames.includes("thin_claire.defer_runtime_event"), false, "must NOT defer to legacy")
  assert.ok(logNames.includes("thin_claire.cv_parsed_reentry"), "cv_parsed_reentry carve-out must fire")
  assert.equal(
    logNames.includes("thin_claire.website_entry.prescreen_start"),
    false,
    "no job context → no prescreen start",
  )

  const handledBy = col(PA_COLLECTIONS.inboundEvents).get(handoffId)?.handledBy
  const bubbles = [...col(PA_COLLECTIONS.outbound).values()]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((r) => ({ seq: r.seq ?? 0, createdAt: r.createdAt, body: r.body }))

  // Model flake (composer miss → 1-bubble deterministic fallback) → caller may re-sample.
  const isFullPitch = handledBy === "thin_claire_pitch_engine" && bubbles.length === 3
  return { db, col, producer, continuation, handoffId, handoff, logs, logNames, handledBy, bubbles, isFullPitch, t0, t1, attempt }
}

async function main() {
  if (!(process.env.PA_OPENAI_AGENT_API_KEY ?? "").trim().startsWith("sk-")) {
    console.error("BLOCKED: PA_OPENAI_AGENT_API_KEY missing — cannot drive the REAL pitch composer.")
    process.exit(3)
  }
  if ((process.env.SENDBLUE_API_KEY_ID ?? "").trim()) {
    console.error("REFUSING TO RUN: SENDBLUE_API_KEY_ID is set — unset all SENDBLUE_* env first (no real sends).")
    process.exit(3)
  }

  let run
  const flakeNotes = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    run = await attemptOnce(attempt)
    if (run.isFullPitch) break
    flakeNotes.push(
      `attempt ${attempt}: handledBy=${run.handledBy} bubbles=${run.bubbles.length} (composer miss — re-sampling)`,
    )
  }

  // ── S2 contract assertions on the captured outbound ──────────────────────────────────────────
  const all = run.bubbles.map((b) => b.body).join("\n\n")
  const failures = []
  const check = (cond, label) => (cond ? null : failures.push(label))

  check(run.handledBy === "thin_claire_pitch_engine", `handledBy=thin_claire_pitch_engine (got ${run.handledBy})`)
  check(run.bubbles.length === 3, `exactly 3 bubbles (got ${run.bubbles.length})`)

  const [b0, b1, b2] = run.bubbles.map((b) => b.body ?? "")
  // Bubble 1 — source confirmation (acknowledges the résumé/profile Claire just used; a statement).
  check(/r[ée]sum[ée]|resume|profile|background/i.test(b0 ?? ""), "bubble[0] acknowledges the résumé/profile source")
  // Bubble 2 — evidence-backed pitch (real employers + at least one real number from the profile).
  const evidenceHits = [/datadog/i.test(b1), /shopify/i.test(b1), /\d/.test(b1), /(go|kafka|kubernetes|typescript|postgres|latency|fraud|ingest)/i.test(b1)]
  check(evidenceHits.filter(Boolean).length >= 3, `bubble[1] cites profile evidence (hits=${JSON.stringify(evidenceHits)})`)
  // Bubble 3 — ONE clear next action (pull-roles ask, ends in a question, no either/or).
  check(/\?/.test(b2 ?? ""), "bubble[2] ends with a clear ask (question)")
  check(/\b(pull|find|send|grab|match|roles?|matches)\b/i.test(b2 ?? ""), "bubble[2] offers the pull-roles next action")
  check(!EITHER_OR_CLOSER_RE.test(b2 ?? ""), "bubble[2] is ONE action, not an either/or")

  // MUST NOTs (whole turn).
  check(!SIGNIN_ASK_RE.test(all), `must NOT ask to sign in (matched: ${(all.match(SIGNIN_ASK_RE) ?? [])[0] ?? ""})`)
  check(!RESUME_ASK_RE.test(all), `must NOT ask for a résumé (matched: ${(all.match(RESUME_ASK_RE) ?? [])[0] ?? ""})`)
  check(!RECEIPT_RE.test(all), `must NOT send a receipt ("signed in / on file") (matched: ${(all.match(RECEIPT_RE) ?? [])[0] ?? ""})`)

  // Durable state: the pitch is stamped (no re-pitch on the next entry).
  const userAfter = run.col(PA_COLLECTIONS.users).get(UID)
  check(Boolean(userAfter?.pitchedAt), "pitchedAt stamped after the pitch turn (no re-pitch)")

  // ── Transcript ────────────────────────────────────────────────────────────────────────────────
  const lines = []
  lines.push(`SCENARIO S2 — website signup continuation (attempt ${run.attempt}, window ${run.t0} → ${run.t1})`)
  lines.push(``)
  lines.push(`[${run.handoff.createdAt}] (runtime event, NOT candidate-visible) ${run.handoff.body.split("\n")[0]}`)
  for (const b of run.bubbles) lines.push(`[${b.createdAt}] CLAIRE bubble ${b.seq}> ${b.body}`)
  const transcript = lines.join("\n")

  console.log("\n================= S2 TRANSCRIPT =================\n")
  console.log(transcript)
  console.log("\n================= ROUTE LOG =================")
  console.log(run.logNames.join(", "))
  if (flakeNotes.length) console.log("\nflake notes:", flakeNotes.join(" | "))
  console.log("\nproducer:", JSON.stringify(run.producer))
  console.log("continuation doc:", JSON.stringify(run.continuation))
  console.log("handledBy:", run.handledBy)
  console.log("\nchecks:", failures.length === 0 ? "ALL PASS" : `FAILURES:\n  - ${failures.join("\n  - ")}`)

  // Raw artifact for the audit note.
  try {
    mkdirSync(new URL("../../../.audit/", import.meta.url), { recursive: true })
    writeFileSync(
      new URL("../../../.audit/s2-website-signup-continuation-raw.json", import.meta.url),
      JSON.stringify(
        {
          producer: run.producer,
          continuation: run.continuation,
          handoffId: run.handoffId,
          handoffBody: run.handoff.body,
          handoffContext: run.handoff.rawMeta.context,
          routeLog: run.logs,
          handledBy: run.handledBy,
          bubbles: run.bubbles,
          flakeNotes,
          failures,
          window: { t0: run.t0, t1: run.t1 },
        },
        null,
        2,
      ),
    )
  } catch (e) {
    console.error("artifact write failed:", e?.message)
  }

  if (failures.length > 0) {
    console.error(`\n❌ S2 FAIL — ${failures.length} contract check(s) failed.`)
    process.exit(1)
  }
  console.log("\n✅ S2 PASS — 3-bubble pitch posture, no sign-in ask, no résumé ask, no receipt.")
}

main().catch((err) => {
  console.error("\n❌ S2 HARNESS ERROR:", err?.message ?? err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
})
