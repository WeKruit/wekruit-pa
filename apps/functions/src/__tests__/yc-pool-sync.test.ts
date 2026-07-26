/**
 * The live pool: a person who gives us their LinkedIn becomes MATCHABLE, not just matched.
 *
 * The assertion that actually matters here is the NEGATIVE one — a normal candidate must never
 * land in the Startup School cohort. That is the regression a future refactor of the shared
 * enrichment seam would otherwise introduce silently, and the blast radius is a stranger being
 * recommended by name to a real attendee.
 *
 * So these tests drive the REAL `isYcPeopleUser` (never a stub): one case fails if the predicate
 * wrongly returns true, another fails if it wrongly returns false, and one asserts that a company
 * carrying a YC batch tag is NOT evidence about the person.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ExternalCandidateRecord } from "@pa/core-types"
import { syncYcPoolMember } from "../yc-pool-sync.js"
import { runYcPeopleMatch, toPoolMember, YC_COHORT_2026, ycPoolRecordId } from "../yc-people-match.js"
import { runCoresignalExperiencesMirror } from "../external-supply/coresignal-experiences-mirror.js"

type Doc = Record<string, unknown>

const RECORDS = "pa-external-candidate-records"

/** Coresignal `collect` payload: an active founder row at a YC-tagged company + a prior role. */
const RAW: Doc = {
  id: 9001,
  full_name: "Dana Founder",
  headline: "Co-Founder at Nimbus (YC W25)",
  active_experience_title: "Co-Founder",
  location_full: "San Francisco, California, United States",
  experience: [
    {
      active_experience: 1,
      position_title: "Co-Founder",
      company_name: "Nimbus (YC W25)",
      company_id: 5150,
      company_industry: "Software Development",
      company_size_range: "1-10 employees",
      description: "Nimbus builds observability tooling for teams shipping LLM applications.",
    },
    {
      active_experience: 0,
      position_title: "Software Engineer",
      company_name: "Stripe",
      company_industry: "Financial Services",
      company_size_range: "1001-5000 employees",
    },
  ],
}

function record(): ExternalCandidateRecord {
  return {
    recordId: "src-1",
    batchId: "b1",
    source: "coresignal_collect_v2",
    rawPayload: RAW,
    emails: [],
    evidence: [],
    canonicalLinkedInUrl: "https://linkedin.com/in/dana-founder",
    name: "Dana Founder",
    currentTitle: "Co-Founder",
    currentCompany: "Nimbus (YC W25)",
    location: "San Francisco, California, United States",
    experience: [
      {
        company: "Nimbus (YC W25)",
        title: "Co-Founder",
        currentRole: true,
        companyId: 5150,
        companyIndustry: "Software Development",
        companySizeRange: "1-10 employees",
        description: "Nimbus builds observability tooling for teams shipping LLM applications.",
      },
      { company: "Stripe", title: "Software Engineer", currentRole: false, companySizeRange: "1001-5000 employees" },
    ],
    education: [{ school: "MIT", degree: "BS Computer Science" }],
    sourceTags: ["typescript", "observability", "llm"],
    normalizationStatus: "ok",
    identityResolutionStatus: "merge_existing",
    createdAt: "2026-07-25T00:00:00.000Z",
  } as ExternalCandidateRecord
}

function fakeDb(users: Record<string, Doc>, opts: { usersThrow?: boolean } = {}) {
  const written = new Map<string, Doc>()
  const setCalls: string[] = []
  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => ({
          async get() {
            if (name === "pa-users") {
              if (opts.usersThrow) throw new Error("firestore unavailable")
              return { exists: Boolean(users[id]), data: () => users[id] }
            }
            // No company cache and no CORESIGNAL key in these tests → Route A facts only.
            return { exists: false, data: () => undefined }
          },
          async set(data: Doc) {
            setCalls.push(`${name}/${id}`)
            written.set(`${name}/${id}`, { ...(written.get(`${name}/${id}`) ?? {}), ...data })
          },
        }),
      }
    },
  }
  return { db: db as never, written, setCalls }
}

/** Deterministic stand-ins — the point of these tests is the gate and the shape, not OpenAI. */
const stubs = {
  openaiApiKey: "sk-test",
  coresignalApiKey: null,
  describe: async () => ({
    businessModel: ["developer_tools"],
    domain: ["llm observability"],
    whatTheyBuild: "observability tooling sold to engineering teams running LLM apps",
  }),
  embed: async (text: string) => [text.length, 1, 0],
}

describe("yc-pool-sync — pool membership is YC-only", () => {
  it("YC user: enrichment lands AND a complete cohort record exists (both vectors)", async () => {
    const { db, written } = fakeDb({ u1: { source: "yc_startup_school", displayName: "Dana" } })
    const res = await syncYcPoolMember({ db, userId: "u1", record: record(), nowIso: "2026-07-25T12:00:00.000Z", ...stubs })

    assert.equal(res.ok, true)
    assert.equal(res.recordId, "yc-user:u1")
    const row = written.get(`${RECORDS}/yc-user:u1`)
    assert.ok(row, "a cohort record must exist")
    assert.deepEqual((row!.enrichment as Doc).cohort, YC_COHORT_2026)
    // BOTH vectors. The profile vector is what makes them matchable at all; the descriptor vector is
    // what "YC backed" / "series B" style asks bind to.
    assert.ok(Array.isArray(row!.matchEmbedding) && (row!.matchEmbedding as number[]).length > 0)
    assert.ok(Array.isArray(row!.descriptorEmbedding) && (row!.descriptorEmbedding as number[]).length > 0)
    assert.equal(res.hasMatchEmbedding, true)
    assert.equal(res.hasDescriptorEmbedding, true)
  })

  it("the row reads through toPoolMember with no special-casing, and carries the company facts", async () => {
    const { db, written } = fakeDb({ u1: { source: "yc_startup_school" } })
    await syncYcPoolMember({ db, userId: "u1", record: record(), nowIso: "2026-07-25T12:00:00.000Z", ...stubs })
    const row = written.get(`${RECORDS}/yc-user:u1`)!

    // `loadCohortPool`'s membership test, then the same flattening every imported row goes through.
    assert.equal(row.coresignalMatch, "ok")
    const m = toPoolMember("yc-user:u1", row)
    assert.equal(m.name, "Dana Founder")
    assert.equal(m.linkedinUrl, "https://linkedin.com/in/dana-founder")
    assert.deepEqual(m.schools, ["MIT"])
    assert.ok(m.matchText.length > 20)
    // Company enrichment actually happened — without it every "YC backed" ask skips them forever.
    const cp = row.companyProfile as Doc
    assert.equal(cp.ycBatch, "W25")
    assert.equal(cp.isYcBacked, true)
    assert.equal(cp.trustReason, "active_name_agrees")
    assert.match(String(cp.matchLine), /Co-Founder at Nimbus/)
    // NEVER GUESSED: no company collect was available here, so no funding round is claimed.
    assert.equal(cp.stage, null)
    // The facts reached the descriptor vector's text, which is the whole point of resolving them.
    assert.match(m.matchText, /Y Combinator W25 batch/)
  })

  it("NORMAL CANDIDATE: enrichment is stored by the caller, but NO cohort record is written", async () => {
    // A YC-tagged EMPLOYER is deliberately in this fixture: someone who works at a YC company and
    // signed up through the normal job flow is not a Startup School attendee, and inferring
    // otherwise from the company is exactly the shortcut this asserts against.
    const { db, written, setCalls } = fakeDb({ u2: { source: "candidate", displayName: "Sam" } })
    const res = await syncYcPoolMember({ db, userId: "u2", record: record(), ...stubs })

    assert.equal(res.ok, false)
    assert.equal(res.reason, "not_yc")
    assert.equal(written.size, 0, "a non-YC user must never appear in the Startup School pool")
    assert.deepEqual(setCalls, [], "no writes at all on the non-YC path")
  })

  it("QR scanner (ycEventEntryAt, source=qr_imessage) IS pooled — the predicate is not re-derived narrowly", async () => {
    // Guards the opposite failure: a narrower inline copy (`source === "yc_startup_school"`) would
    // silently drop every event QR entrant, who are the majority of today's arrivals.
    const { db, written } = fakeDb({ u3: { source: "qr_imessage", ycEventEntryAt: "2026-07-25T09:00:00.000Z" } })
    const res = await syncYcPoolMember({ db, userId: "u3", record: record(), ...stubs })
    assert.equal(res.ok, true)
    assert.ok(written.get(`${RECORDS}/yc-user:u3`))
  })

  it("FAILS CLOSED: an unreadable user doc writes nothing", async () => {
    const { db, written } = fakeDb({ u4: { source: "yc_startup_school" } }, { usersThrow: true })
    const res = await syncYcPoolMember({ db, userId: "u4", record: record(), ...stubs })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "user_unreadable")
    assert.equal(written.size, 0, "unknown YC-ness must not write — a wrong pool member is worse than a missing one")
  })

  it("IDEMPOTENT: a second enrichment updates the same row, it does not fork a second face", async () => {
    const { db, written, setCalls } = fakeDb({ u1: { source: "yc_startup_school" } })
    const a = await syncYcPoolMember({ db, userId: "u1", record: record(), ...stubs })
    const b = await syncYcPoolMember({ db, userId: "u1", record: record(), ...stubs })
    assert.equal(a.recordId, b.recordId)
    assert.equal(written.size, 1, "one person, one pool row")
    assert.deepEqual(setCalls, [`${RECORDS}/yc-user:u1`, `${RECORDS}/yc-user:u1`])
  })

  it("no descriptor (LLM unavailable) still produces a matchable row — fail-soft, not a dead record", async () => {
    const { db, written } = fakeDb({ u1: { source: "yc_startup_school" } })
    const res = await syncYcPoolMember({
      db,
      userId: "u1",
      record: record(),
      ...stubs,
      describe: async () => {
        throw new Error("nano down")
      },
    })
    assert.equal(res.ok, true)
    assert.equal(res.hasDescriptor, false)
    assert.ok(Array.isArray(written.get(`${RECORDS}/yc-user:u1`)!.matchEmbedding))
  })

  it("writes no contact handle — pool members are recommendable, never outbound-messaged", async () => {
    const { db, written } = fakeDb({ u1: { source: "yc_startup_school" } })
    await syncYcPoolMember({
      db,
      userId: "u1",
      record: { ...record(), emails: [{ value: "dana@nimbus.dev", hash: "h".repeat(32) }] } as ExternalCandidateRecord,
      ...stubs,
    })
    const row = written.get(`${RECORDS}/yc-user:u1`)!
    assert.equal(row.emails, undefined)
    assert.equal(row.phoneHash, undefined)
  })
})

describe("yc-pool-sync — the shared seam", () => {
  it("the mirror runs afterMirror AFTER the profile write, and a throw there never fails enrichment", async () => {
    const order: string[] = []
    const res = await runCoresignalExperiencesMirror(record(), "u1", {
      findExistingForUser: async () => [],
      mergeAndDetermine: async () => null,
      writeBoth: async () => {
        order.push("writeBoth")
      },
      afterMirror: async () => {
        order.push("afterMirror")
        throw new Error("pool sync blew up")
      },
    })
    // Enrichment is the payload; pool membership is bookkeeping on top of it.
    assert.deepEqual(order, ["writeBoth", "afterMirror"])
    assert.equal(res.status, "mirrored")
  })
})

describe("yc-people-match — self-exclusion", () => {
  it("the asker never matches themselves, even though they are now in the pool", async () => {
    const selfId = ycPoolRecordId("u1")
    const records: Record<string, Doc> = {
      // The asker's own row is by construction the highest-cosine row for their own ask.
      [selfId]: {
        coresignalMatch: "ok",
        name: "Dana Founder",
        currentTitle: "Co-Founder",
        currentCompany: "Nimbus",
        normalizedSkills: ["llm observability", "typescript", "distributed systems"],
        matchEmbedding: [1, 0, 0],
        enrichment: { cohort: YC_COHORT_2026 },
      },
      other: {
        coresignalMatch: "ok",
        name: "Someone Else",
        currentTitle: "Infrastructure Engineer",
        currentCompany: "Acme Systems",
        normalizedSkills: ["observability", "kubernetes", "go"],
        matchEmbedding: [0.9, 0.1, 0],
        enrichment: { cohort: YC_COHORT_2026 },
      },
    }
    const user: Doc = { ycIntake: { building: "llm observability", wantsToMeet: "infra founders" } }
    const db = {
      collection: (name: string) => ({
        doc: () => ({ get: async () => ({ data: () => (name === "pa-users" ? user : undefined) }) }),
        where: () => ({
          get: async () => ({ docs: Object.entries(records).map(([id, d]) => ({ id, data: () => d })) }),
        }),
      }),
    }
    const out = await runYcPeopleMatch(
      { userId: "u1", limit: 5 },
      {
        db: db as never,
        embed: async () => [1, 0, 0],
        cosine: (a, b) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!,
      },
    )
    assert.ok(out.results.length > 0, "the other person still matches")
    assert.equal(
      out.results.some((r) => r.recordId === selfId),
      false,
      "matching yourself at cosine ~1.0 is the first thing that happens without this filter",
    )
  })
})
