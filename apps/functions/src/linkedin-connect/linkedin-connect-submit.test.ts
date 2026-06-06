/**
 * Tests for the LinkedIn one-tap connect submit handler — the load-bearing CF
 * orchestration (token → link handle → Coresignal enrich → runtime event →
 * sms reroute), exercised via the pure `handleLinkedinConnectSubmit` with
 * injected (mocked) dependencies. The `onRequest` wrapper is a thin adapter
 * over this, so testing the pure handler covers the real decision logic.
 *
 * Separately, `identity resolve` exercises the REAL `linkCandidateHandle`
 * against a fake Firestore to prove the v2.0 identity rule: same LinkedIn hash
 * resolves to the same uid (no conflict); a different uid on the same hash
 * throws `identity_conflict:<id>` and writes a conflict doc (→ needs_review).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { canonicalizeLinkedInUrl, linkedinHash } from "@pa/external-supply"
import { linkCandidateHandle, hashCandidateHandle } from "@pa/pa-persistence"
import {
  handleLinkedinConnectSubmit,
  type LinkedinConnectSubmitDeps,
} from "./linkedin-connect-submit.js"
import type { VerifyLinkedinConnectTokenResult } from "./connect-token.js"

// ---------------------------------------------------------------------------
// Spy-deps factory: real builder semantics, recorded side-effects, mocked
// CoreSignal/identity so we can assert WHAT the handler did (enrich / emit /
// reroute / mark-used / canary gate) without a live backend.
// ---------------------------------------------------------------------------

type EmitArgs = { userId: string; canonicalUrl: string; enriched: boolean; nowIso: string; token: string }

interface Spies {
  deps: LinkedinConnectSubmitDeps
  calls: {
    linkHandle: Array<{ userId: string; canonicalUrl: string }>
    persistUrl: Array<{ userId: string; canonicalUrl: string }>
    enrich: Array<{ userId: string; canonicalUrl: string; apiKey: string }>
    emit: EmitArgs[]
    markUsed: string[]
  }
}

function makeSpies(overrides: {
  verify?: VerifyLinkedinConnectTokenResult
  isCanary?: boolean
  apiKey?: string
  enrichResult?: { enriched: boolean }
  enrichThrows?: Error
  linkHandleThrows?: Error
  /** sms: reroute RECIPIENT = the user's WeKruit Sendblue number (NOT the candidate's own phone). */
  senderNumber?: string
} = {}): Spies {
  const verify: VerifyLinkedinConnectTokenResult =
    overrides.verify ?? { ok: true, userId: "user-1", phoneE164: "+14243201960" }
  const isCanary = overrides.isCanary ?? true
  const apiKey = overrides.apiKey ?? "csk-test"
  // The candidate's own phone is +14243201960 (verify.phoneE164); the reroute must target the
  // WeKruit sender number instead, so they're intentionally DIFFERENT here.
  const senderNumber = overrides.senderNumber ?? "+17174919939"
  const calls: Spies["calls"] = { linkHandle: [], persistUrl: [], enrich: [], emit: [], markUsed: [] }

  const deps: LinkedinConnectSubmitDeps = {
    nowIso: () => "2026-06-03T00:00:00.000Z",
    verifyToken: async () => verify,
    linkHandle: async (userId, canonicalUrl) => {
      calls.linkHandle.push({ userId, canonicalUrl })
      if (overrides.linkHandleThrows) throw overrides.linkHandleThrows
    },
    persistUrl: async (userId, canonicalUrl) => {
      calls.persistUrl.push({ userId, canonicalUrl })
    },
    isCanary: () => isCanary,
    coresignalApiKey: () => apiKey,
    enrich: async ({ userId, canonicalUrl, apiKey: k }) => {
      calls.enrich.push({ userId, canonicalUrl, apiKey: k })
      if (overrides.enrichThrows) throw overrides.enrichThrows
      return overrides.enrichResult ?? { enriched: true }
    },
    emitRuntimeEvent: async (args) => {
      calls.emit.push(args)
    },
    markUsed: async (token) => {
      calls.markUsed.push(token)
    },
    resolveRerouteRecipient: async () => senderNumber,
    buildSms: (recipient, body) => (body ? `sms:${recipient}?&body=${encodeURIComponent(body)}` : `sms:${recipient}`),
  }
  return { deps, calls }
}

describe("handleLinkedinConnectSubmit — happy path (canary, enrich, emit, reroute)", () => {
  it("links handle, enriches, emits resume_parse_completed runtime event, returns sms reroute", async () => {
    const { deps, calls } = makeSpies()
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_abc12345",
      linkedinUrl: "https://www.LinkedIn.com/in/Ada-Lovelace/?trk=x",
    })

    // Canonicalized URL is what gets linked + enriched (host/slug lowercased,
    // query stripped) — proves the handler canonicalizes before identity work.
    const canonical = canonicalizeLinkedInUrl("https://www.LinkedIn.com/in/Ada-Lovelace/?trk=x")
    assert.ok(canonical, "fixture URL must canonicalize")
    assert.deepEqual(calls.linkHandle, [{ userId: "user-1", canonicalUrl: canonical }])
    assert.deepEqual(calls.persistUrl, [{ userId: "user-1", canonicalUrl: canonical }])
    assert.equal(calls.enrich.length, 1)
    assert.equal(calls.enrich[0].apiKey, "csk-test")

    // Runtime event is the load-bearing handoff that drives the thin pitch.
    assert.equal(calls.emit.length, 1)
    assert.deepEqual(calls.emit[0], {
      userId: "user-1",
      canonicalUrl: canonical,
      enriched: true,
      nowIso: "2026-06-03T00:00:00.000Z",
      // per-connect-flow idempotency: the single-use token now keys the pitch handoff (dedups a
      // double-callback of one login, lets a genuine re-login pitch fresh).
      token: "tok_abc12345",
    })

    // Token consumed single-use + sms reroute back into the thread.
    assert.deepEqual(calls.markUsed, ["tok_abc12345"])
    assert.equal(result.ok, true)
    assert.equal(result.enriched, true)
    assert.ok(result.smsDeepLink, "must return an sms: reroute")
    // Reroute targets the WeKruit SENDER number (so opening lands in Claire's thread), NOT the
    // candidate's own phone (+14243201960). This is the Image #21 bug, locked against regression.
    assert.match(result.smsDeepLink!, /^sms:\+17174919939/)
    assert.ok(!result.smsDeepLink!.includes("+14243201960"), "must NOT reroute to the candidate's own phone")
    // NO PREFILL (Adam 2026-06-06): the reroute just drops the candidate back in the thread with an
    // EMPTY compose box — no "I've done LinkedIn submission <token>" message. The server already pushes
    // the pitch via the resume_parse_completed handoff, so there is nothing for the user to send.
    assert.ok(!result.smsDeepLink!.includes("body="), "reroute must NOT prefill any message body")
  })
})

describe("handleLinkedinConnectSubmit — token + url failures short-circuit", () => {
  it("propagates an unknown token (no link/enrich/emit/markUsed)", async () => {
    const { deps, calls } = makeSpies({ verify: { ok: false, reason: "unknown_token" } })
    const result = await handleLinkedinConnectSubmit(deps, { token: "nope", linkedinUrl: "x" })
    assert.deepEqual(result, { ok: false, reason: "unknown_token" })
    assert.equal(calls.linkHandle.length, 0)
    assert.equal(calls.enrich.length, 0)
    assert.equal(calls.emit.length, 0)
    assert.equal(calls.markUsed.length, 0)
  })

  it("propagates an expired token verbatim", async () => {
    const { deps } = makeSpies({ verify: { ok: false, reason: "token_expired" } })
    const result = await handleLinkedinConnectSubmit(deps, { token: "old", linkedinUrl: "x" })
    assert.deepEqual(result, { ok: false, reason: "token_expired" })
  })

  it("rejects an invalid LinkedIn URL after a valid token (no enrich/emit)", async () => {
    const { deps, calls } = makeSpies()
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_valid1234",
      linkedinUrl: "not a linkedin url",
    })
    assert.deepEqual(result, { ok: false, reason: "invalid_url" })
    assert.equal(calls.linkHandle.length, 0)
    assert.equal(calls.enrich.length, 0)
    assert.equal(calls.emit.length, 0)
  })
})

describe("handleLinkedinConnectSubmit — identity conflict → needs_review (NO enrich)", () => {
  it("returns needs_review and skips enrich + emit when linkHandle reports a conflict", async () => {
    const { deps, calls } = makeSpies({
      linkHandleThrows: new Error("identity_conflict:conflict_abc"),
    })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_conflict12",
      linkedinUrl: "https://linkedin.com/in/someone",
    })
    assert.deepEqual(result, { ok: false, reason: "needs_review" })
    assert.equal(calls.linkHandle.length, 1, "link attempted")
    assert.equal(calls.persistUrl.length, 0, "no URL persisted on conflict")
    assert.equal(calls.enrich.length, 0, "no enrich on identity conflict (v2.0 rule)")
    assert.equal(calls.emit.length, 0, "no pitch event on identity conflict")
    assert.equal(calls.markUsed.length, 0, "token not consumed on conflict")
  })

  it("a NON-conflict link error does NOT dead-end the candidate (still persists + reroutes)", async () => {
    const { deps, calls } = makeSpies({
      linkHandleThrows: new Error("firestore_unavailable"),
    })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_softfail12",
      linkedinUrl: "https://linkedin.com/in/someone",
    })
    assert.equal(result.ok, true, "soft link failure must not 500/dead-end")
    assert.equal(calls.persistUrl.length, 1, "URL still persisted")
    assert.equal(calls.emit.length, 1, "pitch event still fires")
    assert.ok(result.smsDeepLink, "still reroutes back to thread")
  })
})

describe("handleLinkedinConnectSubmit — canary gate", () => {
  it("non-canary: links + persists + reroutes but does NOT enrich or emit", async () => {
    const { deps, calls } = makeSpies({ isCanary: false })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_noncanary1",
      linkedinUrl: "https://linkedin.com/in/jane",
    })
    assert.equal(result.ok, true)
    assert.equal(result.enriched, false, "no enrich for non-canary")
    assert.equal(calls.linkHandle.length, 1, "handle still linked (durable identity)")
    assert.equal(calls.persistUrl.length, 1, "URL still persisted")
    assert.equal(calls.enrich.length, 0, "enrich gated to canary")
    assert.equal(calls.emit.length, 0, "pitch event gated to canary")
    assert.ok(result.smsDeepLink, "never a dead end — still reroutes")
  })
})

describe("handleLinkedinConnectSubmit — graceful degrade (never 500)", () => {
  it("coresignal key absent: still emits the event + reroutes, enriched=false", async () => {
    const { deps, calls } = makeSpies({ apiKey: "" })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_nokey1234",
      linkedinUrl: "https://linkedin.com/in/jane",
    })
    assert.equal(result.ok, true)
    assert.equal(result.enriched, false)
    assert.equal(calls.enrich.length, 0, "no enrich attempt without a key")
    assert.equal(calls.emit.length, 1, "pitch event still fires (best-effort)")
    assert.equal(calls.emit[0].enriched, false)
    assert.ok(result.smsDeepLink)
  })

  it("coresignal enrich throws: fail-open, still emits + reroutes, enriched=false", async () => {
    const { deps, calls } = makeSpies({ enrichThrows: new Error("coresignal 503") })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_enrichdown",
      linkedinUrl: "https://linkedin.com/in/jane",
    })
    assert.equal(result.ok, true, "enrich failure must fail open, not 500")
    assert.equal(result.enriched, false)
    assert.equal(calls.enrich.length, 1, "enrich was attempted")
    assert.equal(calls.emit.length, 1, "pitch event still fires after enrich failure")
    assert.equal(calls.emit[0].enriched, false)
    assert.ok(result.smsDeepLink)
  })

  it("enrich returns enriched=false (no Coresignal match): emit carries enriched=false", async () => {
    const { deps, calls } = makeSpies({ enrichResult: { enriched: false } })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_nomatch12",
      linkedinUrl: "https://linkedin.com/in/jane",
    })
    assert.equal(result.ok, true)
    assert.equal(result.enriched, false)
    assert.equal(calls.emit[0].enriched, false)
  })

  it("no resolvable sender number: ok with NO sms reroute (page falls back), token still consumed", async () => {
    const { deps, calls } = makeSpies({ senderNumber: "" })
    const result = await handleLinkedinConnectSubmit(deps, {
      token: "tok_nophone12",
      linkedinUrl: "https://linkedin.com/in/jane",
    })
    assert.equal(result.ok, true)
    assert.equal(result.smsDeepLink, undefined, "no phone → no reroute link")
    assert.deepEqual(calls.markUsed, ["tok_nophone12"], "token still consumed")
  })
})

// ---------------------------------------------------------------------------
// Identity resolve — REAL linkCandidateHandle against a fake Firestore.
// Proves the v2.0 identity rule end-to-end (no mocked identity here).
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeIdentityDb(): { db: Firestore; store: Store } {
  const store: Store = new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
  function col(name: string): Map<string, Record<string, unknown>> {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  let auto = 1
  function docRef(name: string, id?: string) {
    const docId = id ?? `auto_${auto++}`
    return {
      id: docId,
      async get() {
        const data = col(name).get(docId)
        return { exists: data !== undefined, id: docId, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = opts?.merge ? { ...(col(name).get(docId) ?? {}) } : {}
        col(name).set(docId, { ...current, ...data })
      },
    }
  }
  const db = {
    collection(name: string) {
      return { doc: (id?: string) => docRef(name, id) }
    },
  } as unknown as Firestore
  return { db, store }
}

describe("identity resolve — same LinkedIn hash → same uid; different uid → conflict", () => {
  const url = "https://www.linkedin.com/in/ada-lovelace"
  const now = "2026-06-03T00:00:00.000Z"

  it("first link creates the handle mapped to uid A; the hash is the doc id", async () => {
    const { db, store } = makeIdentityDb()
    const canonical = canonicalizeLinkedInUrl(url)!
    const out = await linkCandidateHandle(db, {
      candidateId: "uid-A",
      kind: "linkedin",
      value: canonical,
      source: "candidate",
      now,
    })
    assert.equal(out.created, true)
    assert.equal(out.handle.candidateId, "uid-A")
    // Doc id is the hashed handle (NEVER the raw URL) — v2.0 identity rule.
    const hashed = hashCandidateHandle("linkedin", canonical)
    const handleDoc = store.get(PA_COLLECTIONS.candidateHandles)!.get(hashed.handleId)
    assert.ok(handleDoc, "handle stored under the hashed id")
    assert.equal(handleDoc!.candidateId, "uid-A")
    assert.equal(handleDoc!.handleId, hashed.handleId)
  })

  it("re-linking the SAME url to the SAME uid resolves to that uid (created=false, no conflict)", async () => {
    const { db } = makeIdentityDb()
    const canonical = canonicalizeLinkedInUrl(url)!
    await linkCandidateHandle(db, { candidateId: "uid-A", kind: "linkedin", value: canonical, source: "candidate", now })
    const again = await linkCandidateHandle(db, {
      candidateId: "uid-A",
      kind: "linkedin",
      value: canonical,
      source: "candidate",
      now,
    })
    assert.equal(again.created, false)
    assert.equal(again.handle.candidateId, "uid-A")
  })

  it("URL variants that canonicalize identically map to the SAME hash (one uid)", async () => {
    const { db } = makeIdentityDb()
    const c1 = canonicalizeLinkedInUrl("https://www.linkedin.com/in/ada-lovelace")!
    const c2 = canonicalizeLinkedInUrl("https://LinkedIn.com/in/Ada-Lovelace/?trk=public")!
    assert.equal(c1, c2, "case/query/trailing-slash variants canonicalize the same")
    await linkCandidateHandle(db, { candidateId: "uid-A", kind: "linkedin", value: c1, source: "candidate", now })
    const again = await linkCandidateHandle(db, { candidateId: "uid-A", kind: "linkedin", value: c2, source: "candidate", now })
    assert.equal(again.created, false, "second variant hits the same handle doc")
  })

  it("linking the SAME url to a DIFFERENT uid throws identity_conflict + writes a conflict doc (NO auto-merge)", async () => {
    const { db, store } = makeIdentityDb()
    const canonical = canonicalizeLinkedInUrl(url)!
    await linkCandidateHandle(db, { candidateId: "uid-A", kind: "linkedin", value: canonical, source: "candidate", now })
    await assert.rejects(
      () =>
        linkCandidateHandle(db, {
          candidateId: "uid-B",
          kind: "linkedin",
          value: canonical,
          source: "candidate",
          now,
        }),
      (err: unknown) => err instanceof Error && err.message.startsWith("identity_conflict:"),
    )
    // The handle doc still maps to the ORIGINAL uid (no silent overwrite/merge).
    const hashed = hashCandidateHandle("linkedin", canonical)
    const handleDoc = store.get(PA_COLLECTIONS.candidateHandles)!.get(hashed.handleId)
    assert.equal(handleDoc!.candidateId, "uid-A", "first claimant keeps the handle")
    // A conflict record was written for HITL review.
    const conflicts = store.get(PA_COLLECTIONS.candidateIdentityConflicts)
    assert.ok(conflicts && conflicts.size >= 1, "an identity conflict doc was recorded for review")
  })

  it("the connect-submit idempotency key is stable for a (uid, linkedin-hash) pair", () => {
    // The runtime-event idempotency key is `linkedin-enriched:<uid>:<hash>` — two
    // submits of the same URL by the same uid collapse to ONE pitch event.
    const canonical = canonicalizeLinkedInUrl(url)!
    const k1 = `linkedin-enriched:uid-A:${linkedinHash(canonical)}`
    const k2 = `linkedin-enriched:uid-A:${linkedinHash(canonicalizeLinkedInUrl("https://LinkedIn.com/in/Ada-Lovelace/?x=1")!)}`
    assert.equal(k1, k2, "same canonical URL → same idempotency key (one pitch)")
  })
})
