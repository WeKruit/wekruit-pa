/**
 * start-by-name-prescreen.test.ts — the ADDITIVE by-name prescreen path (task #13 follow-on).
 *
 * Locks the two friendly-path primitives that sit ALONGSIDE the copy-paste WeKruit_<jobId>_<userId>_Job
 * trigger (which is untouched):
 *
 *   resolveCollabRole          — free-form role name → exactly-one jobId, with no_match / ambiguous /
 *                                exact-1 outcomes (NEVER a silent wrong-role pick on a tie). NO regex.
 *   prescreenStatusFromTerminal — PASS→passed, FAIL→not_passed, null→in_progress.
 *   check_prescreen_progress    — userId-only query + in-memory company/title filter + status mapping.
 *
 * Pure/offline: the resolver + status map are pure; the progress tool is driven against a tiny
 * Firestore-faithful fake (mirrors process-tools.test.ts / prescreen-context.test.ts fake-db style).
 * No SDK/LLM/network — deterministic.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  resolveCollabRole,
  prescreenStatusFromTerminal,
  buildMatchingTools,
  type CollabRole,
} from "./matching-tools.js"
import type { ClaireToolContext } from "../types.js"

// ── resolveCollabRole — no_match / ambiguous / exact-1 ───────────────────────

const ROLES: CollabRole[] = [
  { jobId: "job-helium", company: "Helium", title: "Backend Engineer" },
  { jobId: "job-invoko", company: "Invoko", title: "Product Manager" },
  { jobId: "job-rain", company: "Rain", title: "Technical Account Manager" },
]

test("resolveCollabRole: company name → exact-1 match", () => {
  const r = resolveCollabRole("let's do the Helium one", ROLES)
  assert.equal(r.kind, "match")
  assert.equal(r.kind === "match" && r.role.jobId, "job-helium")
})

test("resolveCollabRole: company + role abbreviation ('invoko PM') → exact-1 match", () => {
  const r = resolveCollabRole("start the invoko PM screen", ROLES)
  assert.equal(r.kind, "match")
  assert.equal(r.kind === "match" && r.role.jobId, "job-invoko")
})

test("resolveCollabRole: title words → exact-1 match", () => {
  const r = resolveCollabRole("the technical account manager role", ROLES)
  assert.equal(r.kind, "match")
  assert.equal(r.kind === "match" && r.role.jobId, "job-rain")
})

test("resolveCollabRole: no signal → no_match", () => {
  const r = resolveCollabRole("the marketing gig at Google", ROLES)
  assert.equal(r.kind, "no_match")
})

test("resolveCollabRole: empty query / empty roles → no_match", () => {
  assert.equal(resolveCollabRole("", ROLES).kind, "no_match")
  assert.equal(resolveCollabRole("Helium", []).kind, "no_match")
})

test("resolveCollabRole: a tie at the top is AMBIGUOUS — never a silent wrong pick", () => {
  const dupes: CollabRole[] = [
    { jobId: "job-a", company: "Acme", title: "Software Engineer" },
    { jobId: "job-b", company: "Acme", title: "Software Engineer" },
  ]
  const r = resolveCollabRole("the Acme software engineer one", dupes)
  assert.equal(r.kind, "ambiguous")
  assert.equal(r.kind === "ambiguous" && r.candidates.length, 2)
})

test("resolveCollabRole: shared token does NOT defeat a stronger company-substring match", () => {
  // Both have "engineer", but only one is the Helium company the query names → Helium wins outright.
  const r = resolveCollabRole("helium engineer", ROLES)
  assert.equal(r.kind, "match")
  assert.equal(r.kind === "match" && r.role.jobId, "job-helium")
})

// ── prescreenStatusFromTerminal — PASS / FAIL / null mapping ─────────────────

test("prescreenStatusFromTerminal maps PASS→passed, FAIL→not_passed, null/other→in_progress", () => {
  assert.equal(prescreenStatusFromTerminal("PASS"), "passed")
  assert.equal(prescreenStatusFromTerminal("pass"), "passed")
  assert.equal(prescreenStatusFromTerminal("FAIL"), "not_passed")
  assert.equal(prescreenStatusFromTerminal(null), "in_progress")
  assert.equal(prescreenStatusFromTerminal(undefined), "in_progress")
  assert.equal(prescreenStatusFromTerminal("PAUSE"), "in_progress")
})

// ── check_prescreen_progress — query + filter + status (fake db) ─────────────

function makeFakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed))
  const matchDocs = (col: string, predicates: Array<[string, unknown]>) => {
    const docs: Array<{ id: string; data: () => Record<string, unknown> }> = []
    for (const [key, val] of store.entries()) {
      if (!key.startsWith(`${col}/`)) continue
      const data = val
      if (predicates.every(([f, v]) => data[f] === v)) {
        docs.push({ id: key.slice(col.length + 1), data: () => data })
      }
    }
    return docs
  }
  const collection = (col: string) => {
    const predicates: Array<[string, unknown]> = []
    const q: Record<string, unknown> = {
      where(f: string, _op: string, v: unknown) {
        predicates.push([f, v])
        return q
      },
      limit() {
        return q
      },
      async get() {
        const docs = matchDocs(col, predicates)
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
    return {
      doc: (id: string) => ({
        async get() {
          const key = `${col}/${id}`
          return { exists: store.has(key), id, data: () => store.get(key) }
        },
        async set(data: Record<string, unknown>) {
          store.set(`${col}/${id}`, { ...(store.get(`${col}/${id}`) ?? {}), ...data })
        },
      }),
      ...q,
    }
  }
  return { db: { collection } as never, store }
}

function makeCtx(db: never, overrides: Partial<ClaireToolContext> = {}): ClaireToolContext {
  return {
    db,
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
    nowIso: () => "2026-05-31T00:00:00.000Z",
    ...overrides,
  } as ClaireToolContext
}

/** Pull a tool out of buildMatchingTools by name (the array order is an internal detail). */
function tool(ctx: ClaireToolContext, name: string) {
  const t = buildMatchingTools(ctx).find((x) => (x as { name?: string }).name === name)
  assert.ok(t, `tool ${name} must be registered`)
  return t as { invoke: (a: never, raw: string) => Promise<unknown> }
}

async function call(t: { invoke: (a: never, raw: string) => Promise<unknown> }, args: unknown) {
  const raw = await t.invoke({} as never, JSON.stringify(args))
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

test("check_prescreen_progress: lists all sessions with mapped status, most-recent first", async () => {
  const { db } = makeFakeDb({
    "pa-prescreen-sessions/sA": {
      userId: "u1",
      jobId: "job-invoko",
      terminal: "PASS",
      createdAt: "2026-05-20",
      cfgSnapshot: { jobTitle: "Product Manager", company: "Invoko" },
    },
    "pa-prescreen-sessions/sB": {
      userId: "u1",
      jobId: "job-rain",
      terminal: null,
      createdAt: "2026-05-25",
      cfgSnapshot: { jobTitle: "Technical Account Manager", company: "Rain" },
    },
    "pa-prescreen-sessions/sOther": {
      userId: "u2", // different candidate — must be excluded
      jobId: "job-x",
      terminal: "FAIL",
      createdAt: "2026-05-26",
      cfgSnapshot: { jobTitle: "X", company: "Y" },
    },
  })
  const out = await call(tool(makeCtx(db), "check_prescreen_progress"), { query: null })
  assert.equal(out.ok, true)
  const sessions = out.sessions as Array<Record<string, string>>
  assert.equal(sessions.length, 2, "only u1's sessions")
  assert.equal(sessions[0]!.company, "Rain", "most-recent (2026-05-25) first")
  assert.equal(sessions[0]!.status, "in_progress")
  assert.equal(sessions[1]!.company, "Invoko")
  assert.equal(sessions[1]!.status, "passed")
})

test("check_prescreen_progress: query filters by company/title (in-memory contains)", async () => {
  const { db } = makeFakeDb({
    "pa-prescreen-sessions/sA": {
      userId: "u1",
      terminal: "PASS",
      createdAt: "2026-05-20",
      cfgSnapshot: { jobTitle: "Product Manager", company: "Invoko" },
    },
    "pa-prescreen-sessions/sB": {
      userId: "u1",
      terminal: "FAIL",
      createdAt: "2026-05-25",
      cfgSnapshot: { jobTitle: "Technical Account Manager", company: "Rain" },
    },
  })
  const out = await call(tool(makeCtx(db), "check_prescreen_progress"), { query: "invoko" })
  const sessions = out.sessions as Array<Record<string, string>>
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.company, "Invoko")
  assert.equal(sessions[0]!.status, "passed")
})

test("check_prescreen_progress: fail-soft — db throws → ok:false, empty sessions, no throw", async () => {
  const throwingDb = {
    collection() {
      return {
        where() {
          return this
        },
        limit() {
          return this
        },
        async get(): Promise<never> {
          throw new Error("boom")
        },
      }
    },
  } as never
  const out = await call(tool(makeCtx(throwingDb), "check_prescreen_progress"), { query: null })
  assert.equal(out.ok, false)
  assert.deepEqual(out.sessions, [])
})

// ── begin_collab_prescreen — resolve + start via the SAME legacy session-start ──

test("begin_collab_prescreen: no_match returns the roles for re-offer (no session started)", async () => {
  const { db, store } = makeFakeDb({
    "pa-users/u1": {
      phoneE164: "+13054507715",
      lastCollabRoles: [{ jobId: "job-helium", company: "Helium", title: "Backend Engineer" }],
    },
  })
  const out = await call(tool(makeCtx(db), "begin_collab_prescreen"), { roleQuery: "the marketing gig" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "no_match")
  assert.equal((out.roles as unknown[]).length, 1)
  // no session doc created
  const created = [...store.keys()].some((k) => k.startsWith("pa-prescreen-sessions/"))
  assert.equal(created, false, "no_match must NOT start any prescreen session")
})

test("begin_collab_prescreen: ambiguous returns candidates (no wrong-role start)", async () => {
  const { db } = makeFakeDb({
    "pa-users/u1": {
      phoneE164: "+13054507715",
      lastCollabRoles: [
        { jobId: "job-a", company: "Acme", title: "Software Engineer" },
        { jobId: "job-b", company: "Acme", title: "Software Engineer" },
      ],
    },
  })
  const out = await call(tool(makeCtx(db), "begin_collab_prescreen"), {
    roleQuery: "the acme software engineer one",
  })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "ambiguous")
  assert.equal((out.candidates as unknown[]).length, 2)
})

test("begin_collab_prescreen: exact-1 starts the session via the legacy session-start seam (right role)", async () => {
  const { db } = makeFakeDb({
    "pa-users/u1": {
      lastCollabRoles: [
        { jobId: "job-invoko", company: "Invoko", title: "Product Manager" },
        { jobId: "job-helium", company: "Helium", title: "Backend Engineer" },
      ],
    },
  })
  // beginPrescreen is the eval seam for the REAL runPreScreenForUser — we assert it is called with
  // EXACTLY the resolved role (never the other one) and the threaded phone, then returns ok.
  const calls: Array<{ jobId: string; userId: string; toE164: string }> = []
  const ctx = makeCtx(db, {
    toE164: "+13054507715",
    beginPrescreen: async (a) => {
      calls.push(a)
      return { ok: true, sessionId: `ps_${a.jobId}_${a.userId}_x` }
    },
  })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { roleQuery: "start the invoko PM screen" })
  assert.equal(out.ok, true, `expected ok:true, got ${JSON.stringify(out)}`)
  assert.equal(out.jobId, "job-invoko")
  assert.equal(out.company, "Invoko")
  assert.equal(calls.length, 1, "session-start invoked exactly once")
  assert.equal(calls[0]!.jobId, "job-invoko", "started the NAMED role, never the other collab role")
  assert.equal(calls[0]!.userId, "u1")
  assert.equal(calls[0]!.toE164, "+13054507715", "phone threaded from ctx.toE164")
})

test("begin_collab_prescreen: phone falls back to pa-users.phoneE164 when ctx.toE164 absent", async () => {
  const { db } = makeFakeDb({
    "pa-users/u1": {
      phoneE164: "+14243201960",
      lastCollabRoles: [{ jobId: "job-invoko", company: "Invoko", title: "Product Manager" }],
    },
  })
  const calls: Array<{ toE164: string }> = []
  const ctx = makeCtx(db, {
    beginPrescreen: async (a) => {
      calls.push({ toE164: a.toE164 })
      return { ok: true, sessionId: "ps_x" }
    },
  })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { roleQuery: "the invoko one" })
  assert.equal(out.ok, true)
  assert.equal(calls[0]!.toE164, "+14243201960", "phone read from pa-users.phoneE164 when ctx has none")
})

test("begin_collab_prescreen: session-start returns not-ok → surfaced reason, ok:false", async () => {
  const { db } = makeFakeDb({
    "pa-users/u1": {
      phoneE164: "+13054507715",
      lastCollabRoles: [{ jobId: "job-invoko", company: "Invoko", title: "Product Manager" }],
    },
  })
  const ctx = makeCtx(db, {
    beginPrescreen: async () => ({ ok: false, reason: "config_missing", sessionId: "ps_x" }),
  })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { roleQuery: "the invoko one" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "config_missing")
  assert.equal(out.jobId, "job-invoko")
})

test("begin_collab_prescreen: no phone available → no_phone, session-start NOT invoked", async () => {
  const { db } = makeFakeDb({
    "pa-users/u1": {
      lastCollabRoles: [{ jobId: "job-invoko", company: "Invoko", title: "Product Manager" }],
    },
  })
  let started = false
  const ctx = makeCtx(db, {
    beginPrescreen: async () => {
      started = true
      return { ok: true, sessionId: "ps_x" }
    },
  })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { roleQuery: "the invoko one" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "no_phone")
  assert.equal(started, false, "must NOT start a session with no phone")
})
