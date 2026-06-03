/**
 * pitch-loop.mjs — REAL-MODEL postParsePitch JUDGE LOOP.
 *
 * Drives the EXACT production pitch seam (REAL ingestCv → REAL enqueueRuntimeEventHandoff → REAL
 * selectClaireMode(cvParsedTrigger) → REAL runClaireTurn(postParsePitch) with a capturing transport and
 * a REAL gpt-5.4-nano) N times against a seeded senior-eng fintech/payments parsed profile that carries
 * a numbered OWNED outcome, then scores every sample with an LLM JUDGE.
 *
 * A sample is CLEAN iff the JUDGE finds ALL of:
 *   - cites SENIORITY (level grounded in the arc, not 'experienced')
 *   - cites INDUSTRY / career-track (the fintech/payments arc, named)
 *   - cites SKILLS→IMPACT with an OWNED outcome (the system + its number, e.g. ~30s→2s)
 *   - cites real EXPERIENCE (the actual companies/roles)
 *   - does NOT ask the candidate to paste/share/upload/send/drop their résumé
 *   - is NOT a tapback-only turn (must be text bubbles)
 *
 * Run (Node 24, from apps/functions, with PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY exported):
 *   node --import tsx src/claire-agent/__tests__/pitch-loop.mjs --samples 10 [--out /tmp/pitch-loop.json]
 *
 * This is a LOOP harness (samples + judge + report) — it does NOT mutate the directive. The agent edits
 * PITCH_KICKOFF_DIRECTIVE in prompt.ts between rounds and re-runs this to read the clean rate.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import { PA_COLLECTIONS } from "@pa/core-types"
import OpenAI from "openai"
import { ingestCv } from "../../cv-ingest/cv-ingest.js"
import { maybeRunThinClaire } from "../cutover.js"
import { selectClaireMode } from "../mode-selector.js"
import { runClaireTurn } from "../agent.js"
import { createSendblueTransport } from "../transport.js"
import { makeV16FindMatch } from "../tools/matching-tools.js"

const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // Adam dev phone +14243201960 (isCanaryUser → true)
const PHONE = "+14243201960"
const THIN_FLAG_KEY = "paThinClaireEnabled"
const RESUME_COLLECTION = "parsedCandidateResumes"

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function argVal(name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const SAMPLES = Number(argVal("--samples", "10"))
const OUT = argVal("--out", "")

// ── Rich in-memory Firestore (mirrors resume-e2e-text-capture.mjs's stub) ─────────────────────────
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

function seedThinFlag(col, uid) {
  col("pa-feature-flags").set(THIN_FLAG_KEY, {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [uid],
    blocklist: [],
  })
}

/**
 * Seeded senior-eng FINTECH/PAYMENTS arc with a numbered OWNED outcome in BOTH the global tags
 * (experienceHighlights) AND a parsedCandidateResumes row — the exact two surfaces loadGlobalContext
 * + the parsed-resume fallback read. This is the "senior-eng parsed profile (seniority + a
 * fintech/payments arc + an owned numbered outcome)" the loop is required to drive.
 */
function seedUserWithProfile(col, uid) {
  col(PA_COLLECTIONS.users).set(uid, {
    id: uid,
    phoneE164: PHONE,
    displayName: "Priya Nair",
    onboardingStatus: "invited",
    sharedOnboarding: {
      status: "active",
      completed: false,
      currentQuestionId: "target_role",
      questionOrder: ["main_goal", "target_role", "location_relocation"],
      answers: { main_goal: "find a new job" },
    },
    tags: {
      careerStage: "senior",
      yoeRange: [7, 9],
      targetRoleFunction: ["software_engineering"],
      industrySector: ["financial_technology"],
      relevantIndustry: ["financial_technology", "developer_tools"],
      recentRoleTitle: "Senior Software Engineer",
      recentCompany: "Stripe",
      workHistorySummary:
        "Grew from a backend engineer into a senior SWE over ~8 years across payments infrastructure — Block then Stripe — owning ledger + settlement systems at scale.",
      visaStatus: "citizen",
      targetLocations: ["san_francisco", "remote"],
      skills: [
        { name: "Go" },
        { name: "TypeScript" },
        { name: "distributed systems" },
        { name: "Kafka" },
        { name: "PostgreSQL" },
      ],
      experienceHighlights: [
        {
          title: "Senior Software Engineer",
          company: "Stripe",
          description:
            "Owned the payments-ledger reconciliation service and cut settlement latency from ~30s to under 2s, handling 8k transactions/sec at peak.",
          durationMonths: 40,
          companyIndustry: "financial_technology",
        },
        {
          title: "Software Engineer",
          company: "Block",
          description:
            "Built the merchant payouts pipeline that moved $2B+/yr and reduced failed-payout retries by 35%.",
          durationMonths: 44,
          companyIndustry: "financial_technology",
        },
      ],
    },
  })
}

function seedParsedResume(col, uid) {
  col(RESUME_COLLECTION).set("pcr_seed_priya", {
    userId: uid,
    sha256: "seed-sha-priya",
    createdAt: "2026-06-02T00:00:00.000Z",
    experiences: [
      {
        company: "Stripe",
        title: "Senior Software Engineer",
        startDate: "2021",
        endDate: null,
        location: "SF",
        description:
          "Owned the payments-ledger reconciliation service and cut settlement latency from ~30s to under 2s, handling 8k transactions/sec at peak.",
      },
      {
        company: "Block",
        title: "Software Engineer",
        startDate: "2017",
        endDate: "2021",
        location: "SF",
        description:
          "Built the merchant payouts pipeline that moved $2B+/yr and reduced failed-payout retries by 35%.",
      },
    ],
  })
}

function seedSession(col, uid) {
  const sessionId = "ses_pitch_loop"
  col(PA_COLLECTIONS.sessions).set(sessionId, {
    id: sessionId,
    userId: uid,
    channel: "imessage",
    externalChatId: PHONE,
    createdAt: "2026-06-02T00:00:00.000Z",
    lastMessageAt: "2026-06-02T00:00:00.000Z",
  })
  return sessionId
}

function ingestDeps(db, col) {
  return {
    db,
    log: () => {},
    fetchPdf: async () => ({
      bytes: new TextEncoder().encode("PRIYA-NAIR-RESUME-BYTES"),
      contentType: "application/pdf",
    }),
    parsePdf: async () => ({
      text: "Priya Nair — Senior Software Engineer at Stripe. Go, TypeScript, distributed systems, Kafka.",
      numPages: 1,
    }),
    llmExtract: async () => ({
      parsed: {
        candidateProfile: {
          name: "Priya Nair",
          email: "priya@example.com",
          phone: PHONE,
          linkedIn: null,
          location: "SF",
          skills: ["Go", "TypeScript", "distributed systems", "Kafka", "PostgreSQL"],
        },
        experiences: [
          {
            company: "Stripe",
            title: "Senior Software Engineer",
            startDate: "2021",
            endDate: null,
            location: "SF",
            description:
              "Owned the payments-ledger reconciliation service and cut settlement latency from ~30s to under 2s, handling 8k transactions/sec at peak.",
          },
          {
            company: "Block",
            title: "Software Engineer",
            startDate: "2017",
            endDate: "2021",
            location: "SF",
            description:
              "Built the merchant payouts pipeline that moved $2B+/yr and reduced failed-payout retries by 35%.",
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
    const meta = data.rawMeta ?? {}
    if (meta.runtimeEventKind === "resume_parse_completed") return id
  }
  return undefined
}

/** Replicate cutover's transport+turn for the pitch decision, capturing the recorded bubbles. */
async function runPitchTurnCapturing({ db, decision, userId, sessionId, text, eventId, postParsePitchSummary }) {
  const transport = createSendblueTransport({
    db,
    toE164: PHONE,
    userId,
    sessionId,
    inboundEventId: eventId,
    dryRun: true,
  })
  const turnResult = await runClaireTurn(
    {
      userId,
      sessionId,
      text,
      toE164: PHONE,
      inboundEventId: eventId,
      lang: "en",
    },
    {
      db,
      transport,
      findMatch: makeV16FindMatch(db, undefined, undefined),
      log: () => {},
      mode: decision.mode,
      ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
      ...(decision.currentStep ? { currentStep: decision.currentStep } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}),
      ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
      ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}),
      ...(decision.postParsePitch ? { postParsePitch: true } : {}),
      ...(decision.postParsePitch && postParsePitchSummary ? { postParsePitchSummary } : {}),
    },
  )
  const bubbles = transport.recordedEvents.filter((e) => e.kind === "text").map((e) => e.value)
  const statuses = transport.recordedEvents.filter((e) => e.kind === "status").map((e) => e.value)
  const tapbacks = transport.recordedEvents.filter((e) => e.kind === "tapback").map((e) => e.value)
  return { bubbles, statuses, tapbacks, all: transport.recordedEvents, turnResult }
}

// ── JUDGE ─────────────────────────────────────────────────────────────────────────────────────
const JUDGE_MODEL = (process.env.PA_PITCH_JUDGE_MODEL || "gpt-5.4-nano").trim()
const judgeClient = new OpenAI({
  apiKey: (process.env.PA_OPENAI_AGENT_API_KEY || process.env.OPENAI_API_KEY || "").trim(),
})

const JUDGE_SYSTEM = [
  "You are a strict QA judge for a recruiter chatbot's post-résumé-parse opener pitch.",
  "The candidate just had their résumé parsed. The PROFILE the bot was given is provided below.",
  "Score the bot's two-bubble pitch on whether it actually USES that profile. Return STRICT JSON only.",
  "",
  "A pitch is CLEAN only if ALL SIX criteria pass:",
  "1. seniority: it names the candidate's LEVEL grounded in their arc (e.g. 'senior engineer ~8 yrs',",
  "   a climb from junior→senior). NOT just the vague word 'experienced'. PASS if a concrete level is named.",
  "2. industry_track: it names the DOMAIN / career track they've built in (here: fintech / payments /",
  "   financial infra / dev-tools). PASS if the domain is named, not generic 'tech'.",
  "3. skills_impact: it cites at least ONE OWNED outcome from the profile — a specific system the candidate",
  "   owned/built AND its number (e.g. settlement latency ~30s→under 2s, 8k tx/sec, $2B+/yr, 35% fewer",
  "   retries). FAIL if it only lists skills (Go, Kafka) with no owned outcome, or invents a number not in",
  "   the profile.",
  "4. experience: it names the REAL companies/roles from the profile (Stripe and/or Block). FAIL if it",
  "   names no real employer or invents one.",
  "5. no_paste_request: it does NOT ask the candidate to PASTE, SHARE, SEND, UPLOAD, ATTACH, or 'DROP'",
  "   their RÉSUMÉ / CV, and does NOT say it can't see the résumé / is still loading it / needs them to",
  "   provide it. This criterion is ONLY about the candidate's RÉSUMÉ/CV. It is NOT violated by: asking a",
  "   normal clarifying question about roles/industries/preferences; offering a link to view or change",
  "   their preferences (e.g. 'view/change your prefs at wekruit.com'); or any other non-résumé request.",
  "   PASS unless the bot specifically asks for the candidate's RÉSUMÉ/CV document. A prefs link or a",
  "   clarifier question alone is PASS.",
  "6. not_tapback_only: the response is a real text pitch (provided), not an empty/emoji-only reaction.",
  "   (You will always receive text here; FAIL only if the text is empty or purely an emoji with no pitch.)",
  "",
  "Return JSON: {",
  '  "seniority": bool, "industry_track": bool, "skills_impact": bool, "experience": bool,',
  '  "no_paste_request": bool, "not_tapback_only": bool,',
  '  "clean": bool,  // true iff ALL SIX above are true',
  '  "owned_outcome_cited": string,  // the exact owned-outcome phrase you found, or "" if none',
  '  "reason": string  // one sentence: if not clean, which criterion failed and why',
  "}",
].join("\n")

async function judgePitch({ profileSummary, pitchText, tapbackOnly }) {
  if (tapbackOnly || !pitchText.trim()) {
    return {
      seniority: false,
      industry_track: false,
      skills_impact: false,
      experience: false,
      no_paste_request: false,
      not_tapback_only: false,
      clean: false,
      owned_outcome_cited: "",
      reason: "tapback-only / empty turn — no text pitch was sent",
    }
  }
  const user = [
    "PROFILE GIVEN TO THE BOT:",
    profileSummary,
    "",
    "BOT PITCH (two bubbles, joined):",
    pitchText,
  ].join("\n")
  const resp = await judgeClient.chat.completions.create({
    model: JUDGE_MODEL,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  })
  const raw = resp.choices?.[0]?.message?.content ?? "{}"
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = { clean: false, reason: `judge returned non-JSON: ${raw.slice(0, 120)}` }
  }
  // Recompute clean deterministically from the six booleans so a stray "clean" can't disagree.
  const six = ["seniority", "industry_track", "skills_impact", "experience", "no_paste_request", "not_tapback_only"]
  parsed.clean = six.every((k) => parsed[k] === true)
  return parsed
}

const PROFILE_SUMMARY_FOR_JUDGE = [
  "Name: Priya Nair. Level: SENIOR software engineer, ~7-9 years. Domain/track: fintech / payments infrastructure.",
  "Companies: Stripe (current, Senior SWE), Block (prior, SWE).",
  "Owned outcomes:",
  "  - Stripe: owned the payments-ledger reconciliation service; cut settlement latency from ~30s to under 2s; 8k transactions/sec at peak.",
  "  - Block: built the merchant payouts pipeline moving $2B+/yr; reduced failed-payout retries by 35%.",
  "Skills: Go, TypeScript, distributed systems, Kafka, PostgreSQL. Target role: software_engineering. US citizen, SF / remote.",
].join("\n")

async function main() {
  const haveModel = Boolean((process.env.PA_OPENAI_AGENT_API_KEY || process.env.OPENAI_API_KEY || "").trim())
  if (!haveModel) {
    console.error("BLOCKED: no PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY in env — cannot drive a REAL pitch.")
    process.exit(3)
  }

  // Build the REAL handoff ONCE (deterministic producer), reuse the same DB for every pitch sample so the
  // turn is composed against the exact same context production has.
  const { db, col } = makeFirestore()
  seedThinFlag(col, CANARY_UID)
  seedUserWithProfile(col, CANARY_UID)
  seedParsedResume(col, CANARY_UID)
  const sessionId = seedSession(col, CANARY_UID)

  const deps = ingestDeps(db, col)
  const res = await ingestCv({ userId: CANARY_UID, mediaUrl: "https://example.com/priya.pdf", sessionId }, deps)
  assert.equal(res.ok, true, "ingestCv must succeed")
  const handoffId = firstHandoffId(col)
  assert.ok(handoffId, "exactly one resume_parse_completed handoff produced by the REAL producer")
  const handoffDoc = col(PA_COLLECTIONS.inboundEvents).get(handoffId)

  // Route check through the REAL wrapper (proves cv_parsed_reentry, not defer).
  const routeEvents = []
  const routed = await maybeRunThinClaire(db, handoffId, { dryRun: true, log: (e) => routeEvents.push(e) })
  assert.equal(routed, true, "cv-parsed MUST route to thin")
  assert.ok(routeEvents.includes("thin_claire.cv_parsed_reentry"), "cv_parsed_reentry fired")

  const pitchDecision = await selectClaireMode({
    db,
    userId: CANARY_UID,
    inboundText: "[resume just finished parsing]",
    cvParsedTrigger: true,
    log: () => {},
  })
  assert.equal(pitchDecision.postParsePitch, true, "mode decision sets postParsePitch")

  const handoffSummary = (() => {
    const c = handoffDoc.rawMeta?.context ?? {}
    return typeof c.candidateProfileSummary === "string" ? c.candidateProfileSummary.trim() : ""
  })()

  console.log(`\n=== PITCH LOOP: ${SAMPLES} samples, judge=${JUDGE_MODEL} ===`)
  console.log(`[handoff summary]: ${handoffSummary || "(none)"}\n`)

  const samples = []
  let cleanCount = 0
  for (let i = 1; i <= SAMPLES; i++) {
    let cap
    // gpt-5.4-nano occasionally returns an empty draft (model flake). Re-sample up to 2x for a non-empty
    // turn so an empty draw doesn't masquerade as a directive failure; a persistently-empty turn DOES
    // count as not-clean (judged tapbackOnly=false but empty text → judge fails it).
    for (let attempt = 1; attempt <= 2; attempt++) {
      cap = await runPitchTurnCapturing({
        db,
        decision: pitchDecision,
        userId: CANARY_UID,
        sessionId,
        text: handoffDoc.body ?? "[resume just finished parsing]",
        eventId: handoffId,
        postParsePitchSummary: handoffSummary,
      })
      if (cap.bubbles.length >= 1) break
    }
    const pitchText = cap.bubbles.join("\n\n")
    const tapbackOnly = cap.bubbles.length === 0 && (cap.tapbacks.length > 0 || cap.turnResult?.deliveredViaTool === true)
    // DETERMINISTIC cross-check on the REAL production failure (the exact regex resume-e2e-text-capture.mjs
    // asserts): does the pitch literally ask the candidate to paste/share/upload/send/drop their résumé?
    // This guards the LLM judge from BOTH over-failing (a benign prefs link) and under-failing (a real
    // paste-ask the model rationalizes away). Reported next to the judge so any disagreement is visible.
    const asksToPasteRegex =
      /\b(paste|upload|send (me )?(your )?(résumé|resume|cv)|share (your )?(résumé|resume|cv)|drop (your )?(résumé|resume|cv)|attach (your )?(résumé|resume|cv))\b/i.test(
        pitchText,
      )
    const verdict = await judgePitch({ profileSummary: PROFILE_SUMMARY_FOR_JUDGE, pitchText, tapbackOnly })
    verdict.asksToPasteRegex = asksToPasteRegex
    // If the deterministic regex proves a real paste-ask, force no_paste_request false (judge cannot
    // overrule a literal "send me your resume"). This keeps the clean rate honest in the strict direction.
    if (asksToPasteRegex) {
      verdict.no_paste_request = false
      verdict.clean = false
    }
    if (verdict.clean) cleanCount++
    samples.push({ i, pitchText, tapbacks: cap.tapbacks, statuses: cap.statuses, deliveredViaTool: cap.turnResult?.deliveredViaTool === true, verdict })
    const flag = verdict.clean ? "CLEAN ✅" : "DIRTY ❌"
    console.log(`--- sample ${i}/${SAMPLES} — ${flag} ---`)
    console.log(`  pitch: ${pitchText.replace(/\n+/g, " ⏎ ")}`)
    const fails = ["seniority", "industry_track", "skills_impact", "experience", "no_paste_request", "not_tapback_only"]
      .filter((k) => verdict[k] !== true)
    if (fails.length) console.log(`  FAILS: ${fails.join(", ")} — ${verdict.reason}`)
    else console.log(`  owned outcome cited: ${verdict.owned_outcome_cited}`)
    console.log(`  [deterministic paste-ask regex: ${verdict.asksToPasteRegex ? "TRUE (real paste-ask!)" : "false"}]`)
    console.log("")
  }

  const rate = `${cleanCount}/${SAMPLES}`
  const barMet = cleanCount >= Math.ceil(SAMPLES * 0.8)
  console.log("==================================================")
  console.log(`CLEAN RATE: ${rate}  (bar = ${Math.ceil(SAMPLES * 0.8)}/${SAMPLES})  ${barMet ? "✅ BAR MET" : "❌ below bar"}`)
  // Per-criterion tally to guide the next directive edit.
  const tally = {}
  for (const k of ["seniority", "industry_track", "skills_impact", "experience", "no_paste_request", "not_tapback_only"]) {
    tally[k] = samples.filter((s) => s.verdict[k] === true).length
  }
  console.log(`per-criterion (of ${SAMPLES}): ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join("  ")}`)
  console.log("==================================================")

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({ rate, cleanCount, samples: SAMPLES, barMet, tally, results: samples }, null, 2))
    console.log(`\n[wrote ${OUT}]`)
  }
}

main().catch((err) => {
  console.error("\n❌ HARNESS FAIL:", err?.message ?? err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
})
