/**
 * resume-ingest-failure.test.ts — BUG A regression (live 2026-06-11, RJcsA285Drcml1kTPZjI).
 *
 * WHAT HAPPENED LIVE: the candidate sent a SCREENSHOT (IMG_7001.PNG). The résumé-drop seam
 * (cutover.ts) replied "got it — reading through your résumé now 📄", set
 * `pa-users.enrichmentInFlight=true`, and fired the fire-and-forget ingestCv. parsePdf failed on
 * the PNG bytes → `{ok:false, reason:"pdf_parse_failed"}` was only LOGGED:
 *   - the candidate never heard back (the pitch fires only on resume_parse_completed, which a
 *     failed parse never emits) — total silence;
 *   - enrichmentInFlight stuck true forever (the cv-parsed re-entry is the only CLEAR site), so the
 *     next turns got the deterministic "still pulling your info, one sec 🔎" hold ack.
 *
 * THE FIX (cutover.ts):
 *   1. withIngestFailureHandling — every settle of the fire-and-forget ingest chain with
 *      `ok !== true` (or a throw) ALWAYS clears enrichmentInFlight and sends a real fallback reply
 *      (RESUME_INGEST_FAILURE_REPLY), except for ingestCv reasons that already self-message
 *      (not_invited / quota_exhausted / pdf_too_large via enqueueLimitRejection).
 *   2. isImageAttachmentUrl — the Sendblue media URL carries the original filename; a known image
 *      extension (an EXISTING structural signal — no content sniffing) branches BEFORE any résumé
 *      claim: image-only drop → honest deterministic reply (IMAGE_ATTACHMENT_REPLY), no
 *      enrichmentInFlight, no ingestCv, no "reading your résumé" lie.
 *
 * Mirrors the resume-e2e harness: REAL maybeRunThinClaire over an in-memory Firestore stub,
 * dryRun transport, ingestCvOverride as the parse seam. Load-bearing assertions are on routing
 * (handledBy), log markers, and the durable pa-users marker — same style as resume-e2e.test.ts.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/__tests__/resume-ingest-failure.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { maybeRunThinClaire, isImageAttachmentUrl } from "../cutover.js"

const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // in CANARY_UIDS → all résumé-drop gates open
const PHONE = "+14243201960"
const THIN_FLAG_KEY = "paThinClaireEnabled"

// ── Minimal in-memory Firestore stub (subset of the resume-e2e one) ─────────────────────────────
type DocStore = Map<string, Record<string, unknown>>
function makeFirestore() {
  const store = new Map<string, DocStore>()
  const col = (name: string): DocStore => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  let autoId = 0
  const makeQuery = (name: string, filters: Array<[string, unknown]>) => {
    const api: Record<string, unknown> = {
      where(field: string, _op: string, value: unknown) {
        return makeQuery(name, [...filters, [field, value]])
      },
      orderBy() {
        return api
      },
      limit() {
        return api
      },
      async get() {
        const rows = [...col(name).entries()].filter(([, data]) =>
          filters.every(([field, value]) => {
            const actual = (data as Record<string, unknown>)[field]
            if (value === null) return actual === null || actual === undefined
            return actual === value
          }),
        )
        const docs = rows.map(([id, data]) => ({ id, exists: true, data: () => data }))
        return { empty: docs.length === 0, docs, size: docs.length }
      },
    }
    return api
  }
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            id,
            async get() {
              const data = col(name).get(id)
              return { exists: data !== undefined, id, data: () => data }
            },
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              col(name).set(id, opts?.merge ? { ...(col(name).get(id) ?? {}), ...data } : { ...data })
            },
            async create(data: Record<string, unknown>) {
              if (col(name).has(id)) {
                const err = new Error("ALREADY_EXISTS") as Error & { code: number }
                err.code = 6
                throw err
              }
              col(name).set(id, { ...data })
            },
          }
        },
        async add(data: Record<string, unknown>) {
          const id = `auto_${name}_${++autoId}`
          col(name).set(id, { ...data })
          return { id }
        },
        where(field: string, _op: string, value: unknown) {
          return makeQuery(name, [[field, value]])
        },
      }
    },
  } as unknown as Firestore
  return { db, col }
}

function seed(col: (n: string) => DocStore, eventId: string, mediaUrl: string) {
  col("pa-feature-flags").set(THIN_FLAG_KEY, {
    key: THIN_FLAG_KEY,
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [CANARY_UID],
    blocklist: [],
  })
  col(PA_COLLECTIONS.users).set(CANARY_UID, {
    id: CANARY_UID,
    phoneE164: PHONE,
    onboardingState: "complete",
    sharedOnboarding: { completed: true, status: "completed" },
  })
  col(PA_COLLECTIONS.sessions).set("ses_fail", {
    id: "ses_fail",
    userId: CANARY_UID,
    channel: "imessage",
    externalChatId: PHONE,
  })
  col(PA_COLLECTIONS.inboundEvents).set(eventId, {
    userId: CANARY_UID,
    sessionId: "ses_fail",
    body: "[attachment]", // Sendblue placeholder — NOT real text (the Avi shape)
    fromNumber: PHONE,
    rawMeta: { source: "imessage_broker", mediaUrl, messageHandle: "MH-1" },
  })
}

async function waitFor(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ── (A) failed ingest clears enrichmentInFlight + emits a non-empty fallback reply ──────────────
test("FAILED PARSE: {ok:false} ingest clears enrichmentInFlight AND sends the fallback reply (no more silent death)", async () => {
  const { db, col } = makeFirestore()
  const eventId = "evt_failed_parse"
  seed(col, eventId, "https://storage.googleapis.com/inbound-file-store/some-upload.pdf")
  const events: Array<{ e: string; p?: Record<string, unknown> }> = []
  let ingestCalls = 0

  const handled = await maybeRunThinClaire(db, eventId, {
    dryRun: true,
    log: (e, p) => events.push({ e, p }),
    ingestCvOverride: async () => {
      ingestCalls += 1
      return { ok: false, reason: "pdf_parse_failed" }
    },
  })

  assert.equal(handled, true, "the résumé-only drop is still acked + handled on thin")
  assert.equal(ingestCalls, 1, "the ingest seam fired")
  const handledBy = String(col(PA_COLLECTIONS.inboundEvents).get(eventId)!.handledBy ?? "")
  assert.equal(handledBy, "thin_claire_resume_ack", "a PDF drop keeps the reading-ack path")

  // The marker was set on the ack turn — the failure handler must CLEAR it (the live bug left it
  // true forever, poisoning later turns with the 'still pulling' hold ack).
  await waitFor(
    () => col(PA_COLLECTIONS.users).get(CANARY_UID)?.enrichmentInFlight === false,
    "enrichmentInFlight cleared after failed ingest",
  )
  // …and the candidate must get a REAL reply, not silence.
  await waitFor(
    () => events.some((x) => x.e === "thin_claire.resume_ingest.fallback_sent"),
    "fallback reply sent after failed ingest",
  )
  const fallback = events.find((x) => x.e === "thin_claire.resume_ingest.fallback_sent")
  assert.equal(fallback?.p?.reason, "pdf_parse_failed")
})

test("THROWN INGEST: a rejecting ingest chain also clears the marker + sends the fallback", async () => {
  const { db, col } = makeFirestore()
  const eventId = "evt_thrown_ingest"
  seed(col, eventId, "https://storage.googleapis.com/inbound-file-store/another.pdf")
  const events: string[] = []

  const handled = await maybeRunThinClaire(db, eventId, {
    dryRun: true,
    log: (e) => events.push(e),
    ingestCvOverride: async () => {
      throw new Error("network down")
    },
  })

  assert.equal(handled, true)
  await waitFor(
    () => col(PA_COLLECTIONS.users).get(CANARY_UID)?.enrichmentInFlight === false,
    "enrichmentInFlight cleared after thrown ingest",
  )
  await waitFor(
    () => events.includes("thin_claire.resume_ingest.fallback_sent"),
    "fallback reply sent after thrown ingest",
  )
})

test("SELF-MESSAGING REJECT (quota_exhausted): marker cleared but NO double-text (ingestCv already messaged)", async () => {
  const { db, col } = makeFirestore()
  const eventId = "evt_quota"
  seed(col, eventId, "https://storage.googleapis.com/inbound-file-store/third.pdf")
  const events: string[] = []

  await maybeRunThinClaire(db, eventId, {
    dryRun: true,
    log: (e) => events.push(e),
    ingestCvOverride: async () => ({ ok: false, reason: "quota_exhausted" }),
  })

  await waitFor(
    () => events.includes("thin_claire.resume_ingest.failure_no_fallback"),
    "failure handler ran without a fallback reply",
  )
  assert.equal(
    events.includes("thin_claire.resume_ingest.fallback_sent"),
    false,
    "must not double-text on a self-messaging limit rejection",
  )
  assert.equal(
    col(PA_COLLECTIONS.users).get(CANARY_UID)?.enrichmentInFlight,
    false,
    "marker still cleared",
  )
})

test("SUCCESSFUL INGEST (control): no fallback fires; the marker is left for the cv-parsed re-entry to clear", async () => {
  const { db, col } = makeFirestore()
  const eventId = "evt_ok_ingest"
  seed(col, eventId, "https://storage.googleapis.com/inbound-file-store/good.pdf")
  const events: string[] = []

  await maybeRunThinClaire(db, eventId, {
    dryRun: true,
    log: (e) => events.push(e),
    ingestCvOverride: async () => ({ ok: true, resumeId: "r1", userId: CANARY_UID }),
  })

  await waitFor(() => events.includes("thin_claire.resume_ingest.done"), "ingest settled")
  assert.equal(events.includes("thin_claire.resume_ingest.fallback_sent"), false)
  assert.equal(events.includes("thin_claire.resume_ingest.failure_no_fallback"), false)
  // (waitFor: the marker SET is fire-and-forget — give its microtask chain time to land.)
  await waitFor(
    () => col(PA_COLLECTIONS.users).get(CANARY_UID)?.enrichmentInFlight === true,
    "success leaves the marker for the resume_parse_completed re-entry (the existing CLEAR site)",
  )
})

// ── (B) image attachments never enter the résumé pipeline at all ────────────────────────────────
test("IMAGE DROP (the live IMG_7001.PNG shape): honest reply, NO résumé claim, NO marker, NO ingest", async () => {
  const { db, col } = makeFirestore()
  const eventId = "evt_image_drop"
  seed(col, eventId, "https://storage.googleapis.com/inbound-file-store/YPqlGRXa_IMG_7001.PNG")
  const events: string[] = []
  let ingestCalls = 0

  const handled = await maybeRunThinClaire(db, eventId, {
    dryRun: true,
    log: (e) => events.push(e),
    ingestCvOverride: async () => {
      ingestCalls += 1
      return { ok: true }
    },
  })

  assert.equal(handled, true, "the image-only drop is handled deterministically on thin")
  const handledBy = String(col(PA_COLLECTIONS.inboundEvents).get(eventId)!.handledBy ?? "")
  assert.equal(handledBy, "thin_claire_image_attachment_ack", "image ack path, not resume_ack")
  assert.equal(ingestCalls, 0, "ingestCv must NEVER fire for a known-image attachment")
  assert.notEqual(
    col(PA_COLLECTIONS.users).get(CANARY_UID)?.enrichmentInFlight,
    true,
    "enrichmentInFlight must not be set for an image",
  )
  assert.ok(events.includes("thin_claire.image_attachment.detected"))
  assert.ok(events.includes("thin_claire.image_attachment.ack_sent"))
  assert.equal(
    events.includes("thin_claire.resume_ack.sent"),
    false,
    "the 'reading through your résumé' ack must not fire for an image",
  )
})

test("isImageAttachmentUrl — extension signal only (case-insensitive, query-safe, no content sniffing)", () => {
  assert.equal(isImageAttachmentUrl("https://x.com/store/YPqlGRXa_IMG_7001.PNG"), true)
  assert.equal(isImageAttachmentUrl("https://x.com/a/photo.jpeg?sig=abc"), true)
  assert.equal(isImageAttachmentUrl("https://x.com/a/pic.HEIC"), true)
  assert.equal(isImageAttachmentUrl("https://x.com/a/resume.pdf"), false)
  assert.equal(isImageAttachmentUrl("https://x.com/a/resume"), false) // unknown ext → résumé path (fail-open)
  assert.equal(isImageAttachmentUrl(""), false)
  assert.equal(isImageAttachmentUrl("not a url"), false)
})
