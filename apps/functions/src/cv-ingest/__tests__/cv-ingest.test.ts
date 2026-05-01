import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { ingestCv, type IngestCvDeps, type StructuredCv } from "../cv-ingest.js"

// ---------- Tiny fake Firestore (only .collection().add() is used) -----------

type DocData = Record<string, unknown>

function makeFakeDb() {
  const writes: Array<{ collection: string; data: DocData }> = []
  let nextId = 1
  const db = {
    collection(name: string) {
      return {
        async add(data: DocData) {
          const id = `rsm_${nextId++}`
          writes.push({ collection: name, data: { ...data } })
          return { id }
        },
      }
    },
  } as unknown as IngestCvDeps["db"]
  return { db, writes }
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
  }
}

function captureLog() {
  const events: Array<{ event: string; payload: Record<string, unknown> | undefined }> = []
  const log = (event: string, payload?: Record<string, unknown>) => {
    events.push({ event, payload })
  }
  return { events, log }
}

// ---------- Tests ------------------------------------------------------------

describe("ingestCv", () => {
  it("happy path: writes parsedCandidateResumes with full schema match", async () => {
    const { db, writes } = makeFakeDb()
    const { log } = captureLog()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/path/cv.pdf", sessionId: "ses_x" },
      {
        db,
        log,
        nowIso: () => "2026-04-30T00:00:00.000Z",
        fetchPdf: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "John Doe\nWorked at WeKruit.", numPages: 1 }),
        llmExtract: async () => ({
          parsed: happyParsed(),
          usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
        }),
      }
    )
    assert.equal(res.ok, true)
    assert.ok(res.ok && res.resumeId.startsWith("rsm_"))
    assert.equal(writes.length, 1)
    const w = writes[0]!
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
    const { db, writes } = makeFakeDb()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        fetchPdf: async () => {
          throw new Error("HTTP 404 Not Found")
        },
        parsePdf: async () => ({ text: "should not run" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "download_failed")
    assert.equal(writes.length, 0)
  })

  it("pdf-parse throws → returns ok:false reason:pdf_parse_failed", async () => {
    const { db, writes } = makeFakeDb()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        fetchPdf: async () => ({ bytes: new Uint8Array([0x25, 0x50]), contentType: "application/pdf" }),
        parsePdf: async () => {
          throw new Error("malformed PDF")
        },
        llmExtract: async () => ({ parsed: happyParsed() }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "pdf_parse_failed")
    assert.equal(writes.length, 0)
  })

  it("LLM extract returns malformed shape → returns ok:false reason:llm_parse_failed", async () => {
    const { db, writes } = makeFakeDb()
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "https://example.com/cv.pdf" },
      {
        db,
        fetchPdf: async () => ({ bytes: new Uint8Array([0x25]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "real cv text" }),
        // Missing required candidateProfile.skills array → validator throws.
        llmExtract: async () =>
          ({ parsed: { candidateProfile: { name: "x" } } as unknown as StructuredCv }),
      }
    )
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.reason === "llm_parse_failed")
    assert.equal(writes.length, 0)
  })

  it("empty mediaUrl → returns ok:false reason:invalid_input (no fetch attempted)", async () => {
    const { db } = makeFakeDb()
    let fetchCount = 0
    const res = await ingestCv(
      { userId: "user_x", mediaUrl: "" },
      {
        db,
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
        log,
        fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "real cv text" }),
        llmExtract: async () => ({
          parsed: happyParsed(),
          usage: { input_tokens: 1234, output_tokens: 567, total_tokens: 1801 },
        }),
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
})
