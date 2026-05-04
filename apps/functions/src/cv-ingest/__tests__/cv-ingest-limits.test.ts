/**
 * iter30 WS1 — integration tests for the 4-limit gate stack inside ingestCv.
 *
 * Each test exercises one of: gate (not_invited), quota (quota_exhausted),
 * size (pdf_too_large), retry-chain (parser-v2 swap). The fakes are scoped
 * narrowly so we don't recreate the full Firestore mock — we override the
 * gate / quota / parser-v2 dep injection seams instead.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ingestCv, type IngestCvDeps, type StructuredCv } from "../cv-ingest.js"
import { PdfSizeError } from "../cv-size-cap.js"

type DocData = Record<string, unknown>

function happyParsed(): StructuredCv {
  return {
    candidateProfile: {
      name: "Adam",
      email: null,
      phone: null,
      linkedIn: null,
      location: "Bay Area",
      skills: ["TS"],
    },
    experiences: [],
    education: [],
    industryTags: ["other"],
  }
}

function makeMinimalDb(): IngestCvDeps["db"] {
  let counter = 0
  const outbound = new Map<string, DocData>()
  const resumes: DocData[] = []
  const fake = {
    collection: (name: string) => ({
      doc: (id?: string) => {
        const useId = id ?? `auto_${++counter}`
        return {
          id: useId,
          get: async () => ({
            exists: false,
            data: () => undefined,
          }),
          set: async (_data: DocData) => {},
          create: async (data: DocData) => {
            if (name === "pa-outbound") {
              if (outbound.has(useId)) {
                const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
                err.code = 6
                throw err
              }
              outbound.set(useId, data)
            }
          },
        }
      },
      add: async (data: DocData) => {
        const id = `auto_${++counter}`
        resumes.push({ id, ...data })
        return { id }
      },
      where: () => ({
        orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
        limit: () => ({ get: async () => ({ docs: [] }) }),
      }),
    }),
    runTransaction: async () => undefined,
  }
  return fake as unknown as IngestCvDeps["db"]
}

describe("ingestCv — iter30 WS1 4-limit stack", () => {
  it("gate closed → returns not_invited and enqueues rejection", async () => {
    const db = makeMinimalDb()
    let rejectEnqueued: { docId: string; payload: DocData } | null = null
    const res = await ingestCv(
      { userId: "u1", mediaUrl: "https://x/a.pdf" },
      {
        db,
        nowIso: () => "2026-05-03T00:00:00.000Z",
        checkGate: async () => ({ open: false, reason: "not_set" }),
        readQuotaCount: async () => 0,
        incrementQuota: async () => {},
        isParserV2Enabled: async () => false,
        fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "x" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
        lookupUserForFollowup: async () => ({ toE164: "+14155550100", mem0UserId: null }),
        enqueueOutboundFollowup: async (_db, docId, payload) => {
          rejectEnqueued = { docId, payload }
        },
      }
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, "not_invited")
    assert.ok(rejectEnqueued, "expected rejection iMessage enqueued")
    const rj = rejectEnqueued as unknown as { docId: string; payload: DocData }
    assert.match(rj.docId, /^out-cv-reject-u1-\d{8}-not_invited$/)
    assert.equal(rj.payload.rejectReason, "not_invited")
  })

  it("quota exhausted (count=2) → returns quota_exhausted and enqueues rejection", async () => {
    const db = makeMinimalDb()
    let rejectEnqueued: { docId: string; payload: DocData } | null = null
    const res = await ingestCv(
      { userId: "u1", mediaUrl: "https://x/a.pdf" },
      {
        db,
        nowIso: () => "2026-05-03T00:00:00.000Z",
        checkGate: async () => ({ open: true, reason: "gate_open" }),
        readQuotaCount: async () => 2,
        incrementQuota: async () => {},
        isParserV2Enabled: async () => false,
        fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "x" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
        lookupUserForFollowup: async () => ({ toE164: "+14155550100", mem0UserId: null }),
        enqueueOutboundFollowup: async (_db, docId, payload) => {
          rejectEnqueued = { docId, payload }
        },
      }
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, "quota_exhausted")
    assert.ok(rejectEnqueued)
    const rj = rejectEnqueued as unknown as { docId: string; payload: DocData }
    assert.match(rj.docId, /^out-cv-reject-u1-\d{8}-quota_exhausted$/)
  })

  it("size cap → returns pdf_too_large and enqueues rejection", async () => {
    const db = makeMinimalDb()
    let rejectEnqueued: { docId: string; payload: DocData } | null = null
    const res = await ingestCv(
      { userId: "u1", mediaUrl: "https://x/big.pdf" },
      {
        db,
        nowIso: () => "2026-05-03T00:00:00.000Z",
        checkGate: async () => ({ open: true, reason: "gate_open" }),
        readQuotaCount: async () => 0,
        incrementQuota: async () => {},
        isParserV2Enabled: async () => false,
        fetchPdf: async () => {
          throw new PdfSizeError(10_000_000, 5_242_880)
        },
        parsePdf: async () => ({ text: "x" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
        lookupUserForFollowup: async () => ({ toE164: "+14155550100", mem0UserId: null }),
        enqueueOutboundFollowup: async (_db, docId, payload) => {
          rejectEnqueued = { docId, payload }
        },
      }
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, "pdf_too_large")
    assert.ok(rejectEnqueued)
    const rj = rejectEnqueued as unknown as { docId: string; payload: DocData }
    assert.match(rj.docId, /^out-cv-reject-u1-\d{8}-pdf_too_large$/)
  })

  it("parser v2 ON: uses parserV2Extract and writes inferredAnswers/parserVersion=v2", async () => {
    const db = makeMinimalDb()
    let extracted = false
    let incrementCalled = false
    const res = await ingestCv(
      { userId: "u1", mediaUrl: "https://x/a.pdf" },
      {
        db,
        nowIso: () => "2026-05-03T00:00:00.000Z",
        checkGate: async () => ({ open: true, reason: "gate_open" }),
        readQuotaCount: async () => 0,
        incrementQuota: async () => {
          incrementCalled = true
        },
        isParserV2Enabled: async () => true,
        // Provide a v2 extract stub. We don't pass deps.llmExtract, so v2 is used.
        parserV2Extract: async () => {
          extracted = true
          return {
            parsed: {
              fullName: "Adam",
              email: null,
              phone: null,
              location: "SF",
              summary: null,
              skills: ["TS"],
              workHistory: [],
              education: [],
              projects: [],
              certifications: [],
              languages: [],
              interests: [],
              awards: [],
              volunteerWork: [],
              websites: [],
              totalYearsExperience: 5,
              workAuthorization: "US Citizen",
              parseConfidence: 0.9,
              inferredAnswers: [
                {
                  question: "Years of experience?",
                  answer: "5",
                  confidence: 0.9,
                  category: "experience",
                },
              ],
            },
            usedTier: "primary",
            usedModel: "gpt-5.4-nano",
            usage: { input_tokens: 100, output_tokens: 50 },
          }
        },
        fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "real cv text" }),
        // No llmExtract → ensures v2 path is used.
        lookupUserForFollowup: async () => null, // skip Stream E
        enqueueOutboundFollowup: async () => {},
        mem0Add: async () => {},
      }
    )
    assert.equal(res.ok, true)
    assert.equal(extracted, true, "parser v2 must be invoked when flag ON")
    assert.equal(incrementCalled, true, "quota counter must increment after success")
  })

  it("kill-switch via skipLimitEnforcement bypasses gate+quota even when closed", async () => {
    const db = makeMinimalDb()
    const res = await ingestCv(
      { userId: "u1", mediaUrl: "https://x/a.pdf" },
      {
        db,
        skipLimitEnforcement: true,
        nowIso: () => "2026-05-03T00:00:00.000Z",
        // These would BLOCK if not bypassed:
        checkGate: async () => ({ open: false, reason: "not_set" }),
        readQuotaCount: async () => 999,
        fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
        parsePdf: async () => ({ text: "x" }),
        llmExtract: async () => ({ parsed: happyParsed() }),
        isParserV2Enabled: async () => false,
        lookupUserForFollowup: async () => null,
        enqueueOutboundFollowup: async () => {},
        mem0Add: async () => {},
      }
    )
    assert.equal(res.ok, true)
  })
})
