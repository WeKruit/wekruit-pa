/**
 * Unit tests for paJobPoolHygiene CF (W6 of pre-launch matching hardening).
 *
 * Coverage:
 *   - evaluateHygiene predicate alone — 4 flip cases (one per reason) +
 *     1 healthy → no flip, plus first-match priority order.
 *   - classifyPage: counters, defensive already-inactive guard.
 *   - runJobPoolHygiene end-to-end with in-memory store:
 *       * 10-doc fixture (3 dead, 2 no-title, 2 stale, 1 missing-ats, 2 healthy)
 *       * dry-run does NOT call batchFlipInactive
 *       * non-dry run flips 8 (3+2+2+1)
 *       * batches sized at batchSize
 *       * batch failure isolated, errors counter bumps
 *       * audit row written
 *
 * Architecture: in-memory HygieneStore. No firebase-admin boot.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  classifyPage,
  emptyCounters,
  evaluateHygiene,
  runJobPoolHygiene,
  toMillis,
  STALE_FIRSTSEENAT_DAYS_DEFAULT,
  type HygieneCounters,
  type HygieneDeps,
  type HygieneJobDoc,
  type HygieneReason,
  type HygieneStore,
} from "../job-pool-hygiene.js"

const NOW = Date.parse("2026-05-19T00:00:00Z")
const MS_PER_DAY = 24 * 3600 * 1000
const dayAgoIso = (n: number) => new Date(NOW - n * MS_PER_DAY).toISOString()
const dayAgoTs = (n: number) => ({ toMillis: () => NOW - n * MS_PER_DAY })

const staleCutoffMs = NOW - STALE_FIRSTSEENAT_DAYS_DEFAULT * MS_PER_DAY

// ---------------------------------------------------------------------------
// evaluateHygiene — predicate-only, 4 flip cases + healthy + priority
// ---------------------------------------------------------------------------

describe("evaluateHygiene — predicate", () => {
  // ≥200-char JD body satisfies the matching-quality launch blocker zombie
  // predicate (Track D). Used by every healthy-base derivation so the new
  // jd_zombie reason doesn't fire on docs that have always been considered
  // "healthy" by the original four predicates. ZOMBIE_MIN_JD_LENGTH=200 in
  // the predicate; keep this comfortably above that.
  const HEALTHY_JD =
    "Build matching engines, partner with product, ship internships. " +
    "We are looking for someone who has shipped production systems end-to-end, " +
    "is comfortable owning ambiguous problems, writes tests as part of every " +
    "commit, and enjoys collaborating across teams to ship quickly."
  const HEALTHY_SKILLS = ["python", "postgres"]

  const healthyBase = (): HygieneJobDoc => ({
    id: "j",
    status: "active",
    dead: false,
    jobTitle: "Senior Software Engineer",
    firstSeenAt: dayAgoIso(5),
    atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/12345",
    primaryUrl: "https://boards.greenhouse.io/acme/jobs/12345",
    jobDescription: HEALTHY_JD,
    requiredSkills: HEALTHY_SKILLS,
    unresolvableAts: false,
  })

  it("healthy doc: no flip", () => {
    const ev = evaluateHygiene(healthyBase(), NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: false })
  })

  it("dead === true: flip with reason dead_flag", () => {
    const doc = { ...healthyBase(), dead: true }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "dead_flag" })
  })

  it("missing jobTitle: flip with reason no_title", () => {
    const doc = { ...healthyBase(), jobTitle: null }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "no_title" })
  })

  it("whitespace-only jobTitle: flip with reason no_title (trim().length===0)", () => {
    const doc = { ...healthyBase(), jobTitle: "   \t\n  " }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "no_title" })
  })

  // ---- 2026-05-19 schema-drift hotfix --------------------------------------
  // macmini scraper canonically writes `roleTitle` (100% of 16,788 active
  // docs as of 2026-05-19, 0% have `jobTitle`). The no_title predicate MUST
  // treat a doc as titled when EITHER `jobTitle` OR `roleTitle` has non-empty
  // trimmed text. Without this fallback, paJobPoolHygiene would flip ALL
  // 16,788 active docs → inactive on first non-dry-run trigger.

  it("roleTitle present, jobTitle missing: KEEP (no_title fallback)", () => {
    const doc: HygieneJobDoc = {
      ...healthyBase(),
      jobTitle: null,
      roleTitle: "Software Engineer",
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: false })
  })

  it("both jobTitle and roleTitle missing: flip with reason no_title", () => {
    const doc: HygieneJobDoc = {
      ...healthyBase(),
      jobTitle: null,
      roleTitle: null,
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "no_title" })
  })

  it("both jobTitle and roleTitle whitespace-only: flip with reason no_title", () => {
    const doc: HygieneJobDoc = {
      ...healthyBase(),
      jobTitle: "   ",
      roleTitle: "\t\n",
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "no_title" })
  })

  it("roleTitle whitespace-only with valid jobTitle: KEEP", () => {
    const doc: HygieneJobDoc = {
      ...healthyBase(),
      jobTitle: "Engineer",
      roleTitle: "   ",
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: false })
  })

  it("firstSeenAt 21d ago: flip with reason stale_firstseenat (>20d)", () => {
    const doc = { ...healthyBase(), firstSeenAt: dayAgoIso(21) }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "stale_firstseenat" })
  })

  it("firstSeenAt 19d ago: KEEP (just inside 20d window)", () => {
    const doc = { ...healthyBase(), firstSeenAt: dayAgoIso(19) }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: false })
  })

  it("missing atsApplyUrl: flip with reason missing_or_placeholder_ats", () => {
    const doc = { ...healthyBase(), atsApplyUrl: null }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "missing_or_placeholder_ats" })
  })

  it("atsApplyUrl pointing to jobright.ai: flip with reason missing_or_placeholder_ats", () => {
    const doc = {
      ...healthyBase(),
      atsApplyUrl: "https://jobright.ai/jobs/info/abc123",
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "missing_or_placeholder_ats" })
  })

  it("atsApplyUrl pointing to www.jobright.ai (case-insensitive): flip", () => {
    const doc = { ...healthyBase(), atsApplyUrl: "https://WWW.JOBRIGHT.AI/x" }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "missing_or_placeholder_ats" })
  })

  it("priority: dead beats no_title", () => {
    const doc = { ...healthyBase(), dead: true, jobTitle: "" }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "dead_flag" })
  })

  it("priority: no_title beats stale_firstseenat", () => {
    const doc = {
      ...healthyBase(),
      jobTitle: "",
      firstSeenAt: dayAgoIso(100),
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "no_title" })
  })

  it("priority: stale_firstseenat beats missing_or_placeholder_ats", () => {
    const doc = {
      ...healthyBase(),
      firstSeenAt: dayAgoIso(100),
      atsApplyUrl: null,
    }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "stale_firstseenat" })
  })

  it("firstSeenAt as Timestamp-like object", () => {
    const doc = { ...healthyBase(), firstSeenAt: dayAgoTs(30) }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: true, reason: "stale_firstseenat" })
  })

  it("unparseable firstSeenAt does NOT trigger stale (conservative)", () => {
    // Doc has no other defect → no flip; we don't flag stale when age is unknown.
    const doc = { ...healthyBase(), firstSeenAt: "not-a-date" }
    const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
    assert.deepEqual(ev, { flip: false })
  })

  // -------------------------------------------------------------------------
  // Matching-quality launch blocker predicates (Tracks A + D + F, 2026-05-20)
  // -------------------------------------------------------------------------

  describe("yc_synthetic_title predicate", () => {
    it("'Open Engineering Roles' literal: flip with reason yc_synthetic_title", () => {
      const doc = { ...healthyBase(), jobTitle: null, roleTitle: "Open Engineering Roles" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "yc_synthetic_title" })
    })

    it("'Open Sales Roles' (other function): flip with reason yc_synthetic_title", () => {
      const doc = { ...healthyBase(), jobTitle: null, roleTitle: "Open Sales Roles" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "yc_synthetic_title" })
    })

    it("'Open Engineering Role' (singular): also flipped (Roles? matches)", () => {
      const doc = { ...healthyBase(), jobTitle: null, roleTitle: "Open Engineering Role" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "yc_synthetic_title" })
    })

    it("case-insensitive: 'open engineering roles' lowercase still flips", () => {
      const doc = { ...healthyBase(), jobTitle: null, roleTitle: "open engineering roles" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "yc_synthetic_title" })
    })

    it("real role title 'Engineering Manager': KEEP (no match)", () => {
      const doc = { ...healthyBase(), jobTitle: null, roleTitle: "Engineering Manager" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })

    it("'Senior Software Engineer': KEEP — common real title", () => {
      const doc = { ...healthyBase(), roleTitle: "Senior Software Engineer" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })

    it("jobTitle synthetic + roleTitle empty: still flips (titleA fallback)", () => {
      const doc = { ...healthyBase(), jobTitle: "Open Marketing Roles", roleTitle: null }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "yc_synthetic_title" })
    })
  })

  describe("bare_workatastartup_url predicate", () => {
    it("bare /companies/{slug} URL: flip with reason bare_workatastartup_url", () => {
      const doc = { ...healthyBase(), primaryUrl: "https://www.workatastartup.com/companies/veritus" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "bare_workatastartup_url" })
    })

    it("bare /companies/{slug}/ trailing-slash variant: also flipped", () => {
      const doc = { ...healthyBase(), primaryUrl: "https://www.workatastartup.com/companies/veritus/" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "bare_workatastartup_url" })
    })

    it("real job page /companies/{slug}/jobs/{id}: KEEP", () => {
      const doc = {
        ...healthyBase(),
        primaryUrl: "https://www.workatastartup.com/companies/veritus/jobs/12345-backend-eng",
      }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })

    it("non-workatastartup URL with /companies/ path: KEEP", () => {
      const doc = { ...healthyBase(), primaryUrl: "https://example.com/companies/abc" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })
  })

  describe("unresolvable_ats predicate", () => {
    it("unresolvableAts === true: flip with reason unresolvable_ats", () => {
      const doc = { ...healthyBase(), unresolvableAts: true }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "unresolvable_ats" })
    })

    it("unresolvableAts === false: KEEP", () => {
      const doc = { ...healthyBase(), unresolvableAts: false }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })

    it("unresolvableAts === null: KEEP (conservative — not a positive signal)", () => {
      const doc = { ...healthyBase(), unresolvableAts: null }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })
  })

  describe("jd_zombie predicate", () => {
    it("NULL JD + empty skills: flip with reason jd_zombie", () => {
      const doc = { ...healthyBase(), jobDescription: null, requiredSkills: [] }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "jd_zombie" })
    })

    it("empty JD string + empty skills: flip", () => {
      const doc = { ...healthyBase(), jobDescription: "", requiredSkills: [] }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "jd_zombie" })
    })

    it("JD heading-only (<200 chars) + empty skills: flip", () => {
      const doc = {
        ...healthyBase(),
        jobDescription: "About the role",
        requiredSkills: [],
      }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "jd_zombie" })
    })

    it("NULL JD but non-empty skills (mid-enrichment race): KEEP", () => {
      // Defensive: a doc whose JD just landed but skills are still being
      // extracted should NOT get prematurely flipped. Both conditions
      // required.
      const doc = { ...healthyBase(), jobDescription: null, requiredSkills: ["python"] }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })

    it("Valid JD but empty skills (LLM extracted nothing): KEEP", () => {
      // Same logic — both conditions required. A real JD with no skills
      // extracted is a quality concern but not a zombie.
      const doc = { ...healthyBase(), requiredSkills: [] }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: false })
    })
  })

  describe("predicate priority (matching-quality blocker order)", () => {
    it("dead beats yc_synthetic", () => {
      const doc = { ...healthyBase(), dead: true, roleTitle: "Open Engineering Roles" }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "dead_flag" })
    })

    it("yc_synthetic beats bare_workatastartup_url", () => {
      const doc = {
        ...healthyBase(),
        roleTitle: "Open Engineering Roles",
        primaryUrl: "https://www.workatastartup.com/companies/x",
      }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "yc_synthetic_title" })
    })

    it("bare_workatastartup_url beats unresolvable_ats", () => {
      const doc = {
        ...healthyBase(),
        primaryUrl: "https://www.workatastartup.com/companies/x",
        unresolvableAts: true,
      }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "bare_workatastartup_url" })
    })

    it("unresolvable_ats beats jd_zombie", () => {
      const doc = {
        ...healthyBase(),
        unresolvableAts: true,
        jobDescription: null,
        requiredSkills: [],
      }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "unresolvable_ats" })
    })

    it("jd_zombie beats stale_firstseenat (fresh zombie still flips)", () => {
      // A 5-day-old NULL-JD doc would otherwise have to wait 20 days for
      // the stale predicate to catch it. Track D pins the zombie predicate
      // before staleness so it fires on the first sweep.
      const doc = {
        ...healthyBase(),
        jobDescription: null,
        requiredSkills: [],
        firstSeenAt: dayAgoIso(5),
      }
      const ev = evaluateHygiene(doc, NOW, staleCutoffMs)
      assert.deepEqual(ev, { flip: true, reason: "jd_zombie" })
    })
  })
})

// ---------------------------------------------------------------------------
// toMillis (parsing helper)
// ---------------------------------------------------------------------------

describe("toMillis", () => {
  it("returns null for null/undefined", () => {
    assert.equal(toMillis(null), null)
    assert.equal(toMillis(undefined), null)
  })
  it("parses ISO string", () => {
    assert.equal(toMillis("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"))
  })
  it("returns null for unparseable string", () => {
    assert.equal(toMillis("not-a-date"), null)
  })
  it("calls toMillis() on Timestamp-like object", () => {
    assert.equal(toMillis({ toMillis: () => 12345 }), 12345)
  })
})

// ---------------------------------------------------------------------------
// classifyPage — scanned counter + defensive already-inactive guard
// ---------------------------------------------------------------------------

describe("classifyPage", () => {
  it("scanned counter increments for every doc regardless of outcome", () => {
    const counters = emptyCounters()
    const page: HygieneJobDoc[] = [
      { id: "a", status: "active", dead: true, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x" },
      { id: "b", status: "active", dead: false, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x" }, // healthy
      { id: "c", status: "active", dead: false, jobTitle: "", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x" },
    ]
    classifyPage(page, NOW, staleCutoffMs, counters)
    assert.equal(counters.scanned, 3)
  })

  it("defensive guard: doc with status != active counts under skipped_already_inactive", () => {
    const counters = emptyCounters()
    const page: HygieneJobDoc[] = [
      { id: "a", status: "inactive", dead: true, jobTitle: "Engineer" },
    ]
    const out = classifyPage(page, NOW, staleCutoffMs, counters)
    assert.equal(out.length, 0)
    assert.equal(counters.skipped_already_inactive, 1)
  })
})

// ---------------------------------------------------------------------------
// In-memory HygieneStore
// ---------------------------------------------------------------------------

type StoreFixture = {
  store: HygieneStore
  flipped: Array<Array<{ id: string; reason: HygieneReason }>>
  audits: Array<{ counters: HygieneCounters; runAt: string }>
}

function inMemoryStore(opts: {
  active: HygieneJobDoc[]
  failBatchN?: number
}): StoreFixture {
  const flipped: Array<Array<{ id: string; reason: HygieneReason }>> = []
  const audits: Array<{ counters: HygieneCounters; runAt: string }> = []

  const paginate = (
    docs: HygieneJobDoc[],
    pageSize: number,
    onPage: (docs: HygieneJobDoc[]) => Promise<{ stop: boolean }>,
  ) =>
    (async () => {
      let i = 0
      while (i < docs.length) {
        const page = docs.slice(i, i + pageSize)
        const r = await onPage(page)
        if (r.stop) return
        i += pageSize
      }
    })()

  let batchCount = 0
  const store: HygieneStore = {
    streamActive: (pageSize, onPage) => paginate(opts.active, pageSize, onPage),
    batchFlipInactive: async (items) => {
      batchCount++
      if (opts.failBatchN === batchCount) {
        throw new Error(`simulated batch ${batchCount} failure`)
      }
      flipped.push(items.map((it) => ({ ...it })))
    },
    writeAudit: async (counters, runAt) => {
      audits.push({ counters: { ...counters }, runAt })
    },
  }

  return { store, flipped, audits }
}

const noSleep = async () => undefined

const baseDeps = (store: HygieneStore, overrides: Partial<HygieneDeps> = {}): HygieneDeps => ({
  store,
  now: () => NOW,
  sleep: noSleep,
  ...overrides,
})

// ---------------------------------------------------------------------------
// runJobPoolHygiene — integration with deps-injected store
// ---------------------------------------------------------------------------

describe("runJobPoolHygiene — end-to-end", () => {
  // 10-doc fixture: 3 dead, 2 no-title, 2 stale, 1 missing-ats, 2 healthy.
  // (Per spec brief — 8 flips total.)
  //
  // Launch-blocker fields (jobDescription / requiredSkills / primaryUrl /
  // unresolvableAts) are populated for every doc so the new predicates
  // (yc_synthetic, jd_zombie, bare_workatastartup_url, unresolvable_ats)
  // never fire on this baseline. The new predicates are pinned with their
  // own focused test cases below.
  const E2E_JD =
    "Build matching pipelines. Partner with product on the matching " +
    "engine roadmap. You have shipped systems end-to-end and write tests."
  const E2E_SKILLS = ["python", "postgres"]
  const buildSeed = (): HygieneJobDoc[] => [
    // 3 dead
    { id: "dead_a", status: "active", dead: true, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    { id: "dead_b", status: "active", dead: true, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    { id: "dead_c", status: "active", dead: true, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    // 2 no-title
    { id: "no_title_a", status: "active", dead: false, jobTitle: "", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    { id: "no_title_b", status: "active", dead: false, jobTitle: "   ", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    // 2 stale (firstSeenAt > 20d, otherwise healthy)
    { id: "stale_a", status: "active", dead: false, jobTitle: "Engineer", firstSeenAt: dayAgoIso(30), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    { id: "stale_b", status: "active", dead: false, jobTitle: "Engineer", firstSeenAt: dayAgoIso(40), atsApplyUrl: "https://x.com", primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    // 1 missing-ats (otherwise healthy)
    { id: "no_ats_a", status: "active", dead: false, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: null, primaryUrl: "https://x.com", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    // 2 healthy
    { id: "healthy_a", status: "active", dead: false, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/1", primaryUrl: "https://boards.greenhouse.io/acme/jobs/1", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
    { id: "healthy_b", status: "active", dead: false, jobTitle: "Senior PM", firstSeenAt: dayAgoIso(2), atsApplyUrl: "https://jobs.lever.co/acme/2", primaryUrl: "https://jobs.lever.co/acme/2", jobDescription: E2E_JD, requiredSkills: E2E_SKILLS, unresolvableAts: false },
  ]

  it("dry-run: counters correct, no Firestore writes", async () => {
    const fixture = inMemoryStore({ active: buildSeed() })
    const counters = await runJobPoolHygiene(baseDeps(fixture.store, { dryRun: true }))

    assert.equal(counters.dryRun, true)
    assert.equal(counters.scanned, 10)
    assert.equal(counters.flipped_dead, 3)
    assert.equal(counters.flipped_no_title, 2)
    assert.equal(counters.flipped_stale, 2)
    assert.equal(counters.flipped_missing_ats, 1)
    assert.equal(counters.flipped_total, 8)
    assert.equal(counters.skipped_already_inactive, 0)
    assert.equal(counters.batches, 1)
    assert.equal(counters.errors, 0)
    assert.equal(
      fixture.flipped.length,
      0,
      "dry-run must NOT call batchFlipInactive",
    )
    assert.equal(fixture.audits.length, 1)
    assert.equal(fixture.audits[0]!.counters.dryRun, true)
  })

  it("non-dry-run: flips 8 docs with correct reasons, writes via store", async () => {
    const fixture = inMemoryStore({ active: buildSeed() })
    const counters = await runJobPoolHygiene(baseDeps(fixture.store, { dryRun: false }))

    assert.equal(counters.dryRun, false)
    assert.equal(counters.scanned, 10)
    assert.equal(counters.flipped_total, 8)
    assert.equal(counters.batches, 1)
    assert.equal(counters.errors, 0)

    // Exactly one batch flush with all 8 items.
    assert.equal(fixture.flipped.length, 1)
    const flat = fixture.flipped.flat()
    assert.equal(flat.length, 8)

    const byId = new Map(flat.map((f) => [f.id, f.reason]))
    assert.equal(byId.get("dead_a"), "dead_flag")
    assert.equal(byId.get("dead_b"), "dead_flag")
    assert.equal(byId.get("dead_c"), "dead_flag")
    assert.equal(byId.get("no_title_a"), "no_title")
    assert.equal(byId.get("no_title_b"), "no_title")
    assert.equal(byId.get("stale_a"), "stale_firstseenat")
    assert.equal(byId.get("stale_b"), "stale_firstseenat")
    assert.equal(byId.get("no_ats_a"), "missing_or_placeholder_ats")
    assert.ok(!byId.has("healthy_a"))
    assert.ok(!byId.has("healthy_b"))
  })

  // ---- 2026-05-19 schema-drift hotfix regression ---------------------------
  // Live audit found 100% of macmini-sourced active docs carry `roleTitle`
  // but no `jobTitle`. End-to-end regression: a corpus of 100% `roleTitle`
  // docs must produce ZERO no_title flips so we don't nuke the active pool.

  it("regression: 1000 docs with only roleTitle produce ZERO no_title flips", async () => {
    // Matching-quality launch blocker (2026-05-20): docs also need JD +
    // skills populated to pass the new `jd_zombie` predicate. The intent
    // of THIS regression test is that the no_title predicate alone doesn't
    // false-positive on macmini-shaped docs — pin the no_title counter at
    // zero. Other predicates are exercised by focused tests below.
    const SEED_JD =
      "Build matching engines. Partner with product. Ship internships. " +
      "We are looking for someone who writes production code and tests."
    const active: HygieneJobDoc[] = []
    for (let i = 0; i < 1000; i++) {
      active.push({
        id: `macmini_${i}`,
        status: "active",
        dead: false,
        jobTitle: null,
        roleTitle: "Software Engineer",
        firstSeenAt: dayAgoIso(5),
        atsApplyUrl: "https://boards.greenhouse.io/acme/jobs/1",
        primaryUrl: "https://boards.greenhouse.io/acme/jobs/1",
        jobDescription: SEED_JD,
        requiredSkills: ["python"],
        unresolvableAts: false,
      })
    }
    const fixture = inMemoryStore({ active })
    const counters = await runJobPoolHygiene(
      baseDeps(fixture.store, { dryRun: false, batchSize: 500, pageSize: 500 }),
    )
    assert.equal(counters.scanned, 1000)
    assert.equal(
      counters.flipped_no_title,
      0,
      "macmini-sourced docs with roleTitle MUST NOT be flipped as no_title",
    )
    assert.equal(counters.flipped_total, 0)
    assert.equal(counters.batches, 0)
    assert.equal(fixture.flipped.length, 0)
  })

  it("empty collection: zero flips, zero errors, single audit row", async () => {
    const fixture = inMemoryStore({ active: [] })
    const counters = await runJobPoolHygiene(baseDeps(fixture.store))
    assert.equal(counters.scanned, 0)
    assert.equal(counters.flipped_total, 0)
    assert.equal(counters.batches, 0)
    assert.equal(counters.errors, 0)
    assert.equal(fixture.flipped.length, 0)
    assert.equal(fixture.audits.length, 1)
  })

  it("batches at batchSize when flips exceed one batch", async () => {
    const active: HygieneJobDoc[] = []
    for (let i = 0; i < 1100; i++) {
      active.push({
        id: `dead_${i}`,
        status: "active",
        dead: true,
        jobTitle: "Engineer",
        firstSeenAt: dayAgoIso(5),
        atsApplyUrl: "https://x.com",
      })
    }
    const fixture = inMemoryStore({ active })
    const counters = await runJobPoolHygiene(
      baseDeps(fixture.store, { batchSize: 500, pageSize: 500 }),
    )
    assert.equal(counters.flipped_total, 1100)
    assert.equal(counters.batches, 3)
    assert.equal(fixture.flipped[0]!.length, 500)
    assert.equal(fixture.flipped[1]!.length, 500)
    assert.equal(fixture.flipped[2]!.length, 100)
  })

  it("batch failure isolated: errors bumps, run continues", async () => {
    const active: HygieneJobDoc[] = []
    for (let i = 0; i < 1100; i++) {
      active.push({
        id: `dead_${i}`,
        status: "active",
        dead: true,
        jobTitle: "Engineer",
        firstSeenAt: dayAgoIso(5),
        atsApplyUrl: "https://x.com",
      })
    }
    const fixture = inMemoryStore({ active, failBatchN: 2 })
    const counters = await runJobPoolHygiene(
      baseDeps(fixture.store, { batchSize: 500, pageSize: 500 }),
    )
    assert.equal(counters.errors, 1)
    // Batches 1 + 3 succeeded; batch 2 failed → 500 + 100 = 600 flipped.
    assert.equal(counters.flipped_total, 600)
    assert.equal(counters.batches, 2)
  })

  it("throttle invoked between batches", async () => {
    const active: HygieneJobDoc[] = []
    for (let i = 0; i < 600; i++) {
      active.push({
        id: `dead_${i}`,
        status: "active",
        dead: true,
        jobTitle: "Engineer",
        firstSeenAt: dayAgoIso(5),
        atsApplyUrl: "https://x.com",
      })
    }
    const sleepCalls: number[] = []
    const fixture = inMemoryStore({ active })
    await runJobPoolHygiene(
      baseDeps(fixture.store, {
        batchSize: 500,
        pageSize: 500,
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
      }),
    )
    assert.ok(sleepCalls.length >= 2, "sleep called after each batch")
    assert.ok(
      sleepCalls.every((ms) => ms === 100),
      "throttle is 100ms",
    )
  })

  it("respects maxDocsPerRun cap and stops streaming", async () => {
    const active: HygieneJobDoc[] = []
    for (let i = 0; i < 1000; i++) {
      active.push({
        id: `dead_${i}`,
        status: "active",
        dead: true,
        jobTitle: "Engineer",
        firstSeenAt: dayAgoIso(5),
        atsApplyUrl: "https://x.com",
      })
    }
    const fixture = inMemoryStore({ active })
    const counters = await runJobPoolHygiene(
      baseDeps(fixture.store, { maxDocsPerRun: 300, pageSize: 100, batchSize: 500 }),
    )
    // Cap checked after each page (size 100), so we can overshoot by ≤1 page.
    assert.ok(
      counters.flipped_total >= 300 && counters.flipped_total <= 400,
      `expected 300..400 flips, got ${counters.flipped_total}`,
    )
  })

  it("defensive guard: ids with non-active status skipped under skipped_already_inactive", async () => {
    const fixture = inMemoryStore({
      active: [
        // This shouldn't happen in prod (query is status==active) but if a
        // bug returned mixed status, we must skip it.
        { id: "wrong", status: "inactive", dead: true, jobTitle: "Engineer" },
        { id: "right", status: "active", dead: true, jobTitle: "Engineer", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com" },
      ],
    })
    const counters = await runJobPoolHygiene(baseDeps(fixture.store, { dryRun: false }))
    assert.equal(counters.skipped_already_inactive, 1)
    assert.equal(counters.flipped_total, 1)
    const flat = fixture.flipped.flat()
    assert.deepEqual(flat, [{ id: "right", reason: "dead_flag" }])
  })

  it("structured log key 'pa.matching_jobs.hygiene' shape", async () => {
    const fixture = inMemoryStore({
      active: [
        { id: "a", status: "active", dead: true, jobTitle: "x", firstSeenAt: dayAgoIso(5), atsApplyUrl: "https://x.com" },
      ],
    })
    const messages: Array<{ msg: string; ctx: Record<string, unknown> }> = []
    await runJobPoolHygiene(
      baseDeps(fixture.store, {
        log: (msg, ctx) => messages.push({ msg, ctx: ctx ?? {} }),
      }),
    )
    const start = messages.find((m) => m.msg === "job_pool_hygiene_start")
    assert.ok(start, "start log emitted")
    assert.equal(start!.ctx.staleFirstSeenAtDays, 20)
    const complete = messages.find((m) => m.msg === "job_pool_hygiene_complete")
    assert.ok(complete, "complete log emitted")
    assert.ok(typeof complete!.ctx.duration_seconds === "number")
  })

  it("default stale window is 20d (matches V16 hard-filter window)", () => {
    assert.equal(STALE_FIRSTSEENAT_DAYS_DEFAULT, 20)
  })
})
