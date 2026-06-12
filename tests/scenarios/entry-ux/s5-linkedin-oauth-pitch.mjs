/**
 * s5-linkedin-oauth-pitch.mjs — ENTRY-UX PRD round-1 scenario S5: LinkedIn OAuth entry event.
 *
 * Contract under test (PRD §2.1 / §2.2.2 / §3.5, golden baseline B2):
 *   Seed = the LinkedIn OAuth entry event (the EXACT runtime event linkedin-connect-submit.ts emits
 *   after the OAuth callback + Coresignal enrich: eventKind "resume_parse_completed",
 *   source "linkedin_connect", idempotencyKey keyed on the single-use connectToken, context
 *   {cvParsedTrigger, enrichmentSource:"linkedin", linkedinEnriched}).
 *   First Claire message →
 *     1. LinkedIn-source confirmation bubble
 *     2. evidence-backed candidate pitch bubble (composePitchTurn shape)
 *     3. action bubble: pull roles now / tweak
 *   And: NO re-auth ask (no "sign in / log in / connect LinkedIn again").
 *
 * What is REAL here (mirrors the accepted B2/B3 harness pattern in
 * apps/functions/src/claire-agent/__tests__/):
 *   - REAL producer: enqueueRuntimeEventHandoff with the verbatim linkedin-connect-submit input
 *     (incl. the double-callback dedup contract — same connectToken twice → ONE event doc).
 *   - REAL enrichmentInFlight marker set before the event (as the producer does) — the re-entry
 *     must clear it.
 *   - REAL consumer: maybeRunThinClaire (cutover.ts) over that doc, dryRun transport — proves
 *     cv_parsed_reentry routing + thin_claire_pitch_engine handling end-to-end, including the
 *     REAL composePitchTurn gpt-5.4-mini call inside.
 *   - REAL text capture: composePitchTurn(db2, UID) on an identically-seeded second store — the
 *     EXACT function whose [confirmation, pitch, offer] output cutover sends in that order
 *     (cutover.ts pitch-engine block). Same accepted seam-fidelity caveat as B2/B3: the only
 *     thing not literally inside maybeRunThinClaire is the transport-construction line.
 *
 * Seeded profile = the B2 golden-baseline shape (post-LinkedIn-OAuth Coresignal enrich result on
 * pa-users: tags + experienceHighlights; LinkedIn-only, NO parsedCandidateResumes row → the
 * LinkedIn-source confirmation variant is the contractual one).
 *
 * Run (Node 24, from apps/functions, PA_OPENAI_AGENT_API_KEY exported):
 *   node --import tsx ../../tests/scenarios/entry-ux/s5-linkedin-oauth-pitch.mjs
 */
import assert from "node:assert/strict"
import { enqueueRuntimeEventHandoff } from "../../../apps/functions/src/runtime-event-handoff.js"
import { maybeRunThinClaire } from "../../../apps/functions/src/claire-agent/cutover.js"
import { composePitchTurn } from "../../../apps/functions/src/claire-agent/compose-pitch.js"
import { setEnrichmentInFlight } from "../../../apps/functions/src/claire-agent/enrichment-inflight.js"

const UID = "8fEwIduUrzxZsblHHsNz" // canary dev phone (isCanaryUser → true; cv_parsed_reentry is canary-gated)
const PHONE = "+14243201960"
const CONNECT_TOKEN = "tok_s5_oauth_single_use_abc123" // the single-use connectToken (idempotency key source)
const THIN_FLAG_KEY = "paThinClaireEnabled"
const USERS = "pa-users"
const INBOUND = "pa-inbound-events"

// ── in-memory Firestore (mirrors resume-e2e-text-capture.mjs stub) ────────────────────────────────
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
          const actual = field.includes(".")
            ? field.split(".").reduce((o, k) => o?.[k], data)
            : data[field]
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
      select() {
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
          const docId = id ?? `auto_${name}_${++autoId}`
          return {
            id: docId,
            async get() {
              const data = col(name).get(docId)
              return { exists: data !== undefined, id: docId, data: () => data }
            },
            async set(data, opts) {
              col(name).set(docId, opts?.merge ? { ...(col(name).get(docId) ?? {}), ...data } : { ...data })
            },
            async update(data) {
              col(name).set(docId, { ...(col(name).get(docId) ?? {}), ...data })
            },
            async create(data) {
              if (col(name).has(docId)) {
                const err = new Error("ALREADY_EXISTS")
                err.code = 6
                throw err
              }
              col(name).set(docId, { ...data })
            },
            collection(sub) {
              return db.collection(`${name}/${docId}/${sub}`)
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
  return { db, col }
}

/** Seed = thin flag ON (perUser allowlist) + the post-LinkedIn-OAuth ENRICHED pa-users doc.
 *  Profile shape = the B2 golden baseline (canonical-loop-e2e.mjs seed): Coresignal enrich result —
 *  tags + experienceHighlights, LinkedIn bind markers, NO parsedCandidateResumes (LinkedIn-only). */
function seed(col) {
  col("pa-feature-flags").set(THIN_FLAG_KEY, {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [UID],
    blocklist: [],
  })
  col(USERS).set(UID, {
    id: UID,
    phoneE164: PHONE,
    displayName: "Adam Yang",
    // LinkedIn OAuth identity bind — what the OAuth callback leaves on the doc.
    linkedinOauthLinked: true,
    linkedinOauthSub: "li_sub_s5_test",
    linkedinUrl: "https://www.linkedin.com/in/adam-yang-s5-test",
    onboardingStatus: "invited",
    tags: {
      careerStage: "senior",
      yoeRange: [3, 5],
      targetRoleFunction: ["software_engineering"],
      industrySector: ["automotive"],
      recentRoleTitle: "Senior Software Engineer",
      recentCompany: "Tesla",
      visaStatus: "citizen",
      skills: [{ name: "TypeScript" }, { name: "Kubernetes" }, { name: "Azure" }, { name: "CI/CD" }],
      experienceHighlights: [
        {
          title: "Senior Software Engineer",
          company: "Tesla",
          description:
            "Built the V&C internal portfolio used by 300+ stores; led an Azure backend migration; CI/CD on Kubernetes/Docker.",
          durationMonths: 12,
          companyIndustry: "automotive",
        },
        {
          title: "Founder",
          company: "aiStudy",
          description: "LLM/RAG knowledge-tracing model, +10% AUC.",
          durationMonths: 5,
          companyIndustry: "education",
        },
      ],
    },
  })
}

/** The VERBATIM producer call from linkedin-connect-submit.ts (OAuth callback, post-enrich). */
async function emitLinkedinOauthEntryEvent(db) {
  return enqueueRuntimeEventHandoff(db, {
    userId: UID,
    toE164: PHONE,
    source: "linkedin_connect",
    eventKind: "resume_parse_completed",
    idempotencyKey: `linkedin-oauth-enriched:${UID}:${CONNECT_TOKEN}`,
    requireExistingSession: false,
    context: { cvParsedTrigger: true, enrichmentSource: "linkedin", linkedinEnriched: true },
  })
}

const ts = () => new Date().toISOString()

async function main() {
  const haveModel = Boolean((process.env.PA_OPENAI_AGENT_API_KEY || "").trim())
  if (!haveModel) {
    console.error("BLOCKED: PA_OPENAI_AGENT_API_KEY missing — composePitchTurn (gpt-5.4-mini) needs it.")
    process.exit(3)
  }

  // ── STORE 1: full REAL seam (producer → routing → pitch engine inside maybeRunThinClaire) ───────
  const { db, col } = makeFirestore()
  seed(col)

  // Producer sets the in-flight marker before the enrich (linkedin-connect-submit.ts) — the
  // re-entry must clear it.
  await setEnrichmentInFlight(db, UID, "linkedin", ts())
  assert.equal(col(USERS).get(UID).enrichmentInFlight, true, "precondition: in-flight marker set")

  console.log(`[${ts()}] SEED: LinkedIn OAuth entry — emitting the linkedin_connect runtime event (REAL producer)`)
  const first = await emitLinkedinOauthEntryEvent(db)
  assert.equal(first.ok, true, "producer: handoff must enqueue")
  assert.equal(first.created, true, "producer: first callback creates the event doc")

  // LinkedIn double-callback (live bug class, memory: linkedin_double_callback_dedup) — the 2nd
  // callback of the SAME login reuses the SAME connectToken → MUST dedup to the same doc.
  const second = await emitLinkedinOauthEntryEvent(db)
  assert.equal(second.ok, true, "producer: second callback still ok")
  assert.equal(second.created, false, "producer: second callback DEDUPED (no second event doc)")
  const runtimeDocs = [...col(INBOUND).values()].filter(
    (d) => d?.rawMeta?.runtimeEventKind === "resume_parse_completed",
  )
  assert.equal(runtimeDocs.length, 1, "producer: exactly ONE resume_parse_completed doc after double callback")

  console.log(`[${ts()}] CONSUMER: maybeRunThinClaire over ${first.eventId} (dryRun transport, REAL pitch engine)`)
  const routeEvents = []
  const handled = await maybeRunThinClaire(db, first.eventId, {
    dryRun: true,
    log: (e, p) => routeEvents.push([e, p]),
  })
  const routeNames = routeEvents.map(([e]) => e)
  assert.equal(handled, true, "consumer: the LinkedIn entry event MUST be handled by thin")
  assert.ok(routeNames.includes("thin_claire.cv_parsed_reentry"), "consumer: cv_parsed_reentry fired")
  assert.equal(
    routeNames.includes("thin_claire.defer_runtime_event"),
    false,
    "consumer: must NOT defer to legacy",
  )
  const pitchSent = routeEvents.find(([e]) => e === "thin_claire.pitch_engine.sent")
  assert.ok(pitchSent, "consumer: pitch engine SENT (not fallback, not agent path)")
  assert.equal(pitchSent[1]?.bubbles, 3, "consumer: pitch engine sent exactly 3 bubbles")
  assert.equal(
    col(INBOUND).get(first.eventId)?.handledBy,
    "thin_claire_pitch_engine",
    "consumer: handledBy thin_claire_pitch_engine",
  )
  assert.notEqual(
    col(USERS).get(UID).enrichmentInFlight,
    true,
    "consumer: re-entry cleared the enrichmentInFlight marker",
  )
  console.log(`[${ts()}] routing proof OK: ${routeNames.join(" → ")}`)

  // ── STORE 2: capture the VERBATIM bubble text via the EXACT composer cutover sends ──────────────
  // (composePitchTurn returns [confirmation, pitch, offer]; cutover.ts sends them in that order.)
  let bubbles = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { db: db2, col: col2 } = makeFirestore()
    seed(col2)
    bubbles = await composePitchTurn(db2, UID)
    if (Array.isArray(bubbles) && bubbles.length === 3) break
    console.log(`  [text attempt ${attempt} bad sample (${bubbles ? bubbles.length : "null"}) — re-sampling]`)
    bubbles = null
  }
  assert.ok(bubbles, "text: composePitchTurn must compose (3 attempts)")
  const stamp = ts()
  console.log(`\n[${stamp}] ── S5 FIRST CLAIRE MESSAGE (verbatim bubbles, in send order) ──`)
  bubbles.forEach((b, i) => console.log(`  bubble${i + 1}: ${b.replace(/\n/g, " ⏎ ")}`))

  // ── S5 CONTRACT ASSERTIONS ───────────────────────────────────────────────────────────────────
  const [confirmation, pitch, offer] = bubbles
  const all = bubbles.join("\n").toLowerCase()

  // 1. LinkedIn-source confirmation (LinkedIn-only profile → must credit LinkedIn, not a résumé).
  assert.ok(/linkedin/i.test(confirmation), `S5: confirmation must credit LinkedIn — got: ${confirmation}`)
  assert.equal(
    /résumé|resume/i.test(confirmation),
    false,
    `S5: confirmation must NOT claim a résumé read (LinkedIn-only entry) — got: ${confirmation}`,
  )

  // 2. Evidence-backed pitch. NOTE: the pitch-engine guide (compose-pitch.ts PITCH_SYSTEM, P1 rule)
  // REQUIRES a founder signal to lead line 1 over the senior IC title, so the seeded profile's
  // "Founder @ aiStudy" legitimately leads and "Tesla" may live in the confirmation bubble instead.
  // Contract = pitch cites REAL profile evidence (employer / metric / system), and Tesla appears
  // somewhere in the 3-bubble turn (B2 golden anchor).
  const evidenceRe = /tesla|aistudy|v&c|300\+|azure|kubernetes|docker|auc|llm|rag/i
  assert.ok(evidenceRe.test(pitch), `S5: pitch must cite real profile evidence — got: ${pitch}`)
  assert.ok(/tesla/i.test(all), `S5/B2: the turn must cite Tesla somewhere — got: ${bubbles.join(" | ")}`)

  // 3. Action bubble: pull-roles / tweak.
  assert.ok(
    /(pull|find|grab|send|match).*(role|match|job)|(role|match|job).*(now|fit)/i.test(offer),
    `S5: offer must propose pulling roles/matches — got: ${offer}`,
  )

  // 4. NO re-auth ask anywhere (PRD §3.5: never re-auth a signed-in candidate).
  const reauthRe =
    /\b(sign in|sign-in|log in|log-in|login|re-?auth\w*|re-?connect|connect (your |to )?linkedin|linkedin (login|sign[- ]?in)|magic link|verify your (email|identity|account)|authenticate)\b/i
  assert.equal(reauthRe.test(all), false, `S5: NO re-auth ask allowed — got: ${bubbles.join(" | ")}`)
  // Also: no resume re-upload DEMAND on this turn (an optional "sharpen with a résumé" offer is the
  // contracted improvement ask and is allowed; a directive "send/upload your resume" is not).
  const uploadDemandRe = /\b(please (send|upload)|need (your |a )?(résumé|resume|cv)|upload (your |a )?(résumé|resume|cv) (first|to continue|before))\b/i
  assert.equal(uploadDemandRe.test(all), false, `S5: no résumé-upload demand — got: ${bubbles.join(" | ")}`)

  // B2 non-regression notes (soft dimensions, reported not hard-asserted beyond Tesla):
  const dims = {
    seniority: /senior|staff|lead|founder|yrs|years/i.test(pitch),
    track: /software|engineer|backend|platform|infra|swe/i.test(pitch),
    evidence: /tesla|aistudy|300\+|azure|kubernetes|auc/i.test(pitch),
  }
  console.log(`\n  pitch dimensions → seniority:${dims.seniority} track:${dims.track} evidence:${dims.evidence}`)

  console.log("\n✅ S5 PASS: LinkedIn OAuth entry event → cv_parsed_reentry → pitch engine 3-bubble turn")
  console.log("   [confirmation credits LinkedIn] [pitch cites real evidence] [offer = pull roles/tweak] [no re-auth ask] [double-callback deduped] [in-flight marker cleared]")
  // machine-readable tail for the transcript writer
  console.log("\n__S5_BUBBLES_JSON__=" + JSON.stringify({ stamp, bubbles, routeNames, dims }))
}

main().catch((err) => {
  console.error("\n❌ S5 FAIL:", err?.message ?? err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
})
