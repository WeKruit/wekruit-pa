/**
 * pregenerate-rec-card.test.ts — REGRESSION for P0 #4 (collab rec-card image
 * inconsistent): a collab job must carry a ready, Sendblue-acceptable
 * `recCardMediaUrl` PERSISTED on matching-jobs/{jobId} the moment it is
 * created/enriched — i.e. the card is generated AT CREATION, not lazily at send.
 *
 * Proves `pregenerateRecCardForJob`:
 *   - happy path: generates + PERSISTS recCardMediaUrl + recCardContentHash
 *     (the exact field the runtime cache read uses),
 *   - idempotent: an unchanged collab job (cached url+hash already match) is
 *     SKIPPED — no render, no upload, no write,
 *   - a WRONG-SHAPED cached url (legacy Firebase token url) is NOT treated as a
 *     valid cache → regenerates a fresh Sendblue url,
 *   - FAIL-OPEN: no creds / un-renderable / gen-fail / persist-fail all return a
 *     typed status and NEVER throw (a card-gen miss must not abort enrichment).
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  pregenerateRecCardForJob,
  recCardContentHash,
} from "../job-rec-card.js"
import { buildRecCardPayload } from "../card-payload.js"

// A Sendblue-acceptable media URL: https, ends in .png, no signed query.
const SENDBLUE_MEDIA_URL = "https://storage.googleapis.com/inbound-file-store/aBcd1234_wk-rec-job-1.png"
// A POISONED legacy Firebase token URL: HTTP-200-live but signed + no .png terminator → Sendblue drops it.
const FIREBASE_TOKEN_URL =
  "https://firebasestorage.googleapis.com/v0/b/wekruit-5f89b.appspot.com/o/rec-cards%2Fabc%2Fdef.png?alt=media&token=deadbeef"
const CREDS = { apiKeyId: "k", apiSecretKey: "s" }

const COLLAB_JOB = {
  companyName: "VoiceCursor",
  jobTitle: "Founding Engineer",
  roleTitle: "Founding Engineer",
  atsApplyUrl: "https://wekruit.com/j/voicecursor-founding-engineer",
  requiredSkills: ["typescript", "react"],
}

/** Fake db that captures matching-jobs set() writes. */
function makeFakeDb() {
  const mjWrites: Array<Record<string, unknown>> = []
  const db = {
    collection(name: string) {
      return {
        doc() {
          return {
            async get() {
              return { exists: false, data: () => undefined }
            },
            async set(doc: Record<string, unknown>) {
              if (name === "matching-jobs") mjWrites.push(doc)
            },
          }
        },
      }
    },
  }
  return { db: db as never, mjWrites }
}

// ── happy path: generate + PERSIST the cached url at creation ─────────────────

test("pregenerateRecCardForJob: generates + persists recCardMediaUrl on matching-jobs (the cache read source)", async () => {
  const { db, mjWrites } = makeFakeDb()
  let rendered = false
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "voicecursor-founding-engineer",
    job: COLLAB_JOB,
    company: null,
    creds: CREDS,
    renderPng: async () => {
      rendered = true
      return Buffer.from("PNGDATA")
    },
    fetchLogoDataUri: async () => null,
    uploadMedia: async (_png, filename) => `https://storage.googleapis.com/inbound-file-store/FAKE_${filename}`,
  })
  assert.equal(res.status, "generated")
  assert.equal(rendered, true, "the card was rendered at creation (not deferred to send)")
  assert.ok(res.status === "generated" && /\.png$/.test(res.mediaUrl), "media url is .png-terminated")
  // THE REGRESSION ASSERTION: the card url is persisted to matching-jobs under the
  // EXACT field the runtime cache read uses, so every collab job has a ready card.
  assert.equal(mjWrites.length, 1, "exactly one matching-jobs writeback")
  const w = mjWrites[0]!
  assert.equal(typeof w.recCardMediaUrl, "string")
  assert.match(String(w.recCardMediaUrl), /\.png$/)
  assert.equal(typeof w.recCardContentHash, "string")
  assert.equal(typeof w.recCardGeneratedAt, "string")
})

// ── idempotency: an unchanged collab job is skipped (no render/upload/write) ───

test("pregenerateRecCardForJob: cached url+hash already match → skipped (no render, no write)", async () => {
  const { db, mjWrites } = makeFakeDb()
  const payload = buildRecCardPayload({ job: COLLAB_JOB, company: null, reasons: null })!
  const hash = recCardContentHash(payload)
  let rendered = false
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "voicecursor-founding-engineer",
    job: COLLAB_JOB,
    company: null,
    cached: { mediaUrl: SENDBLUE_MEDIA_URL, contentHash: hash },
    creds: CREDS,
    renderPng: async () => {
      rendered = true
      return Buffer.from("PNGDATA")
    },
    fetchLogoDataUri: async () => null,
    uploadMedia: async (_png, filename) => `https://storage.googleapis.com/inbound-file-store/FAKE_${filename}`,
  })
  assert.equal(res.status, "skipped_cached")
  assert.equal(rendered, false, "no re-render when content is unchanged")
  assert.equal(mjWrites.length, 0, "no write on an idempotent skip")
})

test("pregenerateRecCardForJob: force=true bypasses the cache gate → regenerates", async () => {
  const { db, mjWrites } = makeFakeDb()
  const payload = buildRecCardPayload({ job: COLLAB_JOB, company: null, reasons: null })!
  const hash = recCardContentHash(payload)
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "job-1",
    job: COLLAB_JOB,
    company: null,
    cached: { mediaUrl: SENDBLUE_MEDIA_URL, contentHash: hash },
    creds: CREDS,
    force: true,
    renderPng: async () => Buffer.from("PNGDATA"),
    fetchLogoDataUri: async () => null,
    uploadMedia: async (_png, filename) => `https://storage.googleapis.com/inbound-file-store/FAKE_${filename}`,
  })
  assert.equal(res.status, "generated")
  assert.equal(mjWrites.length, 1)
})

// ── wrong-shaped cache → NOT a valid skip → regenerate ────────────────────────

test("pregenerateRecCardForJob: a wrong-shaped (Firebase token) cached url → regenerates a fresh Sendblue url", async () => {
  const { db, mjWrites } = makeFakeDb()
  const payload = buildRecCardPayload({ job: COLLAB_JOB, company: null, reasons: null })!
  const hash = recCardContentHash(payload)
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "job-1",
    job: COLLAB_JOB,
    company: null,
    // hash matches, but the cached url is a poisoned Firebase token url (Sendblue drops it).
    cached: { mediaUrl: FIREBASE_TOKEN_URL, contentHash: hash },
    creds: CREDS,
    renderPng: async () => Buffer.from("PNGDATA"),
    fetchLogoDataUri: async () => null,
    uploadMedia: async (_png, filename) => `https://storage.googleapis.com/inbound-file-store/FAKE_${filename}`,
  })
  assert.equal(res.status, "generated", "a wrong-shaped cache is not a valid skip")
  assert.equal(mjWrites.length, 1)
  assert.match(String(mjWrites[0]!.recCardMediaUrl), /\.png$/)
  assert.ok(!/firebasestorage/.test(String(mjWrites[0]!.recCardMediaUrl)), "never persists a Firebase url")
})

// ── fail-open: never throws into enrichment ───────────────────────────────────

test("pregenerateRecCardForJob: no creds → skipped_no_creds (no-op, no throw)", async () => {
  const { db, mjWrites } = makeFakeDb()
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "job-1",
    job: COLLAB_JOB,
    company: null,
    creds: { apiKeyId: "", apiSecretKey: "" },
  })
  assert.equal(res.status, "skipped_no_creds")
  assert.equal(mjWrites.length, 0)
})

test("pregenerateRecCardForJob: un-renderable job (no company/title) → skipped_unrenderable", async () => {
  const { db, mjWrites } = makeFakeDb()
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "job-1",
    job: { companyName: null, jobTitle: null, roleTitle: null },
    company: null,
    creds: CREDS,
  })
  assert.equal(res.status, "skipped_unrenderable")
  assert.equal(mjWrites.length, 0)
})

test("pregenerateRecCardForJob: render throws → gen_failed, never throws (fail-open)", async () => {
  const { db, mjWrites } = makeFakeDb()
  const res = await pregenerateRecCardForJob({
    db,
    jobId: "job-1",
    job: COLLAB_JOB,
    company: null,
    creds: CREDS,
    renderPng: async () => {
      throw new Error("satori boom")
    },
    fetchLogoDataUri: async () => null,
  })
  assert.equal(res.status, "gen_failed")
  assert.equal(mjWrites.length, 0)
})

test("pregenerateRecCardForJob: persist write throws → persist_failed, never throws", async () => {
  const throwingDb = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: false, data: () => undefined }
            },
            async set() {
              throw new Error("firestore_down")
            },
          }
        },
      }
    },
  } as never
  const res = await pregenerateRecCardForJob({
    db: throwingDb,
    jobId: "job-1",
    job: COLLAB_JOB,
    company: null,
    creds: CREDS,
    renderPng: async () => Buffer.from("PNGDATA"),
    fetchLogoDataUri: async () => null,
    uploadMedia: async (_png, filename) => `https://storage.googleapis.com/inbound-file-store/FAKE_${filename}`,
  })
  // The card WAS generated; only the writeback failed. Status reports it, no throw.
  assert.equal(res.status, "persist_failed")
  assert.ok(res.status === "persist_failed" && /\.png$/.test(res.mediaUrl))
})
