/**
 * send-rec-card.test.ts — proves the render→host→send orchestration is
 * flag-gated and FAIL-OPEN: render/upload errors never throw and never enqueue
 * a row (so the caller's text rec is the only delivery), while the happy path
 * enqueues exactly one runtime-approved media outbound row carrying media_url.
 */
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  maybeBuildRecCard,
  buildRecCardCaption,
  isJobRecCardEnabled,
  JOB_REC_CARD_ENV_FLAG,
} from "../job-rec-card.js"
import { maybeSendRecCard } from "../send-rec-card.js"
import { cardStoragePath, firebaseDownloadUrl } from "../upload-card.js"
import type { CardStorage } from "../upload-card.js"

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

function makeFakeDb() {
  const created: Array<Record<string, unknown>> = []
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: false, data: () => undefined }
            },
            async create(doc: Record<string, unknown>) {
              created.push(doc)
            },
          }
        },
      }
    },
  }
  return { db: db as never, created }
}

const PAYLOAD_JOB = {
  companyName: "Invoko",
  jobTitle: "Senior Product Designer",
  atsApplyUrl: "https://jobs.invoko.com/apply/123",
  reason: "your Figma experience lines up",
}

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

// ── upload helpers ───────────────────────────────────────────────────────────

test("cardStoragePath is stable + rec-scoped", () => {
  const p1 = cardStoragePath("u1", "job-1")
  const p2 = cardStoragePath("u1", "job-1")
  assert.equal(p1, p2)
  assert.match(p1, /^rec-cards\/[0-9a-f]{16}\/[0-9a-f]{16}\.png$/)
  assert.notEqual(cardStoragePath("u1", "job-2"), p1)
})

test("firebaseDownloadUrl shape", () => {
  const url = firebaseDownloadUrl("b.appspot.com", "rec-cards/a/b.png", "tok")
  assert.match(url, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/b\.appspot\.com\/o\//)
  assert.match(url, /alt=media&token=tok$/)
  assert.match(url, /rec-cards%2Fa%2Fb\.png/)
})

// ── maybeBuildRecCard: flag gate + happy path + fail-open ─────────────────────

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

test("maybeBuildRecCard: happy path → mediaUrl + caption + upload", async () => {
  const { storage, saved } = makeFakeStorage()
  const { db } = makeFakeDb()
  const fakePng = Buffer.from("PNGDATA")
  const out = await maybeBuildRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      renderPng: async () => fakePng,
      loadCompany: async () => null,
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
    },
  })
  assert.ok(out)
  assert.match(out!.mediaUrl, /^https:\/\/firebasestorage\.googleapis\.com\//)
  assert.match(out!.caption, /Invoko/)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.bytes, fakePng.length)
  // download token is set so the URL works without ACL changes.
  const tokens = (saved[0]!.metadata?.metadata as Record<string, unknown>)?.firebaseStorageDownloadTokens
  assert.ok(typeof tokens === "string" && (tokens as string).length > 0)
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
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
    },
  })
  assert.equal(out, null)
  assert.equal(saved.length, 0)
})

test("maybeBuildRecCard: un-renderable payload (no title) → null", async () => {
  const { storage } = makeFakeStorage()
  const { db } = makeFakeDb()
  const out = await maybeBuildRecCard({
    userId: "u1",
    jobId: "job-1",
    job: { companyName: "Co" }, // no title → builder returns null
    deps: { db, storage, renderPng: async () => Buffer.from("x"), env: { [JOB_REC_CARD_ENV_FLAG]: "1" } },
  })
  assert.equal(out, null)
})

// ── maybeSendRecCard: enqueues one media row; fail-open paths ─────────────────

test("maybeSendRecCard: flag off → not sent, nothing enqueued", async () => {
  const { storage } = makeFakeStorage()
  const { db, created } = makeFakeDb()
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "0" },
    },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "flag_off")
  assert.equal(created.length, 0)
})

test("maybeSendRecCard: no phone → not sent (text rec still covers the user)", async () => {
  const { storage } = makeFakeStorage()
  const { db, created } = makeFakeDb()
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      getPhoneE164: async () => null,
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
    },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "no_phone")
  assert.equal(created.length, 0)
})

test("maybeSendRecCard: happy path → enqueues ONE runtime-approved media row with media_url", async () => {
  const { storage } = makeFakeStorage()
  const { db, created } = makeFakeDb()
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
      todayYmd: () => "20260530",
      cardDeps: { renderPng: async () => Buffer.from("PNG"), loadCompany: async () => null },
    },
  })
  assert.equal(res.sent, true)
  assert.ok(res.mediaUrl)
  assert.equal(created.length, 1)
  const row = created[0]!
  assert.equal(row.userId, "u1")
  assert.equal(row.toE164, "+15551234567")
  assert.equal(row.mediaUrl, res.mediaUrl)
  assert.match(String(row.body), /Invoko/) // caption
  assert.equal(row.runtimeApproved, true)
  assert.equal(row.runtimeSource, "pa_orchestrator")
  assert.equal(row.idempotencyKey, "rec-card-u1-job-1-20260530")
  assert.equal(row.status, "pending")
})

test("maybeSendRecCard: render failure → not sent, no row enqueued (fail-open)", async () => {
  const { storage } = makeFakeStorage()
  const { db, created } = makeFakeDb()
  const res = await maybeSendRecCard({
    userId: "u1",
    jobId: "job-1",
    job: PAYLOAD_JOB,
    deps: {
      db,
      storage,
      getPhoneE164: async () => "+15551234567",
      env: { [JOB_REC_CARD_ENV_FLAG]: "1" },
      cardDeps: {
        renderPng: async () => {
          throw new Error("boom")
        },
        loadCompany: async () => null,
      },
    },
  })
  assert.equal(res.sent, false)
  assert.equal(res.reason, "card_unavailable")
  assert.equal(created.length, 0)
})
