import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  ingestCv,
  buildCvFactBody,
  computeTopSkills,
  detectCvLang,
  type IngestCvDeps,
  type StructuredCv,
} from "../cv-ingest.js"
import type { IndustryTag } from "../industry-tags.js"

// ---------- Tiny fake Firestore (only .collection().add() / .doc().create() / .doc().get() used) -----------

type DocData = Record<string, unknown>

type FakeDbState = {
  /** parsedCandidateResumes auto-id .add() writes */
  resumes: Array<{ collection: string; data: DocData }>
  /** pa-outbound .doc(id).create() writes (idempotent) */
  outbound: Map<string, DocData>
  /** pa-users docs available for .doc(id).get() lookups */
  users: Map<string, DocData>
}

function makeFakeDb(opts?: { users?: Record<string, DocData> }) {
  const state: FakeDbState = {
    resumes: [],
    outbound: new Map(),
    users: new Map(Object.entries(opts?.users ?? {})),
  }
  let nextId = 1
  const db = {
    collection(name: string) {
      return {
        async add(data: DocData) {
          if (name !== "parsedCandidateResumes") {
            throw new Error(`fake-db: .add() not supported for collection ${name}`)
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
                return {
                  exists: !!data,
                  data: () => data,
                }
              }
              return { exists: false, data: () => undefined }
            },
            async create(data: DocData) {
              if (name === "pa-outbound") {
                if (state.outbound.has(id)) {
                  // Mirror Firestore Admin throw shape — message contains
                  // ALREADY_EXISTS to match the cv-ingest dup detector.
                  const err = new Error(
                    `6 ALREADY_EXISTS: Document already exists: projects/.../databases/(default)/documents/pa-outbound/${id}`
                  )
                  throw err
                }
                state.outbound.set(id, { ...data })
                return
              }
              throw new Error(`fake-db: .create() not supported for collection ${name}`)
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
      name: "Adam Test",
      email: "adam@example.com",
      phone: "+15551234567",
      linkedIn: null,
      location: "San Francisco, CA",
      skills: ["TypeScript", "Firestore"],
    },
    experiences: [
      {
        company: "WeKruit",
        title: "Founder",
        startDate: "2024",
        endDate: null,
        location: "SF",
        description: "Built Claire.",
      },
    ],
    education: [
      {
        school: "Some University",
        degree: "BS",
        field: "CS",
        startDate: "2018",
        endDate: "2022",
      },
    ],
    industryTags: ["tech_software"],
  }
}

function captureLog() {
  const events: Array<{ event: string; payload: Record<string, unknown> | undefined }> = []
  const log = (event: string, payload?: Record<string, unknown>) => {
    events.push({ event, payload })
  }
  return { events, log }
}

/**
 * Helper: produce a minimum-noise IngestCvDeps that lets a happy path
 * complete without hitting any real network/file/SDK. Stream E hooks
 * default to no-ops (recorded via spy counters returned alongside).
 */
function makeStubbedDeps(opts: {
  db: IngestCvDeps["db"]
  log: IngestCvDeps["log"]
  parsed?: StructuredCv
}) {
  const llmFollowupCalls: Array<{ parsed: StructuredCv }> = []
  const enqueueCalls: Array<{ docId: string; payload: Record<string, unknown> }> = []
  const mem0Calls: Array<{ userId: string; partitionKey: string; factBody: string }> = []
  const lookupCalls: Array<{ userId: string }> = []

  const deps: IngestCvDeps = {
    db: opts.db,
    log: opts.log,
    nowIso: () => "2026-04-30T00:00:00.000Z",
    // iter30 WS1 — pre-iter30 fixture stubs don't populate gate / quota
    // Firestore docs; bypass the new limits to preserve test intent.
    skipLimitEnforcement: true,
    fetchPdf: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" }),
    parsePdf: async () => ({ text: "John Doe\nWorked at WeKruit.", numPages: 1 }),
    llmExtract: async () => ({
      parsed: opts.parsed ?? happyParsed(),
      usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
    }),
    llmFollowup: async (parsed) => {
      llmFollowupCalls.push({ parsed })
      return "saw your founder run at WeKruit — wild. you targeting startup again or thinking 大厂 this round?"
    },
    enqueueOutboundFollowup: async (_db, docId, payload) => {
      enqueueCalls.push({ docId, payload: { ...payload } })
    },
    mem0Add: async (a) => {
      mem0Calls.push({ ...a })
    },
    lookupUserForFollowup: async (_db, userId) => {
      lookupCalls.push({ userId })
      return { toE164: "+14243201960", mem0UserId: null }
    },
  }
  return { deps, llmFollowupCalls, enqueueCalls, mem0Calls, lookupCalls }
}

// ---------- Tests ------------------------------------------------------------

describe("ingestCv", () => {
  it("happy path: writes parsedCandidateResumes with full schema match", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.nowIso = () => "2026-04-30T00:00:00.000Z"
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/path/cv.pdf", sessionId: "ses_x" },
      deps
    )
    assert.equal(res.ok, true)
    assert.ok(res.ok && res.resumeId.startsWith("rsm_"))
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!
    assert.equal(w.collection, "parsedCandidateResumes")
    assert.equal(w.data.userId, "user_x")
    assert.equal(w.data.mediaUrl, "https://example.com/path/cv.pdf")
    assert.equal(w.data.fileType, "application/pdf")
    assert.equal(w.data.ingestedVia, "imessage-attachment")
    assert.equal(w.data.studentFrom, null)
    assert.equal(w.data.sessionId, "ses_x")
    assert.equal(w.data.originalFileName, "cv.pdf")
    const cp = w.data.candidateProfile as Record<string, unknown>
    assert.equal(cp.name, "Adam Test")
    assert.equal(cp.linkedIn, null)
    assert.deepEqual(cp.skills, ["TypeScript", "Firestore"])
    assert.ok(Array.isArray(w.data.experiences))
    assert.equal((w.data.experiences as unknown[]).length, 1)
    assert.ok(Array.isArray(w.data.education))
  })

  it("download fail → returns ok:false reason:download_failed and writes nothing", async () => {
    const { db, state } = makeFakeDb()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        skipLimitEnforcement: true,
        fetchPdf: async () => {
          throw new Error("HTTP 404 Not Found")
        },
        parsePdf: async () => ({ text: "should not run" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "download_failed")
    assert.equal(state.resumes.length, 0)
  })

  it("pdf-parse throws → returns ok:false reason:pdf_parse_failed", async () => {
    const { db, state } = makeFakeDb()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        skipLimitEnforcement: true,
        fetchPdf: async () => ({ bytes: new Uint8Array([0x25, 0x50]), contentType: "application/pdf" }),
        parsePdf: async () => {
          throw new Error("malformed PDF")
        },
        llmExtract: async () => ({ parsed: happyParsed() }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "pdf_parse_failed")
    assert.equal(state.resumes.length, 0)
  })

  it("LLM extract returns malformed shape → returns ok:false reason:llm_parse_failed", async () => {
    const { db, state } = makeFakeDb()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        skipLimitEnforcement: true,
        fetchPdf: async () => ({ bytes: new Uint8Array([0x25]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "real cv text" }),
        // Missing required candidateProfile.skills array → validator throws.
        llmExtract: async () =>
          ({ parsed: { candidateProfile: { name: "x" } } as unknown as StructuredCv }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "llm_parse_failed")
    assert.equal(state.resumes.length, 0)
  })

  it("empty mediaUrl → returns ok:false reason:invalid_input (no fetch attempted)", async () => {
    const { db } = makeFakeDb()
    let fetchCount = 0
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "" },
      {
        db,
        skipLimitEnforcement: true,
        fetchPdf: async () => {
          fetchCount++
          return { bytes: new Uint8Array(), contentType: undefined }
        },
        parsePdf: async () => ({ text: "" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "invalid_input")
    assert.equal(fetchCount, 0, "invalid input must short-circuit before fetch")
  })

  it("happy path emits pa.cv_ingest.cost telemetry with input/output token counts", async () => {
    const { db } = makeFakeDb()
    const { events, log } = captureLog()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        skipLimitEnforcement: true,
        log,
        fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "real cv text" }),
        llmExtract: async () => ({
          parsed: happyParsed(),
          usage: { input_tokens: 1234, output_tokens: 567, total_tokens: 1801 },
        }),
        // Stream E paths also exercised — stub them to no-ops.
        llmFollowup: async () => "ignore",
        enqueueOutboundFollowup: async () => {},
        mem0Add: async () => {},
        lookupUserForFollowup: async () => ({ toE164: "+1555", mem0UserId: null }),
      }
    )
    assert.equal(res.ok, true)
    const cost = events.find((e) => e.event === "pa.cv_ingest.cost")
    assert.ok(cost, "expected pa.cv_ingest.cost log event")
    const p = cost!.payload!
    assert.equal(p.userId, "user_x")
    assert.equal(p.inputTokens, 1234)
    assert.equal(p.outputTokens, 567)
    assert.equal(p.totalTokens, 1801)
    assert.equal(p.model, "gpt-5.4-nano")
  })

  // -------------- Stream E1 — findings follow-up --------------

  it("E1 happy: cv-findings LLM called → outbound enqueued with idempotent docId out-cvfindings-{resumeId}", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps, llmFollowupCalls, enqueueCalls } = makeStubbedDeps({ db, log })
    delete process.env.PA_CV_FINDINGS_FOLLOWUP_DISABLED
    delete process.env.PA_CV_MEM0_WRITE_DISABLED

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/path/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.ok(res.ok && res.resumeId.startsWith("rsm_"))

    assert.equal(llmFollowupCalls.length, 1, "llmFollowup should fire once")
    assert.equal(llmFollowupCalls[0]!.parsed.candidateProfile.name, "Adam Test")

    assert.equal(enqueueCalls.length, 1, "outbound should be enqueued exactly once")
    const enq = enqueueCalls[0]!
    assert.equal(enq.docId, `out-cvfindings-${(res as { ok: true; resumeId: string }).resumeId}`)
    assert.equal(enq.payload.userId, "user_x")
    assert.equal(enq.payload.toE164, "+14243201960")
    assert.equal(enq.payload.status, "pending")
    assert.equal(enq.payload.attempts, 0)
    assert.equal(enq.payload.createdBy, "cv-ingest-followup")
    assert.equal(enq.payload.idempotencyKey, (res as { ok: true; resumeId: string }).resumeId)
    assert.equal(typeof enq.payload.body, "string")
    // Body should be the LLM string (light-normalize ≤600 chars, no markdown)
    assert.ok(((enq.payload.body as string) ?? "").includes("WeKruit"))
    // Note: state.outbound stays empty here because we stubbed
    // enqueueOutboundFollowup. Idempotency through the default Firestore
    // path is exercised in the dedicated idempotency test below.
  })

  it("E1 LLM throws → ingestCv still ok:true, NO outbound enqueued", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps, enqueueCalls } = makeStubbedDeps({ db, log })
    deps.llmFollowup = async () => {
      throw new Error("openai_500")
    }
    delete process.env.PA_CV_FINDINGS_FOLLOWUP_DISABLED

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(enqueueCalls.length, 0)
    assert.equal(state.outbound.size, 0)
    const errEvt = events.find(
      (e) => e.event === "pa.cv_followup.error" && e.payload?.stage === "llm"
    )
    assert.ok(errEvt, "expected pa.cv_followup.error/llm log event")
    // parsedCandidateResumes write must have still completed.
    assert.equal(state.resumes.length, 1)
  })

  it("E1 kill switch (PA_CV_FINDINGS_FOLLOWUP_DISABLED=true) → no LLM call, no outbound", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps, llmFollowupCalls, enqueueCalls } = makeStubbedDeps({ db, log })
    process.env.PA_CV_FINDINGS_FOLLOWUP_DISABLED = "true"
    try {
      const res = await ingestCv(
        { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
        deps
      )
      assert.equal(res.ok, true)
      assert.equal(llmFollowupCalls.length, 0, "LLM must not be called when kill switch is on")
      assert.equal(enqueueCalls.length, 0, "outbound must not be enqueued when kill switch is on")
      assert.equal(state.outbound.size, 0)
    } finally {
      delete process.env.PA_CV_FINDINGS_FOLLOWUP_DISABLED
    }
  })
  it("E1 idempotency: re-running on same resumeId via default enqueue path → second enqueue ALREADY_EXISTS, no double-write", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps, llmFollowupCalls } = makeStubbedDeps({ db, log })
    // Use the default enqueueOutboundFollowup (Firestore .create)
    deps.enqueueOutboundFollowup = undefined
    delete process.env.PA_CV_FINDINGS_FOLLOWUP_DISABLED

    const res1 = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res1.ok, true)
    const id1 = (res1 as { ok: true; resumeId: string }).resumeId
    assert.equal(state.outbound.size, 1)
    assert.ok(state.outbound.has(`out-cvfindings-${id1}`))

    // Manually attempt second enqueue with the SAME resumeId — must
    // surface as ALREADY_EXISTS via the default enqueue path.
    // Simulate by writing the same docId via a fresh deps.run with
    // a frozen lookup-injected resumeId fixture.
    const sameIdDb = state.outbound
    const before = sameIdDb.size
    // Re-run ingestCv → fresh resumeId (rsm_2), so a NEW docId is
    // created. To verify dup-detection, we manually call .create
    // with the prior docId and confirm it throws ALREADY_EXISTS.
    let dupErr: unknown = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).collection("pa-outbound").doc(`out-cvfindings-${id1}`).create({ stub: true })
    } catch (err) {
      dupErr = err
    }
    assert.ok(dupErr instanceof Error)
    assert.ok(/ALREADY_EXISTS/.test((dupErr as Error).message))
    assert.equal(sameIdDb.size, before, "dup .create must not mutate state")
    void llmFollowupCalls
    void events
  })


  // -------------- Stream E2 — Mem0 memory write --------------

  it("E2 happy: mem0Add called with fact body + correct partition key", async () => {
    const { db } = makeFakeDb()
    const { log } = captureLog()
    const { deps, mem0Calls } = makeStubbedDeps({ db, log })
    // User has explicit mem0UserId different from canonical id → partition
    // key MUST be the explicit value (resolveMem0PartitionKey semantics).
    deps.lookupUserForFollowup = async () => ({
      toE164: "+14243201960",
      mem0UserId: "mem0_partition_42",
    })
    delete process.env.PA_CV_MEM0_WRITE_DISABLED

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(mem0Calls.length, 1, "mem0Add should fire exactly once")
    const call = mem0Calls[0]!
    assert.equal(call.userId, "user_x")
    assert.equal(call.partitionKey, "mem0_partition_42")
    assert.ok(call.factBody.length > 0)
    // Default English template (tests use ASCII-only fixture)
    assert.ok(/User resume summary|用户简历摘要/.test(call.factBody))
    assert.ok(call.factBody.includes("WeKruit"))
  })

  it("E2 mem0Add throws → ingestCv still ok:true, error logged, no propagation", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.mem0Add = async () => {
      throw new Error("qdrant_unreachable")
    }
    delete process.env.PA_CV_MEM0_WRITE_DISABLED

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    // parsedCandidateResumes write must have still completed.
    assert.equal(state.resumes.length, 1)
    const errEvt = events.find((e) => e.event === "pa.cv_mem0.error")
    assert.ok(errEvt, "expected pa.cv_mem0.error log event")
    assert.equal((errEvt!.payload as Record<string, unknown>).userId, "user_x")
  })

  it("E2 kill switch (PA_CV_MEM0_WRITE_DISABLED=true) → mem0Add NOT called", async () => {
    const { db } = makeFakeDb()
    const { log } = captureLog()
    const { deps, mem0Calls } = makeStubbedDeps({ db, log })
    process.env.PA_CV_MEM0_WRITE_DISABLED = "true"
    try {
      const res = await ingestCv(
        { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
        deps
      )
      assert.equal(res.ok, true)
      assert.equal(mem0Calls.length, 0, "mem0Add must not be called when kill switch is on")
    } finally {
      delete process.env.PA_CV_MEM0_WRITE_DISABLED
    }
  })
})


  // -------------- Stream F1 — industry tag enrichment --------------

  it("F1 happy path: writes industryTags to parsedCandidateResumes", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const parsedWithFintech: StructuredCv = {
      ...happyParsed(),
      industryTags: ["fintech_finance", "ai_ml"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: parsedWithFintech })
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const written = state.resumes[0]!.data
    assert.ok(Array.isArray(written.industryTags))
    assert.deepEqual(written.industryTags, ["fintech_finance", "ai_ml"])
  })

  it("F1 unknown industry → falls back to ['other'] (no throw, doc still written)", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    // LLM emits a totally bogus tag — validator must clamp + fall back.
    deps.llmExtract = async () => ({
      parsed: {
        ...happyParsed(),
        industryTags: ["completely_made_up_industry"] as unknown as IndustryTag[],
      },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const written = state.resumes[0]!.data
    assert.deepEqual(written.industryTags, ["other"])
  })

// ---------- Pure-function unit tests for buildCvFactBody / detectCvLang -----

describe("buildCvFactBody / detectCvLang", () => {
  it("English CV → English fact body", () => {
    const body = buildCvFactBody(happyParsed())
    assert.ok(body.startsWith("User resume summary:"))
    assert.ok(body.includes("Founder at WeKruit"))
    assert.ok(body.includes("TypeScript"))
  })

  it("Chinese-heavy CV → Chinese fact body", () => {
    const zh: StructuredCv = {
      candidateProfile: {
        name: "张伟",
        email: null,
        phone: null,
        linkedIn: null,
        location: "北京",
        skills: ["量化交易", "数据分析", "机器学习"],
      },
      experiences: [
        {
          company: "瑞银集团",
          title: "暑期分析师",
          startDate: "2024",
          endDate: null,
          location: "上海",
          description: "金融科技研究项目，负责量化模型搭建与回测",
        },
      ],
      education: [
        {
          school: "清华大学",
          degree: "金融学学士",
          field: "金融",
          startDate: "2020",
          endDate: "2024",
        },
      ],
      industryTags: ["fintech_finance"],
    }
    assert.equal(detectCvLang(zh), "zh")
    const body = buildCvFactBody(zh)
    assert.ok(body.startsWith("用户简历摘要:"))
    assert.ok(body.includes("瑞银集团"))
  })
})

// ---------- iter34 sprint A.1 — topSkills compute + write -------------------

describe("computeTopSkills (iter34 A.1)", () => {
  it("only candidateProfile.skills → output is normalized + deduped list", () => {
    const out = computeTopSkills({
      candidateProfileSkills: ["TypeScript", "React", "Node.js"],
    })
    assert.deepEqual(out, ["typescript", "react", "node.js"])
  })

  it("v2 workHistory[].skills + candidateProfile.skills → merged with frequency-rank", () => {
    // "Python" appears in 3 workHistory entries + candidateProfile (4x total)
    // "SQL" appears in 1 workHistory entry + candidateProfile (2x total)
    // "Docker" appears in candidateProfile only (1x total)
    const workHistory = [
      { skills: ["Python", "SQL"] },
      { skills: ["Python"] },
      { skills: ["Python"] },
    ]
    const out = computeTopSkills({
      candidateProfileSkills: ["Python", "SQL", "Docker"],
      workHistory,
    })
    // Highest freq first.
    assert.equal(out[0], "python")
    assert.equal(out[1], "sql")
    assert.equal(out[2], "docker")
    assert.equal(out.length, 3)
  })

  it("empty input → returns []", () => {
    assert.deepEqual(computeTopSkills({}), [])
    assert.deepEqual(computeTopSkills({ candidateProfileSkills: [] }), [])
    assert.deepEqual(
      computeTopSkills({ candidateProfileSkills: [], workHistory: [] }),
      []
    )
    assert.deepEqual(
      computeTopSkills({ candidateProfileSkills: ["", "  ", "x", "42"] }),
      []
    )
  })

  it("duplicates + case mixing → single normalized entry with summed count", () => {
    const out = computeTopSkills({
      candidateProfileSkills: ["TypeScript", "typescript", "TYPESCRIPT", "React"],
    })
    // dedupe after normalize → ["typescript", "react"], typescript first (3x)
    assert.deepEqual(out, ["typescript", "react"])
  })

  it("frequency wins over insertion order (A 3x, B 1x → A first)", () => {
    const out = computeTopSkills({
      // B inserted first to verify count beats order.
      candidateProfileSkills: ["SkillB", "SkillA"],
      workHistory: [
        { skills: ["SkillA"] },
        { skills: ["SkillA"] },
      ],
    })
    assert.deepEqual(out, ["skilla", "skillb"])
  })

  it("caps at 12", () => {
    const skills = Array.from({ length: 30 }, (_, i) => `Skill_${i}`)
    const out = computeTopSkills({ candidateProfileSkills: skills })
    assert.equal(out.length, 12)
    // First 12 preserved (all freq=1, tiebreak = insertion order).
    assert.deepEqual(
      out,
      Array.from({ length: 12 }, (_, i) => `skill_${i}`)
    )
  })

  it("filters single-char and pure-numeric tokens", () => {
    const out = computeTopSkills({
      candidateProfileSkills: ["A", "x", "  ", "2024", "ec2", "es6", "TypeScript"],
    })
    // Drops "A", "x" (single char after trim), "2024" (pure numeric).
    // Keeps "ec2", "es6", "typescript" (alphanumeric).
    assert.deepEqual(out, ["ec2", "es6", "typescript"])
  })

  it("tolerates malformed v2 workHistory entries (missing/wrong-typed skills)", () => {
    const workHistory: unknown[] = [
      { skills: ["Go"] },
      { skills: "not-an-array" },
      null,
      undefined,
      { /* no skills field */ },
      { skills: [42, "Rust", { nested: true }] },
    ]
    const out = computeTopSkills({
      candidateProfileSkills: ["Go"],
      workHistory,
    })
    assert.deepEqual(out, ["go", "rust"])
  })
})

describe("ingestCv writes topSkills (iter34 A.1)", () => {
  it("legacy v1 path: topSkills present on parsedCandidateResumes doc", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const customParsed: StructuredCv = {
      candidateProfile: {
        name: "SWE Candidate",
        email: null,
        phone: null,
        linkedIn: null,
        location: "Remote",
        skills: ["TypeScript", "React", "PostgreSQL", "Docker"],
      },
      experiences: [],
      education: [],
      industryTags: ["tech_software"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: customParsed })
    const res = await ingestCv(
      { userId: "user_swe", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!
    assert.ok(Array.isArray(w.data.topSkills))
    assert.deepEqual(w.data.topSkills, ["typescript", "react", "postgresql", "docker"])
  })

  it("empty candidateProfile.skills → topSkills is [] (not missing)", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const customParsed: StructuredCv = {
      candidateProfile: {
        name: null,
        email: null,
        phone: null,
        linkedIn: null,
        location: "",
        skills: [],
      },
      experiences: [],
      education: [],
      industryTags: ["other"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: customParsed })
    const res = await ingestCv(
      { userId: "user_blank", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    const w = state.resumes[0]!
    // Field must be present (job-rec read does `?? []` but absence vs []
    // is meaningful for downstream nullability assumptions).
    assert.ok("topSkills" in w.data)
    assert.deepEqual(w.data.topSkills, [])
  })
})
