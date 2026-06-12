/**
 * s3-enrichment-hold.mjs — ENTRY-UX round-1 scenario S3 (PRD §2.3.6–7, §2.4, gap "In-progress enrichment UX").
 *
 * SEED: known website-origin candidate (identity established, résumé uploaded) whose parse is IN FLIGHT
 * (durable `enrichmentInFlight` marker on pa-users — enrichment-inflight.ts, the production writer's shape).
 *
 * CONTRACT UNDER TEST:
 *   T1  "hi" while parse in flight → exactly ONE short "still reading/pulling your background" progress
 *       message; NO pitch from incomplete data; NO re-auth / re-upload ask.
 *   T2  (supplemental, once-only proof) a second mid-enrich message must NOT get a second hold notice —
 *       the deterministic claim is spent; the turn falls through to the agent, which carries the softer
 *       enrichmentInFlight directive (cutover.ts:880-933 documented behavior).
 *   T3  completion event (REAL ingestCv → REAL enqueueRuntimeEventHandoff resume_parse_completed) →
 *       the pitch turn arrives (cv_parsed_reentry → composePitchTurn 3-bubble pitch engine), and the
 *       in-flight marker is cleared.
 *
 * HARNESS CONVENTION: thin-runtime in-process driver (same family as
 * apps/functions/src/claire-agent/__tests__/resume-e2e-text-capture.mjs) — runner-local.mjs only reaches
 * the LEGACY orchestrator and cannot seed pa-users/enrichmentInFlight, so the thin seam is driven directly:
 * REAL maybeRunThinClaire / selectClaireMode / claimEnrichmentHoldNotice / ingestCv / composePitchTurn over
 * an in-memory Firestore stub, with dryRun transports (zero Sendblue, zero prod Firestore, zero real sends).
 *
 * Verbatim-text capture notes (the two seams whose sends happen INSIDE maybeRunThinClaire behind a dryRun
 * transport whose ledger is not exposed):
 *   - T1 hold copy is DETERMINISTIC: cutover sends exactly ENRICHMENT_HOLD_NOTICE_COPY (cutover.ts:915).
 *   - T3 pitch bubbles are captured by running composePitchTurn on a byte-identical CLONE of the store
 *     state at the pitch moment (production sends composePitchTurn's bubbles verbatim, cutover.ts:611-618);
 *     the in-cutover routing run is asserted separately (pitch_engine.sent + bubble count). Same convention
 *     the entry-ux baseline (B3) used.
 *
 * Run (Node 24, from the worktree root, OPENAI key in env — never printed):
 *   node --import tsx tests/scenarios/entry-ux/s3-enrichment-hold.mjs
 */
import assert from "node:assert/strict"
import { PA_COLLECTIONS } from "@pa/core-types"
import { ingestCv } from "../../../apps/functions/src/cv-ingest/cv-ingest.js"
import { maybeRunThinClaire } from "../../../apps/functions/src/claire-agent/cutover.js"
import { selectClaireMode } from "../../../apps/functions/src/claire-agent/mode-selector.js"
import { runClaireTurn } from "../../../apps/functions/src/claire-agent/agent.js"
import { createSendblueTransport } from "../../../apps/functions/src/claire-agent/transport.js"
import { makeV16FindMatch } from "../../../apps/functions/src/claire-agent/tools/matching-tools.js"
import {
  ENRICHMENT_HOLD_NOTICE_COPY,
  claimEnrichmentHoldNotice,
  shouldSendEnrichmentHoldNotice,
} from "../../../apps/functions/src/claire-agent/enrichment-inflight.js"
import { composePitchTurn } from "../../../apps/functions/src/claire-agent/compose-pitch.js"

const UID = "8fEwIduUrzxZsblHHsNz" // dev canary (isClaireEntryUxCanary + isCanaryUser both true)
const PHONE = "+14243201960"
const THIN_FLAG_KEY = "paThinClaireEnabled"
const RESUME_COLLECTION = "parsedCandidateResumes"

const ts = () => new Date().toISOString()
const transcript = []
const say = (who, text, meta = "") => {
  const line = { at: ts(), who, text, meta }
  transcript.push(line)
  console.log(`[${line.at}] ${who}> ${text}${meta ? `   ${meta}` : ""}`)
}

// ── In-memory Firestore (mirrors resume-e2e-text-capture.mjs's stub) ───────────────────────────
function makeFirestore(initialStore) {
  const store = initialStore ?? new Map()
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
            async update(data) {
              if (!col(name).has(id)) throw new Error("NOT_FOUND")
              col(name).set(id, { ...(col(name).get(id) ?? {}), ...data })
            },
            async delete() {
              col(name).delete(id)
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

/** Deep clone the whole store (for the verbatim composePitchTurn capture on identical state). */
function cloneStore(store) {
  const next = new Map()
  for (const [colName, docs] of store) {
    const m = new Map()
    for (const [id, data] of docs) m.set(id, structuredClone(data))
    next.set(colName, m)
  }
  return next
}

// ── SEED — S3: same known website-origin candidate as S2, but the parse is IN FLIGHT ────────────
function seed(col, nowIso) {
  col("pa-feature-flags").set(THIN_FLAG_KEY, {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [UID],
    blocklist: [],
  })
  col(PA_COLLECTIONS.users).set(UID, {
    id: UID,
    phoneE164: PHONE,
    displayName: "Adam Yang",
    email: "adam@example.com",
    authProvider: "google", // identity established by website sign-in — must NEVER be re-asked
    onboardingStatus: "invited",
    // Résumé just uploaded on the website → parse IS RUNNING. Exact production marker shape
    // (setEnrichmentInFlight, enrichment-inflight.ts:33-55). NO tags yet — the parse hasn't landed,
    // which is precisely why a pitch this turn would be "from incomplete data".
    enrichmentInFlight: true,
    enrichmentStartedAt: nowIso,
    enrichmentSource: "resume",
    updatedAt: nowIso,
  })
  const sessionId = "ses_s3_enrichment_hold"
  col(PA_COLLECTIONS.sessions).set(sessionId, {
    id: sessionId,
    userId: UID,
    channel: "imessage",
    externalChatId: PHONE,
    createdAt: nowIso,
    lastMessageAt: nowIso,
  })
  return sessionId
}

function inboundDoc(col, eventId, sessionId, body) {
  col(PA_COLLECTIONS.inboundEvents).set(eventId, {
    id: eventId,
    userId: UID,
    sessionId,
    channel: "imessage",
    externalChatId: PHONE,
    fromNumber: PHONE,
    body,
    status: "pending",
    rawMeta: { source: "imessage_broker", messageHandle: `h_${eventId}` },
  })
}

// resume-e2e ingest deps: REAL ingestCv, parse/LLM seams stubbed (the parse is not what S3 tests).
function ingestDeps(db, col) {
  return {
    db,
    log: () => {},
    fetchPdf: async () => ({
      bytes: new TextEncoder().encode("ADAM-YANG-RESUME-S3-FIXED-BYTES"),
      contentType: "application/pdf",
    }),
    parsePdf: async () => ({
      text: "Adam Yang — Senior Software Engineer at Tesla. React, TypeScript, Node, Go.",
      numPages: 1,
    }),
    llmExtract: async () => ({
      parsed: {
        candidateProfile: {
          name: "Adam Yang",
          email: "adam@example.com",
          phone: PHONE,
          linkedIn: null,
          location: "SF",
          skills: ["React", "TypeScript", "Node", "Go", "Kubernetes"],
        },
        experiences: [
          {
            company: "Tesla",
            title: "Senior Software Engineer",
            startDate: "2022",
            endDate: null,
            location: "SF",
            description:
              "Owned the payments-ledger reconciliation service and cut settlement latency from ~30s to under 2s.",
          },
          {
            company: "Stripe",
            title: "Software Engineer",
            startDate: "2019",
            endDate: "2022",
            location: "SF",
            description: "Built the merchant onboarding API used by 40k+ businesses.",
          },
        ],
        education: [],
        industryTags: ["financial_technology"],
      },
    }),
    isParserV2Enabled: async () => false,
    mem0Add: async () => {},
    computeEmbedding: async () => null,
    writeUserTags: async () => {},
    mergeUserTagsFn: () => ({}),
    findResumeBySha256: async (_db, userId, sha256) => {
      for (const [id, data] of col(RESUME_COLLECTION)) {
        if (data.userId === userId && data.sha256 === sha256) return id
      }
      return null
    },
    findExistingResume: async () => null,
    checkGate: async () => ({ open: true, reason: "ok" }),
    readQuotaCount: async () => 0,
    incrementQuota: async () => {},
    lookupUserForFollowup: async () => ({ toE164: PHONE, mem0UserId: null }),
    runIndustrySecondPassFn: async () => [],
  }
}

function firstHandoffId(col) {
  for (const [id, data] of col(PA_COLLECTIONS.inboundEvents)) {
    if ((data.rawMeta ?? {}).runtimeEventKind === "resume_parse_completed") return id
  }
  return undefined
}

/** Replicate cutover's agent-turn seam (cutover.ts:1073-1137) with a capturing dryRun transport. */
async function runAgentTurnCapturing({ db, decision, sessionId, text, eventId }) {
  const transport = createSendblueTransport({
    db,
    toE164: PHONE,
    userId: UID,
    sessionId,
    inboundEventId: eventId,
    dryRun: true,
  })
  const turnResult = await runClaireTurn(
    { userId: UID, sessionId, text, toE164: PHONE, inboundEventId: eventId, lang: "en" },
    {
      db,
      transport,
      findMatch: makeV16FindMatch(db, undefined, undefined),
      log: () => {},
      mode: decision.mode,
      ...(decision.enrichmentInFlight ? { enrichmentInFlight: true } : {}),
      ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}),
    },
  )
  return {
    bubbles: transport.recordedEvents.filter((e) => e.kind === "text").map((e) => e.value),
    statuses: transport.recordedEvents.filter((e) => e.kind === "status").map((e) => e.value),
    tapbacks: transport.recordedEvents.filter((e) => e.kind === "tapback").map((e) => e.value),
    turnResult,
  }
}

const REAUTH_OR_REUPLOAD_RE =
  /\b(sign in|log ?in|sign up|re-?authenticate|verify (your )?(email|identity)|upload (your |a )?(résumé|resume|cv)|send (me )?(your |a )?(résumé|resume|cv)|re-?send|paste (your |a )?(résumé|resume|cv)|attach (your |a )?(résumé|resume|cv)|drop (your |a )?(résumé|resume|cv))\b/i

async function main() {
  const haveModel = Boolean((process.env.PA_OPENAI_AGENT_API_KEY || process.env.OPENAI_API_KEY || "").trim())
  if (!haveModel) {
    console.error("BLOCKED: no PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY — T2 agent sample + T3 pitch need a model.")
    process.exit(3)
  }
  assert.notEqual(process.env.PA_ONBOARDING_RAMP_ALL, "1", "run without PA_ONBOARDING_RAMP_ALL (canary semantics)")

  const { db, store, col } = makeFirestore()
  const t0 = ts()
  const sessionId = seed(col, t0)

  // ── T1: "hi" while the parse is in flight ─────────────────────────────────────────────────────
  say("USER", "hi", "(parse in flight: enrichmentInFlight=true, enrichmentStartedAt=" + t0 + ")")
  const t1EventId = "evt_s3_hi_1"
  inboundDoc(col, t1EventId, sessionId, "hi")
  const t1Log = []
  const t1Handled = await maybeRunThinClaire(db, t1EventId, { dryRun: true, log: (e) => t1Log.push(e) })

  assert.equal(t1Handled, true, "T1: thin must own the turn")
  const t1Doc = col(PA_COLLECTIONS.inboundEvents).get(t1EventId)
  assert.equal(t1Doc.handledBy, "thin_claire_enrichment_hold", "T1: handled by the deterministic enrichment hold")
  assert.ok(t1Log.includes("thin_claire.enrichment_hold.sent"), "T1: hold-sent log fired")
  // EXACTLY ONE message: the hold path sends ONE sendStatus then short-circuits (return true) BEFORE the
  // pitch engine / agent path — no pitch, no second bubble can exist on this turn (cutover.ts:901-923).
  assert.equal(t1Log.includes("thin_claire.pitch_engine.sent"), false, "T1: NO pitch on the hold turn")
  assert.equal(t1Log.includes("thin_claire_handled"), false, "T1: NO agent turn ran (deterministic short-circuit)")
  const userAfterT1 = col(PA_COLLECTIONS.users).get(UID)
  assert.ok(typeof userAfterT1.enrichmentHoldNoticeAt === "string", "T1: once-only stamp written")
  // The outbound text is the deterministic constant cutover sends verbatim (cutover.ts:915).
  assert.match(ENRICHMENT_HOLD_NOTICE_COPY, /still (pulling|reading)[^.]*background/i, "T1: 'still reading your background' shape")
  assert.equal(REAUTH_OR_REUPLOAD_RE.test(ENRICHMENT_HOLD_NOTICE_COPY), false, "T1: no re-auth / re-upload ask")
  say("CLAIRE", ENRICHMENT_HOLD_NOTICE_COPY, "[deterministic hold — handledBy=thin_claire_enrichment_hold; route: " + t1Log.join(" → ") + "]")

  // ── T2 (supplemental once-only proof): a second mid-enrich message gets NO second hold ────────
  say("USER", "what now?", "(still in flight; once-only claim already spent)")
  const userDocNow = col(PA_COLLECTIONS.users).get(UID)
  assert.equal(shouldSendEnrichmentHoldNotice(userDocNow), false, "T2: hold notice suppressed for this window")
  const secondClaim = await claimEnrichmentHoldNotice(db, UID, ts())
  assert.equal(secondClaim, false, "T2: the exact claim cutover calls returns false → fallthrough to agent")
  const t2EventId = "evt_s3_hi_2"
  inboundDoc(col, t2EventId, sessionId, "what now?")
  const t2Decision = await selectClaireMode({ db, userId: UID, inboundText: "what now?", log: () => {} })
  assert.equal(t2Decision.mode, "triage", "T2: triage mode")
  assert.equal(t2Decision.enrichmentInFlight, true, "T2: agent turn carries the enrichmentInFlight directive")
  const t2 = await runAgentTurnCapturing({ db, decision: t2Decision, sessionId, text: "what now?", eventId: t2EventId })
  const t2Text = [...t2.bubbles, ...t2.statuses].join("\n\n")
  assert.ok(t2Text.trim().length > 0 || t2.tapbacks.length > 0, "T2: candidate is not left in silence")
  assert.equal(REAUTH_OR_REUPLOAD_RE.test(t2Text), false, `T2: no re-auth / re-upload ask — got: ${t2Text}`)
  for (const s of t2.statuses) say("CLAIRE", s, "[T2 agent turn — transient status]")
  for (const b of t2.bubbles) say("CLAIRE", b, "[T2 agent turn with enrichmentInFlight directive (replicated seam, dryRun)]")

  // ── T3: completion — REAL ingestCv → resume_parse_completed handoff → pitch turn ──────────────
  const deps = ingestDeps(db, col)
  const res = await ingestCv({ userId: UID, mediaUrl: "https://example.com/adam-s3.pdf", sessionId }, deps)
  assert.equal(res.ok, true, "T3: ingestCv must succeed")
  const handoffId = firstHandoffId(col)
  assert.ok(handoffId, "T3: REAL producer wrote exactly the resume_parse_completed handoff")
  say("SYSTEM", "[runtime event: resume_parse_completed]", `(REAL ingestCv → enqueueRuntimeEventHandoff, eventId=${handoffId})`)

  // Verbatim pitch capture on a byte-identical CLONE of the store at this exact moment (production sends
  // composePitchTurn's bubbles verbatim — cutover.ts:611-618; independent model sample, same inputs).
  const { db: cloneDb } = makeFirestore(cloneStore(store))
  let pitchBubbles = null
  for (let attempt = 1; attempt <= 3 && !pitchBubbles; attempt++) {
    pitchBubbles = await composePitchTurn(cloneDb, UID)
    if (!pitchBubbles) console.log(`  [composePitchTurn null on attempt ${attempt} — re-sampling]`)
  }

  // Routing proof through the REAL wrapper on the REAL db (clears the marker, fires the pitch engine).
  const t3Log = []
  const t3Routed = await maybeRunThinClaire(db, handoffId, { dryRun: true, log: (e) => t3Log.push(e) })
  assert.equal(t3Routed, true, "T3: completion event must route to thin")
  assert.ok(t3Log.includes("thin_claire.cv_parsed_reentry"), "T3: cv_parsed_reentry fired")
  assert.ok(
    t3Log.includes("thin_claire.pitch_engine.sent"),
    `T3: the PITCH TURN must arrive (pitch_engine.sent) — route: ${t3Log.join(" → ")}`,
  )
  assert.equal(
    col(PA_COLLECTIONS.inboundEvents).get(handoffId).handledBy,
    "thin_claire_pitch_engine",
    "T3: handled by the pitch engine",
  )
  const userAfterT3 = col(PA_COLLECTIONS.users).get(UID)
  assert.equal(userAfterT3.enrichmentInFlight, false, "T3: in-flight marker cleared by the completion re-entry")

  assert.ok(pitchBubbles && pitchBubbles.length >= 1, "T3: composePitchTurn must produce the pitch bubbles")
  const pitchText = pitchBubbles.join("\n\n")
  assert.equal(REAUTH_OR_REUPLOAD_RE.test(pitchText), false, `T3: pitch must not re-ask auth/résumé — got: ${pitchText}`)
  pitchBubbles.forEach((b, i) =>
    say("CLAIRE", b, `[T3 pitch turn bubble ${i + 1}/${pitchBubbles.length} — composePitchTurn on identical clone state]`),
  )
  console.log(`\n  T3 route: ${t3Log.join(" → ")}`)

  console.log("\n✅ S3 PASS: hold once-only → no pitch pre-completion → completion event → pitch turn arrived; marker cleared.")
  // Emit machine-readable transcript for the report writer.
  console.log("\n===TRANSCRIPT-JSON===")
  console.log(JSON.stringify(transcript, null, 2))
}

main().catch((err) => {
  console.error("\n❌ S3 FAIL:", err?.message ?? err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
})
