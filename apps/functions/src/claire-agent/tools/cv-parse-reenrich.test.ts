/**
 * cv-parse-reenrich.test.ts — #3 conversational re-enrich hook (Adam 2026-06-05).
 *
 * The `cv_parse` chat tool used to DEAD-END a résumé pasted as TEXT: it parsed the text
 * and returned the struct to the LLM but never persisted / re-enriched (so role/skills were
 * never re-derived, find_match never refreshed). The attachment (webhook Stream-D) + website
 * (public-cv-ingest) paths both flow through the canonical `ingestCv`→`runUserTagsMerge` enrich;
 * pasted text had no seam because `ingestCv` is mediaUrl-only.
 *
 * The fix wires `cv_parse`'s success branch to `reEnrichUserTagsFromParsedResume` (the SAME D8
 * writer, fire-and-forget, fail-open). The END-TO-END enrich + role re-derive is proven offline
 * by the helper unit test (cv-ingest.test.ts → "reEnrichUserTagsFromParsedResume — #3 ...").
 *
 * THIS file is the TOOL-WIRING regression guard: the import didn't break module init, the tool
 * is still registered, and the too-short early-exit path takes no side effect. The success branch
 * itself calls the REAL parseResumeText + reEnrich (both real-model), so it is covered by the
 * helper unit + the live resume-e2e driver, not re-driven here with a model.
 *
 * Pure/offline. No SDK/LLM/network.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMatchingTools } from "./matching-tools.js"
import type { ClaireToolContext } from "../types.js"

function makeCtx(overrides: Partial<ClaireToolContext> = {}): ClaireToolContext {
  return {
    db: {} as never,
    userId: "u1",
    sessionId: "s1",
    lang: "en",
    transport: {
      markRead: async () => {},
      typing: async () => {},
      sendStatus: async () => {},
      sendText: async () => {},
      tapback: async () => {},
      noReply: async () => {},
    },
    judgeModel: "gpt-4.1-mini",
    log: () => {},
    nowIso: () => "2026-06-05T00:00:00.000Z",
    ...overrides,
  } as ClaireToolContext
}

function cvParseTool(ctx: ClaireToolContext) {
  const t = buildMatchingTools(ctx).find((x) => (x as { name?: string }).name === "cv_parse")
  assert.ok(t, "cv_parse tool must be registered")
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}

async function call(t: { invoke: (a: never, raw: string) => Promise<unknown> }, args: unknown) {
  const raw = await t.invoke({} as never, JSON.stringify(args))
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

test("cv_parse is still registered after the re-enrich import (module init intact)", () => {
  const ctx = makeCtx()
  const t = cvParseTool(ctx)
  assert.ok(t)
})

test("cv_parse short input early-exits before parse/re-enrich — no side effect, no throw", async () => {
  // Spy on the log: the re-enrich would log pa.cv_reenrich.* / pa.claire.cv_parse; a too-short
  // input must short-circuit BEFORE any of that (and never touch the db).
  const events: string[] = []
  const ctx = makeCtx({
    log: (event: string) => {
      events.push(event)
    },
    // A throwing db proves the early-exit path never reaches the enrich seam (which reads the db).
    db: {
      collection: () => {
        throw new Error("db must not be touched on the too-short early-exit")
      },
    } as never,
  })
  const t = cvParseTool(ctx)
  const res = await call(t, { resumeText: "too short" })
  assert.equal(res.ok, false)
  assert.match(String(res.reason), /too short/i)
  assert.equal(
    events.includes("pa.claire.cv_parse"),
    false,
    "no parse event on the too-short path",
  )
  assert.equal(
    events.some((e) => e.startsWith("pa.cv_reenrich")),
    false,
    "no re-enrich event on the too-short path",
  )
})
