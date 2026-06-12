/**
 * start-by-name-prescreen.test.ts — CANONICAL role/company resolution (Adam 2026-05-31).
 *
 * Replaces literal string-overlap matching: a fuzzy reference ("some product role", "the design role
 * at the voice company", "the fintech one") is resolved on the SAME canonical @wekruit/shared-tags
 * vocab the tag extractor uses (roleFunction / industrySector / company) — NOT title token overlap.
 *
 *   scoreRoleAgainstQuery / rankRoles — pure canonical scorer: no_match / one / ambiguous (a tie is
 *                                       ALWAYS ambiguous → the agent clarifies, never a silent pick).
 *   loadCandidateRoles                — matched (lastCollabRoles) ∪ prescreened (sessions), enriched
 *                                       with the job's canonical tags (matching-jobs back-fill).
 *   find_my_role tool                 — the agent composes the canonical query; the tool ranks.
 *   begin_collab_prescreen({jobId})   — starts the RESOLVED jobId; a non-matched jobId → not_matched.
 *   prescreenStatusFromTerminal / prescreenStatusFromSession / check_prescreen_progress — HITL-review-aware:
 *                                       a PASS/FAIL still pending operator commit reports 'under_review',
 *                                       never 'passed'/'not_passed' (so Claire can't tell a candidate they
 *                                       passed before a human confirms it).
 *
 * Pure/offline against a Firestore-faithful fake. No SDK/LLM/network — deterministic.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  scoreRoleAgainstQuery,
  rankRoles,
  prescreenStatusFromTerminal,
  prescreenStatusFromSession,
  buildMatchingTools,
  type CollabRole,
  type RoleQuery,
} from "./matching-tools.js"
import type { ClaireToolContext } from "../types.js"

// Enriched roles mirroring the LIVE collab inventory (matching-jobs canonical tags).
const DESIGNER: CollabRole = { jobId: "job-invoko-designer", company: "invoko.ai", title: "Product Designer", roleFunction: ["creatives_and_design", "product_management"], industrySector: ["technology_general", "software_and_saas"], status: "matched" }
const PM: CollabRole = { jobId: "job-invoko-pm", company: "invoko.ai", title: "Product Manager", roleFunction: ["product_management"], industrySector: ["technology_general", "software_and_saas"], status: "matched" }
const HELIUM: CollabRole = { jobId: "job-helium", company: "Helium", title: "Backend Engineer", roleFunction: ["software_engineering", "engineering_and_development"], industrySector: ["technology_general"], status: "matched" }
const METAVOICE: CollabRole = { jobId: "job-metavoice", company: "MetaVoice", title: "Research Scientist", roleFunction: ["data_analysis", "software_engineering"], industrySector: ["artificial_intelligence_and_machine_learning"], status: "matched" }
const ROLES = [DESIGNER, PM, HELIUM, METAVOICE]

// ── scoreRoleAgainstQuery / rankRoles — CANONICAL matching ───────────────────

test("'some product role' (roleFunction:product_management) → BOTH the Designer and PM → ambiguous", () => {
  // The Designer's roleFunction INCLUDES product_management, so a product reference hits both.
  const q: RoleQuery = { roleFunction: ["product_management"] }
  const r = rankRoles(ROLES, q)
  assert.equal(r.kind, "ambiguous")
  const ids = r.kind === "ambiguous" ? r.candidates.map((c) => c.jobId).sort() : []
  assert.deepEqual(ids, ["job-invoko-designer", "job-invoko-pm"].sort())
})

test("'the design role' (roleFunction:creatives_and_design) → ONLY the Designer → one", () => {
  const r = rankRoles(ROLES, { roleFunction: ["creatives_and_design"] })
  assert.equal(r.kind, "one")
  assert.equal(r.kind === "one" && r.best.jobId, "job-invoko-designer")
})

test("'the invoko one' (company only) → all invoko roles tie → ambiguous (which invoko)", () => {
  const r = rankRoles(ROLES, { company: "invoko" })
  assert.equal(r.kind, "ambiguous")
  assert.equal(r.kind === "ambiguous" && r.candidates.length, 2)
})

test("'the invoko design role' (company + roleFunction) → Designer wins over PM", () => {
  const r = rankRoles(ROLES, { company: "invoko", roleFunction: ["creatives_and_design"] })
  assert.equal(r.kind, "one")
  assert.equal(r.kind === "one" && r.best.jobId, "job-invoko-designer")
})

test("'the AI/ML research one' (industrySector) → MetaVoice via canonical industry overlap", () => {
  const r = rankRoles(ROLES, { industrySector: ["artificial_intelligence_and_machine_learning"] })
  assert.equal(r.kind, "one")
  assert.equal(r.kind === "one" && r.best.jobId, "job-metavoice")
})

test("'the engineering role' (roleFunction:software_engineering) → Helium + MetaVoice → ambiguous", () => {
  const r = rankRoles(ROLES, { roleFunction: ["software_engineering"] })
  assert.equal(r.kind, "ambiguous")
  const ids = r.kind === "ambiguous" ? r.candidates.map((c) => c.jobId).sort() : []
  assert.deepEqual(ids, ["job-helium", "job-metavoice"].sort())
})

test("no canonical signal matches → no_match (must guide them to the website)", () => {
  // legal_and_compliance — no role has it; company that isn't theirs.
  assert.equal(rankRoles(ROLES, { roleFunction: ["legal_and_compliance"] }).kind, "no_match")
  assert.equal(rankRoles(ROLES, { company: "Google" }).kind, "no_match")
  assert.equal(rankRoles([], { roleFunction: ["product_management"] }).kind, "no_match")
})

test("company normalization ignores tld/suffix: 'invoko' matches company 'invoko.ai'", () => {
  // 'invoko' normalizes-equal to 'invoko.ai' (the .ai tld is stripped) → the invoko role matches,
  // Helium does not → exactly one. Proves the suffix didn't block the company match.
  const r = rankRoles([DESIGNER, HELIUM], { company: "invoko" })
  assert.equal(r.kind, "one")
  assert.equal(r.kind === "one" && r.best.jobId, "job-invoko-designer")
})

test("scoreRoleAgainstQuery: canonical roleFunction outweighs a raw-text token tiebreak", () => {
  // raw query token 'engineer' overlaps Helium's title, but the canonical product_management signal
  // for the PM scores higher (5 vs 1) → ranking favors the canonical match.
  const pmScore = scoreRoleAgainstQuery(PM, { roleFunction: ["product_management"], query: "engineer" })
  const heliumScore = scoreRoleAgainstQuery(HELIUM, { roleFunction: ["product_management"], query: "engineer" })
  assert.ok(pmScore > heliumScore, `canonical PM (${pmScore}) must beat token-only Helium (${heliumScore})`)
})

// ── prescreenStatusFromTerminal ──────────────────────────────────────────────

test("prescreenStatusFromTerminal (bare terminal, no review) maps PASS→passed, FAIL→not_passed, null/other→in_progress", () => {
  assert.equal(prescreenStatusFromTerminal("PASS"), "passed")
  assert.equal(prescreenStatusFromTerminal("pass"), "passed")
  assert.equal(prescreenStatusFromTerminal("FAIL"), "not_passed")
  assert.equal(prescreenStatusFromTerminal("HARD_STOP"), "not_passed")
  assert.equal(prescreenStatusFromTerminal(null), "in_progress")
  assert.equal(prescreenStatusFromTerminal(undefined), "in_progress")
  assert.equal(prescreenStatusFromTerminal("PAUSE"), "in_progress")
})

test("prescreenStatusFromTerminal: a PENDING-review PASS is under_review, NOT passed (the HIGH-sev bug)", () => {
  // terminalActionPendingReview === true → Claire's verdict, NOT operator-committed → under_review.
  assert.equal(prescreenStatusFromTerminal("PASS", { pendingReview: true }), "under_review")
  assert.equal(prescreenStatusFromTerminal("PASS", { reviewStatus: "pending" }), "under_review")
  // a pending FAIL/HARD_STOP is likewise operator-gated → under_review (not not_passed yet).
  assert.equal(prescreenStatusFromTerminal("FAIL", { pendingReview: true }), "under_review")
  assert.equal(prescreenStatusFromTerminal("HARD_STOP", { reviewStatus: "pending" }), "under_review")
})

test("prescreenStatusFromTerminal: a COMMITTED PASS/FAIL resolves to the real outcome", () => {
  // commit flips terminalActionPendingReview→false and review.status→approved|overridden.
  assert.equal(prescreenStatusFromTerminal("PASS", { pendingReview: false, reviewStatus: "approved" }), "passed")
  assert.equal(prescreenStatusFromTerminal("PASS", { reviewStatus: "overridden" }), "passed")
  assert.equal(prescreenStatusFromTerminal("FAIL", { pendingReview: false, reviewStatus: "approved" }), "not_passed")
})

// ── prescreenStatusFromSession (reads the session's HITL signals) ─────────────

test("prescreenStatusFromSession: pending PASS → under_review", () => {
  assert.equal(
    prescreenStatusFromSession({ terminal: "PASS", terminalActionPendingReview: true, review: { status: "pending" } }),
    "under_review",
  )
})

test("prescreenStatusFromSession: committed PASS → passed", () => {
  assert.equal(
    prescreenStatusFromSession({ terminal: "PASS", terminalActionPendingReview: false, review: { status: "approved" } }),
    "passed",
  )
})

test("prescreenStatusFromSession: pending FAIL → under_review; committed FAIL → not_passed", () => {
  assert.equal(
    prescreenStatusFromSession({ terminal: "FAIL", terminalActionPendingReview: true, review: { status: "pending" } }),
    "under_review",
  )
  assert.equal(
    prescreenStatusFromSession({ terminal: "FAIL", terminalActionPendingReview: false, review: { status: "overridden" } }),
    "not_passed",
  )
})

test("prescreenStatusFromSession: no terminal → in_progress; missing/empty review with terminal is treated as committed", () => {
  assert.equal(prescreenStatusFromSession({}), "in_progress")
  assert.equal(prescreenStatusFromSession({ terminal: null }), "in_progress")
  // a terminal with NEITHER pending flag (e.g. legacy doc that never went through HITL) → committed outcome.
  assert.equal(prescreenStatusFromSession({ terminal: "PASS" }), "passed")
})

// ── fake Firestore ───────────────────────────────────────────────────────────

function makeFakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed))
  const matchDocs = (col: string, predicates: Array<[string, unknown]>) => {
    const docs: Array<{ id: string; data: () => Record<string, unknown> }> = []
    for (const [key, val] of store.entries()) {
      if (!key.startsWith(`${col}/`)) continue
      if (predicates.every(([f, v]) => val[f] === v)) docs.push({ id: key.slice(col.length + 1), data: () => val })
    }
    return docs
  }
  const collection = (col: string) => {
    const predicates: Array<[string, unknown]> = []
    const q: Record<string, unknown> = {
      where(f: string, _op: string, v: unknown) { predicates.push([f, v]); return q },
      limit() { return q },
      async get() { const docs = matchDocs(col, predicates); return { docs, empty: docs.length === 0, size: docs.length } },
    }
    return {
      doc: (id: string) => ({
        async get() { const key = `${col}/${id}`; return { exists: store.has(key), id, data: () => store.get(key) } },
        async set(data: Record<string, unknown>) { store.set(`${col}/${id}`, { ...(store.get(`${col}/${id}`) ?? {}), ...data }) },
      }),
      ...q,
    }
  }
  return { db: { collection } as never, store }
}

function makeCtx(db: never, overrides: Partial<ClaireToolContext> = {}): ClaireToolContext {
  return {
    db, userId: "u1", sessionId: "s1", lang: "en",
    transport: { markRead: async () => {}, typing: async () => {}, sendStatus: async () => {}, sendText: async () => {}, tapback: async () => {}, noReply: async () => {} },
    judgeModel: "gpt-4.1-mini", log: () => {}, nowIso: () => "2026-05-31T00:00:00.000Z",
    ...overrides,
  } as ClaireToolContext
}

function tool(ctx: ClaireToolContext, name: string) {
  const t = buildMatchingTools(ctx).find((x) => (x as { name?: string }).name === name)
  assert.ok(t, `tool ${name} must be registered`)
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}
async function call(t: { invoke: (a: never, raw: string) => Promise<unknown> }, args: unknown) {
  const raw = await t.invoke({} as never, JSON.stringify(args))
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

// lastCollabRoles seed (enriched, as find_match now persists it).
const LAST_COLLAB = [
  { jobId: "job-invoko-designer", company: "invoko.ai", title: "Product Designer", roleFunction: ["creatives_and_design", "product_management"], industrySector: ["technology_general"] },
  { jobId: "job-invoko-pm", company: "invoko.ai", title: "Product Manager", roleFunction: ["product_management"], industrySector: ["technology_general"] },
  { jobId: "job-helium", company: "Helium", title: "Backend Engineer", roleFunction: ["software_engineering"], industrySector: ["technology_general"] },
]

// ── find_my_role tool ────────────────────────────────────────────────────────

test("find_my_role: agent composes roleFunction:product_management → ambiguous designer+PM", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { lastCollabRoles: LAST_COLLAB } })
  const out = await call(tool(makeCtx(db), "find_my_role"), { roleFunction: ["product_management"], company: null, industrySector: null, query: "how'd the product role go?" })
  assert.equal(out.ok, true)
  assert.equal(out.kind, "ambiguous")
  assert.equal((out.candidates as unknown[]).length, 2)
})

test("find_my_role: roleFunction:creatives_and_design → one (the Designer), with status", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { lastCollabRoles: LAST_COLLAB } })
  const out = await call(tool(makeCtx(db), "find_my_role"), { roleFunction: ["creatives_and_design"], company: null, industrySector: null, query: null })
  assert.equal(out.kind, "one")
  const best = out.best as Record<string, string>
  assert.equal(best.jobId, "job-invoko-designer")
  assert.equal(best.status, "matched")
})

test("find_my_role: prescreened session status OVERRIDES 'matched' + back-fills tags from matching-jobs", async () => {
  const { db } = makeFakeDb({
    // lastCollabRoles WITHOUT tags (old write) → back-fill from matching-jobs.
    "pa-users/u1": { lastCollabRoles: [{ jobId: "job-invoko-designer", company: "invoko.ai", title: "Product Designer" }] },
    "matching-jobs/job-invoko-designer": { roleFunction: ["creatives_and_design", "product_management"], industrySector: ["technology_general"], companyName: "invoko.ai", jobTitle: "Product Designer" },
    // a prescreen session for that job, PASS → status should be 'passed'.
    "pa-prescreen-sessions/sX": { userId: "u1", jobId: "job-invoko-designer", terminal: "PASS", createdAt: "2026-05-30", cfgSnapshot: { company: "invoko.ai", jobTitle: "Product Designer" } },
  })
  const out = await call(tool(makeCtx(db), "find_my_role"), { roleFunction: ["creatives_and_design"], company: null, industrySector: null, query: null })
  assert.equal(out.kind, "one", `expected one, got ${JSON.stringify(out)}`)
  const best = out.best as Record<string, string>
  assert.equal(best.jobId, "job-invoko-designer")
  assert.equal(best.status, "passed", "session terminal PASS overrides 'matched' (proves back-fill + merge)")
})

test("find_my_role: a PENDING-review PASS session reports under_review, NOT passed (live HIGH-sev repro)", async () => {
  // Mirrors live user QswUyww2PQQdV3EoKrSh / hs-11005308-paradigm-gtm-growth: terminal=PASS but
  // terminalActionPendingReview=true (operator has NOT committed) → must NOT surface 'passed'.
  const { db } = makeFakeDb({
    "pa-users/u1": { lastCollabRoles: [{ jobId: "job-invoko-pm", company: "invoko.ai", title: "Product Manager", roleFunction: ["product_management"], industrySector: ["technology_general"] }] },
    "pa-prescreen-sessions/sPending": {
      userId: "u1",
      jobId: "job-invoko-pm",
      terminal: "PASS",
      terminalActionPendingReview: true,
      review: { status: "pending" },
      createdAt: "2026-05-31",
      cfgSnapshot: { company: "invoko.ai", jobTitle: "Product Manager" },
    },
  })
  const out = await call(tool(makeCtx(db), "find_my_role"), { roleFunction: ["product_management"], company: null, industrySector: null, query: "did I pass?" })
  assert.equal(out.kind, "one", JSON.stringify(out))
  const best = out.best as Record<string, string>
  assert.equal(best.status, "under_review", "a PASS still pending HITL review must NOT be reported as passed")
})

test("find_my_role: no canonical match → no_match (lists their roles so the agent can guide them)", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { lastCollabRoles: LAST_COLLAB } })
  const out = await call(tool(makeCtx(db), "find_my_role"), { roleFunction: ["legal_and_compliance"], company: null, industrySector: null, query: null })
  assert.equal(out.kind, "no_match")
})

// ── begin_collab_prescreen({ jobId }) — matched-gate + start ─────────────────

test("begin_collab_prescreen: a matched jobId starts the RIGHT session via the legacy seam", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { lastCollabRoles: LAST_COLLAB } })
  const calls: Array<{ jobId: string; userId: string; toE164: string }> = []
  const ctx = makeCtx(db, { toE164: "+13054507715", beginPrescreen: async (a) => { calls.push(a); return { ok: true, sessionId: `ps_${a.jobId}` } } })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "job-invoko-pm" })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.jobId, "job-invoko-pm")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.jobId, "job-invoko-pm", "started the resolved role, never another")
  assert.equal(calls[0]!.toE164, "+13054507715")
})

test("begin_collab_prescreen: a FOREIGN jobId (not in the matched set) → not_matched, NO start", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { lastCollabRoles: LAST_COLLAB } })
  let started = false
  const ctx = makeCtx(db, { toE164: "+13054507715", beginPrescreen: async () => { started = true; return { ok: true, sessionId: "ps_x" } } })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "job-foreign-harvested-from-url" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "not_matched")
  assert.equal(started, false, "a foreign jobId must NOT start a session")
})

test("begin_collab_prescreen: phone falls back to pa-users.phoneE164 when ctx.toE164 absent", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { phoneE164: "+14243201960", lastCollabRoles: LAST_COLLAB } })
  const calls: Array<{ toE164: string }> = []
  const ctx = makeCtx(db, { beginPrescreen: async (a) => { calls.push({ toE164: a.toE164 }); return { ok: true, sessionId: "ps_x" } } })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "job-invoko-pm" })
  assert.equal(out.ok, true)
  assert.equal(calls[0]!.toE164, "+14243201960")
})

test("begin_collab_prescreen: session-start not-ok → surfaced reason, ok:false", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { phoneE164: "+13054507715", lastCollabRoles: LAST_COLLAB } })
  const ctx = makeCtx(db, { beginPrescreen: async () => ({ ok: false, reason: "config_missing", sessionId: "ps_x" }) })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "job-invoko-pm" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "config_missing")
  assert.equal(out.jobId, "job-invoko-pm")
})

test("begin_collab_prescreen: no phone available → no_phone, session-start NOT invoked", async () => {
  const { db } = makeFakeDb({ "pa-users/u1": { lastCollabRoles: LAST_COLLAB } })
  let started = false
  const ctx = makeCtx(db, { beginPrescreen: async () => { started = true; return { ok: true, sessionId: "ps_x" } } })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "job-invoko-pm" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "no_phone")
  assert.equal(started, false)
})

// ── check_prescreen_progress (HITL-review-aware status) ──────────────────────

test("check_prescreen_progress: a PENDING-review PASS is reported under_review, NOT passed", async () => {
  const { db } = makeFakeDb({
    "pa-prescreen-sessions/sPend": {
      userId: "u1",
      jobId: "job-paradigm",
      terminal: "PASS",
      terminalActionPendingReview: true,
      review: { status: "pending" },
      createdAt: "2026-05-31",
      cfgSnapshot: { jobTitle: "GTM Growth", company: "paradigm.study" },
    },
  })
  const out = await call(tool(makeCtx(db), "check_prescreen_progress"), { query: null })
  assert.equal(out.ok, true)
  const sessions = out.sessions as Array<Record<string, string>>
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.status, "under_review", "pending PASS must surface under_review, never passed")
})

test("check_prescreen_progress: lists all sessions with mapped status, most-recent first", async () => {
  const { db } = makeFakeDb({
    "pa-prescreen-sessions/sA": { userId: "u1", jobId: "job-invoko-pm", terminal: "PASS", createdAt: "2026-05-20", cfgSnapshot: { jobTitle: "Product Manager", company: "Invoko" } },
    "pa-prescreen-sessions/sB": { userId: "u1", jobId: "job-helium", terminal: null, createdAt: "2026-05-25", cfgSnapshot: { jobTitle: "Backend Engineer", company: "Helium" } },
    "pa-prescreen-sessions/sOther": { userId: "u2", jobId: "job-x", terminal: "FAIL", createdAt: "2026-05-26", cfgSnapshot: { jobTitle: "X", company: "Y" } },
  })
  const out = await call(tool(makeCtx(db), "check_prescreen_progress"), { query: null })
  assert.equal(out.ok, true)
  const sessions = out.sessions as Array<Record<string, string>>
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0]!.company, "Helium")
  assert.equal(sessions[0]!.status, "in_progress")
  assert.equal(sessions[1]!.status, "passed")
})

test("check_prescreen_progress: query filters by company/title (in-memory contains)", async () => {
  const { db } = makeFakeDb({
    "pa-prescreen-sessions/sA": { userId: "u1", terminal: "PASS", createdAt: "2026-05-20", cfgSnapshot: { jobTitle: "Product Manager", company: "Invoko" } },
    "pa-prescreen-sessions/sB": { userId: "u1", terminal: "FAIL", createdAt: "2026-05-25", cfgSnapshot: { jobTitle: "Backend Engineer", company: "Helium" } },
  })
  const out = await call(tool(makeCtx(db), "check_prescreen_progress"), { query: "invoko" })
  const sessions = out.sessions as Array<Record<string, string>>
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.company, "Invoko")
  assert.equal(sessions[0]!.status, "passed")
})

test("check_prescreen_progress: fail-soft — db throws → ok:false, empty sessions, no throw", async () => {
  const throwingDb = { collection() { return { where() { return this }, limit() { return this }, async get(): Promise<never> { throw new Error("boom") } } } } as never
  const out = await call(tool(makeCtx(throwingDb), "check_prescreen_progress"), { query: null })
  assert.equal(out.ok, false)
  assert.deepEqual(out.sessions, [])
})

// ── Adam 2026-06-12: PAUSE is a routing terminal — never "in_progress", never "under_review" ─────
// Live failure (+12026571666): a boundary=timeout PAUSE was narrated as "under review". The session
// mapper now distinguishes timed_out (staleness expiry / manual-review park) from paused (stepped away).
test("prescreenStatusFromSession: timeout-expired PAUSE → timed_out (never under_review/in_progress)", () => {
  assert.equal(
    prescreenStatusFromSession({
      terminal: "PAUSE",
      terminalReason: "expired_inactive_prescreen_session",
      workSession: { kind: "job_prescreen", status: "ended", boundary: "timeout" },
    }),
    "timed_out",
  )
  // boundary alone is enough (terminalReason missing on some legacy docs).
  assert.equal(
    prescreenStatusFromSession({ terminal: "PAUSE", workSession: { boundary: "timeout" } }),
    "timed_out",
  )
  assert.equal(
    prescreenStatusFromSession({ terminal: "PAUSE", workSession: { boundary: "manual_review_required" } }),
    "timed_out",
  )
  // even a (mis)stamped pendingReview flag must NOT make a stale PAUSE read as under review.
  assert.equal(
    prescreenStatusFromSession({
      terminal: "PAUSE",
      terminalActionPendingReview: true,
      workSession: { boundary: "timeout" },
    }),
    "timed_out",
  )
})

test("prescreenStatusFromSession: user-exit PAUSE → paused", () => {
  assert.equal(
    prescreenStatusFromSession({
      terminal: "PAUSE",
      terminalReason: "user_exit",
      workSession: { kind: "job_prescreen", status: "ended", boundary: "user_exit" },
    }),
    "paused",
  )
  assert.equal(prescreenStatusFromSession({ terminal: "PAUSE" }), "paused")
})
