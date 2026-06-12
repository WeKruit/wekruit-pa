/**
 * enrichment-hold-notice.test.ts — ENTRY-UX PRD §2.3.6 once-only enrichment hold.
 *
 * The deterministic "still pulling in your background" line must send EXACTLY ONCE per
 * enrichment window: shouldSendEnrichmentHoldNotice is the pure window predicate;
 * claimEnrichmentHoldNotice is the read→check→stamp claim the cutover uses.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/enrichment-hold-notice.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  shouldSendEnrichmentHoldNotice,
  claimEnrichmentHoldNotice,
  ENRICHMENT_HOLD_NOTICE_COPY,
  ENRICHMENT_INFLIGHT_TTL_MS,
} from "./enrichment-inflight.js"

const NOW = Date.parse("2026-06-12T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

test("no marker → no hold notice", () => {
  assert.equal(shouldSendEnrichmentHoldNotice({}, NOW), false)
  assert.equal(shouldSendEnrichmentHoldNotice(null, NOW), false)
})

test("in-flight + never noticed → send", () => {
  const user = { enrichmentInFlight: true, enrichmentStartedAt: iso(NOW - 10_000) }
  assert.equal(shouldSendEnrichmentHoldNotice(user, NOW), true)
})

test("in-flight + notice already sent THIS window → suppress (once-only)", () => {
  const user = {
    enrichmentInFlight: true,
    enrichmentStartedAt: iso(NOW - 60_000),
    enrichmentHoldNoticeAt: iso(NOW - 30_000), // after startedAt → this window
  }
  assert.equal(shouldSendEnrichmentHoldNotice(user, NOW), false)
})

test("a NEW enrichment window (fresh startedAt) re-arms the notice", () => {
  const user = {
    enrichmentInFlight: true,
    enrichmentStartedAt: iso(NOW - 5_000), // fresh window
    enrichmentHoldNoticeAt: iso(NOW - 60 * 60 * 1000), // stamp from an OLD window
  }
  assert.equal(shouldSendEnrichmentHoldNotice(user, NOW), true)
})

test("expired marker (past TTL) → no notice (the in-flight predicate self-heals)", () => {
  const user = {
    enrichmentInFlight: true,
    enrichmentStartedAt: iso(NOW - ENRICHMENT_INFLIGHT_TTL_MS - 1_000),
  }
  assert.equal(shouldSendEnrichmentHoldNotice(user, NOW), false)
})

test("malformed startedAt with an existing notice stamp → suppress (never spam on bad data)", () => {
  const user = {
    enrichmentInFlight: true,
    enrichmentStartedAt: "not-a-date",
    enrichmentHoldNoticeAt: iso(NOW - 1_000),
  }
  assert.equal(shouldSendEnrichmentHoldNotice(user, NOW), false)
})

// ── claimEnrichmentHoldNotice (read→check→stamp) ────────────────────────────────────────────────

function makeUsersDb(initial: Record<string, unknown>) {
  let data: Record<string, unknown> = { ...initial }
  return {
    data: () => data,
    db: {
      collection(name: string) {
        assert.equal(name, "pa-users")
        return {
          doc() {
            return {
              async get() {
                return { exists: true, data: () => data }
              },
              async set(patch: Record<string, unknown>) {
                data = { ...data, ...patch }
              },
            }
          },
        }
      },
    } as never,
  }
}

test("claim: first claim stamps and returns true; second claim in the same window returns false", async () => {
  const { db, data } = makeUsersDb({
    enrichmentInFlight: true,
    enrichmentStartedAt: new Date(Date.now() - 5_000).toISOString(),
  })
  const first = await claimEnrichmentHoldNotice(db, "u1", new Date().toISOString())
  assert.equal(first, true, "first mid-enrich message claims the notice")
  assert.equal(typeof data().enrichmentHoldNoticeAt, "string", "stamp written")
  const second = await claimEnrichmentHoldNotice(db, "u1", new Date().toISOString())
  assert.equal(second, false, "second mid-enrich message must NOT re-send the hold")
})

test("claim: not in flight → false, no stamp", async () => {
  const { db, data } = makeUsersDb({ enrichmentInFlight: false })
  assert.equal(await claimEnrichmentHoldNotice(db, "u1", new Date().toISOString()), false)
  assert.equal(data().enrichmentHoldNoticeAt, undefined)
})

test("claim: db error → false (fail-closed; the agent directive still answers)", async () => {
  const db = {
    collection() {
      throw new Error("firestore down")
    },
  } as never
  assert.equal(await claimEnrichmentHoldNotice(db, "u1", new Date().toISOString()), false)
})

test("hold copy is one short progress line, no receipt prose", () => {
  assert.ok(ENRICHMENT_HOLD_NOTICE_COPY.length < 160)
  assert.ok(!/signed in|on file/i.test(ENRICHMENT_HOLD_NOTICE_COPY), "PRD §2.1 bans receipt phrasing")
  assert.match(ENRICHMENT_HOLD_NOTICE_COPY, /background/i)
})
