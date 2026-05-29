#!/usr/bin/env node
/**
 * L3 side-effect eval for WS-proactive (outbound-initiated turns).
 *
 * The GATES are the load-bearing asserts — they are deterministic and tested
 * with an injected FAKE in-memory Firestore + a RECORDING ClaireTransport. The
 * LLM copy step is injected as a deterministic fake here (a real-model copy
 * step is optional and not what this eval is grading), so the asserts never
 * flake on model variance.
 *
 * Asserts:
 *   1. one outbound   — fresh eligible user → outboundCount === 1, transport saw
 *                       exactly one text bubble (≤2).
 *   2. idempotent     — same key again → outboundCount === 0 (no double-send).
 *   3. opt-out        — opted-out user → sent:false, reason opted_out, 0 outbound.
 *   4. dedup          — daily_job_rec where all candidate jobs already sent →
 *                       sent:false / no_fresh_jobs, 0 outbound.
 *
 * Run (tsx resolves from apps/functions/node_modules; the eval imports a .ts):
 *   source ~/.zshrc && nvm use 24 && \
 *     (cd apps/functions && node --import tsx \
 *       "$PWD/../eval/thin-claire/eval-proactive.mjs")
 *
 * The proactive gate path imports @openai/agents only LAZILY (inside the default
 * composer), and this eval injects its own deterministic composer, so NO real LLM
 * call is made and NO API key is required — the GATES are the load-bearing asserts.
 */
import { symlinkSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const nm = join(here, "node_modules")
const target = join(here, "../../../packages/agent-runtime/node_modules")
if (!existsSync(nm)) {
  try {
    symlinkSync(target, nm)
  } catch (e) {
    console.error(`could not symlink node_modules → ${target}: ${e?.message ?? e}`)
  }
}

const { runProactiveTurn } = await import(
  "../../functions/src/claire-agent/proactive.ts"
)

// ── Recording ClaireTransport — every outward action lands here (assertable seam) ──
function makeTransport() {
  const events = []
  return {
    events,
    async markRead() { events.push({ kind: "mark_read" }) },
    async typing() { events.push({ kind: "typing" }) },
    async sendStatus(t) { events.push({ kind: "status", value: t }) },
    async sendText(t) { events.push({ kind: "text", value: t }) },
    async tapback(r) { events.push({ kind: "tapback", value: r }) },
    async noReply(reason) { events.push({ kind: "no_reply", value: reason }) },
    texts() { return events.filter((e) => e.kind === "text") },
  }
}

// ── Minimal in-memory Firestore (doc + nested subcollection + transaction) ──
// Stores docs keyed by a "/"-joined path. Supports the surface proactive.ts +
// readOutreachStopControl use: collection().doc().get()/set()/delete(),
// nested collection().doc().collection().doc().get()/set(), collection-group
// .get() over a subcollection, and runTransaction(get/set).
function makeDb(initial = {}) {
  const store = new Map(Object.entries(initial)) // path -> data object

  const docRef = (path) => ({
    path,
    async get() {
      const data = store.get(path)
      return { exists: data !== undefined, id: path.split("/").pop(), data: () => data }
    },
    async set(value, opts) {
      if (opts && opts.merge && store.has(path)) {
        store.set(path, deepMerge(store.get(path), value))
      } else {
        store.set(path, structuredClone(value))
      }
    },
    async delete() {
      store.delete(path)
    },
    collection(sub) {
      return collectionRef(`${path}/${sub}`)
    },
  })

  const collectionRef = (prefix) => ({
    prefix,
    doc(id) {
      return docRef(`${prefix}/${id}`)
    },
    async get() {
      // Return every doc whose path is exactly prefix/<id> (one level deep).
      const docs = []
      for (const [path, data] of store.entries()) {
        if (!path.startsWith(`${prefix}/`)) continue
        const rest = path.slice(prefix.length + 1)
        if (rest.includes("/")) continue // deeper subcollection — skip
        docs.push({ id: rest, exists: true, data: () => data })
      }
      return { docs, empty: docs.length === 0, size: docs.length }
    },
  })

  return {
    _store: store,
    collection(name) {
      return collectionRef(name)
    },
    async runTransaction(fn) {
      // Single-threaded JS — sequential txns are sufficient for the eval.
      const tx = {
        async get(ref) {
          return ref.get()
        },
        set(ref, value, opts) {
          // synchronous within the txn body
          const data = store.get(ref.path)
          if (opts && opts.merge && data !== undefined) {
            store.set(ref.path, deepMerge(data, value))
          } else {
            store.set(ref.path, structuredClone(value))
          }
        },
      }
      return fn(tx)
    },
  }
}

function deepMerge(a, b) {
  const out = structuredClone(a ?? {})
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = structuredClone(v)
    }
  }
  return out
}

// ── Deterministic composer (no LLM) — proves the gate path end-to-end ──
const fakeComposer = async ({ kind, jobs }) => {
  if (kind === "daily_job_rec") {
    return [`got 2 fresh roles for you:\n${jobs.map((j) => j.line ?? j.id).join("\n")}`]
  }
  return ["hey! quick check-in — how'd those roles feel?"]
}

const baseDeps = (db) => ({
  db,
  transport: makeTransport(),
  nowMs: () => Date.parse("2026-05-29T17:00:00.000Z"),
  fireWindow: "20260529",
  composeCopy: fakeComposer,
  log: () => {},
})

let fails = 0
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name}\n        → ${detail}`)
    fails += 1
  }
}

// ── 1. one outbound — fresh eligible user → exactly one outbound ──
{
  const db = makeDb()
  const deps = { ...baseDeps(db), transport: makeTransport() }
  const out = await runProactiveTurn("user_fresh", "post_match_retention", deps)
  const texts = deps.transport.texts()
  check(
    "one outbound: fresh eligible user → outboundCount === 1, exactly one text bubble",
    out.sent === true && out.outboundCount === 1 && texts.length === 1 && texts.length <= 2,
    `outcome=${JSON.stringify(out)} texts=${texts.length}`
  )
}

// ── 2. idempotent — same key again → 0 outbound (no double-send) ──
{
  const db = makeDb()
  // cooldownMs:0 isolates the IDEMPOTENCY gate (otherwise the first send's
  // cooldown stamp would short-circuit the retry — also a valid no-double-send,
  // but this assert specifically pins the keyed idempotency marker).
  const t1 = makeTransport()
  const first = await runProactiveTurn("user_idem", "post_match_retention", {
    ...baseDeps(db),
    transport: t1,
    cooldownMs: 0,
  })
  // SAME db + SAME key (same userId/kind/fireWindow) — a retry.
  const t2 = makeTransport()
  const second = await runProactiveTurn("user_idem", "post_match_retention", {
    ...baseDeps(db),
    transport: t2,
    cooldownMs: 0,
  })
  check(
    "idempotent: retry with same key → first sends 1, second sends 0 (no double-send)",
    first.outboundCount === 1 &&
      second.sent === false &&
      second.reason === "duplicate" &&
      second.outboundCount === 0 &&
      t2.texts().length === 0,
    `first=${JSON.stringify(first)} second=${JSON.stringify(second)} secondTexts=${t2.texts().length} key=user_idem:post_match_retention:20260529`
  )
}

// ── 3. opt-out — opted-out user → sent:false, reason opted_out, zero outbound ──
{
  const db = makeDb({
    "pa-users/user_optout": { candidateLifecycleState: "opted_out" },
  })
  const deps = { ...baseDeps(db), transport: makeTransport() }
  const out = await runProactiveTurn("user_optout", "daily_job_rec", {
    ...deps,
    fetchCandidateJobs: async () => [{ id: "job_x", line: "Backend SWE @ Acme" }],
  })
  check(
    "opt-out: opted_out user → sent:false, reason opted_out, 0 outbound",
    out.sent === false && out.reason === "opted_out" && out.outboundCount === 0 && deps.transport.texts().length === 0,
    `outcome=${JSON.stringify(out)} texts=${deps.transport.texts().length}`
  )
}

// ── 3b. opt-out via global outreach stop control (HITL kill-switch) ──
{
  const db = makeDb({
    "pa-outreach-stop-controls/outreach_stop_global": {
      controlId: "outreach_stop_global",
      scope: "global",
      paused: true,
      reason: "ops_pause",
      actor: "operator",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  })
  const deps = { ...baseDeps(db), transport: makeTransport() }
  const out = await runProactiveTurn("user_global_pause", "follow_up", deps)
  check(
    "opt-out: global outreach stop control paused → sent:false, reason opted_out, 0 outbound",
    out.sent === false && out.reason === "opted_out" && out.outboundCount === 0,
    `outcome=${JSON.stringify(out)}`
  )
}

// ── 4. dedup — daily_job_rec, all candidate jobs already sent → no fresh ──
{
  const db = makeDb({
    // job_a + job_b already recorded as recommended → must be excluded.
    "pa-user-job-recommendations/user_dedup/jobs/job_a": {
      userId: "user_dedup",
      jobId: "job_a",
      recommendationCount: 1,
    },
    "pa-user-job-recommendations/user_dedup/jobs/job_b": {
      userId: "user_dedup",
      jobId: "job_b",
      recommendationCount: 2,
    },
  })
  const deps = { ...baseDeps(db), transport: makeTransport() }
  const out = await runProactiveTurn("user_dedup", "daily_job_rec", {
    ...deps,
    fetchCandidateJobs: async () => [
      { id: "job_a", line: "Role A @ A" },
      { id: "job_b", line: "Role B @ B" },
    ],
  })
  check(
    "dedup: daily_job_rec where all candidate jobs already sent → sent:false / no_fresh_jobs, 0 outbound",
    out.sent === false && out.reason === "no_fresh_jobs" && out.outboundCount === 0 && deps.transport.texts().length === 0,
    `outcome=${JSON.stringify(out)} texts=${deps.transport.texts().length}`
  )
}

// ── 4b. dedup positive control — one fresh job survives → exactly one outbound + recorded ──
{
  const db = makeDb({
    "pa-user-job-recommendations/user_mix/jobs/job_old": {
      userId: "user_mix",
      jobId: "job_old",
      recommendationCount: 1,
    },
  })
  const deps = { ...baseDeps(db), transport: makeTransport() }
  const out = await runProactiveTurn("user_mix", "daily_job_rec", {
    ...deps,
    fetchCandidateJobs: async () => [
      { id: "job_old", line: "Old @ X" }, // already sent → dropped
      { id: "job_new", line: "New @ Y" }, // fresh → kept
    ],
  })
  // The fresh job must now be recorded so a NEXT window dedups it.
  const recordedNew = await db
    .collection("pa-user-job-recommendations")
    .doc("user_mix")
    .collection("jobs")
    .doc("job_new")
    .get()
  check(
    "dedup positive: one fresh job → one outbound AND job_new recorded for next-window dedup",
    out.sent === true && out.outboundCount === 1 && deps.transport.texts().length === 1 && recordedNew.exists,
    `outcome=${JSON.stringify(out)} texts=${deps.transport.texts().length} recordedNew=${recordedNew.exists}`
  )
}

console.log(
  `\n${fails === 0 ? "WS-PROACTIVE L3: GREEN ✅ — one trigger = exactly one outbound, idempotent, opt-out + dedup honored" : `WS-PROACTIVE L3: RED ❌ — ${fails} FAILED`}`
)
process.exit(fails === 0 ? 0 : 1)
