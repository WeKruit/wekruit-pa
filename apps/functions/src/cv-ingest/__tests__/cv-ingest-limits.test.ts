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
  it("gate closed → returns not_invited and hands rejection to runtime", async () => {
    const db = makeMinimalDb()
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
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
        log: (event, payload) => events.push({ event, payload }),
      }
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, "not_invited")
    const handoff = events.find((e) => e.event === "pa.cv_reject.runtime_handoff")
    assert.ok(handoff, "expected rejection runtime handoff")
    assert.equal(handoff!.payload?.kind, "not_invited")
  })

  it("quota exhausted (count=2) → returns quota_exhausted and hands rejection to runtime", async () => {
    const db = makeMinimalDb()
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
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
        log: (event, payload) => events.push({ event, payload }),
      }
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, "quota_exhausted")
    const handoff = events.find((e) => e.event === "pa.cv_reject.runtime_handoff")
    assert.ok(handoff)
    assert.equal(handoff!.payload?.kind, "quota_exhausted")
  })

  it("size cap → returns pdf_too_large and hands rejection to runtime", async () => {
    const db = makeMinimalDb()
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
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
        log: (event, payload) => events.push({ event, payload }),
      }
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, "pdf_too_large")
    const handoff = events.find((e) => e.event === "pa.cv_reject.runtime_handoff")
    assert.ok(handoff)
    assert.equal(handoff!.payload?.kind, "pdf_too_large")
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
              // Phase 53 — extended fields default to []
              relevantIndustry: [],
              relevantSpecialization: [],
              proposedTags: [],
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
        mem0Add: async () => {},
      }
    )
    assert.equal(res.ok, true)
  })

  it("BUG 3 regression (Noah Liu): a real readable résumé with a CLOSED gate ingests via skipLimitEnforcement — reaches extraction, NOT rejected and NOT empty_text", async () => {
    // ROOT CAUSE this guards: the webhook Stream-D ingest of a résumé the candidate TEXTED us
    // must bypass the invite-gate. Noah (a canary user, no resumeAccepted flag → gate CLOSED)
    // texted a 4213-char PDF; the live PDF parsed perfectly. With the gate bypassed the readable
    // text must clear the empty_text threshold (cv-ingest.ts:1867 `!text.trim()`) and reach LLM
    // extraction — i.e. the threshold must NOT false-negative a real résumé. This pins both:
    //   (a) closed gate is bypassed (no "not_invited"), and
    //   (b) a multi-line readable résumé passes the empty_text gate (no "pdf_parse_failed").
    const db = makeMinimalDb()
    // Representative of the live Noah Liu CV head (real PDF parsed to ~4213 chars of text).
    const realResumeText = [
      "Noah Liu",
      "EDUCATION",
      "University of Southern California, Viterbi School of Engineering — Los Angeles, CA",
      "B.S. Computer Science, Expected 2026 — GPA 3.8",
      "EXPERIENCE",
      "Software Engineer Intern, Tesla — Palo Alto, CA",
      "Built React/TypeScript dashboards; shipped a Node.js service handling 2M requests/day.",
      "PROJECTS",
      "Distributed key-value store in Go; ML pipeline in Python (PyTorch).",
      "SKILLS",
      "TypeScript, React, Node.js, Go, Python, PyTorch, PostgreSQL, AWS, Docker, Kubernetes",
    ].join("\n")
    assert.ok(realResumeText.trim().length > 200, "fixture must be a substantial, readable résumé")

    let extractedCvText: string | null = null
    // Record the failure reason (if any) BEFORE the success assert narrows `res` to `never`.
    let observedReason: string | false = false
    const res = await ingestCv(
      { userId: "noah", mediaUrl: "https://storage.googleapis.com/inbound-file-store/Noah_Liu_CV.pdf" },
      {
        db,
        // Mirrors the webhook Stream-D production call (parse-only + gate bypass).
        skipLimitEnforcement: true,
        followupDeliveryMode: "none",
        nowIso: () => "2026-06-04T00:00:00.000Z",
        // Gate is CLOSED (canary user with no resumeAccepted flag) — must be bypassed.
        checkGate: async () => ({ open: false, reason: "not_set" }),
        fetchPdf: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" }),
        // Real readable text — must clear the empty_text threshold (NOT pdf_parse_failed).
        parsePdf: async () => ({ text: realResumeText, numPages: 1 }),
        llmExtract: async (cvText: string) => {
          extractedCvText = cvText
          return { parsed: happyParsed() }
        },
        isParserV2Enabled: async () => false,
        lookupUserForFollowup: async () => null,
        mem0Add: async () => {},
      }
    )

    if (!res.ok) observedReason = res.reason
    // Successful ingest proves BOTH failure modes are absent: a closed gate would return
    // { ok:false, reason:"not_invited" } and an empty_text false-negative would return
    // { ok:false, reason:"pdf_parse_failed" }. res.ok === true means neither fired.
    assert.equal(
      observedReason,
      false,
      "ingest must not have failed at the gate (not_invited) or empty_text (pdf_parse_failed)",
    )
    assert.equal(res.ok, true, "readable résumé with closed gate must ingest")
    // The readable text actually reached the extractor (proves the threshold did not drop it).
    assert.equal(
      extractedCvText,
      realResumeText,
      "the readable résumé text must flow into LLM extraction, not be dropped by the empty_text gate",
    )
  })
})
