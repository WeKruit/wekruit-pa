/**
 * get-public-role-start.test.ts — the UNMATCHED-candidate start path (Adam 2026-06-09).
 *
 * Live failure (Avi Sardana / hs-10996795-invoko-product-manager): an employer-invited candidate
 * with 0 recs / 0 sessions / 0 pending-invite said "start the Invoko pre-screen" and pasted the
 * wekruit.com/j/<jobId> URL; Claire looped asking HIM for a 'WeKruit_…_Job' line he never had. The
 * string-paste trigger works for EVERYONE (allowMatchedBypass — token self-identity is the auth),
 * so:
 *   get_public_role_start            — resolves a publicVisible pa-jobs role from company/title
 *                                      (contains) or a candidate-pasted /j/<jobId> id, and returns
 *                                      the EXACT startText `WeKruit_<jobId>_<userId>_Job` + pageUrl
 *                                      for the agent to CONFIRM then relay. one / ambiguous / none.
 *   begin_collab_prescreen not_matched — when the candidate's matched set is EMPTY and the jobId is
 *                                      a public role, the return now carries `publicRole` so the
 *                                      model doesn't dead-end.
 *   NON-publicVisible jobs           — NEVER returned by either path.
 *
 * Pure/offline against a Firestore-faithful fake. No SDK/LLM/network — deterministic.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildMatchingTools, toPublicRoleStart } from "./matching-tools.js"
import type { ClaireToolContext } from "../types.js"

// ── fake Firestore (same shape as start-by-name-prescreen.test.ts) ───────────

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
    judgeModel: "gpt-4.1-mini", log: () => {}, nowIso: () => "2026-06-09T00:00:00.000Z",
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

// Mirrors the live pa-jobs collab inventory: publicVisible roles + one HIDDEN (non-public) role.
const PA_JOBS_SEED = {
  "pa-jobs/hs-10996795-invoko-product-manager": {
    publicVisible: true,
    title: "Product Manager",
    employerName: "Invoko",
  },
  "pa-jobs/hs-11005382-invoko-product-designer": {
    publicVisible: true,
    // title via the prescreenConfig fallback chain (no top-level title) — proves the projection.
    prescreenConfig: { jobTitle: "Product Designer", company: "invoko.ai" },
  },
  "pa-jobs/hs-11005308-paradigm-gtm-growth": {
    publicVisible: true,
    title: "GTM Growth",
    companyName: "paradigm.study",
  },
  "pa-jobs/hs-99999999-secret-stealth-role": {
    publicVisible: false, // NEVER startable via the public path
    title: "Stealth Engineer",
    companyName: "StealthCo",
  },
  "pa-jobs/hs-88888888-no-flag-role": {
    // publicVisible ABSENT — also never returned
    title: "Flagless Manager",
    companyName: "Invoko",
  },
}

// ── get_public_role_start — resolution ───────────────────────────────────────

test("get_public_role_start: company+title resolve to EXACTLY one → kind=one with startText + pageUrl", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const out = await call(tool(makeCtx(db), "get_public_role_start"), { company: "invoko", title: "product manager", jobId: null })
  assert.equal(out.ok, true)
  assert.equal(out.kind, "one", JSON.stringify(out))
  assert.equal(out.jobId, "hs-10996795-invoko-product-manager")
  assert.equal(out.title, "Product Manager")
  assert.equal(out.company, "Invoko")
  // startText format is LOCKED to the trigger the parser matches: WeKruit_<jobId>_<userId>_Job.
  assert.equal(out.startText, "WeKruit_hs-10996795-invoko-product-manager_u1_Job")
  assert.equal(out.pageUrl, "https://wekruit.com/j/hs-10996795-invoko-product-manager")
})

test("get_public_role_start: jobId from a pasted wekruit.com/j/<jobId> URL → kind=one (the live Avi repro)", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const out = await call(tool(makeCtx(db), "get_public_role_start"), { company: null, title: null, jobId: "hs-10996795-invoko-product-manager" })
  assert.equal(out.kind, "one", JSON.stringify(out))
  assert.equal(out.startText, "WeKruit_hs-10996795-invoko-product-manager_u1_Job")
})

test("get_public_role_start: startText carries the CALLING user's id (ctx.userId)", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const ctx = makeCtx(db, { userId: "RJcsA285Drcml1kTPZjI" })
  const out = await call(tool(ctx, "get_public_role_start"), { company: null, title: null, jobId: "hs-10996795-invoko-product-manager" })
  assert.equal(out.startText, "WeKruit_hs-10996795-invoko-product-manager_RJcsA285Drcml1kTPZjI_Job")
})

test("get_public_role_start: company-only 'invoko' hits BOTH invoko roles → ambiguous with candidates, NO startText", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const out = await call(tool(makeCtx(db), "get_public_role_start"), { company: "invoko", title: null, jobId: null })
  assert.equal(out.kind, "ambiguous", JSON.stringify(out))
  const candidates = out.candidates as Array<Record<string, string>>
  assert.deepEqual(
    candidates.map((c) => c.jobId).sort(),
    ["hs-10996795-invoko-product-manager", "hs-11005382-invoko-product-designer"],
  )
  for (const c of candidates) assert.equal("startText" in c, false, "ambiguous candidates must NOT carry a startText")
  assert.equal("startText" in out, false)
})

test("get_public_role_start: title resolved through the prescreenConfig fallback chain", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const out = await call(tool(makeCtx(db), "get_public_role_start"), { company: null, title: "designer", jobId: null })
  assert.equal(out.kind, "one", JSON.stringify(out))
  assert.equal(out.jobId, "hs-11005382-invoko-product-designer")
  assert.equal(out.title, "Product Designer")
  assert.equal(out.company, "invoko.ai")
})

test("get_public_role_start: no public role matches → kind=none", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const out = await call(tool(makeCtx(db), "get_public_role_start"), { company: "google", title: null, jobId: null })
  assert.equal(out.kind, "none")
  const byId = await call(tool(makeCtx(makeFakeDb(PA_JOBS_SEED).db), "get_public_role_start"), { company: null, title: null, jobId: "hs-00000000-not-a-job" })
  assert.equal(byId.kind, "none")
})

test("get_public_role_start: a NON-publicVisible job is NEVER returned — by jobId, company, or title", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  // direct jobId hit on the hidden role → none.
  const byId = await call(tool(makeCtx(db), "get_public_role_start"), { company: null, title: null, jobId: "hs-99999999-secret-stealth-role" })
  assert.equal(byId.kind, "none", "publicVisible:false must not resolve by jobId")
  // company contains hit → none.
  const byCompany = await call(tool(makeCtx(db), "get_public_role_start"), { company: "stealthco", title: null, jobId: null })
  assert.equal(byCompany.kind, "none", "publicVisible:false must not resolve by company")
  // publicVisible ABSENT (flagless invoko doc) must not leak into the invoko ambiguous set.
  const invoko = await call(tool(makeCtx(db), "get_public_role_start"), { company: "invoko", title: null, jobId: null })
  const ids = (invoko.candidates as Array<Record<string, string>>).map((c) => c.jobId)
  assert.equal(ids.includes("hs-88888888-no-flag-role"), false, "a doc without publicVisible:true must never surface")
})

test("get_public_role_start: NO signals at all → lists the public inventory as ambiguous (agent asks which)", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const out = await call(tool(makeCtx(db), "get_public_role_start"), { company: null, title: null, jobId: null })
  assert.equal(out.kind, "ambiguous")
  const ids = (out.candidates as Array<Record<string, string>>).map((c) => c.jobId).sort()
  assert.deepEqual(ids, [
    "hs-10996795-invoko-product-manager",
    "hs-11005308-paradigm-gtm-growth",
    "hs-11005382-invoko-product-designer",
  ])
})

test("get_public_role_start: fail-soft — db throws → kind=none, no throw", async () => {
  const throwingDb = { collection() { return { where() { return this }, limit() { return this }, async get(): Promise<never> { throw new Error("boom") }, doc() { return { async get(): Promise<never> { throw new Error("boom") } } } } } } as never
  const out = await call(tool(makeCtx(throwingDb), "get_public_role_start"), { company: "invoko", title: null, jobId: null })
  assert.equal(out.ok, true)
  assert.equal(out.kind, "none")
})

// ── toPublicRoleStart — the locked token/URL shapes ──────────────────────────

test("toPublicRoleStart: WeKruit_<jobId>_<userId>_Job + https://wekruit.com/j/<jobId>", () => {
  const r = toPublicRoleStart({ jobId: "hs-1-acme-pm", title: "PM", company: "Acme" }, "Abc123")
  assert.equal(r.startText, "WeKruit_hs-1-acme-pm_Abc123_Job")
  assert.equal(r.pageUrl, "https://wekruit.com/j/hs-1-acme-pm")
  assert.equal(r.title, "PM")
  assert.equal(r.company, "Acme")
})

// ── begin_collab_prescreen not_matched now carries publicRole ────────────────

test("begin_collab_prescreen: EMPTY matched set + a PUBLIC jobId → not_matched WITH publicRole, session NOT started", async () => {
  // The exact live shape: 0 lastCollabRoles, 0 sessions, candidate-supplied public jobId.
  const { db } = makeFakeDb(PA_JOBS_SEED)
  let started = false
  const ctx = makeCtx(db, { toE164: "+12038190526", beginPrescreen: async () => { started = true; return { ok: true, sessionId: "ps_x" } } })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "hs-10996795-invoko-product-manager" })
  assert.equal(out.ok, false)
  assert.equal(out.reason, "not_matched")
  assert.equal(started, false, "the conversational matched-gate must still NOT start the session")
  const publicRole = out.publicRole as Record<string, string>
  assert.ok(publicRole, "not_matched with an empty matched set must carry publicRole")
  assert.equal(publicRole.jobId, "hs-10996795-invoko-product-manager")
  assert.equal(publicRole.title, "Product Manager")
  assert.equal(publicRole.company, "Invoko")
  assert.equal(publicRole.startText, "WeKruit_hs-10996795-invoko-product-manager_u1_Job")
  assert.equal(publicRole.pageUrl, "https://wekruit.com/j/hs-10996795-invoko-product-manager")
})

test("begin_collab_prescreen: EMPTY matched set + a NON-public jobId → not_matched WITHOUT publicRole", async () => {
  const { db } = makeFakeDb(PA_JOBS_SEED)
  const ctx = makeCtx(db, { toE164: "+12038190526", beginPrescreen: async () => ({ ok: true, sessionId: "ps_x" }) })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "hs-99999999-secret-stealth-role" })
  assert.equal(out.reason, "not_matched")
  assert.equal("publicRole" in out, false, "a publicVisible:false job must never be offered as startable")
})

test("begin_collab_prescreen: NON-empty matched set + foreign jobId → not_matched, roles listed, NO publicRole (guessed-id case)", async () => {
  // When the candidate HAS matched roles, a foreign jobId means the MODEL guessed — the fix is
  // re-resolution via find_my_role against the returned roles, not a public-start escape hatch.
  const { db } = makeFakeDb({
    ...PA_JOBS_SEED,
    "pa-users/u1": { lastCollabRoles: [{ jobId: "job-helium", company: "Helium", title: "Backend Engineer", roleFunction: ["software_engineering"], industrySector: ["technology_general"] }] },
  })
  const ctx = makeCtx(db, { toE164: "+12038190526", beginPrescreen: async () => ({ ok: true, sessionId: "ps_x" }) })
  const out = await call(tool(ctx, "begin_collab_prescreen"), { jobId: "hs-10996795-invoko-product-manager" })
  assert.equal(out.reason, "not_matched")
  assert.equal((out.roles as unknown[]).length, 1)
  assert.equal("publicRole" in out, false, "publicRole is ONLY for a genuinely EMPTY matched set")
})
