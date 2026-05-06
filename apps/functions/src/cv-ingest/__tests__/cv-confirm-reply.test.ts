/**
 * Phase 54 (USER-TAG-03 / extends Phase 53 PARSE-07) — Tests for cv-confirm-reply
 * handler + parser.
 *
 * Coverage:
 *   - Confirm-accepted ("对" / "yes") → no merge call
 *   - Skill correction → applyPartialUserTags called with corrected skills
 *   - Industry correction → industrySector populated
 *   - Role correction → targetRoleFunction populated
 *   - LLM error → fail-open, no throw
 *   - Empty / no-op reply → no-op log
 */

import assert from "node:assert/strict"
import test from "node:test"
import { handleCvConfirmReply, detectCvConfirmReply } from "../cv-confirm-reply.js"
import { parseUserCorrection } from "../cv-confirm-reply-parser.js"

// Minimal Firestore stub.
function makeDb(initialDocs: Record<string, Record<string, unknown>> = {}) {
  const writes: Array<{ id: string; data: unknown }> = []
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initialDocs))

  return {
    db: {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: docs.has(id),
            id,
            data: () => docs.get(id),
          }),
          set: async (data: Record<string, unknown>) => {
            writes.push({ id, data })
            docs.set(id, { ...(docs.get(id) ?? {}), ...data })
          },
        }),
        where: () => ({
          where: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => ({ empty: true, docs: [] }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as import("firebase-admin/firestore").Firestore,
    writes,
    docs,
  }
}

// ---------------------------------------------------------------------------
// handleCvConfirmReply
// ---------------------------------------------------------------------------

test("handleCvConfirmReply: 对 → confirmed, no merge call", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-1",
    resumeId: "r-1",
    replyText: "对",
    parseFn: async () => ({
      confirmAccepted: true,
      correctionFreeform: null,
    }),
  })
  assert.equal(res.accepted, true)
  assert.equal(res.correctionsApplied, 0)
  assert.equal(res.resumeId, "r-1")
  // No tag write attempted.
  assert.equal(ctx.writes.length, 0)
})

test("handleCvConfirmReply: yes → confirmed, no merge call", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-2",
    resumeId: "r-2",
    replyText: "yes that looks right",
    parseFn: async () => ({
      confirmAccepted: true,
      correctionFreeform: null,
    }),
  })
  assert.equal(res.accepted, true)
  assert.equal(res.correctionsApplied, 0)
})

test("handleCvConfirmReply: skill correction → applyPartialUserTags called", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-3",
    resumeId: "r-3",
    replyText: "我也做过 React 和 TypeScript",
    parseFn: async () => ({
      confirmAccepted: false,
      correctedSkills: ["react", "typescript"],
      correctionFreeform: "我也做过 React 和 TypeScript",
    }),
  })
  assert.equal(res.accepted, false)
  assert.ok(res.correctionsApplied >= 1)
  // Tag write attempted at least once.
  assert.ok(ctx.writes.length >= 1)
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  // Phase 61 — applyPartialUserTags now upgrades raw string skills to
  // Phase 52 SkillEntry[] (with name + bucket + proficiency + baseWeight)
  // before writing, so the V16 score reads `skills[].baseWeight` correctly.
  const skills = written.tags.skills as Array<{ name: string }>
  assert.deepEqual(
    skills.map((s) => s.name),
    ["react", "typescript"]
  )
})

test("handleCvConfirmReply: industry correction populates industrySector", async () => {
  const ctx = makeDb()
  await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-4",
    resumeId: "r-4",
    replyText: "I'm actually in fintech",
    parseFn: async () => ({
      confirmAccepted: false,
      correctedIndustries: ["financial_technology"],
      correctionFreeform: "I'm actually in fintech",
    }),
  })
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.industrySector, ["financial_technology"])
})

test("handleCvConfirmReply: role correction populates targetRoleFunction", async () => {
  const ctx = makeDb()
  await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-5",
    resumeId: "r-5",
    replyText: "I'm targeting product management",
    parseFn: async () => ({
      confirmAccepted: false,
      correctedRoles: ["product_management"],
      correctionFreeform: null,
    }),
  })
  const written = ctx.writes[0]!.data as { tags: Record<string, unknown> }
  assert.deepEqual(written.tags.targetRoleFunction, ["product_management"])
})

test("handleCvConfirmReply: parse throw → fail-open, no write", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-6",
    resumeId: "r-6",
    replyText: "anything",
    parseFn: async () => {
      throw new Error("simulated_parse_error")
    },
  })
  assert.equal(res.accepted, false)
  assert.equal(res.correctionsApplied, 0)
  assert.equal(res.reason, "parse_error")
  assert.equal(ctx.writes.length, 0)
})

test("handleCvConfirmReply: empty reply → ok:false skip", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-7",
    resumeId: "r-7",
    replyText: "",
    parseFn: async () => ({ confirmAccepted: false }),
  })
  assert.equal(res.accepted, false)
  assert.equal(res.reason, "empty_reply")
  assert.equal(ctx.writes.length, 0)
})

test("handleCvConfirmReply: no userId → ok:false skip", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "",
    replyText: "hello",
  })
  assert.equal(res.accepted, false)
  assert.equal(res.reason, "no_user_id")
})

test("handleCvConfirmReply: non-confirm with no extractable tags → no_corrections log, no write", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-8",
    resumeId: "r-8",
    replyText: "what does this mean",
    parseFn: async () => ({
      confirmAccepted: false,
      correctionFreeform: "what does this mean",
    }),
  })
  assert.equal(res.accepted, false)
  assert.equal(res.correctionsApplied, 0)
  assert.equal(ctx.writes.length, 0)
})

test("handleCvConfirmReply: resolveResumeId injected when resumeId not provided", async () => {
  const ctx = makeDb()
  const res = await handleCvConfirmReply({
    db: ctx.db,
    userId: "u-9",
    replyText: "对",
    resolveResumeId: async () => "r-resolved",
    parseFn: async () => ({ confirmAccepted: true, correctionFreeform: null }),
  })
  assert.equal(res.accepted, true)
  assert.equal(res.resumeId, "r-resolved")
})

// ---------------------------------------------------------------------------
// detectCvConfirmReply
// ---------------------------------------------------------------------------

test("detectCvConfirmReply: empty userId → no match", async () => {
  const ctx = makeDb()
  const res = await detectCvConfirmReply(ctx.db, "")
  assert.equal(res.matches, false)
})

// ---------------------------------------------------------------------------
// parseUserCorrection (unit-level)
// ---------------------------------------------------------------------------

test("parseUserCorrection: empty reply → fail-open", async () => {
  const res = await parseUserCorrection({
    replyText: "",
    apiKey: "k",
  })
  assert.equal(res.confirmAccepted, false)
  assert.equal(res.correctionFreeform, null)
})

test("parseUserCorrection: missing api key → fail-open", async () => {
  const res = await parseUserCorrection({
    replyText: "yes",
    apiKey: "",
  })
  assert.equal(res.confirmAccepted, false)
})

test("parseUserCorrection: LLM stub returns confirm-accepted", async () => {
  const res = await parseUserCorrection({
    replyText: "对",
    apiKey: "k",
    llmCall: async () =>
      JSON.stringify({
        confirmAccepted: true,
        correctionFreeform: null,
      }),
  })
  assert.equal(res.confirmAccepted, true)
})

test("parseUserCorrection: LLM stub returns skill correction (validates + dedupes)", async () => {
  const res = await parseUserCorrection({
    replyText: "我也做过 React, react, and typescript",
    apiKey: "k",
    llmCall: async () =>
      JSON.stringify({
        confirmAccepted: false,
        correctedSkills: ["react", "react", "typescript"],
        correctionFreeform: "我也做过 React",
      }),
  })
  assert.equal(res.confirmAccepted, false)
  // Dedupes "react" duplicate.
  assert.deepEqual(res.correctedSkills, ["react", "typescript"])
})

test("parseUserCorrection: LLM stub returns malformed JSON → fail-open", async () => {
  const res = await parseUserCorrection({
    replyText: "test",
    apiKey: "k",
    llmCall: async () => "<<not json>>",
  })
  assert.equal(res.confirmAccepted, false)
  assert.equal(res.correctionFreeform, "test")
})

test("parseUserCorrection: LLM stub returns invalid schema → fail-open", async () => {
  const res = await parseUserCorrection({
    replyText: "test",
    apiKey: "k",
    llmCall: async () => JSON.stringify({ wrongShape: true }),
  })
  assert.equal(res.confirmAccepted, false)
})

test("parseUserCorrection: LLM stub throws → fail-open", async () => {
  const res = await parseUserCorrection({
    replyText: "test",
    apiKey: "k",
    llmCall: async () => {
      throw new Error("simulated_llm_error")
    },
  })
  assert.equal(res.confirmAccepted, false)
  assert.equal(res.correctionFreeform, "test")
})
