/**
 * Tests for the QR scan reservation lifecycle + canary-campaign gate + redirect
 * URL shape + abandoned-scan sweep.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  normalizeCampaignCode,
  isCanaryCampaign,
  writeQrScanPending,
  readQrScanPending,
  claimQrScanPending,
  resolveQrOpenerProvision,
  sweepAbandonedQrScans,
  QR_SCAN_ABANDON_TTL_MS,
} from "./scan.js"
import {
  buildSmsDeepLink,
  buildQrStartRedirectLocation,
} from "./qr-start-redirect.js"

// ─── in-memory Firestore with where().limit().get() ────────────────────────────

type DocData = Record<string, unknown>
type Store = Map<string, Map<string, DocData>>

type Filter = { field: string; op: string; value: unknown }

class FakeQuery {
  constructor(
    private readonly coll: Map<string, DocData>,
    private readonly filters: Filter[] = [],
    private readonly cap = Infinity,
  ) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.coll, [...this.filters, { field, op, value }], this.cap)
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.coll, this.filters, n)
  }
  async get() {
    const matches = [...this.coll.entries()].filter(([, data]) =>
      this.filters.every(({ field, op, value }) => {
        const v = data[field]
        if (op === "==") return v === value
        if (op === "<") return typeof v === "string" && v < (value as string)
        return true
      }),
    )
    const sliced = matches.slice(0, this.cap)
    return {
      docs: sliced.map(([id, data]) => ({
        id,
        data: () => data,
        ref: {
          set: async (patch: DocData, opts?: { merge?: boolean }) => {
            const prev = this.coll.get(id) ?? {}
            this.coll.set(id, opts?.merge ? { ...prev, ...patch } : patch)
          },
        },
      })),
    }
  }
}

class FakeFirestore {
  readonly store: Store = new Map()
  collection(path: string) {
    const coll = this.store.get(path) ?? new Map<string, DocData>()
    this.store.set(path, coll)
    return {
      doc: (id: string) => ({
        async get() {
          const data = coll.get(id)
          return { id, exists: data !== undefined, data: () => data }
        },
        async set(data: DocData, opts?: { merge?: boolean }) {
          const prev = coll.get(id) ?? {}
          coll.set(id, opts?.merge ? { ...prev, ...data } : data)
        },
      }),
      where: (field: string, op: string, value: unknown) =>
        new FakeQuery(coll).where(field, op, value),
    }
  }
}

function fakeDb(): { db: Firestore; raw: FakeFirestore } {
  const raw = new FakeFirestore()
  return { db: raw as unknown as Firestore, raw }
}

// ─── campaign normalization + canary gate ──────────────────────────────────────

describe("normalizeCampaignCode", () => {
  it("lowercases + trims a valid code", () => {
    assert.equal(normalizeCampaignCode("  Dev-Card "), "dev-card")
  })
  it("rejects invalid / empty", () => {
    assert.equal(normalizeCampaignCode(""), null)
    assert.equal(normalizeCampaignCode("has space"), null)
    assert.equal(normalizeCampaignCode("x".repeat(100)), null)
    assert.equal(normalizeCampaignCode(123 as unknown as string), null)
  })
})

describe("isCanaryCampaign", () => {
  it("dev- prefix is canary", () => {
    assert.equal(isCanaryCampaign("dev-card"), true)
    assert.equal(isCanaryCampaign("dev-sf-popup"), true)
  })
  it("explicit allowlisted code is canary", () => {
    assert.equal(isCanaryCampaign("dev-card"), true)
  })
  it("a real (non-canary) campaign is NOT canary", () => {
    assert.equal(isCanaryCampaign("adv_2026_card"), false)
    assert.equal(isCanaryCampaign("sf_career_fair"), false)
  })
  it("missing / invalid is NOT canary", () => {
    assert.equal(isCanaryCampaign(null), false)
    assert.equal(isCanaryCampaign(undefined), false)
    assert.equal(isCanaryCampaign(""), false)
    assert.equal(isCanaryCampaign("unknown"), false)
  })
})

// ─── reservation lifecycle ─────────────────────────────────────────────────────

describe("writeQrScanPending / readQrScanPending / claim", () => {
  it("round-trips a reservation and claims it", async () => {
    const { db } = fakeDb()
    const now = new Date().toISOString()
    await writeQrScanPending(db, {
      scanToken: "tok-1",
      number: "+15550000001",
      groupId: "g1",
      campaign: "dev-card",
      now,
    })
    const scan = await readQrScanPending(db, "tok-1")
    assert.ok(scan)
    assert.equal(scan!.status, "pending")
    assert.equal(scan!.number, "+15550000001")
    assert.equal(scan!.groupId, "g1")
    assert.equal(scan!.campaign, "dev-card")

    await claimQrScanPending(db, "tok-1", "user-abc", now)
    const claimed = await readQrScanPending(db, "tok-1")
    assert.equal(claimed!.status, "claimed")
    assert.equal(claimed!.claimedUserId, "user-abc")
  })

  it("read of an unknown token returns null", async () => {
    const { db } = fakeDb()
    assert.equal(await readQrScanPending(db, "nope"), null)
  })
})

// ─── the provisioning gate (doc §4) ────────────────────────────────────────────

describe("resolveQrOpenerProvision (the canary gate)", () => {
  async function seedScan(db: Firestore, token: string, campaign: string) {
    await writeQrScanPending(db, {
      scanToken: token,
      number: "+15550000001",
      groupId: "g1",
      campaign,
      now: new Date().toISOString(),
    })
  }

  it("QR opener for a CANARY campaign → provision allowed", async () => {
    const { db } = fakeDb()
    await seedScan(db, "11111111-2222-3333-4444-555555555555", "dev-card")
    const out = await resolveQrOpenerProvision(
      db,
      "Hello, WeKruit! 11111111-2222-3333-4444-555555555555",
    )
    assert.equal(out.shouldProvision, true)
    assert.equal(out.scan?.campaign, "dev-card")
  })

  it("QR opener for a NON-canary campaign → NOT provisioned (scan still observable)", async () => {
    const { db } = fakeDb()
    await seedScan(db, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "adv_2026_card")
    const out = await resolveQrOpenerProvision(
      db,
      "Hello, WeKruit! aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    )
    assert.equal(out.shouldProvision, false)
    assert.equal(out.scan?.campaign, "adv_2026_card")
  })

  it("opener with an UNKNOWN token (no scan doc) → NOT provisioned (anti-spam)", async () => {
    const { db } = fakeDb()
    const out = await resolveQrOpenerProvision(
      db,
      "Hello, WeKruit! 99999999-8888-7777-6666-555555555555",
    )
    assert.equal(out.shouldProvision, false)
    assert.equal(out.scan, null)
  })

  it("generic sendblue text (not an opener) → NOT provisioned", async () => {
    const { db } = fakeDb()
    for (const text of ["hi", "stop", "what's this?", ""]) {
      const out = await resolveQrOpenerProvision(db, text)
      assert.equal(out.shouldProvision, false, `text=${JSON.stringify(text)}`)
    }
  })
})

// ─── sms: deep link shape ──────────────────────────────────────────────────────

describe("redirect URL shape", () => {
  it("buildSmsDeepLink url-encodes the body", () => {
    const link = buildSmsDeepLink("+15550000001", "Hello, WeKruit! tok 123")
    assert.match(link, /^sms:\+15550000001\?&body=/)
    assert.ok(link.includes("Hello%2C%20WeKruit!%20tok%20123"))
  })

  it("buildQrStartRedirectLocation embeds the Hello opener with the scanToken", () => {
    const loc = buildQrStartRedirectLocation("+15550000001", "tok-xyz")
    assert.ok(loc.startsWith("sms:+15550000001?&body="))
    assert.ok(decodeURIComponent(loc.split("body=")[1]!) === "Hello, WeKruit! tok-xyz")
  })
})

// ─── abandoned-scan sweep ──────────────────────────────────────────────────────

describe("sweepAbandonedQrScans", () => {
  it("decrements + marks abandoned only for stale PENDING reservations", async () => {
    const { db, raw } = fakeDb()
    const now = Date.now()
    const stale = new Date(now - QR_SCAN_ABANDON_TTL_MS - 1000).toISOString()
    const fresh = new Date(now - 1000).toISOString()
    const coll = new Map<string, DocData>([
      ["old-pending", { groupId: "g1", status: "pending", createdAt: stale }],
      ["fresh-pending", { groupId: "g1", status: "pending", createdAt: fresh }],
      ["old-claimed", { groupId: "g2", status: "claimed", createdAt: stale }],
    ])
    raw.store.set(PA_COLLECTIONS.qrScanPending, coll)

    const decremented: string[] = []
    const result = await sweepAbandonedQrScans(
      db,
      async (groupId) => {
        decremented.push(groupId)
      },
      now,
    )

    assert.equal(result.scanned, 1, "only the stale pending row matches")
    assert.equal(result.decremented, 1)
    assert.deepEqual(decremented, ["g1"])
    assert.equal(coll.get("old-pending")?.status, "abandoned")
    assert.equal(coll.get("fresh-pending")?.status, "pending")
    assert.equal(coll.get("old-claimed")?.status, "claimed")
  })
})
