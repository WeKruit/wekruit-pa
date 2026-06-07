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
import {
  maybeSendRecCard,
  resolveRecCardMediaUrl,
  persistRecCardMediaUrl,
} from "../send-rec-card.js"
import {
  cardStoragePath,
  firebaseDownloadUrl,
  isSendblueAcceptableMediaUrl,
} from "../upload-card.js"
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
// A POISONED legacy Firebase token URL: HTTP-200-live but signed + no .png terminator → Sendblue drops it.
const FIREBASE_TOKEN_URL =
  "https://firebasestorage.googleapis.com/v0/b/wekruit-5f89b.appspot.com/o/rec-cards%2Fabc%2Fdef.png?alt=media&token=deadbeef"
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

test("buildRecCardCaption: includes the role title @ company + apply link", () => {
  const cap = buildRecCardCaption({
    company: "Invoko",
    title: "Senior Product Designer",
    applyUrl: "https://jobs.invoko.com/apply/123",
  })
  assert.match(cap, /Senior Product Designer @ Invoko/) // title present (was company-only)
  assert.match(cap, /https:\/\/jobs\.invoko\.com\/apply\/123/)
})

test("buildRecCardCaption lean mode: headline + role-specific prescreen CTA, NO external url, no full pitch", () => {
  const cap = buildRecCardCaption(
    {
      company: "Invoko",
      title: "Senior Product Designer",
      applyUrl: "https://jobs.invoko.com/apply/123",
      inNetwork: true,
    },
    "lean",
  )
  assert.match(cap, /Senior Product Designer @ Invoko/) // headline present
  assert.match(cap, /reply "Senior Product Designer @ Invoko" to fast-track/) // co-located, role-specific CTA
  assert.doesNotMatch(cap, /https?:\/\//) // NO external apply url (collab roles funnel through prescreen)
  assert.doesNotMatch(cap, /jumps out|we talk to their team|partner role/i) // not the full pitch paragraph
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
      // Lazy-gen seam present but MUST NOT run on a (LIVE) cache hit.
      sendblueCreds: CREDS,
      checkMediaUrlLive: async () => true, // cached url is alive → pure cache hit
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

test("maybeSendRecCard: STALE cache (HEAD non-200) + creds → regenerates fresh, sends", async () => {
  // The 'delivered but no picture' bug: a cached Sendblue-CDN url that 404'd. The liveness HEAD treats
  // it as a MISS so lazy-gen re-uploads a fresh url instead of silently shipping a dead one.
  const { db } = makeFakeDb({ cachedMediaUrl: "https://storage.googleapis.com/inbound-file-store/STALE.png" })
  let regenerated = false
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
      checkMediaUrlLive: async () => false, // stale → 404
      lazyGenerate: async () => {
        regenerated = true
        return "https://storage.googleapis.com/inbound-file-store/FRESH.png"
      },
    },
  })
  assert.equal(regenerated, true, "stale cached url must trigger a regenerate")
  assert.equal(res.sent, true)
  assert.match(String(res.mediaUrl), /FRESH\.png$/, "sends the freshly-regenerated url, not the stale one")
})

test("maybeSendRecCard: STALE cache + NO creds → keeps the cached url (can't regen, maybe-dead beats nothing)", async () => {
  const { db } = makeFakeDb({ cachedMediaUrl: SENDBLUE_MEDIA_URL })
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
      // NO sendblueCreds → liveness check is skipped (can't regen anyway)
      checkMediaUrlLive: async () => false,
    },
  })
  assert.equal(res.sent, true)
  assert.equal(res.mediaUrl, SENDBLUE_MEDIA_URL)
})

// ── isSendblueAcceptableMediaUrl: the URL-shape contract guard ────────────────

test("isSendblueAcceptableMediaUrl: accepts a Sendblue-CDN .png url, no query", () => {
  assert.equal(isSendblueAcceptableMediaUrl(SENDBLUE_MEDIA_URL), true)
})

test("isSendblueAcceptableMediaUrl: rejects a legacy Firebase token url (the dropped-image shape)", () => {
  assert.equal(isSendblueAcceptableMediaUrl(FIREBASE_TOKEN_URL), false)
})

test("isSendblueAcceptableMediaUrl: rejects signed/query, non-.png, http, empty, null", () => {
  // signed query even on a googleapis host → dropped
  assert.equal(
    isSendblueAcceptableMediaUrl("https://storage.googleapis.com/inbound-file-store/x.png?token=z"),
    false,
  )
  // not extension-terminated
  assert.equal(isSendblueAcceptableMediaUrl("https://storage.googleapis.com/inbound-file-store/x"), false)
  // wrong extension
  assert.equal(isSendblueAcceptableMediaUrl("https://storage.googleapis.com/inbound-file-store/x.jpg"), false)
  // not https
  assert.equal(isSendblueAcceptableMediaUrl("http://storage.googleapis.com/inbound-file-store/x.png"), false)
  // fragment counts as a query-ish suffix
  assert.equal(isSendblueAcceptableMediaUrl("https://storage.googleapis.com/inbound-file-store/x.png#frag"), false)
  assert.equal(isSendblueAcceptableMediaUrl(""), false)
  assert.equal(isSendblueAcceptableMediaUrl(null), false)
  assert.equal(isSendblueAcceptableMediaUrl(undefined), false)
})

test("maybeSendRecCard: POISONED Firebase cache + creds → re-uploads fresh Sendblue url (no HEAD needed)", async () => {
  // THE RESIDUAL BUG ('i don't see image coming for the match still'): a cached Firebase token url is
  // HTTP-200-live, so the HEAD liveness check would PASS it through → Sendblue drops it forever. The
  // shape guard treats it as a cache MISS (deterministically, no network) so lazy-gen re-hosts on Sendblue.
  const { db, created } = makeFakeDb({ cachedMediaUrl: FIREBASE_TOKEN_URL })
  let headChecked = false
  let regenerated = false
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
      // The poisoned Firebase url is live (200) — prove the fix does NOT rely on a HEAD failure.
      checkMediaUrlLive: async () => {
        headChecked = true
        return true
      },
      lazyGenerate: async () => {
        regenerated = true
        return SENDBLUE_MEDIA_URL
      },
    },
  })
  assert.equal(regenerated, true, "wrong-shaped cache must trigger a re-upload, not ship the dropped url")
  assert.equal(headChecked, false, "shape guard short-circuits BEFORE the HEAD liveness check")
  assert.equal(res.sent, true)
  assert.equal(res.mediaUrl, SENDBLUE_MEDIA_URL)
  assert.equal(created.length, 1)
  assert.match(String(created[0]!.mediaUrl), /\.png$/)
  assert.ok(!/firebasestorage/.test(String(created[0]!.mediaUrl)), "never enqueues a Firebase url")
})

test("maybeSendRecCard: POISONED Firebase cache + NO creds → keeps url (can't re-host; fail-open)", async () => {
  // No creds → we can't re-upload, so we don't force an unfillable miss. The text rec still covers
  // the user; the image may drop, but that's strictly no worse than today (and prod passes creds).
  const { db, created } = makeFakeDb({ cachedMediaUrl: FIREBASE_TOKEN_URL })
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
      // no sendblueCreds
    },
  })
  assert.equal(res.sent, true)
  assert.equal(res.mediaUrl, FIREBASE_TOKEN_URL)
  assert.equal(created.length, 1)
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
  // The shared resolveRecCardMediaUrl swallows a lazy-gen throw and returns null (resolve never throws),
  // so maybeSendRecCard sees a cache MISS → "card_unavailable". Still fail-open: not sent, no row.
  assert.equal(res.reason, "card_unavailable")
  assert.equal(created.length, 0)
})

// ── resolveRecCardMediaUrl: pure URL resolution, NO enqueue ───────────────────

test("resolveRecCardMediaUrl: CACHE HIT (live) → returns the url, enqueues NOTHING", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: SENDBLUE_MEDIA_URL })
  const url = await resolveRecCardMediaUrl(db, {
    jobId: "job-1",
    job: PAYLOAD_JOB,
    sendblueCreds: CREDS,
    checkMediaUrlLive: async () => true,
    lazyGenerate: async () => "should-not-be-used",
  })
  assert.equal(url, SENDBLUE_MEDIA_URL)
  assert.equal(created.length, 0, "resolve NEVER enqueues — the caller attaches the url inline")
})

test("resolveRecCardMediaUrl: CACHE MISS + creds → lazy-gens the url (no enqueue)", async () => {
  const { db, created } = makeFakeDb({ cachedMediaUrl: undefined })
  const url = await resolveRecCardMediaUrl(db, {
    jobId: "job-1",
    job: PAYLOAD_JOB,
    sendblueCreds: CREDS,
    lazyGenerate: async () => SENDBLUE_MEDIA_URL,
  })
  assert.equal(url, SENDBLUE_MEDIA_URL)
  assert.equal(created.length, 0)
})

test("resolveRecCardMediaUrl: CACHE MISS + NO creds → null (cache-read only, fail-open)", async () => {
  const { db } = makeFakeDb({ cachedMediaUrl: undefined })
  const url = await resolveRecCardMediaUrl(db, { jobId: "job-1", job: PAYLOAD_JOB })
  assert.equal(url, null)
})

test("resolveRecCardMediaUrl: lazy-gen throws → null, never throws (RC2 fail-open)", async () => {
  const { db } = makeFakeDb({ cachedMediaUrl: undefined })
  const url = await resolveRecCardMediaUrl(db, {
    jobId: "job-1",
    job: PAYLOAD_JOB,
    sendblueCreds: CREDS,
    lazyGenerate: async () => {
      throw new Error("boom")
    },
  })
  assert.equal(url, null)
})

// ── persistRecCardMediaUrl: the writeback fix (cache the url on matching-jobs) ─

test("persistRecCardMediaUrl: writes recCardMediaUrl + hash to matching-jobs (merge) → next read is a cache hit", async () => {
  const { db, mjWrites } = makeFakeDb({ cachedMediaUrl: undefined })
  const ok = await persistRecCardMediaUrl(db, "job-1", {
    mediaUrl: SENDBLUE_MEDIA_URL,
    contentHash: "deadbeefcafef00d",
  })
  assert.equal(ok, true, "writeback persisted")
  assert.equal(mjWrites.length, 1, "exactly one matching-jobs write")
  const w = mjWrites[0]!
  assert.equal(w.recCardMediaUrl, SENDBLUE_MEDIA_URL, "recCardMediaUrl persisted (the field the read uses)")
  assert.equal(w.recCardContentHash, "deadbeefcafef00d", "content hash persisted")
  assert.equal(typeof w.recCardGeneratedAt, "string", "generated-at stamp present")
})

test("persistRecCardMediaUrl: write failure → false, never throws (fail-open)", async () => {
  const throwingDb = {
    collection() {
      return {
        doc() {
          return {
            async set() {
              throw new Error("firestore_down")
            },
          }
        },
      }
    },
  } as never
  const events: string[] = []
  const ok = await persistRecCardMediaUrl(
    throwingDb,
    "job-1",
    { mediaUrl: SENDBLUE_MEDIA_URL, contentHash: "x" },
    (e) => events.push(e),
  )
  assert.equal(ok, false)
  assert.ok(events.includes("rec_card.lazy_gen_persist_failed"), "failure logged, not thrown")
})
