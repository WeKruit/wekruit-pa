/**
 * send-rec-card.test.ts — proves the CACHED-IMAGE rec-card send model:
 *   - flag-gated + fail-open (no phone / no cached card / error → no enqueue),
 *   - the happy path READS matching-jobs.recCardMediaUrl (no render/upload) and
 *     enqueues exactly one runtime-approved media row whose `mediaUrl` ends in
 *     .png and carries NO ?token= signed query (the Sendblue contract),
 *   - the lazy-gen fallback generates + persists + sends when the cache is empty,
 *   - the per-candidate caption is the only candidate-specific part.
 *
 * Plus the legacy `maybeBuildRecCard` build path (Firebase host) still fail-open.
 */
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  maybeBuildRecCard,
  buildRecCardCaption,
  isJobRecCardEnabled,
  recCardContentHash,
  recCardFilename,
  JOB_REC_CARD_ENV_FLAG,
} from "../job-rec-card.js"
import { maybeSendRecCard } from "../send-rec-card.js"
import { cardStoragePath, firebaseDownloadUrl } from "../upload-card.js"
import type { CardStorage } from "../upload-card.js"
import { buildRecCardPayload } from "../card-payload.js"

// ── Fakes ───────────────────────────────────────────────────────────────────

function makeFakeStorage() {
  const saved: Array<{ path: string; bytes: number; metadata?: Record<string, unknown> }> = []
  const storage: CardStorage = {
    bucket() {
      return {
        name: "wekruit-5f89b.appspot.com",
        file(path: string) {
          return {
            async save(data: Buffer, opts) {
              saved.push({ path, bytes: data.length, metadata: opts.metadata })
            },
            async getMetadata() {
              return [{ metadata: {} }]
            },
          }
        },
      }
    },
  }
  return { storage, saved }
}

/** Fake db: a matching-jobs point-read + an outbound create capture. */
function makeFakeDb(opts?: { cachedMediaUrl?: string }) {
  const created: Array<Record<string, unknown>> = []
  const mjWrites: Array<Record<string, unknown>> = []
  const db = {
    collection(name: string) {
      return {
        doc() {
          return {
            async get() {
              if (name === "matching-jobs") {
                return {
                  exists: Boolean(opts?.cachedMediaUrl),
                  data: () => (opts?.cachedMediaUrl ? { recCardMediaUrl: opts.cachedMediaUrl } : undefined),
                }
              }
              return { exists: false, data: () => undefined }
            },
            async create(doc: Record<string, unknown>) {
              created.push(doc)
            },
            async set(doc: Record<string, unknown>) {
              if (name === "matching-jobs") mjWrites.push(doc)
            },
          }
        },
      }
    },
  }
  return { db: db as never, created, mjWrites }
}

const PAYLOAD_JOB = {
  companyName: "Invoko",
  jobTitle: "Senior Product Designer",
  atsApplyUrl: "https://jobs.invoko.com/apply/123",
  reason: "your Figma experience lines up",
}

// A Sendblue-hosted media URL: ends in .png, no signed query (the contract).
const SENDBLUE_MEDIA_URL = "https://storage.googleapis.com/inbound-file-store/aBcd1234_wk-rec-job-1.png"
const CREDS = { apiKeyId: "k", apiSecretKey: "s" }

let savedFlag: string | undefined
beforeEach(() => {
  savedFlag = process.env[JOB_REC_CARD_ENV_FLAG]
})
afterEach(() => {
  if (savedFlag === undefined) delete process.env[JOB_REC_CARD_ENV_FLAG]
  else process.env[JOB_REC_CARD_ENV_FLAG] = savedFlag
})

// ── isJobRecCardEnabled ──────────────────────────────────────────────────────

test("isJobRecCardEnabled: only 1/true/on enable", () => {
  assert.equal(isJobRecCardEnabled({ [JOB_REC_CARD_ENV_FLAG]: "1" }), true)
  assert.equal(isJobRecCardEnabled({ [JOB_REC_CARD_ENV_FLAG]: "true" }), true)
  assert.equal(isJobRecCardEnabled({ [JOB_REC_CARD_ENV_FLAG]: "on" }), true)
  assert.equal(isJobRecCardEnabled({ [JOB_REC_CARD_ENV_FLAG]: "0" }), false)
  assert.equal(isJobRecCardEnabled({}), false)
})

// ── buildRecCardCaption ──────────────────────────────────────────────────────

test("buildRecCardCaption: Claire voice + apply link", () => {
  const cap = buildRecCardCaption({
    company: "Invoko",
    title: "Senior Product Designer",
    applyUrl: "https://jobs.invoko.com/apply/123",
  })
  assert.match(cap, /one role worth your time: Invoko\./)
  assert.match(cap, /lmk if it's interesting/)
  assert.match(cap, /https:\/\/jobs\.invoko\.com\/apply\/123/)
})

// ── content hash + filename ──────────────────────────────────────────────────

test("recCardContentHash: stable for job-level content, ignores per-candidate reasons", () => {
  const base = { job: PAYLOAD_JOB, company: { companyStage: "seed" as const } }
  const h1 = recCardContentHash(buildRecCardPayload({ ...base, reasons: { whyFits: ["a"] } })!)
  const h2 = recCardContentHash(buildRecCardPayload({ ...base, reasons: { whyFits: ["b", "c"] } })!)
  assert.equal(h1, h2, "per-candidate reasons must NOT change the cached-image hash")
  const h3 = recCardContentHash(buildRecCardPayload({ job: { ...PAYLOAD_JOB, jobTitle: "Different" } })!)
  assert.notEqual(h1, h3, "a job-level title change MUST change the hash")
})

test("recCardFilename: sanitized, .png-terminated (Sendblue contract)", () => {
  assert.match(recCardFilename("hs-11005382/invoko"), /^wk-rec-[a-zA-Z0-9._-]+\.png$/)
  assert.ok(recCardFilename("x").endsWith(".png"))
})

// ── upload helpers (legacy Firebase host retained for tests) ──────────────────

test("cardStoragePath is stable + rec-scoped", () => {
  const p1 = cardStoragePath("u1", "job-1")
  const p2 = cardStoragePath("u1", "job-1")
  assert.equal(p1, p2)
  assert.match(p1, /^rec-cards\/[0-9a-f]{16}\/[0-9a-f]{16}\.png$/)
  assert.notEqual(cardStoragePath("u1", "job-2"), p1)
})

test("firebaseDownloadUrl shape (legacy)", () => {
  const url = firebaseDownloadUrl("b.appspot.com", "rec-cards/a/b.png", "tok")
  assert.match(url, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/b\.appspot\.com\/o\//)
  assert.match(url, /alt=media&token=tok$/)
})

// ── maybeBuildRecCard (legacy build path): flag gate + fail-open ──────────────

test("maybeBuildRecCard: returns null when flag off (no render attempted)", async () => {
  const { storage } = makeFakeStorage()
  const { db } = makeFakeDb()
  let rendered = false
  const out = await maybeBuildRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      renderPng: async () => {
        rendered = true
        return Buffer.from("x")
      },
      env: { [JOB_REC_CARD_ENV_FLAG]: "0" },
    },
  })
  assert.equal(out, null)
  assert.equal(rendered, false)
})

test("maybeBuildRecCard: happy path → mediaUrl + caption + upload + logo prefetch", async () => {
  const { storage, saved } = makeFakeStorage()
  const { db } = makeFakeDb()
  const fakePng = Buffer.from("PNGDATA")
  let logoFetched = false
  const out = await maybeBuildRecCard({
    userId: "u1",
    jobId: "job-1",
    job: { ...PAYLOAD_JOB, companyName: "metavoice.io" }, // domain-shaped → favicon logoUrl
    deps: {
      db,
      storage,
      renderPng: async () => fakePng,
      loadCompany: async () => null,
      fetchLogoDataUri: async () => {
        logoFetched = true
        return "data:image/png;base64,AAAA"
      },
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
    },
  })
  assert.ok(out)
  assert.match(out!.mediaUrl, /^https:\/\/firebasestorage\.googleapis\.com\//)
  assert.equal(logoFetched, true, "logo should be pre-fetched into a data URI")
  assert.equal(out!.payload.logoDataUri, "data:image/png;base64,AAAA")
  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.bytes, fakePng.length)
})

test("maybeBuildRecCard: FAIL-OPEN — render throws → null (no upload, no throw)", async () => {
  const { storage, saved } = makeFakeStorage()
  const { db } = makeFakeDb()
  const out = await maybeBuildRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      renderPng: async () => {
        throw new Error("satori boom")
      },
      loadCompany: async () => null,
      fetchLogoDataUri: async () => null,
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
    },
  })
  assert.equal(out, null)
  assert.equal(saved.length, 0)
})

test("maybeBuildRecCard: logo fetch failure → still renders (monogram fail-open)", async () => {
  const { storage, saved } = makeFakeStorage()
  const { db } = makeFakeDb()
  const out = await maybeBuildRecCard({
    userId: "u1",
    jobId: "job-1",
    job: { ...PAYLOAD_JOB, companyName: "metavoice.io" },
    deps: {
      db,
      storage,
      renderPng: async () => Buffer.from("PNG"),
      loadCompany: async () => null,
      fetchLogoDataUri: async () => null, // fetch failed → no data URI
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
    },
  })
  assert.ok(out, "card still built without a logo")
  assert.equal(out!.payload.logoDataUri, undefined)
  assert.equal(saved.length, 1)
})

// ── maybeSendRecCard: CACHED-READ happy path + lazy-gen + fail-open ───────────

test("maybeSendRecCard: flag off → not sent, nothing enqueued", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: SENDBLUE_MEDIA_URL })
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: { db, getPhoneE164: async () => "+15551234567", env: { [JOB_REC_CARD_ENV_FLAG]: "0" } },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "flag_off")
  assert.equal(created.length, 0)
})

test("maybeSendRecCard: no phone → not sent (text rec still covers the user)", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: SENDBLUE_MEDIA_URL })
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: { db, getPhoneE164: async () => null, env: { [JOB_REC_CARD_ENV_FLAG]: "1" } },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "no_phone")
  assert.equal(created.length, 0)
})

test("maybeSendRecCard: CACHE HIT → enqueues ONE row; media_url ends in .png, no ?token=", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: SENDBLUE_MEDIA_URL })
  let rendered = false
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
      todayYmd: () => "20260531",
      loadCompany: async () => null,
      // Lazy-gen seam present but MUST NOT run on a cache hit.
      sendblueCreds: CREDS,
      lazyGenerate: async () => {
        rendered = true
        return "should-not-be-used"
      },
    },
  })
  assert.equal(res.sent, true)
  assert.equal(rendered, false, "no render/upload on a cache hit")
  assert.equal(res.mediaUrl, SENDBLUE_MEDIA_URL)
  assert.equal(created.length, 1)
  const row = created[0]!
  // THE DELIVERY-FIX ASSERTIONS: the media_url Sendblue receives must end in
  // .png and carry NO signed query.
  assert.match(String(row.mediaUrl), /\.png$/, "media_url must end in .png")
  assert.ok(!/[?&]token=/.test(String(row.mediaUrl)), "media_url must not be a signed/token URL")
  assert.ok(!String(row.mediaUrl).includes("?"), "media_url must have no query string")
  assert.equal(row.userId, "u1")
  assert.equal(row.toE164, "+15551234567")
  assert.match(String(row.body), /Invoko/) // per-candidate caption
  assert.equal(row.runtimeApproved, true)
  assert.equal(row.runtimeSource, "pa_orchestrator")
  assert.equal(row.idempotencyKey, "rec-card-u1-job-1-20260531")
})

test("maybeSendRecCard: CACHE MISS + creds → lazy-generates, persists, sends", async () => {
  const { db, created, mjWrites } = makeFakeDb({ cachedMediaUrl: undefined })
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
      todayYmd: () => "20260531",
      loadCompany: async () => null,
      sendblueCreds: CREDS,
      lazyGenerate: async () => SENDBLUE_MEDIA_URL,
    },
  })
  assert.equal(res.sent, true)
  assert.equal(res.mediaUrl, SENDBLUE_MEDIA_URL)
  assert.equal(created.length, 1)
  assert.match(String(created[0]!.mediaUrl), /\.png$/)
})

test("maybeSendRecCard: CACHE MISS + NO creds → not sent (no lazy gen, fail-open to text)", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: undefined })
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
      // no sendblueCreds → no lazy gen
    },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "card_unavailable")
  assert.equal(created.length, 0)
})

test("maybeSendRecCard: lazy-gen throws → fail-open, not sent, no row", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: undefined })
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
      sendblueCreds: CREDS,
      lazyGenerate: async () => {
        throw new Error("boom")
      },
    },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "error")
  assert.equal(created.length, 0)
})
