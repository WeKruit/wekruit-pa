/**
 * Stream H3 — second-CV overwrite UX (flag-gated tapback prompt).
 *
 * 6 unit tests cover:
 *   1. flag OFF + 1 existing resume → ingestCv writes new row directly
 *   2. flag ON + 0 existing → ingestCv writes new row directly (1st-time user)
 *   3. flag ON + 1 existing → no parsedCandidateResumes write, pa-cv-pending +
 *      pa-outbound out-cv-overwrite-* enqueued
 *   4. tapback love → archives previous, promotes new
 *   5. tapback question → keeps both (additionalCv: true on new), confirmation sent
 *   6. TTL fallback → expired pending auto-promotes (replace, silent)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  ingestCv,
  type IngestCvDeps,
  type StructuredCv,
  CV_OVERWRITE_OUTBOUND_PREFIX,
  CV_PENDING_COLLECTION,
} from "../cv-ingest.js"
import {
  processCvOverwriteTapback,
  runPendingCvTtlSweep,
} from "../../job-rec/cv-overwrite-tapback.js"

// ---------- Fake Firestore (fuller than chaos.test.ts) -----------------------
//
// Adds: query support (where/orderBy/limit/get), top-level doc writes via
// .doc(id).set/.delete (needed for parsedCandidateResumes promote +
// archive), and pa-cv-pending docs.

type DocData = Record<string, unknown>
type Where = { field: string; op: string; value: unknown }

type FakeState = {
  /** parsedCandidateResumes (keyed by docId) */
  resumes: Map<string, DocData>
  /** ordered insertion timeline; used to compute "most recent" */
  resumesOrder: string[]
  /** pa-outbound (.doc(id).create()) */
  outbound: Map<string, DocData>
  /** pa-users */
  users: Map<string, DocData>
  /** pa-sessions */
  sessions: Map<string, DocData>
  /** pa-inbound-events runtime handoffs */
  inboundEvents: Map<string, DocData>
  /** pa-cv-pending (.doc(id).create()/.delete()/.get()) */
  pending: Map<string, DocData>
  /** flag values for defaultIsFlagEnabled stub. */
  flags: Map<string, boolean>
}

function sessionDocId(userId: string, phoneE164: string): string {
  const h = createHash("sha256").update(`${userId}|imessage|${phoneE164}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

function makeFakeDb(opts?: {
  users?: Record<string, DocData>
  resumes?: Array<{ id: string; data: DocData }>
  pending?: Array<{ id: string; data: DocData }>
  flags?: Record<string, boolean>
}) {
  const state: FakeState = {
    resumes: new Map(),
    resumesOrder: [],
    outbound: new Map(),
    users: new Map(Object.entries(opts?.users ?? {})),
    sessions: new Map(),
    inboundEvents: new Map(),
    pending: new Map(),
    flags: new Map(Object.entries(opts?.flags ?? {})),
  }
  for (const [userId, user] of state.users) {
    const phone = typeof user.phoneE164 === "string" ? user.phoneE164 : ""
    if (phone) {
      state.sessions.set(sessionDocId(userId, phone), {
        id: sessionDocId(userId, phone),
        userId,
        channel: "imessage",
        externalChatId: phone,
      })
    }
  }
  for (const r of opts?.resumes ?? []) {
    state.resumes.set(r.id, { ...r.data })
    state.resumesOrder.push(r.id)
  }
  for (const p of opts?.pending ?? []) {
    state.pending.set(p.id, { ...p.data })
  }

  let nextResumeId = 1
  let nextOutboundId = 1
  function autoResumeId(): string {
    return `rsm_auto_${nextResumeId++}`
  }
  function autoOutboundId(): string {
    return `auto_outbound_${nextOutboundId++}`
  }

  function makeQuery(name: string, wheres: Where[] = []) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeQuery(name, [...wheres, { field, op, value }])
      },
      orderBy(_field: string, _dir?: string) {
        return makeQuery(name, wheres)
      },
      limit(_n: number) {
        return makeQuery(name, wheres)
      },
      async get() {
        let pool: Array<{ id: string; data: DocData }> = []
        if (name === "parsedCandidateResumes") {
          // Honor insertion order (latest first).
          pool = [...state.resumesOrder]
            .reverse()
            .map((id) => ({ id, data: state.resumes.get(id)! }))
        } else if (name === "pa-outbound") {
          pool = [...state.outbound.entries()].map(([id, data]) => ({ id, data }))
        } else if (name === CV_PENDING_COLLECTION) {
          pool = [...state.pending.entries()].map(([id, data]) => ({ id, data }))
        } else if (name === "pa-inbound-events") {
          pool = [...state.inboundEvents.entries()].map(([id, data]) => ({ id, data }))
        }
        const filtered = pool.filter((row) =>
          wheres.every((w) => {
            const val = row.data[w.field]
            if (w.op === "==") return val === w.value
            if (w.op === ">=") {
              if (typeof val !== "string" || typeof w.value !== "string") return false
              return val >= w.value
            }
            if (w.op === "<=") {
              if (typeof val !== "string" || typeof w.value !== "string") return false
              return val <= w.value
            }
            return true
          })
        )
        return {
          docs: filtered.map((r) => ({
            id: r.id,
            data: () => r.data,
          })),
        }
      },
    }
  }

  function makeColl(name: string) {
    const q = makeQuery(name)
    return {
      // query proxy
      where: q.where,
      orderBy: q.orderBy,
      limit: q.limit,
      async get() {
        return q.get()
      },
      async add(data: DocData) {
        if (name === "parsedCandidateResumes") {
          const id = autoResumeId()
          state.resumes.set(id, { ...data })
          state.resumesOrder.push(id)
          return { id }
        }
        if (name === "pa-outbound") {
          const id = autoOutboundId()
          state.outbound.set(id, { ...data })
          return { id }
        }
        throw new Error(`fake-db: .add() not supported for ${name}`)
      },
      doc(id?: string) {
        const realId = id ?? `${name}_auto_${Math.random().toString(36).slice(2, 8)}`
        return {
          id: realId,
          async get() {
            if (name === "pa-users") {
              const data = state.users.get(realId)
              return { exists: !!data, data: () => data }
            }
            if (name === "parsedCandidateResumes") {
              const data = state.resumes.get(realId)
              return { exists: !!data, data: () => data }
            }
            if (name === CV_PENDING_COLLECTION) {
              const data = state.pending.get(realId)
              return { exists: !!data, data: () => data }
            }
            if (name === "pa-outbound") {
              const data = state.outbound.get(realId)
              return { exists: !!data, data: () => data }
            }
            if (name === "pa-sessions") {
              const data = state.sessions.get(realId)
              return { exists: !!data, data: () => data }
            }
            if (name === "pa-inbound-events") {
              const data = state.inboundEvents.get(realId)
              return { exists: !!data, data: () => data }
            }
            return { exists: false, data: () => undefined }
          },
          async create(data: DocData) {
            if (name === "pa-outbound") {
              if (state.outbound.has(realId)) {
                throw new Error(
                  `6 ALREADY_EXISTS: Document already exists: pa-outbound/${realId}`
                )
              }
              state.outbound.set(realId, { ...data })
              return
            }
            if (name === CV_PENDING_COLLECTION) {
              if (state.pending.has(realId)) {
                throw new Error(
                  `6 ALREADY_EXISTS: Document already exists: ${name}/${realId}`
                )
              }
              state.pending.set(realId, { ...data })
              return
            }
            throw new Error(`fake-db: .create() not supported for ${name}`)
          },
          async set(data: DocData, opts?: { merge?: boolean }) {
            if (name === "parsedCandidateResumes") {
              const cur = state.resumes.get(realId) ?? {}
              const next = opts?.merge ? { ...cur, ...data } : { ...data }
              state.resumes.set(realId, next)
              if (!state.resumesOrder.includes(realId)) state.resumesOrder.push(realId)
              return
            }
            if (name === CV_PENDING_COLLECTION) {
              const cur = state.pending.get(realId) ?? {}
              state.pending.set(realId, opts?.merge ? { ...cur, ...data } : { ...data })
              return
            }
            if (name === "pa-inbound-events") {
              const cur = state.inboundEvents.get(realId) ?? {}
              state.inboundEvents.set(realId, opts?.merge ? { ...cur, ...data } : { ...data })
              return
            }
            if (name === "pa-sessions") {
              const cur = state.sessions.get(realId) ?? {}
              state.sessions.set(realId, opts?.merge ? { ...cur, ...data } : { ...data })
              return
            }
            throw new Error(`fake-db: .set() not supported for ${name}`)
          },
          async delete() {
            if (name === CV_PENDING_COLLECTION) {
              state.pending.delete(realId)
              return
            }
            if (name === "parsedCandidateResumes") {
              state.resumes.delete(realId)
              return
            }
            throw new Error(`fake-db: .delete() not supported for ${name}`)
          },
        }
      },
    }
  }

  const db = {
    collection(name: string) {
      return makeColl(name)
    },
  } as unknown as IngestCvDeps["db"]
  return { db, state }
}

function happyParsed(): StructuredCv {
  return {
    candidateProfile: {
      name: "Adam H3",
      email: null,
      phone: null,
      linkedIn: null,
      location: "SF",
      skills: ["overwrite-test"],
    },
    experiences: [
      {
        company: "Test Co",
        title: "Engineer",
        startDate: "2024",
        endDate: null,
        location: "SF",
        description: "test",
      },
    ],
    education: [],
    industryTags: ["tech_software"],
  }
}

function captureLog() {
  const events: Array<{ event: string; payload: Record<string, unknown> | undefined }> = []
  const log = (event: string, payload?: Record<string, unknown>) =>
    events.push({ event, payload })
  return { events, log }
}

function makeBaseDeps(args: {
  db: IngestCvDeps["db"]
  log: IngestCvDeps["log"]
  flagOn: boolean
  prior?: { id: string; data: Record<string, unknown> } | null
}): IngestCvDeps {
  return {
    db: args.db,
    log: args.log,
    nowIso: () => "2026-05-01T12:00:00.000Z",
    followupDeliveryMode: "direct",
    skipLimitEnforcement: true,
    fetchPdf: async () => ({ bytes: new Uint8Array([1]), contentType: "application/pdf" }),
    parsePdf: async () => ({ text: "resume", numPages: 1 }),
    llmExtract: async () => ({ parsed: happyParsed() }),
    llmFollowup: async () => "follow-up text",
    enqueueOutboundFollowup: async (db, docId, payload) => {
      // Use the fake db's pa-outbound .create() so we exercise the ALREADY_EXISTS path.
      await (
        db as unknown as {
          collection(n: string): { doc(i: string): { create(d: DocData): Promise<void> } }
        }
      )
        .collection("pa-outbound")
        .doc(docId)
        .create(payload)
    },
    mem0Add: async () => {},
    lookupUserForFollowup: async () => ({
      toE164: "+14243201960",
      mem0UserId: null,
    }),
    isFlagEnabled: async () => args.flagOn,
    findExistingResume: async () => args.prior ?? null,
    enqueueCvOverwritePending: async (db, newResumeId, payload) => {
      await (
        db as unknown as {
          collection(n: string): { doc(i: string): { create(d: DocData): Promise<void> } }
        }
      )
        .collection(CV_PENDING_COLLECTION)
        .doc(newResumeId)
        .create(payload)
    },
  }
}

// ---------- Tests ------------------------------------------------------------

describe("Stream H3 — cv-overwrite UX", () => {
  it("test 1: flag OFF + 1 existing resume → writes new parsedCandidateResumes directly (backward compat)", async () => {
    const { db, state } = makeFakeDb({
      users: { u1: { phoneE164: "+14243201960" } },
      resumes: [
        {
          id: "rsm_existing_1",
          data: {
            userId: "u1",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            ingestedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      ],
    })
    const { log, events } = captureLog()
    const deps = makeBaseDeps({
      db,
      log,
      flagOn: false,
      prior: { id: "rsm_existing_1", data: state.resumes.get("rsm_existing_1")! },
    })
    const res = await ingestCv(
      { userId: "u1", mediaUrl: "https://example.com/cv2.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    // 2 rows: the pre-seeded existing + the newly-added.
    assert.equal(state.resumes.size, 2, "new resume row written directly when flag OFF")
    assert.equal(state.pending.size, 0, "pending must NOT be populated when flag OFF")
    // No overwrite prompt outbound enqueued.
    const overwriteOutbound = [...state.outbound.keys()].filter((k) =>
      k.startsWith(CV_OVERWRITE_OUTBOUND_PREFIX)
    )
    assert.equal(overwriteOutbound.length, 0, "no overwrite prompt when flag OFF")
    // Sanity: no error events.
    assert.ok(!events.some((e) => e.event === "pa.cv_overwrite.error"))
  })

  it("test 2: flag ON + 0 existing → writes new parsedCandidateResumes directly (first-time user)", async () => {
    const { db, state } = makeFakeDb({
      users: { u2: { phoneE164: "+14243201960" } },
    })
    const { log } = captureLog()
    const deps = makeBaseDeps({ db, log, flagOn: true, prior: null })
    const res = await ingestCv(
      { userId: "u2", mediaUrl: "https://example.com/cv1.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    assert.equal(state.resumes.size, 1, "first-time user writes parsedCandidateResumes directly")
    assert.equal(state.pending.size, 0, "no pending row for first-time user")
    const overwriteOutbound = [...state.outbound.keys()].filter((k) =>
      k.startsWith(CV_OVERWRITE_OUTBOUND_PREFIX)
    )
    assert.equal(overwriteOutbound.length, 0, "no overwrite prompt for first-time user")
  })

  it("test 3: flag ON + 1 existing → stages in pa-cv-pending + enqueues out-cv-overwrite (no parsedCandidateResumes write)", async () => {
    const { db, state } = makeFakeDb({
      users: { u3: { phoneE164: "+14243201960" } },
      resumes: [
        {
          id: "rsm_prior_3",
          data: {
            userId: "u3",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            ingestedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      ],
    })
    const { log, events } = captureLog()
    const deps = makeBaseDeps({
      db,
      log,
      flagOn: true,
      prior: { id: "rsm_prior_3", data: state.resumes.get("rsm_prior_3")! },
    })
    const res = await ingestCv(
      { userId: "u3", mediaUrl: "https://example.com/cv2.pdf" },
      deps
    )
    assert.equal(res.ok, true)
    // CRITICAL: parsedCandidateResumes MUST still be 1 (only the pre-existing).
    assert.equal(
      state.resumes.size,
      1,
      "no new parsedCandidateResumes row when flag ON + prior exists"
    )
    // Pending row written.
    assert.equal(state.pending.size, 1, "exactly 1 pa-cv-pending row")
    const [pendingId, pendingDoc] = [...state.pending.entries()][0]!
    assert.equal(pendingDoc.userId, "u3")
    assert.equal(pendingDoc.previousResumeId, "rsm_prior_3")
    assert.equal(typeof pendingDoc.expireAt, "string")
    assert.ok(pendingDoc.parsedDoc, "pending row carries parsedDoc")
    // Outbound prompt enqueued with deterministic docId.
    const overwriteKeys = [...state.outbound.keys()].filter((k) =>
      k.startsWith(CV_OVERWRITE_OUTBOUND_PREFIX)
    )
    assert.equal(overwriteKeys.length, 1, "exactly 1 out-cv-overwrite-* outbound enqueued")
    assert.equal(
      overwriteKeys[0],
      `${CV_OVERWRITE_OUTBOUND_PREFIX}${pendingId}`,
      "outbound docId encodes the staged newResumeId"
    )
    const outboundDoc = state.outbound.get(overwriteKeys[0]!)!
    assert.equal(outboundDoc.toE164, "+14243201960")
    assert.match(String(outboundDoc.body), /替代/, "body asks about overwrite")
    // Result resumeId reflects the staged id (so logs are traceable).
    assert.ok(res.ok && res.resumeId === pendingId)
    // Log emitted.
    assert.ok(
      events.some((e) => e.event === "pa.cv_overwrite.prompt_enqueued"),
      "prompt_enqueued logged"
    )
  })

  it("test 3b: profile-only delivery bypasses overwrite prompt and writes parsed resume", async () => {
    const { db, state } = makeFakeDb({
      users: { u3b: { phoneE164: "+14243201960" } },
      resumes: [
        {
          id: "rsm_prior_3b",
          data: {
            userId: "u3b",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            ingestedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      ],
    })
    const { log } = captureLog()
    const deps = makeBaseDeps({
      db,
      log,
      flagOn: true,
      prior: { id: "rsm_prior_3b", data: state.resumes.get("rsm_prior_3b")! },
    })
    deps.followupDeliveryMode = "none"

    const res = await ingestCv(
      { userId: "u3b", mediaUrl: "inline://public-profile-upload.pdf" },
      deps
    )

    assert.equal(res.ok, true)
    assert.equal(state.resumes.size, 2, "profile-only uploads write a real parsedCandidateResumes row")
    assert.equal(state.pending.size, 0, "profile-only uploads must not stage a pending overwrite")
    const overwriteKeys = [...state.outbound.keys()].filter((k) =>
      k.startsWith(CV_OVERWRITE_OUTBOUND_PREFIX)
    )
    assert.equal(overwriteKeys.length, 0, "profile-only uploads must not direct-send overwrite prompts")
  })

  it("test 4: tapback love (replace) → archives previous + promotes new + sends confirmation", async () => {
    // Seed: 1 existing resume + 1 pending row + 1 outbound prompt.
    const newResumeId = "rsm_pending_4"
    const prevResumeId = "rsm_prior_4"
    const promptDocId = `${CV_OVERWRITE_OUTBOUND_PREFIX}${newResumeId}`
    const promptBody =
      "欸看到你又发了份新简历 — 替代之前那份吗？回复 ❤️ = 替代旧的，🤔 = 当作另一个版本参考 (24 小时后默认替代)"
    const { db, state } = makeFakeDb({
      users: { u4: { phoneE164: "+14243201960" } },
      resumes: [
        {
          id: prevResumeId,
          data: {
            userId: "u4",
            candidateProfile: { name: "old" },
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            ingestedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      ],
      pending: [
        {
          id: newResumeId,
          data: {
            newResumeId,
            previousResumeId: prevResumeId,
            userId: "u4",
            expireAt: "2026-05-02T12:00:00.000Z",
            createdAt: "2026-05-01T12:00:00.000Z",
            parsedDoc: {
              userId: "u4",
              candidateProfile: { name: "new" },
              experiences: [],
              education: [],
              industryTags: ["tech_software"],
            },
            status: "awaiting_user",
          },
        },
      ],
    })
    // Pre-seed the outbound prompt the user reacted to (peerE164 must
    // match their phone).
    state.outbound.set(promptDocId, {
      id: promptDocId,
      userId: "u4",
      toE164: "+14243201960",
      body: promptBody,
      status: "pending",
      createdAt: "2026-05-01T12:00:00.000Z",
      rawMeta: {
        cvOverwrite: { newResumeId, previousResumeId: prevResumeId },
      },
    })

    const { log, events } = captureLog()
    const result = await processCvOverwriteTapback(
      db as never,
      {
        userId: "u4",
        fromNumber: "+14243201960",
        kind: "love",
        // Use a substring of the prompt so quotedText match fires.
        quotedText: "替代之前那份吗？",
      },
      { nowIso: () => "2026-05-01T13:00:00.000Z", nowMs: () => 1746104400000, log }
    )
    assert.equal(result.handled, true)
    assert.equal(result.handled && result.action, "replace")
    // Previous row archived (merge).
    const prev = state.resumes.get(prevResumeId)!
    assert.equal(prev.archived, true)
    assert.equal(prev.replacedBy, newResumeId)
    assert.equal(typeof prev.archivedAt, "string")
    // New row promoted.
    assert.ok(state.resumes.has(newResumeId), "new resume promoted")
    const newRow = state.resumes.get(newResumeId)!
    assert.deepEqual(newRow.candidateProfile, { name: "new" })
    assert.notEqual(newRow.additionalCv, true, "replace path must NOT mark additionalCv")
    // Pending row deleted.
    assert.equal(state.pending.size, 0, "pending row deleted after promote")
    // Confirmation context handed to runtime, not direct pa-outbound.
    const confirmDoc = [...state.inboundEvents.values()].find((row) => {
      const meta = row.rawMeta as Record<string, unknown> | undefined
      return meta?.runtimeEventSource === "cv_overwrite"
    })
    assert.ok(confirmDoc, "confirmation runtime event enqueued")
    const context = (confirmDoc!.rawMeta as Record<string, unknown>).context as Record<string, unknown>
    assert.match(String(context.proposedMessage), /替代/, "confirmation says replaced")
    assert.ok(events.some((e) => e.event === "pa.cv_overwrite.promoted"))
  })

  it("test 5: tapback question (supplement) → keeps both rows, marks new with additionalCv:true", async () => {
    const newResumeId = "rsm_pending_5"
    const prevResumeId = "rsm_prior_5"
    const promptDocId = `${CV_OVERWRITE_OUTBOUND_PREFIX}${newResumeId}`
    const promptBody =
      "欸看到你又发了份新简历 — 替代之前那份吗？回复 ❤️ = 替代旧的，🤔 = 当作另一个版本参考 (24 小时后默认替代)"
    const { db, state } = makeFakeDb({
      users: { u5: { phoneE164: "+14243201960" } },
      resumes: [
        {
          id: prevResumeId,
          data: {
            userId: "u5",
            candidateProfile: { name: "old" },
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          },
        },
      ],
      pending: [
        {
          id: newResumeId,
          data: {
            newResumeId,
            previousResumeId: prevResumeId,
            userId: "u5",
            expireAt: "2026-05-02T12:00:00.000Z",
            parsedDoc: {
              userId: "u5",
              candidateProfile: { name: "new-supplement" },
            },
          },
        },
      ],
    })
    state.outbound.set(promptDocId, {
      id: promptDocId,
      toE164: "+14243201960",
      body: promptBody,
      createdAt: "2026-05-01T12:00:00.000Z",
      rawMeta: {
        cvOverwrite: { newResumeId, previousResumeId: prevResumeId },
      },
    })

    const { log } = captureLog()
    const result = await processCvOverwriteTapback(
      db as never,
      {
        userId: "u5",
        fromNumber: "+14243201960",
        kind: "question",
        quotedText: "替代之前那份吗？",
      },
      { nowIso: () => "2026-05-01T13:00:00.000Z", nowMs: () => 1746104400000, log }
    )
    assert.equal(result.handled, true)
    assert.equal(result.handled && result.action, "supplement")
    // Both rows live; previous NOT archived.
    const prev = state.resumes.get(prevResumeId)!
    assert.notEqual(prev.archived, true, "supplement path must NOT archive previous")
    assert.ok(state.resumes.has(newResumeId), "new resume promoted")
    const newRow = state.resumes.get(newResumeId)!
    assert.equal(newRow.additionalCv, true, "supplement path marks additionalCv")
    assert.equal(newRow.supplementsResumeId, prevResumeId)
    // Pending deleted.
    assert.equal(state.pending.size, 0)
  })

  it("test 6: TTL fallback — expired pending auto-promotes (replace, silent)", async () => {
    const newResumeId = "rsm_pending_6"
    const prevResumeId = "rsm_prior_6"
    const { db, state } = makeFakeDb({
      users: { u6: { phoneE164: "+14243201960" } },
      resumes: [
        {
          id: prevResumeId,
          data: {
            userId: "u6",
            candidateProfile: { name: "old6" },
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          },
        },
      ],
      pending: [
        {
          id: newResumeId,
          data: {
            newResumeId,
            previousResumeId: prevResumeId,
            userId: "u6",
            // Expired 1 hour ago.
            expireAt: "2026-05-01T11:00:00.000Z",
            parsedDoc: {
              userId: "u6",
              candidateProfile: { name: "new6" },
            },
          },
        },
      ],
    })

    const { log } = captureLog()
    const r = await runPendingCvTtlSweep(db as never, {
      nowIso: () => "2026-05-01T12:00:00.000Z",
      log,
    })
    assert.equal(r.scanned, 1, "1 expired pending row scanned")
    assert.equal(r.promoted, 1)
    assert.equal(r.archived, 1, "TTL fallback uses replace semantics → archives previous")
    // Verify side effects.
    const prev = state.resumes.get(prevResumeId)!
    assert.equal(prev.archived, true)
    assert.equal(prev.replacedBy, newResumeId)
    assert.ok(state.resumes.has(newResumeId))
    // Silent: no confirmation outbound enqueued by TTL path.
    const confirmKeys = [...state.outbound.keys()].filter((k) =>
      k.startsWith("out-cv-overwrite-confirm-")
    )
    assert.equal(confirmKeys.length, 0, "TTL fallback is silent — no confirmation outbound")
    assert.equal(state.pending.size, 0, "pending row deleted after promote")
  })
})
