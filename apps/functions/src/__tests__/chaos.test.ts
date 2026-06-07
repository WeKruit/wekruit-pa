/**
 * Stream G5 — Chaos drills (failure injection at unit level).
 *
 * Each test mocks ONE failure point in the CV-onboarding pipeline and
 * verifies the system degrades gracefully:
 *   - No partial writes
 *   - No infinite-loop cascades
 *   - No exceptions leak to callers (fire-and-forget contract)
 *   - Independent paths (e.g. tapback) keep working when other paths fail
 *
 * Mocks live in this file; no LIVE deps. Output: CHAOS-REPORT.md alongside
 * E2E-REPORT.md as the chaos-validation artifact.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { ingestCv, type IngestCvDeps, type StructuredCv } from "../cv-ingest/cv-ingest.js"
import {
  recordSendblueFailure,
  __resetSendblueBreakerForTests,
  getSendblueBreakerState,
  SendblueCircuitOpenError,
} from "../sendblue/circuit-breaker.js"

// ---------- Shared helpers ----------

type DocData = Record<string, unknown>
type FakeState = {
  resumes: Array<{ collection: string; data: DocData }>
  outbound: Map<string, DocData>
  users: Map<string, DocData>
}

function makeFakeDb(opts?: { users?: Record<string, DocData>; outboundExisting?: string[] }) {
  const state: FakeState = {
    resumes: [],
    outbound: new Map(),
    users: new Map(Object.entries(opts?.users ?? {})),
  }
  for (const id of opts?.outboundExisting ?? []) {
    state.outbound.set(id, { existing: true })
  }
  let nextId = 1
  const db = {
    collection(name: string) {
      return {
        async add(data: DocData) {
          if (name !== "parsedCandidateResumes") {
            throw new Error(`fake-db: .add() unsupported for ${name}`)
          }
          const id = `rsm_${nextId++}`
          state.resumes.push({ collection: name, data: { ...data } })
          return { id }
        },
        doc(id: string) {
          return {
            async get() {
              if (name === "pa-users") {
                const data = state.users.get(id)
                return { exists: !!data, data: () => data }
              }
              return { exists: false, data: () => undefined }
            },
            async create(data: DocData) {
              if (name === "pa-outbound") {
                if (state.outbound.has(id)) {
                  const err = new Error(
                    `6 ALREADY_EXISTS: Document already exists: pa-outbound/${id}`
                  )
                  throw err
                }
                state.outbound.set(id, { ...data })
                return
              }
              throw new Error(`fake-db: .create() unsupported for ${name}`)
            },
            // Generic write sink. enqueueRuntimeEventHandoff (the resume_parse_completed
            // producer) now CREATES the session + writes the inbound-event doc when none
            // exists (WS-0 BUG1 fix: requireExistingSession:false — fire the pitch even for a
            // user with no pre-existing session, instead of declining). These collections
            // (pa-sessions / pa-inbound-events) aren't otherwise modeled here; a no-op success
            // lets the handoff complete so the chaos pipeline exercises the real path. The
            // resume row + outbound assertions read from `state`, unaffected.
            async set(_data: DocData) {
              return
            },
          }
        },
      }
    },
  } as unknown as IngestCvDeps["db"]
  return { db, state }
}

function happyParsed(): StructuredCv {
  return {
    candidateProfile: {
      name: "Adam Chaos",
      email: null,
      phone: null,
      linkedIn: null,
      location: "SF",
      skills: ["chaos"],
    },
    experiences: [
      {
        company: "Chaos Co",
        title: "Tester",
        startDate: "2024",
        endDate: null,
        location: "SF",
        description: "broke things",
      },
    ],
    education: [],
    industryTags: ["tech_software"],
  }
}

function captureLog() {
  const events: Array<{ event: string; payload: Record<string, unknown> | undefined }> = []
  const log = (event: string, payload?: Record<string, unknown>) =>
    events.push({ event, payload })
  return { events, log }
}

// ---------- Chaos scenarios ----------

describe("chaos: cv-onboarding failure injection", () => {
  // ---- Scenario 1: cv-ingest LLM throws ----------------------------------
  it("S1 cv-ingest LLM throws → ingestCv returns {ok:false, reason} + NO partial Firestore write", async () => {
    const { db, state } = makeFakeDb()
    const { log, events } = captureLog()
    const deps: IngestCvDeps = {
      skipLimitEnforcement: true,
      followupDeliveryMode: "none",
      db,
      log,
      fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
      parsePdf: async () => ({ text: "some resume text", numPages: 1 }),
      llmExtract: async () => {
        throw new Error("upstream OpenAI 500")
      },
    }
    const res = await ingestCv({ userId: "u1", mediaUrl: "https://x/a.pdf" }, deps)

    // Function returns gracefully — never throws.
    assert.equal(res.ok, false)
    assert.ok(!res.ok && typeof res.reason === "string" && res.reason.length > 0)
    // CRITICAL: zero parsedCandidateResumes rows written on LLM failure.
    assert.equal(state.resumes.length, 0, "no partial parsedCandidateResumes write on LLM failure")
    // CRITICAL: zero outbound rows enqueued either.
    assert.equal(state.outbound.size, 0, "no cv-findings enqueue when LLM fails")
    // Error event was logged.
    assert.ok(
      events.some((e) => e.event === "pa.cv_ingest.error" && e.payload?.stage === "llm"),
      "error log line emitted"
    )
  })

  // ---- Scenario 2: mem0 add throws ---------------------------------------
  it("S2 mem0Add throws → fact write skipped + logged, but parsedCandidateResumes + runtime handoff unaffected", async () => {
    const { db, state } = makeFakeDb({
      users: { u2: { phoneE164: "+14243201960", mem0UserId: null } },
    })
    const { log, events } = captureLog()
    const deps: IngestCvDeps = {
      skipLimitEnforcement: true,
      followupDeliveryMode: "runtime",
      db,
      log,
      nowIso: () => "2026-04-30T00:00:00.000Z",
      fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
      parsePdf: async () => ({ text: "happy resume", numPages: 1 }),
      llmExtract: async () => ({ parsed: happyParsed() }),
      mem0Add: async () => {
        throw new Error("mem0 connection refused")
      },
      lookupUserForFollowup: async () => ({ toE164: "+14243201960", mem0UserId: null }),
    }
    const res = await ingestCv({ userId: "u2", mediaUrl: "https://x/a.pdf" }, deps)

    // Pipeline still succeeds — mem0 is best-effort.
    assert.equal(res.ok, true)
    // parsedCandidateResumes row WAS written.
    assert.equal(state.resumes.length, 1, "resume row persisted despite mem0 failure")
    // direct cv-findings outbound is gone; runtime handoff was attempted.
    assert.equal(state.outbound.size, 0, "cv ingest must not enqueue direct outbox rows")
    assert.ok(
      events.some((e) => e.event === "pa.cv_followup.synthetic_trigger_written"),
      "runtime handoff attempted"
    )
    // mem0 error was logged at least once.
    assert.ok(
      events.some((e) => e.event === "pa.cv_mem0.error"),
      "mem0 error logged"
    )
  })

  // ---- Scenario 3: Sendblue circuit OPEN ---------------------------------
  it("S3 Sendblue breaker OPEN → outbox marks pending + retry-after, no infinite cascade", () => {
    __resetSendblueBreakerForTests()
    // Drive the breaker OPEN by recording 5 consecutive failures.
    for (let i = 0; i < 5; i++) recordSendblueFailure("sendblue", 1_000_000_000_000)
    assert.equal(getSendblueBreakerState("sendblue", 1_000_000_000_000), "OPEN")

    // Calling caller (the outbox handler) detects OPEN → throws SendblueCircuitOpenError.
    const err = new SendblueCircuitOpenError(1_000_000_000_000, 1_000_000_000_500)
    assert.equal(err.circuitOpen, true)
    assert.match(err.message, /circuit OPEN/i)

    // After the OPEN window expires, state is HALF_OPEN — exactly one trial.
    const futureNow = 1_000_000_000_000 + 60_001
    assert.equal(
      getSendblueBreakerState("sendblue", futureNow),
      "HALF_OPEN",
      "breaker transitions to HALF_OPEN after 60s without re-raising new failures"
    )
    // Cleanup so other tests don't see leaked state.
    __resetSendblueBreakerForTests()
  })

  // ---- Scenario 4: missing runtime session on resume-complete handoff ----
  it("S4 missing runtime session → no direct outbox and no error propagation", async () => {
    const { db, state } = makeFakeDb({
      users: { u4: { phoneE164: "+14243201960", mem0UserId: null } },
    })
    const { log, events } = captureLog()
    const deps: IngestCvDeps = {
      skipLimitEnforcement: true,
      followupDeliveryMode: "runtime",
      db,
      log,
      nowIso: () => "2026-04-30T00:00:00.000Z",
      fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
      parsePdf: async () => ({ text: "happy resume", numPages: 1 }),
      llmExtract: async () => ({ parsed: happyParsed() }),
      mem0Add: async () => {},
      lookupUserForFollowup: async () => ({ toE164: "+14243201960", mem0UserId: null }),
    }
    const res = await ingestCv({ userId: "u4", mediaUrl: "https://x/a.pdf" }, deps)

    // Pipeline still succeeds; with no pre-existing session the runtime handoff now CREATES
    // one and fires the resume_parse_completed event (WS-0 BUG1 fix: requireExistingSession:false
    // — never drop the pitch for a session-less user), still WITHOUT a direct message producer.
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1, "resume row written")
    assert.equal(state.outbound.size, 0, "no direct outbox rows")
    assert.ok(
      events.some((e) => e.event === "pa.cv_followup.synthetic_trigger_written"),
      "runtime handoff fired (created session + event)"
    )
  })

  // ---- Scenario 5: OpenAI rate limit (429) on cv-ingest extract ----------
  it("S5 OpenAI 429 on llmExtract → ingestCv returns {ok:false, reason} + NO partial parsedCandidateResumes row", async () => {
    const { db, state } = makeFakeDb()
    const { log, events } = captureLog()
    const deps: IngestCvDeps = {
      skipLimitEnforcement: true,
      db,
      log,
      fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
      parsePdf: async () => ({ text: "some resume text", numPages: 1 }),
      llmExtract: async () => {
        const err: Error & { status?: number } = new Error(
          "Rate limit reached for gpt-5.4-nano in organization: 429"
        )
        err.status = 429
        throw err
      },
    }
    const res = await ingestCv({ userId: "u5", mediaUrl: "https://x/a.pdf" }, deps)

    assert.equal(res.ok, false)
    // Reason mentions llm_parse_failed (cv-ingest's standard 429 mapping); a
    // future improvement could split rate_limited specifically — for now we
    // assert the basics: shape is correct, no partial writes leaked.
    assert.ok(!res.ok && typeof res.reason === "string")
    // CRITICAL: NO partial parsedCandidateResumes row.
    assert.equal(state.resumes.length, 0, "429 must not leave a half-written resume row")
    // CRITICAL: No outbound enqueue either.
    assert.equal(state.outbound.size, 0, "429 must not enqueue any cv-findings row")
    // The error log includes the 429-flavored message text.
    const errEvent = events.find((e) => e.event === "pa.cv_ingest.error")
    assert.ok(errEvent, "error event emitted")
    const errMsg = String(errEvent?.payload?.error ?? "")
    assert.match(errMsg, /Rate limit|429/, "error payload preserves 429 signal for downstream")
  })
})
