/**
 * Phase 49 (v1.5 / Stream-H / D9) — paReverseMatch tests.
 *
 * 6 tests covering the brief D4 matrix:
 *   1. ranks correctly (rerank order beats cosine, top survivor first)
 *   2. hard-filter drops mismatch (location preference vs synth-job mismatch)
 *   3. opted-in flag surfaced correctly (no implicit gating)
 *   4. topK respected (default + custom + cap-to-pool)
 *   5. admin-only auth (checkAdminToken contract holds — empty/wrong → reject)
 *   6. notify handoff path (enqueueReverseMatchNotify writes a runtime
 *      event, never direct pa-outbound)
 *
 * Tests are pure-function unit tests against the importable cores:
 *   - runReverseMatch (from @pa/job-rec) for tests 1-4
 *   - checkAdminToken (from ./admin-bootstrap) for test 5
 *   - enqueueReverseMatchNotify (from ./paReverseMatch) for test 6
 *
 * The Firebase `onRequest` wrapper is exercised in deploy/curl-smoke,
 * not here — same pattern as admin-bootstrap.test.ts.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  buildMatchedReasons,
  buildNotifyMessage,
  passesReverseHardFilter,
  runReverseMatch,
  synthesizeJobFromJd,
  type ReverseMatchDeps,
  type ReverseMatchUserProfile,
} from "@pa/job-rec"
import type { Firestore } from "firebase-admin/firestore"
import { checkAdminToken } from "../admin-bootstrap.js"
import { enqueueReverseMatchNotify } from "../paReverseMatch.js"

// ---------- helpers ---------------------------------------------------------

function fakeUser(
  userId: string,
  overrides: Partial<ReverseMatchUserProfile> = {},
): ReverseMatchUserProfile {
  return {
    userId,
    displayName: overrides.displayName ?? `User ${userId}`,
    profileIndustry: overrides.profileIndustry ?? "tech",
    hardFilterProfile: overrides.hardFilterProfile ?? {},
    cvEmbedding: overrides.cvEmbedding ?? [1, 0, 0],
    cvText: overrides.cvText ?? `${userId} resume text`,
    topSkills: overrides.topSkills ?? ["Python", "React"],
    recentCompany: overrides.recentCompany ?? "Acme",
    preferredLanguage: overrides.preferredLanguage ?? "zh",
    hasOptedIn: overrides.hasOptedIn ?? true,
  }
}

function makeDeps(args: {
  jdEmbedding: number[] | null
  pool: Array<{ userId: string; profileIndustry: string }>
  signals: Map<string, ReverseMatchUserProfile | null>
  rerank?: ReverseMatchDeps["rerank"]
}): ReverseMatchDeps {
  return {
    db: {} as unknown as Firestore,
    embedJd: async () => args.jdEmbedding,
    loadCandidatePool: async () => args.pool,
    loadUserSignals: async (_db, userId) => args.signals.get(userId) ?? null,
    rerank: args.rerank ?? (async (_q, cands) =>
      cands.map((c) => ({ id: c.id, score: null }))),
  }
}

/** Minimal fake Firestore for the outbound enqueue test. */
function makeFakeDb(): {
  db: Firestore
  collections: Map<string, Map<string, Record<string, unknown>>>
} {
  const collections = new Map<string, Map<string, Record<string, unknown>>>()
  const getColl = (name: string) => {
    let c = collections.get(name)
    if (!c) {
      c = new Map()
      collections.set(name, c)
    }
    return c
  }
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = getColl(name).get(id)
          return {
            exists: data !== undefined,
            data: () => data,
            id,
          }
        },
        set: async (data: Record<string, unknown>) => {
          getColl(name).set(id, data)
        },
      }),
    }),
  }
  return { db: db as unknown as Firestore, collections }
}

function sessionDocId(userId: string, channel: string, externalChatId: string): string {
  const h = createHash("sha256").update(`${userId}|${channel}|${externalChatId}`).digest("hex")
  return `ses_${h.slice(0, 32)}`
}

// ---------- tests ----------------------------------------------------------

describe("paReverseMatch — D4 test 1: ranks correctly", () => {
  it("rerank score order beats cosine; top survivor first", async () => {
    const userA = fakeUser("A", { cvEmbedding: [1, 0, 0] })
    const userB = fakeUser("B", { cvEmbedding: [0.9, 0.1, 0] })
    const userC = fakeUser("C", { cvEmbedding: [0.5, 0.5, 0] })
    const deps = makeDeps({
      jdEmbedding: [1, 0, 0],
      pool: [
        { userId: "A", profileIndustry: "tech" },
        { userId: "B", profileIndustry: "tech" },
        { userId: "C", profileIndustry: "tech" },
      ],
      signals: new Map([
        ["A", userA],
        ["B", userB],
        ["C", userC],
      ]),
      rerank: async (_q, cands) => {
        const have = new Set(cands.map((c) => c.id))
        return [
          { id: "C", score: 0.91 },
          { id: "A", score: 0.85 },
          { id: "B", score: 0.42 },
        ].filter((r) => have.has(r.id))
      },
    })
    const out = await runReverseMatch(
      { jobDescription: "JD text", tags: ["python"], industry: "tech" },
      deps,
    )
    assert.equal(out.candidates.length, 3)
    assert.deepEqual(out.candidates.map((c) => c.userId), ["C", "A", "B"])
    assert.equal(out.candidates[0]?.matchScore, 0.91)
  })
})

describe("paReverseMatch — D4 test 2: hard-filter drops mismatch", () => {
  it("user with targetLocations:[nyc] dropped when synth job locationRaw=san francisco", async () => {
    const userA = fakeUser("A", {
      hardFilterProfile: { statedPreferences: { visaStatus: "citizen" } },
    })
    const userB = fakeUser("B", {
      hardFilterProfile: { statedPreferences: { targetLocations: ["nyc"] } },
    })
    const deps = makeDeps({
      jdEmbedding: [1, 0, 0],
      pool: [
        { userId: "A", profileIndustry: "tech" },
        { userId: "B", profileIndustry: "tech" },
      ],
      signals: new Map([
        ["A", userA],
        ["B", userB],
      ]),
    })
    const out = await runReverseMatch(
      {
        jobDescription: "JD",
        tags: [],
        industry: "tech",
        location: "san francisco",
      },
      deps,
    )
    assert.deepEqual(out.candidates.map((c) => c.userId), ["A"])
    assert.equal(out.hardFilterDropped, 1)
    // Sanity — synth job + visa-needed user with sponsorship:false synth →
    // dropped by the visa rule (covers the "drop users who need sponsor"
    // path Stream-C contract requires).
    const synthNoSponsor = { ...synthesizeJobFromJd({ jobDescription: "JD", tags: [], industry: "tech" }), sponsorship: false }
    assert.equal(
      passesReverseHardFilter(
        { statedPreferences: { visaStatus: "sponsorship_needed" } },
        synthNoSponsor,
      ),
      false,
      "sponsorship-needed user dropped when synth.sponsorship=false",
    )
  })
})

describe("paReverseMatch — D4 test 3: opted-in flag surfaced", () => {
  it("hasOptedIn round-trips to candidate row without implicit gating", async () => {
    const userOpted = fakeUser("opted", { hasOptedIn: true })
    const userNot = fakeUser("not", { hasOptedIn: false })
    const deps = makeDeps({
      jdEmbedding: [1, 0, 0],
      pool: [
        { userId: "opted", profileIndustry: "tech" },
        { userId: "not", profileIndustry: "tech" },
      ],
      signals: new Map([
        ["opted", userOpted],
        ["not", userNot],
      ]),
    })
    const out = await runReverseMatch(
      { jobDescription: "JD", tags: [], industry: "tech" },
      deps,
    )
    const map = new Map(out.candidates.map((c) => [c.userId, c.hasOptedIn]))
    assert.equal(map.get("opted"), true)
    assert.equal(map.get("not"), false)
    assert.equal(out.candidates.length, 2, "both surfaced; opt-in is dashboard-side concern")
  })
})

describe("paReverseMatch — D4 test 4: topK respected", () => {
  it("default 20 caps to pool size; custom honored; reasons populated", async () => {
    const users = ["u1", "u2", "u3", "u4", "u5"].map((id, idx) =>
      fakeUser(id, {
        cvEmbedding: [1 - idx * 0.1, idx * 0.1, 0],
        topSkills: ["python"],
        profileIndustry: "tech",
      }),
    )
    const deps = makeDeps({
      jdEmbedding: [1, 0, 0],
      pool: users.map((u) => ({ userId: u.userId, profileIndustry: "tech" })),
      signals: new Map(users.map((u) => [u.userId, u])),
    })
    const out3 = await runReverseMatch(
      { jobDescription: "JD", tags: ["python"], industry: "tech", topK: 3 },
      deps,
    )
    assert.equal(out3.candidates.length, 3)
    // matched-reason wiring lights up
    assert.ok(out3.candidates[0]!.topMatchedReasons.length > 0, "reasons populated")
    const out5 = await runReverseMatch(
      { jobDescription: "JD", tags: [], industry: "tech" },
      deps,
    )
    assert.equal(out5.candidates.length, 5, "default topK falls back to pool size when smaller")
    // helper coverage: reasons handle EN + ZH symmetrically
    const userEn = fakeUser("u", { topSkills: ["python"], preferredLanguage: "en" })
    const r = buildMatchedReasons(userEn, { jobDescription: "JD", tags: ["python"], industry: "tech" })
    assert.match(r[0]!, /python match/i)
  })
})

describe("paReverseMatch — D4 test 5: admin-only auth", () => {
  it("checkAdminToken rejects empty/missing/wrong tokens; accepts on exact match", () => {
    const original = process.env.PA_ADMIN_TOKEN
    delete process.env.PA_ADMIN_TOKEN
    try {
      // 503 when env unset
      const a = checkAdminToken("anything")
      assert.equal(a.ok, false)
      assert.equal(a.status, 503)
      // 401 when missing header
      process.env.PA_ADMIN_TOKEN = "secret-tok"
      const b = checkAdminToken(undefined)
      assert.equal(b.ok, false)
      assert.equal(b.status, 401)
      assert.match(b.error ?? "", /missing/)
      // 401 when wrong token
      const c = checkAdminToken("wrong-tok")
      assert.equal(c.ok, false)
      assert.equal(c.status, 401)
      assert.match(c.error ?? "", /invalid/)
      // 200 when match (whitespace tolerant)
      const d = checkAdminToken("  secret-tok  ")
      assert.equal(d.ok, true)
      assert.equal(d.status, 200)
    } finally {
      if (original === undefined) delete process.env.PA_ADMIN_TOKEN
      else process.env.PA_ADMIN_TOKEN = original
    }
  })
})

describe("paReverseMatch — D4 test 6: runtime handoff notify path", () => {
  it("writes runtime event instead of pa-outbound; honors no-phone guard", async () => {
    const { db, collections } = makeFakeDb()
    // Seed a user with phone + zh language
    await (db as Firestore)
      .collection("pa-users")
      .doc("user-zh")
      .set({
        phoneE164: "+15551234567",
        preferredLanguage: "zh",
      })
    await (db as Firestore)
      .collection("pa-sessions")
      .doc(sessionDocId("user-zh", "imessage", "+15551234567"))
      .set({
        id: sessionDocId("user-zh", "imessage", "+15551234567"),
        userId: "user-zh",
        channel: "imessage",
        externalChatId: "+15551234567",
        createdAt: "2026-05-17T00:00:00.000Z",
      })
    // Seed an EN user
    await (db as Firestore)
      .collection("pa-users")
      .doc("user-en")
      .set({
        phoneE164: "+15559999999",
        preferredLanguage: "en",
      })
    await (db as Firestore)
      .collection("pa-sessions")
      .doc(sessionDocId("user-en", "imessage", "+15559999999"))
      .set({
        id: sessionDocId("user-en", "imessage", "+15559999999"),
        userId: "user-en",
        channel: "imessage",
        externalChatId: "+15559999999",
        createdAt: "2026-05-17T00:00:00.000Z",
      })
    // Seed a phone-less user → must reject with user_missing_phone
    await (db as Firestore)
      .collection("pa-users")
      .doc("user-no-phone")
      .set({})

    const ok1 = await enqueueReverseMatchNotify(db, {
      userId: "user-zh",
      jobTitle: "Senior Backend Engineer",
      companyName: "WeKruit",
    })
    assert.equal(ok1.ok, true)
    assert.ok(ok1.outboundId, "runtime event id returned")
    assert.equal(collections.get("pa-outbound")?.size ?? 0, 0)
    const runtimeEvents = collections.get("pa-inbound-events")
    assert.ok(runtimeEvents, "pa-inbound-events collection touched")
    const row = runtimeEvents!.get(ok1.outboundId!) as Record<string, unknown> | undefined
    assert.ok(row)
    assert.equal(row!.userId, "user-zh")
    assert.equal(row!.status, "pending")
    assert.match(String(row!.body), /system-event:reverse_match:operator_notify/)
    assert.match(String(row!.body), /Senior Backend Engineer/)
    assert.equal((row!.rawMeta as Record<string, unknown>).runtimeEvent, true)

    const ok2 = await enqueueReverseMatchNotify(db, {
      userId: "user-en",
      jobTitle: "Senior Backend Engineer",
      companyName: "WeKruit",
    })
    assert.equal(ok2.ok, true)
    const enRow = runtimeEvents!.get(ok2.outboundId!) as Record<string, unknown>
    assert.match(String(enRow.body), /Senior Backend Engineer/)

    // Missing-phone case → ok=false, no row written.
    const fail1 = await enqueueReverseMatchNotify(db, {
      userId: "user-no-phone",
      jobTitle: "T",
      companyName: "C",
    })
    assert.equal(fail1.ok, false)
    assert.equal(fail1.error, "user_missing_phone")

    // Missing-user case → ok=false with user_not_found
    const fail2 = await enqueueReverseMatchNotify(db, {
      userId: "ghost",
      jobTitle: "T",
      companyName: "C",
    })
    assert.equal(fail2.ok, false)
    assert.equal(fail2.error, "user_not_found")

    // Bilingual sanity at the helper level
    assert.match(
      buildNotifyMessage({ jobTitle: "PM", companyName: "WK", preferredLanguage: "zh" }),
      /嘿/,
    )
    assert.match(
      buildNotifyMessage({ jobTitle: "PM", companyName: "WK", preferredLanguage: "en" }),
      /Hey/,
    )
  })
})
