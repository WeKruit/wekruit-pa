/**
 * website-entry-event.test.ts — PRD §2.3/§2.4/§2.5 producer seam.
 *
 * Covers: evidence gating, per-flow idempotency key shape, canary gate,
 * user_not_routable → pendingEmit continuation, phone-bind replay, the
 * one-shot login emit rule, and the always-full-keys continuation write
 * (no stale subkeys under Firestore deep-merge).
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import {
  buildWebsiteEntryEventContext,
  deriveLinkedinStateFromUser,
  derivePitchAlreadySent,
  processWebsiteEntry,
  replayPendingWebsiteEntryEvent,
  websiteEntryEvidenceSource,
  type WebsiteEntryContinuationDoc,
  type WebsiteEntryState,
} from "./website-entry-event.js"
import type { RuntimeEventHandoffInput, RuntimeEventHandoffResult } from "../runtime-event-handoff.js"

type DocData = Record<string, unknown>

class FakeDocRef {
  constructor(
    private readonly store: Map<string, DocData>,
    readonly id: string,
  ) {}
  async get() {
    const data = this.store.get(this.id)
    return { id: this.id, exists: data !== undefined, data: () => data }
  }
  async set(data: DocData, opts?: { merge?: boolean }) {
    const prev = this.store.get(this.id) ?? {}
    this.store.set(this.id, opts?.merge ? { ...prev, ...data } : data)
  }
}

function fakeDb(seed?: Record<string, DocData>) {
  const users = new Map<string, DocData>(Object.entries(seed ?? {}))
  const db = {
    collection: (path: string) => ({
      doc: (id: string) => {
        if (path !== "pa-users") throw new Error(`unexpected collection ${path}`)
        return new FakeDocRef(users, id)
      },
    }),
  } as unknown as Firestore
  return { db, users }
}

function state(overrides?: Partial<WebsiteEntryState>): WebsiteEntryState {
  return {
    candidateId: "cand-1",
    authProvider: "google",
    resumeStatus: "parsed",
    linkedinState: "none",
    jobIdContext: null,
    pitchAlreadySent: false,
    ...overrides,
  }
}

function captureEnqueue(result: RuntimeEventHandoffResult) {
  const calls: RuntimeEventHandoffInput[] = []
  const enqueue = async (_db: Firestore, input: RuntimeEventHandoffInput) => {
    calls.push(input)
    return result
  }
  return { calls, enqueue }
}

const OK: RuntimeEventHandoffResult = { ok: true, eventId: "evt-1", sessionId: "ses-1", created: true }
const NOT_ROUTABLE: RuntimeEventHandoffResult = { ok: false, reason: "user_not_routable" }

test("evidence source: parsed resume wins, enriched linkedin second, else null", () => {
  assert.equal(websiteEntryEvidenceSource({ resumeStatus: "parsed", linkedinState: "none" }), "resume")
  assert.equal(websiteEntryEvidenceSource({ resumeStatus: "none", linkedinState: "enriched" }), "linkedin")
  assert.equal(websiteEntryEvidenceSource({ resumeStatus: "none", linkedinState: "oauth_linked" }), null)
  assert.equal(websiteEntryEvidenceSource({ resumeStatus: "processing", linkedinState: "url_linked" }), null)
})

test("processWebsiteEntry emits the resume_parse_completed class event with a per-flow key", async () => {
  const { db, users } = fakeDb({ "cand-1": {} })
  const { calls, enqueue } = captureEnqueue(OK)
  const out = await processWebsiteEntry(db, state(), {
    flowId: "login:1765432100",
    source: "candidate_verify",
    newEvidence: false,
    deps: { enqueue, isCanary: () => true, nowIso: () => "2026-06-12T00:00:00.000Z" },
  })
  assert.equal(out.emitted, true)
  assert.equal(out.pendingEmit, false)
  assert.equal(calls.length, 1)
  const input = calls[0]!
  assert.equal(input.source, "website_entry")
  assert.equal(input.eventKind, "resume_parse_completed")
  assert.equal(input.idempotencyKey, "website-entry:cand-1:login:1765432100")
  assert.equal(input.requireExistingSession, false)
  assert.equal(input.context?.websiteEntry, true)
  assert.equal(input.context?.enrichmentSource, "resume")
  assert.equal(input.context?.authProvider, "google")
  assert.equal(input.context?.pitchAlreadySent, false)
  // Continuation recorded with lastEmitFlowId stamped, pendingEmit false.
  const cont = users.get("cand-1")?.websiteEntry as WebsiteEntryContinuationDoc
  assert.equal(cont.lastEmitFlowId, "login:1765432100")
  assert.equal(cont.pendingEmit, false)
  assert.equal(cont.source, "candidate_verify")
})

test("no evidence → record continuation only, no enqueue", async () => {
  const { db, users } = fakeDb({ "cand-1": {} })
  const { calls, enqueue } = captureEnqueue(OK)
  const out = await processWebsiteEntry(db, state({ resumeStatus: "none", linkedinState: "oauth_linked" }), {
    flowId: "login:1",
    source: "candidate_verify",
    newEvidence: false,
    deps: { enqueue, isCanary: () => true },
  })
  assert.equal(out.emitted, false)
  assert.equal(out.skippedReason, "no_evidence")
  assert.equal(calls.length, 0)
  const cont = users.get("cand-1")?.websiteEntry as WebsiteEntryContinuationDoc
  assert.equal(cont.linkedinState, "oauth_linked")
  assert.equal(cont.pendingEmit, false)
})

test("plain re-login of an already-pitched candidate never re-emits", async () => {
  const { db } = fakeDb({ "cand-1": {} })
  const { calls, enqueue } = captureEnqueue(OK)
  const out = await processWebsiteEntry(db, state({ pitchAlreadySent: true }), {
    flowId: "login:2",
    source: "candidate_verify",
    newEvidence: false,
    deps: { enqueue, isCanary: () => true },
  })
  assert.equal(out.emitted, false)
  assert.equal(out.skippedReason, "already_pitched")
  assert.equal(calls.length, 0)
})

test("login-origin emit is one-shot across logins; new evidence still emits", async () => {
  const { db } = fakeDb({
    "cand-1": {
      websiteEntry: { flowId: "login:1", lastEmitFlowId: "login:1", pendingEmit: false },
    },
  })
  const { calls, enqueue } = captureEnqueue(OK)
  const again = await processWebsiteEntry(db, state(), {
    flowId: "login:2",
    source: "candidate_verify",
    newEvidence: false,
    deps: { enqueue, isCanary: () => true },
  })
  assert.equal(again.emitted, false)
  assert.equal(again.skippedReason, "already_emitted_for_login")
  assert.equal(calls.length, 0)

  const upload = await processWebsiteEntry(db, state(), {
    flowId: "cv:resume-9",
    source: "public_cv_ingest",
    newEvidence: true,
    deps: { enqueue, isCanary: () => true },
  })
  assert.equal(upload.emitted, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.idempotencyKey, "website-entry:cand-1:cv:resume-9")
})

test("non-canary records continuation but does not enqueue (no proactive send)", async () => {
  const { db, users } = fakeDb({ "cand-1": {} })
  const { calls, enqueue } = captureEnqueue(OK)
  const out = await processWebsiteEntry(db, state(), {
    flowId: "login:3",
    source: "candidate_verify",
    newEvidence: false,
    deps: { enqueue, isCanary: () => false },
  })
  assert.equal(out.emitted, false)
  assert.equal(out.skippedReason, "not_canary")
  assert.equal(calls.length, 0)
  assert.ok(users.get("cand-1")?.websiteEntry)
})

test("user_not_routable (website-first, no phone) → pendingEmit continuation", async () => {
  const { db, users } = fakeDb({ "cand-1": {} })
  const { calls, enqueue } = captureEnqueue(NOT_ROUTABLE)
  const out = await processWebsiteEntry(db, state({ jobIdContext: "hs-123-job" }), {
    flowId: "cv:resume-1",
    source: "public_cv_ingest",
    newEvidence: true,
    deps: { enqueue, isCanary: () => true },
  })
  assert.equal(out.emitted, false)
  assert.equal(out.pendingEmit, true)
  assert.equal(out.skippedReason, "user_not_routable")
  assert.equal(calls.length, 1)
  const cont = users.get("cand-1")?.websiteEntry as WebsiteEntryContinuationDoc
  assert.equal(cont.pendingEmit, true)
  assert.equal(cont.jobIdContext, "hs-123-job")
  assert.equal(cont.lastEmitFlowId, "")
})

test("replay after phone bind emits the STORED flow id and clears pendingEmit", async () => {
  const { db, users } = fakeDb({
    "cand-1": {
      websiteEntry: {
        flowId: "cv:resume-1",
        candidateId: "cand-1",
        authProvider: "magic_link",
        resumeStatus: "parsed",
        linkedinState: "none",
        jobIdContext: "hs-123-job",
        pitchAlreadySent: false,
        pendingEmit: true,
        lastEmitFlowId: "",
        source: "public_cv_ingest",
        updatedAt: "2026-06-12T00:00:00.000Z",
      },
    },
  })
  const { calls, enqueue } = captureEnqueue(OK)
  const out = await replayPendingWebsiteEntryEvent(db, "cand-1", { enqueue, isCanary: () => true })
  assert.equal(out.emitted, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.idempotencyKey, "website-entry:cand-1:cv:resume-1")
  assert.equal(calls[0]!.context?.jobIdContext, "hs-123-job")
  const cont = users.get("cand-1")?.websiteEntry as WebsiteEntryContinuationDoc
  assert.equal(cont.pendingEmit, false)
  assert.equal(cont.lastEmitFlowId, "cv:resume-1")
})

test("replay is a no-op without a pending continuation", async () => {
  const { db } = fakeDb({ "cand-1": { websiteEntry: { flowId: "login:1", pendingEmit: false } } })
  const { calls, enqueue } = captureEnqueue(OK)
  const out = await replayPendingWebsiteEntryEvent(db, "cand-1", { enqueue, isCanary: () => true })
  assert.equal(out.emitted, false)
  assert.equal(out.reason, "no_pending")
  assert.equal(calls.length, 0)
})

test("continuation doc always writes every key (no stale subkeys under deep-merge)", async () => {
  const { db, users } = fakeDb({ "cand-1": {} })
  const { enqueue } = captureEnqueue(OK)
  await processWebsiteEntry(db, state(), {
    flowId: "login:1",
    source: "candidate_verify",
    newEvidence: false,
    deps: { enqueue, isCanary: () => true },
  })
  const cont = users.get("cand-1")?.websiteEntry as Record<string, unknown>
  for (const key of [
    "flowId",
    "candidateId",
    "authProvider",
    "resumeStatus",
    "linkedinState",
    "jobIdContext",
    "pitchAlreadySent",
    "pendingEmit",
    "lastEmitFlowId",
    "source",
    "updatedAt",
  ]) {
    assert.ok(key in cont, `missing continuation key ${key}`)
  }
})

test("context builder carries the §2.4 fields and the cvParsedTrigger flag", () => {
  const ctx = buildWebsiteEntryEventContext(
    state({ linkedinState: "enriched", resumeStatus: "none", jobIdContext: "job-7", pitchAlreadySent: true }),
    "linkedin",
  )
  assert.deepEqual(ctx, {
    cvParsedTrigger: true,
    websiteEntry: true,
    enrichmentSource: "linkedin",
    authProvider: "google",
    resumeStatus: "none",
    linkedinState: "enriched",
    jobIdContext: "job-7",
    pitchAlreadySent: true,
  })
})

test("deriveLinkedinStateFromUser ladder", () => {
  assert.equal(deriveLinkedinStateFromUser(undefined), "none")
  assert.equal(deriveLinkedinStateFromUser({ linkedinOauthLinked: true }), "oauth_linked")
  assert.equal(
    deriveLinkedinStateFromUser({ linkedinUrl: "https://www.linkedin.com/in/adam" }),
    "url_linked",
  )
  assert.equal(
    deriveLinkedinStateFromUser({ linkedinUrl: "https://www.linkedin.com/oauth-linked/abc" }),
    "none",
  )
  assert.equal(
    deriveLinkedinStateFromUser({
      linkedinOauthLinked: true,
      experienceHighlights: [{ title: "SWE", company: "Stripe" }],
    }),
    "enriched",
  )
})

test("derivePitchAlreadySent reads pa-users.pitchedAt", () => {
  assert.equal(derivePitchAlreadySent(undefined), false)
  assert.equal(derivePitchAlreadySent({}), false)
  assert.equal(derivePitchAlreadySent({ pitchedAt: "" }), false)
  assert.equal(derivePitchAlreadySent({ pitchedAt: "2026-06-12T00:00:00.000Z" }), true)
})
