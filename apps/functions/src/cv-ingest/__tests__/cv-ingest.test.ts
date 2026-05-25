import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

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
  /** pa-inbound-events synthetic runtime trigger writes */
  inboundEvents: Map<string, DocData>
  /** pa-sessions docs used by runtime handoff gate */
  sessions: Map<string, DocData>
  /** pa-users docs available for .doc(id).get() lookups */
  users: Map<string, DocData>
  /** pa-users .doc(id).set(data, {merge: true}) writes — H.3b unified tags */
  userSets: Array<{ id: string; data: DocData; merge: boolean }>
}

function sessionDocId(userId: string, phoneE164: string): string {
  const h = createHash("sha256").update(`${userId}|imessage|${phoneE164}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

function seedRuntimeSession(state: FakeDbState, userId = "user_x", phoneE164 = "+14243201960"): void {
  state.sessions.set(sessionDocId(userId, phoneE164), {
    id: sessionDocId(userId, phoneE164),
    userId,
    channel: "imessage",
    externalChatId: phoneE164,
  })
}

function makeFakeDb(opts?: { users?: Record<string, DocData> }) {
  const state: FakeDbState = {
    resumes: [],
    outbound: new Map(),
    inboundEvents: new Map(),
    sessions: new Map(),
    users: new Map(Object.entries(opts?.users ?? {})),
    userSets: [],
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
              if (name === "pa-sessions") {
                const data = state.sessions.get(id)
                return {
                  exists: !!data,
                  data: () => data,
                }
              }
              if (name === "pa-inbound-events") {
                const data = state.inboundEvents.get(id)
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
            async set(data: DocData, opts?: { merge?: boolean }) {
              if (name === "pa-users") {
                state.userSets.push({
                  id,
                  data: JSON.parse(JSON.stringify(data)) as DocData,
                  merge: opts?.merge === true,
                })
                // Mirror merge-true semantics so subsequent .get() reads
                // see the layered fields (test assertions can stay terse).
                const prev = state.users.get(id) ?? {}
                state.users.set(id, opts?.merge === true ? { ...prev, ...data } : data)
                return
              }
              if (name === "pa-inbound-events") {
                const prev = state.inboundEvents.get(id) ?? {}
                state.inboundEvents.set(id, opts?.merge === true ? { ...prev, ...data } : { ...data })
                return
              }
              if (name === "pa-sessions") {
                const prev = state.sessions.get(id) ?? {}
                state.sessions.set(id, opts?.merge === true ? { ...prev, ...data } : { ...data })
                return
              }
              throw new Error(`fake-db: .set() not supported for collection ${name}`)
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
  const mem0Calls: Array<{ userId: string; partitionKey: string; factBody: string }> = []
  const lookupCalls: Array<{ userId: string }> = []

  const deps: IngestCvDeps = {
    db: opts.db,
    log: opts.log,
    nowIso: () => "2026-04-30T00:00:00.000Z",
    followupDeliveryMode: "runtime",
    // iter30 WS1 — pre-iter30 fixture stubs don't populate gate / quota
    // Firestore docs; bypass the new limits to preserve test intent.
    skipLimitEnforcement: true,
    fetchPdf: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" }),
    parsePdf: async () => ({ text: "John Doe\nWorked at WeKruit.", numPages: 1 }),
    llmExtract: async () => ({
      parsed: opts.parsed ?? happyParsed(),
      usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
    }),
    mem0Add: async (a) => {
      mem0Calls.push({ ...a })
    },
    lookupUserForFollowup: async (_db, userId) => {
      lookupCalls.push({ userId })
      return { toE164: "+14243201960", mem0UserId: null }
    },
  }
  return { deps, mem0Calls, lookupCalls }
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
        // Stream E paths also exercised — mem0 stubbed to no-op.
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

  // -------------- Stream E1 — runtime handoff --------------

  it("E1 runtime delivery writes a resume_parse_completed event and no direct pa-outbound", async () => {
    const { db, state } = makeFakeDb()
    seedRuntimeSession(state)
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.followupDeliveryMode = "runtime"

    const res1 = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res1.ok, true)
    const id1 = (res1 as { ok: true; resumeId: string }).resumeId
    assert.equal(state.outbound.size, 0)
    const e1Events = [...state.inboundEvents.values()].filter((row) => {
      const meta = row.rawMeta as Record<string, unknown> | undefined
      return meta?.runtimeEventSource === "cv_ingest" && meta?.runtimeEventKind === "resume_parse_completed"
    })
    assert.equal(e1Events.length, 1)
    assert.match(String(e1Events[0]!.idempotencyKey), new RegExp(`cv-parsed:user_x:${id1}`))
    assert.ok(events.some((e) => e.event === "pa.cv_followup.synthetic_trigger_written"))
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
      // happyParsed skills include "TypeScript" so H.3a fallback also adds
      // tech_software (≤3 cap honored). This validates the additive behavior.
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
    // iter34 H.3a — TypeScript skill triggers tech_software fallback (additive).
    assert.deepEqual(written.industryTags, ["fintech_finance", "ai_ml", "tech_software"])
  })

  it("F1 unknown industry → no tech skill → falls back to ['other'] (no throw, doc still written)", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    // LLM emits a totally bogus tag — validator must clamp + fall back.
    // Use non-tech skills so the H.3a skill-token fallback ALSO returns ["other"].
    deps.llmExtract = async () => ({
      parsed: {
        ...happyParsed(),
        candidateProfile: {
          ...happyParsed().candidateProfile,
          skills: ["leadership", "communication"], // no tech / AI tokens
        },
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

// ---------- iter34 sprint B.9 — sync embedding compute ---------------------

describe("ingestCv writes embedding sync (iter34 B.9)", () => {
  it("happy path: embedding fields written to parsedCandidateResumes doc", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    const fakeVec = new Array(1536).fill(0.123)
    deps.computeEmbedding = async () => ({
      vector: fakeVec,
      model: "text-embedding-3-small",
      dim: 1536,
      computedAt: "2026-05-05T12:00:00.000Z",
    })
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!.data
    assert.ok(Array.isArray(w.embedding))
    assert.equal((w.embedding as unknown[]).length, 1536)
    assert.equal(w.embeddingModel, "text-embedding-3-small")
    assert.equal(w.embeddingDim, 1536)
    assert.equal(w.embeddingComputedAt, "2026-05-05T12:00:00.000Z")
  })

  it("computeEmbedding returns null (OpenAI down) → doc still written, embedding fields absent", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.computeEmbedding = async () => null
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true, "doc must still write when embedding is null")
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!.data
    // Daily-batch will lazy-compute on next run; absence is the contract.
    assert.equal("embedding" in w, false)
    assert.equal("embeddingModel" in w, false)
    assert.equal("embeddingDim" in w, false)
    assert.equal("embeddingComputedAt" in w, false)
    // Other fields still present.
    assert.equal(w.userId, "user_x")
    assert.ok(Array.isArray(w.topSkills))
  })

  it("computeEmbedding throws (defensive) → doc still written, embedding_error logged", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.computeEmbedding = async () => {
      throw new Error("simulated_failure")
    }
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true, "throw inside computeEmbedding must NOT block doc write")
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!.data
    assert.equal("embedding" in w, false)
    const errEvt = events.find((e) => e.event === "pa.cv_ingest.embedding_error")
    assert.ok(errEvt, "expected pa.cv_ingest.embedding_error log event")
    assert.equal((errEvt!.payload as Record<string, unknown>).userId, "user_x")
  })

  it("embedding compute is invoked with parsed CV fields (sanity)", async () => {
    const { db } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    let captured: Record<string, unknown> | null = null
    deps.computeEmbedding = async (input) => {
      captured = input as unknown as Record<string, unknown>
      return null
    }
    await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.ok(captured, "computeEmbedding must be invoked")
    const cap = captured as Record<string, unknown>
    const cp = cap.candidateProfile as Record<string, unknown>
    assert.equal(cp.name, "Adam Test")
    assert.ok(Array.isArray(cap.experiences))
    assert.ok(Array.isArray(cap.industryTags))
    // topSkills is the SHARED computed value (same that's written to doc)
    assert.ok(Array.isArray(cap.topSkills))
  })

  it("happy path emits pa.cv_ingest.embedding_computed log with dim + model", async () => {
    const { db } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.computeEmbedding = async () => ({
      vector: new Array(1536).fill(0.1),
      model: "text-embedding-3-small",
      dim: 1536,
      computedAt: "2026-05-05T12:00:00.000Z",
    })
    await ingestCv({ userId: "user_x", mediaUrl: "https://example.com/cv.pdf" }, deps)
    const evt = events.find((e) => e.event === "pa.cv_ingest.embedding_computed")
    assert.ok(evt, "expected pa.cv_ingest.embedding_computed event")
    const p = evt!.payload as Record<string, unknown>
    assert.equal(p.userId, "user_x")
    assert.equal(p.dim, 1536)
    assert.equal(p.model, "text-embedding-3-small")
  })
})

// ---------- iter34 H.3b — unified user-tags merge + write ------------------

describe("ingestCv writes pa-users.tags via mergeUserTags (iter34 H.3b)", () => {
  it("happy path: pa-users/{userId}.set is called with tags object containing skills + industryEnum", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    const tagSetOps = state.userSets.filter((op) => "tags" in op.data)
    assert.equal(tagSetOps.length, 1, "pa-users.set should write tags once")
    const setOp = tagSetOps[0]!
    assert.equal(setOp.id, "user_x")
    assert.equal(setOp.merge, true, "must use merge:true to preserve chat-side tag fields")
    const payload = setOp.data as Record<string, unknown>
    const tags = payload.tags as Record<string, unknown>
    assert.ok(tags, "payload.tags must be present")
    assert.ok(Array.isArray(tags.skills), "tags.skills must be array")
    assert.ok(Array.isArray(tags.industryEnum), "tags.industryEnum must be array")
    assert.equal(typeof tags.schemaVersion, "number")
    // Telemetry log written.
    const ok = events.find((e) => e.event === "pa.cv_user_tags.ok")
    assert.ok(ok, "expected pa.cv_user_tags.ok log")
    assert.equal((ok!.payload as Record<string, unknown>).userId, "user_x")
    const phoneSet = state.userSets.find((op) => "phoneE164" in op.data)
    assert.equal(phoneSet?.data.phoneE164, "+15551234567")
    assert.equal(typeof phoneSet?.data.updatedAt, "string")
  })

  it("skills written FULLY (not truncated to 12) — Adam directive", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const skills30 = Array.from({ length: 30 }, (_, i) => `Skill_${i}`)
    const customParsed: StructuredCv = {
      candidateProfile: {
        name: "Power User",
        email: null,
        phone: null,
        linkedIn: null,
        location: "",
        skills: skills30,
      },
      experiences: [],
      education: [],
      industryTags: ["tech_software"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: customParsed })
    await ingestCv(
      { userId: "user_full", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    const tagSet = state.userSets.find((op) => "tags" in op.data)
    assert.ok(tagSet, "expected tag set")
    const tags = (tagSet.data.tags ?? {}) as Record<string, unknown>
    const writtenSkills = tags.skills as Array<{ name: string }>
    // Full list: at least the 30 input skills make it through (lowercased,
    // deduped, but NOT capped at 12 like topSkills).
    assert.equal(
      writtenSkills.length,
      30,
      `expected 30 skills written (full list), got ${writtenSkills.length}`
    )
    // Phase 61 — skills are now SkillEntry objects; check `.name`
    assert.ok(
      writtenSkills.every((s) => s.name.toLowerCase() === s.name),
      "skill.name must be lowercased"
    )
  })

  it("CV-only ingest writes resume baseline matching axes before onboarding refinement", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const parsed: StructuredCv = {
      candidateProfile: {
        name: "Data Candidate",
        email: null,
        phone: null,
        linkedIn: null,
        location: "",
        skills: ["SQL", "Python", "Tableau"],
      },
      experiences: [
        {
          company: "EnergyCo",
          title: "Associate Data Analyst",
          startDate: "2024",
          endDate: "2026",
          location: "Pittsburgh",
          description: "Built SQL dashboards and forecasting analysis.",
        },
      ],
      education: [],
      industryTags: ["tech_software"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed })

    const res = await ingestCv(
      { userId: "user_baseline", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )

    assert.equal(res.ok, true)
    const tagSet = state.userSets.find((op) => "tags" in op.data)
    assert.ok(tagSet, "expected tags write")
    const tags = tagSet.data.tags as Record<string, unknown>
    assert.deepEqual(tags.targetRoleFunction, ["data_analysis"])
    assert.equal(tags.careerStage, "entry_level")
    assert.deepEqual(tags.targetJobType, ["full_time"])
    assert.deepEqual(tags.yoeRange, [1, 3])
  })

  it("statedPreferences (chat-side) is read from pa-users + passed to mergeUserTags", async () => {
    const { db, state } = makeFakeDb({
      users: {
        user_chat: {
          phoneE164: "+1555",
          statedPreferences: {
            targetRole: ["software_engineer"],
            yoeRange: [3, 5],
            visaStatus: "h1b",
            preferredLang: "en",
          },
          preferredLang: "en",
        },
      },
    })
    const { log } = captureLog()
    let capturedInput: unknown = null
    const { deps } = makeStubbedDeps({ db, log })
    deps.mergeUserTagsFn = (input) => {
      capturedInput = input
      return {
        skills: ["typescript"],
        industryEnum: ["tech_software"],
        schemaVersion: 1,
      }
    }
    await ingestCv(
      { userId: "user_chat", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.ok(capturedInput, "mergeUserTags must be called")
    const captured = capturedInput as Record<string, unknown>
    const sp = captured.statedPreferences as Record<string, unknown>
    assert.ok(sp, "mergeUserTags must receive statedPreferences from pa-users")
    assert.deepEqual(sp.targetRole, ["software_engineer"])
    assert.deepEqual(sp.yoeRange, [3, 5])
    assert.equal(sp.visaStatus, "h1b")
    assert.equal(captured.preferredLang, "en")
    // CV side wired correctly too.
    const cv = captured.cv as Record<string, unknown>
    assert.ok(cv, "cv input present")
    assert.deepEqual((cv.industryTags as string[]), ["tech_software"])
    void state
  })

  it("parser v2 resume signals fill missing matching tag axes on pa-users.tags", async () => {
    const { db, state } = makeFakeDb({
      users: {
        user_v2_tags: {
          phoneE164: "+1555",
          tags: {
            targetLocations: ["new_york"],
          },
        },
      },
    })
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    delete deps.llmExtract
    deps.followupDeliveryMode = "none"
    deps.computeEmbedding = async () => null
    deps.isParserV2Enabled = async () => true
    deps.parserV2Extract = async () => ({
      parsed: {
        fullName: "Riley Candidate",
        email: "riley@example.com",
        phone: null,
        location: "San Francisco, CA",
        summary: null,
        skills: [
          "TypeScript",
          "React",
          "Node.js",
          "PostgreSQL",
          "AWS",
          "Developer Tools",
          "Distributed Systems",
        ],
        workHistory: [
          {
            title: "Senior Full Stack Software Engineer",
            company: "Acme",
            location: "San Francisco, CA",
            startDate: "2019",
            endDate: null,
            currentRole: true,
            description: "Built developer tools and distributed systems.",
            bullets: [],
            achievements: [],
          },
        ],
        education: [],
        projects: [],
        certifications: [],
        languages: [],
        interests: [],
        awards: [],
        volunteerWork: [],
        websites: [],
        totalYearsExperience: 7,
        workAuthorization: "H1B",
        parseConfidence: 0.95,
        inferredAnswers: [],
        relevantIndustry: [],
        relevantSpecialization: [],
        proposedTags: [],
      },
      usedTier: "primary",
      usedModel: "gpt-5.4-nano",
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const res = await ingestCv(
      { userId: "user_v2_tags", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )

    assert.equal(res.ok, true)
    const tagSet = state.userSets.find((op) => "tags" in op.data)
    assert.ok(tagSet, "expected pa-users.tags write")
    const tags = tagSet!.data.tags as Record<string, unknown>
    assert.deepEqual(tags.targetRoleFunction, ["software_engineering"])
    assert.equal(tags.careerStage, "senior")
    assert.equal(tags.visaStatus, "sponsor_needed")
    assert.deepEqual(tags.relevantTags, ["developer_tools", "distributed_systems"])
    assert.equal(tags.targetLocations, undefined, "resume location must not become a target location")
  })

  it("parser v2 resume tag projection does not replace existing matching tag axes", async () => {
    const { db, state } = makeFakeDb({
      users: {
        user_v2_explicit_tags: {
          phoneE164: "+1555",
          tags: {
            targetRoleFunction: ["data_analysis"],
            careerStage: "manager",
            visaStatus: "citizen",
            relevantTags: ["quantitative_research"],
          },
        },
      },
    })
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    delete deps.llmExtract
    deps.followupDeliveryMode = "none"
    deps.computeEmbedding = async () => null
    deps.isParserV2Enabled = async () => true
    deps.parserV2Extract = async () => ({
      parsed: {
        fullName: "Riley Candidate",
        email: "riley@example.com",
        phone: null,
        location: "San Francisco, CA",
        summary: null,
        skills: ["TypeScript", "React", "Developer Tools"],
        workHistory: [
          {
            title: "Senior Full Stack Software Engineer",
            company: "Acme",
            location: "San Francisco, CA",
            startDate: "2019",
            endDate: null,
            currentRole: true,
            description: "Built developer tools.",
            bullets: [],
            achievements: [],
          },
        ],
        education: [],
        projects: [],
        certifications: [],
        languages: [],
        interests: [],
        awards: [],
        volunteerWork: [],
        websites: [],
        totalYearsExperience: 7,
        workAuthorization: "H1B",
        parseConfidence: 0.95,
        inferredAnswers: [],
        relevantIndustry: [],
        relevantSpecialization: [],
        proposedTags: [],
      },
      usedTier: "primary",
      usedModel: "gpt-5.4-nano",
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const res = await ingestCv(
      { userId: "user_v2_explicit_tags", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )

    assert.equal(res.ok, true)
    const tagSet = state.userSets.find((op) => "tags" in op.data)
    assert.ok(tagSet, "expected pa-users.tags write")
    const tags = tagSet!.data.tags as Record<string, unknown>
    assert.equal(tags.targetRoleFunction, undefined)
    assert.equal(tags.careerStage, undefined)
    assert.equal(tags.visaStatus, undefined)
    assert.equal(tags.relevantTags, undefined)
  })

  it("missing pa-users doc → still writes tags from CV-only signals (statedPreferences omitted)", async () => {
    const { db, state } = makeFakeDb() // no users seeded
    const { log } = captureLog()
    let capturedInput: unknown = null
    const { deps } = makeStubbedDeps({ db, log })
    deps.mergeUserTagsFn = (input) => {
      capturedInput = input
      return { skills: [], industryEnum: ["tech_software"], schemaVersion: 1 }
    }
    const res = await ingestCv(
      { userId: "user_new", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.ok(capturedInput, "mergeUserTags still called")
    const captured = capturedInput as Record<string, unknown>
    assert.equal(captured.statedPreferences, undefined, "statedPreferences absent when user doc missing")
    assert.equal(
      state.userSets.filter((op) => "tags" in op.data).length,
      1,
      "pa-users.set still writes tags (creates doc via merge)"
    )
  })

  it("writeUserTags throws → ingestCv still ok:true, error logged, parsedCandidateResumes intact", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.writeUserTags = async () => {
      throw new Error("firestore_unreachable")
    }
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true, "tag-write failure must NOT break cv-ingest")
    assert.equal(state.resumes.length, 1, "parsedCandidateResumes must still be written")
    const errEvt = events.find((e) => e.event === "pa.cv_user_tags.write_error")
    assert.ok(errEvt, "expected pa.cv_user_tags.write_error log event")
  })

  it("mergeUserTags throws → ingestCv still ok:true, error logged, no write attempted", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.mergeUserTagsFn = () => {
      throw new Error("merger_panic")
    }
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(
      state.userSets.filter((op) => "tags" in op.data).length,
      0,
      "no tag .set() attempted when merger throws"
    )
    const errEvt = events.find((e) => e.event === "pa.cv_user_tags.merge_error")
    assert.ok(errEvt, "expected pa.cv_user_tags.merge_error log event")
  })

  it("CV with embedding → embedding fields propagate to mergeUserTags input", async () => {
    const { db } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    let capturedInput: unknown = null
    deps.mergeUserTagsFn = (input) => {
      capturedInput = input
      return { skills: [], industryEnum: ["tech_software"], schemaVersion: 1 }
    }
    const fakeVec = new Array(1536).fill(0.5)
    deps.computeEmbedding = async () => ({
      vector: fakeVec,
      model: "text-embedding-3-small",
      dim: 1536,
      computedAt: "2026-05-05T12:00:00.000Z",
    })
    await ingestCv(
      { userId: "user_e", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    const captured = capturedInput as Record<string, unknown>
    const cv = captured.cv as Record<string, unknown>
    assert.ok(Array.isArray(cv.embedding))
    assert.equal((cv.embedding as unknown[]).length, 1536)
    assert.equal(cv.embeddingModel, "text-embedding-3-small")
    assert.equal(cv.embeddingComputedAt, "2026-05-05T12:00:00.000Z")
  })

  it("CV without embedding → mergeUserTags called without embedding fields", async () => {
    const { db } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    let capturedInput: unknown = null
    deps.mergeUserTagsFn = (input) => {
      capturedInput = input
      return { skills: [], industryEnum: ["other"], schemaVersion: 1 }
    }
    deps.computeEmbedding = async () => null
    await ingestCv(
      { userId: "user_no_embed", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    const captured = capturedInput as Record<string, unknown>
    const cv = captured.cv as Record<string, unknown>
    assert.equal(cv.embedding, undefined)
    assert.equal(cv.embeddingModel, undefined)
  })

  it("cvUpdatedAt timestamp passed through to mergeUserTags", async () => {
    const { db } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    let capturedInput: unknown = null
    deps.mergeUserTagsFn = (input) => {
      capturedInput = input
      return { skills: [], industryEnum: ["tech_software"], schemaVersion: 1 }
    }
    deps.nowIso = () => "2026-05-05T11:22:33.000Z"
    await ingestCv(
      { userId: "user_t", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    const captured = capturedInput as Record<string, unknown>
    assert.equal(captured.cvUpdatedAt, "2026-05-05T11:22:33.000Z")
  })
})

// ---------- Phase 53 (PARSE-09) sha256 idempotency -------------------------

describe("ingestCv sha256 idempotency (Phase 53 PARSE-09)", () => {
  it("idempotent hit: existing resumeId returned, no re-parse, no duplicate write", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    let parseCount = 0
    deps.llmExtract = async () => {
      parseCount++
      return { parsed: happyParsed() }
    }
    // Simulate "already parsed this PDF" via injected hit.
    deps.findResumeBySha256 = async () => "rsm_pre_existing"

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.ok(res.ok && res.resumeId === "rsm_pre_existing")
    assert.equal(parseCount, 0, "must not re-parse on idempotent hit")
    assert.equal(state.resumes.length, 0, "must not write a new doc")
    assert.equal(state.outbound.size, 0, "must not enqueue legacy confirm outbound")
    const hit = events.find((e) => e.event === "pa.cv_ingest.idempotent_hit")
    assert.ok(hit, "expected pa.cv_ingest.idempotent_hit log")
  })

  it("idempotent miss: parses fresh + writes sha256 to doc", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.findResumeBySha256 = async () => null

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!.data
    // sha256 of "[1, 2, 3]" Uint8Array.
    assert.equal(typeof w.sha256, "string")
    assert.ok((w.sha256 as string).length === 64, "sha256 must be 64 hex chars")
  })

  it("findResumeBySha256 throws → fail-open, parses + writes anyway", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.findResumeBySha256 = async () => {
      throw new Error("firestore_unreachable")
    }
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const errEvt = events.find(
      (e) => e.event === "pa.cv_ingest.idempotent_lookup_error"
    )
    assert.ok(errEvt, "expected pa.cv_ingest.idempotent_lookup_error log")
  })
})

// ---------- v2.0 S2 canonical identity before permanent CV writes ----------

describe("ingestCv candidate identity resolution (v2.0 S2)", () => {
  it("public browser upload resolves canonical user before sha256 dedupe or writes", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    const order: string[] = []
    deps.parsePdf = async () => {
      order.push("parse")
      return { text: "public resume", numPages: 1 }
    }
    deps.llmExtract = async () => {
      order.push("llm")
      return { parsed: happyParsed() }
    }
    deps.resolveCandidateIdentity = async (_db, input) => {
      order.push(`identity:${input.browserUid}`)
      return {
        outcome: "created",
        candidateId: "cand_canonical",
        handle: {
          handleId: "email__hash",
          candidateId: "cand_canonical",
          kind: "email",
          handleHash: "hashhashhashhash",
          source: "resume",
          createdAt: "2026-05-13T00:00:00.000Z",
        },
      }
    }
    deps.findResumeBySha256 = async (_db, userId) => {
      order.push(`sha:${userId}`)
      return "rsm_existing"
    }

    const res = await ingestCv(
      {
        userId: "browser_temp",
        browserUid: "browser_temp",
        mediaUrl: "https://example.com/cv.pdf",
      },
      deps
    )

    assert.equal(res.ok, true)
    assert.ok(res.ok && res.userId === "cand_canonical")
    assert.ok(res.ok && res.resumeId === "rsm_existing")
    assert.deepEqual(order, ["parse", "llm", "identity:browser_temp", "sha:cand_canonical"])
    assert.equal(state.resumes.length, 0, "identity-enabled dedupe must avoid duplicate write")
    assert.ok(events.find((e) => e.event === "pa.cv_ingest.identity_resolved"))
  })

  it("identity conflict stops before resume, tags, memory, or follow-up writes", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps, mem0Calls } = makeStubbedDeps({ db, log })
    let tagWriteCount = 0
    deps.writeUserTags = async () => {
      tagWriteCount++
    }
    deps.resolveCandidateIdentity = async () => ({
      outcome: "identity_conflict",
      conflict: {
        conflictId: "identity_conflict_1",
        kind: "pdf_email_employer_email_mismatch",
        status: "open",
        evidence: [],
        payloadRedacted: {},
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    })
    deps.findResumeBySha256 = async () => {
      throw new Error("sha lookup should not run after conflict")
    }

    const res = await ingestCv(
      {
        userId: "ats_temp",
        browserUid: "browser_temp",
        employerEmailHint: "hint@example.com",
        mediaUrl: "https://example.com/cv.pdf",
      },
      deps
    )

    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "identity_conflict")
    assert.ok(!res.ok && res.conflictId === "identity_conflict_1")
    assert.ok(!res.ok && res.extractedEmail === "adam@example.com")
    assert.equal(state.resumes.length, 0)
    assert.equal(tagWriteCount, 0)
    assert.equal(mem0Calls.length, 0)
    assert.equal(state.outbound.size, 0)
    assert.equal(state.inboundEvents.size, 0)
  })

  it("bulk intake can require PDF-extracted email before identity or permanent writes", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const missingEmailParsed: StructuredCv = {
      ...happyParsed(),
      candidateProfile: {
        ...happyParsed().candidateProfile,
        email: null,
      },
    }
    const { deps, mem0Calls } = makeStubbedDeps({
      db,
      log,
      parsed: missingEmailParsed,
    })
    let identityCalls = 0
    let tagWriteCount = 0
    deps.resolveCandidateIdentity = async () => {
      identityCalls++
      throw new Error("identity should not run when PDF email is missing")
    }
    deps.writeUserTags = async () => {
      tagWriteCount++
    }
    deps.findResumeBySha256 = async () => {
      throw new Error("sha lookup should not run without canonical identity")
    }

    const res = await ingestCv(
      {
        userId: "bulk_temp",
        browserUid: "bulk_browser",
        employerEmailHint: "hint@example.com",
        mediaUrl: "https://example.com/cv.pdf",
        identitySource: "admin",
        requireExtractedEmail: true,
      },
      deps
    )

    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "missing_extracted_email")
    assert.equal(identityCalls, 0)
    assert.equal(state.resumes.length, 0)
    assert.equal(tagWriteCount, 0)
    assert.equal(mem0Calls.length, 0)
    assert.equal(state.outbound.size, 0)
    assert.equal(state.inboundEvents.size, 0)
    assert.ok(events.find((e) => e.event === "pa.cv_ingest.missing_extracted_email"))
  })
})

// ---------- Phase 53 (PARSE-08) Sonnet second-pass for ['other'] -----------

describe("ingestCv industry second-pass (Phase 53 PARSE-08, D15)", () => {
  it("triggers when LLM emits ['other'] and writes overridden industries", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const otherParsed: StructuredCv = {
      ...happyParsed(),
      candidateProfile: {
        ...happyParsed().candidateProfile,
        skills: ["leadership"], // no tech tokens — H.3a fallback also returns "other"
      },
      industryTags: ["other"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: otherParsed })
    let secondPassInvoked = false
    deps.runIndustrySecondPassFn = async () => {
      secondPassInvoked = true
      return ["financial_technology", "software_and_saas"]
    }
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(secondPassInvoked, true, "second pass MUST run on ['other']")
    const applied = events.find(
      (e) => e.event === "pa.cv_ingest.industry_second_pass.applied"
    )
    assert.ok(applied, "expected industry_second_pass.applied log")
  })

  it("does NOT trigger when LLM gave non-['other'] industries", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const goodParsed: StructuredCv = {
      ...happyParsed(),
      industryTags: ["tech_software"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: goodParsed })
    let secondPassInvoked = false
    deps.runIndustrySecondPassFn = async () => {
      secondPassInvoked = true
      return []
    }
    await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(secondPassInvoked, false, "second pass MUST NOT run on confident tags")
    void state
  })

  it("second pass returns [] (LLM gave up) → original ['other'] preserved", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const otherParsed: StructuredCv = {
      ...happyParsed(),
      candidateProfile: {
        ...happyParsed().candidateProfile,
        skills: ["leadership"],
      },
      industryTags: ["other"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: otherParsed })
    deps.runIndustrySecondPassFn = async () => []
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const w = state.resumes[0]!.data
    // Legacy industryTags preserved when second pass returns nothing.
    assert.deepEqual(w.industryTags, ["other"])
  })

  it("second pass throws → fail-open, parsed CV still written", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const otherParsed: StructuredCv = {
      ...happyParsed(),
      candidateProfile: {
        ...happyParsed().candidateProfile,
        skills: ["leadership"],
      },
      industryTags: ["other"],
    }
    const { deps } = makeStubbedDeps({ db, log, parsed: otherParsed })
    deps.runIndustrySecondPassFn = async () => {
      throw new Error("simulated")
    }
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    const errEvt = events.find(
      (e) => e.event === "pa.cv_ingest.industry_second_pass.error"
    )
    assert.ok(errEvt, "expected industry_second_pass.error log")
  })
})

// ---------- Phase 53 (PARSE-07) runtime-only post-parse handoff -----------

describe("ingestCv post-parse runtime handoff (Phase 53 PARSE-07, D12)", () => {
  it("no follow-up user record → writes profile, skips runtime message", async () => {
    const { db, state } = makeFakeDb()
    const { log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.lookupUserForFollowup = async () => null
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1)
    assert.equal(state.outbound.size, 0, "CV ingest must not write direct outbounds")
    assert.equal(state.inboundEvents.size, 0, "no routable user means no runtime event")
  })

  it("runtime delivery writes a synthetic inbound event instead of direct outbounds", async () => {
    const { db, state } = makeFakeDb()
    seedRuntimeSession(state)
    const { events, log } = captureLog()
    const { deps } = makeStubbedDeps({ db, log })
    deps.followupDeliveryMode = "runtime"

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )

    assert.equal(res.ok, true)
    assert.equal(state.outbound.size, 0, "runtime mode must not enqueue direct findings outbound")
    assert.equal(state.inboundEvents.size, 1, "runtime mode should hand off through pa-inbound-events")
    const event = [...state.inboundEvents.values()][0]!
    assert.equal(event.status, "pending")
    assert.equal(event.channel, "imessage")
    assert.equal(event.userId, "user_x")
    const rawMeta = event.rawMeta as Record<string, unknown>
    assert.equal(rawMeta.runtimeEvent, true)
    assert.equal(rawMeta.runtimeEventSource, "cv_ingest")
    assert.equal(rawMeta.runtimeEventKind, "resume_parse_completed")
    const context = rawMeta.context as Record<string, unknown>
    assert.equal(context.cvParsedTrigger, true)
    const skipped = events.find((e) => e.event === "pa.cv_followup.direct_outbound_removed")
    assert.equal(skipped?.payload?.reason, "runtime_delivery")
  })

  it("none delivery updates the profile without direct or runtime messages", async () => {
    const { db, state } = makeFakeDb()
    const { events, log } = captureLog()
    const { deps, mem0Calls } = makeStubbedDeps({ db, log })
    deps.followupDeliveryMode = "none"

    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      deps
    )

    assert.equal(res.ok, true)
    assert.equal(state.resumes.length, 1, "profile parsing still writes parsedCandidateResumes")
    assert.equal(mem0Calls.length, 1, "profile parsing still writes long-term memory")
    assert.equal(state.outbound.size, 0, "none mode must not enqueue direct findings outbound")
    assert.equal(state.inboundEvents.size, 0, "none mode must not synthesize an iMessage event")
    const directSkipped = events.find((e) => e.event === "pa.cv_followup.direct_outbound_removed")
    assert.equal(directSkipped?.payload?.reason, "delivery_none")
    const syntheticSkipped = events.find((e) => e.event === "pa.cv_followup.synthetic_trigger_skipped")
    assert.equal(syntheticSkipped?.payload?.reason, "delivery_none")
  })
})
